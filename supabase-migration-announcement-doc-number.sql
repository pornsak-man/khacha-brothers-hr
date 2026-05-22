-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: เพิ่ม doc_number ใน announcements
-- เลขที่เอกสาร เช่น "001/2569" สำหรับประกาศและคำสั่งบริษัท
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.company_announcements
  ADD COLUMN IF NOT EXISTS doc_number TEXT;

-- index สำหรับ search/filter (จะมี + ไม่มีก็ได้ — index ขนาดเล็ก)
CREATE INDEX IF NOT EXISTS idx_ann_doc_number
  ON public.company_announcements(doc_number)
  WHERE doc_number IS NOT NULL;

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE v_has_col BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'company_announcements'
      AND column_name = 'doc_number'
  ) INTO v_has_col;
  IF v_has_col THEN
    RAISE NOTICE '✅ เพิ่มคอลัมน์ doc_number ใน company_announcements แล้ว';
  ELSE
    RAISE WARNING '⚠️ ไม่พบคอลัมน์ doc_number — ตรวจสอบ migration';
  END IF;
END $$;
