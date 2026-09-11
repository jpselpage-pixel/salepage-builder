/**
 * crypto.js — ตัวช่วยสร้าง/แฮชค่าเกี่ยวกับ session และโทเคน
 */
'use strict';

const crypto = require('node:crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { sha256, randomToken };
