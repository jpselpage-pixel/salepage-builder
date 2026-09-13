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
const db = require('../db');
const mailer = require('./mailer');
const sms = require('./sms');
const { devMode } = require('./settings');
const { sha256 } = require('./crypto');
const { isExpired, futureSql } = require('./time');

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 5);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);

// purpose ที่ส่งรหัสทาง "อีเมล" — ที่เหลือส่งทาง SMS (ช่องทางอีเมลทำงานอิสระจากโหมด dev)
const EMAIL_PURPOSES = new Set(['password_reset', 'email_verify']);

// อ่านค่าตั้งค่าจากตาราง settings ก่อน (แอดมินปรับได้) แล้วค่อยใช้ค่า env เป็นค่าเริ่มต้น
function getOtpTtlMinutes() {
  const s = db.getSetting('otp_ttl_minutes');
  return s !== null && s !== '' ? Number(s) : OTP_TTL_MINUTES;
}

function getOtpMaxAttempts() {
  const s = db.getSetting('otp_max_attempts');
  return s !== null && s !== '' ? Number(s) : OTP_MAX_ATTEMPTS;
}

function generateOtp() {
  // 6 หลักแบบสุ่มปลอดภัย (หลีกเลี่ยงเลขขึ้นต้น 0 เพื่อให้จำง่าย/กันลักไก่)
  const digits = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  return digits;
}

/**
 * สร้าง OTP ใหม่สำหรับผู้ใช้ + 'ส่ง' ผ่านช่องทางตาม purpose
 * @param {number} userId
 * @param {string} contact  เบอร์โทร (signup) หรืออีเมล (password_reset / email_verify)
 * @param {string} purpose  'signup' | 'password_reset' | 'email_verify'
 * @returns {{ code: string, expiresAt: string, otpId: number }}
 */
async function issueOtp(userId, contact, purpose = 'signup', { awaitDelivery = false } = {}) {
  const code = generateOtp();
  const ttl = getOtpTtlMinutes();
  const expiresAt = futureSql(ttl * 60 * 1000);

  const otpId = await db.createOtp({
    userId,
    codeHash: sha256(code),
    contact,
    purpose,
    expiresAt,
    codeVisible: code, // เก็บรหัส (plaintext) ให้แอดมินดูใน log — การยืนยันยังใช้ hash เสมอ
  });

  // ส่งจริง + บันทึกผลลง log — ทำแบบไม่บล็อก response (ผู้ใช้ไม่ต้องรอ SMS/อีเมล)
  // ยกเว้นเมื่อผู้เรียกระบุ awaitDelivery (เช่น ขั้นสมัครที่ต้องรู้ว่าส่งอีเมลสำเร็จไหม เพื่อแจ้งผู้ใช้)
  let delivered = null;
  if (EMAIL_PURPOSES.has(purpose)) {
    if (awaitDelivery) delivered = await deliverOtpEmail(otpId, contact, code, purpose);
    else deliverOtpEmail(otpId, contact, code, purpose);
  } else {
    deliverOtpSms(otpId, contact, code, ttl);
  }
  return { code, expiresAt, otpId, delivered };
}

/**
 * ส่ง SMS + บันทึกผล (สำเร็จ/ไม่สำเร็จ/เครดิตหมด/โหมดจำลอง) ลงรายการ OTP
 * ช่องทางแยกกันชัดเจน: OTP สมัครสมาชิกใช้ SMS เท่านั้น (อีเมลใช้เฉพาะกู้รหัสผ่าน)
 */
async function deliverOtpSms(otpId, phone, code, ttl) {
  try {
    const result = await sendOtpSms(phone, code, ttl);
    await db.setOtpNote(otpId, result.note);
  } catch (err) {
    await db.setOtpNote(otpId, 'ส่ง SMS ผิดพลาด: ' + String(err.message || err).slice(0, 200));
  }
}

/** ส่งอีเมล OTP (กู้รหัสผ่าน / ยืนยันอีเมล) + บันทึกผล — ช่องทางอีเมลทำงานอิสระจากโหมด dev */
async function deliverOtpEmail(otpId, email, code, purpose = 'password_reset') {
  const label = purpose === 'email_verify' ? 'รหัสยืนยันอีเมล' : 'OTP กู้รหัสผ่าน';
  try {
    if (!mailer.getSmtpConfig().configured) {
      console.log(`🔐 [${label} — ยังไม่ได้ตั้งค่า SMTP] ${email} → รหัส ${code}`);
      await db.setOtpNote(otpId, 'ยังไม่ได้ตั้งค่า SMTP — ไม่ได้ส่งอีเมลจริง');
      return { ok: false, error: 'ยังไม่ได้ตั้งค่า SMTP' };
    }
    const sent = await mailer.sendOtpEmail({ email, code, purpose });
    if (sent && sent.ok) {
      await db.setOtpNote(otpId, 'ส่งอีเมล OTP แล้ว (ตรวจอินบ็อกซ์)');
      return { ok: true };
    }
    const err = (sent && sent.error) || 'ไม่ทราบสาเหตุ';
    await db.setOtpNote(otpId, 'ส่งอีเมลไม่สำเร็จ: ' + String(err).slice(0, 200));
    return { ok: false, error: String(err).slice(0, 200) };
  } catch (err) {
    await db.setOtpNote(otpId, 'ส่งอีเมลผิดพลาด: ' + String(err.message || err).slice(0, 200));
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

/**
 * ตรวจสอบรหัสที่ผู้ใช้กรอก (ตาม purpose)
 * @returns {{ ok: boolean, message?: string }}
 */
async function verifyOtp(userId, inputCode, purpose = 'signup') {
  const record = await db.findLatestOtp(userId, purpose);

  if (!record || record.used === 1) {
    return { ok: false, message: 'รหัส OTP ไม่ถูกต้องหรือหมดอายุแล้ว' };
  }
  if (isExpired(record.expires_at)) {
    return { ok: false, message: 'รหัส OTP หมดอายุแล้ว กรุณาขอรหัสใหม่' };
  }
  if (record.attempts >= getOtpMaxAttempts()) {
    return { ok: false, message: 'ลองผิดเกินจำนวนครั้งที่กำหนด กรุณาขอรหัสใหม่' };
  }
  if (sha256(inputCode.trim()) !== record.code_hash) {
    await db.incrementOtpAttempts(record.id);
    const left = getOtpMaxAttempts() - (record.attempts + 1);
    return {
      ok: false,
      message: left > 0
        ? `รหัส OTP ไม่ถูกต้อง (เหลือโอกาสอีก ${left} ครั้ง)`
        : 'ลองผิดเกินจำนวนครั้งที่กำหนด กรุณาขอรหัสใหม่',
    };
  }

  await db.markOtpUsed(record.id);
  return { ok: true };
}

/**
 * ส่ง SMS OTP:
 *  - โหมดจริง (dev ปิด) → ส่ง SMS ผ่าน provider ที่เลือก (Twilio / ThaiBulkSMS)
 *  - โหมด dev → จำลอง (พิมพ์ที่ console + หน้าเว็บแสดงรหัส)
 * @returns {{ ok: boolean, note: string }}
 */
async function sendOtpSms(phone, code, ttl) {
  const body = `รหัสยืนยันของคุณคือ ${code} (มีอายุ ${ttl} นาที) — ระบบสมาชิก`;
  const dev = devMode();

  if (!dev) {
    // โหมดจริง: ส่งผ่าน provider ที่เลือกไว้ (ตรวจ config ของ provider นั้นโดยตรงใน sms.js)
    const result = await sms.sendSms({ to: phone, body });
    if (result.ok) {
      console.log(`📱 [SMS จริง — ${result.provider}] ส่งไป ${phone} (id=${result.sid})`);
      const rem = result.remaining != null ? ` เครดิตคงเหลือ ${result.remaining}` : '';
      return { ok: true, note: `ส่ง SMS สำเร็จ (${result.provider})${rem}` };
    }
    console.log(`📱 [SMS จริง — ส่งไม่สำเร็จ] ไป ${phone}: ${result.error}`);
    console.log('   ⚠️ ตรวจการตั้งค่า SMS ที่หน้าแอดมิน (ผู้ให้บริการ/API Key/เครดิต)');
    return { ok: false, note: `ส่ง SMS ไม่สำเร็จ: ${String(result.error).slice(0, 200)}` };
  }

  console.log('📱 [SMS — โหมดจำลอง] ส่ง OTP ไปที่ ' + phone);
  console.log('   รหัสยืนยันของคุณ: ' + code);
  console.log('   (หมดอายุใน ' + ttl + ' นาที — ยังไม่ได้ส่ง SMS จริง)');
  return { ok: true, note: 'โหมดทดสอบ (dev) — ไม่ได้ส่ง SMS จริง' };
}

module.exports = {
  issueOtp,
  verifyOtp,
  getOtpTtlMinutes,
  getOtpMaxAttempts,
};
