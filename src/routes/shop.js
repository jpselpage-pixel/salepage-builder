/**
 * shop.js — พื้นที่เจ้าของร้าน (ซื้อแพ็กเกจ → ตั้งร้าน → จัดการเมนู) + หน้าร้านสาธารณะ
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const { getCurrentUser, requireLogin, requireShop } = require('../middleware/auth');
const { isAdminRole, isShop } = require('../lib/roles');
const { randomToken } = require('../lib/crypto');
const { addMonthsSql, toSql, nowSql } = require('../lib/time');
const { getPaymentSettings, hasAnyChannel, paymentInstructions, generateRef, emailPackagePurchased } = require('../lib/payments');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'shops');
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ---------------------------------------------------------------------------
// หน้าเว็บ (อยู่หลัง shopGuard ที่ mount ไว้ใน app.js)
// ---------------------------------------------------------------------------
async function requireShopPage(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/shop'));
  if (user.status !== 'active') {
    return res.redirect(user.provider === 'google' ? '/google-setup.html' : '/otp.html');
  }
  if (!isShop(user.role)) return res.redirect('/shop');
  req.user = user;
  next();
}

// ประตู /shop — ใช้หน้ากลางที่ redirect ฝั่ง client (location.replace) เพื่อไม่ให้กดย้อนกลับแล้ววน
router.get('/shop', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'entry.html'));
});

// หน้าซื้อแพ็กเกจ (ผู้ใช้ทั่วไป)
router.get('/shop/purchase.html', async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.redirect('/login.html?next=/shop/purchase.html');
  if (isAdminRole(user.role)) return res.redirect('/admin/');
  // เจ้าของร้านเข้าหน้านี้ได้ด้วย เพื่อ "ซื้อเพิ่ม/ต่ออายุ" (ไม่เริ่มนับใหม่)
  res.set('Cache-Control', 'no-store'); // กัน bfcache กด Back แล้วเจอหน้าเดิมหลังซื้อ
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'purchase.html'));
});

// หน้าตั้งข้อมูลร้าน (เจ้าของร้าน)
router.get('/shop/setup.html', requireShopPage, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'setup.html'));
});

// หน้าจัดการเมนู (เจ้าของร้าน + ต้องมีข้อมูลร้านก่อน)
router.get('/shop/menu.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'menu.html'));
});

// หน้าร้านสาธารณะ (ไม่ต้องล็อกอิน) — โหลดข้อมูลผ่าน /api/public/shops/:code
router.get('/s/:code', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'index.html'));
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function myShop(req, res) {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) {
    res.status(400).json({ ok: false, message: 'กรุณาตั้งข้อมูลร้านก่อน' });
    return null;
  }
  return shop;
}

// รายการแพ็กเกจที่เปิดขาย (owner ตั้งไว้ที่ /admin/packages.html) — ใช้แสดงในหน้าซื้อแพ็กเกจ
router.get('/api/packages', async (req, res) => {
  res.json({ ok: true, packages: await db.listActivePackages() });
});

// ซื้อแพ็กเกจ (จำลองการชำระเงิน) — ผู้ใช้ที่ล็อกอินแล้วและยังไม่เป็นเจ้าของร้าน
// ราคา/ชื่อแพ็กเกจคิดจากฝั่งเซิร์ฟเวอร์เสมอ (ไม่เชื่อค่าที่ client ส่งมา)
router.post('/api/shop/purchase', requireLogin, async (req, res) => {
  const user = req.user;
  if (isAdminRole(user.role)) {
    return res.status(400).json({ ok: false, message: 'บัญชีผู้ดูแลระบบไม่ต้องซื้อแพ็กเกจ' });
  }

  const packageId = Number(req.body?.packageId);
  if (!Number.isInteger(packageId) || packageId <= 0) {
    return res.status(400).json({ ok: false, message: 'กรุณาเลือกแพ็กเกจที่ต้องการซื้อ' });
  }
  const pkg = await db.findPackageById(packageId);
  if (!pkg || Number(pkg.active) !== 1) {
    return res.status(400).json({ ok: false, message: 'แพ็กเกจนี้ไม่พร้อมขายหรือถูกปิดไปแล้ว' });
  }

  const amount = Number(pkg.price) || 0;

  // เปิดรับชำระเงินจริง → สร้างรายการรอโอน แล้วให้เจ้าของระบบกดยืนยันยอด (ยังไม่ให้สิทธิ์ทันที)
  const pay = getPaymentSettings();
  if (pay.enabled && hasAnyChannel(pay)) {
    await db.expireStalePayments(); // ล้างรายการที่หมดเวลา ให้ลูกค้าสร้างใหม่ได้
    const existing = await db.findPendingPackagePaymentByUser(user.id);
    if (existing) {
      return res.json({ ok: true, pending: true, message: 'คุณมีรายการที่รอตรวจสอบยอดอยู่แล้ว', payment: paymentInstructions(existing) });
    }
    let paymentId = null;
    for (let i = 0; i < 5 && !paymentId; i++) {
      try {
        paymentId = await db.createPackagePayment({
          userId: user.id,
          packageId: pkg.id,
          packageName: pkg.name,
          durationMonths: pkg.duration_months,
          amount,
          method: pay.promptpayId ? 'promptpay' : 'bank',
          ref: generateRef(),
        });
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err; // รหัสอ้างอิงชนกัน → สุ่มใหม่
      }
    }
    if (!paymentId) return res.status(500).json({ ok: false, message: 'สร้างรายการชำระเงินไม่สำเร็จ กรุณาลองใหม่' });
    const rec = await db.findPackagePaymentById(paymentId);
    console.log(`💳 เปิดรายการชำระเงิน #${rec.id} (${rec.ref}) ${user.email} · ${pkg.name} · ฿${amount}`);
    return res.json({ ok: true, pending: true, message: 'สร้างรายการชำระเงินแล้ว (รหัส ' + rec.ref + ')', payment: paymentInstructions(rec) });
  }

  // โหมดที่ยังไม่เปิดรับชำระเงิน → ให้สิทธิ์ทันที
  // ถ้ายังมีสิทธิ์เหลืออยู่ ให้นับต่อจากวันหมดอายุเดิม (เหมือนเส้นทางที่ชำระเงินจริง)
  const current = await db.maxActiveEntitlement(user.id);
  const stillActive = current && new Date(current).getTime() > Date.now();
  const startAt = stillActive ? toSql(current) : nowSql();
  const expiresAt = addMonthsSql(startAt, pkg.duration_months);
  await db.setUserRole(user.id, 'shop');
  await db.setUserShopExpiry(user.id, expiresAt);
  await db.createShopPurchase({
    userId: user.id, packageId: pkg.id, packageName: clip(pkg.name, 30), amount, startAt, expiresAt,
  });
  console.log(`🛒 ซื้อแพ็กเกจร้านค้า: ${user.email} (${pkg.name} · ${pkg.duration_months} เดือน · ฿${amount} · ถึง ${expiresAt}${stillActive ? ' · ต่อจากเดิม' : ''})`);
  // แจ้งลูกค้าทางอีเมล พร้อมรายละเอียดแพ็กเกจที่แอดมินตั้งไว้
  await emailPackagePurchased({
    user,
    packageId: pkg.id,
    packageName: pkg.name,
    durationMonths: pkg.duration_months,
    amount,
    startAt,
    expiresAt,
    ref: '',
    extended: Boolean(stillActive),
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
  res.json({
    ok: true,
    message: `ซื้อแพ็กเกจ "${pkg.name}" สำเร็จ ตอนนี้คุณเป็นเจ้าของร้านแล้ว`,
    role: 'shop',
    expiresAt,
    redirect: '/settings/profile?purchased=1',
  });
});

// ข้อมูลร้านของฉัน + ข้อมูลเมนูทั้งหมด (ใช้ในหน้าจัดการ)
router.get('/api/shop/me', requireShop, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) {
    return res.json({
      ok: true, shop: null, categories: [], menus: [], optionGroups: [], optionItems: [], menuGroups: [],
      purchase: await db.findLatestShopPurchase(req.user.id),
    });
  }
  const [categories, menus, optionGroups, optionItems, menuGroups] = await Promise.all([
    db.listCategories(shop.id),
    db.listMenus(shop.id),
    db.listOptionGroups(shop.id),
    db.listOptionItems(shop.id),
    db.listMenuOptionGroups(shop.id),
  ]);
  res.json({
    ok: true, shop, categories, menus, optionGroups, optionItems, menuGroups,
    publicUrl: '/s/' + shop.public_code,
    purchase: await db.findLatestShopPurchase(req.user.id),
  });
});

// สร้างร้าน (1 บัญชี = 1 ร้าน)
router.post('/api/shop', requireShop, async (req, res) => {
  const existing = await db.findShopByUserId(req.user.id);
  if (existing) return res.status(409).json({ ok: false, message: 'คุณมีร้านแล้ว (1 บัญชี = 1 ร้าน)' });

  const name = clip(req.body?.name, 120);
  const phone = clip(req.body?.phone, 30);
  if (name.length < 2) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อร้าน (อย่างน้อย 2 ตัวอักษร)' });
  if (phone.length < 6) return res.status(400).json({ ok: false, field: 'phone', message: 'กรุณากรอกเบอร์ติดต่อร้าน' });

  const shop = await db.createShop({
    userId: req.user.id,
    publicCode: randomToken().slice(0, 10),
    name,
    phone,
    lineUrl: clip(req.body?.lineUrl, 255),
    logoUrl: clip(req.body?.logoUrl, 255),
    mapsUrl: clip(req.body?.mapsUrl, 500),
  });
  console.log(`🏪 สร้างร้าน: ${name} (${req.user.email})`);
  res.json({ ok: true, message: 'สร้างร้านสำเร็จ', shop });
});

// แก้ไขข้อมูลร้าน
router.put('/api/shop', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;

  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 120);
    if (name.length < 2) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อร้าน (อย่างน้อย 2 ตัวอักษร)' });
    fields.name = name;
  }
  if (req.body?.phone !== undefined) fields.phone = clip(req.body.phone, 30);
  if (req.body?.lineUrl !== undefined) fields.lineUrl = clip(req.body.lineUrl, 255);
  if (req.body?.logoUrl !== undefined) fields.logoUrl = clip(req.body.logoUrl, 255);
  if (req.body?.mapsUrl !== undefined) fields.mapsUrl = clip(req.body.mapsUrl, 500);

  await db.updateShop(shop.id, fields);
  const updated = await db.findShopByUserId(req.user.id);
  res.json({ ok: true, message: 'บันทึกข้อมูลร้านแล้ว', shop: updated });
});

// ---------- หมวดหมู่ / หมวดหมู่ย่อย ----------
router.post('/api/shop/categories', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const name = clip(req.body?.name, 120);
  if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อหมวดหมู่' });

  let parentId = req.body?.parentId ? Number(req.body.parentId) : null;
  if (parentId) {
    const parent = await db.findCategoryById(parentId, shop.id);
    if (!parent) return res.status(400).json({ ok: false, message: 'ไม่พบหมวดหมู่หลักที่เลือก' });
    if (parent.parent_id) return res.status(400).json({ ok: false, message: 'ซ้อนหมวดหมู่ย่อยได้ไม่เกิน 1 ชั้น' });
  }
  const id = await db.createCategory({ shopId: shop.id, parentId, name, sortOrder: Number(req.body?.sortOrder) || 0 });
  res.json({ ok: true, message: 'เพิ่มหมวดหมู่แล้ว', id });
});

router.put('/api/shop/categories/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findCategoryById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบหมวดหมู่' });

  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 120);
    if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อหมวดหมู่' });
    fields.name = name;
  }
  if (req.body?.sortOrder !== undefined) fields.sortOrder = Number(req.body.sortOrder) || 0;
  await db.updateCategory(id, shop.id, fields);
  res.json({ ok: true, message: 'บันทึกหมวดหมู่แล้ว' });
});

router.delete('/api/shop/categories/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findCategoryById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบหมวดหมู่' });
  await db.deleteCategory(id, shop.id);
  res.json({ ok: true, message: 'ลบหมวดหมู่แล้ว' });
});

// ---------- เมนูสินค้า ----------
async function readMenuFields(req, shop, res) {
  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 150);
    if (!name) { res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อเมนู' }); return null; }
    fields.name = name;
  }
  if (req.body?.description !== undefined) fields.description = clip(req.body.description, 500);
  if (req.body?.price !== undefined) {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0) { res.status(400).json({ ok: false, field: 'price', message: 'ราคาไม่ถูกต้อง' }); return null; }
    fields.price = Math.round(price * 100) / 100;
  }
  if (req.body?.imageUrl !== undefined) fields.imageUrl = clip(req.body.imageUrl, 255);
  if (req.body?.available !== undefined) fields.available = req.body.available ? 1 : 0;
  if (req.body?.sortOrder !== undefined) fields.sortOrder = Number(req.body.sortOrder) || 0;
  if (req.body?.categoryId !== undefined) {
    if (req.body.categoryId === null || req.body.categoryId === '') {
      fields.categoryId = null;
    } else {
      const cid = Number(req.body.categoryId);
      if (!await db.findCategoryById(cid, shop.id)) { res.status(400).json({ ok: false, field: 'categoryId', message: 'ไม่พบหมวดหมู่ที่เลือก' }); return null; }
      fields.categoryId = cid;
    }
  }
  return fields;
}

router.post('/api/shop/menus', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  if (!clip(req.body?.name, 150)) return res.status(400).json({ ok: false, field: 'name', message: 'กรุณากรอกชื่อเมนู' });
  const fields = await readMenuFields(req, shop, res);
  if (!fields) return;
  const id = await db.createMenu({ shopId: shop.id, ...fields });
  res.json({ ok: true, message: 'เพิ่มเมนูแล้ว', id });
});

router.put('/api/shop/menus/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findMenuById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบเมนู' });
  const fields = await readMenuFields(req, shop, res);
  if (!fields) return;
  await db.updateMenu(id, shop.id, fields);
  res.json({ ok: true, message: 'บันทึกเมนูแล้ว' });
});

router.delete('/api/shop/menus/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findMenuById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบเมนู' });
  await db.deleteMenu(id, shop.id);
  res.json({ ok: true, message: 'ลบเมนูแล้ว' });
});

// ผูกกลุ่มตัวเลือกกับเมนู
router.put('/api/shop/menus/:id/groups', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findMenuById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบเมนู' });

  const raw = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
  const groupIds = [];
  for (const g of raw) {
    const gid = Number(g);
    if (gid && await db.findOptionGroupById(gid, shop.id)) groupIds.push(gid);
  }
  await db.setMenuOptionGroups(id, groupIds);
  res.json({ ok: true, message: 'บันทึกตัวเลือกของเมนูแล้ว' });
});

// ---------- กลุ่มตัวเลือก / ตัวเลือก ----------
router.post('/api/shop/option-groups', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const name = clip(req.body?.name, 120);
  if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อกลุ่มตัวเลือก (เช่น ระดับความเผ็ด)' });
  const id = await db.createOptionGroup({
    shopId: shop.id, name,
    required: req.body?.required ? 1 : 0,
    multi: req.body?.multi ? 1 : 0,
    sortOrder: Number(req.body?.sortOrder) || 0,
  });
  res.json({ ok: true, message: 'เพิ่มกลุ่มตัวเลือกแล้ว', id });
});

router.put('/api/shop/option-groups/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findOptionGroupById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มตัวเลือก' });
  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 120);
    if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อกลุ่มตัวเลือก' });
    fields.name = name;
  }
  if (req.body?.required !== undefined) fields.required = req.body.required ? 1 : 0;
  if (req.body?.multi !== undefined) fields.multi = req.body.multi ? 1 : 0;
  if (req.body?.sortOrder !== undefined) fields.sortOrder = Number(req.body.sortOrder) || 0;
  await db.updateOptionGroup(id, shop.id, fields);
  res.json({ ok: true, message: 'บันทึกกลุ่มตัวเลือกแล้ว' });
});

router.delete('/api/shop/option-groups/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findOptionGroupById(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มตัวเลือก' });
  await db.deleteOptionGroup(id, shop.id);
  res.json({ ok: true, message: 'ลบกลุ่มตัวเลือกแล้ว' });
});

router.post('/api/shop/option-groups/:id/items', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const gid = Number(req.params.id);
  if (!await db.findOptionGroupById(gid, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบกลุ่มตัวเลือก' });
  const name = clip(req.body?.name, 120);
  if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อตัวเลือก' });
  const priceDelta = Number(req.body?.priceDelta) || 0;
  const id = await db.createOptionItem({ groupId: gid, name, priceDelta, sortOrder: Number(req.body?.sortOrder) || 0 });
  res.json({ ok: true, message: 'เพิ่มตัวเลือกแล้ว', id });
});

router.put('/api/shop/option-items/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findOptionItemOwned(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบตัวเลือก' });
  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clip(req.body.name, 120);
    if (!name) return res.status(400).json({ ok: false, message: 'กรุณากรอกชื่อตัวเลือก' });
    fields.name = name;
  }
  if (req.body?.priceDelta !== undefined) fields.priceDelta = Number(req.body.priceDelta) || 0;
  if (req.body?.sortOrder !== undefined) fields.sortOrder = Number(req.body.sortOrder) || 0;
  await db.updateOptionItem(id, shop.id, fields);
  res.json({ ok: true, message: 'บันทึกตัวเลือกแล้ว' });
});

router.delete('/api/shop/option-items/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  if (!await db.findOptionItemOwned(id, shop.id)) return res.status(404).json({ ok: false, message: 'ไม่พบตัวเลือก' });
  await db.deleteOptionItem(id, shop.id);
  res.json({ ok: true, message: 'ลบตัวเลือกแล้ว' });
});

// ---------- อัปโหลดรูป (base64 JSON → ไฟล์ใน public/uploads/shops) ----------
router.post('/api/shop/upload', requireShop, (req, res) => {
  const dataUrl = String(req.body?.dataUrl || '');
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ ok: false, message: 'ไฟล์รูปไม่ถูกต้อง (รองรับ png/jpeg/webp/gif)' });

  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, message: 'ไฟล์ใหญ่เกิน 3MB' });

  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* มีอยู่แล้ว */ }
  const name = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + IMAGE_TYPES[m[1]];
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.json({ ok: true, url: '/uploads/shops/' + name });
});

module.exports = router;
