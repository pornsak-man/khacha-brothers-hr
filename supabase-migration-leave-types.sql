-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Configurable Leave Types
-- ย้ายการตั้งค่าประเภทการลาออกจาก hardcode → ตาราง leave_types
-- admin/HR แก้ไขชื่อ จำนวนวัน gender filter ลาย้อนหลังได้เองในระบบ
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.leave_types (
  id              TEXT PRIMARY KEY,                       -- รหัสภายใน เช่น 'personal', 'sick'
  label           TEXT NOT NULL,                          -- ชื่อแสดง เช่น 'ลากิจ'
  max_days        NUMERIC,                                -- ค่าคงที่ ถ้า rule = null
  rule            TEXT CHECK (rule IS NULL OR rule IN ('tenure')),  -- สูตรพิเศษ; 'tenure' = ลาพักร้อนตามอายุงาน
  gender          TEXT CHECK (gender IS NULL OR gender IN ('M','F')),
  allow_backdate  BOOLEAN NOT NULL DEFAULT false,         -- ย้อนหลังได้ไหม
  badge           TEXT NOT NULL DEFAULT 'badge-info',     -- CSS class สีของ badge
  sort_order      INTEGER NOT NULL DEFAULT 100,
  active          BOOLEAN NOT NULL DEFAULT true,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leave_types_active ON public.leave_types(active, sort_order);

-- ─── Seed defaults — ตรงกับ hardcoded เดิม ─────────────────
INSERT INTO public.leave_types (id, label, max_days, rule, gender, allow_backdate, badge, sort_order) VALUES
  ('personal',   'ลากิจ',                       3,    NULL,     NULL, false, 'badge-info',    10),
  ('sick',       'ลาป่วย',                      30,   NULL,     NULL, true,  'badge-warning', 20),
  ('maternity',  'ลาคลอดบุตร (หญิง)',           98,   NULL,     'F',  true,  'badge-info',    30),
  ('paternity',  'ลาคลอดบุตร (ช่วยภริยา)',      15,   NULL,     'M',  true,  'badge-info',    40),
  ('vacation',   'ลาพักร้อน',                   12,   'tenure', NULL, false, 'badge-success', 50),
  ('ordination', 'ลาบวช',                       15,   NULL,     'M',  false, 'badge-info',    60),
  ('military',   'ลารับราชการทหาร',             60,   NULL,     NULL, false, 'badge-info',    70)
ON CONFLICT (id) DO NOTHING;

-- ─── RLS ─────────────────────────────────────────────────
ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_authenticated" ON public.leave_types;
DROP POLICY IF EXISTS "write_admin"        ON public.leave_types;
CREATE POLICY "read_authenticated" ON public.leave_types FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin"        ON public.leave_types FOR ALL    TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ─── Auto-update updated_at ─────────────────────────────
CREATE OR REPLACE FUNCTION public.set_leave_types_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_leave_types_updated_at ON public.leave_types;
CREATE TRIGGER trg_leave_types_updated_at BEFORE UPDATE ON public.leave_types
  FOR EACH ROW EXECUTE FUNCTION public.set_leave_types_updated_at();

-- ─── Realtime ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'leave_types') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.leave_types;
  END IF;
END $$;

-- ─── Audit trigger ──────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_trigger_fn' AND pronamespace = 'public'::regnamespace) THEN
    DROP TRIGGER IF EXISTS audit_trigger ON public.leave_types;
    CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.leave_types
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();
  END IF;
END $$;

-- ─── เปลี่ยน leave_requests ให้รองรับประเภทใหม่ ─────────────
-- ลบ CHECK constraint เดิมที่ hardcode 7 ประเภท + ใส่ FK แทน
ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_leave_type_check;
ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS fk_leave_requests_leave_type;
ALTER TABLE public.leave_requests
  ADD CONSTRAINT fk_leave_requests_leave_type
  FOREIGN KEY (leave_type) REFERENCES public.leave_types(id) ON DELETE RESTRICT;

NOTIFY pgrst, 'reload schema';
