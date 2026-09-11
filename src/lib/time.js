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

module.exports = { nowSql, futureSql };
