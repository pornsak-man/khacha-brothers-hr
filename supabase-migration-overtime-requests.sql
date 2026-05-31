-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — ระบบขอทำงานล่วงเวลา (Overtime / OT Requests)
--
-- BM ขอ OT ให้ลูกน้อง (พนักงานประจำ สายงาน operation ในสาขา) → AM/HR อนุมัติ
-- status: pending → approved / rejected / cancelled  (อนุมัติขั้นเดียว)
--
-- ⚠️ เฉพาะ employee_type='พนักงานประจำ' + scope='operation' (ตรวจซ้ำใน RPC กัน bypass)
-- รันใน Supabase SQL Editor (idempotent) — โปรเจกต์ kacha = xvulimfftkoiybvqdjqz
-- อิง pattern: supabase-migration-headcount-requests.sql
-- ═══════════════════════════════════════════════════════════

-- ════════ 1. TABLE ════════
CREATE TABLE IF NOT EXISTS public.overtime_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       TEXT NOT NULL REFERENCES public.branches(id),
  employee_id     TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  employee_name   TEXT,                       -- snapshot ตอนขอ
  position_title  TEXT,                       -- snapshot ตอนขอ
  ot_date         DATE NOT NULL,
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  ot_hours        NUMERIC(5,2),               -- ระบบคำนวณตอน insert (ข้ามเที่ยงคืน +24)
  reason          TEXT,
  -- pending → approved/rejected/cancelled (อนุมัติขั้นเดียวโดย AM/HR)
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by    UUID REFERENCES auth.users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ขั้นอนุมัติ (AM/HR)
  approved_by     UUID REFERENCES auth.users(id),
  approved_at     TIMESTAMPTZ,
  approver_note   TEXT,                       -- ใช้ทั้ง approve/reject
  -- ยกเลิก
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ot_branch   ON public.overtime_requests(branch_id);
CREATE INDEX IF NOT EXISTS idx_ot_status   ON public.overtime_requests(status);
CREATE INDEX IF NOT EXISTS idx_ot_date     ON public.overtime_requests(ot_date DESC);
CREATE INDEX IF NOT EXISTS idx_ot_employee ON public.overtime_requests(employee_id);

-- ════════ 2. updated_at trigger ════════
CREATE OR REPLACE FUNCTION public.fn_ot_set_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_ot_updated_at ON public.overtime_requests;
CREATE TRIGGER trg_ot_updated_at
  BEFORE UPDATE ON public.overtime_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_ot_set_updated_at();

-- ════════ 3. Helper functions ════════
-- ใครขอ OT ให้สาขานี้ได้: HR/admin, BM ของสาขาตัวเอง, หรือ AM/OM ของสาขาในความดูแล
-- (ตัด branch_staff/viewer ออก — พนักงานทั่วไปขอเองไม่ได้ ตาม flow BM→AM/HR)
CREATE OR REPLACE FUNCTION public.ot_can_request(p_branch_id TEXT)
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

-- ใครเห็นคำขอของสาขานี้ได้ (SELECT) — ชุดเดียวกับ ot_can_request
CREATE OR REPLACE FUNCTION public.ot_is_party(p_branch_id TEXT)
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

-- AM/OM ดูแลสาขานี้ไหม (สำหรับสิทธิ์อนุมัติ — BM ผู้ขออนุมัติเองไม่ได้)
CREATE OR REPLACE FUNCTION public.ot_is_am_of(p_branch_id TEXT)
RETURNS BOOLEAN LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_branches TEXT[];
BEGIN
  SELECT up.role, up.managed_branches INTO v_role, v_branches
  FROM public.user_profiles up WHERE up.user_id = auth.uid();
  IF v_role NOT IN ('area_manager','operation_manager') THEN RETURN FALSE; END IF;
  IF v_branches IS NULL THEN RETURN FALSE; END IF;
  RETURN p_branch_id = ANY(v_branches);
END $$;

GRANT EXECUTE ON FUNCTION public.ot_can_request(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ot_is_party(TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.ot_is_am_of(TEXT)   TO authenticated;

-- ════════ 4. RLS ════════
ALTER TABLE public.overtime_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ot_select" ON public.overtime_requests;
CREATE POLICY "ot_select" ON public.overtime_requests
  FOR SELECT TO authenticated
  USING (public.ot_is_party(branch_id));

DROP POLICY IF EXISTS "ot_insert" ON public.overtime_requests;
CREATE POLICY "ot_insert" ON public.overtime_requests
  FOR INSERT TO authenticated
  WITH CHECK (public.ot_can_request(branch_id));

-- UPDATE/DELETE ทำผ่าน RPC (SECURITY DEFINER) — policy นี้ defensive
DROP POLICY IF EXISTS "ot_update" ON public.overtime_requests;
CREATE POLICY "ot_update" ON public.overtime_requests
  FOR UPDATE TO authenticated
  USING (public.ot_is_party(branch_id))
  WITH CHECK (public.ot_is_party(branch_id));

DROP POLICY IF EXISTS "ot_delete" ON public.overtime_requests;
CREATE POLICY "ot_delete" ON public.overtime_requests
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ════════ 5. RPC: ขอ OT ════════
CREATE OR REPLACE FUNCTION public.create_overtime_request(
  p_branch_id      TEXT,
  p_employee_id    TEXT,
  p_employee_name  TEXT,
  p_position_title TEXT,
  p_ot_date        DATE,
  p_start_time     TIME,
  p_end_time       TIME,
  p_reason         TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID; v_branch TEXT; v_emp_type TEXT; v_scope TEXT; v_hours NUMERIC;
BEGIN
  IF NOT public.ot_can_request(p_branch_id) THEN
    RAISE EXCEPTION 'คุณไม่มีสิทธิ์ขอ OT ของสาขานี้';
  END IF;
  IF p_employee_id IS NULL OR btrim(p_employee_id) = '' THEN
    RAISE EXCEPTION 'ต้องระบุพนักงาน';
  END IF;
  IF p_ot_date IS NULL OR p_start_time IS NULL OR p_end_time IS NULL THEN
    RAISE EXCEPTION 'ต้องระบุวันที่ + เวลาเริ่ม + เวลาเลิก';
  END IF;

  -- ดึงข้อมูลพนักงาน + resolve scope (position → department)
  SELECT e.branch, e.employee_type, COALESCE(pl.scope, d.scope)
    INTO v_branch, v_emp_type, v_scope
  FROM public.employees e
  LEFT JOIN public.position_levels pl ON pl.id = e.position
  LEFT JOIN public.departments    d  ON d.id  = e.department
  WHERE e.id = p_employee_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบพนักงาน'; END IF;
  IF v_branch IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'พนักงานคนนี้ไม่ได้อยู่สาขาที่เลือก';
  END IF;
  -- ★ สิทธิ์ตามตัว: เฉพาะ full-time สาย operation
  IF v_emp_type IS DISTINCT FROM 'พนักงานประจำ' THEN
    RAISE EXCEPTION 'ขอ OT ได้เฉพาะพนักงานประจำ (full-time) เท่านั้น';
  END IF;
  IF v_scope IS DISTINCT FROM 'operation' THEN
    RAISE EXCEPTION 'ขอ OT ได้เฉพาะพนักงานสายงาน operation เท่านั้น';
  END IF;

  -- คำนวณชั่วโมง OT (ข้ามเที่ยงคืน → +24)
  v_hours := EXTRACT(EPOCH FROM (p_end_time - p_start_time)) / 3600.0;
  IF v_hours <= 0 THEN v_hours := v_hours + 24; END IF;
  IF v_hours <= 0 OR v_hours > 24 THEN
    RAISE EXCEPTION 'ช่วงเวลา OT ไม่ถูกต้อง';
  END IF;

  INSERT INTO public.overtime_requests
    (branch_id, employee_id, employee_name, position_title, ot_date, start_time, end_time, ot_hours, reason, status, requested_by)
  VALUES
    (p_branch_id, p_employee_id, btrim(coalesce(p_employee_name,'')),
     btrim(coalesce(p_position_title,'')), p_ot_date, p_start_time, p_end_time,
     round(v_hours, 2), p_reason, 'pending', auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'status', 'pending', 'ot_hours', round(v_hours, 2));
END $$;
GRANT EXECUTE ON FUNCTION public.create_overtime_request(TEXT,TEXT,TEXT,TEXT,DATE,TIME,TIME,TEXT) TO authenticated;

-- ════════ 6. RPC: อนุมัติ/ปฏิเสธ (AM ของสาขา หรือ HR/admin) ════════
CREATE OR REPLACE FUNCTION public.review_overtime_request(
  p_request_id UUID,
  p_decision   TEXT,   -- 'approve' | 'reject'
  p_note       TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.overtime_requests; v_new TEXT;
BEGIN
  IF p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'decision ต้องเป็น approve หรือ reject';
  END IF;
  SELECT * INTO v_req FROM public.overtime_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'คำขอนี้ไม่อยู่ในสถานะรออนุมัติ (สถานะ: %)', v_req.status;
  END IF;
  IF NOT (public.is_hr_or_admin() OR public.ot_is_am_of(v_req.branch_id)) THEN
    RAISE EXCEPTION 'ต้องเป็น AM ที่ดูแลสาขานี้ หรือ HR จึงจะอนุมัติได้';
  END IF;
  v_new := CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END;
  UPDATE public.overtime_requests
    SET status = v_new, approved_by = auth.uid(), approved_at = now(), approver_note = p_note
    WHERE id = p_request_id;
  RETURN jsonb_build_object('id', p_request_id, 'status', v_new);
END $$;
GRANT EXECUTE ON FUNCTION public.review_overtime_request(UUID,TEXT,TEXT) TO authenticated;

-- ════════ 7. RPC: ยกเลิก (ผู้ขอ หรือ HR) ════════
CREATE OR REPLACE FUNCTION public.cancel_overtime_request(
  p_request_id UUID,
  p_reason     TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.overtime_requests;
BEGIN
  SELECT * INTO v_req FROM public.overtime_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะคำขอที่ยังรออนุมัติ';
  END IF;
  IF NOT (public.is_hr_or_admin() OR v_req.requested_by = auth.uid()) THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะผู้ขอ หรือ HR';
  END IF;
  UPDATE public.overtime_requests
    SET status='cancelled', cancelled_at=now(), cancel_reason=p_reason
    WHERE id = p_request_id;
  RETURN jsonb_build_object('id', p_request_id, 'status', 'cancelled');
END $$;
GRANT EXECUTE ON FUNCTION public.cancel_overtime_request(UUID,TEXT) TO authenticated;

-- ════════ 8. Realtime ════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='overtime_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.overtime_requests;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ════════ 9. Verify ════════
SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='overtime_requests') AS policies,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('create_overtime_request','review_overtime_request','cancel_overtime_request',
     'ot_can_request','ot_is_party','ot_is_am_of')) AS functions,
  '✅ พร้อมใช้ — ต่อไปโค้ด frontend (data.js + app.js + index.html)' AS note;
