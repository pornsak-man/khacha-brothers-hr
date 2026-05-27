-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Uniform Issues: เก็บ snapshot brand/color/sku
--
-- ปัญหา:
--   - uniform_issues เก็บแค่ item_name + size (snapshot)
--   - ถ้า uniform_items ถูกลบ/แก้ → ประวัติเก่าไม่รู้ brand/color/sku อย่างไร
--   - ไม่สามารถ filter ประวัติย้อนหลังตาม brand แบบ accurate
--
-- แก้:
--   - เพิ่ม cols: brand_snapshot, color_snapshot, sku_snapshot
--   - Trigger BEFORE INSERT/UPDATE: auto-fill snapshot จาก item ถ้า user ไม่ระบุ
--   - Backfill row เก่า: ดึง brand/color/sku จาก uniform_items
--
-- รันใน Supabase SQL Editor (idempotent)
-- ═══════════════════════════════════════════════════════════

-- ─── เพิ่ม snapshot columns ───
ALTER TABLE public.uniform_issues
  ADD COLUMN IF NOT EXISTS brand_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS color_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS sku_snapshot   TEXT,
  ADD COLUMN IF NOT EXISTS category_snapshot TEXT;

CREATE INDEX IF NOT EXISTS idx_uniform_issues_brand    ON public.uniform_issues(brand_snapshot);
CREATE INDEX IF NOT EXISTS idx_uniform_issues_category ON public.uniform_issues(category_snapshot);

-- ─── Trigger function: auto-fill snapshot from item ───
-- ทำงาน BEFORE INSERT/UPDATE ก่อน stock trigger
CREATE OR REPLACE FUNCTION public.uniform_issues_fill_snapshot()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand    TEXT;
  v_category TEXT;
  v_color    TEXT;
  v_sku      TEXT;
  v_name     TEXT;
  v_size     TEXT;
  v_cost     NUMERIC;
BEGIN
  -- ถ้าระบุ item_id → ดึง snapshot ที่ขาดจาก master
  IF NEW.item_id IS NOT NULL THEN
    SELECT brand, category, color, sku, name, size, unit_cost
      INTO v_brand, v_category, v_color, v_sku, v_name, v_size, v_cost
    FROM public.uniform_items WHERE id = NEW.item_id;

    -- fill เฉพาะที่ NULL (เคารพค่าที่ user ส่งมา)
    NEW.brand_snapshot    := COALESCE(NEW.brand_snapshot, v_brand);
    NEW.category_snapshot := COALESCE(NEW.category_snapshot, v_category);
    NEW.color_snapshot    := COALESCE(NEW.color_snapshot, v_color);
    NEW.sku_snapshot      := COALESCE(NEW.sku_snapshot, v_sku);
    NEW.item_name         := COALESCE(NEW.item_name, v_name);
    NEW.size              := COALESCE(NEW.size, v_size);
    -- ราคา snapshot — ใช้ราคาตอนจัด (frozen) ถ้า user ไม่ระบุก็ใช้ราคาปัจจุบัน
    IF NEW.unit_cost IS NULL OR NEW.unit_cost = 0 THEN
      NEW.unit_cost := v_cost;
    END IF;
    -- total_cost = qty × unit_cost
    NEW.total_cost := COALESCE(NEW.qty, 0) * COALESCE(NEW.unit_cost, 0);
  END IF;

  RETURN NEW;
END $$;

-- Trigger ทำงาน BEFORE INSERT/UPDATE — ก่อน stock trigger (ลำดับชื่อ alphabet)
-- ตั้งชื่อขึ้นต้นด้วย 'a' เพื่อให้ทำงานก่อน trg_uniform_issues_stock
DROP TRIGGER IF EXISTS a_uniform_issues_fill_snapshot ON public.uniform_issues;
CREATE TRIGGER a_uniform_issues_fill_snapshot
  BEFORE INSERT OR UPDATE ON public.uniform_issues
  FOR EACH ROW
  EXECUTE FUNCTION public.uniform_issues_fill_snapshot();

-- ─── Backfill row เก่าที่ยังไม่มี snapshot ───
UPDATE public.uniform_issues ui
SET
  brand_snapshot    = COALESCE(ui.brand_snapshot, itm.brand),
  category_snapshot = COALESCE(ui.category_snapshot, itm.category),
  color_snapshot    = COALESCE(ui.color_snapshot, itm.color),
  sku_snapshot      = COALESCE(ui.sku_snapshot, itm.sku)
FROM public.uniform_items itm
WHERE ui.item_id = itm.id
  AND (ui.brand_snapshot IS NULL OR ui.brand_snapshot = '');

NOTIFY pgrst, 'reload schema';

-- ─── Verify ───
DO $$
DECLARE
  v_total INT;
  v_with_brand INT;
  v_trigger_count INT;
BEGIN
  SELECT count(*) INTO v_total FROM public.uniform_issues;
  SELECT count(*) INTO v_with_brand FROM public.uniform_issues
    WHERE brand_snapshot IS NOT NULL AND brand_snapshot != '';
  SELECT count(*) INTO v_trigger_count FROM pg_trigger
    WHERE tgrelid = 'public.uniform_issues'::regclass AND NOT tgisinternal;

  RAISE NOTICE '✅ Uniform Issues Snapshot ติดตั้งแล้ว';
  RAISE NOTICE '';
  RAISE NOTICE '   uniform_issues ทั้งหมด: % รายการ', v_total;
  RAISE NOTICE '   ─ มี brand snapshot: % / % (%.0f%%)', v_with_brand, v_total, (v_with_brand::FLOAT / NULLIF(v_total, 0)) * 100;
  RAISE NOTICE '';
  RAISE NOTICE '   Triggers บน uniform_issues: %', v_trigger_count;
  RAISE NOTICE '   - a_uniform_issues_fill_snapshot (BEFORE — fill brand/sku/color)';
  RAISE NOTICE '   - trg_uniform_issues_stock (BEFORE — atomic stock deduct)';
  RAISE NOTICE '';
  RAISE NOTICE '   ผลที่ได้:';
  RAISE NOTICE '   - ประวัติเก่าเก็บ brand context แม้ item ถูกลบ';
  RAISE NOTICE '   - filter ประวัติตาม brand ทำงาน accurate';
END $$;
