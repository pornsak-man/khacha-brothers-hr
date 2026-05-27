# Uniform Stock — Migration Checklist

ตรวจสอบลำดับการรัน SQL migration ของระบบ Uniform Stock อย่างเป็นทางการ

## 📋 ลำดับการรัน (ห้ามสลับ!)

รันที่ **Supabase SQL Editor** ตามลำดับ:

### ⓵ Foundation (ตารางหลัก)
- [ ] `supabase-migration-uniform.sql`
  - สร้าง `uniform_items`, `uniform_requests`, `uniform_issues`
  - Seed รายการตัวอย่าง

### ⓶ Schedule (รอบการจัดส่ง)
- [ ] `supabase-migration-uniform-schedule.sql`

### ⓷ Applicant link (เชื่อม recruit)
- [ ] `supabase-migration-uniform-applicant-link.sql`
  - เพิ่ม `applicant_id` ใน `uniform_requests`

### ⓸ Request type (ฟรี/เสียเงิน)
- [ ] `supabase-migration-uniform-request-type.sql`
  - เพิ่ม `request_type`, `request_reason`

### ⓹ Self-service RLS (พนักงานยื่นเอง)
- [ ] `supabase-migration-uniform-self-rls.sql`

### ⓺ Stock Trigger (atomic deduct)
- [ ] `supabase-migration-uniform-stock-trigger.sql`
  - Trigger ตัด stock อัตโนมัติ + check stock พอ

### ⓻ Stock Movements (ledger)
- [ ] `supabase-migration-uniform-stock-movements.sql`
  - ตาราง `uniform_stock_movements` (immutable log)
  - **Replace** trigger เดิมให้ log ทุก movement
  - RPC `receive_uniform_stock()`, `adjust_uniform_stock_manual()`

### ⓼ Modern Inventory (multi-brand)
- [ ] `supabase-migration-uniform-modern-inventory.sql`
  - เพิ่ม `brand`, `category`, `color`, `sku`, `reorder_point`, etc.
  - ตาราง `uniform_brands` (master)
  - Backfill brand='KB', auto-gen SKU

### ⓽ Issues Snapshot (multi-brand history)
- [ ] `supabase-migration-uniform-issues-snapshot.sql`
  - เพิ่ม snapshot cols ใน `uniform_issues`
  - Trigger fill snapshot จาก item (BEFORE — รัน 'a' prefix ก่อน stock trigger)
  - Backfill ประวัติเก่า

### ⓾ Stock Trigger Final Fix
- [ ] `supabase-migration-uniform-stock-trigger-fix.sql`
  - Fix DELETE trigger — เก็บ issue_id ใน note (audit trail)

---

## 🔍 วิธีตรวจสอบว่ารันครบ

รันคำสั่งนี้ใน SQL Editor:

```sql
-- ตรวจสถานะ schema
SELECT
  -- ตรงนี้เช็คทุก feature ที่ควรมี
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'uniform_items'
    AND column_name IN ('brand', 'category', 'color', 'sku', 'reorder_point', 'supplier', 'gender', 'material', 'image_url', 'sort_order')) AS items_modern_cols,  -- ควร = 10
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'uniform_issues'
    AND column_name IN ('brand_snapshot', 'color_snapshot', 'sku_snapshot', 'category_snapshot')) AS issues_snapshot_cols,  -- ควร = 4
  (SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('uniform_brands', 'uniform_stock_movements')) AS modern_tables,  -- ควร = 2
  (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = 'public.uniform_issues'::regclass AND NOT tgisinternal) AS triggers,  -- ควร >= 3 (snapshot, stock, updated_at)
  (SELECT COUNT(*) FROM pg_proc WHERE proname IN ('receive_uniform_stock', 'adjust_uniform_stock_manual', 'uniform_issues_stock_trigger', 'uniform_issues_fill_snapshot')) AS funcs;  -- ควร = 4
```

ผลที่คาดหวัง: ค่าทุกคอลัมน์ = ที่ comment ข้างล่าง

---

## ✅ Test End-to-End หลังรันครบ

1. **Brand:** ไปแท็บ "รายการชุด · Stock" → "🏷️ แบรนด์" → เพิ่ม "TEST" → ลบ
2. **Item:** "+ เพิ่มรายการชุด" → กรอกแบรนด์/หมวด/สี/SKU → บันทึก
3. **Receive Stock:** "+ รับเข้า Stock" → เลือก item → ใส่ 50 → เลือกเหตุผล → กด → ดู Stock เพิ่ม 50
4. **Issue:** สร้าง uniform_request → จัดชุด → Stock ตัดลง
5. **Movement ledger:** แท็บ "ความเคลื่อนไหว Stock" → เห็น receive + issue
6. **History:** แท็บ "ประวัติการจัดส่ง" → เห็น brand badge + SKU
7. **Self-service:** Login พนักงาน → "ขอชุดของฉัน" → ยื่นคำขอ → กลับเป็น HR เห็น
8. **Adjust:** ปุ่ม "ปรับ" บน item → ใส่จำนวนใหม่ → เลือกเหตุผล → ดู movement type=adjust
9. **Historical:** เลือก date ย้อนหลัง → ดู stock ณ วันนั้น
10. **Monthly report:** ปุ่ม "📊 รายงานรายเดือน" → เลือกเดือน → Export Excel

---

## 🛡️ Rollback (ฉุกเฉิน)

ถ้า migration ทำให้ระบบพัง ใช้:

```sql
-- ลบทุก feature ใหม่ (กลับสู่ Phase Foundation)
DROP TRIGGER IF EXISTS a_uniform_issues_fill_snapshot ON public.uniform_issues;
DROP TRIGGER IF EXISTS trg_uniform_issues_stock ON public.uniform_issues;
DROP FUNCTION IF EXISTS public.uniform_issues_fill_snapshot();
DROP FUNCTION IF EXISTS public.uniform_issues_stock_trigger();
DROP FUNCTION IF EXISTS public.receive_uniform_stock(UUID, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.adjust_uniform_stock_manual(UUID, INTEGER, TEXT, TEXT);
-- ⚠ ลบตารางก็จะลบข้อมูล — ใช้เฉพาะถ้าต้องการ reset เท่านั้น
-- DROP TABLE IF EXISTS public.uniform_stock_movements;
-- DROP TABLE IF EXISTS public.uniform_brands;
```

---

## 📊 ภาพรวมสถาปัตยกรรม

```
                   ┌─────────────────────────┐
                   │   uniform_brands        │
                   │   (master แบรนด์)        │
                   └────────────┬────────────┘
                                │ brand FK (text)
                                ▼
┌─────────────────┐    ┌────────────────────┐
│  uniform_items  │◄──┤ brand, category,    │
│  + stock_qty    │    │ color, sku, ...     │
└────────┬────────┘    └────────────────────┘
         │
         │ item_id FK
         ▼
┌─────────────────────────────────────────────┐
│  uniform_issues (จัดให้พนักงาน)              │
│  + qty, unit_cost                            │
│  + brand_snapshot, color_snapshot, sku_*     │←─ trigger #1: fill snapshot
│  ↓ on INSERT/UPDATE/DELETE                   │
│  trigger #2: stock_trigger                   │
└────────┬────────────────────────────────────┘
         │
         │ ref_issue_id
         ▼
┌─────────────────────────────────────────────┐
│  uniform_stock_movements (ledger immutable) │
│  receive / issue / return / adjust          │
│  delta (+/-), balance_after, reason, by     │
└─────────────────────────────────────────────┘

Flow ตัวอย่าง (HR จัดให้พนักงาน):
  1. INSERT INTO uniform_issues (item_id, qty, ...)
  2. → Trigger#1 (BEFORE): fill brand/color/sku จาก uniform_items
  3. → Trigger#2 (BEFORE): LOCK item → check stock → UPDATE stock_qty -= qty
  4. → Trigger#2: INSERT INTO uniform_stock_movements (type='issue', delta=-qty)
  5. → Realtime push → frontend อัพเดททั่วระบบ
```
