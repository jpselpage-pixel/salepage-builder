/**
 * google-oauth.js — ค่าตั้งล็อกอินด้วย Google (OAuth 2.0)
 *
 * อ่านค่าจากตาราง settings ก่อน (แอดมินกรอกได้ที่หน้า /admin/otp.html)
 * แล้วค่อยใช้ค่าใน .env เป็นค่าเริ่มต้น — เหมือน SMTP/SMS
 */
'use strict';

const db = require('../db');
const { PORT } = require('../config');

function getGoogleConfig() {
  const clientId = String(db.getSetting('google_client_id') || process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(db.getSetting('google_client_secret') || process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = String(
    db.getSetting('google_redirect_uri') || process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/auth/google/callback`
  ).trim();

  return {
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret),
    source: db.getSetting('google_client_id') ? 'admin' : 'env',
  };
}

module.exports = { getGoogleConfig };
