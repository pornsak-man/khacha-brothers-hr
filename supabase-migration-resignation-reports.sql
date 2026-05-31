-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — ระบบแจ้งพนักงานลาออก (Resignation Reports)
--
-- BM แจ้งพนักงานที่ขอลาออกของสาขาตนเอง → AM/OM/HR ทราบ → HR กด "รับทราบ"
-- status: reported → acknowledged / cancelled
--
-- ⚠️ ไม่แตะตาราง employees — การตั้งวันพ้นสภาพจริง HR ทำในเมนูทะเบียนพนักงานเหมือนเดิม
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้) — โปรเจกต์ kacha = xvulimfftkoiybvqdjqz
-- อิง pattern: supabase-migration-headcount-requests.sql
-- ═══════════════════════════════════════════════════════════

-- ════════ 1. TABLE ════════
CREATE TABLE IF NOT EXISTS public.resignation_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        TEXT NOT NULL REFERENCES public.branches(id),
  employee_id      TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  employee_name    TEXT,                       -- snapshot ตอนแจ้ง
  position_title   TEXT,                       -- snapshot ตอนแจ้ง
  resign_date      DATE,                       -- วันมีผล/วันทำงานวันสุดท้าย (nullable เผื่อยังไม่ทราบ)
  reason           TEXT,
  note             TEXT,
  -- reported → acknowledged / cancelled
  status           TEXT NOT NULL DEFAULT 'reported'
                   CHECK (status IN ('reported','acknowledged','cancelled')),
  reported_by      UUID REFERENCES auth.users(id),
  reported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ขั้นรับทราบ (HR)
  acknowledged_by  UUID REFERENCES auth.users(id),
  acknowledged_at  TIMESTAMPTZ,
  acknowledge_note TEXT,
  -- ยกเลิก
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rsg_branch      ON public.resignation_reports(branch_id);
CREATE INDEX IF NOT EXISTS idx_rsg_status      ON public.resignation_reports(status);
CREATE INDEX IF NOT EXISTS idx_rsg_reported_at ON public.resignation_reports(reported_at DESC);
-- กันแจ้งซ้ำ: พนักงาน 1 คนมีรายการ "reported" ค้างได้แค่รายการเดียว
CREATE UNIQUE INDEX IF NOT EXISTS uq_rsg_open
  ON public.resignation_reports(employee_id) WHERE status = 'reported';

-- ════════ 2. updated_at trigger ════════
CREATE OR REPLACE FUNCTION public.fn_rsg_set_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_rsg_updated_at ON public.resignation_reports;
CREATE TRIGGER trg_rsg_updated_at
  BEFORE UPDATE ON public.resignation_reports
  FOR EACH ROW EXECUTE FUNCTION public.fn_rsg_set_updated_at();

-- ════════ 3. Helper functions ════════
-- ใครแจ้งลาออกให้สาขานี้ได้: HR/admin, BM ของสาขาตัวเอง, หรือ AM/OM ของสาขาในความดูแล
-- (ตัด branch_staff/viewer ออก — พนักงานทั่วไปแจ้งไม่ได้)
CREATE OR REPLACE FUNCTION public.rsg_can_report(p_branch_id TEXT)
RETURNS BOOLEAN LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_branches TEXT[]; v_own TEXT;
BEGIN
  IF public.is_hr_or_admin() THEN RETURN TRUE; END IF;
  SELECT up.role, up.managed_branches, e.branch
    INTO v_role, v_branches, v_own
  FROM public.user_profiles up
  LEFT JOIN public.employees e ON e.id = up.employee_id
  WHERE up.user_id = auth.uid();
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  -- BM → สาขาตัวเอง
  IF v_role = 'branch_manager' AND v_own IS NOT NULL AND v_own = p_branch_id THEN
    RETURN TRUE;
  END IF;
  -- AM / OM → สาขาในความดูแล
  IF v_role IN ('area_manager','operation_manager') AND v_branches IS NOT NULL THEN
    RETURN p_branch_id = ANY(v_branches);
  END IF;
  RETURN FALSE;
END $$;

-- ใครเห็นรายการของสาขานี้ได้ (SELECT) — ชุดเดียวกับ rsg_can_report
CREATE OR REPLACE FUNCTION public.rsg_is_party(p_branch_id TEXT)
RETURNS BOOLEAN LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_branches TEXT[]; v_own TEXT;
BEGIN
  IF public.is_hr_or_admin() THEN RETURN TRUE; END IF;
  SELECT up.role, up.managed_branches, e.branch
    INTO v_role, v_branches, v_own
  FROM public.user_profiles up
  LEFT JOIN public.employees e ON e.id = up.employee_id
  WHERE up.user_id = auth.uid();
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF v_role = 'branch_manager' AND v_own IS NOT NULL AND v_own = p_branch_id THEN
    RETURN TRUE;
  END IF;
  IF v_role IN ('area_manager','operation_manager') AND v_branches IS NOT NULL THEN
    RETURN p_branch_id = ANY(v_branches);
  END IF;
  RETURN FALSE;
END $$;

GRANT EXECUTE ON FUNCTION public.rsg_can_report(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rsg_is_party(TEXT)   TO authenticated;

-- ════════ 4. RLS ════════
ALTER TABLE public.resignation_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rsg_select" ON public.resignation_reports;
CREATE POLICY "rsg_select" ON public.resignation_reports
  FOR SELECT TO authenticated
  USING (public.rsg_is_party(branch_id));

DROP POLICY IF EXISTS "rsg_insert" ON public.resignation_reports;
CREATE POLICY "rsg_insert" ON public.resignation_reports
  FOR INSERT TO authenticated
  WITH CHECK (public.rsg_can_report(branch_id));

-- UPDATE/DELETE ทำผ่าน RPC (SECURITY DEFINER) — policy นี้ defensive
DROP POLICY IF EXISTS "rsg_update" ON public.resignation_reports;
CREATE POLICY "rsg_update" ON public.resignation_reports
  FOR UPDATE TO authenticated
  USING (public.rsg_is_party(branch_id))
  WITH CHECK (public.rsg_is_party(branch_id));

DROP POLICY IF EXISTS "rsg_delete" ON public.resignation_reports;
CREATE POLICY "rsg_delete" ON public.resignation_reports
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ════════ 5. RPC: แจ้งลาออก ════════
CREATE OR REPLACE FUNCTION public.create_resignation_report(
  p_branch_id      TEXT,
  p_employee_id    TEXT,
  p_employee_name  TEXT,
  p_position_title TEXT,
  p_resign_date    DATE  DEFAULT NULL,
  p_reason         TEXT  DEFAULT NULL,
  p_note           TEXT  DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID; v_emp_branch TEXT; v_term DATE;
BEGIN
  IF NOT public.rsg_can_report(p_branch_id) THEN
    RAISE EXCEPTION 'คุณไม่มีสิทธิ์แจ้งพนักงานลาออกของสาขานี้';
  END IF;
  IF p_employee_id IS NULL OR btrim(p_employee_id) = '' THEN
    RAISE EXCEPTION 'ต้องระบุพนักงาน';
  END IF;
  SELECT branch, termination_date INTO v_emp_branch, v_term
    FROM public.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบพนักงาน'; END IF;
  IF v_emp_branch IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'พนักงานคนนี้ไม่ได้อยู่สาขาที่เลือก';
  END IF;
  IF v_term IS NOT NULL AND v_term <= CURRENT_DATE THEN
    RAISE EXCEPTION 'พนักงานคนนี้พ้นสภาพแล้ว';
  END IF;
  IF EXISTS (SELECT 1 FROM public.resignation_reports
             WHERE employee_id = p_employee_id AND status = 'reported') THEN
    RAISE EXCEPTION 'มีการแจ้งลาออกของพนักงานคนนี้ค้างอยู่แล้ว (รอรับทราบ)';
  END IF;
  INSERT INTO public.resignation_reports
    (branch_id, employee_id, employee_name, position_title, resign_date, reason, note, status, reported_by)
  VALUES
    (p_branch_id, p_employee_id, btrim(coalesce(p_employee_name,'')),
     btrim(coalesce(p_position_title,'')), p_resign_date, p_reason, p_note, 'reported', auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'status', 'reported');
END $$;
GRANT EXECUTE ON FUNCTION public.create_resignation_report(TEXT,TEXT,TEXT,TEXT,DATE,TEXT,TEXT) TO authenticated;

-- ════════ 6. RPC: รับทราบ (HR/admin เท่านั้น) ════════
CREATE OR REPLACE FUNCTION public.acknowledge_resignation_report(
  p_request_id UUID,
  p_note       TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.resignation_reports;
BEGIN
  SELECT * INTO v_req FROM public.resignation_reports WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบรายการ'; END IF;
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'เฉพาะ HR/admin จึงจะรับทราบได้';
  END IF;
  IF v_req.status <> 'reported' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรอรับทราบ (สถานะปัจจุบัน: %)', v_req.status;
  END IF;
  UPDATE public.resignation_reports
    SET status='acknowledged', acknowledged_by=auth.uid(), acknowledged_at=now(), acknowledge_note=p_note
    WHERE id = p_request_id;
  RETURN jsonb_build_object('id', p_request_id, 'status', 'acknowledged');
END $$;
GRANT EXECUTE ON FUNCTION public.acknowledge_resignation_report(UUID,TEXT) TO authenticated;

-- ════════ 7. RPC: ยกเลิก (ผู้แจ้ง หรือ HR) ════════
CREATE OR REPLACE FUNCTION public.cancel_resignation_report(
  p_request_id UUID,
  p_reason     TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.resignation_reports;
BEGIN
  SELECT * INTO v_req FROM public.resignation_reports WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบรายการ'; END IF;
  IF v_req.status <> 'reported' THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะรายการที่ยังไม่รับทราบ';
  END IF;
  IF NOT (public.is_hr_or_admin() OR v_req.reported_by = auth.uid()) THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะผู้แจ้ง หรือ HR';
  END IF;
  UPDATE public.resignation_reports
    SET status='cancelled', cancelled_at=now(), cancel_reason=p_reason
    WHERE id = p_request_id;
  RETURN jsonb_build_object('id', p_request_id, 'status', 'cancelled');
END $$;
GRANT EXECUTE ON FUNCTION public.cancel_resignation_report(UUID,TEXT) TO authenticated;

-- ════════ 8. Realtime ════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='resignation_reports'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.resignation_reports;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ════════ 9. Verify ════════
SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='resignation_reports') AS policies,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('create_resignation_report','acknowledge_resignation_report','cancel_resignation_report',
     'rsg_can_report','rsg_is_party')) AS functions,
  '✅ พร้อมใช้ — ต่อไปโค้ด frontend (data.js + app.js + index.html)' AS note;
