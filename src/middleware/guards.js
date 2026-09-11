/**
 * guards.js — middleware ป้องกันหน้าเว็บ (ไม่ใช่ API)
 *  - adminGuard:   /admin/* ต้องเป็นแอดมิน
 *  - accountGuard: /dashboard, /settings ต้องล็อกอิน + ยืนยันเบอร์แล้ว
 */
'use strict';

const { getCurrentUser } = require('./auth');
const { isAdminRole } = require('../lib/roles');

async function adminGuard(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=/admin/');
  }
  if (!isAdminRole(user.role)) {
    return res.status(403).send(
      '<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>403</title></head>' +
      '<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f5fb;color:#333">' +
      '<div style="text-align:center"><h1 style="font-size:56px;margin:0">🔒 403</h1>' +
      '<p style="color:#667085">คุณไม่มีสิทธิ์เข้าถึงหน้านี้ (ต้องเป็นแอดมิน)</p>' +
      '<a href="/" style="color:#6366f1">← กลับหน้าแรก</a></div></body></html>'
    );
  }
  next();
}

// บัญชีค้างกลางคัน (ยังไม่ยืนยันเบอร์) → พาไปทำขั้นตอนให้ครบก่อน
async function accountGuard(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/settings/profile'));
  }
  if (user.status !== 'active') {
    const completeUrl = user.provider === 'google' ? '/google-setup.html' : '/otp.html';
    return res.redirect(completeUrl);
  }
  next();
}

// พื้นที่ร้านค้า (/shop/*) — ต้องล็อกอินและบัญชี active (การเช็ค role ทำใน route/API)
async function shopGuard(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/shop'));
  }
  if (user.status !== 'active') {
    const completeUrl = user.provider === 'google' ? '/google-setup.html' : '/otp.html';
    return res.redirect(completeUrl);
  }
  next();
}

module.exports = { adminGuard, accountGuard, shopGuard };
