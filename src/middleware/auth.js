/**
 * auth.js — ตัวช่วย session และ guard ที่ต้องล็อกอิน/ต้องเป็นแอดมิน
 */
'use strict';

const db = require('../db');
const { sha256, randomToken } = require('../lib/crypto');
const { nowSql, futureSql } = require('../lib/time');
const { isAdminRole, isOwner, isShop } = require('../lib/roles');
const { SESSION_TTL_MS, COOKIE_NAME, COOKIE_SECURE } = require('../config');

async function getCurrentUser(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  const session = await db.findSession(sha256(token));
  if (!session) return null;
  if (session.expires_at <= nowSql()) {
    await db.deleteSession(session.token);
    return null;
  }
  const user = await db.findUserById(session.user_id);
  return user || null;
}

async function startSession(res, userId) {
  const token = randomToken();
  const expiresAt = futureSql(SESSION_TTL_MS);
  await db.createSession({ token: sha256(token), userId, expiresAt });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
  });
}

/** แอดมินหรือเจ้าของระบบ (ใช้กับ API /api/admin/*) — เก็บผู้ใช้ไว้ที่ req.admin */
async function requireAdmin(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  if (!isAdminRole(user.role)) {
    return res.status(403).json({ ok: false, message: 'ไม่มีสิทธิ์เข้าถึง ต้องเป็นแอดมิน' });
  }
  req.admin = user;
  next();
}

/** เฉพาะเจ้าของระบบ (owner) — ใช้กับงานจัดการสิทธิ์ระดับสูง */
async function requireOwner(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  if (!isOwner(user.role)) {
    return res.status(403).json({ ok: false, message: 'เฉพาะเจ้าของระบบเท่านั้น' });
  }
  req.owner = user;
  req.admin = user;
  next();
}

/** ผู้ใช้ที่ล็อกอินแล้วแต่ยังสมัครไม่ครบ (Google) — เก็บผู้ใช้ไว้ที่ req.user */
async function requirePendingGoogle(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  if (user.status === 'active') {
    return res.status(400).json({ ok: false, message: 'บัญชีนี้สมัครครบแล้ว' });
  }
  req.user = user;
  next();
}

/** ต้องล็อกอิน (ไม่จำกัดบทบาท) — เก็บผู้ใช้ไว้ที่ req.user */
async function requireLogin(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  req.user = user;
  next();
}

/** เฉพาะเจ้าของร้าน (shop) ที่บัญชีพร้อมใช้งาน */
async function requireShop(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ ok: false, message: 'บัญชียังไม่พร้อมใช้งาน กรุณายืนยันตัวตนให้ครบก่อน' });
  }
  if (!isShop(user.role)) {
    return res.status(403).json({ ok: false, message: 'เฉพาะเจ้าของร้านเท่านั้น' });
  }
  // ของขวัญร้านค้าหมดอายุ → ถอนสิทธิ์ทันที
  if (user.gift_expires_at && new Date(user.gift_expires_at).getTime() <= Date.now()) {
    await db.expireShopGift(user.id);
    return res.status(403).json({ ok: false, message: 'แพ็กเกจร้านค้าหมดอายุแล้ว กรุณาซื้อแพ็กเกจเพื่อใช้งานต่อ' });
  }
  req.user = user;
  next();
}

module.exports = { getCurrentUser, startSession, requireLogin, requireAdmin, requireOwner, requireShop, requirePendingGoogle };
