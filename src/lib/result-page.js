/**
 * หน้าผลลัพธ์การยืนยันอีเมล (HTML)
 * @param success   ยืนยันสำเร็จหรือไม่
 * @param message   ข้อความเมื่อไม่สำเร็จ
 * @param viewer    ผู้ใช้ที่กำลังล็อกอินอยู่ (ถ้ามี) — ใช้เลือกปุ่มให้ตรงกับสถานะจริง
 * @param targetUserId  เจ้าของอีเมลที่ถูกยืนยัน (ถ้าล็อกอินเป็นคนละบัญชี จะไม่พาไปหน้าของเจ้าของ)
 */

'use strict';

function buildResultPage(success, message, { viewer = null, targetUserId = null } = {}) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // ล็อกอินอยู่แล้ว "และเป็นบัญชีเดียวกัน" → ปุ่มพาเข้าใช้งานต่อ ไม่ใช่พาไปหน้าล็อกอิน
  const loggedIn = Boolean(viewer) && (targetUserId == null || Number(viewer.id) === Number(targetUserId));
  let dest = '/login.html';
  let label = 'ไปหน้าเข้าสู่ระบบ';
  if (loggedIn) {
    // กรณีผิดพลาด/หมดอายุ → พาไปหน้าบัญชีของฉัน ซึ่งมีปุ่มขอลิงก์ยืนยันใหม่
    if (!success) { dest = '/settings/profile'; label = 'ไปที่บัญชีของฉัน'; }
    else if (viewer.role === 'owner' || viewer.role === 'admin') { dest = '/admin/'; label = 'ไปหน้าจัดการระบบ'; }
    else if (viewer.role === 'shop') { dest = '/shop'; label = 'ไปที่ร้านค้าของฉัน'; }
    else { dest = '/settings/profile'; label = 'ไปที่บัญชีของฉัน'; }
  }
  const accent = success ? '#16a34a' : '#dc2626';
  const accentBg = success ? '#dcfce7' : '#fee2e2';
  const statusSvg = success
    ? '<svg viewBox="0 0 24 24" fill="none" width="34" height="34"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" width="30" height="30"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const sub = success
    ? (loggedIn
      ? 'อีเมลของคุณได้รับการยืนยันแล้ว — คุณเข้าสู่ระบบอยู่แล้ว เข้าใช้งานต่อได้เลย'
      : 'อีเมลของคุณได้รับการยืนยันแล้ว — เข้าสู่ระบบเพื่อเริ่มใช้งานได้เลย')
    : esc(message);
  const btnIcon = loggedIn
    ? '<path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${success ? 'ยืนยันอีเมลสำเร็จ' : 'เกิดข้อผิดพลาด'} | ระบบสมาชิก</title>
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
      ระบบสมาชิก
    </div>
    <div class="status">${statusSvg}</div>
    <h1>${success ? 'ยืนยันอีเมลสำเร็จ' : 'เกิดข้อผิดพลาด'}</h1>
    <div class="sub">${sub}</div>
    <a class="btn" href="${dest}">
      <svg viewBox="0 0 24 24" fill="none">${btnIcon}</svg>
      ${label}
    </a>
    <div class="hint">ระบบสมาชิก</div>
  </div>
</body>
</html>`;
}

module.exports = { buildResultPage };
