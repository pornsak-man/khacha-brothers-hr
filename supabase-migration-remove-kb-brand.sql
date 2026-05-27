-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — ลบแบรนด์ default "KB / Kacha Brothers"
--
-- เหตุผล: "Kacha Brothers" เป็นชื่อบริษัท ไม่ใช่ชื่อแบรนด์สินค้า
-- ระบบขยายไปสู่ multi-brand แล้ว → ไม่ควรมี default brand ที่เป็นชื่อบริษัท
--
-- ขั้นตอน (atomic ใน transaction):
--   1. UPDATE uniform_items: brand='KB' → brand=NULL
--   2. UPDATE uniform_requests: brand_preference='KB' → NULL
--   3. DELETE FROM uniform_brands WHERE code='KB'
--
-- ผลลัพธ์:
--   - Items ที่เคยอยู่ภายใต้ KB → "(ไม่ระบุแบรนด์)" → HR ตั้งใหม่ทีหลัง
--   - Request ที่ระบุ KB → ไม่ระบุแบรนด์ → HR เลือกตอนจัด
--   - SKU เดิม (เช่น "KB-SHRT-M-XXX") คงเดิม — เป็น historical reference
--
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- 1. Clear brand จาก items
WITH affected AS (
  SELECT id FROM public.uniform_items WHERE brand = 'KB'
)
UPDATE public.uniform_items
SET brand = NULL, updated_at = now()
WHERE brand = 'KB';

-- 2. Clear brand_preference จาก requests
UPDATE public.uniform_requests
SET brand_preference = NULL, updated_at = now()
WHERE brand_preference = 'KB';

-- 3. DELETE brand record
DELETE FROM public.uniform_brands WHERE code = 'KB';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ─── Verify ───
DO $$
DECLARE
  v_items_no_brand INT;
  v_requests_no_brand INT;
  v_brands_left INT;
  v_kb_exists BOOLEAN;
BEGIN
  SELECT count(*) INTO v_items_no_brand
    FROM public.uniform_items WHERE brand IS NULL OR brand = '';
  SELECT count(*) INTO v_requests_no_brand
    FROM public.uniform_requests WHERE brand_preference IS NULL;
  SELECT count(*) INTO v_brands_left FROM public.uniform_brands;
  SELECT EXISTS(SELECT 1 FROM public.uniform_brands WHERE code = 'KB') INTO v_kb_exists;

  RAISE NOTICE '✅ ลบแบรนด์ "Kacha Brothers" สำเร็จ';
  RAISE NOTICE '';
  RAISE NOTICE '   uniform_brands เหลือ: % แบรนด์', v_brands_left;
  RAISE NOTICE '   KB ยังอยู่: % (ควรเป็น false)', v_kb_exists;
  RAISE NOTICE '   items ไม่มีแบรนด์: % รายการ → HR ตั้งแบรนด์ใหม่ที่ "แก้ไข" รายการ', v_items_no_brand;
  RAISE NOTICE '   requests ไม่ระบุแบรนด์: % รายการ', v_requests_no_brand;
  RAISE NOTICE '';
  RAISE NOTICE '   ขั้นตอนต่อไป (ที่หน้าเว็บ):';
  RAISE NOTICE '   1. เพิ่มแบรนด์ใหม่ (เมนู "🏷️ แบรนด์")';
  RAISE NOTICE '   2. ไปที่ items ที่ "(ไม่ระบุแบรนด์)" → คลิก "แก้ไข" → เลือกแบรนด์';
END $$;
