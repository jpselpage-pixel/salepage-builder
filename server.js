/**
 * server.js — จุดเริ่มระบบ (entry point)
 *
 * รัน:   npm start            (โหมดปกติ)
 *        npm run dev          (โหมด auto-restart เมื่อแก้โค้ด)
 *
 * โค้ดหลักแยกอยู่ใน src/ (app / routes / middleware / lib)
 * ไฟล์นี้ทำหน้าที่ boot: ต่อฐานข้อมูล → สร้างตาราง → สร้างแอดมินแรก → เปิดเซิร์ฟเวอร์
 */
'use strict';

const bcrypt = require('bcryptjs');
const app = require('./src/app');
const db = require('./src/db');
const { PORT } = require('./src/config');
const { DEV_MODE } = require('./src/lib/settings');

// ตาข่ายกันเซิร์ฟเวอร์ล่มจากข้อผิดพลาดที่หลุดมา (เช่น async handler ที่ไม่ได้ try/catch)
// — บันทึกไว้ให้ตรวจ แล้วให้คำขออื่นทำงานต่อได้ (pm2 ยังรีสตาร์ทให้ถ้าจำเป็น)
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled promise rejection:', err && err.stack ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err && err.stack ? err.stack : err);
});

(async () => {
  try {
    await db.initDb();
    await db.deleteExpiredSessions();

    // ถอนสิทธิ์ของขวัญร้านค้าที่หมดอายุแล้ว (คืนบทบาทเป็น user)
    const expiredGifts = await db.clearExpiredGifts();
    if (expiredGifts) console.log(`🎁 ถอนสิทธิ์ของขวัญร้านค้าที่หมดอายุแล้ว ${expiredGifts} บัญชี`);

    // สร้างบัญชีเจ้าของระบบ (owner) ครั้งแรก ถ้ายังไม่มี — ตั้งค่าได้ผ่าน ADMIN_EMAIL/ADMIN_PASSWORD ใน .env
    if (!await db.findOwner()) {
      const ownerEmail = String(process.env.ADMIN_EMAIL || 'owner@example.com').trim().toLowerCase();
      const ownerPassword = process.env.ADMIN_PASSWORD || 'Owner@123!';
      const hash = await bcrypt.hash(ownerPassword, 10);
      await db.createOwnerUser({ email: ownerEmail, passwordHash: hash });
      console.log('==============================================');
      console.log('👑 สร้างบัญชีเจ้าของระบบ (owner) เรียบร้อย:');
      console.log(`   อีเมล: ${ownerEmail}`);
      console.log(`   รหัสผ่าน: ${process.env.ADMIN_PASSWORD ? '(จาก .env)' : 'Owner@123! (ควรเปลี่ยนทันที)'}`);
      console.log('==============================================');
    }

    app.listen(PORT, () => {
      console.log('==============================================');
      console.log(`🚀 เซิร์ฟเวอร์ระบบสมาชิกรันที่: http://localhost:${PORT}`);
      console.log(`    โหมด: ${DEV_MODE ? 'DEV (โหมดจำลอง OTP/อีเมล)' : 'PRODUCTION'}`);
      console.log(`    หน้าแรก: http://localhost:${PORT}/`);
      console.log(`    สมัครสมาชิก: http://localhost:${PORT}/register.html`);
      console.log('==============================================');
    });
  } catch (err) {
    console.error('❌ ไม่สามารถเชื่อมต่อฐานข้อมูล MySQL ได้:', err.message);
    process.exit(1);
  }
})();
