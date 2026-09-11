/**
 * config.js — ค่าคงที่ระดับแอป (อ่านจาก environment ตอน boot)
 */
'use strict';

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 7) * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';
const COOKIE_NAME = 'session';
const RESEND_COOLDOWN_MS = 60 * 1000; // กัน spam ขอ OTP ซ้ำ 60 วินาที

module.exports = { PORT, SESSION_TTL_MS, COOKIE_SECURE, COOKIE_NAME, RESEND_COOLDOWN_MS };
