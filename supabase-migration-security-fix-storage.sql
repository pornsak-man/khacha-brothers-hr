-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security fix: Storage hardening
-- แก้ช่องโหว่ระดับ High:
--   H2) ไม่มี server-side validation file type/size
--   H3) employee-photos: ทุก authenticated เขียน/ลบได้ (overwrite รูปคนอื่น)
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
--
-- หมายเหตุ H1 (bucket public read + filename predictable):
--   - คงไว้เป็น public read เพราะ <img src> ต้องการ unsigned URL
--   - การกัน "เดาชื่อไฟล์" จะแก้ใน JS (ใช้ UUID) — commit แยกต่างหาก
--   - ผู้โจมตียังต้องรู้ filename ก่อน — หลัง H3 จะ overwrite ของคนอื่นไม่ได้
-- ═══════════════════════════════════════════════════════════

-- ─── H2: จำกัด mimetype + file size ที่ระดับ bucket ──────────
-- Supabase บังคับ limit นี้ก่อน RLS — ปฏิเสธไฟล์ก่อนเข้า object
UPDATE storage.buckets
SET file_size_limit = 5 * 1024 * 1024,  -- 5 MB
    allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']
WHERE id IN ('employee-photos', 'announcement-images');

-- ─── H3: employee-photos — เขียน/แก้/ลบเฉพาะ HR/admin ───────
-- ก่อนหน้านี้: ทุก authenticated เขียนได้ → branch_staff overwrite รูปคนอื่นได้
DROP POLICY IF EXISTS "kb_photos_insert" ON storage.objects;
CREATE POLICY "kb_photos_insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'employee-photos'
  AND public.is_hr_or_admin()
);

DROP POLICY IF EXISTS "kb_photos_update" ON storage.objects;
CREATE POLICY "kb_photos_update" ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'employee-photos'
  AND public.is_hr_or_admin()
);

DROP POLICY IF EXISTS "kb_photos_delete" ON storage.objects;
CREATE POLICY "kb_photos_delete" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'employee-photos'
  AND public.is_hr_or_admin()
);

-- ─── ตรวจสอบ ───────────────────────────────────────────────
DO $$
DECLARE
  v_emp_size BIGINT;
  v_emp_types TEXT[];
  v_ann_size BIGINT;
  v_ann_types TEXT[];
  v_photo_insert_hr BOOLEAN;
BEGIN
  SELECT file_size_limit, allowed_mime_types
    INTO v_emp_size, v_emp_types
  FROM storage.buckets WHERE id = 'employee-photos';

  SELECT file_size_limit, allowed_mime_types
    INTO v_ann_size, v_ann_types
  FROM storage.buckets WHERE id = 'announcement-images';

  -- ตรวจว่า policy insert มี is_hr_or_admin หรือยัง (อ่านจาก qual/with_check definition)
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'kb_photos_insert'
      AND with_check LIKE '%is_hr_or_admin%'
  ) INTO v_photo_insert_hr;

  RAISE NOTICE '═══ ผลลัพธ์ Storage hardening ═══';
  RAISE NOTICE 'H2a) employee-photos     size_limit=% bytes  types=%', v_emp_size, v_emp_types;
  RAISE NOTICE 'H2b) announcement-images size_limit=% bytes  types=%', v_ann_size, v_ann_types;
  RAISE NOTICE 'H3)  employee-photos INSERT มี HR check: %', CASE WHEN v_photo_insert_hr THEN '✅ ใช่' ELSE '❌ ไม่' END;
  IF v_emp_size = 5242880 AND v_ann_size = 5242880 AND v_photo_insert_hr THEN
    RAISE NOTICE '🎉 Storage hardening เรียบร้อย';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════
-- ทดสอบหลังรัน:
--   1) Login เป็น branch_staff → ลอง upload รูปผ่าน Supabase JS:
--      DB.client.storage.from('employee-photos').upload('test.jpg', new Blob(['x']))
--      → ควรได้ error "new row violates row-level security policy"
--   2) ลอง upload ไฟล์ .html (mimetype text/html) ผ่าน HR/admin:
--      → ควรถูกปฏิเสธโดย bucket (file_type_not_allowed) ก่อน RLS
--   3) ลอง upload ไฟล์ขนาด > 5MB:
--      → ควรได้ error file_size_limit
-- ═══════════════════════════════════════════════════════════
