/**
 * scripts/migrate-to-mysql.js — ย้ายข้อมูลจาก SQLite (shop.db) → MySQL
 *
 * วิธีรัน:
 *   node scripts/migrate-to-mysql.js
 *
 * ต้องตั้ง DATABASE_URL ก่อนรัน (เช่น env var หรือใน .env)
 * ย้าย: users, pages, settings  (ข้าม sessions/otp/tokens — เป็นข้อมูลชั่วคราว)
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'shop.db');
const DATABASE_URL = process.env.DATABASE_URL || process.env.MYSQL_URL;

if (!DATABASE_URL) {
  console.error('❌ ต้องตั้ง DATABASE_URL ก่อนรัน (เช่น DATABASE_URL=mysql://... node scripts/migrate-to-mysql.js)');
  process.exit(1);
}

(async () => {
  const sqlite = new DatabaseSync(DB_PATH, { readOnly: true });
  const pool = await mysql.createPool({ uri: DATABASE_URL, connectionLimit: 5, timezone: 'Z', charset: 'utf8mb4' });

  // 1. users
  const users = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
  console.log(`📦 users: ${users.length} รายการ`);
  for (const u of users) {
    await pool.execute(
      `INSERT IGNORE INTO users
        (id, email, password_hash, phone, status, is_email_verified, role, provider, google_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.email, u.password_hash, u.phone, u.status, u.is_email_verified, u.role || 'user', u.provider || 'email', u.google_id || null, u.created_at]
    );
  }

  // 2. pages
  const pages = sqlite.prepare('SELECT * FROM pages ORDER BY id').all();
  console.log(`📦 pages: ${pages.length} รายการ`);
  for (const p of pages) {
    await pool.execute(
      `INSERT IGNORE INTO pages
        (id, user_id, slug, title, status, theme, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.user_id, p.slug, p.title, p.status, p.theme, p.content, p.created_at, p.updated_at]
    );
  }

  // 3. settings
  const settings = sqlite.prepare('SELECT key, value FROM settings').all();
  console.log(`📦 settings: ${settings.length} รายการ`);
  for (const s of settings) {
    await pool.execute(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [s.key, s.value]
    );
  }

  console.log('✅ ย้ายข้อมูลเสร็จสมบูรณ์!');
  sqlite.close();
  await pool.end();
})().catch((err) => {
  console.error('❌ ย้ายข้อมูลล้มเหลว:', err.message);
  process.exit(1);
});
