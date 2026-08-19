/**
 * db.js — ฐานข้อมูล SQLite (ใช้โมดูล node:sqlite ในตัว Node.js)
 * ไม่ต้องติดตั้ง MySQL / Python / node-gyp ใด ๆ
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'shop.db');
const db = new DatabaseSync(DB_PATH);

// โหมด WAL ช่วยให้อ่าน/เขียนพร้อมกันได้ดีขึ้น
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// สร้างตาราง (รันครั้งแรกเท่านั้น)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    email             TEXT    NOT NULL UNIQUE,
    password_hash     TEXT    NOT NULL,
    phone             TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'pending',   -- pending | active
    is_email_verified INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT    NOT NULL,
    phone      TEXT    NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    used       INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS email_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug       TEXT    NOT NULL UNIQUE,                -- ชื่อเพจ (เช่น my-shop) → /p/my-shop
    title      TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'draft',       -- draft | published
    theme      TEXT    NOT NULL DEFAULT 'minimal',
    content    TEXT    NOT NULL DEFAULT '{}',
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// migration: เพิ่มคอลัมน์ purpose ใน otp_codes (แยก OTP ลงทะเบียน vs กู้รหัสผ่าน)
// ถ้ายังไม่มี (ฐานข้อมูลเก่า) ให้เพิ่มเข้าไป — SQLite ALTER TABLE ADD COLUMN รองรับ
const otpColumns = db.prepare('PRAGMA table_info(otp_codes)').all();
if (!otpColumns.some((c) => c.name === 'purpose')) {
  db.exec("ALTER TABLE otp_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'signup'");
}

// migration: เพิ่มคอลัมน์ role ใน users (แยกผู้ใช้ทั่วไป vs แอดมิน)
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((c) => c.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}

// migration: เพิ่มคอลัมน์ provider + google_id ใน users (รองรับเข้าสู่ระบบด้วย Google)
const userColumns2 = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns2.some((c) => c.name === 'provider')) {
  db.exec("ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'email'");
}
if (!userColumns2.some((c) => c.name === 'google_id')) {
  db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
}

// ---------------------------------------------------------------------------
// แคช prepared statements (node:sqlite ต้อง prepare ก่อน run)
// ---------------------------------------------------------------------------
const stmtCache = new Map();

function q(sql) {
  if (!stmtCache.has(sql)) stmtCache.set(sql, db.prepare(sql));
  return stmtCache.get(sql);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
function findUserByEmail(email) {
  return q('SELECT * FROM users WHERE email = ?').get(email);
}

function findUserById(id) {
  return q('SELECT * FROM users WHERE id = ?').get(id);
}

function createUser({ email, passwordHash, phone }) {
  const result = q(
    'INSERT INTO users (email, password_hash, phone) VALUES (?, ?, ?)'
  ).run(email, passwordHash, phone);
  return findUserById(Number(result.lastInsertRowid));
}

function setUserStatus(id, status) {
  q('UPDATE users SET status = ? WHERE id = ?').run(status, id);
}

/**
 * สร้างผู้ใช้ที่เข้าสู่ระบบด้วย Google ครั้งแรก (ยังค้าง: ยังไม่ตั้งรหัส/เบอร์)
 * อีเมลถือว่ายืนยันแล้ว (Google ยืนยันให้) — phone ยังว่างไว้ก่อน
 */
function createGooglePendingUser({ email, googleId }) {
  const result = q(
    `INSERT INTO users (email, password_hash, phone, status, is_email_verified, provider, google_id)
     VALUES (?, '', '', 'pending', 1, 'google', ?)`
  ).run(email, googleId || null);
  return findUserById(Number(result.lastInsertRowid));
}

/** ผูก google_id เข้ากับบัญชี (ล็อกอิน Google ครั้งแรกด้วยอีเมลที่ตรงกัน) */
function linkGoogle(id, googleId) {
  q("UPDATE users SET provider = CASE WHEN provider = 'email' THEN 'google' ELSE provider END, google_id = ? WHERE id = ?").run(googleId || null, id);
}

/** กรอกข้อมูลให้ครบหลัง Google setup (ตั้งรหัส + เบอร์) */
function completeGoogleSetup(id, { passwordHash, phone }) {
  q("UPDATE users SET password_hash = ?, phone = ?, status = 'active', is_email_verified = 1 WHERE id = ?")
    .run(passwordHash, phone, id);
  return findUserById(id);
}

/**
 * อัปเดตข้อมูลผู้ใช้ที่ยัง pending (สมัครค้าง) — ใช้เมื่อผู้ใช้กลับมาสมัครใหม่ด้วยอีเมลเดิม
 */
function updatePendingUser(id, { phone, passwordHash }) {
  q('UPDATE users SET phone = ?, password_hash = ? WHERE id = ?').run(phone, passwordHash, id);
  return findUserById(id);
}

function setEmailVerified(id, verified = 1) {
  q('UPDATE users SET is_email_verified = ? WHERE id = ?').run(verified, id);
}

// ---------------------------------------------------------------------------
// Sessions (ล็อกอินอัตโนมัติด้วย token + คุกกี้ httpOnly)
// ---------------------------------------------------------------------------
function createSession({ token, userId, expiresAt }) {
  q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token, userId, expiresAt
  );
}

function findSession(token) {
  return q('SELECT * FROM sessions WHERE token = ?').get(token);
}

function deleteSession(token) {
  q('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteExpiredSessions() {
  q("DELETE FROM sessions WHERE expires_at <= datetime('now', 'localtime')").run();
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------
/**
 * สร้าง OTP ใหม่ (purpose: 'signup' = ยืนยันเบอร์โทร, 'password_reset' = กู้รหัสผ่านทางอีเมล)
 * contact = เบอร์โทร (signup) หรืออีเมล (password_reset) — เก็บในคอลัมน์ phone
 */
function createOtp({ userId, codeHash, contact, purpose = 'signup', expiresAt }) {
  // ให้มี OTP ที่ยังใช้ได้แค่ 1 อันต่อผู้ใช้ต่อ purpose
  q('DELETE FROM otp_codes WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  const result = q(
    'INSERT INTO otp_codes (user_id, code_hash, phone, purpose, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, codeHash, contact, purpose, expiresAt);
  return Number(result.lastInsertRowid);
}

function findLatestOtp(userId, purpose = 'signup') {
  return q(
    'SELECT * FROM otp_codes WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1'
  ).get(userId, purpose);
}

function markOtpUsed(id) {
  q('UPDATE otp_codes SET used = 1 WHERE id = ?').run(id);
}

function incrementOtpAttempts(id) {
  q('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Email verification tokens
// ---------------------------------------------------------------------------
function createEmailToken({ userId, tokenHash, expiresAt }) {
  const result = q(
    'INSERT INTO email_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(userId, tokenHash, expiresAt);
  return Number(result.lastInsertRowid);
}

function findLatestEmailToken(userId) {
  return q(
    'SELECT * FROM email_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(userId);
}

function findEmailTokenByHash(tokenHash) {
  return q(
    `SELECT et.*, u.email
       FROM email_tokens et
       JOIN users u ON u.id = et.user_id
      WHERE et.token_hash = ?
      ORDER BY et.id DESC LIMIT 1`
  ).get(tokenHash);
}

function markEmailTokenUsed(id) {
  q('UPDATE email_tokens SET used = 1 WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Password reset (กู้รหัสผ่าน)
// ---------------------------------------------------------------------------
function updateUserPassword(id, passwordHash) {
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

function createPasswordReset({ userId, tokenHash, expiresAt }) {
  // token ที่ยังใช้ได้มีแค่ 1 อันต่อผู้ใช้
  q('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  const result = q(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(userId, tokenHash, expiresAt);
  return Number(result.lastInsertRowid);
}

function findPasswordResetByHash(tokenHash) {
  return q(
    `SELECT pr.*, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ?
      ORDER BY pr.id DESC LIMIT 1`
  ).get(tokenHash);
}

function markPasswordResetUsed(id) {
  q('UPDATE password_resets SET used = 1 WHERE id = ?').run(id);
}

function deleteUserSessions(userId) {
  q('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function deleteOtherSessions(userId, currentTokenHash) {
  q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, currentTokenHash);
}

// ---------------------------------------------------------------------------
// Admin (ผู้ดูแลระบบ)
// ---------------------------------------------------------------------------
function findAdmin() {
  return q("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
}

function createAdminUser({ email, passwordHash }) {
  const result = q(
    "INSERT INTO users (email, password_hash, phone, status, role) VALUES (?, ?, '0000000000', 'active', 'admin')"
  ).run(email, passwordHash);
  return findUserById(Number(result.lastInsertRowid));
}

// ---------------------------------------------------------------------------
// Settings (ตั้งค่าที่แก้ได้ตอนรัน — เก็บในตาราง settings)
// ---------------------------------------------------------------------------
function getSetting(key) {
  const r = q('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function setSetting(key, value) {
  q('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

// ---------------------------------------------------------------------------
// Admin — รายงาน OTP
// ---------------------------------------------------------------------------
function listOtpLogs(limit = 50) {
  return q(
    `SELECT o.id, o.user_id, o.phone AS contact, o.purpose,
            o.attempts, o.used, o.expires_at, o.created_at, u.email
       FROM otp_codes o
       JOIN users u ON u.id = o.user_id
      ORDER BY o.id DESC LIMIT ?`
  ).all(limit);
}

function countStats() {
  const users = q('SELECT COUNT(*) AS c FROM users').get().c;
  const activeUsers = q("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get().c;
  const otpTotal = q('SELECT COUNT(*) AS c FROM otp_codes').get().c;
  const otpValid = q(
    "SELECT COUNT(*) AS c FROM otp_codes WHERE used = 0 AND expires_at > datetime('now', 'localtime')"
  ).get().c;
  const otpUsed = q('SELECT COUNT(*) AS c FROM otp_codes WHERE used = 1').get().c;
  const otpExpired = q(
    "SELECT COUNT(*) AS c FROM otp_codes WHERE used = 0 AND expires_at <= datetime('now', 'localtime')"
  ).get().c;
  return { users, activeUsers, otpTotal, otpValid, otpUsed, otpExpired };
}

// ---------------------------------------------------------------------------
// Admin — จัดการผู้ใช้
// ---------------------------------------------------------------------------
function listUsers({ search = '', limit = 100 } = {}) {
  const like = `%${search}%`;
  return q(
    `SELECT id, email, phone, status, role, provider, is_email_verified, google_id, created_at
       FROM users
      WHERE email LIKE ? OR phone LIKE ?
      ORDER BY id DESC LIMIT ?`
  ).all(like, like, limit);
}

function countUsers(search = '') {
  if (!search) return q('SELECT COUNT(*) AS c FROM users').get().c;
  const like = `%${search}%`;
  return q('SELECT COUNT(*) AS c FROM users WHERE email LIKE ? OR phone LIKE ?').get(like, like).c;
}

function countAdmins() {
  return q("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
}

function updateUserByAdmin(id, fields) {
  const sets = [];
  const params = [];
  if (fields.email !== undefined) { sets.push('email = ?'); params.push(fields.email); }
  if (fields.phone !== undefined) { sets.push('phone = ?'); params.push(fields.phone); }
  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.role !== undefined) { sets.push('role = ?'); params.push(fields.role); }
  if (fields.isEmailVerified !== undefined) { sets.push('is_email_verified = ?'); params.push(fields.isEmailVerified ? 1 : 0); }
  if (fields.passwordHash !== undefined) { sets.push('password_hash = ?'); params.push(fields.passwordHash); }
  if (sets.length) {
    q(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }
  return findUserById(id);
}

function deleteUser(id) {
  q('DELETE FROM users WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Pages (เซลเพจของผู้ใช้) — slug ไม่ซ้ำกันทั่วระบบ
// ---------------------------------------------------------------------------
function findPageBySlug(slug) {
  return q('SELECT * FROM pages WHERE slug = ?').get(slug);
}

function findPagesByUser(userId) {
  return q('SELECT * FROM pages WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function createPage({ userId, slug, title, theme = 'minimal' }) {
  const result = q(
    'INSERT INTO pages (user_id, slug, title, theme) VALUES (?, ?, ?, ?)'
  ).run(userId, slug, title, theme);
  return Number(result.lastInsertRowid);
}

function countUserPages(userId) {
  return q('SELECT COUNT(*) AS c FROM pages WHERE user_id = ?').get(userId).c;
}

function findPageById(id) {
  return q('SELECT * FROM pages WHERE id = ?').get(id);
}

function updatePage(id, fields) {
  const sets = [];
  const values = [];
  for (const key of ['content', 'status', 'theme', 'title']) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  sets.push("updated_at = datetime('now', 'localtime')");
  values.push(id);
  q(`UPDATE pages SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

module.exports = {
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
  findLatestOtp,
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
  getSetting,
  setSetting,
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
