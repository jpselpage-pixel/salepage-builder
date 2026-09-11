/**
 * order-builder.js — ตรวจสอบและคำนวณราคารายการสั่งอาหาร (คิดราคาฝั่งเซิร์ฟเวอร์เสมอ)
 * ใช้ร่วมกันทั้งการสั่งของลูกค้า (public) และการเพิ่มอาหารโดยแคชเชียร์ (shop)
 */
'use strict';

const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * @param {number} shopId
 * @param {Array<{menuId:number, quantity?:number, optionItemIds?:number[]}>} rawItems
 * @returns {Promise<Array>} รายการที่พร้อมบันทึกลง order_items
 */
async function buildOrderItems(shopId, rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw fail('ไม่มีรายการที่สั่ง');
  if (rawItems.length > 50) throw fail('รายการเยอะเกินไปในครั้งเดียว');

  const [menuGroups, optionGroups, optionItems] = await Promise.all([
    db.listMenuOptionGroups(shopId),
    db.listOptionGroups(shopId),
    db.listOptionItems(shopId),
  ]);
  const groupById = {};
  optionGroups.forEach((g) => { groupById[g.id] = g; });
  const itemsByGroup = {};
  optionItems.forEach((i) => { (itemsByGroup[i.group_id] || (itemsByGroup[i.group_id] = [])).push(i); });

  const prepared = [];
  for (const raw of rawItems) {
    const menu = await db.findMenuById(Number(raw?.menuId), shopId);
    if (!menu || Number(menu.available) !== 1) throw fail('มีเมนูที่ไม่พร้อมขายอยู่ในรายการ กรุณาโหลดหน้าใหม่');

    const qty = Math.max(1, Math.min(99, Number(raw?.quantity) || 1));
    const linkedGroupIds = menuGroups.filter((g) => g.menu_id === menu.id).map((g) => g.group_id);
    const selectedIds = (Array.isArray(raw?.optionItemIds) ? raw.optionItemIds : []).map(Number);
    const chosen = [];
    const chosenIds = [];
    let extra = 0;

    for (const gid of linkedGroupIds) {
      const group = groupById[gid];
      if (!group) continue;
      const allowed = itemsByGroup[gid] || [];
      const picked = allowed.filter((i) => selectedIds.includes(i.id));
      if (group.required && picked.length === 0) throw fail(`กรุณาเลือก "${group.name}"`);
      if (!group.multi && picked.length > 1) throw fail(`"${group.name}" เลือกได้อย่างเดียว`);
      picked.forEach((i) => { chosen.push(i.name); chosenIds.push(i.id); extra += Number(i.price_delta) || 0; });
    }

    const unitPrice = round2(Number(menu.price) + extra);
    prepared.push({
      menuId: menu.id,
      menuName: menu.name,
      unitPrice,
      quantity: qty,
      optionsJson: chosen.length ? JSON.stringify(chosen) : null,
      optionsIdsJson: chosenIds.length ? JSON.stringify(chosenIds) : null,
      lineTotal: round2(unitPrice * qty),
    });
  }
  return prepared;
}

module.exports = { buildOrderItems, round2 };
