/**
 * rate-limit.js — จำกัดจำนวนคำขอต่อ IP (กันบอท)
 */
'use strict';

// ---------------------------------------------------------------------------
// Rate limit ต่อ IP (กันบอท) — พอเพียงสำหรับ dev/production ขนาดเล็ก
// ---------------------------------------------------------------------------
const rateMap = new Map();

function rateLimit(req, { max, windowMs }) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const rec = rateMap.get(key);
  if (!rec || rec.resetAt <= now) {
    rateMap.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false };
  }
  rec.count += 1;
  if (rec.count > max) {
    return { limited: true, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  }
  return { limited: false };
}

// ล้าง cache rate limit ทิ้งเป็นระยะ
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of rateMap) {
    if (rec.resetAt <= now) rateMap.delete(key);
  }
}, 10 * 60 * 1000).unref();

module.exports = { rateLimit };
