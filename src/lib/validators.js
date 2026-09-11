/**
 * validators.js — ตรวจ/แปลงข้อมูลนำเข้า (อีเมล เบอร์โทรศัพท์ไทย รหัสผ่าน)
 */
'use strict';

function maskPhone(phone) {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 7) return phone;
  return `${digits.slice(0, 3)}-***-${digits.slice(-4)}`;
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * ตรวจเบอร์โทรไทย — ยอมรับทั้งแบบมี/ไม่มี 0 นำหน้า และแบบมี 66/+66
 * เช่น 0812345678 | 812345678 | 66812345678 | +66812345678
 */
function isValidThaiPhone(value) {
  const d = String(value || '').replace(/[^0-9]/g, '');
  return /^0\d{9}$/.test(d) || /^8\d{8}$/.test(d) || /^668\d{8}$/.test(d);
}

/** แปลงเบอร์ไทยทุกรูปแบบ → มาตรฐาน 08XXXXXXXX (10 หลัก มี 0 นำหน้า) */
function normalizeThaiPhone(value) {
  let d = String(value || '').replace(/[^0-9]/g, '');
  if (d.startsWith('668')) d = d.slice(2); // 66812345678 → 812345678
  if (/^8\d{8}$/.test(d)) d = '0' + d;      // 812345678 → 0812345678
  return d;
}

/**
 * ให้คะแนนความแข็งแรงรหัสผ่าน (0-5) — ต้องตรงกับฝั่ง client (register.html)
 * เกณฑ์: 8 ตัวขึ้นไป, 12 ตัวขึ้นไป, มีพิมพ์ใหญ่, มีพิมพ์เล็ก, มีตัวเลข, มีสัญลักษณ์
 */
function passwordStrengthScore(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

module.exports = { maskPhone, isValidEmail, isValidThaiPhone, normalizeThaiPhone, passwordStrengthScore };
