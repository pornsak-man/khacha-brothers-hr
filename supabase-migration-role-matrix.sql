-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Role Permission Matrix
-- ตารางเอกสารอ้างอิงสิทธิ์ของแต่ละ role — admin/HR แก้ไข + เพิ่มแถวได้
-- ⚠️ หมายเหตุ: ตารางนี้เป็น "เอกสาร" — การแก้ค่าในนี้ไม่ได้กระทบ permission
--   จริงของระบบโดยอัตโนมัติ (permission จริงยังอยู่ที่ code/RLS)
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.role_permission_matrix (
  id              BIGSERIAL PRIMARY KEY,
  menu_label      TEXT NOT NULL,           -- ชื่อเมนู/หัวข้อสิทธิ์
  admin_val       TEXT DEFAULT '',         -- ค่าที่แสดงในคอลัมน์ Admin
  hr_val          TEXT DEFAULT '',
  op_mgr_val      TEXT DEFAULT '',
  area_mgr_val    TEXT DEFAULT '',
  branch_mgr_val  TEXT DEFAULT '',
  branch_staff_val TEXT DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  note            TEXT,                    -- หมายเหตุเพิ่มเติม
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_role_matrix_sort ON public.role_permission_matrix(sort_order);

-- RLS — authenticated อ่านได้ทั้งหมด, admin/HR เขียนได้
ALTER TABLE public.role_permission_matrix ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_authenticated" ON public.role_permission_matrix;
DROP POLICY IF EXISTS "write_hr"            ON public.role_permission_matrix;
CREATE POLICY "read_authenticated" ON public.role_permission_matrix FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_hr"            ON public.role_permission_matrix FOR ALL    TO authenticated USING (public.is_hr_or_admin()) WITH CHECK (public.is_hr_or_admin());

-- Realtime
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'role_permission_matrix'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.role_permission_matrix;
  END IF;
END $$;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.role_matrix_set_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS on_role_matrix_updated ON public.role_permission_matrix;
CREATE TRIGGER on_role_matrix_updated BEFORE UPDATE ON public.role_permission_matrix
  FOR EACH ROW EXECUTE FUNCTION public.role_matrix_set_updated_at();

-- ── Seed default rows (idempotent — insert ถ้ายังว่าง) ──
INSERT INTO public.role_permission_matrix
  (menu_label, admin_val, hr_val, op_mgr_val, area_mgr_val, branch_mgr_val, branch_staff_val, sort_order)
SELECT * FROM (VALUES
  ('Dashboard',                'Org',     'Org',           'Org',     'Scoped', 'Scoped', 'Personal',  10),
  ('ทะเบียนพนักงาน',            'ทั้งหมด', 'ทั้งหมด',       'ทั้งหมด', 'สาขา',   'สาขา',   '— ซ่อน',    20),
  ('สาขา / ตำแหน่ง / รับสมัคร',  '✓',       '✓',             '✓',       '✓',      '✓',      '—',         30),
  ('ปรับค่าจ้าง / กู้ / audit',   '✓',       '✓',             '—',       '—',      '—',      '—',         40),
  ('การลา',                    'ทั้งหมด', 'ทั้งหมด',       'ทั้งหมด', 'สาขา',   'สาขา',   'ตัวเอง',    50),
  ('ผู้ใช้และสิทธิ์',             '✓ ทุก',   '✓ ยกเว้น admin', '—',       '—',      '—',      '—',         60),
  ('ตั้งค่าระบบ (company)',     '✓',       '—',             '—',       '—',      '—',      '—',         70)
) AS v(menu_label, admin_val, hr_val, op_mgr_val, area_mgr_val, branch_mgr_val, branch_staff_val, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.role_permission_matrix);

NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════
