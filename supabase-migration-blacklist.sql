-- ═══════════════════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Employee Blacklist
-- ─────────────────────────────────────────────────────────────────────
-- ⛔ บันทึกรายชื่อบุคคลที่ห้ามจ้าง/รับสมัคร (พนักงานเก่ามีปัญหา / บุคคลภายนอก)
-- ใช้ auto-check ตอนเพิ่มพนักงานใหม่ → เตือนถ้า national_id ตรง
--
-- หมวด (category):
--   theft, fraud, violence, conduct, performance, attendance, other
-- ระดับ (severity):
--   permanent — ห้ามถาวร
--   temporary — ห้ามชั่วคราว (review_date)
--   review    — เตือนเฉยๆ ไม่ block
--
-- สิทธิ์: เฉพาะ admin + hr (RLS)
-- หมายเหตุ PDPA: เก็บ soft delete (removed_at) เพื่อ audit trail
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.employee_blacklist (
  id              BIGSERIAL PRIMARY KEY,
  national_id     TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  nickname        TEXT,
  phone           TEXT,
  previous_emp_id TEXT,
  reason          TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'other'
                  CHECK (category IN ('theft','fraud','violence','conduct','performance','attendance','other')),
  severity        TEXT NOT NULL DEFAULT 'permanent'
                  CHECK (severity IN ('permanent','temporary','review')),
  review_date     DATE,
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  removed_at      TIMESTAMPTZ,
  removed_by      TEXT,
  removed_reason  TEXT,
  CONSTRAINT chk_national_id_format CHECK (national_id ~ '^\d{1,20}$'),
  CONSTRAINT chk_temp_review_date CHECK (severity <> 'temporary' OR review_date IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_bl_national_id ON public.employee_blacklist(national_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bl_emp_id      ON public.employee_blacklist(previous_emp_id);
CREATE INDEX IF NOT EXISTS idx_bl_category    ON public.employee_blacklist(category);
CREATE INDEX IF NOT EXISTS idx_bl_severity    ON public.employee_blacklist(severity);
CREATE INDEX IF NOT EXISTS idx_bl_created     ON public.employee_blacklist(created_at DESC);

-- ─── RLS — admin + hr only ─────────────────────────────────
ALTER TABLE public.employee_blacklist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blacklist_hr_full" ON public.employee_blacklist;
CREATE POLICY "blacklist_hr_full"
  ON public.employee_blacklist FOR ALL
  TO authenticated
  USING (public.is_hr_or_admin())
  WITH CHECK (public.is_hr_or_admin());

-- ─── Trigger: auto-update updated_at ───
CREATE OR REPLACE FUNCTION public.fn_blacklist_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_blacklist_updated_at ON public.employee_blacklist;
CREATE TRIGGER trg_blacklist_updated_at
  BEFORE UPDATE ON public.employee_blacklist
  FOR EACH ROW EXECUTE FUNCTION public.fn_blacklist_set_updated_at();

-- ─── Realtime ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'employee_blacklist'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.employee_blacklist;
  END IF;
END $$;

-- ─── Audit trigger ───
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_trigger_fn' AND pronamespace = 'public'::regnamespace) THEN
    DROP TRIGGER IF EXISTS audit_trigger ON public.employee_blacklist;
    CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.employee_blacklist
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();
  END IF;
END $$;

-- ─── RPC: Check blacklist by national_id ───
-- รับ national_id → คืน rows ที่ active (ยังไม่ removed + ยังไม่หมด review_date)
CREATE OR REPLACE FUNCTION public.check_blacklist(p_national_id TEXT)
RETURNS TABLE (
  id              BIGINT,
  national_id     TEXT,
  full_name       TEXT,
  nickname        TEXT,
  previous_emp_id TEXT,
  reason          TEXT,
  category        TEXT,
  severity        TEXT,
  review_date     DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ,
  created_by      TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    b.id, b.national_id, b.full_name, b.nickname, b.previous_emp_id,
    b.reason, b.category, b.severity, b.review_date, b.notes,
    b.created_at, b.created_by
  FROM public.employee_blacklist b
  WHERE b.national_id = p_national_id
    AND b.removed_at IS NULL
    AND (b.severity <> 'temporary' OR b.review_date IS NULL OR b.review_date >= CURRENT_DATE)
  ORDER BY b.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.check_blacklist(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
