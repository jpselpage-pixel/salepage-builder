/**
 * account.js — หน้าบัญชี (/dashboard, /settings) และการยืนยันอีเมล
 */
'use strict';

const path = require('node:path');
const express = require('express');
const db = require('../db');
const { sha256 } = require('../lib/crypto');
const { nowSql } = require('../lib/time');
const { buildResultPage } = require('../lib/result-page');

const router = express.Router();

// หน้าบัญชี — ใช้ไฟล์เดียว เลือก panel จาก URL (/settings/profile, /settings/security)
router.get(['/dashboard', '/dashboard/'], (req, res) => res.redirect('/settings/profile'));
router.get(['/settings', '/settings/'], (req, res) => res.redirect('/settings/profile'));
router.get(['/dashboard/:section', '/settings/:section'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'dashboard', 'index.html'));
});

// ---------------------------------------------------------------------------
// ยืนยันอีเมล (เปิดจากลิงก์ในอีเมล)
// ---------------------------------------------------------------------------
router.get('/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  const record = await db.findEmailTokenByHash(sha256(token));

  if (!record || record.used === 1) {
    return res.status(400).send(buildResultPage(false, 'ลิงก์ยืนยันไม่ถูกต้องหรือถูกใช้ไปแล้ว'));
  }
  if (record.expires_at <= nowSql()) {
    return res.status(400).send(buildResultPage(false, 'ลิงก์ยืนยันหมดอายุแล้ว กรุณาขอใหม่'));
  }

  await db.markEmailTokenUsed(record.id);
  await db.setEmailVerified(record.user_id, 1);
  console.log(`📧 ยืนยันอีเมลสำเร็จ: user_id=${record.user_id}`);

  res.send(buildResultPage(true, 'ยืนยันอีเมลสำเร็จ! คุณสามารถเข้าสู่ระบบได้เลย'));
});

module.exports = router;
