/**
 * slip-verify.js — ตรวจสลิปโอนเงินอัตโนมัติ
 *
 * ผู้ให้บริการ: EasySlip (https://developer.easyslip.com)
 *  - ยืนยันตัวตนด้วย Bearer token + ต้อง whitelist IP ของเซิร์ฟเวอร์ในหน้าเว็บผู้ให้บริการ
 *  - ส่งรูปสลิปเป็น base64 ในฟิลด์ payload
 *  - ตัวตอบกลับมีฟิลด์ amount / transRef / receiver และ isDuplicate (กันสลิปซ้ำ)
 *
 * หมายเหตุ: ชื่อฟิลด์ของผู้ให้บริการอาจต่างกันตามเวอร์ชัน API
 * ตัวอ่านค่าด้านล่างจึงรองรับหลายรูปแบบและบันทึก raw ไว้ให้ตรวจสอบเมื่อได้ key จริง
 */
'use strict';

const db = require('../db');

// ปลายทาง API ของผู้ให้บริการ — เปลี่ยนได้ผ่าน env เพื่อทดสอบ/staging
const EASYSLIP_ENDPOINT = process.env.SLIP_API_BASE || 'https://developer.easyslip.com/api/v1/verify';

/** อ่านค่าตั้งการตรวจสลิป */
function getSlipSettings() {
  return {
    provider: db.getSetting('slip_provider') || 'easyslip',
    apiKey: db.getSetting('slip_api_key') || '',
    receiverAccount: db.getSetting('slip_receiver_account') || '', // พร้อมเพย์/เลขบัญชีที่ต้องตรง
    autoApprove: db.getSetting('slip_auto_approve') === 'true',
    configured: Boolean(db.getSetting('slip_api_key')),
  };
}

/** ดึงตัวเลขจากค่าที่อาจเป็น object/string (เช่น {amount: 350} หรือ "350.00") */
function pickNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return pickNumber(v.amount != null ? v.amount : v.value);
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function pickString(v) {
  if (v == null) return '';
  if (typeof v === 'object') return pickString(v.value != null ? v.value : v.name != null ? v.name : v.account);
  return String(v);
}

/** เรียก API ผู้ให้บริการ → ผลลัพธ์รูปแบบเดียว */
async function verifySlip(buffer) {
  const s = getSlipSettings();
  if (!s.apiKey) return { ok: false, code: 'not_configured', message: 'ยังไม่ได้ตั้งค่า API key ของ EasySlip' };

  try {
    const res = await fetch(EASYSLIP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
      body: JSON.stringify({ payload: buffer.toString('base64') }),
    });
    const json = await res.json().catch(() => null);

    if (!res.ok || !json || Number(json.status) !== 200) {
      const msg = (json && (json.message || json.error)) || ('ตรวจสลิปไม่สำเร็จ (HTTP ' + res.status + ')');
      console.error('⚠️ EasySlip ตอบกลับผิดพลาด:', res.status, JSON.stringify(json).slice(0, 400));
      return { ok: false, code: 'verify_failed', message: String(msg).slice(0, 200) };
    }

    const d = json.data || {};
    const amount = pickNumber(d.amount);
    const receiver = d.receiver || {};
    const receiverAccount = pickString((receiver.account && (receiver.account.proxy || receiver.account.bank || receiver.account)) || receiver.proxy || '');
    const receiverName = pickString((receiver.account && receiver.account.name) || receiver.name || '');

    if (!amount) console.error('⚠️ EasySlip: อ่านยอดเงินไม่ได้ — โครงสร้างข้อมูล:', JSON.stringify(d).slice(0, 600));

    return {
      ok: true,
      code: 'verified',
      amount,
      transRef: pickString(d.transRef || d.transactionRef || ''),
      receiverAccount,
      receiverName,
      duplicate: Boolean(d.isDuplicate),
      raw: d,
    };
  } catch (err) {
    console.error('⚠️ เชื่อมต่อ EasySlip ไม่สำเร็จ:', err.message);
    return { ok: false, code: 'error', message: 'เชื่อมต่อผู้ให้บริการตรวจสลิปไม่สำเร็จ' };
  }
}

/**
 * ตัดสินใจว่าจะอนุมัติอัตโนมัติหรือให้เจ้าของระบบตรวจเอง
 * แยกเป็นฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) เพื่อทดสอบได้โดยไม่ต้องเรียก API จริง
 */
function decideAutoApprove({ settings, record, result }) {
  if (!settings.autoApprove) return { approve: false, status: 'manual', detail: 'ปิดโหมดอนุมัติอัตโนมัติ — รอตรวจสอบเอง' };
  if (!result || !result.ok) {
    return { approve: false, status: (result && result.code) || 'error', detail: (result && result.message) || 'ตรวจสลิปไม่สำเร็จ' };
  }
  if (result.duplicate) return { approve: false, status: 'duplicate', detail: 'สลิปนี้เคยถูกใช้ไปแล้ว' };

  const expect = Number(record.amount) || 0;
  if (Math.abs(result.amount - expect) > 0.01) {
    return { approve: false, status: 'amount_mismatch', detail: 'ยอดในสลิป ' + result.amount + ' ไม่ตรงกับยอดที่ต้องชำระ ' + expect };
  }

  if (settings.receiverAccount) {
    const norm = (v) => String(v == null ? '' : v).replace(/\D/g, '');
    const want = norm(settings.receiverAccount);
    const got = norm(result.receiverAccount);
    if (want && got && want !== got) {
      return { approve: false, status: 'receiver_mismatch', detail: 'บัญชีผู้รับในสลิปไม่ตรงกับที่ตั้งค่าไว้' };
    }
  }

  return { approve: true, status: 'verified', detail: 'ตรวจสลิปผ่าน · ยอดตรง' };
}

module.exports = { getSlipSettings, verifySlip, decideAutoApprove };
