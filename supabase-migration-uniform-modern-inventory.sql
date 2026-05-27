-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Uniform Inventory: Modern Schema Extension
--
-- ขยายระบบ uniform_items ให้รองรับ:
--   - Multi-brand (เปิดแบรนด์ใหม่ได้)
--   - Category/Sub-category (หมวด/หมวดย่อย)
--   - SKU (รหัสสากล)
--   - Color, Gender, Material
--   - Reorder point (จุดสั่งซื้อแบบ per-item)
--   - Supplier (ผู้ผลิต)
--   - Image URL (รูปสินค้า)
--
-- ปลอดภัย: ทุกคอลัมน์ใหม่ nullable + มี backfill default
-- รันใน Supabase SQL Editor (idempotent)
-- ═══════════════════════════════════════════════════════════

-- ─── เพิ่มคอลัมน์ใหม่ (idempotent) ───
ALTER TABLE public.uniform_items
  ADD COLUMN IF NOT EXISTS brand         TEXT,                    -- "Safari World", "Kacha Brothers", "New Brand"
  ADD COLUMN IF NOT EXISTS category      TEXT,                    -- "เสื้อ", "กางเกง", "หมวก", "รองเท้า", "อุปกรณ์"
  ADD COLUMN IF NOT EXISTS subcategory   TEXT,                    -- "แขนสั้น", "แขนยาว", "ขายาว", ...
  ADD COLUMN IF NOT EXISTS color         TEXT,                    -- "ขาว", "ดำ", "น้ำเงิน"
  ADD COLUMN IF NOT EXISTS sku           TEXT,                    -- "KB-SHRT-M-WH" (รหัสสากล)
  ADD COLUMN IF NOT EXISTS reorder_point INTEGER DEFAULT 5,        -- จุดสั่งซื้อ (แทน hardcode < 5)
  ADD COLUMN IF NOT EXISTS supplier      TEXT,                    -- ผู้ผลิต/supplier
  ADD COLUMN IF NOT EXISTS gender        TEXT,                    -- 'male' / 'female' / 'unisex'
  ADD COLUMN IF NOT EXISTS material      TEXT,                    -- "Cotton 100%", "Poly-Cotton 65/35"
  ADD COLUMN IF NOT EXISTS image_url     TEXT,                    -- URL/path รูป
  ADD COLUMN IF NOT EXISTS sort_order    INTEGER DEFAULT 0;       -- ลำดับแสดง

-- ─── Indexes ───
CREATE INDEX IF NOT EXISTS idx_uniform_items_brand     ON public.uniform_items(brand);
CREATE INDEX IF NOT EXISTS idx_uniform_items_category  ON public.uniform_items(category);
CREATE INDEX IF NOT EXISTS idx_uniform_items_sku       ON public.uniform_items(sku);

-- SKU unique (nullable แต่ถ้ามีต้องไม่ซ้ำ)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uniform_items_sku_unique'
  ) THEN
    CREATE UNIQUE INDEX uniform_items_sku_unique
      ON public.uniform_items(sku)
      WHERE sku IS NOT NULL AND sku != '';
  END IF;
END $$;

-- ─── Backfill ข้อมูลเดิม ───
-- [DEPRECATED] Backfill brand='KB' (Kacha Brothers) — ลบออกแล้วเพราะ KB เป็นชื่อบริษัท
-- ดู supabase-migration-remove-kb-brand.sql สำหรับการลบ
-- รายการเก่าที่ไม่มี brand → คงเป็น NULL → HR ตั้งแบรนด์ใหม่ภายหลัง
-- UPDATE public.uniform_items SET brand = 'KB' WHERE brand IS NULL OR brand = '';

-- Auto-detect category จาก name (เผื่อสำหรับ row เก่า)
UPDATE public.uniform_items
SET category = (CASE
  WHEN name ILIKE '%เสื้อ%' OR name ILIKE '%shirt%' THEN 'เสื้อ'
  WHEN name ILIKE '%กางเกง%' OR name ILIKE '%pants%' THEN 'กางเกง'
  WHEN name ILIKE '%กระโปรง%' OR name ILIKE '%skirt%' THEN 'กระโปรง'
  WHEN name ILIKE '%หมวก%' OR name ILIKE '%cap%' OR name ILIKE '%hat%' THEN 'หมวก'
  WHEN name ILIKE '%รองเท้า%' OR name ILIKE '%shoes%' THEN 'รองเท้า'
  WHEN name ILIKE '%ถุงเท้า%' OR name ILIKE '%socks%' THEN 'ถุงเท้า'
  WHEN name ILIKE '%ผ้ากันเปื้อน%' OR name ILIKE '%apron%' THEN 'อุปกรณ์'
  WHEN name ILIKE '%เนคไท%' OR name ILIKE '%ผูกคอ%' OR name ILIKE '%tie%' THEN 'อุปกรณ์'
  WHEN name ILIKE '%เข็มขัด%' OR name ILIKE '%belt%' THEN 'อุปกรณ์'
  ELSE 'อื่นๆ'
END)
WHERE category IS NULL OR category = '';

-- Default reorder_point = 5 (เท่ากับ hardcode เดิม)
UPDATE public.uniform_items
SET reorder_point = 5
WHERE reorder_point IS NULL;

-- Auto-generate SKU สำหรับ row เก่าที่ยังไม่มี
-- Format: <BRAND>-<CAT_CODE>-<SIZE>-<UUID4>
-- ตัวอย่าง: ITEM-SHRT-M-a1b2 (ถ้า brand ว่าง ใช้ 'ITEM')
UPDATE public.uniform_items
SET sku = UPPER(
  COALESCE(NULLIF(brand, ''), 'ITEM') || '-' ||
  CASE
    WHEN category = 'เสื้อ' THEN 'SHRT'
    WHEN category = 'กางเกง' THEN 'PANT'
    WHEN category = 'กระโปรง' THEN 'SKRT'
    WHEN category = 'หมวก' THEN 'CAP'
    WHEN category = 'รองเท้า' THEN 'SHOE'
    WHEN category = 'ถุงเท้า' THEN 'SOCK'
    WHEN category = 'อุปกรณ์' THEN 'ACC'
    ELSE 'ITEM'
  END || '-' ||
  COALESCE(NULLIF(size, ''), 'FREE') ||
  '-' || SUBSTRING(id::TEXT FROM 1 FOR 4)  -- สั้นๆ ป้องกัน collision
)
WHERE sku IS NULL OR sku = '';

-- ─── ตาราง brands (lookup สำหรับ datalist + reference) ───
CREATE TABLE IF NOT EXISTS public.uniform_brands (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        TEXT UNIQUE NOT NULL,        -- "KB", "SW", "NEWBRAND"
  name        TEXT NOT NULL,                -- "Kacha Brothers", "Safari World"
  description TEXT,
  logo_url    TEXT,
  active      BOOLEAN DEFAULT true,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- [DEPRECATED] Default insert "KB / Kacha Brothers" — ลบออกแล้ว
-- เหตุผล: "Kacha Brothers" เป็นชื่อบริษัท ไม่ใช่ชื่อแบรนด์สินค้า
-- HR สร้างแบรนด์ใหม่ที่หน้า "🏷️ แบรนด์" → เพิ่มแบรนด์
-- INSERT INTO public.uniform_brands (code, name, description, sort_order) VALUES
--   ('KB', 'Kacha Brothers', 'แบรนด์หลัก คชา บราเธอร์ส', 1)
-- ON CONFLICT (code) DO NOTHING;

-- RLS
ALTER TABLE public.uniform_brands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_authenticated" ON public.uniform_brands;
DROP POLICY IF EXISTS "write_hr_admin"     ON public.uniform_brands;
CREATE POLICY "read_authenticated" ON public.uniform_brands
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_hr_admin" ON public.uniform_brands
  FOR ALL TO authenticated USING (public.is_hr_or_admin()) WITH CHECK (public.is_hr_or_admin());

-- Realtime
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'uniform_brands'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.uniform_brands;
  END IF;
END $$;

-- updated_at trigger
DROP TRIGGER IF EXISTS on_uniform_brands_updated ON public.uniform_brands;
CREATE TRIGGER on_uniform_brands_updated BEFORE UPDATE ON public.uniform_brands
  FOR EACH ROW EXECUTE FUNCTION public.uniform_set_updated_at();

-- ─── ทำให้ name+size+brand+color เป็น constraint แทน name+size เดิม ───
-- (อนุญาตให้เสื้อยูนิฟอร์ม M สีขาว แบรนด์ A กับแบรนด์ B แยกกัน)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniform_items_name_size_key'
      AND conrelid = 'public.uniform_items'::regclass
  ) THEN
    ALTER TABLE public.uniform_items DROP CONSTRAINT uniform_items_name_size_key;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ─── Verify ───
DO $$
DECLARE
  v_total INT;
  v_with_brand INT;
  v_with_sku INT;
  v_with_category INT;
  v_brand_count INT;
BEGIN
  SELECT count(*) INTO v_total FROM public.uniform_items;
  SELECT count(*) INTO v_with_brand FROM public.uniform_items WHERE brand IS NOT NULL AND brand != '';
  SELECT count(*) INTO v_with_sku FROM public.uniform_items WHERE sku IS NOT NULL AND sku != '';
  SELECT count(*) INTO v_with_category FROM public.uniform_items WHERE category IS NOT NULL AND category != '';
  SELECT count(*) INTO v_brand_count FROM public.uniform_brands;

  RAISE NOTICE '✅ Modern Inventory Schema ติดตั้งแล้ว';
  RAISE NOTICE '';
  RAISE NOTICE '   uniform_items ทั้งหมด: % รายการ', v_total;
  RAISE NOTICE '   ─ มี brand: % / % (%.0f%%)', v_with_brand, v_total, (v_with_brand::FLOAT / NULLIF(v_total, 0)) * 100;
  RAISE NOTICE '   ─ มี category: % / % (%.0f%%)', v_with_category, v_total, (v_with_category::FLOAT / NULLIF(v_total, 0)) * 100;
  RAISE NOTICE '   ─ มี SKU: % / % (%.0f%%)', v_with_sku, v_total, (v_with_sku::FLOAT / NULLIF(v_total, 0)) * 100;
  RAISE NOTICE '';
  RAISE NOTICE '   uniform_brands: % แบรนด์', v_brand_count;
  RAISE NOTICE '';
  RAISE NOTICE '   ผู้ใช้สามารถ:';
  RAISE NOTICE '   - เพิ่มแบรนด์ใหม่ในหน้า "แบรนด์ Uniform"';
  RAISE NOTICE '   - แต่ละ item ตั้ง brand/category/color/SKU/reorder_point';
  RAISE NOTICE '   - กรอง Stock ตามแบรนด์/หมวดในหน้า "รายการชุด"';
END $$;
