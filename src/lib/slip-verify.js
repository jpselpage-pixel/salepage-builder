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

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const db = require('../db');

// เปลี่ยนปลายทางได้ผ่าน env สำหรับทดสอบ/staging
const EASYSLIP_ENDPOINT = process.env.SLIP_API_BASE || 'https://api.easyslip.com/v2/verify/bank';

/** แปลงชื่อโฮสต์ → IPv4 */
function resolveIpv4(host) {
  return new Promise((resolve) => {
    dns.resolve4(host, (err, addrs) => resolve(err || !addrs || !addrs.length ? null : addrs[0]));
  });
}

/**
 * POST JSON โดยเลือกใช้ IPv4 ก่อน
 * เหตุผล: เซิร์ฟเวอร์นี้มีทั้ง IPv4/IPv6 แต่ผู้ให้บริการ (EasySlip) whitelist เฉพาะ IPv4
 * ถ้าปล่อยให้ Node วิ่งไป IPv6 จะโดน IP_NOT_ALLOWED — จึงบังคับต่อผ่าน IPv4
 * (คง Host/SNI เป็นชื่อโฮสต์จริง เพื่อให้ตรวจ certificate ผ่าน)
 */
async function postJson(urlStr, headers, bodyObj) {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const ip = isHttps ? await resolveIpv4(url.hostname) : null;
  const body = JSON.stringify(bodyObj);
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request({
      host: ip || url.hostname,
      servername: isHttps ? url.hostname : undefined,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: Object.assign({
        Host: url.hostname,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }, headers),
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('หมดเวลารอผู้ให้บริการ')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** รหัสข้อผิดพลาดของผู้ให้บริการ → รหัสภายในระบบ */
const ERROR_MAP = {
  IMAGE_SIZE_TOO_LARGE: 'image_too_large',
  INVALID_IMAGE_FORMAT: 'invalid_image',
  INVALID_IMAGE: 'invalid_image',
  VALIDATION_ERROR: 'invalid_image',
  SLIP_NOT_FOUND: 'slip_not_found',
  SLIP_PENDING: 'slip_pending',
  IP_NOT_ALLOWED: 'ip_not_allowed',
  UNAUTHORIZED: 'unauthorized',
  INVALID_API_KEY: 'unauthorized',
  AUTHENTICATION_ERROR: 'unauthorized',
  QUOTA_EXCEEDED: 'quota',
  USAGE_LIMIT_EXCEEDED: 'quota',
  INSUFFICIENT_BALANCE: 'quota',
};

/** ข้อความสำหรับเจ้าของระบบ (ในคิวตรวจสอบ) */
const OWNER_TEXT = {
  image_too_large: 'รูปสลิปใหญ่เกิน 4MB',
  invalid_image: 'อ่านรูปสลิปไม่ได้',
  slip_not_found: 'ไม่พบ QR Code ในรูปสลิป',
  slip_pending: 'สลิปธนาคารกรุงเทพเพิ่งโอนไม่เกิน 5 นาที — ให้ลูกค้ารอแล้วแนบใหม่',
  ip_not_allowed: 'IP ของเซิร์ฟเวอร์ไม่ได้รับอนุญาต — ต้องเพิ่ม 118.27.151.243 ใน whitelist ของ EasySlip',
  unauthorized: 'API key ของ EasySlip ไม่ถูกต้องหรือถูกยกเลิก — ตรวจสอบที่หน้าเว็บ EasySlip',
  quota: 'โควต้าตรวจสลิปของ EasySlip หมด — กรุณาเติมเครดิตหรืออัปเกรดแพ็กเกจ',
  verify_failed: 'ตรวจสลิปไม่สำเร็จ',
  error: 'เชื่อมต่อผู้ให้บริการตรวจสลิปไม่สำเร็จ',
};

/** ข้อความที่บอกลูกค้าได้ (เฉพาะกรณีที่ลูกค้าแก้ไขเองได้) — กรณีตั้งค่าผิดจะไม่โชว์ให้ลูกค้าเห็น */
const CUSTOMER_TEXT = {
  image_too_large: 'รูปสลิปใหญ่เกิน 4MB กรุณาย่อรูปก่อนแนบ',
  invalid_image: 'อ่านรูปสลิปไม่ได้ กรุณาแนบรูปสลิปที่ชัดเจน',
  slip_not_found: 'ไม่พบ QR Code ในรูปสลิป กรุณาแนบรูปที่เห็น QR ชัด ๆ',
  slip_pending: 'สลิปธนาคารกรุงเทพที่เพิ่งโอนไม่เกิน 5 นาที ต้องรอสักครู่แล้วแจ้งใหม่',
};

function getSlipSettings() {
  const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  // บัญชีผู้รับที่คาดหวัง — ใช้ค่าที่ตั้งไว้เอง ถ้าไม่มีก็ดึงจากช่องทางรับเงินที่กรอกไว้ (ไม่ต้องกรอกซ้ำ)
  const candidates = [
    db.getSetting('slip_receiver_account'),
    db.getSetting('pay_bank_account'),
    db.getSetting('pay_promptpay_id'),
  ].map(digits).filter(Boolean);
  return {
    provider: db.getSetting('slip_provider') || 'easyslip',
    apiKey: db.getSetting('slip_api_key') || '',
    receiverAccounts: [...new Set(candidates)],
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

/**
 * เทียบบัญชีผู้รับ — EasySlip มักส่งเลขบัญชีแบบปิดบางหลัก (เช่น xxx-x-x5678-x)
 * จึงเทียบแบบเข้มก่อน และถ้าไม่ตรงให้เทียบ 4 หลักท้าย (ใช้คู่กับยอดเงิน + การกันสลิปซ้ำ)
 */
function accountMatches(wantRaw, gotRaw) {
  const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  const want = digits(wantRaw);
  const got = digits(gotRaw);
  if (!want || !got) return false;
  if (want === got) return true;
  const tail = 4;
  if (want.length >= tail && got.length >= tail) return want.slice(-tail) === got.slice(-tail);
  return false;
}

/** เรียก EasySlip ตรวจสลิปธนาคาร (ส่งรูปเป็น base64) → ผลลัพธ์รูปแบบเดียว */
async function verifySlip(buffer, expectedAmount) {
  const s = getSlipSettings();
  if (!s.apiKey) return { ok: false, code: 'not_configured', message: 'ยังไม่ได้ตั้งค่า API key ของ EasySlip', customerMessage: '' };

  const body = { base64: buffer.toString('base64'), checkDuplicate: true, matchAccount: true };
  const amount = Number(expectedAmount);
  if (Number.isFinite(amount) && amount > 0) body.matchAmount = amount;

  try {
    const { status, json } = await postJson(EASYSLIP_ENDPOINT, { Authorization: 'Bearer ' + s.apiKey }, body);

    if (!json) {
      console.error('⚠️ EasySlip ตอบกลับไม่ใช่ JSON (HTTP ' + status + ')');
      return { ok: false, code: 'verify_failed', message: OWNER_TEXT.verify_failed, customerMessage: '' };
    }

    if (json.success !== true) {
      const code = (json.error && json.error.code) || 'HTTP_' + status;
      const providerMessage = (json.error && json.error.message) || '';
      const mapped = ERROR_MAP[code] || 'verify_failed';
      console.error('⚠️ EasySlip [' + code + '] ' + providerMessage);
      return {
        ok: false,
        code: mapped,
        providerCode: code,
        message: (OWNER_TEXT[mapped] || OWNER_TEXT.verify_failed) + (providerMessage ? ' (' + providerMessage + ')' : ''),
        customerMessage: CUSTOMER_TEXT[mapped] || '',
      };
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
    // เก็บสาเหตุจริงไว้ด้วย เพื่อให้ตรวจสอบย้อนหลังได้ (เช่น timeout / DNS / TLS)
    return { ok: false, code: 'error', message: OWNER_TEXT.error + ' (' + String(err.message || '').slice(0, 120) + ')', customerMessage: '' };
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
  if (!receiverOk) {
    const wanted = Array.isArray(settings.receiverAccounts) ? settings.receiverAccounts : [];
    if (wanted.some((acc) => accountMatches(acc, result.receiverAccount))) {
      receiverOk = true;
      extra = 'บัญชีผู้รับตรงกับช่องทางรับเงินที่ตั้งไว้ (เทียบ 4 หลักท้าย)';
    }
  }
  if (!receiverOk) {
    return {
      approve: false,
      status: 'receiver_unverified',
      detail: 'ยืนยันบัญชีผู้รับไม่ได้ — ตรวจว่าบัญชีที่ลงทะเบียนใน EasySlip หรือเลขพร้อมเพย์/เลขบัญชีในช่องทางรับเงิน ตรงกับบัญชีที่ลูกค้าโอนเข้า',
    };
  }

  return { approve: true, status: 'verified', detail: 'ตรวจสลิปผ่าน · ยอดตรง · ' + extra };
}

module.exports = { getSlipSettings, verifySlip, decideAutoApprove, accountMatches };
