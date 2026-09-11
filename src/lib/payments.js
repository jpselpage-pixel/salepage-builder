/**
 * payments.js — ค่าตั้งช่องทางรับเงิน + ข้อมูลที่ส่งให้ลูกค้าใช้โอน
 *
 * ค่าตั้งเก็บในตาราง settings (เหมือน SMTP/SMS) เจ้าของระบบกรอกที่หน้า /admin/payments.html
 */
'use strict';

const crypto = require('node:crypto');
const db = require('../db');

/** อ่านค่าตั้งช่องทางรับเงิน */
function getPaymentSettings() {
  return {
    enabled: db.getSetting('pay_enabled') === 'true',
    promptpayId: db.getSetting('pay_promptpay_id') || '',
    bankName: db.getSetting('pay_bank_name') || '',
    bankAccount: db.getSetting('pay_bank_account') || '',
    bankHolder: db.getSetting('pay_bank_holder') || '',
    note: db.getSetting('pay_note') || '',
  };
}

/** จำนวนเงินที่โอนได้จริง — ต้องมีช่องทางรับเงินอย่างน้อย 1 อย่าง */
function hasAnyChannel(s = getPaymentSettings()) {
  return Boolean(s.promptpayId || s.bankAccount);
}

/** แปลงข้อมูลรายการชำระเงิน → สิ่งที่ต้องแสดงให้ลูกค้า (ไม่รวมข้อมูลลับ) */
function paymentInstructions(rec) {
  const s = getPaymentSettings();
  const amount = Number(rec.amount) || 0;
  return {
    id: rec.id,
    ref: rec.ref,
    amount,
    packageName: rec.package_name,
    durationMonths: rec.duration_months,
    status: rec.status,
    notified: rec.notified === 1,
    createdAt: rec.created_at,
    qrUrl: s.promptpayId ? '/api/payment/promptpay-qr?amount=' + amount.toFixed(2) + '&ref=' + encodeURIComponent(rec.ref) : null,
    bank: s.bankAccount ? { name: s.bankName, account: s.bankAccount, holder: s.bankHolder } : null,
    note: rec.note || '',      // หมายเหตุของรายการนั้น ๆ (เช่น เหตุผลที่ถูกยกเลิก)
    payNote: s.note || '',     // ข้อความถึงลูกค้าจากการตั้งค่าช่องทางรับเงิน
    slipUrl: rec.slip_url || null,       // รูปสลิปที่ลูกค้าแนบ
    slipStatus: rec.slip_status || '',   // ผลตรวจสลิปอัตโนมัติ
    slipDetail: rec.slip_detail || '',
  };
}

/** รหัสอ้างอิงให้ลูกค้าใส่ในบันทึกโอน เช่น QP7K2M9A */
function generateRef() {
  return 'QP' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

module.exports = { getPaymentSettings, hasAnyChannel, paymentInstructions, generateRef };
