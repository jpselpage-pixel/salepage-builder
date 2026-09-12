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
const express = require('express');
const QRCode = require('qrcode');
const generatePromptPayPayload = require('promptpay-qr');
const db = require('../db');
const { requireLogin, requireOwner } = require('../middleware/auth');
const { isAdminRole } = require('../lib/roles');
const { futureMonthsSql } = require('../lib/time');
const { getPaymentSettings, hasAnyChannel, paymentInstructions } = require('../lib/payments');
const { getSlipSettings, verifySlip, decideAutoApprove } = require('../lib/slip-verify');

const router = express.Router();
const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const digitsOnly = (v) => String(v == null ? '' : v).replace(/\D/g, '');

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
async function grantPackage(rec, confirmedBy = null) {
  const user = await db.findUserById(rec.user_id);
  if (!user) return null;
  const expiresAt = futureMonthsSql(rec.duration_months);
  await db.setUserRole(user.id, 'shop');
  await db.setUserShopExpiry(user.id, expiresAt);
  await db.createShopPurchase({
    userId: user.id,
    packageId: rec.package_id,
    paymentId: rec.id,
    packageName: clip(rec.package_name, 30),
    amount: Number(rec.amount),
  });
  await db.setPackagePaymentStatus(rec.id, 'paid', { confirmedBy });
  return { user, expiresAt };
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
      message: 'หมดเวลาชำระเงินแล้ว — ถ้าโอนไปแล้วและมีสลิป กรุณาสร้างรายการใหม่แล้วแนบสลิปเดิม',
    });
  }

  const slipData = String(req.body?.slip || '');
  let slipUrl = '';
  let slipStatus = 'manual';
  let slipDetail = 'ลูกค้าแจ้งโอน (ไม่มีสลิป) — รอผู้ดูแลระบบตรวจสอบ';
  let customerNote = ''; // ข้อความถึงลูกค้า (เฉพาะกรณีที่ลูกค้าแก้เองได้)

  if (slipData) {
    let parsed;
    try {
      parsed = parseSlip(slipData);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
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
        await db.markPackagePaymentNotified(rec.id, { slipUrl, slipStatus, slipDetail });
        const granted = await grantPackage(rec, null);
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

  await db.markPackagePaymentNotified(rec.id, { slipUrl, slipStatus, slipDetail });
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
  const status = ['pending', 'paid', 'rejected', 'expired'].includes(req.query.status) ? req.query.status : null;
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
    })),
  });
}));

// ดึงสิทธิ์เจ้าของร้านคืน (ยกเลิกการใช้งาน) — ประวัติการซื้อและการชำระเงินยังอยู่ครบ
router.post('/api/owner/shop-access/:userId/revoke', requireOwner, wrap(async (req, res) => {
  const userId = Number(req.params.userId);
  const target = await db.findUserById(userId);
  if (!target) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้' });
  if (isAdminRole(target.role)) {
    return res.status(400).json({ ok: false, message: 'ดึงสิทธิ์บัญชีแอดมิน/เจ้าของระบบไม่ได้' });
  }
  if (target.role !== 'shop') {
    return res.status(400).json({ ok: false, message: 'บัญชีนี้ไม่ได้เป็นเจ้าของร้านอยู่แล้ว' });
  }

  const done = await db.revokeShopAccess(userId);
  if (!done) return res.status(400).json({ ok: false, message: 'ดึงสิทธิ์ไม่สำเร็จ กรุณาลองใหม่' });

  console.log(`🚫 [owner] ดึงสิทธิ์เจ้าของร้านคืน: ${target.email}`);
  res.json({ ok: true, message: `ดึงสิทธิ์เจ้าของร้านของ ${target.email} คืนแล้ว (กลับเป็นผู้ใช้งานทั่วไป)` });
}));

// ยืนยันยอด → ให้สิทธิ์เจ้าของร้านทันทีตามอายุแพ็กเกจ
router.post('/api/owner/package-payments/:id/confirm', requireOwner, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  // ยืนยันได้ทั้งรายการที่รอตรวจสอบ และรายการที่หมดเวลาแล้ว (กรณีลูกค้าโอนช้า/แนบสลิปไม่ทัน)
  if (!['pending', 'expired'].includes(rec.status)) {
    return res.status(400).json({ ok: false, message: 'รายการนี้ถูกตรวจสอบไปแล้ว' });
  }

  const granted = await grantPackage(rec, req.owner.id);
  if (!granted) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้ของรายการนี้' });

  console.log(`✅ [owner] ยืนยันชำระเงิน #${rec.id} (${rec.ref}) → ให้สิทธิ์ ${granted.user.email} ถึง ${granted.expiresAt}`);
  res.json({ ok: true, message: `ยืนยันยอดแล้ว — ${granted.user.email} เป็นเจ้าของร้านถึง ${granted.expiresAt.slice(0, 10)}` });
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
