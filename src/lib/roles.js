/**
 * roles.js — บทบาทผู้ใช้และตัวช่วยตรวจสิทธิ์
 *
 * ลำดับชั้น: user < shop < admin < owner
 *   - owner = เจ้าของระบบ (ผู้จัดการสูงสุด) เข้าได้ทุกอย่างที่แอดมินเข้าได้
 *     และจัดการบัญชี admin/owner ได้ (ตั้ง/ถอดสิทธิ์, ลบ)
 *   - admin = แอดมินแพลตฟอร์ม จัดการผู้ใช้ทั่วไป + ตั้งค่าระบบ แต่แตะบัญชี admin/owner ไม่ได้
 *   - shop  = เจ้าของร้าน (ผู้ซื้อแพ็กเกจ) จัดการร้าน/เมนูของตัวเองเท่านั้น — เข้าหลังบ้านแพลตฟอร์มไม่ได้
 *   - user  = ผู้ใช้ทั่วไป
 */
'use strict';

const ROLES = ['user', 'shop', 'admin', 'owner'];

const ROLE_LABEL = {
  user: 'ผู้ใช้ทั่วไป',
  shop: 'เจ้าของร้าน',
  admin: 'แอดมิน',
  owner: 'เจ้าของระบบ',
};

function isValidRole(role) {
  return ROLES.includes(role);
}

/** เจ้าหน้าที่แพลตฟอร์ม (admin หรือ owner) — เข้า /admin ได้ */
function isAdminRole(role) {
  return role === 'admin' || role === 'owner';
}

function isOwner(role) {
  return role === 'owner';
}

/** เจ้าของร้าน (ผู้ซื้อแพ็กเกจ) */
function isShop(role) {
  return role === 'shop';
}

module.exports = { ROLES, ROLE_LABEL, isValidRole, isAdminRole, isOwner, isShop };
