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

const express = require('express');
const QRCode = require('qrcode');
const generatePromptPayPayload = require('promptpay-qr');
const db = require('../db');
const { requireLogin, requireOwner } = require('../middleware/auth');
const { futureMonthsSql } = require('../lib/time');
const { getPaymentSettings, hasAnyChannel, paymentInstructions } = require('../lib/payments');

const router = express.Router();
const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const digitsOnly = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// Express 4 ไม่ดัก error จาก async handler ให้เอง — ถ้าไม่ดักไว้ ข้อผิดพลาดจะทำให้โปรเซสล่ม
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// รายการชำระเงินของฉัน
router.get('/api/my-payments', requireLogin, wrap(async (req, res) => {
  const rows = await db.listPackagePayments({ userId: req.user.id, limit: 20 });
  res.json({ ok: true, payments: rows.map((r) => paymentInstructions(r)) });
}));

// แจ้งว่าโอนเงินแล้ว (ลูกค้ากดเอง — ไม่ได้ยืนยันยอดอัตโนมัติ)
router.post('/api/my-payments/:id/notify', requireLogin, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec || Number(rec.user_id) !== Number(req.user.id)) {
    return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  }
  if (rec.status !== 'pending') {
    return res.status(400).json({ ok: false, message: 'รายการนี้ถูกตรวจสอบไปแล้ว' });
  }
  await db.markPackagePaymentNotified(rec.id);
  console.log(`💸 ลูกค้าแจ้งชำระเงิน #${rec.id} (${rec.ref}) ยอด ฿${rec.amount}`);
  res.json({ ok: true, message: 'แจ้งชำระเงินแล้ว รอผู้ดูแลระบบตรวจสอบยอด' });
}));

// ---------------------------------------------------------------------------
// เจ้าของระบบ — ตั้งค่าช่องทางรับเงิน
// ---------------------------------------------------------------------------
router.get('/api/owner/payment-settings', requireOwner, (req, res) => {
  const s = getPaymentSettings();
  res.json({ ok: true, settings: s, ready: hasAnyChannel(s) });
});

router.post('/api/owner/payment-settings', requireOwner, wrap(async (req, res) => {
  const body = req.body || {};
  const enabled = Boolean(body.enabled);
  const promptpayId = digitsOnly(body.promptpayId);
  const bankName = clip(body.bankName, 60);
  const bankAccount = clip(String(body.bankAccount || '').replace(/[^\d-]/g, ''), 25);
  const bankHolder = clip(body.bankHolder, 80);
  const note = clip(body.note, 255);

  if (promptpayId && ![10, 13, 15].includes(promptpayId.length)) {
    return res.status(400).json({ ok: false, field: 'promptpayId', message: 'หมายเลข PromptPay ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก' });
  }
  if (bankAccount && !bankName) {
    return res.status(400).json({ ok: false, field: 'bankName', message: 'กรุณาระบุธนาคารของบัญชีที่กรอก' });
  }
  if (enabled && !promptpayId && !bankAccount) {
    return res.status(400).json({ ok: false, field: 'enabled', message: 'เปิดใช้งานไม่ได้ — ต้องตั้งค่า PromptPay หรือบัญชีธนาคารอย่างน้อย 1 อย่าง' });
  }

  await db.setSetting('pay_promptpay_id', promptpayId);
  await db.setSetting('pay_bank_name', bankName);
  await db.setSetting('pay_bank_account', bankAccount);
  await db.setSetting('pay_bank_holder', bankHolder);
  await db.setSetting('pay_note', note);
  await db.setSetting('pay_enabled', String(enabled));

  console.log(`💳 [owner] บันทึกการตั้งค่ารับเงิน (เปิดใช้=${enabled}${promptpayId ? ' · PromptPay' : ''}${bankAccount ? ' · โอนธนาคาร' : ''})`);
  res.json({ ok: true, message: enabled ? 'บันทึกแล้ว — เปิดรับชำระเงินจริง' : 'บันทึกแล้ว — ยังปิดรับชำระเงิน (ใช้โหมดจำลอง)' });
}));

// ---------------------------------------------------------------------------
// เจ้าของระบบ — คิวตรวจสอบยอด
// ---------------------------------------------------------------------------
router.get('/api/owner/package-payments', requireOwner, wrap(async (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : null;
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

// ยืนยันยอด → ให้สิทธิ์เจ้าของร้านทันทีตามอายุแพ็กเกจ
router.post('/api/owner/package-payments/:id/confirm', requireOwner, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  if (rec.status !== 'pending') return res.status(400).json({ ok: false, message: 'รายการนี้ถูกตรวจสอบไปแล้ว' });

  const user = await db.findUserById(rec.user_id);
  if (!user) return res.status(404).json({ ok: false, message: 'ไม่พบผู้ใช้ของรายการนี้' });

  const expiresAt = futureMonthsSql(rec.duration_months);
  await db.setUserRole(user.id, 'shop');
  await db.setUserShopExpiry(user.id, expiresAt);
  await db.createShopPurchase({
    userId: user.id,
    packageId: rec.package_id,
    packageName: clip(rec.package_name, 30),
    amount: Number(rec.amount),
  });
  await db.setPackagePaymentStatus(rec.id, 'paid', { confirmedBy: req.owner.id });

  console.log(`✅ [owner] ยืนยันชำระเงิน #${rec.id} (${rec.ref}) → ให้สิทธิ์ ${user.email} ถึง ${expiresAt}`);
  res.json({ ok: true, message: `ยืนยันยอดแล้ว — ${user.email} เป็นเจ้าของร้านถึง ${expiresAt.slice(0, 10)}` });
}));

// ยกเลิกรายการ (เช่น ตรวจแล้วไม่พบยอดโอน)
router.post('/api/owner/package-payments/:id/reject', requireOwner, wrap(async (req, res) => {
  const rec = await db.findPackagePaymentById(Number(req.params.id));
  if (!rec) return res.status(404).json({ ok: false, message: 'ไม่พบรายการชำระเงิน' });
  if (rec.status !== 'pending') return res.status(400).json({ ok: false, message: 'รายการนี้ถูกตรวจสอบไปแล้ว' });

  const reason = clip(req.body?.reason, 200) || 'ไม่พบยอดโอน';
  await db.setPackagePaymentStatus(rec.id, 'rejected', { confirmedBy: req.owner.id, note: reason });
  console.log(`⛔ [owner] ยกเลิกรายการชำระเงิน #${rec.id} (${rec.ref}) — ${reason}`);
  res.json({ ok: true, message: 'ยกเลิกรายการแล้ว' });
}));

module.exports = router;
