/**
 * password-reset.js — กู้รหัสผ่านด้วย OTP ทางอีเมล (3 ขั้นตอน)
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const otp = require('../lib/otp');
const { sha256, randomToken } = require('../lib/crypto');
const { nowSql, futureSql } = require('../lib/time');
const { isValidEmail, passwordStrengthScore } = require('../lib/validators');
const { devMode } = require('../lib/settings');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();

// ---------------------------------------------------------------------------
// API: กู้รหัสผ่าน — ขั้นที่ 1 ส่ง OTP ทางอีเมล
// ---------------------------------------------------------------------------
router.post('/api/forgot-password', async (req, res) => {
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
router.post('/api/forgot-verify-otp', async (req, res) => {
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
router.post('/api/forgot-reset-password', async (req, res) => {
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

module.exports = router;
