/**
 * app.js — ประกอบ Express app: middleware → guard → static → router
 */
'use strict';

const path = require('node:path');
const express = require('express');
const db = require('./db');
const { devMode } = require('./lib/settings');
const { getGoogleConfig } = require('./lib/google-oauth');
const { adminGuard, accountGuard, shopGuard, ownerGuard } = require('./middleware/guards');
const authRoutes = require('./routes/auth');
const passwordResetRoutes = require('./routes/password-reset');
const googleRoutes = require('./routes/google');
const accountRoutes = require('./routes/account');
const adminPageRoutes = require('./routes/admin-pages');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payments');
const shopRoutes = require('./routes/shop');
const orderRoutes = require('./routes/orders');
const publicRoutes = require('./routes/public');

const app = express();

// อยู่หลัง Nginx (reverse proxy) — ทำให้ req.protocol อ่านค่า https ถูกต้อง
// ไม่งั้นลิงก์ที่ส่งในอีเมล/QR จะออกมาเป็น http:// ซึ่งเสี่ยงถูกกรองเป็นสแปม
app.set('trust proxy', 1);

// เพดาน 4mb เผื่ออัปโหลดรูป (base64) จากพื้นที่ร้านค้า — route อื่นยังมี body เล็ก
app.use(express.json({ limit: '4mb' }));

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

// guard หน้าเว็บ (ต้องมาก่อน static เพื่อกันไฟล์ใน /admin)
// หน้าจัดการแพ็กเกจเป็นของเจ้าของระบบเท่านั้น — ต้องประกาศก่อน adminGuard
app.use('/admin/packages.html', ownerGuard);
app.use('/admin/payments.html', ownerGuard);
app.use('/admin/purchase-history.html', ownerGuard);
app.use('/admin', adminGuard);
app.use(['/dashboard', '/settings'], accountGuard);
app.use('/shop', shopGuard);

// หน้า HTML หลังบ้าน — แทรกเมนูตามบทบาทฝั่งเซิร์ฟเวอร์ (ต้องมาก่อน express.static)
app.use(adminPageRoutes);
// ระบบรับชำระเงิน (ตั้งค่าช่องทางรับเงิน + คิวตรวจสอบยอด + QR PromptPay)
app.use(paymentRoutes);

// หน้าบัญชี (page routes) — ต้องมาก่อน static เช่นเดียวกับต้นฉบับ
app.use(accountRoutes);
// พื้นที่ร้านค้า (/shop, /s/:code) + API ร้านค้าและ API สาธารณะ
app.use(shopRoutes);
// โต๊ะ/QR/บิล + หน้าสั่งอาหารลูกค้า (/order/:token)
app.use(orderRoutes);
app.use(publicRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

// config ให้หน้าเว็บใช้ (reCAPTCHA site key + โหมด dev + เปิดใช้ Google login หรือยัง)
app.get('/api/config', (req, res) => {
  res.json({
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || null,
    devMode: devMode(),
    // ยังไม่ตั้งค่า key ของ Google → ซ่อนปุ่มล็อกอินด้วย Google (ไม่ให้ผู้ใช้สับสน)
    googleEnabled: getGoogleConfig().configured,
    // [ชั่วคราว] ผลการล้างประวัติการชำระเงิน/การซื้อ — ใช้ตรวจหลัง deploy แล้วจะเอาออก
    maint: db.getSetting('payment_history_purged_info') || null,
  });
});

app.use(authRoutes);
app.use(passwordResetRoutes);
app.use(googleRoutes);
app.use(adminRoutes);

module.exports = app;
