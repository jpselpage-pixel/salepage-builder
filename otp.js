/**
 * otp.js — สร้าง/ตรวจสอบรหัส OTP ยืนยันเบอร์โทร
 *
 * โหมด dev (DEV_MODE=true): ไม่ส่ง SMS จริง — log รหัสที่ console เซิร์ฟเวอร์
 * และ server.js จะแนบรหัสกลับใน response ด้วย (เพื่อให้ทดสอบได้สะดวก)
 *
 * การใช้งานจริง: ใส่ service SMS (เช่น Twilio) ใน sendOtpSms()
 * แล้วปิด DEV_MODE — ระบบจะไม่แสดงรหัสใน response อีกต่อไป
 */
'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const mailer = require('./mailer');
const sms = require('./sms');

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 5);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const DEV_MODE = String(process.env.DEV_MODE || 'true') === 'true';

// อ่านค่าตั้งค่าจากตาราง settings ก่อน (แอดมินปรับได้) แล้วค่อยใช้ค่า env เป็นค่าเริ่มต้น
function getOtpTtlMinutes() {
  const s = db.getSetting('otp_ttl_minutes');
  return s !== null && s !== '' ? Number(s) : OTP_TTL_MINUTES;
}

function getOtpMaxAttempts() {
  const s = db.getSetting('otp_max_attempts');
  return s !== null && s !== '' ? Number(s) : OTP_MAX_ATTEMPTS;
}

function devModeEnabled() {
  const s = db.getSetting('dev_mode');
  return s !== null ? s === 'true' : DEV_MODE;
}

function generateOtp() {
  // 6 หลักแบบสุ่มปลอดภัย (หลีกเลี่ยงเลขขึ้นต้น 0 เพื่อให้จำง่าย/กันลักไก่)
  const digits = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  return digits;
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// เวลาท้องถิ่นรูปแบบ YYYY-MM-DD HH:MM:SS (ให้ตรงกับ datetime('now','localtime') ใน DB)
function pad(n) { return String(n).padStart(2, '0'); }
function localNowSql() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function localFutureSql(ms) {
  const d = new Date(Date.now() + ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * สร้าง OTP ใหม่สำหรับผู้ใช้ + 'ส่ง' ผ่านช่องทางตาม purpose
 * @param {number} userId
 * @param {string} contact  เบอร์โทร (signup) หรืออีเมล (password_reset)
 * @param {string} purpose  'signup' | 'password_reset'
 * @returns {{ code: string, expiresAt: string, otpId: number }}
 */
function issueOtp(userId, contact, purpose = 'signup') {
  const code = generateOtp();
  const ttl = getOtpTtlMinutes();
  const expiresAt = localFutureSql(ttl * 60 * 1000);

  const otpId = db.createOtp({
    userId,
    codeHash: hashOtp(code),
    contact,
    purpose,
    expiresAt,
  });

  if (purpose === 'password_reset') {
    // กู้รหัสผ่าน → ส่ง OTP ทางอีเมล
    mailer.sendOtpEmail({ email: contact, code });
    console.log(`🔐 [OTP กู้รหัสผ่าน — โหมดจำลอง] ส่งไปยังอีเมล ${contact}`);
  } else {
    // ยืนยันเบอร์ → ส่ง SMS (จริง/จำลอง ตาม config) — ส่งแบบไม่บล็อก response
    sendOtpSms(contact, code).catch((err) => {
      console.error('❌ ส่ง SMS OTP ผิดพลาด:', err.message);
    });
  }
  return { code, expiresAt, otpId };
}

/**
 * ตรวจสอบรหัสที่ผู้ใช้กรอก (ตาม purpose)
 * @returns {{ ok: boolean, message?: string }}
 */
function verifyOtp(userId, inputCode, purpose = 'signup') {
  const record = db.findLatestOtp(userId, purpose);

  if (!record || record.used === 1) {
    return { ok: false, message: 'รหัส OTP ไม่ถูกต้องหรือหมดอายุแล้ว' };
  }
  if (record.expires_at <= localNowSql()) {
    return { ok: false, message: 'รหัส OTP หมดอายุแล้ว กรุณาขอรหัสใหม่' };
  }
  if (record.attempts >= getOtpMaxAttempts()) {
    return { ok: false, message: 'ลองผิดเกินจำนวนครั้งที่กำหนด กรุณาขอรหัสใหม่' };
  }
  if (hashOtp(inputCode.trim()) !== record.code_hash) {
    db.incrementOtpAttempts(record.id);
    const left = getOtpMaxAttempts() - (record.attempts + 1);
    return {
      ok: false,
      message: left > 0
        ? `รหัส OTP ไม่ถูกต้อง (เหลือโอกาสอีก ${left} ครั้ง)`
        : 'ลองผิดเกินจำนวนครั้งที่กำหนด กรุณาขอรหัสใหม่',
    };
  }

  db.markOtpUsed(record.id);
  return { ok: true };
}

/**
 * ส่ง SMS OTP:
 *  - โหมดจริง (dev ปิด) → ส่ง SMS ผ่าน provider ที่เลือก (Twilio / ThaiBulkSMS)
 *  - โหมด dev → จำลอง (พิมพ์ที่ console + หน้าเว็บแสดงรหัส)
 */
async function sendOtpSms(phone, code) {
  const ttl = getOtpTtlMinutes();
  const body = `รหัสยืนยันของคุณคือ ${code} (มีอายุ ${ttl} นาที) — ร้านค้าออนไลน์`;
  const dev = devModeEnabled();

  if (!dev) {
    // โหมดจริง: ส่งผ่าน provider ที่เลือกไว้ (ตรวจ config ของ provider นั้นโดยตรงใน sms.js)
    const result = await sms.sendSms({ to: phone, body });
    if (result.ok) {
      console.log(`📱 [SMS จริง — ${result.provider}] ส่งไป ${phone} (id=${result.sid})`);
    } else {
      console.log(`📱 [SMS จริง — ส่งไม่สำเร็จ] ไป ${phone}: ${result.error}`);
      console.log('   ⚠️ ตรวจการตั้งค่า SMS ที่หน้าแอดมิน (ผู้ให้บริการ/API Key/เครดิต)');
    }
    return;
  }

  console.log('📱 [SMS — โหมดจำลอง] ส่ง OTP ไปที่ ' + phone);
  console.log('   รหัสยืนยันของคุณ: ' + code);
  console.log('   (หมดอายุใน ' + ttl + ' นาที — ยังไม่ได้ส่ง SMS จริง)');
}

module.exports = {
  issueOtp,
  verifyOtp,
  getOtpTtlMinutes,
  getOtpMaxAttempts,
  devModeEnabled,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  DEV_MODE,
};
