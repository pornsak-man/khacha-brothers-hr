-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Configurable Position Scopes
-- ย้ายการตั้งค่าสายงาน (scope) ออกจาก hardcode ('operation'/'office')
-- → ตาราง position_scopes ให้ admin/HR เพิ่ม/แก้/ลบสายงานเองได้
--
-- ตัวอย่างการใช้: เพิ่ม SCM (Supply Chain Management), Quality, IT, Marketing
-- โดยไม่ต้องแก้ schema หรือ deploy โค้ดใหม่
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.position_scopes (
  id           TEXT PRIMARY KEY,                       -- รหัสภายใน เช่น 'operation', 'office', 'scm'
  label        TEXT NOT NULL,                          -- ชื่อแสดง เช่น 'ปฏิบัติการ (Operation)'
  badge_bg     TEXT NOT NULL DEFAULT 'rgba(148,163,184,0.15)',  -- CSS background ของ badge
  badge_color  TEXT NOT NULL DEFAULT '#475569',        -- CSS color ของ badge
  sort_order   INTEGER NOT NULL DEFAULT 100,
  active       BOOLEAN NOT NULL DEFAULT true,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_position_scopes_active ON public.position_scopes(active, sort_order);

-- ─── Seed defaults — ตรงกับ hardcoded เดิม + เพิ่ม SCM ─────
INSERT INTO public.position_scopes (id, label, badge_bg, badge_color, sort_order) VALUES
  ('operation', 'ปฏิบัติการ (Operation)', 'rgba(245,158,11,0.15)', '#b45309', 10),
  ('office',    'สำนักงาน (Office)',      'rgba(30,136,229,0.15)', '#1565c0', 20),
  ('scm',       'Supply Chain (SCM)',     'rgba(124,58,237,0.15)', '#6d28d9', 30)
ON CONFLICT (id) DO NOTHING;

-- ─── ลบ CHECK constraint เดิมที่ hardcode ค่า ──────────────
-- รับค่าจาก position_scopes table แทน (validate ผ่าน FK)
ALTER TABLE public.position_levels DROP CONSTRAINT IF EXISTS position_levels_scope_check;
ALTER TABLE public.departments     DROP CONSTRAINT IF EXISTS departments_scope_check;

-- ─── เพิ่ม FK ไปที่ position_scopes ───────────────────────
-- ON UPDATE CASCADE: ถ้า rename id (rare) → ตามไป
-- ON DELETE SET NULL: ลบ scope → position_levels/departments ที่อ้างถึง = NULL
ALTER TABLE public.position_levels DROP CONSTRAINT IF EXISTS position_levels_scope_fk;
ALTER TABLE public.position_levels
  ADD CONSTRAINT position_levels_scope_fk
  FOREIGN KEY (scope) REFERENCES public.position_scopes(id)
  ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.departments DROP CONSTRAINT IF EXISTS departments_scope_fk;
ALTER TABLE public.departments
  ADD CONSTRAINT departments_scope_fk
  FOREIGN KEY (scope) REFERENCES public.position_scopes(id)
  ON UPDATE CASCADE ON DELETE SET NULL;

-- ─── RLS ─────────────────────────────────────────────────
ALTER TABLE public.position_scopes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_authenticated" ON public.position_scopes;
DROP POLICY IF EXISTS "write_hr"           ON public.position_scopes;
CREATE POLICY "read_authenticated" ON public.position_scopes FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_hr"           ON public.position_scopes FOR ALL    TO authenticated
  USING (public.is_hr_or_admin()) WITH CHECK (public.is_hr_or_admin());

-- ─── Auto-update updated_at ─────────────────────────────
CREATE OR REPLACE FUNCTION public.set_position_scopes_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_position_scopes_updated_at ON public.position_scopes;
CREATE TRIGGER trg_position_scopes_updated_at BEFORE UPDATE ON public.position_scopes
  FOR EACH ROW EXECUTE FUNCTION public.set_position_scopes_updated_at();

-- ─── Realtime ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'position_scopes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.position_scopes;
  END IF;
END $$;

-- ─── Audit trigger ──────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_trigger_fn' AND pronamespace = 'public'::regnamespace) THEN
    DROP TRIGGER IF EXISTS audit_trigger ON public.position_scopes;
    CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.position_scopes
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
