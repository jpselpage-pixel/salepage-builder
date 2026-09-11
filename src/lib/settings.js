/**
 * settings.js — อ่านค่าตั้งระบบจากตาราง settings (แอดมินปรับได้) แล้ว fallback เป็น env
 */
'use strict';

const db = require('../db');

const DEV_MODE = String(process.env.DEV_MODE || 'true') === 'true'; // ค่าเริ่มต้นตอน boot

// อ่านโหมด dev แบบ dynamic — แอดมินสลับได้ผ่านหน้าจัดการ (ตาราง settings)
function devMode() {
  const s = db.getSetting('dev_mode');
  return s !== null ? s === 'true' : DEV_MODE;
}

module.exports = { DEV_MODE, devMode };
