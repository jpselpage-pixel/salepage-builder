/**
 * account.js — หน้าบัญชี (/dashboard, /settings) และการยืนยันอีเมล
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const db = require('../db');
const { sha256 } = require('../lib/crypto');
const { nowSql } = require('../lib/time');
const { buildResultPage } = require('../lib/result-page');
const { getCurrentUser } = require('../middleware/auth');
const { isShop } = require('../lib/roles');

const router = express.Router();
const DASHBOARD_FILE = path.join(__dirname, '..', '..', 'public', 'dashboard', 'index.html');

/**
 * เมนู "ร้านค้า" ในแถบข้าง ต่างกันตามบทบาท — เรนเดอร์จากเซิร์ฟเวอร์ตั้งแต่แรก
 * (เดิมใช้ JS สลับข้อความ/ซ่อน ทำให้เมนูกะพริบทุกครั้งที่เปลี่ยนหน้า)
 */
function shopMenuHtml(role) {
  if (!role || role === 'admin' || role === 'owner') return '';
  const shop = isShop(role);
  const href = shop ? '/shop/menu.html' : '/shop/purchase.html';
  const label = shop ? 'ร้านค้าของฉัน' : 'ซื้อแพ็กเกจร้านค้า';
  return `      <div class="menu-title">ร้านค้า</div>
      <a class="menu-item" href="${href}">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 6h18M16 10a4 4 0 01-8 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${label}</span>
      </a>`;
}

// หน้าบัญชี — ใช้ไฟล์เดียว เลือก panel จาก URL (/settings/profile, /settings/security)
router.get(['/dashboard', '/dashboard/'], (req, res) => res.redirect('/settings/profile'));
router.get(['/settings', '/settings/'], (req, res) => res.redirect('/settings/profile'));
router.get(['/dashboard/:section', '/settings/:section'], async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    let html = await fs.readFile(DASHBOARD_FILE, 'utf8');
    const menu = shopMenuHtml(user && user.role);
    html = html.replace(/^[ \t]*<!--SHOP_MENU-->[ \t]*\r?\n/m, menu ? menu + '\n' : '');
    res.set('Cache-Control', 'no-store'); // HTML ขึ้นกับบทบาทผู้ใช้ — ห้ามแคช
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// ยืนยันอีเมล (เปิดจากลิงก์ในอีเมล)
// ---------------------------------------------------------------------------
router.get('/verify-email', async (req, res) => {
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

module.exports = router;
