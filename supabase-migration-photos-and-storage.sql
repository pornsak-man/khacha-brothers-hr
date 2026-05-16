-- ═══════════════════════════════════════════════════════════
-- KHACHA BROTHERS HR — Migration: Photos + Storage
-- เพิ่ม column photo_url + ตั้ง Supabase Storage bucket "employee-photos"
-- รันสคริปต์นี้ใน Supabase SQL Editor ครั้งเดียว (ปลอดภัย — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- 1) เพิ่ม column รูปพนักงาน
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- 2) สร้าง storage bucket (public read — ใครก็เปิดดู URL ได้)
INSERT INTO storage.buckets (id, name, public)
VALUES ('employee-photos', 'employee-photos', true)
ON CONFLICT (id) DO NOTHING;

-- 3) RLS policies สำหรับ bucket
DROP POLICY IF EXISTS "kb_photos_select" ON storage.objects;
CREATE POLICY "kb_photos_select" ON storage.objects
FOR SELECT USING (bucket_id = 'employee-photos');

DROP POLICY IF EXISTS "kb_photos_insert" ON storage.objects;
CREATE POLICY "kb_photos_insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'employee-photos');

DROP POLICY IF EXISTS "kb_photos_update" ON storage.objects;
CREATE POLICY "kb_photos_update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'employee-photos');

DROP POLICY IF EXISTS "kb_photos_delete" ON storage.objects;
CREATE POLICY "kb_photos_delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'employee-photos');
