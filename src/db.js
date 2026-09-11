/**
 * db.js — ฐานข้อมูล MySQL (ใช้ mysql2)
 *
 * API เดียวกับเวอร์ชัน SQLite เดิม — แต่ฟังก์ชันทั้งหมดเป็น async (คืน Promise)
 * caller ต้อง await ทุกครั้ง
 */
'use strict';

const mysql = require('mysql2/promise');

const DATABASE_URL = process.env.DATABASE_URL || process.env.MYSQL_URL || '';

if (!DATABASE_URL) {
  console.error('⚠️ ไม่พบ DATABASE_URL — ตั้งค่า MySQL connection URL ใน environment');
}

const pool = mysql.createPool({
  uri: DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z', // เก็บ/อ่านเวลาเป็น UTC ให้ตรงกับ nowSql() ใน server.js
  enableKeepAlive: true, // ส่ง TCP keepalive — ป้องกัน Railway proxy ตัด connection ที่ idle ทิ้ง
  keepAliveInitialDelay: 0,
  connectTimeout: 10000,
});

// บังคับทุก connection ให้ใช้ UTC — ไม่งั้น CURRENT_TIMESTAMP (เช่น created_at)
// จะบันทึกเป็นเวลาท้องถิ่นของเครื่อง MySQL แล้วตีความผิดเพี้ยน (VPS ตั้งเวลาไทย +07)
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", (err) => {
    if (err) console.error('⚠️ ตั้ง time_zone ล้มเหลว:', err.message);
  });
});

// mysql2 pool ไม่ retry ให้อัตโนมัติ — ถ้า connection ถูกตัดกลางอากาศ (proxy หลุด/restart)
// คำสั่ง SELECT ที่เพิ่งส่งไปจะ error ทั้งที่ฐานข้อมูลพร้อมแล้ว ขอ retry 1 ครั้งเฉพาะคำสั่งอ่าน
// (คำสั่งเขียนไม่ retry เพื่อป้องกันการ insert ซ้ำ ถ้าคำสั่งแรกไปถึง DB แล้วแต่ connection หลุดตอนตอบกลับ)
const TRANSIENT_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_INCORRECT_PACKET_SEQUENCE',
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ER_SERVER_SHUTDOWN',
]);
const isTransient = (err) => !!(err && (TRANSIENT_CODES.has(err.code) || TRANSIENT_CODES.has(err.errno)));
const isReadQuery = (sql) => /^\s*(select|show|describe|explain)/i.test(String(sql));

const poolExecute = pool.execute.bind(pool);
pool.execute = async (sql, params) => {
  try {
    return await poolExecute(sql, params);
  } catch (err) {
    if (isReadQuery(sql) && isTransient(err)) {
      return await poolExecute(sql, params); // ลองใหม่ 1 ครั้ง (pool ทิ้ง connection ที่เสียไปแล้ว)
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Schema (รันตอน boot — ฝังคอลัมน์จาก migrations เดิมเข้าไปใน DDL แล้ว)
// ---------------------------------------------------------------------------
async function initSchema() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      email             VARCHAR(255) NOT NULL UNIQUE,
      password_hash     VARCHAR(255) NOT NULL,
      phone             VARCHAR(30)  NOT NULL,
      status            VARCHAR(10)  NOT NULL DEFAULT 'pending',
      is_email_verified TINYINT(1)   NOT NULL DEFAULT 0,
      role              VARCHAR(10)  NOT NULL DEFAULT 'user',
      provider          VARCHAR(10)  NOT NULL DEFAULT 'email',
      google_id         VARCHAR(255) NULL,
      created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      CHAR(64) PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      code_hash  CHAR(64) NOT NULL,
      phone      VARCHAR(30) NOT NULL,
      attempts   INT NOT NULL DEFAULT 0,
      used       TINYINT(1) NOT NULL DEFAULT 0,
      purpose    VARCHAR(20) NOT NULL DEFAULT 'signup',
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      used       TINYINT(1) NOT NULL DEFAULT 0,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_emailtoken_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      used       TINYINT(1) NOT NULL DEFAULT 0,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_pwreset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\`   VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // เพิ่มคอลัมน์ใหม่ให้ตารางที่สร้างไว้แล้ว (MySQL ไม่มี ADD COLUMN IF NOT EXISTS)
  await ensureColumn('otp_codes', 'code_visible', 'code_visible VARCHAR(10) NULL');
  await ensureColumn('otp_codes', 'note', 'note VARCHAR(255) NULL');
  await ensureColumn('otp_codes', 'replaced', 'replaced TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn('users', 'gift_expires_at', 'gift_expires_at DATETIME NULL');

  // ประวัติการมอบของขวัญร้านค้า (owner มอบสิทธิ์เจ้าของร้านชั่วคราว)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shop_gifts (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      granted_by BIGINT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_gift_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_gift_grantor FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── ร้านค้า / เมนู (ระบบร้านอาหาร) ──────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shops (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id     BIGINT NOT NULL UNIQUE,
      public_code VARCHAR(20) NOT NULL UNIQUE,
      name        VARCHAR(120) NOT NULL,
      phone       VARCHAR(30) NOT NULL DEFAULT '',
      line_url    VARCHAR(255) NOT NULL DEFAULT '',
      logo_url    VARCHAR(255) NOT NULL DEFAULT '',
      maps_url    VARCHAR(500) NOT NULL DEFAULT '',
      status      VARCHAR(10) NOT NULL DEFAULT 'active',
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_shops_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      parent_id  BIGINT NULL,
      name       VARCHAR(120) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_categories_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS menus (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id     BIGINT NOT NULL,
      category_id BIGINT NULL,
      name        VARCHAR(150) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      price       DECIMAL(10,2) NOT NULL DEFAULT 0,
      image_url   VARCHAR(255) NOT NULL DEFAULT '',
      available   TINYINT(1) NOT NULL DEFAULT 1,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_menus_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      CONSTRAINT fk_menus_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS option_groups (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      name       VARCHAR(120) NOT NULL,
      required   TINYINT(1) NOT NULL DEFAULT 0,
      multi      TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_optgrp_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS option_items (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      group_id    BIGINT NOT NULL,
      name        VARCHAR(120) NOT NULL,
      price_delta DECIMAL(10,2) NOT NULL DEFAULT 0,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_optitem_group FOREIGN KEY (group_id) REFERENCES option_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS menu_option_groups (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      menu_id    BIGINT NOT NULL,
      group_id   BIGINT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      UNIQUE KEY uq_menu_group (menu_id, group_id),
      CONSTRAINT fk_mog_menu FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE,
      CONSTRAINT fk_mog_group FOREIGN KEY (group_id) REFERENCES option_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shop_purchases (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      package    VARCHAR(30) NOT NULL DEFAULT 'basic',
      amount     DECIMAL(10,2) NOT NULL DEFAULT 0,
      status     VARCHAR(10) NOT NULL DEFAULT 'paid',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_purchase_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureColumn('shop_purchases', 'package_id', 'package_id BIGINT NULL');

  // ── แพ็กเกจ (owner ตั้งขาย — ผู้ใช้ซื้อแล้วเปิดร้านได้) ─────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS packages (
      id              BIGINT AUTO_INCREMENT PRIMARY KEY,
      name            VARCHAR(120) NOT NULL,
      duration_months INT NOT NULL DEFAULT 1,
      price           DECIMAL(10,2) NOT NULL DEFAULT 0,
      details_json    TEXT NULL,
      active          TINYINT(1) NOT NULL DEFAULT 1,
      sort_order      INT NOT NULL DEFAULT 0,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── การชำระเงินค่าแพ็กเกจ (ลูกค้าแจ้งโอน → owner ตรวจสอบยืนยัน) ────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS package_payments (
      id              BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id         BIGINT NOT NULL,
      package_id      BIGINT NULL,
      package_name    VARCHAR(120) NOT NULL,
      duration_months INT NOT NULL DEFAULT 1,
      amount          DECIMAL(10,2) NOT NULL DEFAULT 0,
      method          VARCHAR(20) NOT NULL DEFAULT 'promptpay',
      ref             VARCHAR(20) NOT NULL UNIQUE,
      status          VARCHAR(12) NOT NULL DEFAULT 'pending',
      notified        TINYINT(1) NOT NULL DEFAULT 0,
      note            VARCHAR(255) NOT NULL DEFAULT '',
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at    DATETIME NULL,
      confirmed_by    BIGINT NULL,
      CONSTRAINT fk_ppay_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_ppay_package FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE SET NULL,
      CONSTRAINT fk_ppay_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── โต๊ะ + ออเดอร์ (ระบบสั่งอาหาร) ─────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS \`tables\` (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id    BIGINT NOT NULL,
      code       VARCHAR(30) NOT NULL,
      token      CHAR(16) NOT NULL UNIQUE,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_tables_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      UNIQUE KEY uq_shop_table_code (shop_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id        BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_id   BIGINT NOT NULL,
      table_id  BIGINT NOT NULL,
      status    VARCHAR(10) NOT NULL DEFAULT 'open',
      total     DECIMAL(12,2) NOT NULL DEFAULT 0,
      opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME NULL,
      CONSTRAINT fk_orders_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      CONSTRAINT fk_orders_table FOREIGN KEY (table_id) REFERENCES \`tables\`(id) ON DELETE CASCADE,
      KEY idx_orders_open (shop_id, table_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS order_items (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_id     BIGINT NOT NULL,
      menu_id      BIGINT NULL,
      menu_name    VARCHAR(150) NOT NULL,
      unit_price   DECIMAL(10,2) NOT NULL DEFAULT 0,
      quantity     INT NOT NULL DEFAULT 1,
      options_json TEXT,
      line_total   DECIMAL(12,2) NOT NULL DEFAULT 0,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_orderitems_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // เลขที่บิล (รันต่อร้าน) — เพิ่มให้ตาราง orders ที่มีอยู่แล้ว
  await ensureColumn('orders', 'bill_no', 'bill_no INT NULL');
  // สถานะรายจานสำหรับครัว: pending (รอทำ) / cooking (กำลังทำ) / done (เสร็จแล้ว)
  await ensureColumn('order_items', 'status', "status VARCHAR(10) NOT NULL DEFAULT 'pending'");
  await ensureColumn('order_items', 'started_at', 'started_at DATETIME NULL');
  await ensureColumn('order_items', 'done_at', 'done_at DATETIME NULL');
  await ensureColumn('order_items', 'cancel_reason', 'cancel_reason VARCHAR(255) NULL');
  await ensureColumn('order_items', 'options_ids_json', 'options_ids_json TEXT NULL');
}

// เพิ่มคอลัมน์ถ้ายังไม่มี (ใช้กับตารางที่สร้างจาก schema เก่า)
async function ensureColumn(table, column, ddl) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (Number(rows[0].c) === 0) {
    await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  }
}

// ---------------------------------------------------------------------------
// Settings — cache ในหน่วยความจำ (devMode/SMTP/SMS config ยังเป็น sync ได้)
// ---------------------------------------------------------------------------
const settingsCache = new Map();

async function loadSettingsCache() {
  settingsCache.clear();
  const [rows] = await pool.execute('SELECT `key`, value FROM settings');
  for (const r of rows) settingsCache.set(r.key, r.value);
}

async function initDb() {
  await initSchema();
  await loadSettingsCache();
  // ลบตาราง pages ของฟีเจอร์ SalePage เดิม (ทำครั้งเดียว) — ตั้ง flag กันไม่ให้ลบซ้ำในอนาคต
  if (getSetting('legacy_pages_dropped') !== 'true') {
    await pool.execute('DROP TABLE IF EXISTS pages');
    await setSetting('legacy_pages_dropped', 'true');
    console.log('🧹 ลบตาราง pages (ฟีเจอร์ SalePage เดิม) เรียบร้อย');
  }
  // ยกระดับแอดมินคนแรกเป็นเจ้าของระบบ (ครั้งเดียว) — สำหรับฐานข้อมูลเดิมที่ยังไม่มีบทบาท owner
  if (getSetting('legacy_owner_promoted') !== 'true') {
    const [owners] = await pool.execute("SELECT id FROM users WHERE role = 'owner' LIMIT 1");
    if (!owners[0]) {
      const [admins] = await pool.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
      if (admins[0]) {
        await pool.execute("UPDATE users SET role = 'owner' WHERE id = ?", [admins[0].id]);
        console.log('👑 ยกระดับแอดมินคนแรกเป็นเจ้าของระบบ (owner) เรียบร้อย');
      }
    }
    await setSetting('legacy_owner_promoted', 'true');
  }
}

function getSetting(key) {
  return settingsCache.has(key) ? settingsCache.get(key) : null;
}

async function setSetting(key, value) {
  const v = String(value);
  await pool.execute(
    'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, v]
  );
  settingsCache.set(key, v);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
async function findUserByEmail(email) {
  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

async function findUserById(id) {
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

async function createUser({ email, passwordHash, phone }) {
  const [result] = await pool.execute(
    'INSERT INTO users (email, password_hash, phone) VALUES (?, ?, ?)',
    [email, passwordHash, phone]
  );
  return findUserById(result.insertId);
}

async function setUserStatus(id, status) {
  await pool.execute('UPDATE users SET status = ? WHERE id = ?', [status, id]);
}

async function createGooglePendingUser({ email, googleId }) {
  const [result] = await pool.execute(
    `INSERT INTO users (email, password_hash, phone, status, is_email_verified, provider, google_id)
     VALUES (?, '', '', 'pending', 1, 'google', ?)`,
    [email, googleId || null]
  );
  return findUserById(result.insertId);
}

async function linkGoogle(id, googleId) {
  await pool.execute(
    "UPDATE users SET provider = CASE WHEN provider = 'email' THEN 'google' ELSE provider END, google_id = ? WHERE id = ?",
    [googleId || null, id]
  );
}

async function completeGoogleSetup(id, { passwordHash, phone }) {
  await pool.execute(
    "UPDATE users SET password_hash = ?, phone = ?, status = 'active', is_email_verified = 1 WHERE id = ?",
    [passwordHash, phone, id]
  );
  return findUserById(id);
}

async function updatePendingUser(id, { phone, passwordHash }) {
  await pool.execute('UPDATE users SET phone = ?, password_hash = ? WHERE id = ?', [phone, passwordHash, id]);
  return findUserById(id);
}

async function setEmailVerified(id, verified = 1) {
  await pool.execute('UPDATE users SET is_email_verified = ? WHERE id = ?', [verified, id]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function createSession({ token, userId, expiresAt }) {
  await pool.execute('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expiresAt]);
}

async function findSession(token) {
  const [rows] = await pool.execute('SELECT * FROM sessions WHERE token = ?', [token]);
  return rows[0] || null;
}

async function deleteSession(token) {
  await pool.execute('DELETE FROM sessions WHERE token = ?', [token]);
}

async function deleteExpiredSessions() {
  await pool.execute('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP');
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------
async function createOtp({ userId, codeHash, contact, purpose = 'signup', expiresAt, codeVisible = null }) {
  // รหัสเก่าที่ยังไม่ใช้ → ตัดสิทธิ์ทันที (เก็บประวัติไว้ให้แอดมินดู — ไม่ลบ)
  // หมายเหตุ (ผลส่ง SMS) ของรหัสเก่าเก็บไว้ตามเดิม ไม่ทับ — สถานะ "ถูกแทนที่" ดูจากคอลัมน์สถานะ
  await pool.execute(
    `UPDATE otp_codes SET replaced = 1
        WHERE user_id = ? AND purpose = ? AND used = 0 AND replaced = 0`,
    [userId, purpose]
  );
  const [result] = await pool.execute(
    'INSERT INTO otp_codes (user_id, code_hash, phone, purpose, expires_at, code_visible) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, codeHash, contact, purpose, expiresAt, codeVisible]
  );
  return Number(result.insertId);
}

// บันทึกผลการส่ง (SMS/อีเมล) ลงรายการ OTP
async function setOtpNote(id, note) {
  await pool.execute('UPDATE otp_codes SET note = ? WHERE id = ?', [note, id]);
}

async function findLatestOtp(userId, purpose = 'signup') {
  const [rows] = await pool.execute(
    `SELECT * FROM otp_codes 
      WHERE user_id = ? AND purpose = ? AND used = 0 AND replaced = 0 
      ORDER BY id DESC LIMIT 1`,
    [userId, purpose]
  );
  return rows[0] || null;
}

async function markOtpUsed(id) {
  await pool.execute('UPDATE otp_codes SET used = 1 WHERE id = ?', [id]);
}

// เบอร์/อีเมลปลายทางจากรายการ OTP ล่าสุดของคนนี้ (ใช้กรณีบัญชียังไม่ได้บันทึกเบอร์)
async function findLatestOtpContact(userId, purpose = 'signup') {
  const [rows] = await pool.execute(
    `SELECT phone FROM otp_codes 
      WHERE user_id = ? AND purpose = ? AND phone <> '' 
      ORDER BY id DESC LIMIT 1`,
    [userId, purpose]
  );
  return rows[0] ? rows[0].phone : null;
}

async function incrementOtpAttempts(id) {
  await pool.execute('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Email verification tokens
// ---------------------------------------------------------------------------
async function createEmailToken({ userId, tokenHash, expiresAt }) {
  const [result] = await pool.execute(
    'INSERT INTO email_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
  return Number(result.insertId);
}

async function findEmailTokenByHash(tokenHash) {
  const [rows] = await pool.execute(
    `SELECT et.*, u.email
       FROM email_tokens et
       JOIN users u ON u.id = et.user_id
      WHERE et.token_hash = ?
      ORDER BY et.id DESC LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function markEmailTokenUsed(id) {
  await pool.execute('UPDATE email_tokens SET used = 1 WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------
async function updateUserPassword(id, passwordHash) {
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
}

async function createPasswordReset({ userId, tokenHash, expiresAt }) {
  await pool.execute('DELETE FROM password_resets WHERE user_id = ?', [userId]);
  const [result] = await pool.execute(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
  return Number(result.insertId);
}

async function findPasswordResetByHash(tokenHash) {
  const [rows] = await pool.execute(
    `SELECT pr.*, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ?
      ORDER BY pr.id DESC LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function markPasswordResetUsed(id) {
  await pool.execute('UPDATE password_resets SET used = 1 WHERE id = ?', [id]);
}

async function deleteUserSessions(userId) {
  await pool.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

async function deleteOtherSessions(userId, currentTokenHash) {
  await pool.execute('DELETE FROM sessions WHERE user_id = ? AND token != ?', [userId, currentTokenHash]);
}

// ---------------------------------------------------------------------------
// Owner (เจ้าของระบบ — บทบาทสูงสุด)
// ---------------------------------------------------------------------------
async function findOwner() {
  const [rows] = await pool.execute("SELECT * FROM users WHERE role = 'owner' LIMIT 1");
  return rows[0] || null;
}

async function createOwnerUser({ email, passwordHash }) {
  const [result] = await pool.execute(
    "INSERT INTO users (email, password_hash, phone, status, role) VALUES (?, ?, '0000000000', 'active', 'owner')",
    [email, passwordHash]
  );
  return findUserById(result.insertId);
}

// ---------------------------------------------------------------------------
// Admin — รายงาน OTP
// ---------------------------------------------------------------------------
async function listOtpLogs(limit = 50) {
  // MySQL ไม่รองรับ placeholder ใน LIMIT — ต้อง interpolate (limit เป็นตัวเลขแล้ว)
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const [rows] = await pool.execute(
    `SELECT o.id, o.user_id, o.phone AS contact, o.purpose,
            o.attempts, o.used, o.replaced, o.code_visible, o.note,
            o.expires_at, o.created_at, u.email
       FROM otp_codes o
       JOIN users u ON u.id = o.user_id
      ORDER BY o.id DESC LIMIT ${safeLimit}`
  );
  return rows;
}

async function countStats() {
  const [users] = await pool.execute('SELECT COUNT(*) AS c FROM users');
  const [activeUsers] = await pool.execute("SELECT COUNT(*) AS c FROM users WHERE status = 'active'");
  const [otpTotal] = await pool.execute('SELECT COUNT(*) AS c FROM otp_codes');
  const [otpValid] = await pool.execute(
    'SELECT COUNT(*) AS c FROM otp_codes WHERE used = 0 AND replaced = 0 AND expires_at > CURRENT_TIMESTAMP'
  );
  const [otpUsed] = await pool.execute('SELECT COUNT(*) AS c FROM otp_codes WHERE used = 1');
  const [otpExpired] = await pool.execute(
    'SELECT COUNT(*) AS c FROM otp_codes WHERE used = 0 AND replaced = 0 AND expires_at <= CURRENT_TIMESTAMP'
  );
  return {
    users: users[0].c,
    activeUsers: activeUsers[0].c,
    otpTotal: otpTotal[0].c,
    otpValid: otpValid[0].c,
    otpUsed: otpUsed[0].c,
    otpExpired: otpExpired[0].c,
  };
}

// ---------------------------------------------------------------------------
// Admin — จัดการผู้ใช้
// ---------------------------------------------------------------------------
async function listUsers({ search = '', limit = 100 } = {}) {
  const like = `%${search}%`;
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const [rows] = await pool.execute(
    `SELECT id, email, phone, status, role, provider, is_email_verified, google_id, gift_expires_at, created_at
       FROM users
      WHERE email LIKE ? OR phone LIKE ?
      ORDER BY id DESC LIMIT ${safeLimit}`,
    [like, like]
  );
  return rows;
}

async function countUsers(search = '') {
  if (!search) {
    const [rows] = await pool.execute('SELECT COUNT(*) AS c FROM users');
    return rows[0].c;
  }
  const like = `%${search}%`;
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS c FROM users WHERE email LIKE ? OR phone LIKE ?',
    [like, like]
  );
  return rows[0].c;
}

async function countOwners() {
  const [rows] = await pool.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'owner'");
  return rows[0].c;
}

async function updateUserByAdmin(id, fields) {
  const sets = [];
  const params = [];
  if (fields.email !== undefined) { sets.push('email = ?'); params.push(fields.email); }
  if (fields.phone !== undefined) { sets.push('phone = ?'); params.push(fields.phone); }
  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.role !== undefined) { sets.push('role = ?'); params.push(fields.role); }
  if (fields.isEmailVerified !== undefined) { sets.push('is_email_verified = ?'); params.push(fields.isEmailVerified ? 1 : 0); }
  if (fields.passwordHash !== undefined) { sets.push('password_hash = ?'); params.push(fields.passwordHash); }
  if (sets.length) {
    await pool.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }
  return findUserById(id);
}

async function deleteUser(id) {
  await pool.execute('DELETE FROM users WHERE id = ?', [id]);
}

async function setUserRole(id, role) {
  await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, id]);
}

// ---------------------------------------------------------------------------
// ของขวัญร้านค้า (owner มอบสิทธิ์เจ้าของร้านชั่วคราว)
// ---------------------------------------------------------------------------
async function setShopGift({ userId, grantedBy = null, expiresAt }) {
  await pool.execute("UPDATE users SET role = 'shop', gift_expires_at = ? WHERE id = ?", [expiresAt, userId]);
  await pool.execute('INSERT INTO shop_gifts (user_id, granted_by, expires_at) VALUES (?, ?, ?)', [userId, grantedBy, expiresAt]);
}

/** กำหนดวันหมดอายุการใช้งานร้านให้ผู้ใช้ (ใช้ทั้งของขวัญจาก owner และการซื้อแพ็กเกจ) */
async function setUserShopExpiry(userId, expiresAt) {
  await pool.execute('UPDATE users SET gift_expires_at = ? WHERE id = ?', [expiresAt, userId]);
}

/** ถอนสิทธิ์ของขวัญของผู้ใช้คนหนึ่ง (คืนบทบาทเป็น user) */
async function expireShopGift(userId) {
  await pool.execute("UPDATE users SET role = 'user', gift_expires_at = NULL WHERE id = ? AND role = 'shop'", [userId]);
}

/** ถอนสิทธิ์ของขวัญที่หมดอายุทั้งหมด — คืนจำนวนที่ถูกถอน */
async function clearExpiredGifts() {
  const [result] = await pool.execute(
    "UPDATE users SET role = 'user', gift_expires_at = NULL WHERE role = 'shop' AND gift_expires_at IS NOT NULL AND gift_expires_at <= UTC_TIMESTAMP()"
  );
  return result.affectedRows || 0;
}

/** หาร้านสาธารณะที่ยังใช้งานได้ (เจ้าของยังเป็น shop และของขวัญไม่หมดอายุ) */
async function findPublicShopByCode(code) {
  const [rows] = await pool.execute(
    `SELECT s.* FROM shops s
       JOIN users u ON u.id = s.user_id
      WHERE s.public_code = ? AND s.status = 'active' AND u.role = 'shop'
        AND (u.gift_expires_at IS NULL OR u.gift_expires_at > UTC_TIMESTAMP())
      LIMIT 1`,
    [code]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Shops (ร้านค้า) — 1 บัญชี = 1 ร้าน
// ---------------------------------------------------------------------------
async function findShopByUserId(userId) {
  const [rows] = await pool.execute('SELECT * FROM shops WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

async function findShopByCode(code) {
  const [rows] = await pool.execute('SELECT * FROM shops WHERE public_code = ? LIMIT 1', [code]);
  return rows[0] || null;
}

async function createShop({ userId, publicCode, name, phone = '', lineUrl = '', logoUrl = '', mapsUrl = '' }) {
  const [result] = await pool.execute(
    'INSERT INTO shops (user_id, public_code, name, phone, line_url, logo_url, maps_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, publicCode, name, phone, lineUrl, logoUrl, mapsUrl]
  );
  const [rows] = await pool.execute('SELECT * FROM shops WHERE id = ?', [result.insertId]);
  return rows[0] || null;
}

async function updateShop(id, fields) {
  const map = { name: 'name', phone: 'phone', lineUrl: 'line_url', logoUrl: 'logo_url', mapsUrl: 'maps_url' };
  const sets = [];
  const params = [];
  for (const key of Object.keys(map)) {
    if (fields[key] !== undefined) { sets.push(`${map[key]} = ?`); params.push(fields[key]); }
  }
  if (!sets.length) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  await pool.execute(`UPDATE shops SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

// ---------------------------------------------------------------------------
// Categories (หมวดหมู่/หมวดหมู่ย่อย) — parent_id NULL = หมวดหลัก
// ---------------------------------------------------------------------------
async function listCategories(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM categories WHERE shop_id = ? ORDER BY sort_order ASC, id ASC',
    [shopId]
  );
  return rows;
}

async function findCategoryById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM categories WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function createCategory({ shopId, parentId = null, name, sortOrder = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO categories (shop_id, parent_id, name, sort_order) VALUES (?, ?, ?, ?)',
    [shopId, parentId, name, sortOrder]
  );
  return Number(result.insertId);
}

async function updateCategory(id, shopId, fields) {
  const sets = [];
  const params = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.parentId !== undefined) { sets.push('parent_id = ?'); params.push(fields.parentId); }
  if (fields.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(fields.sortOrder); }
  if (sets.length) await pool.execute(`UPDATE categories SET ${sets.join(', ')} WHERE id = ? AND shop_id = ?`, [...params, id, shopId]);
}

async function deleteCategory(id, shopId) {
  await pool.execute('DELETE FROM categories WHERE id = ? AND shop_id = ?', [id, shopId]);
}

// ---------------------------------------------------------------------------
// Menus (เมนูสินค้า)
// ---------------------------------------------------------------------------
async function listMenus(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM menus WHERE shop_id = ? ORDER BY sort_order ASC, id ASC',
    [shopId]
  );
  return rows;
}

async function findMenuById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM menus WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function createMenu({ shopId, categoryId = null, name, description = '', price = 0, imageUrl = '', sortOrder = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO menus (shop_id, category_id, name, description, price, image_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [shopId, categoryId, name, description, price, imageUrl, sortOrder]
  );
  return Number(result.insertId);
}

async function updateMenu(id, shopId, fields) {
  const map = { categoryId: 'category_id', name: 'name', description: 'description', price: 'price', imageUrl: 'image_url', available: 'available', sortOrder: 'sort_order' };
  const sets = [];
  const params = [];
  for (const key of Object.keys(map)) {
    if (fields[key] !== undefined) { sets.push(`${map[key]} = ?`); params.push(fields[key]); }
  }
  if (!sets.length) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  await pool.execute(`UPDATE menus SET ${sets.join(', ')} WHERE id = ? AND shop_id = ?`, [...params, id, shopId]);
}

async function deleteMenu(id, shopId) {
  await pool.execute('DELETE FROM menus WHERE id = ? AND shop_id = ?', [id, shopId]);
}

// ---------------------------------------------------------------------------
// Option groups / items (ตัวเลือกในเมนู เช่น ระดับความเผ็ด, ทานที่ร้าน/ห่อกลับ)
// ---------------------------------------------------------------------------
async function listOptionGroups(shopId) {
  const [rows] = await pool.execute(
    'SELECT * FROM option_groups WHERE shop_id = ? ORDER BY sort_order ASC, id ASC',
    [shopId]
  );
  return rows;
}

async function findOptionGroupById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM option_groups WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function createOptionGroup({ shopId, name, required = 0, multi = 0, sortOrder = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO option_groups (shop_id, name, required, multi, sort_order) VALUES (?, ?, ?, ?, ?)',
    [shopId, name, required ? 1 : 0, multi ? 1 : 0, sortOrder]
  );
  return Number(result.insertId);
}

async function updateOptionGroup(id, shopId, fields) {
  const sets = [];
  const params = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.required !== undefined) { sets.push('required = ?'); params.push(fields.required ? 1 : 0); }
  if (fields.multi !== undefined) { sets.push('multi = ?'); params.push(fields.multi ? 1 : 0); }
  if (fields.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(fields.sortOrder); }
  if (sets.length) await pool.execute(`UPDATE option_groups SET ${sets.join(', ')} WHERE id = ? AND shop_id = ?`, [...params, id, shopId]);
}

async function deleteOptionGroup(id, shopId) {
  await pool.execute('DELETE FROM option_groups WHERE id = ? AND shop_id = ?', [id, shopId]);
}

async function listOptionItems(shopId) {
  const [rows] = await pool.execute(
    `SELECT oi.* FROM option_items oi
       JOIN option_groups g ON g.id = oi.group_id
      WHERE g.shop_id = ?
      ORDER BY oi.sort_order ASC, oi.id ASC`,
    [shopId]
  );
  return rows;
}

async function createOptionItem({ groupId, name, priceDelta = 0, sortOrder = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO option_items (group_id, name, price_delta, sort_order) VALUES (?, ?, ?, ?)',
    [groupId, name, priceDelta, sortOrder]
  );
  return Number(result.insertId);
}

async function findOptionItemOwned(id, shopId) {
  const [rows] = await pool.execute(
    `SELECT oi.* FROM option_items oi
       JOIN option_groups g ON g.id = oi.group_id
      WHERE oi.id = ? AND g.shop_id = ?`,
    [id, shopId]
  );
  return rows[0] || null;
}

async function updateOptionItem(id, shopId, fields) {
  const sets = [];
  const params = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.priceDelta !== undefined) { sets.push('price_delta = ?'); params.push(fields.priceDelta); }
  if (fields.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(fields.sortOrder); }
  if (!sets.length) return;
  await pool.execute(
    `UPDATE option_items oi JOIN option_groups g ON g.id = oi.group_id
        SET ${sets.join(', ')} WHERE oi.id = ? AND g.shop_id = ?`,
    [...params, id, shopId]
  );
}

async function deleteOptionItem(id, shopId) {
  await pool.execute(
    `DELETE oi FROM option_items oi JOIN option_groups g ON g.id = oi.group_id
      WHERE oi.id = ? AND g.shop_id = ?`,
    [id, shopId]
  );
}

// ผูกกลุ่มตัวเลือกกับเมนู
async function listMenuOptionGroups(shopId) {
  const [rows] = await pool.execute(
    `SELECT mog.menu_id, mog.group_id, mog.sort_order FROM menu_option_groups mog
       JOIN menus m ON m.id = mog.menu_id
      WHERE m.shop_id = ?`,
    [shopId]
  );
  return rows;
}

async function setMenuOptionGroups(menuId, groupIds) {
  await pool.execute('DELETE FROM menu_option_groups WHERE menu_id = ?', [menuId]);
  for (let i = 0; i < groupIds.length; i++) {
    await pool.execute(
      'INSERT INTO menu_option_groups (menu_id, group_id, sort_order) VALUES (?, ?, ?)',
      [menuId, groupIds[i], i]
    );
  }
}

// ---------------------------------------------------------------------------
// Shop purchases (บันทึกการซื้อแพ็กเกจ — จำลอง)
// ---------------------------------------------------------------------------
async function createShopPurchase({ userId, packageName = 'basic', packageId = null, amount = 0, status = 'paid' }) {
  const [result] = await pool.execute(
    'INSERT INTO shop_purchases (user_id, package, package_id, amount, status) VALUES (?, ?, ?, ?, ?)',
    [userId, packageName, packageId, amount, status]
  );
  return Number(result.insertId);
}

async function findLatestShopPurchase(userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM shop_purchases WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Packages (แพ็กเกจร้านค้า) — owner สร้าง/แก้ไข แล้วผู้ใช้ทั่วไปซื้อเพื่อเปิดร้าน
// ---------------------------------------------------------------------------
function mapPackage(row) {
  if (!row) return null;
  let details = [];
  try { details = row.details_json ? JSON.parse(row.details_json) : []; } catch (err) { details = []; }
  if (!Array.isArray(details)) details = [];
  return { ...row, details };
}

async function listPackages() {
  const [rows] = await pool.execute('SELECT * FROM packages ORDER BY sort_order ASC, id ASC');
  return rows.map(mapPackage);
}

/** แพ็กเกจที่เปิดขาย (ใช้แสดงในหน้าซื้อแพ็กเกจของผู้ใช้) */
async function listActivePackages() {
  const [rows] = await pool.execute('SELECT * FROM packages WHERE active = 1 ORDER BY sort_order ASC, id ASC');
  return rows.map(mapPackage);
}

async function findPackageById(id) {
  const [rows] = await pool.execute('SELECT * FROM packages WHERE id = ?', [id]);
  return mapPackage(rows[0]);
}

async function createPackage({ name, durationMonths = 1, price = 0, details = [], active = true, sortOrder = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO packages (name, duration_months, price, details_json, active, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [name, durationMonths, price, JSON.stringify(details), active ? 1 : 0, sortOrder]
  );
  return Number(result.insertId);
}

async function updatePackage(id, { name, durationMonths, price, details, active, sortOrder }) {
  await pool.execute(
    `UPDATE packages SET name = ?, duration_months = ?, price = ?, details_json = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [name, durationMonths, price, JSON.stringify(details), active ? 1 : 0, sortOrder, id]
  );
}

async function deletePackage(id) {
  await pool.execute('DELETE FROM packages WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Package payments (การชำระเงินค่าแพ็กเกจ)
// ---------------------------------------------------------------------------
async function createPackagePayment({ userId, packageId, packageName, durationMonths = 1, amount = 0, method = 'promptpay', ref, note = '' }) {
  const [result] = await pool.execute(
    `INSERT INTO package_payments (user_id, package_id, package_name, duration_months, amount, method, ref, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, packageId, packageName, durationMonths, amount, method, ref, note]
  );
  return Number(result.insertId);
}

async function findPackagePaymentById(id) {
  const [rows] = await pool.execute('SELECT * FROM package_payments WHERE id = ?', [id]);
  return rows[0] || null;
}

/** รายการที่ยังรอตรวจสอบของผู้ใช้คนหนึ่ง (กันสร้างซ้ำ) */
async function findPendingPackagePaymentByUser(userId) {
  const [rows] = await pool.execute(
    "SELECT * FROM package_payments WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return rows[0] || null;
}

async function listPackagePayments({ status = null, userId = null, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  // LIMIT ต้องใส่เป็นตัวเลขในสตริง — MySQL ไม่รับค่า ? ใน prepared statement (ER_WRONG_ARGUMENTS)
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 500);
  const [rows] = await pool.execute(
    `SELECT * FROM package_payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${n}`,
    args
  );
  return rows;
}

async function markPackagePaymentNotified(id) {
  await pool.execute('UPDATE package_payments SET notified = 1 WHERE id = ? AND status = \'pending\'', [id]);
}

async function setPackagePaymentStatus(id, status, { confirmedBy = null, note = null } = {}) {
  const sets = ['status = ?'];
  const args = [status];
  if (confirmedBy) { sets.push('confirmed_by = ?'); args.push(confirmedBy); }
  if (confirmedBy) sets.push('confirmed_at = CURRENT_TIMESTAMP');
  if (note !== null) { sets.push('note = ?'); args.push(note); }
  args.push(id);
  await pool.execute(`UPDATE package_payments SET ${sets.join(', ')} WHERE id = ?`, args);
}

// ---------------------------------------------------------------------------
// Tables (โต๊ะ) + Orders (บิล/ออเดอร์) — ระบบสั่งอาหาร
// ---------------------------------------------------------------------------
async function listTables(shopId) {
  const [rows] = await pool.execute('SELECT * FROM `tables` WHERE shop_id = ? ORDER BY code ASC', [shopId]);
  return rows;
}

async function findTableById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM `tables` WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function findTableByCode(shopId, code) {
  const [rows] = await pool.execute('SELECT * FROM `tables` WHERE shop_id = ? AND code = ?', [shopId, code]);
  return rows[0] || null;
}

async function findTableByToken(token) {
  const [rows] = await pool.execute('SELECT * FROM `tables` WHERE token = ? LIMIT 1', [token]);
  return rows[0] || null;
}

/** โต๊ะที่สั่งอาหารได้ (เจ้าของร้านยังเป็น shop และของขวัญไม่หมดอายุ) + ข้อมูลร้าน */
async function findOrderableTableByToken(token) {
  const [rows] = await pool.execute(
    `SELECT t.id, t.shop_id, t.code, t.token,
            s.name AS shop_name, s.logo_url, s.phone, s.line_url, s.maps_url
       FROM \`tables\` t
       JOIN shops s ON s.id = t.shop_id
       JOIN users u ON u.id = s.user_id
      WHERE t.token = ? AND s.status = 'active' AND u.role = 'shop'
        AND (u.gift_expires_at IS NULL OR u.gift_expires_at > UTC_TIMESTAMP())
      LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function createTable({ shopId, code, token }) {
  const [result] = await pool.execute('INSERT INTO `tables` (shop_id, code, token) VALUES (?, ?, ?)', [shopId, code, token]);
  return Number(result.insertId);
}

async function updateTableCode(id, shopId, code) {
  await pool.execute('UPDATE `tables` SET code = ? WHERE id = ? AND shop_id = ?', [code, id, shopId]);
}

async function deleteTable(id, shopId) {
  await pool.execute('DELETE FROM `tables` WHERE id = ? AND shop_id = ?', [id, shopId]);
}

async function findOpenOrder(shopId, tableId) {
  const [rows] = await pool.execute(
    "SELECT * FROM orders WHERE shop_id = ? AND table_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    [shopId, tableId]
  );
  return rows[0] || null;
}

async function findOrderById(id, shopId) {
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ? AND shop_id = ?', [id, shopId]);
  return rows[0] || null;
}

async function createOrder({ shopId, tableId }) {
  // เลขที่บิลรันต่อร้าน (เริ่มที่ 1)
  const [rows] = await pool.execute('SELECT COALESCE(MAX(bill_no),0)+1 AS n FROM orders WHERE shop_id = ?', [shopId]);
  const billNo = Number(rows[0].n) || 1;
  const [result] = await pool.execute(
    "INSERT INTO orders (shop_id, table_id, status, bill_no) VALUES (?, ?, 'open', ?)",
    [shopId, tableId, billNo]
  );
  return Number(result.insertId);
}

async function listOrderItems(orderId) {
  const [rows] = await pool.execute('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [orderId]);
  return rows;
}

async function recalcOrderTotal(orderId) {
  await pool.execute(
    "UPDATE orders SET total = (SELECT COALESCE(SUM(line_total),0) FROM order_items WHERE order_id = ? AND status <> 'cancelled') WHERE id = ?",
    [orderId, orderId]
  );
}

async function addOrderItems(orderId, items) {
  for (const it of items) {
    await pool.execute(
      'INSERT INTO order_items (order_id, menu_id, menu_name, unit_price, quantity, options_json, options_ids_json, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [orderId, it.menuId || null, it.menuName, it.unitPrice, it.quantity, it.optionsJson || null, it.optionsIdsJson || null, it.lineTotal]
    );
  }
  await recalcOrderTotal(orderId);
}

/** รายการอาหารของบิลที่ยังเปิดอยู่ทั้งหมด (สำหรับหน้าครัว) — ไม่รวมรายการที่ถูกยกเลิก */
async function listKitchenItems(shopId) {
  const [rows] = await pool.execute(
    `SELECT oi.id, oi.order_id, oi.menu_id, oi.menu_name, oi.quantity, oi.options_json, oi.status,
            oi.created_at, oi.started_at, oi.done_at, o.bill_no, t.code AS table_code,
            m.image_url
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN \`tables\` t ON t.id = o.table_id
       LEFT JOIN menus m ON m.id = oi.menu_id
      WHERE o.shop_id = ? AND o.status = 'open' AND oi.status <> 'cancelled'
      ORDER BY FIELD(oi.status, 'pending', 'cooking', 'done'), oi.id ASC`,
    [shopId]
  );
  return rows;
}

async function findOrderItemOwned(id, shopId) {
  const [rows] = await pool.execute(
    `SELECT oi.*, o.status AS order_status FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ? AND o.shop_id = ?`,
    [id, shopId]
  );
  return rows[0] || null;
}

/** เปลี่ยนสถานะรายจาน (เฉพาะบิลที่ยังเปิดอยู่) */
async function setOrderItemStatus(id, shopId, status) {
  const sets = ['oi.status = ?'];
  const params = [status];
  if (status === 'cooking') sets.push('oi.started_at = COALESCE(oi.started_at, UTC_TIMESTAMP())');
  if (status === 'done') sets.push('oi.done_at = COALESCE(oi.done_at, UTC_TIMESTAMP())');
  await pool.execute(
    `UPDATE order_items oi JOIN orders o ON o.id = oi.order_id
        SET ${sets.join(', ')}
      WHERE oi.id = ? AND o.shop_id = ? AND o.status = 'open'`,
    [...params, id, shopId]
  );
}

/** ยกเลิกรายการ (ไม่ลบ แต่ทำเครื่องหมาย cancelled + เก็บสาเหตุ) แล้วคิดยอดใหม่ */
async function cancelOrderItem(id, orderId, reason) {
  await pool.execute(
    "UPDATE order_items SET status = 'cancelled', cancel_reason = ? WHERE id = ? AND order_id = ?",
    [reason ? String(reason).slice(0, 255) : null, id, orderId]
  );
  await recalcOrderTotal(orderId);
}

/** ลบรายการออกจากบิลจริง ๆ (ใช้ตอนแคชเชียร์ลบ) แล้วคิดยอดใหม่ */
async function deleteOrderItem(id, orderId) {
  await pool.execute('DELETE FROM order_items WHERE id = ? AND order_id = ?', [id, orderId]);
  await recalcOrderTotal(orderId);
}

async function closeOrder(orderId) {
  await pool.execute("UPDATE orders SET status = 'closed', closed_at = UTC_TIMESTAMP() WHERE id = ?", [orderId]);
}

async function listOpenOrders(shopId) {
  const [rows] = await pool.execute(
    `SELECT o.id, o.table_id, o.total, o.opened_at, o.bill_no, t.code AS table_code,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status <> 'cancelled') AS item_count
       FROM orders o JOIN \`tables\` t ON t.id = o.table_id
      WHERE o.shop_id = ? AND o.status = 'open'
      ORDER BY t.code ASC`,
    [shopId]
  );
  return rows;
}

// ประวัติบิลที่ปิดแล้ว (ดูย้อนหลัง) — กรองตามโต๊ะได้
async function listClosedOrders(shopId, { tableId = null, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  let sql = `SELECT o.id, o.table_id, o.bill_no, o.total, o.opened_at, o.closed_at, t.code AS table_code,
                    (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status <> 'cancelled') AS item_count
               FROM orders o JOIN \`tables\` t ON t.id = o.table_id
              WHERE o.shop_id = ? AND o.status = 'closed'`;
  const params = [shopId];
  if (tableId) { sql += ' AND o.table_id = ?'; params.push(tableId); }
  sql += ` ORDER BY o.closed_at DESC, o.id DESC LIMIT ${safeLimit}`;
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// รายการของหลายบิลพร้อมกัน (สำหรับหน้าประวัติ)
async function listItemsForOrders(orderIds) {
  if (!Array.isArray(orderIds) || !orderIds.length) return [];
  const ph = orderIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT * FROM order_items WHERE order_id IN (${ph}) ORDER BY id ASC`,
    orderIds.map(Number)
  );
  return rows;
}

module.exports = {
  initDb,
  getSetting,
  setSetting,
  findUserByEmail,
  findUserById,
  createUser,
  setUserStatus,
  updatePendingUser,
  createGooglePendingUser,
  linkGoogle,
  completeGoogleSetup,
  setEmailVerified,
  createSession,
  findSession,
  deleteSession,
  deleteExpiredSessions,
  createOtp,
  setOtpNote,
  findLatestOtp,
  findLatestOtpContact,
  markOtpUsed,
  incrementOtpAttempts,
  createEmailToken,
  findEmailTokenByHash,
  markEmailTokenUsed,
  updateUserPassword,
  createPasswordReset,
  findPasswordResetByHash,
  markPasswordResetUsed,
  deleteUserSessions,
  deleteOtherSessions,
  findOwner,
  createOwnerUser,
  listOtpLogs,
  countStats,
  listUsers,
  countUsers,
  countOwners,
  updateUserByAdmin,
  deleteUser,
  setUserRole,
  setShopGift,
  setUserShopExpiry,
  expireShopGift,
  clearExpiredGifts,
  findPublicShopByCode,
  findShopByUserId,
  findShopByCode,
  createShop,
  updateShop,
  listCategories,
  findCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  listMenus,
  findMenuById,
  createMenu,
  updateMenu,
  deleteMenu,
  listOptionGroups,
  findOptionGroupById,
  createOptionGroup,
  updateOptionGroup,
  deleteOptionGroup,
  listOptionItems,
  createOptionItem,
  findOptionItemOwned,
  updateOptionItem,
  deleteOptionItem,
  listMenuOptionGroups,
  setMenuOptionGroups,
  createShopPurchase,
  findLatestShopPurchase,
  listPackages,
  listActivePackages,
  findPackageById,
  createPackage,
  updatePackage,
  deletePackage,
  createPackagePayment,
  findPackagePaymentById,
  findPendingPackagePaymentByUser,
  listPackagePayments,
  markPackagePaymentNotified,
  setPackagePaymentStatus,
  listTables,
  findTableById,
  findTableByCode,
  findTableByToken,
  findOrderableTableByToken,
  createTable,
  updateTableCode,
  deleteTable,
  findOpenOrder,
  findOrderById,
  createOrder,
  listOrderItems,
  addOrderItems,
  closeOrder,
  listOpenOrders,
  listClosedOrders,
  listItemsForOrders,
  recalcOrderTotal,
  listKitchenItems,
  findOrderItemOwned,
  setOrderItemStatus,
  cancelOrderItem,
  deleteOrderItem,
};
