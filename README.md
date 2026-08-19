# 🛍️ SalePage Builder — เว็บบริการสร้างเซลเพจออนไลน์

เว็บไซต์บริการสร้างเซลเพจ (Sale Page) สำหรับขายของออนไลน์ + ระบบสมาชิกครบวงจร สร้างด้วย **Node.js + Express + SQLite** (ไม่มี MySQL/Python ให้ติดตั้ง)

## ✨ ฟีเจอร์

### หน้าแรก (`/` — Landing Page โปรโมตบริการ)
- Hero + mockup เซลเพจจำลอง + สถิติ + ฟีเจอร์ 6 ด้าน + วิธีใช้งาน 3 ขั้นตอน + ตัวอย่างธีม + ราคา + FAQ + CTA
- ปุ่มในแถบเมนูเปลี่ยนตามสถานะล็อกอิน (เข้าสู่ระบบ/สมัครสมาชิก ↔ บัญชีของฉัน)
- ธีมสว่าง/มืด + เมนูมือถือ + แอนิเมชัน fade-up เมื่อเลื่อนหน้า

### Dashboard และตั้งค่า (หลังล็อกอิน)
- เมนูหมวดหมู่ด้านซ้าย: **Dashboard** (เพจ) + **ตั้งค่า** (โปรไฟล์ / ความปลอดภัย) — URL แยกตามหมวดหมู่:
  - `/dashboard/pages` — รายการเซลเพจของฉัน (หมวด Dashboard)
  - `/settings/profile` — ข้อมูลผู้ใช้ + สถานะยืนยันเบอร์/อีเมล + ปุ่มส่งลิงก์ยืนยันอีเมลใหม่ + ลิงก์เข้าระบบหลังบ้าน (แอดมิน)
  - `/settings/security` — เปลี่ยนรหัสผ่าน (ตรวจรหัสเดิม + ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้) + ออกจากระบบทุกเครื่อง + ออกจากระบบ
- ต้องล็อกอินก่อนเข้าถึง (redirect ไปหน้า login) — หลังล็อกอิน/สมัครเสร็จระบบจะพามาที่ `/dashboard/pages`

### ระบบสร้างเซลเพจ (Page Builder)
- **สร้างเพจ**: `/dashboard/pages/new` — ตั้งชื่อเพจ + ตรวจชื่อซ้ำอัตโนมัติ (slug ไม่ซ้ำทั่วระบบ) + ลิมิตแพ็กเกจฟรี 1 เพจ
- **ตัวสร้างเพจ**: `/dashboard/pages/:id/editor` — ผ้าใบ 375px + แถบเครื่องมือซ้าย (ข้อความ/ปุ่ม/รูปภาพ/ราคา) + ลากย้าย/ปรับขนาด + แผงเลเยอร์/คุณสมบัติขวา
- **เผยแพร่**: เพจเป็นฉบับร่างจนกว่ากด "เผยแพร่" → หน้า `/p/:slug` แสดงให้ทุกคนเห็น (draft จะเห็นข้อความ "ยังไม่เผยแพร่")
- เนื้อหาเพจเก็บเป็น JSON ในตาราง `pages.content` — เจ้าของเพจเท่านั้นแก้ไขได้

### หน้าสมัครสมาชิก (`register.html`)
- กรอกอีเมล รหัสผ่าน ยืนยันรหัสผ่าน เบอร์โทรศัพท์
- ✅ ตรวจรูปแบบอีเมล + **ปุ่มตรวจสอบอีเมลซ้ำ** (เรียก API real-time)
- ✅ ตัววัดความแข็งแรงรหัสผ่าน (ต้อง ≥ 8 ตัว และผ่าน ≥ 3 เกณฑ์)
- ✅ ตรวจยืนยันรหัสผ่านให้ตรงกัน
- ✅ ตรวจเบอร์โทรไทย (ขึ้นต้น 0, 9–10 หลัก)
- ✅ บังคับยอมรับข้อกำหนด PDPA
- 👁️ ปุ่มแสดง/ซ่อนรหัสผ่าน

### ระบบ OTP ยืนยันเบอร์โทร (`otp.html`)
- กล่องกรอกรหัส 6 หลัก เลื่อนช่องอัตโนมัติ
- นับถอยหลัง 60 วินาทีก่อนส่งรหัสใหม่
- จำกัดการกรอกรหัสผิด (5 ครั้ง) / อายุรหัส 5 นาที

### เข้าสู่ระบบ (`login.html`)
- ล็อกอินด้วยอีเมล + รหัสผ่าน (ต่อ API จริง)
- ล็อกอินอัตโนมัติทันทีหลังยืนยัน OTP

### เข้าสู่ระบบด้วย Google (`login.html` → ปุ่ม Google)
- **ล็อกอินด้วย Google ครั้งแรก** (ยังไม่เคยสมัคร): พาไปหน้า `google-setup.html` ตั้งรหัสผ่าน (2 ช่อง) + เบอร์โทร + ยืนยัน OTP → สมัครเสร็จ
- **อีเมลตรงบัญชีที่สมัครไว้แล้ว** → เข้าบัญชีเดิมทันที (ไม่ต้องกรอกรหัสผ่าน) — ล็อกอินอีเมล+รหัสผ่านก็ยังใช้ได้
- **หยุดสมัครกลางคัน** → กลับมา Google ล็อกอินใหม่ได้ (ต่อจากเดิม) + ใช้ฟังก์ชันลืมรหัสผ่านไม่ได้ (ถือว่า "ไม่มีผู้ใช้")
- **อีเมลถือว่ายืนยันแล้ว** ทันที (Google ยืนยันให้ ไม่ต้องกดยืนยันผ่านเมล์)
- โหมดทดสอบ (dev): ยังไม่มี `GOOGLE_CLIENT_ID` → ปุ่ม Google ไปหน้า mock (`google-login.html`) กรอกอีเมลจำลองได้ทันที
- วิธีตั้ง OAuth จริง: ดูหัวข้อ "🔌 วิธีต่อ service จริง" ด้านล่าง

### ลืมรหัสผ่าน (`forgot.html`)
- กู้รหัสผ่านด้วย **OTP ทางอีเมล** — 3 ขั้นตอน: กรอกอีเมล → ยืนยัน OTP → ตั้งรหัสใหม่
- กัน spam ขอ OTP (60 วินาที/ครั้ง) + ตอบเหมือนกันแม้อีเมลไม่มีในระบบ (กันการเดาอีเมล)
- โทเคนยืนยันอายุ 10 นาที + ออกจากระบบทุกเครื่องอัตโนมัติหลังเปลี่ยนรหัส

### ระบบหลังบ้านแอดมิน (`/admin/`) — เฉพาะแอดมิน
- **บัญชีแอดมิน**: `admin@gmail.com` / `123456` (ตั้งค่าได้ผ่าน `ADMIN_EMAIL`/`ADMIN_PASSWORD` ใน `.env` — ⚠️ 123456 เป็นรหัสทดสอบ ควรเปลี่ยนเป็นรหัสแข็งแรงก่อนใช้งานจริง)
- หน้า `/admin/*` และ API `/api/admin/*` ตรวจสิทธิ์ `role = admin` — ผู้ใช้ธรรมดาโดน 403, ไม่ได้ล็อกอินโดน redirect ไป login
- **ภาพรวม** (`/admin/`): สถิติผู้ใช้ + OTP ล่าสุด
- **จัดการ SMS-OTP** (`/admin/otp.html`):
  - สถานะระบบ SMS: โหมด dev/production, Twilio, SMTP
  - ตั้งค่า OTP แบบ real-time: อายุรหัส, จำนวนลองผิด, สลับ dev mode (ไม่ต้องรีสตาร์ท)
  - **ตั้งค่า SMS จริง**: เลือก provider (Twilio / ThaiBulkSMS) + ทดสอบส่ง
  - **ตั้งค่า SMTP (อีเมลจริง)**: ใช้กับลิงก์ยืนยันอีเมล + OTP กู้รหัสผ่านทางอีเมล + ทดสอบส่ง
  - รายการ OTP ทั้งหมด + ค้นหา + ปุ่ม "ส่ง OTP ใหม่" ให้ผู้ใช้ (แสดงรหัส dev ในโหมดทดสอบ)

### หน้าแรก (`/` — Landing Page) และ Dashboard (`/dashboard/*`)
- หน้าแรกเป็นหน้าโปรโมตบริการสร้างเซลเพจ (ดูหัวข้อแรก) — หลังล็อกอิน/สมัครเสร็จระบบจะพาไป `/dashboard/pages`
- แอดมินล็อกอินแล้วไปหน้า `/admin/` โดยตรง

### ความปลอดภัย
- 🔒 รหัสผ่านแฮชด้วย **bcrypt** (cost 10) — ไม่เก็บ plain text
- 🔒 session ด้วย token สุ่ม + คุกกี้ httpOnly SameSite=Lax
- 🔒 honeypot + ตรวจเวลากรอกฟอร์ม + rate limit ต่อ IP กันบอท
- 🔒 รองรับ **Google reCAPTCHA v2** (เปิดเมื่อตั้ง key)
- 📄 หน้า `privacy.html` (นโยบาย PDPA)

## 🚀 วิธีรัน

```bash
# 1. ติดตั้ง dependencies (ทำครั้งเดียว)
npm install

# 2. ตั้งค่า config
cp .env.example .env    # แก้ไขได้ตามต้องการ (ขั้นต่ำแค่เปลี่ยน SESSION_SECRET)

# 3. รันเซิร์ฟเวอร์
npm start               # หรือ npm run dev (auto-restart เมื่อแก้โค้ด)
```

เปิดเบราว์เซอร์ที่ `http://localhost:3000`

## 🧪 โหมดทดสอบ (DEV_MODE=true)

ในโหมด dev ระบบ **ยังไม่ได้ส่ง SMS/อีเมลจริง** แต่จะแสดงที่ **console ของเซิร์ฟเวอร์** และบนหน้าเว็บ:
- 📱 รหัส OTP → แสดงบนหน้า `otp.html` (กล่องเขียว "โหมดทดสอบ")
- 📧 ลิงก์ยืนยันอีเมล → แสดงบนหน้าแรกหลังกด "ส่งลิงก์ยืนยันอีเมล"

## 🔌 วิธีต่อ service จริง (เมื่อพร้อมขึ้น production)

### 1. SMS ส่ง OTP จริง — ไฟล์ `otp.js`
- ไปที่ฟังก์ชัน `sendOtpSms()` และใช้ service อย่าง **Twilio** (มี TODO ตัวอย่างในโค้ด)
- ใส่ `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE` ใน `.env`

### 2. ส่งอีเมลจริง — ไฟล์ `mailer.js`
- ไปที่ฟังก์ชัน `sendEmail()` และใช้ **nodemailer** + SMTP (มี TODO ตัวอย่างในโค้ด)
- ใส่ `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` ใน `.env`

### 3. Google reCAPTCHA — เปิดเมื่อตั้ง key
- ไปที่ https://www.google.com/recaptcha/admin สร้าง site ใหม่ (reCAPTCHA v2 checkbox)
- ใส่ `RECAPTCHA_SITE_KEY` และ `RECAPTCHA_SECRET_KEY` ใน `.env`
- เมื่อตั้งแล้วหน้า register จะโหลด reCAPTCHA อัตโนมัติและบังคับตรวจสอบ

### 4. Google Login (OAuth จริง) — เปิดเมื่อตั้ง key
- ไปที่ https://console.cloud.google.com/apis/credentials → สร้าง OAuth Client ID (ชนิด Web application)
- ตั้ง **Authorized redirect URIs** = `http://localhost:3000/api/auth/google/callback` (หรือโดเมนจริงของคุณ)
- ใส่ `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` ใน `.env`
- เมื่อตั้งแล้วปุ่ม Google จะ redirect ไป Google จริง (แทนหน้า mock dev)

### 4. ปิดโหมด dev
```env
DEV_MODE=false
```
เมื่อปิด ระบบจะ**ไม่แสดงรหัส OTP/ลิงก์บนหน้าเว็บอีกต่อไป** (มีเฉพาะใน console)

## 🔒 หมายเหตุ HTTPS

- การพัฒนาท้องถิ่นรันบน `http://localhost` ได้ตามปกติ
- **การขึ้น production ต้องใช้ HTTPS เสมอ** (ผ่านผู้ให้บริการโฮสติ้ง / Cloudflare / Let's Encrypt)
  เพื่อไม่ให้รหัสผ่านและคุกกี้ session เดินทางเป็นข้อความธรรมดา
- เมื่อใช้ HTTPS ให้ตั้ง `COOKIE_SECURE=true` ใน `.env` เพื่อให้คุกกี้ถูกส่งผ่าน HTTPS เท่านั้น

## 📁 โครงสร้างไฟล์

```
├── server.js          # Express server + API ทั้งหมด
├── db.js              # ฐานข้อมูล SQLite (node:sqlite ในตัว Node)
├── otp.js             # สร้าง/ตรวจ OTP (จุดต่อ SMS จริง)
├── mailer.js          # ส่งลิงก์ยืนยันอีเมล (จุดต่อ SMTP จริง)
├── .env / .env.example # config
├── package.json
├── shop.db            # ไฟล์ฐานข้อมูล (สร้างอัตโนมัติ)
└── public/
    ├── index.html     # หน้าแรก — Landing Page บริการสร้างเซลเพจ
    ├── dashboard/     # หน้า Dashboard (pages/profile/security)
    ├── login.html     # เข้าสู่ระบบ
    ├── register.html  # สมัครสมาชิก
    ├── otp.html       # ยืนยันเบอร์ด้วย OTP
    ├── privacy.html   # นโยบายความเป็นส่วนตัว (PDPA)
    ├── css/
    │   ├── style.css  # Design system + ธีมสว่าง/มืด
    │   └── landing.css # สไตล์หน้า Landing Page
    └── js/theme.js    # สลับธีม
```

## 📡 API endpoints

| Method | Path | คำอธิบาย |
|---|---|---|
| POST | `/api/register` | สมัครสมาชิก (สร้างผู้ใช้ pending + OTP) |
| POST | `/api/verify-otp` | ยืนยัน OTP → activate + ล็อกอินอัตโนมัติ |
| POST | `/api/resend-otp` | ขอ OTP ใหม่ (จำกัด 60 วิ) |
| GET | `/api/check-email` | ตรวจอีเมลซ้ำ |
| POST | `/api/login` | เข้าสู่ระบบ |
| GET | `/api/auth/google/url` | เปิด URL ล็อกอิน Google (dev: หน้า mock) |
| GET | `/api/auth/google/callback` | Callback OAuth Google (จริง) |
| POST | `/api/auth/google/mock` | (dev) จำลองล็อกอิน Google |
| POST | `/api/google-setup/send-otp` | ส่ง OTP ยืนยันเบอร์ (Google setup) |
| POST | `/api/google-setup/complete` | ตั้งรหัส+เบอร์+OTP → สมัครเสร็จ |
| POST | `/api/logout` | ออกจากระบบ |
| GET | `/api/me` | ข้อมูลผู้ใช้ปัจจุบัน |
| POST | `/api/send-verify-email` | ส่งลิงก์ยืนยันอีเมลใหม่ |
| POST | `/api/forgot-password` | ขอ OTP กู้รหัสผ่าน (ส่งทางอีเมล) |
| POST | `/api/forgot-verify-otp` | ตรวจ OTP กู้รหัสผ่าน → คืน reset token |
| POST | `/api/forgot-reset-password` | ตั้งรหัสผ่านใหม่ (ใช้ reset token) |
| POST | `/api/change-password` | (ล็อกอิน) เปลี่ยนรหัสผ่าน + ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้ |
| POST | `/api/logout-all` | (ล็อกอิน) ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้ |
| GET | `/api/pages/check-slug?slug=` | (ล็อกอิน) ตรวจชื่อเพจว่าง/ซ้ำ |
| GET | `/api/pages` | (ล็อกอิน) รายการเพจของฉัน |
| POST | `/api/pages` | (ล็อกอิน) สร้างเพจใหม่ (เช็คลิมิตแพ็กเกจ) |
| GET | `/api/pages/:id` | (ล็อกอิน เจ้าของ) โหลดเนื้อหาเพจ |
| PUT | `/api/pages/:id` | (ล็อกอิน เจ้าของ) เซฟเนื้อหาเพจ (JSON) |
| POST | `/api/pages/:id/publish` | (ล็อกอิน เจ้าของ) เผยแพร่เพจ |
| GET | `/p/:slug` | หน้าแสดงเพจสาธารณะ (เฉพาะที่เผยแพร่แล้ว) |
| GET | `/api/admin/stats` | (แอดมิน) สถิติภาพรวม |
| GET | `/api/admin/otp-logs` | (แอดมิน) รายการ OTP ทั้งหมด |
| POST | `/api/admin/otp/resend` | (แอดมิน) ส่ง OTP ใหม่ให้ผู้ใช้ |
| GET | `/api/admin/sms-status` | (แอดมิน) สถานะระบบ SMS-OTP |
| POST | `/api/admin/settings` | (แอดมิน) ตั้งค่า OTP (TTL/attempts/dev mode) |
| GET | `/verify-email?token=` | ยืนยันอีเมล (จากลิงก์ในอีเมล) |
| GET | `/api/config` | config ที่หน้าเว็บใช้ (reCAPTCHA key, devMode) |

## ⚠️ หมายเหตุ

- `SESSION_SECRET` ใน `.env` ควรเปลี่ยนเป็นค่าสุ่มยาว ๆ ก่อนใช้งานจริง
- rate limit เก็บในหน่วยความจำ (เหมาะกับขนาดเล็ก — ถ้าจะ scale ใช้ Redis)
- session เก็บในตาราง SQLite (เหมาะกับ dev — production ใช้ Redis/store ภายนอกได้)
