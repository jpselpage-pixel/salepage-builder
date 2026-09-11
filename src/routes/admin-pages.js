/**
 * admin-pages.js — ส่งหน้า HTML ของหลังบ้านโดย "แทรกเมนูตามบทบาท" ฝั่งเซิร์ฟเวอร์
 *
 * เหตุผล: เมนู "แพ็กเกจร้านค้า" เป็นของเจ้าของระบบเท่านั้น แต่หน้าแอดมินทุกหน้าใช้ร่วมกับ admin
 * ถ้าใช้ JS ซ่อน/โชว์ทีหลัง เมนูจะกระพริบทุกครั้งที่เปลี่ยนหน้า — จึงเรนเดอร์ตั้งแต่ฝั่งเซิร์ฟเวอร์
 * ไฟล์ HTML มีจุดแทนที่ <!--MENU_PACKAGES--> ไว้ แล้วสคริปต์นี้จะแทนด้วยเมนู (หรือลบทิ้งถ้าไม่ใช่ owner)
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const { getCurrentUser } = require('../middleware/auth');
const { isAdminRole, isOwner } = require('../lib/roles');

const router = express.Router();
const ADMIN_DIR = path.join(__dirname, '..', '..', 'public', 'admin');
const PAGES = ['index.html', 'otp.html', 'users.html', 'profile.html', 'packages.html'];

const OWNER_MENU = `      <a class="side-link{{ACTIVE}}" href="/admin/packages.html">
        <svg viewBox="0 0 24 24" fill="none"><path d="M21 16V8a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3.3 7L12 12l8.7-5M12 22V12" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        แพ็กเกจร้านค้า
      </a>`;

router.get(['/admin/', '/admin/:file'], async (req, res, next) => {
  const file = req.params.file || 'index.html';
  if (!PAGES.includes(file)) return next(); // ไฟล์อื่น (css/js/รูป) ให้ express.static จัดการ

  const user = await getCurrentUser(req);
  if (!user || !isAdminRole(user.role)) return next(); // ไม่ผ่านสิทธิ์ = ให้ guard จัดการต่อ

  let html;
  try {
    html = await fs.readFile(path.join(ADMIN_DIR, file), 'utf8');
  } catch (err) {
    return next(); // ไม่มีไฟล์ → ปล่อยให้ static ตอบ 404
  }

  const menu = isOwner(user.role)
    ? OWNER_MENU.replace('{{ACTIVE}}', file === 'packages.html' ? ' active' : '')
    : '';
  html = html.replace(/^[ \t]*<!--MENU_PACKAGES-->[ \t]*\r?\n/m, menu ? menu + '\n' : '');

  res.set('Cache-Control', 'no-store'); // HTML ขึ้นกับบทบาทผู้ใช้ — ห้ามแคช
  res.type('html').send(html);
});

module.exports = router;
