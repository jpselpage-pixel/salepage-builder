/**
 * admin.js — API หลังบ้านแอดมิน (SMTP / ผู้ใช้ / OTP / SMS / ตั้งค่า)
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const otp = require('../lib/otp');
const mailer = require('../lib/mailer');
const sms = require('../lib/sms');
const { isValidEmail, isValidThaiPhone, normalizeThaiPhone, passwordStrengthScore } = require('../lib/validators');
const { devMode } = require('../lib/settings');
const { isValidRole, isAdminRole, isOwner } = require('../lib/roles');
const { requireAdmin, requireOwner } = require('../middleware/auth');
const { getGoogleConfig } = require('../lib/google-oauth');

const router = express.Router();

// ลำดับชั้นบทบาท ใช้เทียบว่ากำลัง "ลดระดับ" ตัวเองหรือไม่
const ROLE_RANK = { user: 0, shop: 1, admin: 2, owner: 3 };

// ---------------------------------------------------------------------------
// Admin — ตั้งค่า SMTP (อีเมลจริง: ยืนยันอีเมล / OTP ทางอีเมล)
// ---------------------------------------------------------------------------

// สถานะ SMTP
router.get('/api/admin/smtp-status', requireAdmin, (req, res) => {
  const cfg = mailer.getSmtpConfig();
  res.json({
    ok: true,
    status: {
      configured: cfg.configured,
      host: cfg.host || null,
      port: cfg.port,
      userMasked: cfg.user ? cfg.user.slice(0, 3) + '…' : null,
      userFull: cfg.user || '',   // User ไม่ใช่ secret — เอาไว้เติมกลับในช่องกรอก
      from: cfg.from || null,
      fromFull: cfg.from || '',
      hasPass: Boolean(cfg.pass),
      passMasked: cfg.pass ? '••••' + String(cfg.pass).slice(-4) : null,
      source: db.getSetting('smtp_host') ? 'admin' : 'env',
      devMode: devMode(),
    },
  });
});

// บันทึกค่า SMTP
router.post('/api/admin/smtp-settings', requireAdmin, (req, res) => {
  const { host, port, user, pass, from } = req.body || {};
  let changed = 0;

  if (host !== undefined && host !== '') {
    if (!/^[\w.-]+(\.[\w.-]+)+$/.test(String(host).trim())) {
      return res.status(400).json({ ok: false, message: 'SMTP Host ไม่ถูกต้อง (เช่น smtp.gmail.com)' });
    }
    db.setSetting('smtp_host', String(host).trim());
    changed++;
  }
  if (port !== undefined && port !== '') {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return res.status(400).json({ ok: false, message: 'SMTP Port ไม่ถูกต้อง (เช่น 587)' });
    }
    db.setSetting('smtp_port', String(p));
    changed++;
  }
  if (user !== undefined && user !== '') {
    if (/\s/.test(String(user).trim()) || String(user).length < 3) {
      return res.status(400).json({ ok: false, message: 'SMTP User (อีเมล/ชื่อผู้ใช้) ไม่ถูกต้อง' });
    }
    db.setSetting('smtp_user', String(user).trim());
    changed++;
  }
  if (pass !== undefined && pass !== '') {
    db.setSetting('smtp_pass', String(pass));
    changed++;
  }
  if (from !== undefined && from !== '') {
    if (!isValidEmail(String(from).trim())) {
      return res.status(400).json({ ok: false, message: 'From (อีเมลผู้ส่ง) ไม่ถูกต้อง' });
    }
    db.setSetting('smtp_from', String(from).trim());
    changed++;
  }

  mailer._resetTransporter();
  console.log(`👑 [แอดมิน] บันทึกการตั้งค่า SMTP (${changed} รายการ)`);
  res.json({
    ok: true,
    message: changed > 0 ? `บันทึกการตั้งค่า SMTP แล้ว (${changed} รายการ)` : 'ไม่มีรายการที่เปลี่ยนแปลง',
  });
});

// ทดสอบส่งอีเมล (ต้องตั้งค่า SMTP ครบ + ปิด dev ถึงจะส่งจริง)
router.post('/api/admin/smtp-test', requireAdmin, async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!isValidEmail(to)) {
    return res.status(400).json({ ok: false, message: 'กรุณากรอกอีเมลปลายทางสำหรับทดสอบ' });
  }
  const result = await mailer.sendEmail({
    to,
    // หัวข้ออังกฤษ ASCII — Gmail กรองเมลหัวข้อไทยจากผู้ส่งรายใหม่ (ทดสอบแล้วฉบับ EN ถึง)
    subject: 'SMTP test - Member System',
    htmlBody: '<p>ทดสอบการตั้งค่า SMTP สำเร็จ ถ้าคุณได้รับอีเมลนี้ แสดงว่าระบบพร้อมใช้งานจริงแล้ว</p>',
  });
  if (!result.ok) {
    return res.status(400).json({ ok: false, message: result.error || 'ส่งอีเมลทดสอบไม่สำเร็จ' });
  }
  console.log(`👑 [แอดมิน] ทดสอบส่งอีเมล ${result.simulated ? '(จำลอง)' : '(จริง)'} → ${to}`);
  res.json({
    ok: true,
    message: result.simulated
      ? 'ส่งอีเมลทดสอบแล้ว (โหมดจำลอง — ดูที่ console เซิร์ฟเวอร์)'
      : 'ส่งอีเมลทดสอบสำเร็จแล้ว (ตรวจที่อินบ็อกซ์ของคุณ)',
    simulated: Boolean(result.simulated),
  });
});

// ---------------------------------------------------------------------------
// Admin — ตั้งค่าล็อกอินด้วย Google (OAuth)
// ---------------------------------------------------------------------------

// สถานะการตั้งค่า Google Login
router.get('/api/admin/google-settings', requireAdmin, (req, res) => {
  const cfg = getGoogleConfig();
  res.json({
    ok: true,
    status: {
      configured: cfg.configured,
      clientId: cfg.clientId,
      hasSecret: Boolean(cfg.clientSecret),
      secretMasked: cfg.clientSecret ? '••••' + cfg.clientSecret.slice(-4) : null,
      redirectUri: cfg.redirectUri,
      source: cfg.source,
    },
  });
});

// บันทึกค่า Google Login (Client ID / Client Secret / Redirect URI)
router.post('/api/admin/google-settings', requireAdmin, async (req, res) => {
  const clientId = String(req.body?.clientId || '').trim();
  const clientSecret = String(req.body?.clientSecret || '').trim();
  const redirectUri = String(req.body?.redirectUri || '').trim();

  if (clientId && !clientId.endsWith('.apps.googleusercontent.com')) {
    return res.status(400).json({ ok: false, field: 'clientId', message: 'Client ID ไม่ถูกต้อง — ต้องลงท้ายด้วย .apps.googleusercontent.com' });
  }
  if (redirectUri && !/^https?:\/\/.+/i.test(redirectUri)) {
    return res.status(400).json({ ok: false, field: 'redirectUri', message: 'Redirect URI ต้องขึ้นต้นด้วย http:// หรือ https://' });
  }

  let changed = 0;
  if (clientId) { await db.setSetting('google_client_id', clientId); changed++; }
  if (clientSecret) { await db.setSetting('google_client_secret', clientSecret); changed++; } // เว้นว่าง = ใช้ค่าเดิม
  if (redirectUri) { await db.setSetting('google_redirect_uri', redirectUri); changed++; }

  const cfg = getGoogleConfig();
  console.log(`🔑 [แอดมิน] บันทึกการตั้งค่า Google Login (${changed} รายการ) — เปิดใช้=${cfg.configured}`);
  res.json({
    ok: true,
    configured: cfg.configured,
    message: changed === 0
      ? 'ไม่มีรายการที่เปลี่ยนแปลง'
      : cfg.configured
        ? 'บันทึกแล้ว — เปิดใช้ล็อกอินด้วย Google และปุ่มจะแสดงที่หน้า login ทันที'
        : 'บันทึกแล้ว แต่ยังไม่ครบทั้ง Client ID และ Client Secret',
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Admin — จัดการผู้ใช้งาน (ดู/แก้ไข/ลบ)
// ---------------------------------------------------------------------------

// รายการผู้ใช้ทั้งหมด + ค้นหา
router.get('/api/admin/users', requireAdmin, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const users = (await db.listUsers({ search, limit })).map((u) => ({
    ...u,
    phone: u.phone || '', // แสดงเบอร์เต็มให้แอดมิน (เครื่องมือภายใน — ต้องใช้เบอร์จริงตอนแก้ไข)
    is_email_verified: u.is_email_verified === 1,
  }));
  res.json({ ok: true, users, total: await db.countUsers(search) });
});

// แก้ไขข้อมูลผู้ใช้
router.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const current = await db.findUserById(id);
  if (!current) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });

  const viewer = req.admin;
  // บัญชีระดับแอดมิน/เจ้าของระบบ แก้ไขได้เฉพาะเจ้าของระบบเท่านั้น
  if (isAdminRole(current.role) && !isOwner(viewer.role)) {
    return res.status(403).json({ ok: false, message: 'เฉพาะเจ้าของระบบเท่านั้นที่แก้ไขบัญชีแอดมิน/เจ้าของระบบได้' });
  }

  const { email, phone, status, role, isEmailVerified, newPassword } = req.body || {};
  const fields = {};

  if (email !== undefined) {
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ ok: false, field: 'email', message: 'รูปแบบอีเมลไม่ถูกต้อง' });
    }
    const dup = await db.findUserByEmail(normalizedEmail);
    if (dup && dup.id !== id) {
      return res.status(409).json({ ok: false, field: 'email', message: 'อีเมลนี้ถูกใช้ไปแล้ว' });
    }
    fields.email = normalizedEmail;
  }
  if (phone !== undefined) {
    const normalizedPhone = normalizeThaiPhone(phone);
    if (!isValidThaiPhone(normalizedPhone)) {
      return res.status(400).json({ ok: false, field: 'phone', message: 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 0812345678)' });
    }
    fields.phone = normalizedPhone;
  }
  if (status !== undefined) {
    if (!['pending', 'active'].includes(status)) {
      return res.status(400).json({ ok: false, message: 'สถานะไม่ถูกต้อง' });
    }
    // แอดมินห้ามตั้งสถานะตัวเองเป็น pending (กันล็อกตัวเองออก) — แต่แก้ไขอย่างอื่นของตัวเองได้
    if (id === req.admin.id && status !== 'active') {
      return res.status(400).json({ ok: false, message: 'ไม่สามารถเปลี่ยนสถานะบัญชีตัวเองได้' });
    }
    fields.status = status;
  }
  if (role !== undefined) {
    if (!isValidRole(role)) {
      return res.status(400).json({ ok: false, message: 'บทบาทไม่ถูกต้อง' });
    }
    // เฉพาะเจ้าของระบบเท่านั้นที่เปลี่ยนบทบาทได้ (แอดมินแก้บทบาทใครไม่ได้)
    if (!isOwner(viewer.role) && role !== current.role) {
      return res.status(403).json({ ok: false, message: 'เฉพาะเจ้าของระบบเท่านั้นที่เปลี่ยนบทบาทได้' });
    }
    // ห้ามลดระดับบทบาทของตัวเอง (เช่น owner ลดตัวเองเป็น admin)
    if (id === viewer.id && ROLE_RANK[role] < ROLE_RANK[current.role]) {
      return res.status(400).json({ ok: false, message: 'ไม่สามารถลดบทบาทของตัวเองได้' });
    }
    // ต้องเหลือเจ้าของระบบอย่างน้อย 1 คน
    if (current.role === 'owner' && role !== 'owner' && await db.countOwners() <= 1) {
      return res.status(400).json({ ok: false, message: 'ต้องมีเจ้าของระบบอย่างน้อย 1 คน' });
    }
    fields.role = role;
  }
  if (isEmailVerified !== undefined) {
    fields.isEmailVerified = Boolean(isEmailVerified);
  }
  if (newPassword !== undefined && newPassword !== '') {
    if (passwordStrengthScore(String(newPassword)) < 3) {
      return res.status(400).json({ ok: false, field: 'password', message: 'รหัสผ่านอ่อนเกินไป ต้องมีอย่างน้อย 8 ตัว และตรงตามเกณฑ์ความแข็งแรง' });
    }
    fields.passwordHash = await bcrypt.hash(String(newPassword), 10);
  }

  const updated = await db.updateUserByAdmin(id, fields);
  console.log(`👑 [${viewer.role}] แก้ไขผู้ใช้ #${id} (${updated.email})`);
  res.json({
    ok: true,
    message: 'บันทึกข้อมูลผู้ใช้แล้ว',
    user: {
      ...updated,
      phone: updated.phone || '',
      is_email_verified: updated.is_email_verified === 1,
    },
  });
});

// ลบผู้ใช้
router.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const viewer = req.admin;
  if (id === viewer.id) {
    return res.status(400).json({ ok: false, message: 'ไม่สามารถลบบัญชีตัวเองได้' });
  }
  const current = await db.findUserById(id);
  if (!current) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });
  // บัญชีระดับแอดมิน/เจ้าของระบบ ลบได้เฉพาะเจ้าของระบบเท่านั้น
  if (isAdminRole(current.role) && !isOwner(viewer.role)) {
    return res.status(403).json({ ok: false, message: 'เฉพาะเจ้าของระบบเท่านั้นที่ลบบัญชีแอดมิน/เจ้าของระบบได้' });
  }
  if (current.role === 'owner' && await db.countOwners() <= 1) {
    return res.status(400).json({ ok: false, message: 'ต้องมีเจ้าของระบบอย่างน้อย 1 คน' });
  }
  await db.deleteUser(id);
  await db.deleteUserSessions(id);
  console.log(`👑 [${viewer.role}] ลบผู้ใช้ #${id} (${current.email})`);
  res.json({ ok: true, message: 'ลบผู้ใช้แล้ว' });
});

// มอบของขวัญร้านค้าให้ผู้ใช้ (เฉพาะเจ้าของระบบ) พร้อมวันหมดอายุ
router.post('/api/admin/shop-gift', requireOwner, async (req, res) => {
  const id = Number(req.body?.userId);
  const target = await db.findUserById(id);
  if (!target) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });
  if (isAdminRole(target.role)) {
    return res.status(400).json({ ok: false, message: 'มอบของขวัญให้บัญชีแอดมิน/เจ้าของระบบไม่ได้' });
  }
  if (target.role === 'shop') {
    return res.status(400).json({ ok: false, message: 'ผู้ใช้รายนี้เป็นเจ้าของร้านอยู่แล้ว' });
  }

  const dateStr = String(req.body?.expiresAt || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ ok: false, field: 'expiresAt', message: 'กรุณาเลือกวันหมดอายุ' });
  }
  // สิ้นสุดวันตามเวลาไทย (+07:00) แล้วเก็บเป็น UTC
  const end = new Date(`${dateStr}T23:59:59+07:00`);
  if (isNaN(end.getTime())) {
    return res.status(400).json({ ok: false, field: 'expiresAt', message: 'วันหมดอายุไม่ถูกต้อง' });
  }
  if (end.getTime() <= Date.now()) {
    return res.status(400).json({ ok: false, field: 'expiresAt', message: 'วันหมดอายุต้องเป็นวันในอนาคต' });
  }

  const expiresAt = end.toISOString().slice(0, 19).replace('T', ' ');
  await db.setShopGift({ userId: id, grantedBy: req.owner.id, expiresAt });
  console.log(`🎁 [owner] มอบของขวัญร้านค้าให้ #${id} (${target.email}) ถึง ${dateStr}`);
  res.json({ ok: true, message: `มอบของขวัญร้านค้าให้ ${target.email} แล้ว (ใช้ได้ถึง ${dateStr})`, expiresAt });
});

// สถิติภาพรวม
router.get('/api/admin/stats', requireAdmin, async (req, res) => {
  res.json({ ok: true, stats: await db.countStats() });
});

// รายการ OTP ทั้งหมด (สำหรับหน้าจัดการ SMS-OTP)
router.get('/api/admin/otp-logs', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const nowMs = Date.now();
  const logs = (await db.listOtpLogs(limit)).map((l) => {
    const expiresMs = new Date(l.expires_at).getTime();
    let status;
    if (l.used === 1) status = 'used';
    else if (l.replaced === 1) status = 'replaced'; // ถูกตัดสิทธิ์เพราะมีการขอรหัสใหม่
    else if (expiresMs <= nowMs) status = 'expired';
    else status = 'valid';
    return {
      ...l,
      status,
      code: l.code_visible || null,
      remainingSec: status === 'valid' ? Math.max(0, Math.floor((expiresMs - nowMs) / 1000)) : 0,
    };
  });
  res.json({ ok: true, logs, serverTime: new Date().toISOString() });
});

// แอดมินสั่งส่ง OTP ใหม่ให้ผู้ใช้ (ข้าม cooldown 60 วิ ใช้ support)
router.post('/api/admin/otp/resend', requireAdmin, async (req, res) => {
  const userId = Number(req.body?.userId);
  const purpose = req.body?.purpose === 'password_reset' ? 'password_reset' : 'signup';
  const user = await db.findUserById(userId);
  if (!user) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });

  // ปลายทาง: รับเบอร์ที่แอดมินพิมพ์แทนได้ → ถ้าไม่ใส่ ใช้เบอร์ในบัญชี → ถ้ายังไม่มี ใช้เบอร์จาก OTP ครั้งก่อน
  let contact;
  if (purpose === 'password_reset') {
    contact = user.email;
  } else if (req.body?.phone) {
    contact = normalizeThaiPhone(String(req.body.phone));
  } else {
    contact = user.phone || (await db.findLatestOtpContact(user.id, purpose)) || '';
  }

  if (purpose === 'signup' && !isValidThaiPhone(contact)) {
    return res.status(400).json({
      ok: false,
      field: 'phone',
      message: 'ยังไม่มีเบอร์โทรสำหรับส่ง OTP — ใส่เบอร์ปลายทางก่อนส่ง หรือให้ผู้ใช้กรอกเบอร์ในระบบก่อน',
    });
  }

  const otpResult = await otp.issueOtp(user.id, contact, purpose);
  console.log(`👑 [แอดมิน] ส่ง OTP ใหม่ (${purpose}) ให้ ${user.email} → ${contact}`);

  res.json({
    ok: true,
    message: 'ส่ง OTP ใหม่แล้ว',
    contact,
    dev: devMode() ? { devOtp: otpResult.code } : null,
  });
});

// สถานะระบบ SMS-OTP
router.get('/api/admin/sms-status', requireAdmin, (req, res) => {
  const summary = sms.getConfigSummary();
  res.json({
    ok: true,
    status: {
      devMode: devMode(),
      provider: summary.provider,
      smtpConfigured: mailer.getSmtpConfig().configured,
      otpTtlMinutes: otp.getOtpTtlMinutes(),
      otpMaxAttempts: otp.getOtpMaxAttempts(),
      sms: summary,
    },
  });
});

// บันทึก provider + ค่า config ของ SMS (จากหน้าแอดมิน)
router.post('/api/admin/sms-settings', requireAdmin, (req, res) => {
  const { provider, accountSid, authToken, phone, apiKey, apiSecret, sender } = req.body || {};
  const chosen = provider === 'thaibulksms' ? 'thaibulksms' : 'twilio';
  let changed = 0;

  if (chosen === 'thaibulksms') {
    if (apiKey !== undefined && apiKey !== '') {
      if (String(apiKey).trim().length < 8) {
        return res.status(400).json({ ok: false, message: 'API Key ของ ThaiBulkSMS ดูสั้นเกินไป' });
      }
      db.setSetting('tbs_api_key', String(apiKey).trim());
      changed++;
    }
    if (apiSecret !== undefined && apiSecret !== '') {
      if (String(apiSecret).trim().length < 8) {
        return res.status(400).json({ ok: false, message: 'API Secret ของ ThaiBulkSMS ดูสั้นเกินไป' });
      }
      db.setSetting('tbs_api_secret', String(apiSecret).trim());
      changed++;
    }
    if (sender !== undefined && sender !== '') {
      if (!/^[A-Za-z0-9]{1,10}$/.test(String(sender).trim())) {
        return res.status(400).json({ ok: false, message: 'Sender ต้องเป็นตัวอักษร/เลข ไม่เกิน 10 ตัว (บัญชีทดลองใช้ Demo)' });
      }
      db.setSetting('tbs_sender', String(sender).trim());
      changed++;
    }
  } else {
    if (accountSid !== undefined && accountSid !== '') {
      if (!/^AC[0-9a-f]{32}$/i.test(String(accountSid).trim())) {
        return res.status(400).json({ ok: false, message: 'Account SID ไม่ถูกต้อง (ควรขึ้นต้นด้วย AC และยาว 34 ตัวอักษร)' });
      }
      db.setSetting('twilio_account_sid', String(accountSid).trim());
      changed++;
    }
    if (authToken !== undefined && authToken !== '') {
      if (String(authToken).trim().length < 20) {
        return res.status(400).json({ ok: false, message: 'Auth Token ดูสั้นเกินไป กรุณาตรวจสอบให้ถูกต้อง' });
      }
      db.setSetting('twilio_auth_token', String(authToken).trim());
      changed++;
    }
    if (phone !== undefined && phone !== '') {
      const digits = String(phone).replace(/[^0-9+]/g, '');
      if (!/^\+?\d{10,15}$/.test(digits)) {
        return res.status(400).json({ ok: false, message: 'เบอร์ผู้ส่ง (Twilio phone) ไม่ถูกต้อง เช่น +12025550123' });
      }
      db.setSetting('twilio_phone', digits);
      changed++;
    }
  }

  // บันทึก provider ที่เลือก (ถ้ามีการเปลี่ยน)
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'provider')) {
    db.setSetting('sms_provider', chosen);
    changed++;
  }

  // รีเซ็ต client ที่แคชไว้ เพื่อให้ใช้ค่าใหม่ทันที
  sms._resetClient();

  console.log(`👑 [แอดมิน] บันทึกการตั้งค่า SMS (provider=${chosen}, ${changed} รายการ)`);
  res.json({
    ok: true,
    message: changed > 0 ? `บันทึกการตั้งค่า SMS แล้ว (provider: ${chosen}, ${changed} รายการ)` : 'ไม่มีรายการที่เปลี่ยนแปลง',
  });
});

// ทดสอบส่ง SMS จริง (ต้องตั้งค่า provider ครบก่อน) — รับเบอร์ปลายทางจากหน้าแอดมิน
router.post('/api/admin/sms-test', requireAdmin, async (req, res) => {
  const result = await sms.sendTestSms({ to: String(req.body?.to || '').trim() });
  if (!result.ok) {
    return res.status(400).json({ ok: false, message: result.error || 'ส่ง SMS ทดสอบไม่สำเร็จ' });
  }
  console.log(`👑 [แอดมิน] ทดสอบส่ง SMS สำเร็จ (${result.provider}, id=${result.sid})`);
  res.json({
    ok: true,
    message: 'ส่ง SMS ทดสอบสำเร็จแล้ว (ตรวจที่เบอร์ปลายทาง)',
    provider: result.provider,
    sid: result.sid,
  });
});

// ตั้งค่า SMS-OTP (แอดมิน)
router.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { otpTtlMinutes, otpMaxAttempts, devMode: dev } = req.body || {};
  let changed = 0;

  if (otpTtlMinutes !== undefined && Number(otpTtlMinutes) >= 1 && Number(otpTtlMinutes) <= 60) {
    db.setSetting('otp_ttl_minutes', Number(otpTtlMinutes));
    changed++;
  }
  if (otpMaxAttempts !== undefined && Number(otpMaxAttempts) >= 1 && Number(otpMaxAttempts) <= 20) {
    db.setSetting('otp_max_attempts', Number(otpMaxAttempts));
    changed++;
  }
  if (typeof dev === 'boolean') {
    db.setSetting('dev_mode', String(dev));
    changed++;
  }

  console.log(`👑 [แอดมิน] บันทึกการตั้งค่า SMS-OTP (${changed} รายการ)`);
  res.json({
    ok: true,
    message: changed > 0 ? `บันทึกการตั้งค่าแล้ว (${changed} รายการ)` : 'ไม่มีรายการที่เปลี่ยนแปลง',
  });
});

// ---------------------------------------------------------------------------
// Owner — จัดการแพ็กเกจร้านค้า (ชื่อ / อายุการใช้งาน / รายละเอียดแบบมีหัวข้อ)
// ---------------------------------------------------------------------------
const PKG_MAX_DETAILS = 20;

/** ตรวจ + ทำความสะอาดรายละเอียด [{ heading, text }] จาก body */
function normalizePackageDetails(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, PKG_MAX_DETAILS)) {
    const heading = String(item?.heading || '').trim().slice(0, 120);
    const text = String(item?.text || '').trim().slice(0, 500);
    if (heading || text) out.push({ heading, text });
  }
  return out;
}

/** อ่าน + ตรวจค่าฟอร์มแพ็กเกจ → { value } หรือ { error } */
function readPackageBody(body) {
  const name = String(body?.name || '').trim().slice(0, 120);
  if (!name) return { error: { field: 'name', message: 'กรุณากรอกชื่อแพ็กเกจ' } };

  const durationMonths = Math.trunc(Number(body?.durationMonths));
  if (!Number.isFinite(durationMonths) || durationMonths < 1 || durationMonths > 120) {
    return { error: { field: 'durationMonths', message: 'อายุการใช้งานต้องเป็นจำนวนเดือน 1-120' } };
  }

  const price = Number(body?.price);
  if (!Number.isFinite(price) || price < 0 || price > 1000000) {
    return { error: { field: 'price', message: 'ราคาต้องเป็นตัวเลข 0 ขึ้นไป' } };
  }

  const sortOrder = Number.isFinite(Number(body?.sortOrder)) ? Math.trunc(Number(body.sortOrder)) : 0;
  const active = body?.active === undefined ? true : Boolean(body.active);

  return {
    value: {
      name,
      durationMonths,
      price: Math.round(price * 100) / 100,
      details: normalizePackageDetails(body?.details),
      active,
      sortOrder,
    },
  };
}

// รายการแพ็กเกจทั้งหมด (รวมที่ปิดขาย)
router.get('/api/owner/packages', requireOwner, async (req, res) => {
  res.json({ ok: true, packages: await db.listPackages() });
});

// สร้างแพ็กเกจใหม่
router.post('/api/owner/packages', requireOwner, async (req, res) => {
  const { value, error } = readPackageBody(req.body);
  if (error) return res.status(400).json({ ok: false, ...error });
  const id = await db.createPackage(value);
  console.log(`📦 [owner] สร้างแพ็กเกจ #${id} "${value.name}" (${value.durationMonths} เดือน)`);
  res.json({ ok: true, id, message: 'สร้างแพ็กเกจแล้ว' });
});

// แก้ไขแพ็กเกจ
router.put('/api/owner/packages/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const pkg = await db.findPackageById(id);
  if (!pkg) return res.status(404).json({ ok: false, message: 'ไม่พบแพ็กเกจ' });
  const { value, error } = readPackageBody(req.body);
  if (error) return res.status(400).json({ ok: false, ...error });
  await db.updatePackage(id, value);
  console.log(`📦 [owner] แก้ไขแพ็กเกจ #${id} "${value.name}"`);
  res.json({ ok: true, message: 'บันทึกการแก้ไขแล้ว' });
});

// ลบแพ็กเกจ
router.delete('/api/owner/packages/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const pkg = await db.findPackageById(id);
  if (!pkg) return res.status(404).json({ ok: false, message: 'ไม่พบแพ็กเกจ' });
  await db.deletePackage(id);
  console.log(`📦 [owner] ลบแพ็กเกจ #${id} "${pkg.name}"`);
  res.json({ ok: true, message: 'ลบแพ็กเกจแล้ว' });
});

module.exports = router;
