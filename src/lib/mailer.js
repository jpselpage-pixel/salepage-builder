/**
 * mailer.js — ส่งอีเมลจริงผ่าน SMTP (nodemailer)
 *
 * ค่า config อ่านจากตาราง settings ก่อน (แอดมินกรอกได้ที่ /admin/otp.html)
 * แล้วค่อยใช้ค่า .env เป็นค่าเริ่มต้น
 *
 * การทำงาน:
 *  - ตั้งค่า SMTP ครบ → ส่งอีเมลจริงผ่าน nodemailer ทันที (ไม่ขึ้นกับโหมด dev)
 *  - ยังไม่ตั้งค่า SMTP → จำลอง (พิมพ์ที่ console)
 *
 * หมายเหตุ: "โหมด dev" มีผลกับช่องทาง SMS เท่านั้น — ช่องทางอีเมลแยกอิสระ
 *
 * หมายเหตุ: บน Railway (cloud) port SMTP 587/465 ถูก block — ต้องรันในเครื่อง/VPS
 * หรือใช้บริการส่งเมลผ่าน HTTPS API (Brevo ฯลฯ) แทนถ้าต้องการส่งจริงบน Railway
 */
'use strict';

const db = require('../db');

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
 * ส่งอีเมลจริงเมื่อตั้งค่า SMTP ครบ — ไม่เช่นนั้นจำลองที่ console
 * @returns {{ ok: boolean, simulated?: boolean, messageId?: string, error?: string }}
 */
async function sendEmail({ to, subject, htmlBody }) {
  const cfg = getSmtpConfig();

  if (cfg.configured) {
    try {
      if (!transporter) {
        const nodemailer = require('nodemailer');
        const dns = require('node:dns');
        // บังคับ resolve เป็น IPv4 ก่อน (กัน IPv6 issues บนบาง platform)
        const ipv4 = await new Promise((resolve) => {
          dns.resolve4(cfg.host, (err, addrs) => resolve(err || !addrs || !addrs.length ? null : addrs[0]));
        });
        transporter = nodemailer.createTransport({
          host: ipv4 || cfg.host,
          port: cfg.port,
          secure: cfg.port === 465, // 465 = SSL, 587 = STARTTLS
          auth: { user: cfg.user, pass: cfg.pass },
          tls: { rejectUnauthorized: false, servername: cfg.host }, // SNI ให้ cert ตรงกับ hostname จริง
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 15000,
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

  // ยังไม่ได้ตั้งค่า SMTP → จำลอง (บันทึกที่ console)
  console.log('📧 [อีเมล — โหมดจำลอง: ยังไม่ได้ตั้งค่า SMTP]');
  console.log('   ถึง: ' + to);
  console.log('   หัวข้อ: ' + subject);
  console.log('   เนื้อหา:');
  console.log('   ' + htmlBody.replace(/<[^>]+>/g, '').replace(/\n+/g, '\n   ').trim());
  console.log('   ⚠️ เตือน: ยังไม่ได้ตั้งค่า SMTP → กรุณากรอกค่าที่หน้าแอดมิน');
  return { ok: true, simulated: true };
}

/**
 * สร้างลิงก์ยืนยันอีเมลและ 'ส่ง' ให้ผู้ใช้
 * @returns {{ link: string, token: string }}  คืนลิงก์ (dev) + token (เก็บจริง)
 */
function sendVerificationEmail({ email, token, baseUrl }) {
  const link = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  // หัวข้อเป็นอังกฤษ ASCII ล้วน (ห้ามอักขระพิเศษ/ไทย) — Gmail กรองเมลหัวข้อภาษาไทยจาก sender นี้ (เทสต์แล้วฉบับ EN ถึง)
  const subject = 'Verify your email - Member System';
  // เนื้อหาธรรมดา ไม่มีปุ่ม/สีเยอะ — Gmail กรองเมลแบบมีปุ่มตกแต่ง (เทสต์แล้วฉบับธรรมดาส่งถึง)
  const htmlBody = `
    <p>สวัสดีครับ/ค่ะ</p>
    <p>ขอบคุณที่สมัครสมาชิกกับระบบสมาชิก</p>
    <p>กรุณายืนยันอีเมลของคุณโดยเปิดลิงก์ด้านล่าง (ใช้ได้ 24 ชั่วโมง):</p>
    <p><a href="${link}">${link}</a></p>
    <p>หากคุณไม่ได้สมัครสมาชิก กรุณาเพิกเฉยอีเมลนี้</p>
  `;
  // ส่งแบบไม่บล็อก — บันทึกผลลัพธ์ที่ console เสมอ (ทั้งสำเร็จ/จำลอง/ล้มเหลว)
  sendEmail({ to: email, subject, htmlBody }).then((r) => {
    if (!r || !r.ok) console.error('❌ ส่งอีเมลยืนยันไม่สำเร็จ:', r && r.error ? r.error : 'ไม่ทราบสาเหตุ');
    else if (r.simulated) console.log('📧 [ยืนยันอีเมล — โหมดจำลอง] ถึง ' + email);
    else console.log('📧 ส่งอีเมลยืนยันแล้ว → ' + email + ' (id=' + r.messageId + ')');
  }).catch((err) => console.error('❌ ส่งอีเมลยืนยันผิดพลาด:', err.message));
  return { link, token };
}

/**
 * ส่งรหัส OTP ทางอีเมล (ใช้กับฟังก์ชันกู้รหัสผ่าน)
 * ส่งจริงทันทีเมื่อตั้งค่า SMTP ครบ — ไม่ขึ้นกับโหมด dev
 */
function sendOtpEmail({ email, code }) {
  // หัวข้ออังกฤษ ASCII + เนื้อหาธรรมดาไม่มีสี/ตัวใหญ่ — Gmail กรองเมลหัวข้อไทยและเมลตกแต่งจากผู้ส่งรายใหม่
  const subject = 'Verification code (OTP) - Member System';
  const htmlBody = `
    <p>สวัสดีครับ/ค่ะ,</p>
    <p>คุณได้ขอรหัสยืนยันเพื่อกู้รหัสผ่านบัญชีของคุณ</p>
    <p>รหัสยืนยันของคุณคือ: ${code}</p>
    <p>รหัสนี้มีอายุ 5 นาที หากคุณไม่ได้เป็นผู้ขอ กรุณาเพิกเฉยอีเมลนี้</p>
  `;
  sendEmail({ to: email, subject, htmlBody }).then((r) => {
    if (!r || !r.ok) console.error('❌ ส่ง OTP ทางอีเมลไม่สำเร็จ:', r && r.error ? r.error : 'ไม่ทราบสาเหตุ');
    else if (r.simulated) console.log('📧 [OTP อีเมล — โหมดจำลอง] ถึง ' + email);
    else console.log('📧 ส่ง OTP อีเมลแล้ว → ' + email + ' (id=' + r.messageId + ')');
  }).catch((err) => console.error('❌ ส่ง OTP ทางอีเมลผิดพลาด:', err.message));
}

module.exports = { sendVerificationEmail, sendOtpEmail, sendEmail, getSmtpConfig, _resetTransporter };
