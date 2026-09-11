/**
 * public.js — API สาธารณะ (ไม่ต้องล็อกอิน) สำหรับหน้าร้านลูกค้า
 */
'use strict';

const express = require('express');
const db = require('../db');
const { buildOrderItems } = require('../lib/order-builder');

const router = express.Router();

// ข้อมูลร้าน + เมนูทั้งหมด สำหรับหน้าร้านสาธารณะ /s/:code
router.get('/api/public/shops/:code', async (req, res) => {
  const shop = await db.findPublicShopByCode(String(req.params.code || ''));
  if (!shop) {
    return res.status(404).json({ ok: false, message: 'ไม่พบร้านนี้ หรือร้านปิดให้บริการชั่วคราว' });
  }

  const [categories, menus, optionGroups, optionItems, menuGroups] = await Promise.all([
    db.listCategories(shop.id),
    db.listMenus(shop.id),
    db.listOptionGroups(shop.id),
    db.listOptionItems(shop.id),
    db.listMenuOptionGroups(shop.id),
  ]);

  res.json({
    ok: true,
    shop: {
      name: shop.name,
      phone: shop.phone,
      line_url: shop.line_url,
      logo_url: shop.logo_url,
      maps_url: shop.maps_url,
    },
    categories,
    menus,
    optionGroups,
    optionItems,
    menuGroups,
  });
});

// ข้อมูลโต๊ะ + เมนู + บิลที่เปิดอยู่ สำหรับหน้าร้านลูกค้า (/order/:token)
router.get('/api/public/order/:token', async (req, res) => {
  const table = await db.findOrderableTableByToken(String(req.params.token || ''));
  if (!table) {
    return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะนี้ หรือร้านปิดให้บริการชั่วคราว' });
  }

  const [categories, menus, optionGroups, optionItems, menuGroups] = await Promise.all([
    db.listCategories(table.shop_id),
    db.listMenus(table.shop_id),
    db.listOptionGroups(table.shop_id),
    db.listOptionItems(table.shop_id),
    db.listMenuOptionGroups(table.shop_id),
  ]);

  // เปิดบิลให้อัตโนมัติถ้ายังไม่มี (รองรับโต๊ะที่สร้างไว้ก่อนมีระบบบิล) — เพื่อให้มีเลขที่บิลเสมอ
  let open = await db.findOpenOrder(table.shop_id, table.id);
  if (!open) {
    await db.createOrder({ shopId: table.shop_id, tableId: table.id });
    open = await db.findOpenOrder(table.shop_id, table.id);
  }
  const bill = {
    order_id: open ? open.id : null,
    bill_no: open ? (open.bill_no || null) : null,
    total: open ? Number(open.total) : 0,
    items: open ? await db.listOrderItems(open.id) : [],
  };

  res.json({
    ok: true,
    shop: {
      name: table.shop_name, logo_url: table.logo_url, phone: table.phone,
      line_url: table.line_url, maps_url: table.maps_url,
    },
    table: { code: table.code },
    categories, menus, optionGroups, optionItems, menuGroups,
    bill,
  });
});

// ส่งรายการที่สั่งเข้ามาในบิลของโต๊ะ (ต่อเข้าบิลที่เปิดอยู่)
router.post('/api/public/order/:token/items', async (req, res) => {
  const table = await db.findOrderableTableByToken(String(req.params.token || ''));
  if (!table) {
    return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะนี้ หรือร้านปิดให้บริการชั่วคราว' });
  }

  let prepared;
  try {
    prepared = await buildOrderItems(table.shop_id, req.body?.items);
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, message: err.message });
  }

  let order = await db.findOpenOrder(table.shop_id, table.id);
  if (!order) order = { id: await db.createOrder({ shopId: table.shop_id, tableId: table.id }) };

  await db.addOrderItems(order.id, prepared);
  const fresh = await db.findOpenOrder(table.shop_id, table.id);
  const billItems = await db.listOrderItems(order.id);
  console.log(`🍽️ ออเดอร์ใหม่ โต๊ะ ${table.code} (${table.shop_name}) ${prepared.length} รายการ`);

  res.json({
    ok: true,
    message: 'ส่งออเดอร์แล้ว',
    bill: { order_id: order.id, bill_no: fresh.bill_no || null, total: Number(fresh.total), items: billItems },
  });
});

// ลูกค้ายกเลิกรายการ — ทำได้เฉพาะที่ครัวยังไม่เริ่มทำ (status = pending)
router.post('/api/public/order/:token/items/:itemId/cancel', async (req, res) => {
  const table = await db.findOrderableTableByToken(String(req.params.token || ''));
  if (!table) return res.status(404).json({ ok: false, message: 'ไม่พบโต๊ะนี้ หรือร้านปิดให้บริการชั่วคราว' });

  const open = await db.findOpenOrder(table.shop_id, table.id);
  if (!open) return res.status(400).json({ ok: false, message: 'ไม่มีบิลที่เปิดอยู่' });

  const item = await db.findOrderItemOwned(Number(req.params.itemId), table.shop_id);
  if (!item || item.order_id !== open.id) {
    return res.status(404).json({ ok: false, message: 'ไม่พบรายการในบิลนี้' });
  }
  if (item.status !== 'pending') {
    return res.status(400).json({ ok: false, message: item.status === 'cooking' ? 'ยกเลิกไม่ได้ ครัวเริ่มทำแล้ว' : 'ยกเลิกไม่ได้ อาหารเสร็จแล้ว' });
  }

  await db.cancelOrderItem(item.id, open.id, 'ลูกค้ายกเลิก');
  const fresh = await db.findOpenOrder(table.shop_id, table.id);
  const billItems = await db.listOrderItems(open.id);
  console.log(`❌ ยกเลิกรายการ โต๊ะ ${table.code} (${table.shop_name}): ${item.menu_name}`);
  res.json({
    ok: true,
    message: 'ยกเลิกรายการแล้ว',
    bill: { order_id: open.id, bill_no: fresh.bill_no || null, total: Number(fresh.total), items: billItems },
  });
});

module.exports = router;
