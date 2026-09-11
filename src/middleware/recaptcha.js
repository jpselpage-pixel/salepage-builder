/**
 * recaptcha.js — ตรวจ reCAPTCHA v2 (ข้ามเมื่อยังไม่ตั้ง RECAPTCHA_SECRET_KEY)
 */
'use strict';

// ---------------------------------------------------------------------------
// reCAPTCHA v2 — ตรวจเฉพาะเมื่อตั้ง RECAPTCHA_SECRET_KEY ไว้ (dev ข้ามไป)
// ---------------------------------------------------------------------------
async function isRecaptchaValid(responseToken) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return true; // ยังไม่ได้ตั้ง key → ข้าม (ใช้ honeypot + rate limit แทน)
  if (!responseToken) return false;
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: responseToken }),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

module.exports = { isRecaptchaValid };
