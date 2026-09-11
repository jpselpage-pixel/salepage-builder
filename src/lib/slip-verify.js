/**
 * slip-verify.js — ตรวจสลิปโอนเงินอัตโนมัติผ่าน EasySlip
 *
 * API ที่ใช้ (สลิปธนาคาร ผ่าน base64):
 *   POST https://api.easyslip.com/v2/verify/bank
 *   Authorization: Bearer <API_KEY>
 *   Content-Type: application/json
 *   body: { base64, matchAmount?, matchAccount?, checkDuplicate? }
 *
 * ข้อดี: ผู้ให้บริการจับคู่ยอดเงิน (matchAmount) และบัญชีผู้รับที่ลงทะเบียนไว้ (matchAccount)
 * จึงไม่ต้องเทียบเลขบัญชีเอง แต่ต้องลงทะเบียนบัญชีรับเงินในหน้าเว็บ EasySlip ก่อน
 *
 * สลิปทรูมันนี่ใช้คนละปลายทาง (POST /v2/verify/truewallet) — ยังไม่เปิดใช้ในระบบนี้
 */
'use strict';

const db = require('../db');

// เปลี่ยนปลายทางได้ผ่าน env สำหรับทดสอบ/staging
const EASYSLIP_ENDPOINT = process.env.SLIP_API_BASE || 'https://api.easyslip.com/v2/verify/bank';

/** รหัสข้อผิดพลาดของผู้ให้บริการ → รหัสภายในระบบ */
const ERROR_MAP = {
  IMAGE_SIZE_TOO_LARGE: 'image_too_large',
  INVALID_IMAGE_FORMAT: 'invalid_image',
  INVALID_IMAGE: 'invalid_image',
  VALIDATION_ERROR: 'invalid_image',
  SLIP_NOT_FOUND: 'slip_not_found',
  SLIP_PENDING: 'slip_pending',
};

/** ข้อความภาษาไทยที่ลูกค้าควรเห็น */
const ERROR_TEXT = {
  image_too_large: 'รูปสลิปใหญ่เกิน 4MB กรุณาย่อรูปก่อนแนบ',
  invalid_image: 'อ่านรูปสลิปไม่ได้ กรุณาแนบรูปสลิปที่ชัดเจน',
  slip_not_found: 'ไม่พบ QR Code ในรูปสลิป กรุณาแนบรูปที่เห็น QR ชัด ๆ',
  slip_pending: 'สลิปธนาคารกรุงเทพที่เพิ่งโอนไม่เกิน 5 นาที ต้องรอสักครู่แล้วแจ้งใหม่',
  verify_failed: 'ตรวจสลิปไม่สำเร็จ',
  error: 'เชื่อมต่อผู้ให้บริการตรวจสลิปไม่สำเร็จ',
};

function getSlipSettings() {
  return {
    provider: db.getSetting('slip_provider') || 'easyslip',
    apiKey: db.getSetting('slip_api_key') || '',
    receiverAccount: db.getSetting('slip_receiver_account') || '',
    autoApprove: db.getSetting('slip_auto_approve') === 'true',
    configured: Boolean(db.getSetting('slip_api_key')),
  };
}

function pickAccount(account) {
  if (!account) return '';
  if (account.bank && account.bank.account) return account.bank.account;
  if (account.proxy && account.proxy.account) return account.proxy.account;
  return '';
}

/** เรียก EasySlip ตรวจสลิปธนาคาร (ส่งรูปเป็น base64) → ผลลัพธ์รูปแบบเดียว */
async function verifySlip(buffer, expectedAmount) {
  const s = getSlipSettings();
  if (!s.apiKey) return { ok: false, code: 'not_configured', message: 'ยังไม่ได้ตั้งค่า API key ของ EasySlip' };

  const body = { base64: buffer.toString('base64'), checkDuplicate: true, matchAccount: true };
  const amount = Number(expectedAmount);
  if (Number.isFinite(amount) && amount > 0) body.matchAmount = amount;

  try {
    const res = await fetch(EASYSLIP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);

    if (!json) {
      console.error('⚠️ EasySlip ตอบกลับไม่ใช่ JSON (HTTP ' + res.status + ')');
      return { ok: false, code: 'verify_failed', message: ERROR_TEXT.verify_failed };
    }

    if (json.success !== true) {
      const code = (json.error && json.error.code) || 'HTTP_' + res.status;
      const message = (json.error && json.error.message) || ERROR_TEXT.verify_failed;
      const mapped = ERROR_MAP[code] || 'verify_failed';
      console.error('⚠️ EasySlip [' + code + '] ' + message);
      return { ok: false, code: mapped, providerCode: code, message: ERROR_TEXT[mapped] || String(message).slice(0, 200) };
    }

    const d = json.data || {};
    const raw = d.rawSlip || {};
    const receiver = raw.receiver || {};
    const acc = receiver.account || {};
    const localAmount = raw.amount && raw.amount.local ? raw.amount.local.amount : undefined;
    const amountInSlip = Number(d.amountInSlip != null ? d.amountInSlip : (raw.amount && (raw.amount.amount != null ? raw.amount.amount : localAmount))) || 0;

    return {
      ok: true,
      code: 'verified',
      amount: amountInSlip,
      isAmountMatched: d.isAmountMatched,
      amountInOrder: d.amountInOrder,
      duplicate: Boolean(d.isDuplicate),
      matchedAccount: d.matchedAccount || null,
      receiverAccount: pickAccount(acc),
      receiverName: (acc.name && (acc.name.th || acc.name.en)) || '',
      transRef: raw.transRef || '',
      date: raw.date || '',
      raw: d,
    };
  } catch (err) {
    console.error('⚠️ เชื่อมต่อ EasySlip ไม่สำเร็จ:', err.message);
    return { ok: false, code: 'error', message: ERROR_TEXT.error };
  }
}

/**
 * ตัดสินใจว่าจะอนุมัติอัตโนมัติหรือให้เจ้าของระบบตรวจเอง
 * แยกเป็นฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) เพื่อทดสอบได้โดยไม่ต้องเรียก API จริง
 */
function decideAutoApprove({ settings, record, result }) {
  if (!settings.autoApprove) return { approve: false, status: 'manual', detail: 'ปิดโหมดอนุมัติอัตโนมัติ — รอตรวจสอบเอง' };
  if (!result || !result.ok) {
    return { approve: false, status: (result && result.code) || 'error', detail: (result && result.message) || ERROR_TEXT.verify_failed };
  }
  if (result.duplicate) return { approve: false, status: 'duplicate', detail: 'สลิปนี้เคยถูกใช้ไปแล้ว' };

  // ยอดเงิน: ใช้การเทียบฝั่งเราเป็นหลัก (เรารู้ยอดที่ต้องชำระแน่นอน)
  // ธง isAmountMatched ของผู้ให้บริการใช้ "veto" ได้อย่างเดียว ห้ามใช้ overriding ให้ผ่าน
  const expect = Number(record.amount) || 0;
  const got = Number(result.amount) || 0;
  const amountOk = got > 0 && Math.abs(got - expect) <= 0.01 && result.isAmountMatched !== false;
  if (!amountOk) {
    return { approve: false, status: 'amount_mismatch', detail: 'ยอดในสลิป ' + got + ' ไม่ตรงกับยอดที่ต้องชำระ ' + expect };
  }

  // ยืนยันบัญชีผู้รับ: ผู้ให้บริการจับคู่กับบัญชีที่ลงทะเบียนไว้ให้ ถ้าไม่ได้ให้เทียบกับเลขที่ตั้งค่าเอง
  let receiverOk = Boolean(result.matchedAccount);
  let extra = receiverOk ? 'บัญชีผู้รับตรงกับที่ลงทะเบียนใน EasySlip' : '';
  if (!receiverOk && settings.receiverAccount) {
    const norm = (v) => String(v == null ? '' : v).replace(/\D/g, '');
    const want = norm(settings.receiverAccount);
    const got = norm(result.receiverAccount);
    if (want && got && want === got) { receiverOk = true; extra = 'บัญชีผู้รับตรงกับที่ตั้งค่าไว้'; }
  }
  if (!receiverOk) {
    return {
      approve: false,
      status: 'receiver_unverified',
      detail: 'ยืนยันบัญชีผู้รับไม่ได้ — ลงทะเบียนบัญชีรับเงินในหน้า EasySlip หรือใส่เลขบัญชีผู้รับในการตั้งค่า แล้วระบบจะอนุมัติอัตโนมัติได้',
    };
  }

  return { approve: true, status: 'verified', detail: 'ตรวจสลิปผ่าน · ยอดตรง · ' + extra };
}

module.exports = { getSlipSettings, verifySlip, decideAutoApprove };
