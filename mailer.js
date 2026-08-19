/**
 * mailer.js — ส่งอีเมลจริงผ่าน SMTP (nodemailer)
 *
 * ค่า config อ่านจากตาราง settings ก่อน (แอดมินกรอกได้ที่ /admin/otp.html)
 * แล้วค่อยใช้ค่า .env เป็นค่าเริ่มต้น
 *
 * การทำงาน:
 *  - ตั้งค่า SMTP ครบ + ปิดโหมด dev → ส่งอีเมลจริงผ่าน nodemailer
 *  - โหมด dev หรือยังไม่ตั้งค่า SMTP → จำลอง (พิมพ์ที่ console + แสดงลิงก์ dev)
 */
'use strict';

const db = require('./db');

const DEV_MODE = String(process.env.DEV_MODE || 'true') === 'true';

// อ่านโหมด dev แบบ dynamic (แอดมินสลับได้ผ่านตาราง settings)
function devModeEnabled() {
  const s = db.getSetting('dev_mode');
  return s !== null ? s === 'true' : DEV_MODE;
}

function getSmtpConfig() {
  const host = db.getSetting('smtp_host') || process.env.SMTP_HOST || '';
  const port = Number(db.getSetting('smtp_port') || process.env.SMTP_PORT || 587);
  const user = db.getSetting('smtp_user') || process.env.SMTP_USER || '';
  const pass = db.getSetting('smtp_pass') || process.env.SMTP_PASS || '';
  const from = db.getSetting('smtp_from') || process.env.SMTP_FROM || user;
  return {
    host,
    port,
    user,
    pass,
    from,
    configured: Boolean(host && user && pass),
  };
}

let transporter = null;
function _resetTransporter() { transporter = null; }

/**
 * ส่งอีเมลจริง (ถ้าตั้งค่า SMTP ครบ + ปิด dev) — ไม่เช่นนั้นจำลองที่ console
 * @returns {{ ok: boolean, simulated?: boolean, messageId?: string, error?: string }}
 */
async function sendEmail({ to, subject, htmlBody }) {
  const cfg = getSmtpConfig();
  const dev = devModeEnabled();

  if (cfg.configured && !dev) {
    try {
      if (!transporter) {
        const nodemailer = require('nodemailer');
        transporter = nodemailer.createTransport({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.port === 465, // 465 = SSL, 587 = STARTTLS
          auth: { user: cfg.user, pass: cfg.pass },
          // Railway ยังไม่มี IPv6 outbound — บังคับ IPv4 กัน ENETUNREACH
          family: 4,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 15000,
          tls: { rejectUnauthorized: false },
        });
      }
      const info = await transporter.sendMail({
        from: cfg.from,
        to,
        subject,
        html: htmlBody,
      });
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      return { ok: false, error: err.message || 'ส่งอีเมลไม่สำเร็จ' };
    }
  }

  // โหมดจำลอง (dev เปิด หรือยังไม่ตั้งค่า SMTP)
  console.log('📧 [อีเมล — โหมดจำลอง]');
  console.log('   ถึง: ' + to);
  console.log('   หัวข้อ: ' + subject);
  console.log('   เนื้อหา:');
  console.log('   ' + htmlBody.replace(/<[^>]+>/g, '').replace(/\n+/g, '\n   ').trim());
  if (!cfg.configured && !dev) {
    console.log('   ⚠️ เตือน: ปิดโหมด dev แล้วแต่ยังไม่ตั้งค่า SMTP → กรุณากรอกค่าที่หน้าแอดมิน');
  }
  return { ok: true, simulated: true };
}

/**
 * สร้างลิงก์ยืนยันอีเมลและ 'ส่ง' ให้ผู้ใช้
 * @returns {{ link: string, token: string }}  คืนลิงก์ (dev) + token (เก็บจริง)
 */
function sendVerificationEmail({ email, token, baseUrl }) {
  const link = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const subject = 'ยืนยันอีเมล — ร้านค้าออนไลน์';
  const htmlBody = `
    <p>สวัสดีครับ/ค่ะ,</p>
    <p>ขอบคุณที่สมัครสมาชิกกับร้านค้าออนไลน์ของเรา</p>
    <p>กรุณาคลิกปุ่มด้านล่างเพื่อยืนยันอีเมลของคุณ (ลิงก์มีอายุ 24 ชั่วโมง):</p>
    <p><a href="${link}" style="background:#667eea;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">ยืนยันอีเมล</a></p>
    <p>หรือคัดลอกลิงก์: ${link}</p>
    <p>หากคุณไม่ได้สมัครสมาชิก กรุณาเพิกเฉยอีเมลนี้</p>
  `;
  // ส่งแบบไม่บล็อก — ผลลัพธ์ไปที่ console
  sendEmail({ to: email, subject, htmlBody }).catch((err) => console.error('❌ ส่งอีเมลยืนยันผิดพลาด:', err.message));
  return { link, token };
}

/**
 * ส่งรหัส OTP ทางอีเมล (ใช้กับฟังก์ชันกู้รหัสผ่าน)
 * โหมด dev: แสดงรหัสที่ console + server.js แนบ devOtp กลับให้ทดสอบ
 */
function sendOtpEmail({ email, code }) {
  const subject = 'รหัสยืนยัน (OTP) — ร้านค้าออนไลน์';
  const htmlBody = `
    <p>สวัสดีครับ/ค่ะ,</p>
    <p>คุณได้ขอรหัสยืนยันเพื่อกู้รหัสผ่านบัญชีของคุณ</p>
    <p>รหัสยืนยันของคุณคือ:</p>
    <p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#4f46e5;">${code}</p>
    <p>รหัสนี้มีอายุ 5 นาที หากคุณไม่ได้เป็นผู้ขอ กรุณาเพิกเฉยอีเมลนี้</p>
  `;
  sendEmail({ to: email, subject, htmlBody }).catch((err) => console.error('❌ ส่ง OTP ทางอีเมลผิดพลาด:', err.message));
}

module.exports = { sendVerificationEmail, sendOtpEmail, sendEmail, getSmtpConfig, devModeEnabled, _resetTransporter, DEV_MODE };
