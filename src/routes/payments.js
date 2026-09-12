/**
 * payments.js — ระบบรับชำระเงินค่าแพ็กเกจ
 *
 * ฝั่งเจ้าของระบบ (/api/owner/*): ตั้งค่าช่องทางรับเงิน + ตรวจสอบยอดที่ลูกค้าแจ้งโอน
 * ฝั่งลูกค้า (/api/payment*, /api/my-payments): ดูข้อมูลโอน + QR PromptPay + แจ้งว่าชำระแล้ว
 *
 * หมายเหตุ: เวอร์ชันนี้ยังไม่ต่อผู้ให้บริการบัตรเครดิต (ต้องมีบัญชี merchant ของเจ้าของระบบ)
 * จึงรับเงินผ่าน PromptPay QR และการโอนเข้าบัญชีธนาคาร แล้วให้เจ้าของระบบกดยืนยันยอดเอง
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const generatePromptPayPayload = require('promptpay-qr');
const db = require('../db');
const { requireLogin, requireOwner } = require('../middleware/auth');
const { isAdminRole } = require('../lib/roles');
const { futureMonthsSql, addMonthsSql, toSql, nowSql } = require('../lib/time');
const { getPaymentSettings, hasAnyChannel, paymentInstructions, emailPackagePurchased, entitlementEndFor } = require('../lib/payments');
const { getSlipSettings, verifySlip, decideAutoApprove } = require('../lib/slip-verify');

const router = express.Router();
const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const digitsOnly = (v) => String(v == null ? '' : v).replace(/\D/g, '');
// โดเมนจริงของผู้ใช้ (รองรับ X-Forwarded-Proto ผ่าน trust proxy) — ใช้ทำลิงก์ในอีเมล
const baseUrlFrom = (req) => `${req.protocol}://${req.get('host')}`;

// Express 4 ไม่ดัก error จาก async handler ให้เอง — ถ้าไม่ดักไว้ ข้อผิดพลาดจะทำให้โปรเซสล่ม
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// สลิปโอนเงิน (เก็บไฟล์ใน public/uploads/slips)
// ---------------------------------------------------------------------------
const SLIP_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'slips');
const SLIP_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
// เพดาน 2MB (base64 จะบวม ~33% ต้องไม่เกินเพดาน JSON 4mb ของ express)
const MAX_SLIP_BYTES = 2 * 1024 * 1024;

/** แปลง data URL ของสลิป → buffer + นามสกุล */
function parseSlip(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('ไฟล์สลิปไม่ถูกต้อง (รองรับ png/jpeg/webp)');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('ไฟล์สลิปว่างเปล่า');
  if (buf.length > MAX_SLIP_BYTES) throw new Error('ไฟล์สลิปใหญ่เกิน 2MB');
  return { buf, ext: SLIP_TYPES[m[1]] };
}

function saveSlipBuffer(buf, ext, ref) {
  fs.mkdirSync(SLIP_DIR, { recursive: true });
  const name = String(ref || 'slip') + '-' + Date.now().toString(36) + '.' + ext;
  fs.writeFileSync(path.join(SLIP_DIR, name), buf);
  return '/uploads/slips/' + name;
}

/** ให้สิทธิ์เจ้าของร้านตามแพ็กเกจ — ใช้ทั้งการกดยืนยันเองและการอนุมัติอัตโนมัติจากสลิป */
async function grantPackage(rec, confirmedBy = null, baseUrl = '') {
  const user = await db.findUserById(rec.user_id);
  if (!user) return null;

  // ถ้ายังมีสิทธิ์เหลืออยู่ → "ต่ออายุจากวันหมดอายุเดิม" (ซื้อซ้อนได้) ไม่ใช่เริ่มนับใหม่
  const current = await entitlementEndFor(user);
  const stillActive = current && current.getTime() > Date.now();
  const startAt = stillActive ? toSql(current) : nowSql();
  const expiresAt = addMonthsSql(startAt, rec.duration_months);

  await db.setUserRole(user.id, 'shop');
  await db.setUserShopExpiry(user.id, expiresAt);
  await db.createShopPurchase({
    userId: user.id,
    packageId: rec.package_id,
    paymentId: rec.id,
    packageName: clip(rec.package_name, 30),
    amount: Number(rec.amount),
    startAt,
    expiresAt,
  });
  await db.setPackagePaymentStatus(rec.id, 'paid', { confirmedBy });
  // แจ้งลูกค้าทางอีเมล (รายละเอียดแพ็กเกจดึงจากที่แอดมินตั้งไว้) — ไม่บล็อกการตอบกลับ
  await emailPackagePurchased({
    user,
    packageId: rec.package_id,
    packageName: rec.package_name,
    durationMonths: rec.duration_months,
    amount: rec.amount,
    startAt,
    expiresAt,
    ref: rec.ref,
    extended: Boolean(stillActive),
    baseUrl,
  });
  return { user, expiresAt, extended: Boolean(stillActive), startAt };
}

// ---------------------------------------------------------------------------
// ลูกค้า
// ---------------------------------------------------------------------------

// ข้อมูลช่องทางรับเงิน (ใช้แสดงในหน้าซื้อแพ็กเกจ)
router.get('/api/payment-info', requireLogin, (req, res) => {
  const s = getPaymentSettings();
  res.json({
    ok: true,
    payment: {
      enabled: s.enabled,
      promptpayId: s.promptpayId || null,
      bank: s.bankAccount ? { name: s.bankName, account: s.bankAccount, holder: s.bankHolder } : null,
      note: s.note || '',
    },
  });
});

// QR PromptPay ของเจ้าของระบบ พร้อมยอดเงินที่ต้องจ่าย
router.get('/api/payment/promptpay-qr', requireLogin, wrap(async (req, res) => {
  const s = getPaymentSettings();
  if (!s.promptpayId) return res.status(404).json({ ok: false, message: 'ยังไม่ได้ตั้งค่า PromptPay' });

  const amount = Number(req.query.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ ok: false, message: 'ยอดเงินไม่ถูกต้อง' });
  }

  let payload;
  try {
    payload = generatePromptPayPayload(s.promptpayId, { amount: Math.round(amount * 100) / 100 });
  } catch (err) {
    return res.status(400).json({ ok: false, message: 'หมายเลข PromptPay ที่ตั้งไว้ไม่ถูกต้อง' });
  }

  const png = await QRCode.toBuffer(payload, { type: 'png', width: 360, margin: 1 });
  res.type('png').set('Cache-Control', 'no-store').send(png);
}));

// รายการชำระเงินของฉัน (ยกเลิกรายการที่หมดเวลาก่อน แล้วค่อยส่งข้อมูล)
router.get('/api/my-payments', requireLogin, wrap(async (req, res) => {
  await db.expireStalePayments();
  const rows = await db.listPackagePayments({ userId: req.user.id, limit: 20 });
  res.json({ ok: true, payments: rows.map((r) => paymentInstructions(r)) });
}));

// ประวัติการชำระเงินของฉัน — ทุกสถานะ + สิทธิ์ที่ได้ในแต่ละครั้ง + ของที่ได้โดยไม่ผ่านการชำระเงิน
// ส่งเฉพาะข้อมูลที่ลูกค้าดูได้ (ไม่ส่ง slip_hash / slip_detail ที่มีข้อความสำหรับผู้ดูแลระบบ)
router.get('/api/my-payments/history', requireLogin, wrap(async (req, res) => {
  await db.expireStalePayments();
  const [payments, grants, current] = await Promise.all([
    db.listMyPayments(req.user.id),
    db.listMyGrants(req.user.id),
    db.maxActiveEntitlement(req.user.id),
  ]);
  res.json({
    ok: true,
    currentExpiresAt: current || null,
    payments: payments.map((r) => ({
      id: r.id,
      ref: r.ref,
      packageName: r.package_name,
      durationMonths: r.duration_months,
      amount: Number(r.amount) || 0,
      method: r.method,
      status: r.status,
      notified: r.notified === 1,
      createdAt: r.created_at,
      confirmedAt: r.confirmed_at,
      note: r.note || '',
      hasSlip: Boolean(r.slip_url),
      slipStatus: r.slip_status || '',
      entitlement: r.purchase_id
        ? { startAt: r.start_at, expiresAt: r.expires_at, revokedAt: r.revoked_at }
        : null,
    })),
    grants: grants.map((r) => ({
      id: r.id,
      packageName: r.package_name,
      amount: Number(r.amount) || 0,
      createdAt: r.created_at,
      startAt: r.start_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
    })),
  });
}));

// แจ้งว่าโอนเงินแล้ว (แนบสลิปได้) — ถ้าตั้งค่าตรวจสลิปไว้ ระบบจะตรวจและอนุมัติให้อัตโนมัติ
router.post('/api/my-payments/:id/notify', requireLogin, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec || Number(rec.user_id) !== Number(req.user.id)) {
    return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  }
  if (rec.status !== 'pending') {
    return res.status(400).json({ ok: false, message: 'รายการนี้ถูกตรวจสอบไปแล้ว' });
  }
  // หมดเวลาแล้ว (ยังไม่แนบสลิป) → ปิดรายการนี้ ให้ลูกค้าสร้างใหม่
  if (rec.seconds_left != null && Number(rec.seconds_left) <= 0) {
    await db.setPackagePaymentStatus(rec.id, 'expired', { note: 'หมดเวลาชำระเงิน — กรุณาสร้างรายการใหม่' });
    return res.status(400).json({
      ok: false,
      expired: true,
      message: 'หมดเวลาชำระเงินสำหรับรายการนี้แล้ว — ถ้าโอนไปแล้ว กรุณาแจ้งผู้ดูแลระบบพร้อมรูปสลิป ผู้ดูแลระบบจะตรวจสอบและเปิดสิทธิ์ให้',
    });
  }

  const slipData = String(req.body?.slip || '');
  let slipUrl = '';
  let slipStatus = 'manual';
  let slipDetail = 'ลูกค้าแจ้งโอน (ไม่มีสลิป) — รอผู้ดูแลระบบตรวจสอบ';
  let customerNote = ''; // ข้อความถึงลูกค้า (เฉพาะกรณีที่ลูกค้าแก้เองได้)
  let slipHash = '';     // ลายนิ้วมือไฟล์สลิป (ใช้กันอัพสลิปซ้ำข้ามรายการ)

  if (slipData) {
    let parsed;
    try {
      parsed = parseSlip(slipData);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    // กันอัพสลิปไฟล์เดิมซ้ำกับรายการอื่น (เช่น เอาสลิปของรายการที่ถูกยกเลิกไปใช้กับรายการใหม่)
    slipHash = crypto.createHash('sha256').update(parsed.buf).digest('hex');
    const usedBy = await db.findPaymentBySlipHash(slipHash, rec.id);
    if (usedBy) {
      console.log(`⛔ ปฏิเสธสลิปซ้ำ: #${rec.id} (${rec.ref}) ใช้ไฟล์เดียวกับ #${usedBy.id} (${usedBy.ref})`);
      return res.status(400).json({
        ok: false,
        message: 'สลิปนี้เคยถูกใช้กับรายการอื่นแล้ว (' + usedBy.ref + ') — กรุณาแจ้งผู้ดูแลระบบเพื่อตรวจสอบ',
      });
    }

    slipUrl = saveSlipBuffer(parsed.buf, parsed.ext, rec.ref);

    const settings = getSlipSettings();
    if (settings.configured) {
      const result = await verifySlip(parsed.buf, rec.amount);
      const decision = decideAutoApprove({ settings, record: rec, result });
      slipStatus = decision.status;
      slipDetail = decision.detail;
      customerNote = result.customerMessage || '';

      if (decision.approve) {
        await db.markPackagePaymentNotified(rec.id, { slipUrl, slipStatus, slipDetail, slipHash });
        const granted = await grantPackage(rec, null, baseUrlFrom(req));
        console.log(`✅ ตรวจสลิปผ่าน — อนุมัติอัตโนมัติ #${rec.id} (${rec.ref})${granted ? ' → ' + granted.user.email : ''}`);
        return res.json({
          ok: true,
          autoApproved: true,
          message: 'ตรวจสลิปผ่าน — เปิดสิทธิ์เจ้าของร้านให้คุณแล้ว เริ่มใช้งานได้ทันที',
        });
      }
      console.log(`🔎 ตรวจสลิป #${rec.id} (${rec.ref}) → ${slipStatus}: ${slipDetail}`);
    } else {
      slipStatus = 'not_configured';
      slipDetail = 'ยังไม่ได้ตั้งค่าตรวจสลิปอัตโนมัติ — รอผู้ดูแลระบบตรวจสอบ';
    }
  }

  await db.markPackagePaymentNotified(rec.id, { slipUrl, slipStatus, slipDetail, slipHash });
  console.log(`💸 ลูกค้าแจ้งชำระเงิน #${rec.id} (${rec.ref}) ยอด ฿${rec.amount} [${slipStatus}]`);
  res.json({
    ok: true,
    autoApproved: false,
    message: customerNote || 'แจ้งชำระเงินแล้ว รอผู้ดูแลระบบตรวจสอบยอด',
  });
}));

// หมดเวลา (ลูกค้ายังไม่แนบสลิป) → ยกเลิกรายการ ให้สร้างใหม่ได้
router.post('/api/my-payments/:id/expire', requireLogin, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec || Number(rec.user_id) !== Number(req.user.id)) {
    return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  }
  if (rec.status !== 'pending') {
    return res.json({ ok: true, message: 'รายการนี้ถูกดำเนินการไปแล้ว' });
  }
  if (rec.notified === 1) {
    return res.json({ ok: true, message: 'แจ้งโอนแล้ว — รอผู้ดูแลระบบตรวจสอบยอด' });
  }
  await db.setPackagePaymentStatus(rec.id, 'expired', { note: 'หมดเวลาชำระเงิน — กรุณาเลือกแพ็กเกจและสร้างรายการใหม่' });
  console.log(`⏱️ หมดเวลาชำระเงิน #${rec.id} (${rec.ref}) — ปิดรายการอัตโนมัติ`);
  res.json({ ok: true, message: 'หมดเวลาชำระเงิน — กรุณาสร้างรายการใหม่' });
}));

// ---------------------------------------------------------------------------
// เจ้าของระบบ — ตั้งค่าช่องทางรับเงิน
// ---------------------------------------------------------------------------
router.get('/api/owner/payment-settings', requireOwner, (req, res) => {
  const s = getPaymentSettings();
  const slip = getSlipSettings();
  res.json({
    ok: true,
    settings: s,
    ready: hasAnyChannel(s),
    expireMinutes: db.getPaymentExpireMinutes(),
    slip: {
      configured: slip.configured,
      hasKey: Boolean(slip.apiKey),
      keyMasked: slip.apiKey ? '••••' + slip.apiKey.slice(-4) : null,
      receiverAccounts: slip.receiverAccounts,
      autoApprove: slip.autoApprove,
    },
  });
});

router.post('/api/owner/payment-settings', requireOwner, wrap(async (req, res) => {
  const body = req.body || {};
  const enabled = Boolean(body.enabled);
  const promptpayId = digitsOnly(body.promptpayId);
  const bankName = clip(body.bankName, 60);
  const bankAccount = clip(String(body.bankAccount || '').replace(/[^\d-]/g, ''), 25);
  const bankHolder = clip(body.bankHolder, 80);
  const note = clip(body.note, 255);
  const expireMinutes = Number(body.expireMinutes);

  if (promptpayId && ![10, 13, 15].includes(promptpayId.length)) {
    return res.status(400).json({ ok: false, field: 'promptpayId', message: 'หมายเลข PromptPay ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก' });
  }
  if (bankAccount && !bankName) {
    return res.status(400).json({ ok: false, field: 'bankName', message: 'กรุณาระบุธนาคารของบัญชีที่กรอก' });
  }
  if (enabled && !promptpayId && !bankAccount) {
    return res.status(400).json({ ok: false, field: 'enabled', message: 'เปิดใช้งานไม่ได้ — ต้องตั้งค่า PromptPay หรือบัญชีธนาคารอย่างน้อย 1 อย่าง' });
  }

  // ---- ตรวจสลิปอัตโนมัติ (EasySlip) ----
  const slipApiKey = String(body.slipApiKey || '').trim();
  const slipAutoApprove = Boolean(body.slipAutoApprove);
  const currentSlip = getSlipSettings();
  if (slipAutoApprove && !currentSlip.apiKey && !slipApiKey) {
    return res.status(400).json({ ok: false, field: 'slipApiKey', message: 'เปิดอนุมัติอัตโนมัติไม่ได้ — ต้องใส่ API key ของ EasySlip ก่อน' });
  }

  await db.setSetting('pay_promptpay_id', promptpayId);
  await db.setSetting('pay_bank_name', bankName);
  await db.setSetting('pay_bank_account', bankAccount);
  await db.setSetting('pay_bank_holder', bankHolder);
  await db.setSetting('pay_note', note);
  await db.setSetting('pay_enabled', String(enabled));
  if (Number.isFinite(expireMinutes) && expireMinutes >= 1 && expireMinutes <= 60) {
    await db.setSetting('pay_expire_minutes', String(Math.trunc(expireMinutes)));
  }
  await db.setSetting('slip_provider', 'easyslip');
  if (slipApiKey) await db.setSetting('slip_api_key', slipApiKey); // เว้นว่าง = ใช้ค่าเดิม
  await db.setSetting('slip_auto_approve', String(slipAutoApprove));
  // เลิกใช้ช่องบัญชีผู้รับแยกแล้ว — ระบบดึงจากช่องทางรับเงินข้อ ① (พร้อมเพย์/เลขบัญชี) แทน
  await db.setSetting('slip_receiver_account', '');

  console.log(`💳 [owner] บันทึกการตั้งค่ารับเงิน (เปิดใช้=${enabled}${promptpayId ? ' · PromptPay' : ''}${bankAccount ? ' · โอนธนาคาร' : ''} · ตรวจสลิปอัตโนมัติ=${slipAutoApprove})`);
  res.json({ ok: true, message: enabled ? 'บันทึกแล้ว — เปิดรับชำระเงินจริง' : 'บันทึกแล้ว — ยังปิดรับชำระเงิน (ใช้โหมดจำลอง)' });
}));

// ---------------------------------------------------------------------------
// เจ้าของระบบ — คิวตรวจสอบยอด
// ---------------------------------------------------------------------------
router.get('/api/owner/package-payments', requireOwner, wrap(async (req, res) => {
  await db.expireStalePayments();
  const q = req.query.status;
  // "todo" = งานที่ต้องตรวจ (รอตรวจสอบ + หมดเวลาแล้วแต่ยังรอเจ้าของระบบตัดสิน)
  const status = q === 'todo' ? ['pending', 'expired'] : (['pending', 'paid', 'rejected', 'expired'].includes(q) ? q : null);
  const rows = await db.listPackagePayments({ status, limit: Number(req.query.limit) || 100 });
  const users = await Promise.all(rows.map((r) => db.findUserById(r.user_id)));
  res.json({
    ok: true,
    payments: rows.map((r, i) => ({
      ...paymentInstructions(r),
      confirmedAt: r.confirmed_at,
      userEmail: users[i] ? users[i].email : '(ลบบัญชีแล้ว)',
    })),
  });
}));

// ประวัติการซื้อแพ็กเกจของลูกค้า (รายการที่ได้สิทธิ์แล้ว) + สรุปยอดขาย
router.get('/api/owner/purchase-history', requireOwner, wrap(async (req, res) => {
  const q = clip(req.query.q, 100) || null;
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const from = isDate(req.query.from) ? req.query.from + ' 00:00:00' : null;
  const to = isDate(req.query.to) ? req.query.to + ' 23:59:59' : null;
  const limit = Number(req.query.limit) || 200;

  const [rows, summary] = await Promise.all([
    db.listPurchaseHistory({ q, from, to, limit }),
    db.summarizePurchases(),
  ]);
  res.json({
    ok: true,
    summary,
    purchases: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      packageName: r.package_name,
      durationMonths: r.pay_months || r.pkg_months || null,
      amount: Number(r.amount),
      ref: r.ref || null,
      method: r.method || 'mock',
      status: r.pay_status || 'paid',
      createdAt: r.created_at,
      confirmedAt: r.confirmed_at,
      userRole: r.user_role,
      userExpiresAt: r.user_expires,
      slipStatus: r.slip_status || '',
      notified: r.notified === 1,
      startAt: r.start_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
    })),
  });
}));

// ดึงสิทธิ์เจ้าของร้านคืน (ยกเลิกการใช้งาน) — ประวัติการซื้อและการชำระเงินยังอยู่ครบ
// ดึงสิทธิ์กลับ "เฉพาะรายการซื้อนั้น" — รายการอื่น/อายุการใช้งานที่เหลือยังมีผลตามปกติ
router.post('/api/owner/purchases/:id/revoke', requireOwner, wrap(async (req, res) => {
  const purchase = await db.findShopPurchaseById(Number(req.params.id));
  if (!purchase) return res.status(404).json({ ok: false, message: 'ไม่พบรายการซื้อ' });
  if (purchase.revoked_at) return res.status(400).json({ ok: false, message: 'รายการนี้ถูกดึงสิทธิ์ไปแล้ว' });

  const target = await db.findUserById(purchase.user_id);
  if (target && isAdminRole(target.role)) {
    return res.status(400).json({ ok: false, message: 'ดึงสิทธิ์บัญชีแอดมิน/เจ้าของระบบไม่ได้' });
  }

  const done = await db.revokeShopPurchase(purchase.id, req.owner.id);
  if (!done) return res.status(400).json({ ok: false, message: 'ดึงสิทธิ์ไม่สำเร็จ กรุณาลองใหม่' });

  // คำนวณสิทธิ์ที่เหลือจากรายการอื่น แล้วปรับบทบาท/วันหมดอายุของผู้ใช้ให้ตรง
  const remaining = await db.maxActiveEntitlement(purchase.user_id);
  if (remaining) {
    await db.setUserRole(purchase.user_id, 'shop');
    await db.setUserShopExpiry(purchase.user_id, toSql(remaining));
  } else {
    await db.setUserRole(purchase.user_id, 'user');
    await db.setUserShopExpiry(purchase.user_id, null);
  }

  const when = remaining ? toSql(remaining).slice(0, 10) : null;
  console.log(`🚫 [owner] ดึงสิทธิ์รายการซื้อ #${purchase.id} "${purchase.package}" ของ ${target ? target.email : ''}${when ? ' — ยังเหลือสิทธิ์ถึง ' + when : ' — ไม่เหลือสิทธิ์'}`);
  res.json({
    ok: true,
    remainingAt: when,
    message: remaining
      ? `ดึงสิทธิ์แพ็กเกจ "${purchase.package}" คืนแล้ว — ลูกค้ายังมีสิทธิ์จากรายการอื่นถึง ${when}`
      : `ดึงสิทธิ์แพ็กเกจ "${purchase.package}" คืนแล้ว — ลูกค้าไม่มีสิทธิ์ที่ใช้งานได้เหลืออยู่`,
  });
}));

// เจ้าของระบบแนบสลิปแทนลูกค้า → ตรวจกับ EasySlip → ถ้าผ่าน เปิดสิทธิ์ให้ทันที
router.post('/api/owner/package-payments/:id/verify-slip', requireOwner, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  if (!['pending', 'expired'].includes(rec.status)) {
    return res.status(400).json({ ok: false, message: 'รายการนี้ถูกตรวจสอบไปแล้ว' });
  }

  let parsed;
  try {
    parsed = parseSlip(String(req.body?.slip || ''));
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
  const settings = getSlipSettings();
  if (!settings.configured) {
    return res.status(400).json({ ok: false, message: 'ยังไม่ได้ตั้งค่า API key ของ EasySlip จึงตรวจสลิปอัตโนมัติไม่ได้ — กรุณาตั้งค่าก่อน หรือกด "ยืนยันยอด" เพื่อยืนยันเอง' });
  }

  const result = await verifySlip(parsed.buf, rec.amount);
  // กันเหนียว: ระหว่างตรวจ รายการอาจถูกยืนยัน/ยกเลิกไปแล้วโดยคำขออื่น → ห้ามเขียนทับ
  const fresh = await db.findPackagePaymentById(rec.id);
  if (!fresh || !['pending', 'expired'].includes(fresh.status)) {
    return res.json({ ok: true, approved: true, message: 'รายการนี้ถูกตรวจสอบไปแล้ว — ไม่ได้บันทึกสลิปเพิ่ม' });
  }
  // เจ้าของระบบเป็นผู้สั่งตรวจเอง จึงใช้เกณฑ์เดียวกับการอนุมัติอัตโนมัติ (ยอด/บัญชี/สลิปซ้ำ ต้องผ่าน)
  const decision = decideAutoApprove({ settings: { ...settings, autoApprove: true }, record: rec, result });

  if (!decision.approve) {
    // ตรวจไม่ผ่าน → บันทึกเฉพาะผลการตรวจ ไม่บันทึกไฟล์สลิป (กันสลิปซ้ำ/สลิปที่ไม่ผ่านค้างในระบบ)
    await db.setPackagePaymentSlip(rec.id, { slipStatus: decision.status, slipDetail: 'ตรวจสลิปโดยผู้ดูแลระบบไม่ผ่าน — ' + decision.detail });
    console.log(`🔎 [owner] ตรวจสลิปแทนลูกค้า #${rec.id} (${rec.ref}) → ${decision.status}: ${decision.detail} (ไม่บันทึกไฟล์)`);
    return res.status(400).json({ ok: false, approved: false, message: 'ตรวจสลิปไม่ผ่าน: ' + decision.detail });
  }

  // ผ่านการตรวจแล้วเท่านั้น จึงบันทึกไฟล์สลิปไว้เป็นหลักฐาน
  const slipUrl = saveSlipBuffer(parsed.buf, parsed.ext, rec.ref);
  const slipHash = crypto.createHash('sha256').update(parsed.buf).digest('hex');
  await db.setPackagePaymentSlip(rec.id, { slipUrl, slipStatus: decision.status, slipHash, slipDetail: 'แนบสลิปโดยผู้ดูแลระบบ — ' + decision.detail });

  const granted = await grantPackage(rec, req.owner.id, baseUrlFrom(req));
  console.log(`✅ [owner] ตรวจสลิปแทนลูกค้าผ่าน #${rec.id} (${rec.ref}) → เปิดสิทธิ์ ${granted ? granted.user.email : ''}`);
  res.json({
    ok: true,
    approved: true,
    message: granted
      ? `ตรวจสลิปผ่าน — เปิดสิทธิ์เจ้าของร้านให้ ${granted.user.email} ถึง ${granted.expiresAt.slice(0, 10)} แล้ว`
      : 'ตรวจสลิปผ่านและบันทึกแล้ว',
  });
}));

// ยืนยันยอด → ให้สิทธิ์เจ้าของร้านทันทีตามอายุแพ็กเกจ
router.post('/api/owner/package-payments/:id/confirm', requireOwner, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  // ยืนยันได้ทั้งรายการที่รอตรวจสอบ และรายการที่หมดเวลาแล้ว (กรณีลูกค้าโอนช้า/แนบสลิปไม่ทัน)
  if (!['pending', 'expired'].includes(rec.status)) {
    return res.status(400).json({ ok: false, message: 'รายการนี้ถูกตรวจสอบไปแล้ว' });
  }

  const granted = await grantPackage(rec, req.owner.id, baseUrlFrom(req));
  if (!granted) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้ของรายการนี้' });

  console.log(`✅ [owner] ยืนยันชำระเงิน #${rec.id} (${rec.ref}) → ให้สิทธิ์ ${granted.user.email} ถึง ${granted.expiresAt}${granted.extended ? ' (ต่ออายุจากเดิม)' : ''}`);
  res.json({
    ok: true,
    message: `ยืนยันยอดแล้ว — ${granted.user.email} เป็นเจ้าของร้านถึง ${granted.expiresAt.slice(0, 10)}` + (granted.extended ? ' (ต่ออายุจากวันหมดอายุเดิม)' : ''),
  });
}));

// ยกเลิกรายการ (เช่น ตรวจแล้วไม่พบยอดโอน)
router.post('/api/owner/package-payments/:id/reject', requireOwner, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  if (!['pending', 'expired'].includes(rec.status)) {
    return res.status(400).json({ ok: false, message: 'รายการนี้ถูกตรวจสอบไปแล้ว' });
  }

  const reason = clip(req.body?.reason, 200) || 'ไม่พบยอดโอน';
  await db.setPackagePaymentStatus(rec.id, 'rejected', { confirmedBy: req.owner.id, note: reason });
  console.log(`⛔ [owner] ยกเลิกรายการชำระเงิน #${rec.id} (${rec.ref}) — ${reason}`);
  res.json({ ok: true, message: 'ยกเลิกรายการแล้ว' });
}));

module.exports = router;
