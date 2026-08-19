/**
 * theme.js — สลับธีมสว่าง/มืด (บันทึกใน localStorage)
 * โหลดใน <head> เพื่อกันหน้าจอ "กระพริบ" ตอนเปิดหน้า (FOUC)
 */
(function () {
  'use strict';

  var KEY = 'shop-theme';

  function currentTheme() {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
    if (saved === 'light' || saved === 'dark') return saved;
    var prefersDark = window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* ignore */ }

    // อัปเดตไอคอนบนปุ่มสลับธีม
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      var sun = btn.querySelector('.icon-sun');
      var moon = btn.querySelector('.icon-moon');
      if (sun) sun.style.display = theme === 'dark' ? 'block' : 'none';
      if (moon) moon.style.display = theme === 'dark' ? 'none' : 'block';
      btn.setAttribute('aria-label', theme === 'dark' ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด');
      btn.setAttribute('title', theme === 'dark' ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด');
    });
  }

  // ตั้งธีมทันที (รันตอน head ยังไม่แสดงผล body)
  applyTheme(currentTheme());

  // คลิกปุ่มสลับธีม (ใช้ event delegation รองรับหลายปุ่มบนหน้า)
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.theme-toggle') : null;
    if (!btn) return;
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
})();
