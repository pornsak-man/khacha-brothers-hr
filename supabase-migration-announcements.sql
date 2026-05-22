-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Company Announcements + Orders
-- ระบบประกาศบริษัทและคำสั่งบริษัท พร้อมรูปประกอบ
-- HR/admin สร้าง+แก้+ลบได้ · พนักงานทุกคนดูได้
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ─── TABLE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_announcements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type            TEXT NOT NULL DEFAULT 'announcement' CHECK (type IN ('announcement', 'order')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  image_url       TEXT,                                   -- public URL จาก storage
  effective_date  DATE,                                   -- วันที่มีผล (optional)
  expires_date    DATE,                                   -- วันที่หมดอายุ (optional)
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal')),
  pinned          BOOLEAN NOT NULL DEFAULT false,         -- ปักหมุดบนสุด
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ann_type       ON public.company_announcements(type);
CREATE INDEX IF NOT EXISTS idx_ann_pinned     ON public.company_announcements(pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ann_priority   ON public.company_announcements(priority);
CREATE INDEX IF NOT EXISTS idx_ann_created_at ON public.company_announcements(created_at DESC);

-- ─── RLS ───────────────────────────────────────────────
ALTER TABLE public.company_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ann_read_all"        ON public.company_announcements;
DROP POLICY IF EXISTS "ann_write_hr_admin"  ON public.company_announcements;

-- SELECT: ทุก authenticated user เห็น
CREATE POLICY "ann_read_all" ON public.company_announcements
  FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: HR/admin เท่านั้น
CREATE POLICY "ann_write_hr_admin" ON public.company_announcements
  FOR ALL TO authenticated
  USING (public.is_hr_or_admin())
  WITH CHECK (public.is_hr_or_admin());

-- ─── Auto-update updated_at ─────────────────────────────
CREATE OR REPLACE FUNCTION public.set_ann_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ann_updated_at ON public.company_announcements;
CREATE TRIGGER trg_ann_updated_at
  BEFORE UPDATE ON public.company_announcements
  FOR EACH ROW EXECUTE FUNCTION public.set_ann_updated_at();

-- ─── STORAGE BUCKET: announcement-images ───────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('announcement-images', 'announcement-images', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "ann_img_select" ON storage.objects;
CREATE POLICY "ann_img_select" ON storage.objects
FOR SELECT USING (bucket_id = 'announcement-images');

DROP POLICY IF EXISTS "ann_img_insert" ON storage.objects;
CREATE POLICY "ann_img_insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'announcement-images' AND public.is_hr_or_admin());

DROP POLICY IF EXISTS "ann_img_update" ON storage.objects;
CREATE POLICY "ann_img_update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'announcement-images' AND public.is_hr_or_admin());

DROP POLICY IF EXISTS "ann_img_delete" ON storage.objects;
CREATE POLICY "ann_img_delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'announcement-images' AND public.is_hr_or_admin());

-- ─── Realtime ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'company_announcements') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.company_announcements;
  END IF;
END $$;

-- ─── Audit trigger (ถ้ามี audit_log) ────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_trigger_fn' AND pronamespace = 'public'::regnamespace) THEN
    DROP TRIGGER IF EXISTS audit_trigger ON public.company_announcements;
    CREATE TRIGGER audit_trigger
      AFTER INSERT OR UPDATE OR DELETE ON public.company_announcements
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- การใช้งาน:
-- 1) HR/admin POST เพิ่มประกาศ (type='announcement' หรือ 'order')
-- 2) Upload รูปไป bucket 'announcement-images' → ได้ public URL
-- 3) UPDATE image_url ในตาราง
-- 4) พนักงานทุกคน SELECT เห็นได้ (เรียง pinned DESC, created_at DESC)
-- ═══════════════════════════════════════════════════════════
