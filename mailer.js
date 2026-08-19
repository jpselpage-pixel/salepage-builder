/**
 * mailer.js — ส่งอีเมลจริงผ่าน Gmail API (HTTPS 443) หรือ SMTP (nodemailer)
 *
 * การทำงาน (เลือกช่องทางอัตโนมัติ):
 *  1. ตั้งค่า Gmail API ครบ (clientId/clientSecret/refreshToken) → ใช้ Gmail API (HTTPS 443 — ใช้ได้ทุกที่ รวม Railway)
 *  2. ไม่มี Gmail API แต่มี SMTP → ใช้ SMTP (ใช้ได้บนเครื่อง แต่ Railway block port 587/465)
 *  3. โหมด dev หรือยังไม่ได้ตั้งค่าอะไร → จำลอง (console + ลิงก์ dev)
 *
 * วิธีสร้าง Gmail API credentials: ดู scripts/gmail-oauth.js
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

function getGmailApiConfig() {
  const clientId = db.getSetting('gmail_client_id') || process.env.GMAIL_CLIENT_ID || '';
  const clientSecret = db.getSetting('gmail_client_secret') || process.env.GMAIL_CLIENT_SECRET || '';
  const refreshToken = db.getSetting('gmail_refresh_token') || process.env.GMAIL_REFRESH_TOKEN || '';
  const user = db.getSetting('gmail_user') || process.env.GMAIL_USER || '';
  return {
    clientId,
    clientSecret,
    refreshToken,
    user,
    configured: Boolean(clientId && clientSecret && refreshToken && user),
  };
}

// ช่องทางส่งอีเมล: 'auto' (Gmail API ก่อน → SMTP), 'gmail' (บังคับ Gmail API), 'smtp' (บังคับ SMTP)
function getEmailChannel() {
  const c = db.getSetting('email_channel');
  return c === 'gmail' || c === 'smtp' ? c : 'auto';
}

let transporter = null;
function _resetTransporter() { transporter = null; }

// ---------------------------------------------------------------------------
// Gmail API (OAuth2 + HTTPS 443) — ใช้ได้บน Railway
// ---------------------------------------------------------------------------
async function getGmailAccessToken(cfg) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Gmail token error');
  }
  return data.access_token;
}

async function sendViaGmailApi({ to, subject, htmlBody, cfg }) {
  const accessToken = await getGmailAccessToken(cfg);
  // สร้าง RFC822 email (MIME base64url)
  const from = cfg.user;
  const email = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody,
  ].join('\r\n');
  const raw = Buffer.from(email, 'utf8').toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || data.error || 'Gmail API send error');
  }
  return { ok: true, messageId: data.id };
}

/**
 * ส่งอีเมลจริง (Gmail API → SMTP → จำลอง ตามลำดับ) — ไม่เช่นนั้นจำลองที่ console
 * @returns {{ ok: boolean, simulated?: boolean, messageId?: string, error?: string, channel?: string }}
 */
async function sendEmail({ to, subject, htmlBody }) {
  const gmailCfg = getGmailApiConfig();
  const smtpCfg = getSmtpConfig();
  const dev = devModeEnabled();
  const channel = getEmailChannel(); // auto | gmail | smtp

  // dev เปิด → จำลองเสมอ
  if (dev) {
    return simulateEmail({ to, subject, htmlBody, warn: !gmailCfg.configured && !smtpCfg.configured });
  }

  // ลำดับช่องทางตาม email_channel
  const wantGmail = channel === 'gmail' || (channel === 'auto' && gmailCfg.configured);
  const wantSmtp = channel === 'smtp' || (channel === 'auto' && smtpCfg.configured);

  // 1) Gmail API (ถ้าต้องการ + ตั้งค่าแล้ว)
  if (wantGmail && gmailCfg.configured) {
    try {
      const r = await sendViaGmailApi({ to, subject, htmlBody, cfg: gmailCfg });
      return { ...r, channel: 'gmail-api' };
    } catch (err) {
      console.error('❌ Gmail API ส่งไม่สำเร็จ:', err.message);
      if (channel === 'gmail') {
        return { ok: false, channel: 'gmail-api', error: err.message || 'ส่งอีเมลไม่สำเร็จ' };
      }
      // auto → ลอง SMTP ต่อ
    }
  }

  // 2) SMTP (ถ้าต้องการ + ตั้งค่าแล้ว)
  if (wantSmtp && smtpCfg.configured) {
    try {
      if (!transporter) {
        const nodemailer = require('nodemailer');
        const dns = require('node:dns');
        const ipv4 = await new Promise((resolve) => {
          dns.resolve4(smtpCfg.host, (err, addrs) => resolve(err || !addrs || !addrs.length ? null : addrs[0]));
        });
        transporter = nodemailer.createTransport({
          host: ipv4 || smtpCfg.host,
          port: smtpCfg.port,
          secure: smtpCfg.port === 465,
          auth: { user: smtpCfg.user, pass: smtpCfg.pass },
          tls: { rejectUnauthorized: false, servername: smtpCfg.host },
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 15000,
        });
      }
      const info = await transporter.sendMail({
        from: smtpCfg.from,
        to,
        subject,
        html: htmlBody,
      });
      return { ok: true, messageId: info.messageId, channel: 'smtp' };
    } catch (err) {
      return { ok: false, channel: 'smtp', error: err.message || 'ส่งอีเมลไม่สำเร็จ' };
    }
  }

  // 3) ไม่มีช่องทางที่พร้อม → จำลอง
  return simulateEmail({ to, subject, htmlBody, warn: true });
}

function simulateEmail({ to, subject, htmlBody, warn }) {
  console.log('📧 [อีเมล — โหมดจำลอง]');
  console.log('   ถึง: ' + to);
  console.log('   หัวข้อ: ' + subject);
  console.log('   เนื้อหา:');
  console.log('   ' + htmlBody.replace(/<[^>]+>/g, '').replace(/\n+/g, '\n   ').trim());
  if (warn) {
    console.log('   ⚠️ เตือน: ยังไม่ได้ตั้งค่าช่องทางส่งอีเมลที่เลือก (Gmail API / SMTP) → กรุณากรอกค่าที่หน้าแอดมิน');
  }
  return { ok: true, simulated: true };
}

/**
 * สร้างลิงก์ยืนยันอีเมลและ 'ส่ง' ให้ผู้ใช้
 * @returns {{ link: string, token: string }}  คืนลิงก์ (dev) + token (เก็บจริง)
 */
function sendVerificationEmail({ email, token, baseUrl }) {
  const link = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const subject = 'ยืนยันอีเมล — SalePage';
  const htmlBody = `
    <p>สวัสดีครับ/ค่ะ,</p>
    <p>ขอบคุณที่สมัครสมาชิกกับ SalePage ของเรา</p>
    <p>กรุณาคลิกปุ่มด้านล่างเพื่อยืนยันอีเมลของคุณ (ลิงก์มีอายุ 24 ชั่วโมง):</p>
    <p><a href="${link}" style="background:#667eea;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">ยืนยันอีเมล</a></p>
    <p>หรือคัดลอกลิงก์: ${link}</p>
    <p>หากคุณไม่ได้สมัครสมาชิก กรุณาเพิกเฉยอีเมลนี้</p>
  `;
  sendEmail({ to: email, subject, htmlBody }).catch((err) => console.error('❌ ส่งอีเมลยืนยันผิดพลาด:', err.message));
  return { link, token };
}

/**
 * ส่งรหัส OTP ทางอีเมล (ใช้กับฟังก์ชันกู้รหัสผ่าน)
 * โหมด dev: แสดงรหัสที่ console + server.js แนบ devOtp กลับให้ทดสอบ
 */
function sendOtpEmail({ email, code }) {
  const subject = 'รหัสยืนยัน (OTP) — SalePage';
  const htmlBody = `
    <p>สวัสดีครับ/ค่ะ,</p>
    <p>คุณได้ขอรหัสยืนยันเพื่อกู้รหัสผ่านบัญชีของคุณ</p>
    <p>รหัสยืนยันของคุณคือ:</p>
    <p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#4f46e5;">${code}</p>
    <p>รหัสนี้มีอายุ 5 นาที หากคุณไม่ได้เป็นผู้ขอ กรุณาเพิกเฉยอีเมลนี้</p>
  `;
  sendEmail({ to: email, subject, htmlBody }).catch((err) => console.error('❌ ส่ง OTP ทางอีเมลผิดพลาด:', err.message));
}

module.exports = {
  sendVerificationEmail,
  sendOtpEmail,
  sendEmail,
  getSmtpConfig,
  getGmailApiConfig,
  getEmailChannel,
  devModeEnabled,
  _resetTransporter,
  DEV_MODE,
};
