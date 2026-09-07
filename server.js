/**
 * server.js — เซิร์ฟเวอร์ระบบสมาชิก (Express + SQLite)
 *
 * รัน:   npm start            (โหมดปกติ)
 *        npm run dev          (โหมด auto-restart เมื่อแก้โค้ด)
 *
 * API หลัก:
 *   POST /api/register          สมัครสมาชิก (สร้างผู้ใช้สถานะ pending + สร้าง OTP)
 *   POST /api/verify-otp        ยืนยัน OTP → activate + ล็อกอินอัตโนมัติ
 *   POST /api/resend-otp        ขอ OTP ใหม่ (จำกัด 60 วินาที)
 *   GET  /api/check-email       ตรวจอีเมลซ้ำ
 *   POST /api/login             เข้าสู่ระบบ
 *   POST /api/logout            ออกจากระบบ
 *   GET  /api/me                ข้อมูลผู้ใช้ปัจจุบัน (จากคุกกี้ session)
 *   POST /api/send-verify-email ส่งลิงก์ยืนยันอีเมลใหม่
 *   GET  /verify-email?token=   ยืนยันอีเมล
 */
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('./db');
const otp = require('./otp');
const mailer = require('./mailer');

const app = express();
app.use(express.json({ limit: '100kb' }));

// ดึงคุกกี้แบบง่าย (Express ยังไม่มี built-in cookie parser) — ต้องมาก่อนทุก middleware ที่ใช้ session
app.use((req, res, next) => {
  const header = req.headers.cookie || '';
  req.cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) req.cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  next();
});

// ป้องกันหน้า /admin — เฉพาะแอดมินที่ล็อกอินแล้วเท่านั้น
app.use('/admin', async (req, res, next) => {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=/admin/');
  }
  if (user.role !== 'admin') {
    return res.status(403).send(
      '<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>403</title></head>' +
      '<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f5fb;color:#333">' +
      '<div style="text-align:center"><h1 style="font-size:56px;margin:0">🔒 403</h1>' +
      '<p style="color:#667085">คุณไม่มีสิทธิ์เข้าถึงหน้านี้ (ต้องเป็นแอดมิน)</p>' +
      '<a href="/" style="color:#6366f1">← กลับหน้าแรก</a></div></body></html>'
    );
  }
  next();
});

// ป้องกันหน้า /dashboard และ /settings — ต้องล็อกอินและยืนยันเบอร์ (active) แล้วเท่านั้น
// (บัญชีค้างกลางคัน: ยังไม่ถือว่าสมัครเสร็จ → พาไปทำขั้นตอนยืนยันให้ครบก่อน)
app.use(['/dashboard', '/settings'], async (req, res, next) => {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/dashboard/pages'));
  }
  if (user.status !== 'active') {
    const completeUrl = user.provider === 'google' ? '/google-setup.html' : '/otp.html';
    return res.redirect(completeUrl);
  }
  next();
});

// หน้า dashboard/settings — ใช้ไฟล์เดียว เลือก panel จาก URL
// /dashboard/pages (หมวด Dashboard), /settings/profile, /settings/security (หมวด ตั้งค่า)
const DASHBOARD_SECTIONS = ['pages', 'profile', 'security'];
app.get(['/dashboard', '/dashboard/'], (req, res) => res.redirect('/dashboard/pages'));
app.get(['/settings', '/settings/'], (req, res) => res.redirect('/settings/profile'));
app.get('/dashboard/upgrade', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'upgrade.html'));
});
app.get('/dashboard/pages/new', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'new-page.html'));
});
app.get('/dashboard/pages/:ref/editor', async (req, res) => {
  // รองรับลิงก์เก่าแบบ id (ตัวเลข) → redirect ไปใช้ slug
  const ref = String(req.params.ref || '');
  if (/^\d+$/.test(ref)) {
    const user = await getCurrentUser(req);
    const page = user ? await db.findPageById(Number(ref)) : null;
    if (page && page.user_id === user.id) {
      return res.redirect('/dashboard/pages/' + page.slug + '/editor');
    }
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'editor.html'));
});
app.get(['/dashboard/:section', '/settings/:section'], (req, res) => {
  const section = DASHBOARD_SECTIONS.includes(req.params.section) ? req.params.section : 'pages';
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});

// ---------------------------------------------------------------------------
// หน้าแสดงเพจสาธารณะ /p/:slug — render จาก content JSON (เฉพาะที่เผยแพร่แล้ว)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderElementHtml(el) {
  const { x = 0, y = 0, w = 375, h = 60 } = el;
  const p = el.props || {};
  // Responsive: ซ้าย/กว้างเป็น % ของผ้าใบ 375 → ยืดตามความกว้างจอ ส่วนบน/สูงเป็น px (คงที่)
  const leftPct = ((x / 375) * 100).toFixed(3);
  const widthPct = ((w / 375) * 100).toFixed(3);
  const style = `position:absolute;left:${leftPct}%;top:${y}px;width:${widthPct}%;height:${h}px;`;

  switch (el.type) {
    case 'text': {
      const fs = Number(p.fontSize) || 16;
      const animClass = p.animation === 'blink' ? ' txt-anim-blink' : p.animation === 'glow' ? ' txt-anim-glow' : '';
      const shadowBlur = Number(p.shadowBlur) || 0;
      const shadow = shadowBlur > 0 ? `text-shadow:0 2px ${shadowBlur}px ${p.shadowColor || '#101828'};` : '';
      const glowVar = p.animation === 'glow' ? `--glow-color:${p.shadowColor || '#6366f1'};` : '';
      const styles =
        `font-size:${fs}px;` +
        (p.bold ? 'font-weight:700;' : 'font-weight:400;') +
        (p.italic ? 'font-style:italic;' : 'font-style:normal;') +
        (p.underline ? 'text-decoration:underline;' : 'text-decoration:none;') +
        (p.uppercase ? 'text-transform:uppercase;' : 'text-transform:none;') +
        `font-family:${p.fontFamily || 'Inter'},'Noto Sans Thai',sans-serif;` +
        `color:${p.color || '#101828'};` +
        `line-height:${Number(p.lineHeight) || 1.5};` +
        `letter-spacing:${Number(p.letterSpacing) || 0}px;` +
        shadow + glowVar;
      const align = p.align || 'center';
      const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
      const inner = escapeHtml(p.text || 'ข้อความของคุณ');
      const animAttr = ' class="' + animClass + '"';
      const link = p.link && /^https?:\/\//.test(p.link) ? p.link : '';
      const content = link
        ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener"${animAttr} style="${styles}text-align:${align};word-break:break-word;">${inner}</a>`
        : `<span${animAttr} style="${styles}text-align:${align};word-break:break-word;">${inner}</span>`;
      return `<div style="${style}display:flex;align-items:center;justify-content:${justify};">${content}</div>`;
    }
    case 'button': {
      const bg = p.bgColor || '#6366f1';
      const fg = p.textColor || '#ffffff';
      const radius = Number(p.radius) || 12;
      const link = p.link || '#';
      const href = /^https?:\/\//.test(link) ? link : '#' + link.replace(/^#/, '');
      const animClass = p.animation === 'shake' ? ' btn-anim-shake' : p.animation === 'zoom' ? ' btn-anim-zoom' : '';
      const speedMap = { slow: 2.4, normal: 1.2, fast: 0.6 };
      const animDur = (p.animation && p.animation !== 'none') ? `animation-duration:${speedMap[p.animSpeed] || 1.2}s;` : '';
      const widthStyle = p.fullWidth ? 'width:100%;' : 'width:100%;';
      const btnStyle = `background:${bg};color:${fg};border-radius:${radius}px;font-size:${Number(p.fontSize) || 15}px;font-weight:${p.bold === false ? '400' : '700'};${animDur}${widthStyle}`;
      return `<div style="${style}display:flex;align-items:center;justify-content:center;"><a href="${href}" target="_blank" rel="noopener" class="${animClass}" style="display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;text-decoration:none;${btnStyle}">${escapeHtml(p.label || 'สั่งซื้อเลย')}</a></div>`;
    }
    case 'image': {
      const src = p.src || '';
      return src
        ? `<div style="${style}"><img src="${escapeHtml(src)}" alt="${escapeHtml(p.alt || '')}" style="width:100%;height:100%;object-fit:cover;border-radius:12px;display:block;"></div>`
        : `<div style="${style}display:flex;align-items:center;justify-content:center;background:#f4f5fb;border:1px dashed #d0d5dd;border-radius:12px;color:#98a2b3;font-size:12px;">รูปภาพ</div>`;
    }
    case 'price': {
      const amount = Number(p.amount) || 0;
      const old = p.oldAmount ? Number(p.oldAmount) : null;
      const cur = p.currency || '฿';
      return `<div style="${style}display:flex;align-items:center;justify-content:center;gap:10px;"><span style="font-size:26px;font-weight:800;color:#dc2626;">${cur}${amount.toLocaleString()}</span>${old ? `<span style="font-size:14px;color:#9ca3af;text-decoration:line-through;">${cur}${old.toLocaleString()}</span>` : ''}</div>`;
    }
    case 'heading': {
      const align = p.align || 'center';
      const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
      const inner = escapeHtml(p.text || 'หัวข้อของคุณ');
      return `<div style="${style}display:flex;align-items:center;justify-content:${justify};"><span style="font-size:${Number(p.fontSize) || 26}px;font-weight:${p.bold ? '700' : '400'};color:${p.color || '#101828'};text-align:${align};line-height:1.4;word-break:break-word;">${inner}</span></div>`;
    }
    case 'box': {
      return `<div style="${style}background:${p.bgColor || '#f4f5fb'};border:1.5px solid ${p.borderColor || '#d0d5dd'};border-radius:${Number(p.radius) || 16}px;box-sizing:border-box;"></div>`;
    }
    case 'line': {
      const lid = String(p.lineId || '@salepage').replace(/^@/, '');
      const radius = Number(p.radius) || 12;
      return `<div style="${style}display:flex;align-items:center;justify-content:center;"><a href="https://line.me/R/ti/p/${escapeHtml(lid)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;height:100%;background:#06c755;color:#fff;border-radius:${radius}px;font-size:15px;font-weight:700;text-decoration:none;"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.5 2 2 5.8 2 10.5c0 2.6 1.4 5 3.7 6.5L5 20.5l3.5-1.9c1 .3 2.2.4 3.5.4 5.5 0 10-3.8 10-8.5S17.5 2 12 2z"/></svg>${escapeHtml(p.label || 'แอดไลน์')}</a></div>`;
    }
    case 'video': {
      const v = videoEmbedUrl(p.url);
      if (v) {
        return `<div style="${style}"><iframe src="${escapeHtml(v)}" style="width:100%;height:100%;border:0;border-radius:12px;" allowfullscreen loading="lazy"></iframe></div>`;
      }
      return `<div style="${style}display:flex;align-items:center;justify-content:center;background:#f4f5fb;border:1px dashed #d0d5dd;border-radius:12px;color:#98a2b3;font-size:12px;">วิดีโอ (วางลิงก์ YouTube/TikTok)</div>`;
    }
    case 'gallery': {
      const imgs = String(p.images || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!imgs.length) {
        return `<div style="${style}display:flex;align-items:center;justify-content:center;background:#f4f5fb;border:1px dashed #d0d5dd;border-radius:12px;color:#98a2b3;font-size:12px;">แกลเลอรี่</div>`;
      }
      const cells = imgs.slice(0, 4).map((u) => `<img src="${escapeHtml(u)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px;display:block;">`).join('');
      return `<div style="${style}display:grid;grid-template-columns:repeat(2,1fr);grid-auto-rows:1fr;gap:8px;">${cells}</div>`;
    }
    case 'countdown': {
      const isAlarm = p.mode === 'alarm';
      let total = 0;
      let deadline = '';
      if (isAlarm && p.alarmDate) {
        deadline = p.alarmDate + 'T' + (p.alarmTime || '23:59') + ':00';
        total = Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
      } else {
        total = ((Number(p.days) || 0) * 86400) + ((Number(p.hours) || 0) * 3600) + ((Number(p.minutes) || 0) * 60) + (Number(p.seconds) || 0);
      }
      const attr = isAlarm && deadline ? `data-deadline="${escapeHtml(deadline)}"` : `data-total="${total}"`;
      return `<div style="${style}display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
        <div style="font-size:12.5px;font-weight:600;color:#667085;text-align:center;">${escapeHtml(p.label || 'โปรโมชันหมดเขตใน')}</div>
        <div class="cd-boxes" ${attr} style="display:flex;align-items:stretch;gap:6px;">
          <span style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:48px;padding:6px 8px;background:#101828;color:#fff;border-radius:10px;"><b class="cd-d" style="font-size:18px;font-weight:800;line-height:1.1;">0</b><i style="font-size:10px;font-style:normal;opacity:.7;">วัน</i></span><em style="align-self:center;font-style:normal;font-weight:800;color:#101828;">:</em>
          <span style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:48px;padding:6px 8px;background:#101828;color:#fff;border-radius:10px;"><b class="cd-h" style="font-size:18px;font-weight:800;line-height:1.1;">0</b><i style="font-size:10px;font-style:normal;opacity:.7;">ชม</i></span><em style="align-self:center;font-style:normal;font-weight:800;color:#101828;">:</em>
          <span style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:48px;padding:6px 8px;background:#101828;color:#fff;border-radius:10px;"><b class="cd-m" style="font-size:18px;font-weight:800;line-height:1.1;">0</b><i style="font-size:10px;font-style:normal;opacity:.7;">นาที</i></span><em style="align-self:center;font-style:normal;font-weight:800;color:#101828;">:</em>
          <span style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:48px;padding:6px 8px;background:#101828;color:#fff;border-radius:10px;"><b class="cd-s" style="font-size:18px;font-weight:800;line-height:1.1;">0</b><i style="font-size:10px;font-style:normal;opacity:.7;">วิ</i></span>
        </div>
      </div>`;
    }
    case 'testimonial': {
      const n = Math.max(0, Math.min(5, Number(p.stars) || 0));
      let stars = '';
      for (let i = 0; i < 5; i++) stars += i < n ? '★' : '☆';
      return `<div style="${style}display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px;padding:12px 14px;background:#f7f8fd;border:1px solid #e4e7ec;border-radius:14px;box-sizing:border-box;overflow:hidden;">
        <span style="color:#f59e0b;font-size:15px;letter-spacing:2px;">${stars}</span>
        <p style="font-size:12.5px;color:#101828;line-height:1.6;margin:0;">${escapeHtml(p.text || '')}</p>
        <span style="font-size:11.5px;color:#667085;font-weight:600;">— ${escapeHtml(p.name || 'ลูกค้า')}</span>
      </div>`;
    }
    case 'faq': {
      const items = String(p.items || '').split('\n').map((line) => {
        const i = line.indexOf('|');
        return i > -1 ? { q: line.slice(0, i).trim(), a: line.slice(i + 1).trim() } : { q: line.trim(), a: '' };
      }).filter((x) => x.q);
      const inner = items.map((it) =>
        `<details style="background:#f7f8fd;border:1px solid #e4e7ec;border-radius:10px;padding:8px 12px;">
          <summary style="font-size:12.5px;font-weight:700;color:#101828;cursor:pointer;list-style:none;">${escapeHtml(it.q)}</summary>
          <p style="font-size:12px;color:#667085;margin:5px 0 0;line-height:1.6;">${escapeHtml(it.a)}</p>
        </details>`
      ).join('');
      return `<div style="${style}display:flex;flex-direction:column;gap:6px;overflow-y:auto;padding:2px;box-sizing:border-box;">${inner}</div>`;
    }
    default:
      return '';
  }
}

function videoEmbedUrl(url) {
  const s = String(url || '').trim();
  const yt = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
  if (yt) return 'https://www.youtube.com/embed/' + yt[1];
  const tk = s.match(/tiktok\.com\/@[\w.-]+\/video\/(\d+)/);
  if (tk) return 'https://www.tiktok.com/embed/v2/' + tk[1];
  const em = s.match(/^https:\/\/\S+/);
  if (em && /(youtube|youtu|tiktok)/.test(s)) return s;
  return null;
}

app.get('/p/:slug', async (req, res) => {
  const page = await db.findPageBySlug(String(req.params.slug || '').toLowerCase());
  if (!page) {
    return res.status(404).send('<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>ไม่พบเพจ</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f5fb;color:#667085"><div style="text-align:center"><h1 style="font-size:44px;color:#101828">ไม่พบเพจ</h1><p>ลิงก์นี้อาจไม่ถูกต้องหรือเพจถูกลบแล้ว</p><a href="/" style="color:#6366f1">← กลับหน้าแรก</a></div></body></html>');
  }
  if (page.status !== 'published') {
    return res.status(200).send('<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>ยังไม่เผยแพร่</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f5fb;color:#667085"><div style="text-align:center"><h1 style="font-size:44px;color:#101828">หน้านี้ยังไม่เผยแพร่</h1><p>เจ้าของเพจยังไม่ได้กดเผยแพร่ กรุณารอสักครู่</p><a href="/" style="color:#6366f1">← กลับหน้าแรก</a></div></body></html>');
  }

  let content = {};
  try { content = JSON.parse(page.content || '{}'); } catch (e) { content = {}; }
  const elements = (content.elements || []).map(renderElementHtml).join('');
  const maxY = (content.elements || []).reduce((m, el) => Math.max(m, (el.y || 0) + (el.h || 0)), 0);

  // พื้นหลังเพจ (จาก content.background)
  const bg = content.background || { type: 'solid', color: '#ffffff' };
  let bgCss = '#ffffff';
  let bgAnim = false;
  if (bg.type === 'gradient') {
    bgCss = bg.gradient || 'linear-gradient(135deg,#6366f1,#c026d3)';
    bgAnim = Boolean(bg.animated);
  } else if (bg.type === 'pattern') {
    const pc = bg.color || '#ffffff';
    const lc = bg.lineColor || '#e4e7ec';
    const pat = bg.pattern || 'dots';
    if (pat === 'lines-h') bgCss = `repeating-linear-gradient(0deg,${lc} 0 1px,transparent 1px 12px),${pc}`;
    else if (pat === 'lines-v') bgCss = `repeating-linear-gradient(90deg,${lc} 0 1px,transparent 1px 12px),${pc}`;
    else if (pat === 'grid') bgCss = `repeating-linear-gradient(0deg,${lc} 0 1px,transparent 1px 18px),repeating-linear-gradient(90deg,${lc} 0 1px,transparent 1px 18px),${pc}`;
    else bgCss = `radial-gradient(${lc} 1.6px,transparent 1.6px) 0 0/18px 18px,${pc}`;
  } else {
    bgCss = bg.color || '#ffffff';
  }

  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(page.title || page.slug)} | SalePage</title>
  <style>
    body { margin:0; font-family:'Inter','Noto Sans Thai',system-ui,sans-serif; background:#eef0f6; -webkit-font-smoothing:antialiased; }
    .page-container {
      position: relative;
      width: 100%;
      min-height: 100vh;
      margin: 0 auto;
      background: ${bgCss};
      box-shadow: 0 0 40px rgba(16,24,40,0.12);
      overflow: hidden;   /* ตัดริ้วแสงออโรร่าที่เกินขอบ ไม่กระทบ element ภายใน */
      transform-origin: top left;
    }
    .page-container.bg-anim {
      background-size: 300% 300%;
      animation: canvasBgShift 14s ease infinite;
    }
    @keyframes canvasBgShift {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes auroraFloat {
      0% { transform: translate(0%, 0%) scale(1); }
      33% { transform: translate(5%, -4%) scale(1.12); }
      66% { transform: translate(-4%, 3%) scale(0.94); }
      100% { transform: translate(0%, 0%) scale(1); }
    }
    @keyframes auroraSheen {
      0%, 100% { opacity: 0.12; transform: translateX(-30%) skewX(-12deg); }
      50% { opacity: 0.3; transform: translateX(30%) skewX(-12deg); }
    }
    .page-container.bg-anim::before {
      content: '';
      position: absolute;
      inset: -15%;
      pointer-events: none;
      background:
        radial-gradient(38% 34% at 28% 32%, rgba(255, 255, 255, 0.28), transparent 65%),
        radial-gradient(30% 26% at 68% 55%, rgba(255, 255, 255, 0.2), transparent 65%),
        radial-gradient(34% 30% at 45% 82%, rgba(255, 255, 255, 0.16), transparent 65%);
      filter: blur(26px);
      mix-blend-mode: screen;
      animation: auroraFloat 18s ease-in-out infinite;
    }
    .page-container.bg-anim::after {
      content: '';
      position: absolute;
      inset: -30% -40%;
      pointer-events: none;
      background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.22) 50%, transparent 70%);
      filter: blur(18px);
      animation: auroraSheen 9s ease-in-out infinite;
    }
    @media (max-width: 420px) {
      .page-container { box-shadow: none; }
    }
    @keyframes txtBlink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }
    @keyframes txtGlow {
      0%, 100% { text-shadow: 0 0 3px var(--glow-color, rgba(99, 102, 241, 0.55)); }
      50% { text-shadow: 0 0 14px var(--glow-color, rgba(99, 102, 241, 0.95)); }
    }
    @keyframes btnShake {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-5px); }
      40% { transform: translateX(5px); }
      60% { transform: translateX(-3px); }
      80% { transform: translateX(3px); }
    }
    @keyframes btnZoom {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    .txt-anim-blink { animation: txtBlink 1s steps(2, start) infinite; }
    .txt-anim-glow { animation: txtGlow 1.6s ease-in-out infinite; }
    .btn-anim-shake { animation-name: btnShake; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
    .btn-anim-zoom { animation-name: btnZoom; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
  </style>
</head>
<body>
  <div class="page-container${bgAnim ? ' bg-anim' : ''}" style="height:${Math.max(600, maxY + 80)}px;">
    ${elements}
  </div>
  <script>
    // นับถอยหลังแบบเรียลไทม์ — รองรับ data-total (นับเวลา) และ data-deadline (นาฬิกาปลูก)
    (function () {
      function pad(n) { return String(n).padStart(2, '0'); }
      function render(box, t) {
        t = Math.max(0, t);
        box.querySelector('.cd-d').textContent = Math.floor(t / 86400);
        box.querySelector('.cd-h').textContent = pad(Math.floor((t % 86400) / 3600));
        box.querySelector('.cd-m').textContent = pad(Math.floor((t % 3600) / 60));
        box.querySelector('.cd-s').textContent = pad(t % 60);
      }
      function remaining(box) {
        if (box.hasAttribute('data-deadline')) {
          return Math.floor((new Date(box.getAttribute('data-deadline')).getTime() - Date.now()) / 1000);
        }
        return Math.max(0, Number(box.getAttribute('data-total')) - 1);
      }
      function tick(box) {
        if (box.hasAttribute('data-total')) {
          box.setAttribute('data-total', remaining(box));
        }
        render(box, remaining(box));
      }
      var boxes = document.querySelectorAll('.cd-boxes[data-total], .cd-boxes[data-deadline]');
      boxes.forEach(tick);
      setInterval(function () {
        document.querySelectorAll('.cd-boxes[data-total], .cd-boxes[data-deadline]').forEach(tick);
      }, 1000);
    })();
  </script>
</body>
</html>`);
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 7) * 24 * 60 * 60 * 1000;
const DEV_MODE = String(process.env.DEV_MODE || 'true') === 'true'; // ค่าเริ่มต้นตอน boot

// อ่านโหมด dev แบบ dynamic — แอดมินสลับได้ผ่านหน้าจัดการ (ตาราง settings)
function devMode() {
  const s = db.getSetting('dev_mode');
  return s !== null ? s === 'true' : DEV_MODE;
}
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';

const COOKIE_NAME = 'session';
const RESEND_COOLDOWN_MS = 60 * 1000; // กัน spam ขอ OTP ซ้ำ 60 วินาที

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// เวลาท้องถิ่น YYYY-MM-DD HH:MM:SS — ใช้เทียบกับคอลัมน์ที่เก็บแบบ localtime (เช่น expires_at ของ OTP)
function localNowSql() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function futureSql(ms) {
  return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
}

function maskPhone(phone) {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 7) return phone;
  return `${digits.slice(0, 3)}-***-${digits.slice(-4)}`;
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * ตรวจเบอร์โทรไทย — ยอมรับทั้งแบบมี/ไม่มี 0 นำหน้า และแบบมี 66/+66
 * เช่น 0812345678 | 812345678 | 66812345678 | +66812345678
 */
function isValidThaiPhone(value) {
  const d = String(value || '').replace(/[^0-9]/g, '');
  return /^0\d{9}$/.test(d) || /^8\d{8}$/.test(d) || /^668\d{8}$/.test(d);
}

/** แปลงเบอร์ไทยทุกรูปแบบ → มาตรฐาน 08XXXXXXXX (10 หลัก มี 0 นำหน้า) */
function normalizeThaiPhone(value) {
  let d = String(value || '').replace(/[^0-9]/g, '');
  if (d.startsWith('668')) d = d.slice(2); // 66812345678 → 812345678
  if (/^8\d{8}$/.test(d)) d = '0' + d;      // 812345678 → 0812345678
  return d;
}

/**
 * ให้คะแนนความแข็งแรงรหัสผ่าน (0-5) — ต้องตรงกับฝั่ง client (register.html)
 * เกณฑ์: 8 ตัวขึ้นไป, 12 ตัวขึ้นไป, มีพิมพ์ใหญ่, มีพิมพ์เล็ก, มีตัวเลข, มีสัญลักษณ์
 */
function passwordStrengthScore(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

// ---------------------------------------------------------------------------
// Rate limit ต่อ IP (กันบอท) — พอเพียงสำหรับ dev/production ขนาดเล็ก
// ---------------------------------------------------------------------------
const rateMap = new Map();

function rateLimit(req, { max, windowMs }) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const rec = rateMap.get(key);
  if (!rec || rec.resetAt <= now) {
    rateMap.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false };
  }
  rec.count += 1;
  if (rec.count > max) {
    return { limited: true, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  }
  return { limited: false };
}

// ล้าง cache rate limit ทิ้งเป็นระยะ
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of rateMap) {
    if (rec.resetAt <= now) rateMap.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// reCAPTCHA v2 — ตรวจเฉพาะเมื่อตั้ง RECAPTCHA_SECRET_KEY ไว้ (dev ข้ามไป)
// ---------------------------------------------------------------------------
async function isRecaptchaValid(responseToken) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return true; // ยังไม่ได้ตั้ง key → ข้าม (ใช้ honeypot + rate limit แทน)
  if (!responseToken) return false;
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: responseToken }),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
async function getCurrentUser(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  const session = await db.findSession(sha256(token));
  if (!session) return null;
  if (session.expires_at <= nowSql()) {
    await db.deleteSession(session.token);
    return null;
  }
  const user = await db.findUserById(session.user_id);
  return user || null;
}

async function startSession(res, userId) {
  const token = randomToken();
  const expiresAt = futureSql(SESSION_TTL_MS);
  await db.createSession({ token: sha256(token), userId, expiresAt });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
  });
}

// ---------------------------------------------------------------------------
// API: ตรวจสอบอีเมลซ้ำ
// ---------------------------------------------------------------------------
app.get('/api/check-email', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, message: 'รูปแบบอีเมลไม่ถูกต้อง' });
  }
  const user = await db.findUserByEmail(email);
  if (!user) {
    return res.json({ ok: true, available: true });
  }
  // ผู้ใช้ที่สมัครค้าง (ยังไม่ยืนยัน OTP) → ยังสมัครต่อได้
  if (user.status === 'pending') {
    return res.json({ ok: true, available: true, pending: true });
  }
  res.json({ ok: true, available: false });
});

// ---------------------------------------------------------------------------
// API: สมัครสมาชิก
// ---------------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const rl = rateLimit(req, { max: 10, windowMs: 60 * 1000 });
  if (rl.limited) {
    return res.status(429).json({
      ok: false,
      message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที (สมัครบ่อยเกินไป)`,
    });
  }

  const { email, password, phone, terms, gRecaptchaResponse } = req.body || {};

  // honeypot — บอทที่กรอกช่องซ่อนจะได้คำตอบ "สำเร็จ" หลอก แต่ไม่สร้างผู้ใช้
  if (req.body && req.body.website) {
    return res.json({ ok: true, message: 'สมัครสมาชิกสำเร็จ', redirect: '/dashboard/pages', honeypot: true });
  }
  // ตรวจว่ากรอกฟอร์มเร็วเกินไป (บอท) — ปกติมนุษย์ใช้เวลาอย่างน้อย ~2 วินาที
  const formStart = Number(req.body?.formStart || 0);
  if (formStart && Date.now() - formStart < 2000) {
    return res.json({ ok: true, message: 'สมัครสมาชิกสำเร็จ', redirect: '/dashboard/pages', honeypot: true });
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!isValidEmail(normalizedEmail)) {
    return res.status(400).json({ ok: false, field: 'email', message: 'รูปแบบอีเมลไม่ถูกต้อง' });
  }

  // ผู้ใช้ที่ยืนยันแล้ว (active) เท่านั้นที่บล็อกอีเมลซ้ำ —
  // ส่วนผู้ใช้ที่สมัครค้าง (pending) ยังสามารถสมัครต่อได้โดยส่ง OTP ใหม่
  const existing = await db.findUserByEmail(normalizedEmail);
  if (existing && existing.status === 'active') {
    return res.status(409).json({ ok: false, field: 'email', message: 'อีเมลนี้ถูกใช้ไปแล้ว' });
  }

  if (passwordStrengthScore(String(password || '')) < 3) {
    return res.status(400).json({
      ok: false,
      field: 'password',
      message: 'รหัสผ่านอ่อนเกินไป ต้องมีอย่างน้อย 8 ตัว และตรงตามเกณฑ์ความแข็งแรง',
    });
  }
  const normalizedPhone = normalizeThaiPhone(phone);
  if (!isValidThaiPhone(normalizedPhone)) {
    return res.status(400).json({
      ok: false,
      field: 'phone',
      message: 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 0812345678 หรือ 812345678)',
    });
  }
  if (terms !== true && terms !== 'on' && terms !== 'true') {
    return res.status(400).json({ ok: false, field: 'terms', message: 'กรุณายอมรับข้อกำหนดและนโยบายความเป็นส่วนตัว' });
  }
  if (!(await isRecaptchaValid(gRecaptchaResponse))) {
    return res.status(400).json({ ok: false, message: 'การยืนยันความเป็นมนุษย์ล้มเหลว กรุณาลองใหม่' });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);

  let user;
  let continuePending = false;
  if (existing) {
    // ผู้ใช้เคยสมัครค้างไว้ (ยังไม่ยืนยัน OTP) → อัปเดตเบอร์/รหัสผ่านที่กรอกใหม่ แล้วส่ง OTP ใหม่ให้สมัครต่อ
    user = await db.updatePendingUser(existing.id, {
      phone: normalizedPhone,
      passwordHash,
    });
    continuePending = true;
  } else {
    user = await db.createUser({ email: normalizedEmail, passwordHash, phone: normalizedPhone });
  }

  const otpResult = await otp.issueOtp(user.id, user.phone);

  console.log(
    continuePending
      ? `🔄 ผู้ใช้สมัครต่อ: ${user.email} (ส่ง OTP ใหม่ — pending เดิม)`
      : `👤 สมัครสมาชิกใหม่: ${user.email} (สถานะ pending)`
  );

  res.json({
    ok: true,
    message: continuePending
      ? 'อีเมลนี้เคยสมัครค้างไว้ เราส่งรหัสยืนยันใหม่ให้แล้ว กรุณายืนยันเบอร์โทร'
      : 'สมัครสมาชิกสำเร็จ กรุณายืนยันเบอร์โทรด้วยรหัส OTP',
    redirect: '/otp.html',
    userId: user.id,
    phoneMasked: maskPhone(user.phone),
    otpExpiresAt: otpResult.expiresAt,
    dev: devMode() ? { devOtp: otpResult.code } : null, // โหมด dev: แสดงรหัสเพื่อทดสอบ
  });
});

// ---------------------------------------------------------------------------
// API: ยืนยัน OTP → activate + ล็อกอินอัตโนมัติ
// ---------------------------------------------------------------------------
app.post('/api/verify-otp', async (req, res) => {
  const { userId, code } = req.body || {};
  const user = await db.findUserById(Number(userId));
  if (!user) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้ กรุณาสมัครใหม่' });

  const result = await otp.verifyOtp(user.id, String(code || ''));
  if (!result.ok) return res.status(400).json({ ok: false, message: result.message });

  await db.setUserStatus(user.id, 'active');

  // ล็อกอินอัตโนมัติ
  await startSession(res, user.id);

  // ส่งลิงก์ยืนยันอีเมลอัตโนมัติหลังสมัคร (โหมด dev จะ log ลิงก์ที่ console)
  let devVerifyLink = null;
  if (!user.is_email_verified) {
    const token = randomToken();
    await db.createEmailToken({ userId: user.id, tokenHash: sha256(token), expiresAt: futureSql(24 * 60 * 60 * 1000) });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const sent = mailer.sendVerificationEmail({ email: user.email, token, baseUrl });
    if (devMode()) devVerifyLink = sent.link;
  }

  console.log(`✅ ผู้ใช้ยืนยัน OTP แล้ว: ${user.email} → ${user.phone}${user.role === 'admin' ? ' (แอดมิน)' : ''} (ล็อกอินอัตโนมัติ)`);

  res.json({
    ok: true,
    message: 'ยืนยันเบอร์โทรสำเร็จ เข้าสู่ระบบแล้ว',
    redirect: user.role === 'admin' ? '/admin/' : '/dashboard/pages',
    dev: devMode() ? { devVerifyLink } : null,
  });
});

// ---------------------------------------------------------------------------
// API: ขอ OTP ใหม่ (จำกัด 60 วินาที)
// ---------------------------------------------------------------------------
app.post('/api/resend-otp', async (req, res) => {
  const rl = rateLimit(req, { max: 5, windowMs: 60 * 1000 });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const { userId } = req.body || {};
  const user = await db.findUserById(Number(userId));
  if (!user) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });

  const last = await db.findLatestOtp(user.id);
  if (last) {
    const lastCreated = new Date(last.created_at).getTime();
    const wait = RESEND_COOLDOWN_MS - (Date.now() - lastCreated);
    if (wait > 0) {
      return res.status(429).json({
        ok: false,
        message: `กรุณารอ ${Math.ceil(wait / 1000)} วินาทีก่อนขอรหัสใหม่`,
      });
    }
  }

  const otpResult = await otp.issueOtp(user.id, user.phone);
  res.json({
    ok: true,
    message: 'ส่งรหัส OTP ใหม่แล้ว',
    otpExpiresAt: otpResult.expiresAt,
    dev: DEV_MODE ? { devOtp: otpResult.code } : null,
  });
});

// ---------------------------------------------------------------------------
// API: เข้าสู่ระบบ
// ---------------------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const rl = rateLimit(req, { max: 10, windowMs: 60 * 1000 });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const { email, password } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const user = await db.findUserByEmail(normalizedEmail);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ ok: false, message: 'ยังไม่ได้ยืนยันเบอร์โทร กรุณาสมัครให้ครบขั้นตอนก่อน' });
  }

  const match = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!match) {
    return res.status(401).json({ ok: false, message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
  }

  await startSession(res, user.id);
  console.log(`🔓 เข้าสู่ระบบ: ${user.email}${user.role === 'admin' ? ' (แอดมิน)' : ''}`);
  res.json({
    ok: true,
    message: 'เข้าสู่ระบบสำเร็จ',
    redirect: user.role === 'admin' ? '/admin/' : '/dashboard/pages',
  });
});

// ---------------------------------------------------------------------------
// API: ออกจากระบบ
// ---------------------------------------------------------------------------
app.post('/api/logout', async (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    await db.deleteSession(sha256(token));
    res.clearCookie(COOKIE_NAME);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: ข้อมูลผู้ใช้ปัจจุบัน
// ---------------------------------------------------------------------------
app.get('/api/me', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'ยังไม่ได้เข้าสู่ระบบ' });

  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      phone: maskPhone(user.phone),
      status: user.status,
      role: user.role,
      provider: user.provider,
      created_at: user.created_at,
      is_email_verified: user.is_email_verified === 1,
    },
  });
});

// ---------------------------------------------------------------------------
// API: ส่งลิงก์ยืนยันอีเมลใหม่ (ต้องล็อกอิน)
// ---------------------------------------------------------------------------
app.post('/api/send-verify-email', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });

  if (user.is_email_verified === 1) {
    return res.status(400).json({ ok: false, message: 'อีเมลนี้ยืนยันแล้ว' });
  }

  const token = randomToken();
  await db.createEmailToken({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: futureSql(24 * 60 * 60 * 1000),
  });

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const sent = mailer.sendVerificationEmail({ email: user.email, token, baseUrl });

  res.json({
    ok: true,
    message: 'ส่งลิงก์ยืนยันอีเมลแล้ว',
    dev: devMode() ? { devVerifyLink: sent.link } : null,
  });
});

// ---------------------------------------------------------------------------
// API: เปลี่ยนรหัสผ่าน (ต้องล็อกอิน) — ตรวจรหัสเดิม + ตั้งใหม่ + ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้
// ---------------------------------------------------------------------------
app.post('/api/change-password', async (req, res) => {
  const rl = rateLimit(req, { max: 8, windowMs: 60 * 1000 });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });

  const { currentPassword, newPassword } = req.body || {};
  const ok = await bcrypt.compare(String(currentPassword || ''), user.password_hash);
  if (!ok) {
    return res.status(400).json({ ok: false, field: 'currentPassword', message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  }
  if (passwordStrengthScore(String(newPassword || '')) < 3) {
    return res.status(400).json({
      ok: false,
      field: 'newPassword',
      message: 'รหัสผ่านใหม่อ่อนเกินไป ต้องมีอย่างน้อย 8 ตัว และตรงตามเกณฑ์ความแข็งแรง',
    });
  }
  if (String(newPassword) === String(currentPassword)) {
    return res.status(400).json({ ok: false, field: 'newPassword', message: 'รหัสผ่านใหม่ต้องไม่เหมือนรหัสเดิม' });
  }

  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  await db.updateUserPassword(user.id, passwordHash);
  // ออกจากระบบทุกเครื่อง ยกเว้น session ปัจจุบัน (กัน session เก่าค้าง)
  const token = req.cookies?.session;
  if (token) await db.deleteOtherSessions(user.id, sha256(token));

  console.log(`🔑 เปลี่ยนรหัสผ่านแล้ว: ${user.email}`);
  res.json({ ok: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
});

// ---------------------------------------------------------------------------
// API: ออกจากระบบทุกเครื่อง (ต้องล็อกอิน) — ลบ session อื่นทั้งหมด ยกเว้นเครื่องนี้
// ---------------------------------------------------------------------------
app.post('/api/logout-all', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });

  const token = req.cookies?.session;
  if (token) await db.deleteOtherSessions(user.id, sha256(token));

  console.log(`🔓 ออกจากระบบทุกเครื่องแล้ว: ${user.email}`);
  res.json({ ok: true, message: 'ออกจากระบบทุกเครื่องแล้ว (ยกเว้นเครื่องนี้)' });
});

// ---------------------------------------------------------------------------
// API: ตรวจชื่อเพจ (slug) ว่าว่างหรือไม่ — ต้องล็อกอิน
// ---------------------------------------------------------------------------
const MAX_PAGES_FREE = 1; // แพ็กเกจฟรี สร้างได้ 1 เพจ

function normalizeSlug(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')        // ช่องว่าง → -
    .replace(/[^a-z0-9-]/g, '')  // เอาเฉพาะ a-z 0-9 -
    .replace(/-{2,}/g, '-')      // --- → -
    .replace(/^-+|-+$/g, '');    // ตัด - หัวท้าย
}

function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,29})$/.test(slug);
}

app.get('/api/pages/check-slug', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });

  const slug = normalizeSlug(req.query.slug);
  if (!slug) {
    return res.json({ ok: true, available: false, message: 'กรอกชื่อเพจก่อน' });
  }
  if (!isValidSlug(slug)) {
    return res.json({
      ok: true,
      available: false,
      slug,
      message: 'ชื่อเพจต้องเป็นภาษาอังกฤษ ตัวเลข หรือเครื่องหมายขีด (-) ยาว 2–30 ตัว',
    });
  }
  const existing = await db.findPageBySlug(slug);
  if (existing) {
    return res.json({
      ok: true,
      available: false,
      slug,
      message: 'ชื่อนี้ถูกใช้แล้ว กรุณาใช้ชื่ออื่น',
    });
  }
  res.json({ ok: true, available: true, slug, message: 'ใช้ชื่อนี้ได้!' });
});

// ---------------------------------------------------------------------------
// API: รายการเพจของฉัน + สร้างเพจใหม่ — ต้องล็อกอิน
// ---------------------------------------------------------------------------
app.get('/api/pages', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });

  const pages = await db.findPagesByUser(user.id);
  res.json({ ok: true, pages, limit: MAX_PAGES_FREE, plan: 'free' });
});

app.post('/api/pages', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });

  const slug = normalizeSlug(req.body?.slug);
  if (!isValidSlug(slug)) {
    return res.status(400).json({ ok: false, message: 'ชื่อเพจไม่ถูกต้อง (ภาษาอังกฤษ/ตัวเลข/ขีด ยาว 2–30 ตัว)' });
  }
  if (await db.findPageBySlug(slug)) {
    return res.status(409).json({ ok: false, message: 'ชื่อนี้ถูกใช้แล้ว กรุณาใช้ชื่ออื่น' });
  }
  if (await db.countUserPages(user.id) >= MAX_PAGES_FREE) {
    return res.status(403).json({ ok: false, code: 'plan_limit', message: 'แพ็กเกจฟรีสร้างได้ 1 เพจ — อัปเกรดเพื่อสร้างเพิ่ม' });
  }

  const id = await db.createPage({ userId: user.id, slug, title: slug });
  console.log(`📄 สร้างเพจใหม่: ${slug} (user ${user.email})`);
  res.json({ ok: true, message: 'สร้างเพจแล้ว', page: { id, slug, title: slug, status: 'draft' } });
});

// ---------------------------------------------------------------------------
// API: โหลด/เซฟ/เผยแพร่เพจ — ต้องเป็นเจ้าของเพจเท่านั้น
// ---------------------------------------------------------------------------
async function requirePageOwner(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  const page = await db.findPageById(Number(req.params.id));
  if (!page || page.user_id !== user.id) {
    return res.status(404).json({ ok: false, message: 'ไม่พบเพจนี้' });
  }
  req.user = user;
  req.page = page;
  next();
}

// โหลดเพจด้วย slug (ต้องเป็นเจ้าของ) — ใช้ในหน้า editor
app.get('/api/pages/slug/:slug', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  const page = await db.findPageBySlug(String(req.params.slug || '').toLowerCase());
  if (!page || page.user_id !== user.id) {
    return res.status(404).json({ ok: false, message: 'ไม่พบเพจนี้' });
  }
  let content = {};
  try { content = JSON.parse(page.content || '{}'); } catch (e) { content = {}; }
  res.json({
    ok: true,
    page: {
      id: page.id,
      slug: page.slug,
      title: page.title,
      status: page.status,
      theme: page.theme,
      content,
      created_at: page.created_at,
      updated_at: page.updated_at,
    },
  });
});

app.get('/api/pages/:id', requirePageOwner, (req, res) => {
  const p = req.page;
  let content = {};
  try { content = JSON.parse(p.content || '{}'); } catch (e) { content = {}; }
  res.json({
    ok: true,
    page: {
      id: p.id,
      slug: p.slug,
      title: p.title,
      status: p.status,
      theme: p.theme,
      content,
      created_at: p.created_at,
      updated_at: p.updated_at,
    },
  });
});

app.put('/api/pages/:id', requirePageOwner, async (req, res) => {
  const { content, theme, title } = req.body || {};
  const fields = {};
  if (content !== undefined) fields.content = JSON.stringify(content || { elements: [] });
  if (theme !== undefined) fields.theme = String(theme);
  if (title !== undefined) fields.title = String(title).slice(0, 60);
  if (Object.keys(fields).length) await db.updatePage(req.page.id, fields);
  console.log(`💾 เซฟเพจ: ${req.page.slug} (user ${req.user.email})`);
  res.json({ ok: true, message: 'บันทึกแล้ว' });
});

app.post('/api/pages/:id/publish', requirePageOwner, async (req, res) => {
  await db.updatePage(req.page.id, { status: 'published' });
  console.log(`🚀 เผยแพร่เพจ: ${req.page.slug}`);
  res.json({ ok: true, message: 'เผยแพร่แล้ว', url: `/p/${req.page.slug}` });
});

// ---------------------------------------------------------------------------
// API: อัปโหลดรูปภาพ (ต้องล็อกอิน) — เก็บใน public/uploads, คืน URL /uploads/xxx
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const UPLOAD_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const MAX_UPLOAD = 5 * 1024 * 1024; // 5MB

app.post('/api/upload', async (req, res, next) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });

  const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_TYPES[ctype];
  if (!ext) {
    return res.status(400).json({ ok: false, message: 'รองรับเฉพาะไฟล์รูป JPG/PNG/WebP/GIF' });
  }

  let chunks = [];
  req.on('data', (c) => {
    chunks.push(c);
    const total = chunks.reduce((s, x) => s + x.length, 0);
    if (total > MAX_UPLOAD) {
      res.status(413).json({ ok: false, message: 'ไฟล์ใหญ่เกินไป (สูงสุด 5MB)' });
      req.destroy();
    }
  });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length) return res.status(400).json({ ok: false, message: 'ไม่มีไฟล์' });
    const name = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    console.log(`🖼️ อัปโหลดรูป: ${name} (${buf.length} bytes) โดย ${user.email}`);
    res.json({ ok: true, url: '/uploads/' + name });
  });
  req.on('error', () => res.status(500).json({ ok: false, message: 'อัปโหลดไม่สำเร็จ' }));
});

// ---------------------------------------------------------------------------
// API: กู้รหัสผ่าน — ขั้นที่ 1 ส่ง OTP ทางอีเมล
// ---------------------------------------------------------------------------
app.post('/api/forgot-password', async (req, res) => {
  const rl = rateLimit(req, { max: 5, windowMs: 60 * 1000 });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, field: 'email', message: 'รูปแบบอีเมลไม่ถูกต้อง' });
  }

  const user = await db.findUserByEmail(email);
  // เฉพาะผู้ใช้ที่สมัครครบ (active) เท่านั้นที่กู้รหัสได้ —
  // ผู้ที่ค้างกลางคัน (pending) ถือว่า "ยังไม่มีผู้ใช้" ตรงตามดีไซน์
  const eligible = Boolean(user && user.status === 'active');

  // กัน spam ขอ OTP ซ้ำภายใน 60 วินาที
  if (eligible) {
    const last = await db.findLatestOtp(user.id, 'password_reset');
    if (last) {
      const wait = 60 * 1000 - (Date.now() - new Date(last.created_at).getTime());
      if (wait > 0) {
        return res.status(429).json({
          ok: false,
          message: `กรุณารอ ${Math.ceil(wait / 1000)} วินาทีก่อนขอรหัสใหม่`,
        });
      }
    }
  }

  let devOtp = null;
  if (eligible) {
    const otpResult = await otp.issueOtp(user.id, user.email, 'password_reset');
    if (devMode()) devOtp = otpResult.code;
    console.log(`🔐 ขอ OTP กู้รหัสผ่าน: ${user.email}`);
  }

  // ตอบเหมือนกันเสมอ ไม่บอกว่าอีเมลนี้มีในระบบหรือไม่ (กันการเดาอีเมล)
  res.json({
    ok: true,
    message: 'ถ้าอีเมลนี้มีในระบบ เราจะส่งรหัส OTP ไปให้ที่อีเมลของคุณ',
    dev: devMode() ? { devOtp, userExists: Boolean(eligible) } : null,
  });
});

// ---------------------------------------------------------------------------
// API: กู้รหัสผ่าน — ขั้นที่ 2 ตรวจ OTP → คืน token สำหรับตั้งรหัสใหม่
// ---------------------------------------------------------------------------
app.post('/api/forgot-verify-otp', async (req, res) => {
  const rl = rateLimit(req, { max: 10, windowMs: 60 * 1000 });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const { email, code } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = await db.findUserByEmail(normalizedEmail);
  if (!user) {
    return res.status(404).json({ ok: false, message: 'ไม่พบข้อมูล กรุณาเริ่มใหม่' });
  }

  const result = await otp.verifyOtp(user.id, String(code || ''), 'password_reset');
  if (!result.ok) return res.status(400).json({ ok: false, message: result.message });

  // สร้าง token สำหรับตั้งรหัสผ่านใหม่ (อายุ 10 นาที)
  const token = randomToken();
  await db.createPasswordReset({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: futureSql(10 * 60 * 1000),
  });

  console.log(`🔑 ยืนยัน OTP กู้รหัสผ่านแล้ว: ${user.email}`);
  res.json({ ok: true, message: 'ยืนยันตัวตนสำเร็จ', resetToken: token });
});

// ---------------------------------------------------------------------------
// API: กู้รหัสผ่าน — ขั้นที่ 3 ตั้งรหัสผ่านใหม่
// ---------------------------------------------------------------------------
app.post('/api/forgot-reset-password', async (req, res) => {
  const rl = rateLimit(req, { max: 10, windowMs: 60 * 1000 });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const { resetToken, newPassword } = req.body || {};
  const record = await db.findPasswordResetByHash(sha256(String(resetToken || '')));

  if (!record || record.used === 1) {
    return res.status(400).json({ ok: false, message: 'โทเคนไม่ถูกต้องหรือถูกใช้ไปแล้ว กรุณาเริ่มใหม่' });
  }
  if (record.expires_at <= nowSql()) {
    return res.status(400).json({ ok: false, message: 'โทเคนหมดอายุแล้ว กรุณาเริ่มใหม่' });
  }
  if (passwordStrengthScore(String(newPassword || '')) < 3) {
    return res.status(400).json({
      ok: false,
      field: 'password',
      message: 'รหัสผ่านอ่อนเกินไป ต้องมีอย่างน้อย 8 ตัว และตรงตามเกณฑ์ความแข็งแรง',
    });
  }

  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  await db.updateUserPassword(record.user_id, passwordHash);
  await db.markPasswordResetUsed(record.id);
  await db.deleteUserSessions(record.user_id); // ออกจากระบบทุก session เดิม (กัน session เก่าค้าง)

  console.log(`🔑 ตั้งรหัสผ่านใหม่แล้ว: user_id=${record.user_id}`);
  res.json({ ok: true, message: 'ตั้งรหัสผ่านใหม่สำเร็จ กรุณาเข้าสู่ระบบ' });
});

// ---------------------------------------------------------------------------
// เข้าสู่ระบบด้วย Google (OAuth 2.0)
//   - มี GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET → OAuth จริง (redirect ไป Google)
//   - ยังไม่มี key → โหมดทดสอบ (dev): ใช้หน้า google-login.html กรอกอีเมลจำลอง
// ---------------------------------------------------------------------------
function getGoogleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/auth/google/callback`,
    configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  };
}

// เปิด URL สำหรับล็อกอิน Google
app.get('/api/auth/google/url', (req, res) => {
  const cfg = getGoogleConfig();
  if (!cfg.configured) {
    // ยังไม่มี key → โหมด dev ใช้หน้า mock (กรอกอีเมลจำลอง)
    return res.json({ ok: true, dev: true, url: '/google-login.html' });
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  });
  res.json({ ok: true, dev: false, url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// Callback จาก Google (OAuth จริง)
app.get('/api/auth/google/callback', async (req, res) => {
  const cfg = getGoogleConfig();
  if (!cfg.configured || !req.query.code) {
    return res.redirect('/login.html?error=google');
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('แลก token ไม่สำเร็จ');

    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const info = await infoRes.json();
    if (!info.email) throw new Error('ไม่มีอีเมลจาก Google');

    await handleGoogleUser(req, res, { email: info.email, googleId: info.id || info.email }, 'redirect');
  } catch (err) {
    console.error('❌ Google OAuth error:', err.message);
    res.redirect('/login.html?error=google');
  }
});

// โหมดทดสอบ (dev): จำลองบัญชี Google — รับอีเมลที่ผู้ใช้กรอกในหน้า mock
app.post('/api/auth/google/mock', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, message: 'รูปแบบอีเมลไม่ถูกต้อง' });
  }
  await handleGoogleUser(req, res, { email, googleId: 'dev-' + email }, 'json');
});

/**
 * จัดการผู้ใช้หลังได้อีเมลจาก Google (ถือว่าอีเมลยืนยันแล้ว)
 *  - มีบัญชี active → ล็อกอินบัญชีเดิม (ผูก google_id ถ้ายังไม่เคย)
 *  - ผู้ใช้ค้าง (pending) → ไปหน้า google-setup.html เพื่อสมัครต่อ
 *  - ไม่มีบัญชี → สร้างผู้ใช้ค้าง (Google) → หน้า google-setup.html
 */
async function handleGoogleUser(req, res, { email, googleId }, mode) {
  let user = await db.findUserByEmail(email);
  if (!user) {
    user = await db.createGooglePendingUser({ email, googleId });
    console.log(`🔑 [Google] สร้างผู้ใช้ใหม่ (ค้างกลางคัน): ${email}`);
  } else if (!user.google_id) {
    await db.linkGoogle(user.id, googleId);
  }

  // สร้าง session ให้ (ทั้ง active และ pending — pending ใช้หน้า setup ต่อ)
  await startSession(res, user.id);

  if (user.status !== 'active') {
    console.log(`🔑 [Google] ผู้ใช้ค้าง → ไปตั้งรหัส/เบอร์: ${email}`);
    if (mode === 'redirect') return res.redirect('/google-setup.html');
    return res.json({ ok: true, redirect: '/google-setup.html' });
  }
  console.log(`🔑 [Google] ล็อกอินบัญชีเดิม: ${email}`);
  if (mode === 'redirect') return res.redirect(user.role === 'admin' ? '/admin/' : '/dashboard/pages');
  res.json({ ok: true, redirect: user.role === 'admin' ? '/admin/' : '/dashboard/pages' });
}

// ---------------------------------------------------------------------------
// Google setup — ผู้ใช้ค้าง (ยังไม่ตั้งรหัส/เบอร์) กรอกให้ครบ
// ต้องล็อกอิน (session จาก Google) และสถานะ pending เท่านั้น
// ---------------------------------------------------------------------------
async function requirePendingGoogle(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  if (user.status === 'active') {
    return res.status(400).json({ ok: false, message: 'บัญชีนี้สมัครครบแล้ว' });
  }
  req.user = user;
  next();
}

// ขอ OTP ยืนยันเบอร์ (ขั้นตอน Google setup)
app.post('/api/google-setup/send-otp', requirePendingGoogle, async (req, res) => {
  const phone = normalizeThaiPhone(req.body?.phone);
  if (!isValidThaiPhone(phone)) {
    return res.status(400).json({ ok: false, field: 'phone', message: 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 0812345678 หรือ 812345678)' });
  }
  const otpResult = await otp.issueOtp(req.user.id, phone, 'signup');
  console.log(`🔑 [Google setup] ส่ง OTP ยืนยันเบอร์ ${phone} ให้ ${req.user.email}`);
  res.json({
    ok: true,
    message: 'ส่งรหัส OTP แล้ว',
    otpExpiresAt: otpResult.expiresAt,
    dev: devMode() ? { devOtp: otpResult.code } : null,
  });
});

// ตั้งรหัสผ่าน + ยืนยันเบอร์ OTP → สมัครเสร็จสมบูรณ์
app.post('/api/google-setup/complete', requirePendingGoogle, async (req, res) => {
  const { password, phone, code } = req.body || {};
  const normalizedPhone = normalizeThaiPhone(phone);

  if (passwordStrengthScore(String(password || '')) < 3) {
    return res.status(400).json({ ok: false, field: 'password', message: 'รหัสผ่านอ่อนเกินไป ต้องมีอย่างน้อย 8 ตัว และตรงตามเกณฑ์ความแข็งแรง' });
  }
  if (!isValidThaiPhone(normalizedPhone)) {
    return res.status(400).json({ ok: false, field: 'phone', message: 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 0812345678 หรือ 812345678)' });
  }
  const otpResult = await otp.verifyOtp(req.user.id, String(code || ''), 'signup');
  if (!otpResult.ok) {
    return res.status(400).json({ ok: false, field: 'otp', message: otpResult.message });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  await db.completeGoogleSetup(req.user.id, { passwordHash, phone: normalizedPhone });
  console.log(`✅ [Google] สมัครสมาชิกเสร็จสมบูรณ์: ${req.user.email} (เบอร์ ${normalizedPhone})`);

  res.json({ ok: true, message: 'สมัครสมาชิกเสร็จสมบูรณ์', redirect: '/dashboard/pages' });
});

// ---------------------------------------------------------------------------
// Admin — ตั้งค่า SMTP (อีเมลจริง: ยืนยันอีเมล / OTP ทางอีเมล)
// ---------------------------------------------------------------------------

// สถานะ SMTP
app.get('/api/admin/smtp-status', requireAdmin, (req, res) => {
  const mailer = require('./mailer');
  const cfg = mailer.getSmtpConfig();
  res.json({
    ok: true,
    status: {
      configured: cfg.configured,
      host: cfg.host || null,
      port: cfg.port,
      userMasked: cfg.user ? cfg.user.slice(0, 3) + '…' : null,
      from: cfg.from || null,
      source: db.getSetting('smtp_host') ? 'admin' : 'env',
      devMode: devMode(),
    },
  });
});

// บันทึกค่า SMTP
app.post('/api/admin/smtp-settings', requireAdmin, (req, res) => {
  const { host, port, user, pass, from } = req.body || {};
  let changed = 0;

  if (host !== undefined && host !== '') {
    if (!/^[\w.-]+(\.[\w.-]+)+$/.test(String(host).trim())) {
      return res.status(400).json({ ok: false, message: 'SMTP Host ไม่ถูกต้อง (เช่น smtp.gmail.com)' });
    }
    db.setSetting('smtp_host', String(host).trim());
    changed++;
  }
  if (port !== undefined && port !== '') {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return res.status(400).json({ ok: false, message: 'SMTP Port ไม่ถูกต้อง (เช่น 587)' });
    }
    db.setSetting('smtp_port', String(p));
    changed++;
  }
  if (user !== undefined && user !== '') {
    if (/\s/.test(String(user).trim()) || String(user).length < 3) {
      return res.status(400).json({ ok: false, message: 'SMTP User (อีเมล/ชื่อผู้ใช้) ไม่ถูกต้อง' });
    }
    db.setSetting('smtp_user', String(user).trim());
    changed++;
  }
  if (pass !== undefined && pass !== '') {
    db.setSetting('smtp_pass', String(pass));
    changed++;
  }
  if (from !== undefined && from !== '') {
    if (!isValidEmail(String(from).trim())) {
      return res.status(400).json({ ok: false, message: 'From (อีเมลผู้ส่ง) ไม่ถูกต้อง' });
    }
    db.setSetting('smtp_from', String(from).trim());
    changed++;
  }

  require('./mailer')._resetTransporter();
  console.log(`👑 [แอดมิน] บันทึกการตั้งค่า SMTP (${changed} รายการ)`);
  res.json({
    ok: true,
    message: changed > 0 ? `บันทึกการตั้งค่า SMTP แล้ว (${changed} รายการ)` : 'ไม่มีรายการที่เปลี่ยนแปลง',
  });
});

// ทดสอบส่งอีเมล (ต้องตั้งค่า SMTP ครบ + ปิด dev ถึงจะส่งจริง)
app.post('/api/admin/smtp-test', requireAdmin, async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!isValidEmail(to)) {
    return res.status(400).json({ ok: false, message: 'กรุณากรอกอีเมลปลายทางสำหรับทดสอบ' });
  }
  const mailer = require('./mailer');
  const result = await mailer.sendEmail({
    to,
    subject: 'ทดสอบการตั้งค่า SMTP — ร้านค้าออนไลน์',
    htmlBody: '<p>✅ ทดสอบการตั้งค่า SMTP สำเร็จ ถ้าคุณได้รับอีเมลนี้ แสดงว่าระบบพร้อมใช้งานจริงแล้ว</p>',
  });
  if (!result.ok) {
    return res.status(400).json({ ok: false, message: result.error || 'ส่งอีเมลทดสอบไม่สำเร็จ' });
  }
  console.log(`👑 [แอดมิน] ทดสอบส่งอีเมล ${result.simulated ? '(จำลอง)' : '(จริง)'} → ${to}`);
  res.json({
    ok: true,
    message: result.simulated
      ? 'ส่งอีเมลทดสอบแล้ว (โหมดจำลอง — ดูที่ console เซิร์ฟเวอร์)'
      : 'ส่งอีเมลทดสอบสำเร็จแล้ว (ตรวจที่อินบ็อกซ์ของคุณ)',
    simulated: Boolean(result.simulated),
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Admin — จัดการผู้ใช้งาน (ดู/แก้ไข/ลบ)
// ---------------------------------------------------------------------------

// รายการผู้ใช้ทั้งหมด + ค้นหา
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const users = (await db.listUsers({ search, limit })).map((u) => ({
    ...u,
    phone: u.phone || '', // แสดงเบอร์เต็มให้แอดมิน (เครื่องมือภายใน — ต้องใช้เบอร์จริงตอนแก้ไข)
    is_email_verified: u.is_email_verified === 1,
  }));
  res.json({ ok: true, users, total: await db.countUsers(search) });
});

// แก้ไขข้อมูลผู้ใช้
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const current = await db.findUserById(id);
  if (!current) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });

  const { email, phone, status, role, isEmailVerified, newPassword } = req.body || {};
  const fields = {};

  if (email !== undefined) {
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ ok: false, field: 'email', message: 'รูปแบบอีเมลไม่ถูกต้อง' });
    }
    const dup = await db.findUserByEmail(normalizedEmail);
    if (dup && dup.id !== id) {
      return res.status(409).json({ ok: false, field: 'email', message: 'อีเมลนี้ถูกใช้ไปแล้ว' });
    }
    fields.email = normalizedEmail;
  }
  if (phone !== undefined) {
    const normalizedPhone = normalizeThaiPhone(phone);
    if (!isValidThaiPhone(normalizedPhone)) {
      return res.status(400).json({ ok: false, field: 'phone', message: 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 0812345678)' });
    }
    fields.phone = normalizedPhone;
  }
  if (status !== undefined) {
    if (!['pending', 'active'].includes(status)) {
      return res.status(400).json({ ok: false, message: 'สถานะไม่ถูกต้อง' });
    }
    // แอดมินห้ามตั้งสถานะตัวเองเป็น pending (กันล็อกตัวเองออก) — แต่แก้ไขอย่างอื่นของตัวเองได้
    if (id === req.admin.id && status !== 'active') {
      return res.status(400).json({ ok: false, message: 'ไม่สามารถเปลี่ยนสถานะบัญชีตัวเองได้' });
    }
    fields.status = status;
  }
  if (role !== undefined) {
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ ok: false, message: 'บทบาทไม่ถูกต้อง' });
    }
    if (id === req.admin.id && role !== 'admin') {
      return res.status(400).json({ ok: false, message: 'ไม่สามารถถอดสิทธิ์แอดมินของตัวเองได้' });
    }
    if (current.role === 'admin' && role === 'user' && await db.countAdmins() <= 1) {
      return res.status(400).json({ ok: false, message: 'ต้องมีแอดมินอย่างน้อย 1 คน' });
    }
    fields.role = role;
  }
  if (isEmailVerified !== undefined) {
    fields.isEmailVerified = Boolean(isEmailVerified);
  }
  if (newPassword !== undefined && newPassword !== '') {
    if (passwordStrengthScore(String(newPassword)) < 3) {
      return res.status(400).json({ ok: false, field: 'password', message: 'รหัสผ่านอ่อนเกินไป ต้องมีอย่างน้อย 8 ตัว และตรงตามเกณฑ์ความแข็งแรง' });
    }
    fields.passwordHash = await bcrypt.hash(String(newPassword), 10);
  }

  const updated = await db.updateUserByAdmin(id, fields);
  console.log(`👑 [แอดมิน] แก้ไขผู้ใช้ #${id} (${updated.email})`);
  res.json({
    ok: true,
    message: 'บันทึกข้อมูลผู้ใช้แล้ว',
    user: {
      ...updated,
      phone: updated.phone || '',
      is_email_verified: updated.is_email_verified === 1,
    },
  });
});

// ลบผู้ใช้
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.admin.id) {
    return res.status(400).json({ ok: false, message: 'ไม่สามารถลบบัญชีตัวเองได้' });
  }
  const current = await db.findUserById(id);
  if (!current) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });
  if (current.role === 'admin' && await db.countAdmins() <= 1) {
    return res.status(400).json({ ok: false, message: 'ต้องมีแอดมินอย่างน้อย 1 คน' });
  }
  await db.deleteUser(id);
  await db.deleteUserSessions(id);
  console.log(`👑 [แอดมิน] ลบผู้ใช้ #${id} (${current.email})`);
  res.json({ ok: true, message: 'ลบผู้ใช้แล้ว' });
});

// ---------------------------------------------------------------------------
// ยืนยันอีเมล (เปิดจากลิงก์ในอีเมล)
// ---------------------------------------------------------------------------
app.get('/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  const record = await db.findEmailTokenByHash(sha256(token));

  if (!record || record.used === 1) {
    return res.status(400).send(buildResultPage(false, 'ลิงก์ยืนยันไม่ถูกต้องหรือถูกใช้ไปแล้ว'));
  }
  if (record.expires_at <= nowSql()) {
    return res.status(400).send(buildResultPage(false, 'ลิงก์ยืนยันหมดอายุแล้ว กรุณาขอใหม่'));
  }

  await db.markEmailTokenUsed(record.id);
  await db.setEmailVerified(record.user_id, 1);
  console.log(`📧 ยืนยันอีเมลสำเร็จ: user_id=${record.user_id}`);

  res.send(buildResultPage(true, 'ยืนยันอีเมลสำเร็จ! คุณสามารถเข้าสู่ระบบได้เลย'));
});

function buildResultPage(success, message) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const accent = success ? '#16a34a' : '#dc2626';
  const accentBg = success ? '#dcfce7' : '#fee2e2';
  const statusSvg = success
    ? '<svg viewBox="0 0 24 24" fill="none" width="34" height="34"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" width="30" height="30"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const headline = success ? 'ยืนยันอีเมลสำเร็จ' : 'เกิดข้อผิดพลาด';
  const sub = success
    ? 'อีเมลของคุณได้รับการยืนยันแล้ว — เข้าสู่ระบบเพื่อเริ่มใช้งานได้เลย'
    : esc(message);
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${success ? 'ยืนยันอีเมลสำเร็จ' : 'เกิดข้อผิดพลาด'} | SalePage</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', 'Prompt', Tahoma, Arial, sans-serif;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: radial-gradient(1200px 600px at 10% -10%, #e0e7ff 0%, transparent 55%),
                  radial-gradient(1000px 500px at 110% 110%, #ede9fe 0%, transparent 50%),
                  linear-gradient(160deg, #f8fafc 0%, #eef2ff 100%);
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: #ffffff;
      border: 1px solid rgba(99, 102, 241, 0.12);
      border-radius: 24px;
      box-shadow: 0 24px 60px -20px rgba(79, 70, 229, 0.25);
      padding: 48px 40px 40px;
      text-align: center;
    }
    .brand {
      display: inline-flex; align-items: center; gap: 9px;
      font-size: 15px; font-weight: 700; color: #4f46e5; letter-spacing: .2px;
      margin-bottom: 26px;
    }
    .brand .logo {
      width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      box-shadow: 0 6px 14px -4px rgba(99, 102, 241, .6);
    }
    .status {
      width: 76px; height: 76px; border-radius: 50%;
      background: ${accentBg}; color: ${accent};
      display: grid; place-items: center; margin: 0 auto 22px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.03);
    }
    h1 { font-size: 21px; font-weight: 700; color: #0f172a; margin-bottom: 10px; }
    .sub { font-size: 14.5px; line-height: 1.7; color: #64748b; margin-bottom: 30px; }
    .btn {
      display: inline-flex; align-items: center; gap: 8px;
      background: linear-gradient(135deg, #6366f1, #7c3aed);
      color: #fff; text-decoration: none; font-size: 15px; font-weight: 600;
      padding: 13px 30px; border-radius: 12px;
      box-shadow: 0 10px 22px -8px rgba(99, 102, 241, .7);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 14px 26px -8px rgba(99, 102, 241, .8); }
    .btn svg { width: 17px; height: 17px; }
    .hint { margin-top: 18px; font-size: 12.5px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span class="logo"><svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6z" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 6h18" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg></span>
      SalePage
    </div>
    <div class="status">${statusSvg}</div>
    <h1>${success ? 'ยืนยันอีเมลสำเร็จ' : 'เกิดข้อผิดพลาด'}</h1>
    <div class="sub">${success ? sub : sub}</div>
    <a class="btn" href="/login.html">
      <svg viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      ไปหน้าเข้าสู่ระบบ
    </a>
    <div class="hint">SalePage Builder — สร้างหน้าเว็บขายของในไม่กี่นาที</div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// เปิด config ให้หน้าเว็บใช้ (เช่น reCAPTCHA site key)
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || null,
    devMode: devMode(),
  });
});

// ---------------------------------------------------------------------------
// ระบบหลังบ้านแอดมิน — ทุก endpoint ต้องเป็นแอดมินที่ล็อกอินเท่านั้น
// ---------------------------------------------------------------------------
async function requireAdmin(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ ok: false, message: 'ไม่มีสิทธิ์เข้าถึง ต้องเป็นแอดมิน' });
  }
  req.admin = user;
  next();
}

// สถิติภาพรวม
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  res.json({ ok: true, stats: await db.countStats() });
});

// รายการ OTP ทั้งหมด (สำหรับหน้าจัดการ SMS-OTP)
app.get('/api/admin/otp-logs', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const nowMs = Date.now();
  const logs = (await db.listOtpLogs(limit)).map((l) => {
    const expiresMs = new Date(l.expires_at).getTime();
    let status;
    if (l.used === 1) status = 'used';
    else if (l.replaced === 1) status = 'replaced'; // ถูกตัดสิทธิ์เพราะมีการขอรหัสใหม่
    else if (expiresMs <= nowMs) status = 'expired';
    else status = 'valid';
    return {
      ...l,
      status,
      code: l.code_visible || null,
      remainingSec: status === 'valid' ? Math.max(0, Math.floor((expiresMs - nowMs) / 1000)) : 0,
    };
  });
  res.json({ ok: true, logs, serverTime: new Date().toISOString() });
});

// แอดมินสั่งส่ง OTP ใหม่ให้ผู้ใช้ (ข้าม cooldown 60 วิ ใช้ support)
app.post('/api/admin/otp/resend', requireAdmin, async (req, res) => {
  const userId = Number(req.body?.userId);
  const purpose = req.body?.purpose === 'password_reset' ? 'password_reset' : 'signup';
  const user = await db.findUserById(userId);
  if (!user) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });

  // ปลายทาง: รับเบอร์ที่แอดมินพิมพ์แทนได้ → ถ้าไม่ใส่ ใช้เบอร์ในบัญชี → ถ้ายังไม่มี ใช้เบอร์จาก OTP ครั้งก่อน
  let contact;
  if (purpose === 'password_reset') {
    contact = user.email;
  } else if (req.body?.phone) {
    contact = normalizeThaiPhone(String(req.body.phone));
  } else {
    contact = user.phone || (await db.findLatestOtpContact(user.id, purpose)) || '';
  }

  if (purpose === 'signup' && !isValidThaiPhone(contact)) {
    return res.status(400).json({
      ok: false,
      field: 'phone',
      message: 'ยังไม่มีเบอร์โทรสำหรับส่ง OTP — ใส่เบอร์ปลายทางก่อนส่ง หรือให้ผู้ใช้กรอกเบอร์ในระบบก่อน',
    });
  }

  const otpResult = await otp.issueOtp(user.id, contact, purpose);
  console.log(`👑 [แอดมิน] ส่ง OTP ใหม่ (${purpose}) ให้ ${user.email} → ${contact}`);

  res.json({
    ok: true,
    message: 'ส่ง OTP ใหม่แล้ว',
    contact,
    dev: devMode() ? { devOtp: otpResult.code } : null,
  });
});

// สถานะระบบ SMS-OTP
app.get('/api/admin/sms-status', requireAdmin, (req, res) => {
  const sms = require('./sms');
  const summary = sms.getConfigSummary();
  res.json({
    ok: true,
    status: {
      devMode: devMode(),
      provider: summary.provider,
      smtpConfigured: require('./mailer').getSmtpConfig().configured,
      otpTtlMinutes: otp.getOtpTtlMinutes(),
      otpMaxAttempts: otp.getOtpMaxAttempts(),
      sms: summary,
    },
  });
});

// บันทึก provider + ค่า config ของ SMS (จากหน้าแอดมิน)
app.post('/api/admin/sms-settings', requireAdmin, (req, res) => {
  const { provider, accountSid, authToken, phone, apiKey, apiSecret, sender } = req.body || {};
  const chosen = provider === 'thaibulksms' ? 'thaibulksms' : 'twilio';
  let changed = 0;

  if (chosen === 'thaibulksms') {
    if (apiKey !== undefined && apiKey !== '') {
      if (String(apiKey).trim().length < 8) {
        return res.status(400).json({ ok: false, message: 'API Key ของ ThaiBulkSMS ดูสั้นเกินไป' });
      }
      db.setSetting('tbs_api_key', String(apiKey).trim());
      changed++;
    }
    if (apiSecret !== undefined && apiSecret !== '') {
      if (String(apiSecret).trim().length < 8) {
        return res.status(400).json({ ok: false, message: 'API Secret ของ ThaiBulkSMS ดูสั้นเกินไป' });
      }
      db.setSetting('tbs_api_secret', String(apiSecret).trim());
      changed++;
    }
    if (sender !== undefined && sender !== '') {
      if (!/^[A-Za-z0-9]{1,10}$/.test(String(sender).trim())) {
        return res.status(400).json({ ok: false, message: 'Sender ต้องเป็นตัวอักษร/เลข ไม่เกิน 10 ตัว (บัญชีทดลองใช้ Demo)' });
      }
      db.setSetting('tbs_sender', String(sender).trim());
      changed++;
    }
  } else {
    if (accountSid !== undefined && accountSid !== '') {
      if (!/^AC[0-9a-f]{32}$/i.test(String(accountSid).trim())) {
        return res.status(400).json({ ok: false, message: 'Account SID ไม่ถูกต้อง (ควรขึ้นต้นด้วย AC และยาว 34 ตัวอักษร)' });
      }
      db.setSetting('twilio_account_sid', String(accountSid).trim());
      changed++;
    }
    if (authToken !== undefined && authToken !== '') {
      if (String(authToken).trim().length < 20) {
        return res.status(400).json({ ok: false, message: 'Auth Token ดูสั้นเกินไป กรุณาตรวจสอบให้ถูกต้อง' });
      }
      db.setSetting('twilio_auth_token', String(authToken).trim());
      changed++;
    }
    if (phone !== undefined && phone !== '') {
      const digits = String(phone).replace(/[^0-9+]/g, '');
      if (!/^\+?\d{10,15}$/.test(digits)) {
        return res.status(400).json({ ok: false, message: 'เบอร์ผู้ส่ง (Twilio phone) ไม่ถูกต้อง เช่น +12025550123' });
      }
      db.setSetting('twilio_phone', digits);
      changed++;
    }
  }

  // บันทึก provider ที่เลือก (ถ้ามีการเปลี่ยน)
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'provider')) {
    db.setSetting('sms_provider', chosen);
    changed++;
  }

  // รีเซ็ต client ที่แคชไว้ เพื่อให้ใช้ค่าใหม่ทันที
  require('./sms')._resetClient();

  console.log(`👑 [แอดมิน] บันทึกการตั้งค่า SMS (provider=${chosen}, ${changed} รายการ)`);
  res.json({
    ok: true,
    message: changed > 0 ? `บันทึกการตั้งค่า SMS แล้ว (provider: ${chosen}, ${changed} รายการ)` : 'ไม่มีรายการที่เปลี่ยนแปลง',
  });
});

// ทดสอบส่ง SMS จริง (ต้องตั้งค่า provider ครบก่อน) — รับเบอร์ปลายทางจากหน้าแอดมิน
app.post('/api/admin/sms-test', requireAdmin, async (req, res) => {
  const sms = require('./sms');
  const result = await sms.sendTestSms({ to: String(req.body?.to || '').trim() });
  if (!result.ok) {
    return res.status(400).json({ ok: false, message: result.error || 'ส่ง SMS ทดสอบไม่สำเร็จ' });
  }
  console.log(`👑 [แอดมิน] ทดสอบส่ง SMS สำเร็จ (${result.provider}, id=${result.sid})`);
  res.json({
    ok: true,
    message: 'ส่ง SMS ทดสอบสำเร็จแล้ว (ตรวจที่เบอร์ปลายทาง)',
    provider: result.provider,
    sid: result.sid,
  });
});

// ตั้งค่า SMS-OTP (แอดมิน)
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { otpTtlMinutes, otpMaxAttempts, devMode: dev } = req.body || {};
  let changed = 0;

  if (otpTtlMinutes !== undefined && Number(otpTtlMinutes) >= 1 && Number(otpTtlMinutes) <= 60) {
    db.setSetting('otp_ttl_minutes', Number(otpTtlMinutes));
    changed++;
  }
  if (otpMaxAttempts !== undefined && Number(otpMaxAttempts) >= 1 && Number(otpMaxAttempts) <= 20) {
    db.setSetting('otp_max_attempts', Number(otpMaxAttempts));
    changed++;
  }
  if (typeof dev === 'boolean') {
    db.setSetting('dev_mode', String(dev));
    changed++;
  }

  console.log(`👑 [แอดมิน] บันทึกการตั้งค่า SMS-OTP (${changed} รายการ)`);
  res.json({
    ok: true,
    message: changed > 0 ? `บันทึกการตั้งค่าแล้ว (${changed} รายการ)` : 'ไม่มีรายการที่เปลี่ยนแปลง',
  });
});

// ---------------------------------------------------------------------------
// เริ่มเซิร์ฟเวอร์
// ---------------------------------------------------------------------------
(async () => {
  try {
    await db.initDb();
    await db.deleteExpiredSessions();

    // สร้างบัญชีแอดมินครั้งแรก (ถ้ายังไม่มี) — ตั้งค่าได้ผ่าน ADMIN_EMAIL/ADMIN_PASSWORD ใน .env
    if (!await db.findAdmin()) {
      const adminEmail = String(process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
      const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123!';
      const hash = await bcrypt.hash(adminPassword, 10);
      await db.createAdminUser({ email: adminEmail, passwordHash: hash });
      console.log('==============================================');
      console.log('👑 สร้างบัญชีแอดมินเรียบร้อย:');
      console.log(`   อีเมล: ${adminEmail}`);
      console.log(`   รหัสผ่าน: ${process.env.ADMIN_PASSWORD ? '(จาก .env)' : 'Admin@123! (ควรเปลี่ยนทันที)'}`);
      console.log('==============================================');
    }

    app.listen(PORT, () => {
      console.log('==============================================');
      console.log(`🛍️  เซิร์ฟเวอร์ร้านค้าออนไลน์รันที่: http://localhost:${PORT}`);
      console.log(`    โหมด: ${DEV_MODE ? 'DEV (โหมดจำลอง OTP/อีเมล)' : 'PRODUCTION'}`);
      console.log(`    หน้าแรก: http://localhost:${PORT}/`);
      console.log(`    สมัครสมาชิก: http://localhost:${PORT}/register.html`);
      console.log('==============================================');
    });
  } catch (err) {
    console.error('❌ ไม่สามารถเชื่อมต่อฐานข้อมูล MySQL ได้:', err.message);
    process.exit(1);
  }
})();
