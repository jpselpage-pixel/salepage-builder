/**
 * google.js — ล็อกอินด้วย Google (OAuth จริง/โหมด mock) + ตั้งสมัครให้ครบ
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const otp = require('../lib/otp');
const { isValidEmail, isValidThaiPhone, normalizeThaiPhone, passwordStrengthScore } = require('../lib/validators');
const { devMode } = require('../lib/settings');
const { isAdminRole, isShop } = require('../lib/roles');
const { startSession, requirePendingGoogle } = require('../middleware/auth');
const { PORT } = require('../config');

const router = express.Router();

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
router.get('/api/auth/google/url', (req, res) => {
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
router.get('/api/auth/google/callback', async (req, res) => {
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
router.post('/api/auth/google/mock', async (req, res) => {
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
  if (mode === 'redirect') return res.redirect(isAdminRole(user.role) ? '/admin/' : isShop(user.role) ? '/shop' : '/settings/profile');
  res.json({ ok: true, redirect: isAdminRole(user.role) ? '/admin/' : isShop(user.role) ? '/shop' : '/settings/profile' });
}

// ---------------------------------------------------------------------------
// Google setup — ผู้ใช้ค้าง (ยังไม่ตั้งรหัส/เบอร์) กรอกให้ครบ
// ต้องล็อกอิน (session จาก Google) และสถานะ pending เท่านั้น
// ---------------------------------------------------------------------------


// ขอ OTP ยืนยันเบอร์ (ขั้นตอน Google setup)
router.post('/api/google-setup/send-otp', requirePendingGoogle, async (req, res) => {
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
router.post('/api/google-setup/complete', requirePendingGoogle, async (req, res) => {
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

  res.json({ ok: true, message: 'สมัครสมาชิกเสร็จสมบูรณ์', redirect: '/settings/profile' });
});

module.exports = router;
