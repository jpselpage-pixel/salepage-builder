/**
 * sms.js — ส่ง SMS จริง (รองรับหลาย provider)
 *
 * Provider ที่รองรับ:
 *   1. Twilio      — international / trial-friendly
 *   2. ThaiBulkSMS — API v2 (https://api-v2.thaibulksms.com/sms) เหมาะกับ SMS ไทย 🇹🇭
 *
 * ค่า config อ่านจากตาราง settings ก่อน (แอดมินกรอกได้ที่หน้า /admin/otp.html)
 * แล้วค่อยใช้ค่า .env เป็นค่าเริ่มต้น
 *
 * Provider ที่เลือกอยู่ เก็บใน setting 'sms_provider' ('twilio' | 'thaibulksms')
 */
'use strict';

const db = require('./db');

// ---------------------------------------------------------------------------
// เลือก provider
// ---------------------------------------------------------------------------
function getProvider() {
  const s = db.getSetting('sms_provider');
  return s === 'thaibulksms' ? 'thaibulksms' : 'twilio';
}

// ---------------------------------------------------------------------------
// Config — Twilio
// ---------------------------------------------------------------------------
function getTwilioConfig() {
  const sid = db.getSetting('twilio_account_sid') || process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = db.getSetting('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN || '';
  const from = db.getSetting('twilio_phone') || process.env.TWILIO_PHONE || '';
  return {
    sid,
    authToken,
    from,
    configured: Boolean(sid && authToken && from),
  };
}

let twilioClient = null;

function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const { sid, authToken } = getTwilioConfig();
  if (!sid || !authToken) return null;
  try {
    const twilio = require('twilio');
    twilioClient = twilio(sid, authToken);
  } catch (err) {
    console.error('❌ ไม่สามารถโหลด Twilio SDK:', err.message);
    return null;
  }
  return twilioClient;
}

// ---------------------------------------------------------------------------
// Config — ThaiBulkSMS (API v2: API Key + API Secret + Sender)
// ---------------------------------------------------------------------------
function getThaiBulkSmsConfig() {
  const apiKey = db.getSetting('tbs_api_key') || process.env.TBS_API_KEY || '';
  const apiSecret = db.getSetting('tbs_api_secret') || process.env.TBS_API_SECRET || '';
  const sender = db.getSetting('tbs_sender') || process.env.TBS_SENDER || '';
  return {
    apiKey,
    apiSecret,
    sender,
    configured: Boolean(apiKey && apiSecret && sender),
  };
}

// ---------------------------------------------------------------------------
// ส่ง SMS ตาม provider ที่เลือก
// ---------------------------------------------------------------------------
async function sendSms({ to, body }) {
  const provider = getProvider();
  if (provider === 'thaibulksms') {
    return sendThaiBulkSms({ to, body });
  }
  return sendTwilioSms({ to, body });
}

async function sendTwilioSms({ to, body }) {
  const cfg = getTwilioConfig();
  if (!cfg.configured) {
    return { ok: false, provider: 'twilio', error: 'ยังไม่ได้ตั้งค่า Twilio (SID / Token / เบอร์ผู้ส่ง)' };
  }
  const client = getTwilioClient();
  if (!client) {
    return { ok: false, provider: 'twilio', error: 'Twilio SDK โหลดไม่สำเร็จ' };
  }
  try {
    const message = await client.messages.create({ body, from: cfg.from, to });
    return { ok: true, provider: 'twilio', sid: message.sid };
  } catch (err) {
    return { ok: false, provider: 'twilio', error: err.message || 'ส่ง SMS ไม่สำเร็จ' };
  }
}

async function sendThaiBulkSms({ to, body }) {
  const cfg = getThaiBulkSmsConfig();
  if (!cfg.configured) {
    return { ok: false, provider: 'thaibulksms', error: 'ยังไม่ได้ตั้งค่า ThaiBulkSMS (API Key / Secret / Sender)' };
  }
  try {
    const res = await fetch('https://api-v2.thaibulksms.com/sms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64'),
      },
      body: new URLSearchParams({ sender: cfg.sender, msisdn: to, message: body }),
    });
    const data = await res.json();

    if (res.ok && data.phone_number_list) {
      const first = data.phone_number_list[0] || {};
      return { ok: true, provider: 'thaibulksms', sid: first.message_id || 'ok', remaining: data.remaining_credit };
    }
    return {
      ok: false,
      provider: 'thaibulksms',
      error: (data.error && data.error.description) || `ส่งไม่สำเร็จ (HTTP ${res.status})`,
    };
  } catch (err) {
    return { ok: false, provider: 'thaibulksms', error: err.message || 'เชื่อมต่อ ThaiBulkSMS ไม่สำเร็จ' };
  }
}

// ---------------------------------------------------------------------------
// ส่งข้อความทดสอบไปยังเบอร์ปลายทางที่แอดมินระบุ
// ---------------------------------------------------------------------------
async function sendTestSms({ to }) {
  const provider = getProvider();
  const cfg = provider === 'thaibulksms' ? getThaiBulkSmsConfig() : getTwilioConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      provider,
      error: provider === 'thaibulksms'
        ? 'ยังไม่ได้ตั้งค่า ThaiBulkSMS (API Key / Secret / Sender) ก่อนทดสอบ'
        : 'ยังไม่ได้ตั้งค่า Twilio (SID / Token / เบอร์ผู้ส่ง) ก่อนทดสอบ',
    };
  }
  if (!to) {
    return { ok: false, provider, error: 'กรุณาระบุเบอร์ปลายทางสำหรับทดสอบ' };
  }
  return sendSms({ to, body: '✅ ทดสอบการตั้งค่า SMS สำเร็จ — ร้านค้าออนไลน์' });
}

// ---------------------------------------------------------------------------
// สรุป config สำหรับแสดงในหน้าแอดมิน (ซ่อนเฉพาะ secret: API Secret / Auth Token)
// ---------------------------------------------------------------------------
function getConfigSummary() {
  const provider = getProvider();
  if (provider === 'thaibulksms') {
    const c = getThaiBulkSmsConfig();
    return {
      provider,
      configured: c.configured,
      keyMasked: c.apiKey ? c.apiKey.slice(0, 6) + '…' : null,
      sender: c.sender || null,
      senderFull: c.sender || '', // Sender ไม่ใช่ secret — เอาไว้เติมกลับในช่องกรอก
      source: db.getSetting('tbs_api_key') ? 'admin' : 'env',
    };
  }
  const c = getTwilioConfig();
  return {
    provider,
    configured: c.configured,
    sidMasked: c.sid ? c.sid.slice(0, 8) + '…' : null,
    sidFull: c.sid || '',      // SID ไม่ใช่ secret — เอาไว้เติมกลับในช่องกรอก
    fromFull: c.from || '',    // เบอร์ผู้ส่งไม่ใช่ secret
    from: c.from || null,
    source: db.getSetting('twilio_account_sid') ? 'admin' : 'env',
  };
}

/**
 * ล้าง client ที่แคชไว้ — เรียกเมื่อแอดมินบันทึกค่าใหม่ เพื่อให้ใช้ config ใหม่ทันที
 */
function _resetClient() {
  twilioClient = null;
}

module.exports = {
  getProvider,
  getTwilioConfig,
  getThaiBulkSmsConfig,
  getConfigSummary,
  sendSms,
  sendTestSms,
  _resetClient,
};
