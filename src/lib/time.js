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

module.exports = { nowSql, futureSql, futureMonthsSql };
