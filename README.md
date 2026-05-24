# บริษัท คชา บราเธอร์ส จำกัด — ระบบบริหารทรัพยากรบุคคล

ระบบ HR แบบ Web App (multi-device + realtime) สำหรับ KACHA BROTHERS

## สถาปัตยกรรม

- **Frontend:** Static HTML + Vanilla JS (deploy บน Netlify, ไม่มี build step)
- **Backend:** Supabase (Postgres + Auth + Realtime + Storage)
- **Security:**
  - HTTPS + HSTS + CSP + X-Frame-Options (ดู `netlify.toml`)
  - Subresource Integrity (SRI) สำหรับ CDN scripts
  - hCaptcha invisible สำหรับ login/signup
  - Row-Level Security (RLS) ใน Postgres ปกป้องข้อมูลตาม role
  - bcrypt สำหรับ password (Supabase Auth)

## การเข้าใช้งาน

- **ใครได้บัญชี:** ผู้ดูแลระบบ (admin) สร้างบัญชีให้พนักงานผ่านหน้า "ผู้ใช้และสิทธิ์"
- **Login:** ใช้รหัสพนักงาน + รหัสผ่าน (รหัสเริ่มต้นโดย default = เลขประจำตัวประชาชน, ต้องเปลี่ยนตอนเข้าครั้งแรก)
- **Role hierarchy:** admin / hr / operation_manager / area_manager / branch_manager / branch_staff / viewer

## ฟีเจอร์

- **ภาพรวม:** แดชบอร์ด + ประกาศ/คำสั่ง
- **พนักงาน:** ทะเบียน, รับสมัครงาน, ประเมินผลงาน, การลา, ตารางงาน, ปฏิทินสาขา, วันหยุดประเพณี, จัดชุดพนักงาน, ผู้บังคับบัญชาสาขา
- **องค์กร:** สาขา, ระดับตำแหน่ง, ฝ่าย
- **การเงิน:** ปรับค่าจ้าง, การกู้เงินบริษัท, เบิกเงินล่วงหน้า, เบี้ยเลี้ยงรายเดือน
- **รายงาน & กฎหมาย:** Export, ประกันสังคม, รายชื่อห้ามจ้าง, ประวัติการแก้ไข (audit log)
- **ระบบ:** ผู้ใช้และสิทธิ์, ตั้งค่าระบบ

## โครงสร้างไฟล์

```
kacha-brothers-hr/
├── index.html                          ← shell + login form
├── css/style.css                       ← theme + dark mode
├── js/
│   ├── config.js                       ← Supabase URL + publishable key (ปลอดภัยใน public repo)
│   ├── data.js                         ← Supabase client + cache + realtime
│   └── app.js                          ← page routing + UI + business logic
├── netlify.toml                        ← deployment + security headers
└── supabase-schema.sql                 ← schema หลัก
└── supabase-migration-*.sql            ← schema migrations (รันใน Supabase SQL Editor)
```

## Deploy

- Push ไป `main` → Netlify auto-deploy
- Live: https://pornsak-man.github.io/kacha-brothers-hr/ (GitHub Pages) หรือ Netlify URL

## ข้อมูล + Backup

- ข้อมูลทั้งหมดอยู่ที่ Supabase (Postgres) — sync ทุกอุปกรณ์อัตโนมัติผ่าน Realtime
- Backup: ทำผ่าน Supabase Dashboard (Database → Backups) — Free plan = daily backup เก็บ 7 วัน
