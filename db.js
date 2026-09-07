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
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS pages (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id    BIGINT NOT NULL,
      slug       VARCHAR(60) NOT NULL UNIQUE,
      title      VARCHAR(100) NOT NULL,
      status     VARCHAR(10) NOT NULL DEFAULT 'draft',
      theme      VARCHAR(30) NOT NULL DEFAULT 'minimal',
      content    TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_pages_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // เพิ่มคอลัมน์ใหม่ให้ตารางที่สร้างไว้แล้ว (MySQL ไม่มี ADD COLUMN IF NOT EXISTS)
  await ensureColumn('otp_codes', 'code_visible', 'code_visible VARCHAR(10) NULL');
  await ensureColumn('otp_codes', 'note', 'note VARCHAR(255) NULL');
  await ensureColumn('otp_codes', 'replaced', 'replaced TINYINT(1) NOT NULL DEFAULT 0');
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
  await pool.execute(
    `UPDATE otp_codes SET replaced = 1, note = 'ถูกแทนที่โดยรหัสใหม่ (มีการขอซ้ำ)' 
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
    'SELECT phone FROM otp_codes WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
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

async function findLatestEmailToken(userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM email_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
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
// Admin
// ---------------------------------------------------------------------------
async function findAdmin() {
  const [rows] = await pool.execute("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
  return rows[0] || null;
}

async function createAdminUser({ email, passwordHash }) {
  const [result] = await pool.execute(
    "INSERT INTO users (email, password_hash, phone, status, role) VALUES (?, ?, '0000000000', 'active', 'admin')",
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
    `SELECT id, email, phone, status, role, provider, is_email_verified, google_id, created_at
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

async function countAdmins() {
  const [rows] = await pool.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
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

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
async function findPageBySlug(slug) {
  const [rows] = await pool.execute('SELECT * FROM pages WHERE slug = ?', [slug]);
  return rows[0] || null;
}

async function findPagesByUser(userId) {
  const [rows] = await pool.execute('SELECT * FROM pages WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return rows;
}

async function createPage({ userId, slug, title, theme = 'minimal' }) {
  const [result] = await pool.execute(
    'INSERT INTO pages (user_id, slug, title, theme) VALUES (?, ?, ?, ?)',
    [userId, slug, title, theme]
  );
  return Number(result.insertId);
}

async function countUserPages(userId) {
  const [rows] = await pool.execute('SELECT COUNT(*) AS c FROM pages WHERE user_id = ?', [userId]);
  return rows[0].c;
}

async function findPageById(id) {
  const [rows] = await pool.execute('SELECT * FROM pages WHERE id = ?', [id]);
  return rows[0] || null;
}

async function updatePage(id, fields) {
  const sets = [];
  const values = [];
  for (const key of ['content', 'status', 'theme', 'title']) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  await pool.execute(`UPDATE pages SET ${sets.join(', ')} WHERE id = ?`, values);
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
  findLatestEmailToken,
  findEmailTokenByHash,
  markEmailTokenUsed,
  updateUserPassword,
  createPasswordReset,
  findPasswordResetByHash,
  markPasswordResetUsed,
  deleteUserSessions,
  deleteOtherSessions,
  findAdmin,
  createAdminUser,
  listOtpLogs,
  countStats,
  listUsers,
  countUsers,
  countAdmins,
  updateUserByAdmin,
  deleteUser,
  findPageBySlug,
  findPagesByUser,
  createPage,
  countUserPages,
  findPageById,
  updatePage,
};
