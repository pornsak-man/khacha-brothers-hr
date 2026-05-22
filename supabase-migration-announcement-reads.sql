-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Announcement Read Receipts
-- บันทึก "ใครอ่านประกาศ/คำสั่งแล้วบ้าง" — admin/HR ดูได้
-- พนักงาน insert read ของตัวเอง · admin/HR เห็นทั้งหมด
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.announcement_reads (
  announcement_id UUID NOT NULL REFERENCES public.company_announcements(id) ON DELETE CASCADE,
  employee_id     TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id),
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_ann_reads_ann ON public.announcement_reads(announcement_id);
CREATE INDEX IF NOT EXISTS idx_ann_reads_emp ON public.announcement_reads(employee_id);

-- ─── RLS ───────────────────────────────────────────────
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ann_reads_select_self_or_hr"  ON public.announcement_reads;
DROP POLICY IF EXISTS "ann_reads_insert_self"        ON public.announcement_reads;
DROP POLICY IF EXISTS "ann_reads_delete_hr"          ON public.announcement_reads;

-- SELECT: HR/admin เห็นทั้งหมด, พนักงาน เห็นเฉพาะของตัวเอง
CREATE POLICY "ann_reads_select_self_or_hr" ON public.announcement_reads
  FOR SELECT TO authenticated
  USING (
    public.is_hr_or_admin()
    OR employee_id = (SELECT employee_id FROM public.user_profiles WHERE user_id = auth.uid())
  );

-- INSERT: พนักงาน insert ได้เฉพาะของตัวเอง (employee_id ตรงกับ profile)
CREATE POLICY "ann_reads_insert_self" ON public.announcement_reads
  FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = (SELECT employee_id FROM public.user_profiles WHERE user_id = auth.uid())
  );

-- DELETE: HR/admin เท่านั้น (ใช้ทำความสะอาด, ปกติไม่จำเป็น)
CREATE POLICY "ann_reads_delete_hr" ON public.announcement_reads
  FOR DELETE TO authenticated
  USING (public.is_hr_or_admin());

-- ─── Realtime ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'announcement_reads') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.announcement_reads;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- การใช้งาน:
-- 1) พนักงานเปิด detail ประกาศ → upsert (announcement_id, employee_id)
--    (ignore duplicate — ไม่ update read_at ถ้าอ่านแล้ว, แสดงเวลาอ่านครั้งแรก)
-- 2) admin/HR SELECT WHERE announcement_id = ? → ได้รายชื่อผู้อ่าน
-- 3) เปรียบเทียบกับ employees ที่ยังปฏิบัติงาน → รู้ว่าใครยังไม่อ่าน
-- ═══════════════════════════════════════════════════════════
