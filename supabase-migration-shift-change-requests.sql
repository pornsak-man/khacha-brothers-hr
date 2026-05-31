-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — ระบบขออนุมัติเปลี่ยนกะย้อนหลัง (Shift-Change Requests)
--
-- BM ขอเปลี่ยนกะของพนักงานในวันที่ผ่านมาแล้ว → AM/HR อนุมัติ
--   → ตอนอนุมัติ ระบบแก้กะใน schedule_entries ให้อัตโนมัติ (ข้าม guard ย้อนหลัง อย่างปลอดภัย)
-- status: pending → approved(+applied) / rejected / cancelled
--
-- รันใน Supabase SQL Editor (idempotent) — โปรเจกต์ kacha = xvulimfftkoiybvqdjqz
-- อิง pattern: supabase-migration-overtime-requests.sql
-- ═══════════════════════════════════════════════════════════

-- ════════ 1. TABLE ════════
CREATE TABLE IF NOT EXISTS public.shift_change_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       TEXT NOT NULL REFERENCES public.branches(id),
  employee_id     TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  employee_name   TEXT,
  position_title  TEXT,
  work_date       DATE NOT NULL,                       -- วันอดีตที่ขอแก้กะ
  old_shift_id    UUID REFERENCES public.shifts(id),   -- snapshot กะเดิม ตอนขอ
  old_shift_code  TEXT,
  new_shift_id    UUID NOT NULL REFERENCES public.shifts(id),
  new_shift_code  TEXT,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by    UUID REFERENCES auth.users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by     UUID REFERENCES auth.users(id),
  approved_at     TIMESTAMPTZ,
  approver_note   TEXT,
  applied         BOOLEAN NOT NULL DEFAULT false,      -- แก้กะในตารางสำเร็จแล้วหรือยัง
  applied_at      TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scr_branch    ON public.shift_change_requests(branch_id);
CREATE INDEX IF NOT EXISTS idx_scr_status    ON public.shift_change_requests(status);
CREATE INDEX IF NOT EXISTS idx_scr_work_date ON public.shift_change_requests(work_date DESC);
-- กันขอซ้ำ: พนักงาน+วัน เดียวกัน มี pending ค้างได้แค่รายการเดียว
CREATE UNIQUE INDEX IF NOT EXISTS uq_scr_open
  ON public.shift_change_requests(employee_id, work_date) WHERE status = 'pending';

-- ════════ 2. updated_at trigger ════════
CREATE OR REPLACE FUNCTION public.fn_scr_set_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_scr_updated_at ON public.shift_change_requests;
CREATE TRIGGER trg_scr_updated_at
  BEFORE UPDATE ON public.shift_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_scr_set_updated_at();

-- ════════ 3. Helper functions (ระดับ BM/AM/OM/HR — ไม่รวม branch_staff) ════════
CREATE OR REPLACE FUNCTION public.scr_can_request(p_branch_id TEXT)
RETURNS BOOLEAN LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_branches TEXT[]; v_own TEXT;
BEGIN
  IF public.is_hr_or_admin() THEN RETURN TRUE; END IF;
  SELECT up.role, up.managed_branches, e.branch INTO v_role, v_branches, v_own
  FROM public.user_profiles up
  LEFT JOIN public.employees e ON e.id = up.employee_id
  WHERE up.user_id = auth.uid();
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF v_role = 'branch_manager' AND v_own IS NOT NULL AND v_own = p_branch_id THEN RETURN TRUE; END IF;
  IF v_role IN ('area_manager','operation_manager') AND v_branches IS NOT NULL THEN
    RETURN p_branch_id = ANY(v_branches);
  END IF;
  RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION public.scr_is_party(p_branch_id TEXT)
RETURNS BOOLEAN LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_branches TEXT[]; v_own TEXT;
BEGIN
  IF public.is_hr_or_admin() THEN RETURN TRUE; END IF;
  SELECT up.role, up.managed_branches, e.branch INTO v_role, v_branches, v_own
  FROM public.user_profiles up
  LEFT JOIN public.employees e ON e.id = up.employee_id
  WHERE up.user_id = auth.uid();
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF v_role = 'branch_manager' AND v_own IS NOT NULL AND v_own = p_branch_id THEN RETURN TRUE; END IF;
  IF v_role IN ('area_manager','operation_manager') AND v_branches IS NOT NULL THEN
    RETURN p_branch_id = ANY(v_branches);
  END IF;
  RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION public.scr_is_am_of(p_branch_id TEXT)
RETURNS BOOLEAN LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_branches TEXT[];
BEGIN
  SELECT up.role, up.managed_branches INTO v_role, v_branches
  FROM public.user_profiles up WHERE up.user_id = auth.uid();
  IF v_role NOT IN ('area_manager','operation_manager') THEN RETURN FALSE; END IF;
  IF v_branches IS NULL THEN RETURN FALSE; END IF;
  RETURN p_branch_id = ANY(v_branches);
END $$;

GRANT EXECUTE ON FUNCTION public.scr_can_request(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scr_is_party(TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.scr_is_am_of(TEXT)   TO authenticated;

-- ════════ 4. RLS ════════
ALTER TABLE public.shift_change_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scr_select" ON public.shift_change_requests;
CREATE POLICY "scr_select" ON public.shift_change_requests
  FOR SELECT TO authenticated USING (public.scr_is_party(branch_id));

DROP POLICY IF EXISTS "scr_insert" ON public.shift_change_requests;
CREATE POLICY "scr_insert" ON public.shift_change_requests
  FOR INSERT TO authenticated WITH CHECK (public.scr_can_request(branch_id));

DROP POLICY IF EXISTS "scr_update" ON public.shift_change_requests;
CREATE POLICY "scr_update" ON public.shift_change_requests
  FOR UPDATE TO authenticated
  USING (public.scr_is_party(branch_id)) WITH CHECK (public.scr_is_party(branch_id));

DROP POLICY IF EXISTS "scr_delete" ON public.shift_change_requests;
CREATE POLICY "scr_delete" ON public.shift_change_requests
  FOR DELETE TO authenticated USING (public.is_admin());

-- ════════ 5. RPC: ขอเปลี่ยนกะย้อนหลัง ════════
CREATE OR REPLACE FUNCTION public.create_shift_change_request(
  p_branch_id      TEXT,
  p_employee_id    TEXT,
  p_employee_name  TEXT,
  p_position_title TEXT,
  p_work_date      DATE,
  p_new_shift_id   UUID,
  p_reason         TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID; v_emp_branch TEXT; v_week UUID; v_today DATE;
        v_old_id UUID; v_old_code TEXT; v_new_code TEXT;
BEGIN
  IF NOT public.scr_can_request(p_branch_id) THEN
    RAISE EXCEPTION 'คุณไม่มีสิทธิ์ขอเปลี่ยนกะของสาขานี้';
  END IF;
  IF p_employee_id IS NULL OR btrim(p_employee_id) = '' THEN RAISE EXCEPTION 'ต้องระบุพนักงาน'; END IF;
  IF p_work_date IS NULL OR p_new_shift_id IS NULL THEN RAISE EXCEPTION 'ต้องระบุวันที่ + กะใหม่'; END IF;

  v_today := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  IF p_work_date >= v_today THEN
    RAISE EXCEPTION 'ใช้สำหรับแก้กะย้อนหลังเท่านั้น (วันที่ต้องเป็นอดีต) — วันปัจจุบัน/อนาคตแก้ในตารางได้เลย';
  END IF;

  SELECT branch INTO v_emp_branch FROM public.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบพนักงาน'; END IF;
  IF v_emp_branch IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'พนักงานคนนี้ไม่ได้อยู่สาขาที่เลือก';
  END IF;

  SELECT code INTO v_new_code FROM public.shifts WHERE id = p_new_shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบกะที่เลือก'; END IF;

  -- หาตารางสัปดาห์ของวันนั้น (week_start = จันทร์)
  SELECT id INTO v_week FROM public.schedule_weeks
   WHERE branch_id = p_branch_id AND week_start = date_trunc('week', p_work_date)::date;
  IF v_week IS NULL THEN
    RAISE EXCEPTION 'ยังไม่มีตารางของสัปดาห์นั้น — สร้าง/จัดตารางสัปดาห์นั้นก่อน';
  END IF;

  -- snapshot กะเดิมในวันนั้น (ถ้ามี)
  SELECT se.shift_id, sh.code INTO v_old_id, v_old_code
  FROM public.schedule_entries se
  LEFT JOIN public.shifts sh ON sh.id = se.shift_id
  WHERE se.schedule_week_id = v_week AND se.employee_id = p_employee_id AND se.work_date = p_work_date;

  IF EXISTS (SELECT 1 FROM public.shift_change_requests
             WHERE employee_id = p_employee_id AND work_date = p_work_date AND status = 'pending') THEN
    RAISE EXCEPTION 'มีคำขอเปลี่ยนกะของพนักงานคนนี้ในวันนั้นค้างอยู่แล้ว';
  END IF;

  INSERT INTO public.shift_change_requests
    (branch_id, employee_id, employee_name, position_title, work_date,
     old_shift_id, old_shift_code, new_shift_id, new_shift_code, reason, status, requested_by)
  VALUES
    (p_branch_id, p_employee_id, btrim(coalesce(p_employee_name,'')), btrim(coalesce(p_position_title,'')),
     p_work_date, v_old_id, v_old_code, p_new_shift_id, v_new_code, p_reason, 'pending', auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'status', 'pending');
END $$;
GRANT EXECUTE ON FUNCTION public.create_shift_change_request(TEXT,TEXT,TEXT,TEXT,DATE,UUID,TEXT) TO authenticated;

-- ════════ 6. RPC: อนุมัติ/ปฏิเสธ — อนุมัติแล้ว apply เข้าตารางอัตโนมัติ ════════
CREATE OR REPLACE FUNCTION public.review_shift_change_request(
  p_request_id UUID,
  p_decision   TEXT,   -- 'approve' | 'reject'
  p_note       TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.shift_change_requests; v_week UUID; v_cross BOOLEAN;
BEGIN
  IF p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'decision ต้องเป็น approve หรือ reject';
  END IF;
  SELECT * INTO v_req FROM public.shift_change_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'คำขอนี้ไม่อยู่ในสถานะรออนุมัติ (สถานะ: %)', v_req.status;
  END IF;
  IF NOT (public.is_hr_or_admin() OR public.scr_is_am_of(v_req.branch_id)) THEN
    RAISE EXCEPTION 'ต้องเป็น AM ที่ดูแลสาขานี้ หรือ HR จึงจะอนุมัติได้';
  END IF;

  IF p_decision = 'reject' THEN
    UPDATE public.shift_change_requests
      SET status='rejected', approved_by=auth.uid(), approved_at=now(), approver_note=p_note
      WHERE id = p_request_id;
    RETURN jsonb_build_object('id', p_request_id, 'status', 'rejected');
  END IF;

  -- ── approve → แก้กะในตารางให้อัตโนมัติ ──
  SELECT id INTO v_week FROM public.schedule_weeks
   WHERE branch_id = v_req.branch_id AND week_start = date_trunc('week', v_req.work_date)::date;
  IF v_week IS NULL THEN
    RAISE EXCEPTION 'ไม่พบตารางของสัปดาห์นั้นแล้ว — แก้กะอัตโนมัติไม่ได้';
  END IF;
  SELECT (branch IS DISTINCT FROM v_req.branch_id) INTO v_cross FROM public.employees WHERE id = v_req.employee_id;

  INSERT INTO public.schedule_entries
    (schedule_week_id, employee_id, work_date, shift_id, branch_id, is_cross_branch)
  VALUES
    (v_week, v_req.employee_id, v_req.work_date, v_req.new_shift_id, v_req.branch_id, COALESCE(v_cross, false))
  ON CONFLICT (schedule_week_id, employee_id, work_date)
    DO UPDATE SET shift_id = EXCLUDED.shift_id, branch_id = EXCLUDED.branch_id,
                  custom_start_time = NULL, custom_end_time = NULL, custom_break_minutes = 0, custom_label = NULL,
                  is_cross_branch = EXCLUDED.is_cross_branch, updated_at = now();

  UPDATE public.shift_change_requests
    SET status='approved', approved_by=auth.uid(), approved_at=now(), approver_note=p_note,
        applied=true, applied_at=now()
    WHERE id = p_request_id;
  RETURN jsonb_build_object('id', p_request_id, 'status', 'approved', 'applied', true);
END $$;
GRANT EXECUTE ON FUNCTION public.review_shift_change_request(UUID,TEXT,TEXT) TO authenticated;

-- ════════ 7. RPC: ยกเลิก (ผู้ขอ หรือ HR) ════════
CREATE OR REPLACE FUNCTION public.cancel_shift_change_request(
  p_request_id UUID,
  p_reason     TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.shift_change_requests;
BEGIN
  SELECT * INTO v_req FROM public.shift_change_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'ยกเลิกได้เฉพาะคำขอที่ยังรออนุมัติ'; END IF;
  IF NOT (public.is_hr_or_admin() OR v_req.requested_by = auth.uid()) THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะผู้ขอ หรือ HR';
  END IF;
  UPDATE public.shift_change_requests
    SET status='cancelled', cancelled_at=now(), cancel_reason=p_reason WHERE id = p_request_id;
  RETURN jsonb_build_object('id', p_request_id, 'status', 'cancelled');
END $$;
GRANT EXECUTE ON FUNCTION public.cancel_shift_change_request(UUID,TEXT) TO authenticated;

-- ════════ 8. Realtime ════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='shift_change_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_change_requests;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ════════ 9. Verify ════════
SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='shift_change_requests') AS policies,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('create_shift_change_request','review_shift_change_request','cancel_shift_change_request',
     'scr_can_request','scr_is_party','scr_is_am_of')) AS functions,
  '✅ พร้อมใช้ — ต่อไปโค้ด frontend (data.js + app.js + index.html)' AS note;
