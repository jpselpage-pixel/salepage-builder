/**
 * time.js — เวลา UTC รูปแบบ YYYY-MM-DD HH:MM:SS (ให้ตรงกับ UTC_TIMESTAMP() ใน MySQL)
 */
'use strict';

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function futureSql(ms) {
  return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** บวกจำนวนเดือนแบบปฏิทิน (ไม่ใช่ 30 วัน) — เช่นใช้คำนวณวันหมดอายุแพ็กเกจ */
function futureMonthsSql(months) {
  const d = new Date();
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  // เดือนปลายทางมีวันน้อยกว่า (เช่น 31 ม.ค. + 1 เดือน) → ใช้วันสุดท้ายของเดือนนั้นแทน
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** บวกจำนวนเดือนจากวันที่ที่กำหนด (ถ้าไม่ส่ง base ใช้เวลาปัจจุบัน) — คืนรูปแบบ YYYY-MM-DD HH:MM:SS (UTC) */
function addMonthsSql(base, months) {
  const d = base ? new Date(base) : new Date();
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** แปลงวันที่/สตริงวันที่ → รูปแบบ YYYY-MM-DD HH:MM:SS (UTC) */
function toSql(base) {
  return new Date(base).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * แปลงค่าที่ได้จากฐานข้อมูล (Date หรือสตริง DATETIME) → epoch ms
 * สตริงจาก MySQL เป็นเวลา UTC ('YYYY-MM-DD HH:MM:SS') จึงเติม Z ก่อนแปลง
 */
function toMs(v) {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) return new Date(s.replace(' ', 'T') + 'Z').getTime();
  return new Date(s).getTime();
}

/**
 * หมดอายุแล้วหรือยัง
 * หมายเหตุ: ห้ามเทียบ Date กับสตริงด้วย <= ตรง ๆ (จะได้ false เสมอ เพราะสตริงกลายเป็น NaN)
 */
function isExpired(v) {
  const t = toMs(v);
  return Number.isFinite(t) && t <= Date.now();
}

module.exports = { nowSql, futureSql, futureMonthsSql, addMonthsSql, toSql, toMs, isExpired };
