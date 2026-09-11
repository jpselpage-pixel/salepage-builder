/**
 * orders.js — โต๊ะ + QR + บิล/ออเดอร์ (ฝั่งเจ้าของร้าน) และหน้าร้านสำหรับลูกค้า (/order/:token)
 */
'use strict';

const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { getCurrentUser, requireShop } = require('../middleware/auth');
const { isShop } = require('../lib/roles');
const { randomToken } = require('../lib/crypto');
const { buildOrderItems } = require('../lib/order-builder');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const MAX_QR_URL = 200;

// ตรวจ origin สำหรับลิงก์ใน QR (กันค่าที่ไม่ใช่ http/https)
function safeOrigin(req) {
  const raw = String(req.query.origin || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s"'<>]{1,180}$/i.test(raw)) return raw;
  return `${req.protocol}://${req.get('host')}`;
}

async function requireShopPage(req, res, next) {
  const user = await getCurrentUser(req);
  if (!user) return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl || '/shop'));
  if (user.status !== 'active') return res.redirect(user.provider === 'google' ? '/google-setup.html' : '/otp.html');
  if (!isShop(user.role)) return res.redirect('/shop');
  req.user = user;
  next();
}

async function myShop(req, res) {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) {
    res.status(400).json({ ok: false, message: 'กรุณาตั้งข้อมูลร้านก่อน' });
    return null;
  }
  return shop;
}

// ---------------------------------------------------------------------------
// หน้าเว็บ
// ---------------------------------------------------------------------------
// หน้าสั่งอาหาร (เจ้าของร้าน) — จัดการโต๊ะ/QR + บิลที่เปิดอยู่
router.get('/shop/orders.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'orders.html'));
});

// หน้าสั่งอาหารของลูกค้า (สาธารณะ) — ใช้ token ของโต๊ะ
router.get('/order/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'order', 'index.html'));
});

// ---------------------------------------------------------------------------
// API ฝั่งร้าน: โต๊ะ + QR
// ---------------------------------------------------------------------------
router.get('/api/shop/tables', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const tables = await db.listTables(shop.id);
  const openOrders = await db.listOpenOrders(shop.id);
  const byTable = {};
  openOrders.forEach((o) => { byTable[o.table_id] = o; });
  res.json({
    ok: true,
    tables: tables.map((t) => ({
      id: t.id, code: t.code, token: t.token,
      open_order: byTable[t.id] || null,
    })),
  });
});

router.post('/api/shop/tables', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const code = clip(req.body?.code, 30);
  if (!code) return res.status(400).json({ ok: false, field: 'code', message: 'กรุณากรอกเลขโต๊ะ (เช่น 1, A2, โต๊ะริมหน้าต่าง)' });
  if (await db.findTableByCode(shop.id, code)) {
    return res.status(409).json({ ok: false, field: 'code', message: 'มีเลขโต๊ะนี้อยู่แล้ว' });
  }
  const id = await db.createTable({ shopId: shop.id, code, token: randomToken().slice(0, 16) });
  // เปิดบิลตั้งต้นให้โต๊ะทันที (มีเลขที่บิล) — ลูกค้าสแกนแล้วเห็นเลขบิลได้เลย
  await db.createOrder({ shopId: shop.id, tableId: id });
  res.json({ ok: true, message: `เพิ่มโต๊ะ "${code}" แล้ว`, id });
});

router.put('/api/shop/tables/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const table = await db.findTableById(id, shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });
  const code = clip(req.body?.code, 30);
  if (!code) return res.status(400).json({ ok: false, field: 'code', message: 'กรุณากรอกเลขโต๊ะ' });
  const dup = await db.findTableByCode(shop.id, code);
  if (dup && dup.id !== id) return res.status(409).json({ ok: false, field: 'code', message: 'มีเลขโต๊ะนี้อยู่แล้ว' });
  await db.updateTableCode(id, shop.id, code);
  res.json({ ok: true, message: 'บันทึกเลขโต๊ะแล้ว' });
});

router.delete('/api/shop/tables/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const table = await db.findTableById(id, shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });

  // ห้ามลบถ้าบิลปัจจุบันยังไม่ถูกเช็คบิล (มีรายการค้างอยู่)
  const open = await db.findOpenOrder(shop.id, id);
  if (open) {
    const items = await db.listOrderItems(open.id);
    if (items.length) {
      return res.status(409).json({
        ok: false,
        message: `ลบไม่ได้ เพราะโต๊ะ "${table.code}" ยังมีบิลที่ยังไม่เช็คบิล — กรุณากดเช็คบิลก่อน`,
      });
    }
  }

  await db.deleteTable(id, shop.id);
  res.json({ ok: true, message: `ลบโต๊ะ "${table.code}" แล้ว` });
});

// รูป QR ของโต๊ะ (PNG) — ชี้ไป /order/<token>
router.get('/api/shop/tables/:id/qr', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const table = await db.findTableById(Number(req.params.id), shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });

  const url = `${safeOrigin(req)}/order/${table.token}`.slice(0, MAX_QR_URL);
  try {
    const png = await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    res.status(500).json({ ok: false, message: 'สร้าง QR ไม่สำเร็จ' });
  }
});

// ---------------------------------------------------------------------------
// API ฝั่งร้าน: บิลที่เปิดอยู่ + เช็คบิล
// ---------------------------------------------------------------------------
router.get('/api/shop/orders/open', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const orders = await db.listOpenOrders(shop.id);
  const withItems = [];
  for (const o of orders) {
    withItems.push({ ...o, items: await db.listOrderItems(o.id) });
  }
  res.json({ ok: true, orders: withItems });
});

router.post('/api/shop/tables/:id/checkout', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const table = await db.findTableById(Number(req.params.id), shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });

  const open = await db.findOpenOrder(shop.id, table.id);
  let closed = null;
  if (open) {
    const items = await db.listOrderItems(open.id);
    // ห้ามเช็คบิลถ้าครัวยังไม่เคลียร์ (มีรายการรอทำ/กำลังทำ)
    const uncleared = items.filter((i) => i.status === 'pending' || i.status === 'cooking');
    if (uncleared.length) {
      return res.status(409).json({
        ok: false,
        message: `ยังเช็คบิลไม่ได้ — ครัวยังไม่เคลียร์ ${uncleared.length} รายการ (รอทำ/กำลังทำ)`,
      });
    }
    await db.closeOrder(open.id);
    closed = {
      order_id: open.id, table_code: table.code, total: Number(open.total),
      item_count: items.filter((i) => i.status !== 'cancelled').length,
    };
  }
  // เปิดบิลใหม่ว่างให้โต๊ะเดิมทันที
  await db.createOrder({ shopId: shop.id, tableId: table.id });
  console.log(`🧾 เช็คบิลโต๊ะ ${table.code} (${shop.name})${closed ? ' ยอด ' + closed.total : ' (ไม่มีรายการ)'}`);
  res.json({ ok: true, message: `เช็คบิลโต๊ะ "${table.code}" แล้ว`, closed });
});

// ---------------------------------------------------------------------------
// แคชเชียร์: เพิ่มอาหารเข้าบิล / ลบรายการออกจากบิล
// ---------------------------------------------------------------------------
router.post('/api/shop/tables/:id/items', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const table = await db.findTableById(Number(req.params.id), shop.id);
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะ' });
  const open = await db.findOpenOrder(shop.id, table.id);
  if (!open) return res.status(400).json({ ok: false, message: 'ไม่มีบิลที่เปิดอยู่' });

  let prepared;
  try { prepared = await buildOrderItems(shop.id, req.body?.items); }
  catch (err) { return res.status(err.status || 400).json({ ok: false, message: err.message }); }

  await db.addOrderItems(open.id, prepared);
  const fresh = await db.findOpenOrder(shop.id, table.id);
  const items = await db.listOrderItems(open.id);
  console.log(`🧾 [แคชเชียร์] เพิ่มอาหาร โต๊ะ ${table.code} ${prepared.length} รายการ`);
  res.json({
    ok: true,
    message: 'เพิ่มอาหารเข้าบิลแล้ว',
    bill: { order_id: open.id, bill_no: fresh.bill_no, total: Number(fresh.total), items },
  });
});

router.delete('/api/shop/order-items/:id', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const item = await db.findOrderItemOwned(Number(req.params.id), shop.id);
  if (!item) return res.status(404).json({ ok: false, message: 'ไม่พบรายการ' });
  if (item.order_status !== 'open') return res.status(400).json({ ok: false, message: 'บิลนี้ปิดแล้ว' });
  await db.deleteOrderItem(item.id, item.order_id);
  console.log(`🧾 [แคชเชียร์] ลบรายการ #${item.id} (${item.menu_name})`);
  res.json({ ok: true, message: 'ลบรายการแล้ว' });
});

// ---------------------------------------------------------------------------
// หน้าครัว + สถานะรายจาน
// ---------------------------------------------------------------------------
router.get('/shop/kitchen.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'kitchen.html'));
});

router.get('/api/shop/kitchen', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const items = await db.listKitchenItems(shop.id);
  res.json({ ok: true, items });
});

// เปลี่ยนสถานะรายจาน: pending (รอทำ) | cooking (กำลังทำ) | done (เคลียร์/เสร็จ) | cancelled (ยกเลิก + ต้องระบุสาเหตุ)
router.post('/api/shop/order-items/:id/status', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!['pending', 'cooking', 'done', 'cancelled'].includes(status)) {
    return res.status(400).json({ ok: false, message: 'สถานะไม่ถูกต้อง' });
  }
  const item = await db.findOrderItemOwned(id, shop.id);
  if (!item) return res.status(404).json({ ok: false, message: 'ไม่พบรายการ' });
  if (item.order_status !== 'open') return res.status(400).json({ ok: false, message: 'บิลนี้ปิดแล้ว' });

  if (status === 'cancelled') {
    const reason = String(req.body?.reason || '').trim().slice(0, 200);
    if (!reason) return res.status(400).json({ ok: false, field: 'reason', message: 'กรุณาระบุสาเหตุการยกเลิก' });
    await db.cancelOrderItem(id, item.order_id, reason);
    console.log(`❌ [ครัว] ยกเลิกรายการ #${id} (${item.menu_name}) — ${reason}`);
    return res.json({ ok: true, message: `ยกเลิกรายการแล้ว (${reason})` });
  }

  await db.setOrderItemStatus(id, shop.id, status);
  const msg = status === 'cooking' ? 'เริ่มทำแล้ว' : status === 'done' ? 'เคลียร์อาหารแล้ว' : 'อัปเดตแล้ว';
  res.json({ ok: true, message: msg });
});

// ---------------------------------------------------------------------------
// ประวัติออเดอร์ (บิลที่ปิดแล้ว) — ดูย้อนหลังเป็นบิล ๆ ต่อโต๊ะ
// ---------------------------------------------------------------------------
router.get('/shop/history.html', requireShopPage, async (req, res) => {
  const shop = await db.findShopByUserId(req.user.id);
  if (!shop) return res.redirect('/shop/setup.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'shop', 'history.html'));
});

router.get('/api/shop/orders/history', requireShop, async (req, res) => {
  const shop = await myShop(req, res);
  if (!shop) return;
  const tableId = req.query.tableId ? Number(req.query.tableId) : null;
  const orders = await db.listClosedOrders(shop.id, { tableId, limit: req.query.limit });
  const items = await db.listItemsForOrders(orders.map((o) => o.id));
  const byOrder = {};
  items.forEach((i) => { (byOrder[i.order_id] || (byOrder[i.order_id] = [])).push(i); });
  res.json({ ok: true, orders: orders.map((o) => ({ ...o, items: byOrder[o.id] || [] })) });
});

module.exports = router;
