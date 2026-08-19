/**
 * scripts/gmail-oauth.js — ขอ Gmail API credentials (Client ID/Secret + Refresh Token)
 *
 * วิธีใช้ (รันบนเครื่องของคุณ — ต้องมี Node.js):
 *   1. สร้าง Google Cloud credentials (ดูขั้นตอนด้านล่าง)
 *   2. ตั้งค่าลง .env (หรือ environment):
 *        GMAIL_CLIENT_ID=xxxx.apps.googleusercontent.com
 *        GMAIL_CLIENT_SECRET=xxxx
 *        GMAIL_USER=your-email@gmail.com
 *        GMAIL_PORT=0  ← (ใช้ port อื่นเพื่อไม่ชนกับเว็บ)
 *   3. node scripts/gmail-oauth.js
 *   4. เปิดลิงก์ที่แสดง → ล็อกอิน Gmail → ยอมรับสิทธิ์
 *   5. ระบบจะให้ Refresh Token — นำไปกรอกที่หน้าแอดมิน (หรือ .env)
 *
 * วิธีสร้าง Google Cloud credentials:
 *   1. ไปที่ https://console.cloud.google.com → สร้าง Project ใหม่
 *   2. เมนู APIs & Services → Library → ค้นหา "Gmail API" → Enable
 *   3. เมนู APIs & Services → OAuth consent screen → External → สร้าง
 *      - App name: SalePage, User support email: อีเมลคุณ
 *      - Scopes: เพิ่ม https://www.googleapis.com/auth/gmail.send
 *      - Test users: เพิ่มอีเมลที่ใช้ส่ง (คุณ)
 *   4. เมนู Credentials → Create Credentials → OAuth client ID
 *      - Application type: Desktop app
 *      - ได้ Client ID + Client Secret
 *   5. กลับมาขั้นตอน 2 ข้างบน
 */
'use strict';

const readline = require('node:readline');
const http = require('node:http');
const crypto = require('node:crypto');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_PORT = Number(process.env.GMAIL_PORT || 0) || 9000;

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ ต้องตั้ง GMAIL_CLIENT_ID และ GMAIL_CLIENT_SECRET ใน .env ก่อน');
  console.error('ดูวิธีสร้างได้ในคอมเมนต์หัวไฟล์นี้');
  process.exit(1);
}

(async () => {
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `http://localhost:${REDIRECT_PORT}/callback`,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  console.log('1) เปิดลิงก์นี้ในเบราว์เซอร์ แล้วล็อกอิน Gmail + ยอมรับสิทธิ์:');
  console.log('   ' + authUrl);
  console.log('');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname === '/callback') {
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('state mismatch');
          return;
        }
        const c = url.searchParams.get('code');
        if (c) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h3>สำเร็จ! ปิดหน้านี้ได้เลย แล้วกลับมาที่ terminal</h3>');
          resolve(c);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('no code: ' + (url.searchParams.get('error') || 'unknown'));
          reject(new Error(url.searchParams.get('error') || 'no code'));
        }
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(REDIRECT_PORT, () => console.log(`2) รอ callback ที่ http://localhost:${REDIRECT_PORT}/callback ...`));
    server.on('error', (e) => { console.error('❌ port ไม่ว่าง:', e.message); process.exit(1); });
  });

  console.log('');
  console.log('3) แลก code → refresh token ...');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: `http://localhost:${REDIRECT_PORT}/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.refresh_token) {
    console.error('❌ แลก token ไม่สำเร็จ:', JSON.stringify(tokenData));
    process.exit(1);
  }

  console.log('');
  console.log('✅ สำเร็จ! นำค่าเหล่านี้ไปกรอกที่หน้าแอดมิน (จัดการ SMS-OTP → ตั้งค่า Gmail API)');
  console.log('================================================================');
  console.log('GMAIL_CLIENT_ID = ' + CLIENT_ID);
  console.log('GMAIL_CLIENT_SECRET = ' + CLIENT_SECRET);
  console.log('GMAIL_REFRESH_TOKEN = ' + tokenData.refresh_token);
  console.log('GMAIL_USER = ' + (process.env.GMAIL_USER || '(อีเมล Gmail ที่ใช้ส่ง)'));
  console.log('================================================================');
})();
