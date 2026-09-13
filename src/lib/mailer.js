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
async function sendEmail({ to, subject, htmlBody, text }) {
  const cfg = getSmtpConfig();
  // ใส่ชื่อผู้ส่งให้อ่านออก (เช่น QPage <noreply@...>) — ช่วยให้ผู้รับเห็นว่าเป็นแบรนด์ ไม่ใช่ที่อยู่เปล่า ๆ
  const fromHeader = cfg.from && !cfg.from.includes('<') ? 'QPage <' + cfg.from + '>' : cfg.from;

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
        from: fromHeader,
        to,
        subject,
        text: text || undefined,   // ฉบับข้อความล้วน (multipart/alternative) ช่วยเรื่องการกรองสแปม
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
  // หัวข้ออังกฤษล้วน ASCII — Gmail กรองหัวข้อภาษาไทยจากผู้ส่งรายนี้
  const subject = 'Confirm your email address - QPage';
  // ฉบับข้อความล้วน: ช่วยให้ผู้ให้บริการเมลเห็นว่าเนื้อหาตรงกับฉบับ HTML (ลดคะแนนสแปม)
  const textBody = [
    'Hello,',
    '',
    'Thanks for signing up for QPage.',
    'Please confirm your email address by opening this link (valid for 24 hours):',
    link,
    '',
    "If you didn't create this account, you can safely ignore this email.",
  ].join('\n');
  const htmlBody = `
  <div style="font-family:'Noto Sans Thai',Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:10px;color:#101828;line-height:1.7;font-size:15px;">
    <h2 style="font-size:18px;font-weight:800;margin:0 0 14px;">Confirm your email address</h2>
    <p style="margin:0 0 10px;">Hello,</p>
    <p style="margin:0 0 10px;">Thanks for signing up for QPage. Please confirm your email address to activate your account.</p>
    <p style="margin:24px 0;text-align:center;">
      <a href="${link}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 30px;border-radius:10px;">Confirm email</a>
    </p>
    <p style="margin:0 0 6px;font-size:13px;color:#667085;">This link is valid for 24 hours.</p>
    <p style="margin:0 0 6px;font-size:13px;color:#667085;">If the button does not work, copy and paste this link into your browser:</p>
    <p style="margin:0 0 18px;font-size:13px;word-break:break-all;"><a href="${link}" style="color:#6366f1;">${link}</a></p>
    <hr style="border:none;border-top:1px solid #e4e7ec;margin:18px 0;">
    <p style="margin:0;font-size:12.5px;color:#98a2b3;">If you didn't create this account, you can safely ignore this email.</p>
  </div>`;
  // ส่งแบบไม่บล็อก — บันทึกผลลัพธ์ที่ console เสมอ (ทั้งสำเร็จ/จำลอง/ล้มเหลว)
  sendEmail({ to: email, subject, htmlBody, text: textBody }).then((r) => {
    if (!r || !r.ok) console.error('❌ ส่งอีเมลยืนยันไม่สำเร็จ:', r && r.error ? r.error : 'ไม่ทราบสาเหตุ');
    else if (r.simulated) console.log('📧 [ยืนยันอีเมล — โหมดจำลอง] ถึง ' + email);
    else console.log('📧 ส่งอีเมลยืนยันแล้ว → ' + email + ' (id=' + r.messageId + ')');
  }).catch((err) => console.error('❌ ส่งอีเมลยืนยันผิดพลาด:', err.message));
  return { link, token };
}

/**
 * ส่งรหัส OTP ทางอีเมล
 *  - purpose 'email_verify'  → ใช้ยืนยันอีเมลตอนสมัครสมาชิก
 *  - purpose อื่น ๆ          → ใช้กู้รหัสผ่าน
 * ส่งจริงทันทีเมื่อตั้งค่า SMTP ครบ — ไม่ขึ้นกับโหมด dev
 * @returns {Promise<{ok:boolean, simulated?:boolean, error?:string}>}
 */
function sendOtpEmail({ email, code, purpose = 'password_reset' }) {
  const isVerify = purpose === 'email_verify';
  // หัวข้ออังกฤษ ASCII + เนื้อหาธรรมดาไม่มีสี/ตัวใหญ่ — Gmail กรองเมลหัวข้อไทยและเมลตกแต่งจากผู้ส่งรายใหม่
  const subject = isVerify ? 'Your QPage email verification code' : 'Verification code (OTP) - Member System';
  const htmlBody = isVerify
    ? `
    <p>สวัสดีครับ/ค่ะ,</p>
    <p>รหัสยืนยันอีเมลสำหรับบัญชี QPage ของคุณคือ</p>
    <p style="font-size:22px;font-weight:bold;letter-spacing:4px;">${code}</p>
    <p>กรอกรหัสนี้ในหน้าสมัครสมาชิกเพื่อยืนยันอีเมล (รหัสมีอายุ 5 นาที)</p>
    <p>หากคุณไม่ได้เป็นผู้สมัคร กรุณาเพิกเฉยอีเมลนี้</p>
  `
    : `
    <p>สวัสดีครับ/ค่ะ,</p>
    <p>คุณได้ขอรหัสยืนยันเพื่อกู้รหัสผ่านบัญชีของคุณ</p>
    <p>รหัสยืนยันของคุณคือ: ${code}</p>
    <p>รหัสนี้มีอายุ 5 นาที หากคุณไม่ได้เป็นผู้ขอ กรุณาเพิกเฉยอีเมลนี้</p>
  `;
  // ฉบับข้อความล้วน (multipart/alternative) — ช่วยให้ผู้ให้บริการเมลไม่ตีเป็นสแปม
  const textBody = isVerify
    ? ['สวัสดีครับ/ค่ะ,', '', 'รหัสยืนยันอีเมลสำหรับบัญชี QPage ของคุณคือ: ' + code, '',
      'กรอกรหัสนี้ในหน้าสมัครสมาชิกเพื่อยืนยันอีเมล (รหัสมีอายุ 5 นาที)', '',
      'หากคุณไม่ได้เป็นผู้สมัคร กรุณาเพิกเฉยอีเมลนี้'].join('\n')
    : ['สวัสดีครับ/ค่ะ,', '', 'คุณได้ขอรหัสยืนยันเพื่อกู้รหัสผ่านบัญชีของคุณ',
      'รหัสยืนยันของคุณคือ: ' + code, '', 'รหัสนี้มีอายุ 5 นาที หากคุณไม่ได้เป็นผู้ขอ กรุณาเพิกเฉยอีเมลนี้'].join('\n');
  const label = isVerify ? 'รหัสยืนยันอีเมล' : 'OTP ทางอีเมล';
  return sendEmail({ to: email, subject, htmlBody, text: textBody }).then((r) => {
    if (!r || !r.ok) console.error(`❌ ส่ง${label}ไม่สำเร็จ:`, r && r.error ? r.error : 'ไม่ทราบสาเหตุ');
    else if (r.simulated) console.log(`📧 [${label} — โหมดจำลอง] ถึง ` + email);
    else console.log(`📧 ส่ง${label}แล้ว → ` + email + ' (id=' + r.messageId + ')');
    return r || { ok: false, error: 'ไม่ทราบสาเหตุ' };
  }).catch((err) => {
    console.error(`❌ ส่ง${label}ผิดพลาด:`, err.message);
    return { ok: false, error: err.message };
  });
}

/**
 * สร้างเนื้อหาอีเมล "ซื้อแพ็กเกจสำเร็จ" (ฟังก์ชันบริสุทธิ์ — ทดสอบได้โดยไม่ต้องส่งจริง)
 * details = รายละเอียดแพ็กเกจที่แอดมินตั้งไว้ [{ heading, text }]
 */
function buildPackagePurchasedEmail({ packageName, durationMonths, amount, startAt, expiresAt, ref, details = [], extended = false, baseUrl = '' }) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  // วันที่ในสิทธิ์เป็น UTC — แสดงเป็นเวลาไทย (UTC+7) ให้ตรงกับที่ลูกค้าเห็นในหน้าเว็บ
  const thaiDate = (v) => {
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return g('day') + '/' + g('month') + '/' + g('year');
  };

  const rows = [
    ['แพ็กเกจ', esc(packageName)],
    ['ระยะเวลา', esc(durationMonths) + ' เดือน'],
    ['ยอดชำระ', '฿' + money],
    ['ใช้ได้ถึง', thaiDate(expiresAt) + (extended ? ' (ต่อจากวันหมดอายุเดิม)' : '')],
  ];
  if (ref) rows.push(['รหัสอ้างอิง', esc(ref)]);
  if (startAt) rows.push(['เริ่มใช้ได้', thaiDate(startAt)]);

  const features = (Array.isArray(details) ? details : []).filter((d) => d && (d.heading || d.text));
  const featureHtml = features.length
    ? `<h3 style="font-size:15px;font-weight:800;margin:22px 0 8px;">รายละเอียดแพ็กเกจ</h3>
    <ul style="margin:0;padding-left:20px;">${features.map((d) => `<li style="margin-bottom:6px;">`
      + (d.heading ? '<strong>' + esc(d.heading) + '</strong>' : '')
      + (d.text ? (d.heading ? ' — ' : '') + esc(d.text) : '') + '</li>').join('')}</ul>`
    : '';
  const featureText = features.map((d) => '- ' + [d.heading, d.text].filter(Boolean).join(' — ')).join('\n');
  const cta = baseUrl
    ? `<p style="margin:24px 0;text-align:center;"><a href="${baseUrl}/shop/menu.html" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 30px;border-radius:10px;">ไปที่ร้านค้าของฉัน</a></p>`
    : '';

  const htmlBody = `
  <div style="font-family:'Noto Sans Thai',Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:10px;color:#101828;line-height:1.7;font-size:15px;">
    <h2 style="font-size:18px;font-weight:800;margin:0 0 14px;">ชำระเงินสำเร็จ — เปิดร้านของคุณเรียบร้อยแล้ว</h2>
    <p style="margin:0 0 10px;">สวัสดีครับ/ค่ะ,</p>
    <p style="margin:0 0 10px;">ระบบได้รับชำระเงินสำหรับแพ็กเกจร้านค้าของคุณเรียบร้อยแล้ว และเปิดสิทธิ์เจ้าของร้านให้ทันที</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14.5px;">
      ${rows.map(([k, v]) => `<tr><td style="padding:7px 0;color:#667085;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:7px 0;font-weight:700;">${v}</td></tr>`).join('')}
    </table>
    ${featureHtml}
    ${cta}
    <p style="margin:0 0 6px;font-size:13px;color:#667085;">คุณสามารถดูรายการซื้อและช่วงสิทธิ์ทั้งหมดได้ที่หน้าบัญชีของฉัน → ประวัติการชำระเงิน</p>
    <hr style="border:none;border-top:1px solid #e4e7ec;margin:18px 0;">
    <p style="margin:0;font-size:12.5px;color:#98a2b3;">อีเมลฉบับนี้ส่งอัตโนมัติจากระบบ QPage หากคุณไม่ได้เป็นผู้ซื้อ กรุณาเพิกเฉยอีเมลนี้</p>
  </div>`;

  const textBody = [
    'ชำระเงินสำเร็จ — เปิดร้านของคุณเรียบร้อยแล้ว',
    '',
    ...rows.map(([k, v]) => k + ': ' + String(v).replace(/<[^>]+>/g, '')),
    '',
    ...(featureText ? ['รายละเอียดแพ็กเกจ', featureText, ''] : []),
    ...(baseUrl ? ['ไปที่ร้านค้าของฉัน: ' + baseUrl + '/shop/menu.html', ''] : []),
    'ดูรายการซื้อทั้งหมดได้ที่หน้าบัญชีของฉัน → ประวัติการชำระเงิน',
  ].join('\n');

  return { subject: 'QPage - Your package purchase is confirmed', htmlBody, textBody };
}

/**
 * แจ้งลูกค้าว่าซื้อแพ็กเกจสำเร็จ พร้อมรายละเอียดแพ็กเกจที่แอดมินตั้งไว้
 * ส่งจริงทันทีเมื่อตั้งค่า SMTP ครบ — ไม่ขึ้นกับโหมด dev (เหมือนอีเมลอื่น)
 */
function sendPackagePurchasedEmail(data) {
  const { subject, htmlBody, textBody } = buildPackagePurchasedEmail(data);
  sendEmail({ to: data.email, subject, htmlBody, text: textBody }).then((r) => {
    if (!r || !r.ok) console.error('❌ ส่งอีเมลยืนยันการซื้อไม่สำเร็จ:', r && r.error ? r.error : 'ไม่ทราบสาเหตุ');
    else if (r.simulated) console.log('📧 [ยืนยันการซื้อ — โหมดจำลอง] ถึง ' + data.email);
    else console.log('📧 ส่งอีเมลยืนยันการซื้อแล้ว → ' + data.email + ' (id=' + r.messageId + ')');
  }).catch((err) => console.error('❌ ส่งอีเมลยืนยันการซื้อผิดพลาด:', err.message));
}

module.exports = { sendVerificationEmail, sendOtpEmail, sendPackagePurchasedEmail, buildPackagePurchasedEmail, sendEmail, getSmtpConfig, _resetTransporter };
