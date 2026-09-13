/**
 * auth.js — สมัครสมาชิก / ล็อกอิน / ยืนยัน OTP / เปลี่ยนรหัสผ่าน / ออกจากระบบ
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const otp = require('../lib/otp');
const mailer = require('../lib/mailer');
const { sha256, randomToken } = require('../lib/crypto');
const { futureSql } = require('../lib/time');
const { maskPhone, maskEmail, isValidEmail, isValidThaiPhone, normalizeThaiPhone, passwordStrengthScore } = require('../lib/validators');
const { devMode } = require('../lib/settings');
const { rateLimit } = require('../middleware/rate-limit');
const { isRecaptchaValid } = require('../middleware/recaptcha');
const { getCurrentUser, startSession } = require('../middleware/auth');
const { COOKIE_NAME, RESEND_COOLDOWN_MS } = require('../config');
const { isAdminRole, isOwner, isShop } = require('../lib/roles');

// ข้อความต่อท้าย log ตามบทบาท (ใช้แสดงใน console)
const roleNote = (role) => (isOwner(role) ? ' (เจ้าของระบบ)' : role === 'admin' ? ' (แอดมิน)' : isShop(role) ? ' (เจ้าของร้าน)' : '');

// ปลายทางหลังเข้าสู่ระบบ ตามบทบาทผู้ใช้
const homeFor = (user) => (isAdminRole(user.role) ? '/admin/' : isShop(user.role) ? '/shop' : '/settings/profile');

const router = express.Router();

// Express 4 ไม่ดัก error จาก async handler ให้เอง — ถ้าไม่ดัก คำขอจะค้างโดยไม่มี response
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// API: ตรวจสอบอีเมลซ้ำ
// ---------------------------------------------------------------------------
router.get('/api/check-email', async (req, res) => {
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
router.post('/api/register', wrap(async (req, res) => {
  const rl = rateLimit(req, { max: 10, windowMs: 60 * 1000, bucket: 'register' });
  if (rl.limited) {
    return res.status(429).json({
      ok: false,
      message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที (สมัครบ่อยเกินไป)`,
    });
  }

  const { email, password, phone, terms, gRecaptchaResponse } = req.body || {};

  // honeypot — บอทที่กรอกช่องซ่อนจะได้คำตอบ "สำเร็จ" หลอก แต่ไม่สร้างผู้ใช้
  if (req.body && req.body.website) {
    return res.json({ ok: true, message: 'สมัครสมาชิกสำเร็จ', redirect: '/settings/profile', honeypot: true });
  }
  // ตรวจว่ากรอกฟอร์มเร็วเกินไป (บอท) — ปกติมนุษย์ใช้เวลาอย่างน้อย ~2 วินาที
  const formStart = Number(req.body?.formStart || 0);
  if (formStart && Date.now() - formStart < 2000) {
    return res.json({ ok: true, message: 'สมัครสมาชิกสำเร็จ', redirect: '/settings/profile', honeypot: true });
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
      ? 'อีเมลนี้เคยสมัครค้างไว้ — เราส่งรหัส OTP ใหม่ไปที่เบอร์ของคุณแล้ว'
      : 'ส่งรหัส OTP ไปที่เบอร์โทรของคุณแล้ว กรุณากรอกรหัส 6 หลักเพื่อสมัครต่อ',
    userId: user.id,
    phoneMasked: maskPhone(user.phone),
    otpExpiresAt: otpResult.expiresAt,
    dev: devMode() ? { devOtp: otpResult.code } : null, // โหมด dev: แสดงรหัสเพื่อทดสอบ
  });
}));

// ---------------------------------------------------------------------------
// API: ยืนยัน OTP ทาง SMS (ขั้นที่ 1 ของการสมัคร) → เปิดบัญชี + ส่ง OTP ทางอีเมล
// ---------------------------------------------------------------------------
router.post('/api/register/verify-sms', wrap(async (req, res) => {
  const rl = rateLimit(req, { max: 10, windowMs: 60 * 1000, bucket: 'verify-sms' });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const { userId, code, password } = req.body || {};
  const user = await db.findUserById(Number(userId));
  if (!user) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้ กรุณาสมัครใหม่' });

  if (user.status !== 'active') {
    const result = await otp.verifyOtp(user.id, String(code || ''));
    if (!result.ok) return res.status(400).json({ ok: false, message: result.message });
    await db.setUserStatus(user.id, 'active');
    console.log(`✅ ยืนยันเบอร์โทรแล้ว: ${user.email} → ${user.phone}`);
  }

  // ผู้ใช้อาจแก้รหัสผ่านระหว่างขั้นตอน (เช่น รีเฟรชหน้าแล้วพิมพ์ใหม่) → บันทึกค่าล่าสุดให้
  if (password) {
    if (passwordStrengthScore(String(password)) < 3) {
      return res.status(400).json({ ok: false, field: 'password', message: 'รหัสผ่านอ่อนเกินไป ต้องมีอย่างน้อย 8 ตัว และผ่านอย่างน้อย 3 เกณฑ์' });
    }
    await db.updateUserPassword(user.id, await bcrypt.hash(String(password), 10));
  }

  // ยืนยันอีเมลไว้แล้ว (ไม่ควรเกิดในเส้นทางสมัคร) → เข้าสู่ระบบให้เลย
  if (user.is_email_verified === 1) {
    await startSession(res, user.id);
    return res.json({ ok: true, alreadyVerified: true, message: 'ยืนยันตัวตนครบแล้ว เข้าสู่ระบบแล้ว', redirect: homeFor(user) });
  }

  const sent = await otp.issueOtp(user.id, user.email, 'email_verify', { awaitDelivery: true });
  const emailOk = !sent.delivered || sent.delivered.ok;
  console.log(`📧 ${emailOk ? 'ส่ง' : 'ส่งไม่สำเร็จ'}รหัสยืนยันอีเมลไปที่ ${user.email}${emailOk ? '' : ' — ' + sent.delivered.error}`);
  // บันทึกสถานะการส่งล่าสุด (ให้แอดมินตรวจได้ว่าอีเมลออกจริงไหม)
  if (!emailOk) await db.setSetting('mail_debug', 'fail: ' + String(sent.delivered.error).slice(0, 160));
  else await db.setSetting('mail_debug', 'ok');

  res.json({
    ok: true,
    message: emailOk
      ? 'ยืนยันเบอร์โทรสำเร็จ — เราส่งรหัส OTP ไปที่อีเมลของคุณแล้ว'
      : 'ยืนยันเบอร์โทรสำเร็จ แต่ส่งอีเมลไม่สำเร็จ — กรุณากด "ส่งรหัสใหม่" หรือแจ้งผู้ดูแลระบบ',
    emailMasked: maskEmail(user.email),
    emailSent: emailOk,
    otpExpiresAt: sent.expiresAt,
    // แสดงรหัสให้ทดสอบเฉพาะเมื่อ "ยังไม่ได้ตั้งค่า SMTP" (ช่องทางอีเมลทำงานอิสระจากโหมด dev)
    dev: mailer.getSmtpConfig().configured ? null : { devOtp: sent.code },
  });
}));

// ---------------------------------------------------------------------------
// API: ยืนยัน OTP ทางอีเมล (ขั้นที่ 2) → ยืนยันอีเมล + ล็อกอินอัตโนมัติ
// ---------------------------------------------------------------------------
router.post('/api/register/verify-email', wrap(async (req, res) => {
  const rl = rateLimit(req, { max: 10, windowMs: 60 * 1000, bucket: 'verify-email' });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const { userId, code } = req.body || {};
  const user = await db.findUserById(Number(userId));
  if (!user) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้ กรุณาสมัครใหม่' });

  const result = await otp.verifyOtp(user.id, String(code || ''), 'email_verify');
  if (!result.ok) return res.status(400).json({ ok: false, message: result.message });

  await db.setEmailVerified(user.id, 1);
  await startSession(res, user.id); // ล็อกอินอัตโนมัติเมื่อสมัครครบขั้นตอน
  console.log(`🎉 สมัครสมาชิกครบขั้นตอน: ${user.email} (ยืนยันเบอร์ + อีเมลแล้ว)${roleNote(user.role)}`);

  res.json({
    ok: true,
    message: 'ยืนยันอีเมลสำเร็จ เข้าสู่ระบบแล้ว',
    redirect: homeFor(user),
  });
}));

// ---------------------------------------------------------------------------
// API: ขอ OTP ใหม่ (จำกัด 60 วินาที)
// ---------------------------------------------------------------------------
router.post('/api/resend-otp', wrap(async (req, res) => {
  const rl = rateLimit(req, { max: 5, windowMs: 60 * 1000, bucket: 'resend-otp' });
  if (rl.limited) {
    return res.status(429).json({ ok: false, message: `ลองอีกครั้งในอีก ${rl.retryAfter} วินาที` });
  }

  const { userId, purpose } = req.body || {};
  const user = await db.findUserById(Number(userId));
  if (!user) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });

  // ขอรหัสใหม่ได้ทั้งรหัสทาง SMS (สมัครสมาชิก) และรหัสทางอีเมล (ยืนยันอีเมล)
  const which = purpose === 'email_verify' ? 'email_verify' : 'signup';
  if (which === 'email_verify' && user.is_email_verified === 1) {
    return res.status(400).json({ ok: false, message: 'อีเมลนี้ยืนยันแล้ว' });
  }

  const last = await db.findLatestOtp(user.id, which);
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

  const contact = which === 'email_verify' ? user.email : user.phone;
  const otpResult = await otp.issueOtp(user.id, contact, which, { awaitDelivery: which === 'email_verify' });
  const emailOk = which !== 'email_verify' || !otpResult.delivered || otpResult.delivered.ok;
  if (which === 'email_verify') await db.setSetting('mail_debug', emailOk ? 'ok' : 'fail: ' + String(otpResult.delivered.error).slice(0, 160));
  res.json({
    ok: true,
    message: which === 'email_verify'
      ? (emailOk ? 'ส่งรหัสยืนยันอีเมลใหม่แล้ว' : 'ส่งอีเมลไม่สำเร็จ — กรุณาลองใหม่หรือแจ้งผู้ดูแลระบบ')
      : 'ส่งรหัส OTP ใหม่แล้ว',
    emailSent: emailOk,
    otpExpiresAt: otpResult.expiresAt,
    // รหัสทางอีเมลแสดงได้เมื่อยังไม่ได้ตั้งค่า SMTP / รหัสทาง SMS แสดงเมื่ออยู่ในโหมด dev
    dev: (which === 'email_verify' ? !mailer.getSmtpConfig().configured : devMode()) ? { devOtp: otpResult.code } : null,
  });
}));

// ---------------------------------------------------------------------------
// API: เข้าสู่ระบบ
// ---------------------------------------------------------------------------
router.post('/api/login', async (req, res) => {
  const rl = rateLimit(req, { max: 10, windowMs: 60 * 1000, bucket: 'login' });
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
  console.log(`🔓 เข้าสู่ระบบ: ${user.email}${roleNote(user.role)}`);
  res.json({
    ok: true,
    message: 'เข้าสู่ระบบสำเร็จ',
    redirect: isAdminRole(user.role) ? '/admin/' : isShop(user.role) ? '/shop' : '/settings/profile',
  });
});

// ---------------------------------------------------------------------------
// API: ออกจากระบบ
// ---------------------------------------------------------------------------
router.post('/api/logout', async (req, res) => {
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
router.get('/api/me', async (req, res) => {
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
      gift_expires_at: user.gift_expires_at || null,
    },
  });
});

// ---------------------------------------------------------------------------
// API: ส่งลิงก์ยืนยันอีเมลใหม่ (ต้องล็อกอิน)
// ---------------------------------------------------------------------------
router.post('/api/send-verify-email', async (req, res) => {
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
    // แสดงลิงก์เฉพาะเมื่อยังไม่ได้ตั้งค่า SMTP — ช่องทางอีเมลแยกจากโหมด dev
    dev: mailer.getSmtpConfig().configured ? null : { devVerifyLink: sent.link },
  });
});

// ---------------------------------------------------------------------------
// API: เปลี่ยนรหัสผ่าน (ต้องล็อกอิน) — ตรวจรหัสเดิม + ตั้งใหม่ + ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้
// ---------------------------------------------------------------------------
router.post('/api/change-password', async (req, res) => {
  const rl = rateLimit(req, { max: 8, windowMs: 60 * 1000, bucket: 'change-password' });
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
router.post('/api/logout-all', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });

  const token = req.cookies?.session;
  if (token) await db.deleteOtherSessions(user.id, sha256(token));

  console.log(`🔓 ออกจากระบบทุกเครื่องแล้ว: ${user.email}`);
  res.json({ ok: true, message: 'ออกจากระบบทุกเครื่องแล้ว (ยกเว้นเครื่องนี้)' });
});

module.exports = router;
