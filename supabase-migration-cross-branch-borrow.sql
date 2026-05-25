-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Cross-Branch Borrow Request (Phase 3 — Level 3 workflow)
--
-- ปัญหาเดิม:
--   BM ของสาขา A เพิ่มพนักงาน X (สังกัด B) มาช่วยใส่ตารางได้
--   AM ของ A อนุมัติเอง — AM ของ B ไม่รู้ + ไม่มีสิทธิ์ veto
--   → conflict double-booking + ไม่มี audit trail
--
-- กลไกใหม่:
--   1. BM A สร้าง "ขอยืมพนักงาน X จากสาขา B" → ระบุวัน + เหตุผล
--   2. AM ของ B พิจารณา → อนุมัติ/ปฏิเสธ
--   3. ถ้าอนุมัติ → BM A ใส่ X ในตาราง (วันที่อนุมัติ) ได้
--   4. ถ้าไม่อนุมัติ → BM A schedule X วันนั้นไม่ได้ (trigger block)
--
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ════════ 1. TABLE ════════
CREATE TABLE IF NOT EXISTS public.cross_branch_borrow_requests (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  source_branch_id       TEXT NOT NULL REFERENCES public.branches(id),
  destination_branch_id  TEXT NOT NULL REFERENCES public.branches(id),
  work_dates             DATE[] NOT NULL,         -- array ของวันที่ขอยืม
  reason                 TEXT,                    -- เหตุผลที่ขอยืม
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by           UUID REFERENCES auth.users(id),    -- BM/HR ที่สร้างคำขอ
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by            UUID REFERENCES auth.users(id),    -- AM source ที่ review
  reviewed_at            TIMESTAMPTZ,
  approver_note          TEXT,
  reject_reason          TEXT,
  cancelled_at           TIMESTAMPTZ,
  cancel_reason          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_branches_different CHECK (source_branch_id <> destination_branch_id),
  CONSTRAINT chk_work_dates_nonempty CHECK (array_length(work_dates, 1) >= 1)
);

CREATE INDEX IF NOT EXISTS idx_borrow_employee ON public.cross_branch_borrow_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_borrow_source   ON public.cross_branch_borrow_requests(source_branch_id);
CREATE INDEX IF NOT EXISTS idx_borrow_dest     ON public.cross_branch_borrow_requests(destination_branch_id);
CREATE INDEX IF NOT EXISTS idx_borrow_status   ON public.cross_branch_borrow_requests(status);
CREATE INDEX IF NOT EXISTS idx_borrow_dates    ON public.cross_branch_borrow_requests USING GIN (work_dates);

-- ════════ 2. AUTO updated_at TRIGGER ════════
CREATE OR REPLACE FUNCTION public.fn_borrow_set_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_borrow_updated_at ON public.cross_branch_borrow_requests;
CREATE TRIGGER trg_borrow_updated_at
  BEFORE UPDATE ON public.cross_branch_borrow_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_borrow_set_updated_at();

-- ════════ 3. HELPER FUNCTIONS (ต้องสร้างก่อน RLS policies ที่ใช้) ════════

-- helper: เช็คว่า user สามารถสร้าง schedule ของ branch นั้นได้ไหม
-- (ใช้ใน RLS INSERT — ต้อง STABLE function)
CREATE OR REPLACE FUNCTION public.can_create_schedule_for_branch(p_branch TEXT)
RETURNS BOOLEAN
LANGUAGE PLPGSQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_branches TEXT[];
  v_my_branch TEXT;
BEGIN
  IF public.is_hr_or_admin() THEN RETURN TRUE; END IF;
  SELECT role, managed_branches INTO v_role, v_branches
  FROM public.user_profiles WHERE user_id = auth.uid();
  IF v_role = 'operation_manager' THEN RETURN TRUE; END IF;
  IF v_role NOT IN ('branch_manager', 'area_manager') THEN RETURN FALSE; END IF;
  IF v_branches IS NOT NULL AND array_length(v_branches, 1) > 0 THEN
    RETURN p_branch = ANY(v_branches);
  END IF;
  SELECT e.branch INTO v_my_branch
  FROM public.employees e
  JOIN public.user_profiles up ON up.employee_id = e.id
  WHERE up.user_id = auth.uid();
  RETURN v_my_branch = p_branch;
END $$;

-- HELPER: ใครเป็นผู้เกี่ยวข้องกับคำขอ (BM/AM ของ source หรือ destination)
-- (ใช้ใน RLS SELECT/UPDATE — ต้อง STABLE function)
CREATE OR REPLACE FUNCTION public.is_borrow_party(p_source TEXT, p_dest TEXT)
RETURNS BOOLEAN
LANGUAGE PLPGSQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_branches TEXT[];
  v_my_branch TEXT;
BEGIN
  IF public.is_hr_or_admin() THEN RETURN TRUE; END IF;
  SELECT role, managed_branches INTO v_role, v_branches
  FROM public.user_profiles WHERE user_id = auth.uid();
  IF v_role NOT IN ('area_manager', 'operation_manager', 'branch_manager') THEN
    RETURN FALSE;
  END IF;
  -- เช็ค managed_branches override
  IF v_branches IS NOT NULL AND array_length(v_branches, 1) > 0 THEN
    RETURN (p_source = ANY(v_branches)) OR (p_dest = ANY(v_branches));
  END IF;
  -- fallback: emp.branch ของตัวเอง
  SELECT e.branch INTO v_my_branch
  FROM public.employees e
  JOIN public.user_profiles up ON up.employee_id = e.id
  WHERE up.user_id = auth.uid();
  RETURN v_my_branch IN (p_source, p_dest);
END $$;

-- ════════ 3.5 RLS POLICIES ════════
ALTER TABLE public.cross_branch_borrow_requests ENABLE ROW LEVEL SECURITY;

-- SELECT: HR/admin + party ทั้ง source/destination + AM/OM
DROP POLICY IF EXISTS "borrow_select" ON public.cross_branch_borrow_requests;
CREATE POLICY "borrow_select" ON public.cross_branch_borrow_requests
  FOR SELECT TO authenticated
  USING (public.is_borrow_party(source_branch_id, destination_branch_id));

-- INSERT: HR/admin + BM/AM ของ destination (ใครจะใช้งานพนักงานคนนั้น)
DROP POLICY IF EXISTS "borrow_insert" ON public.cross_branch_borrow_requests;
CREATE POLICY "borrow_insert" ON public.cross_branch_borrow_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_hr_or_admin()
    OR public.can_create_schedule_for_branch(destination_branch_id)
  );

-- UPDATE: HR/admin + AM ของ source (เพราะ approve/reject) + requester (cancel)
DROP POLICY IF EXISTS "borrow_update" ON public.cross_branch_borrow_requests;
CREATE POLICY "borrow_update" ON public.cross_branch_borrow_requests
  FOR UPDATE TO authenticated
  USING (public.is_borrow_party(source_branch_id, destination_branch_id))
  WITH CHECK (public.is_borrow_party(source_branch_id, destination_branch_id));

-- DELETE: เฉพาะ HR/admin
DROP POLICY IF EXISTS "borrow_delete" ON public.cross_branch_borrow_requests;
CREATE POLICY "borrow_delete" ON public.cross_branch_borrow_requests
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ════════ 4. RPCs ════════

-- 4.1 สร้างคำขอยืม (BM destination เรียก)
CREATE OR REPLACE FUNCTION public.create_borrow_request(
  p_employee_id           TEXT,
  p_destination_branch_id TEXT,
  p_work_dates            DATE[],
  p_reason                TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_branch TEXT;
  v_new_id        UUID;
BEGIN
  IF NOT public.can_create_schedule_for_branch(p_destination_branch_id) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ขอยืมพนักงานเข้าสาขานี้';
  END IF;

  -- หา source branch จาก employee
  SELECT branch INTO v_source_branch FROM public.employees WHERE id = p_employee_id;
  IF v_source_branch IS NULL THEN
    RAISE EXCEPTION 'ไม่พบพนักงาน %', p_employee_id;
  END IF;
  IF v_source_branch = p_destination_branch_id THEN
    RAISE EXCEPTION 'พนักงานคนนี้สังกัดสาขาปลายทางอยู่แล้ว — ไม่ต้องขอยืม';
  END IF;

  -- validate dates
  IF p_work_dates IS NULL OR array_length(p_work_dates, 1) < 1 THEN
    RAISE EXCEPTION 'ต้องระบุวันทำงานอย่างน้อย 1 วัน';
  END IF;

  INSERT INTO public.cross_branch_borrow_requests (
    employee_id, source_branch_id, destination_branch_id,
    work_dates, reason, requested_by
  ) VALUES (
    p_employee_id, v_source_branch, p_destination_branch_id,
    p_work_dates, p_reason, auth.uid()
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('id', v_new_id, 'status', 'pending');
END $$;

GRANT EXECUTE ON FUNCTION public.create_borrow_request(TEXT, TEXT, DATE[], TEXT) TO authenticated;

-- 4.2 อนุมัติ/ปฏิเสธ (AM source เรียก)
CREATE OR REPLACE FUNCTION public.review_borrow_request(
  p_request_id UUID,
  p_decision   TEXT,                -- 'approved' / 'rejected'
  p_note       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req RECORD;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'p_decision ต้องเป็น approved หรือ rejected';
  END IF;

  SELECT * INTO v_req FROM public.cross_branch_borrow_requests WHERE id = p_request_id;
  IF v_req IS NULL THEN
    RAISE EXCEPTION 'ไม่พบคำขอ';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'คำขอนี้ review ไปแล้ว (สถานะ: %)', v_req.status;
  END IF;

  -- เช็คสิทธิ์: HR/admin หรือ AM ของ source_branch
  IF NOT public.is_hr_or_admin() THEN
    DECLARE
      v_role TEXT; v_branches TEXT[]; v_my_branch TEXT;
    BEGIN
      SELECT role, managed_branches INTO v_role, v_branches
      FROM public.user_profiles WHERE user_id = auth.uid();
      IF v_role NOT IN ('area_manager', 'operation_manager') THEN
        RAISE EXCEPTION 'ต้องเป็น Area/Operation Manager ของสาขาแม่ของพนักงาน';
      END IF;
      IF v_branches IS NOT NULL AND array_length(v_branches, 1) > 0 THEN
        IF NOT (v_req.source_branch_id = ANY(v_branches)) THEN
          RAISE EXCEPTION 'คุณไม่ได้ดูแลสาขา % (สาขาแม่ของพนักงาน)', v_req.source_branch_id;
        END IF;
      ELSE
        SELECT e.branch INTO v_my_branch
        FROM public.employees e
        JOIN public.user_profiles up ON up.employee_id = e.id
        WHERE up.user_id = auth.uid();
        IF v_my_branch IS DISTINCT FROM v_req.source_branch_id THEN
          RAISE EXCEPTION 'คุณไม่ได้สังกัดสาขา % (สาขาแม่ของพนักงาน)', v_req.source_branch_id;
        END IF;
      END IF;
    END;
  END IF;

  UPDATE public.cross_branch_borrow_requests
  SET status        = p_decision,
      reviewed_by   = auth.uid(),
      reviewed_at   = now(),
      approver_note = CASE WHEN p_decision = 'approved' THEN p_note ELSE approver_note END,
      reject_reason = CASE WHEN p_decision = 'rejected' THEN p_note ELSE reject_reason END
  WHERE id = p_request_id;

  RETURN jsonb_build_object('id', p_request_id, 'status', p_decision);
END $$;

GRANT EXECUTE ON FUNCTION public.review_borrow_request(UUID, TEXT, TEXT) TO authenticated;

-- 4.3 ยกเลิกคำขอ (requester หรือ HR เรียก)
CREATE OR REPLACE FUNCTION public.cancel_borrow_request(
  p_request_id UUID,
  p_reason     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req RECORD;
BEGIN
  SELECT * INTO v_req FROM public.cross_branch_borrow_requests WHERE id = p_request_id;
  IF v_req IS NULL THEN
    RAISE EXCEPTION 'ไม่พบคำขอ';
  END IF;
  IF v_req.status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'ยกเลิกไม่ได้ (สถานะปัจจุบัน: %)', v_req.status;
  END IF;
  IF NOT public.is_hr_or_admin() AND v_req.requested_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'เฉพาะผู้สร้างคำขอ (หรือ HR/admin) ที่ยกเลิกได้';
  END IF;

  UPDATE public.cross_branch_borrow_requests
  SET status         = 'cancelled',
      cancelled_at   = now(),
      cancel_reason  = p_reason
  WHERE id = p_request_id;

  RETURN jsonb_build_object('id', p_request_id, 'status', 'cancelled');
END $$;

GRANT EXECUTE ON FUNCTION public.cancel_borrow_request(UUID, TEXT) TO authenticated;

-- ════════ 5. TRIGGER บน schedule_entries ════════
-- block การ insert/update cross-branch entry ที่ไม่มี approved borrow request ครอบคลุม
CREATE OR REPLACE FUNCTION public.fn_enforce_borrow_approved()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp_branch TEXT;
  v_has_approval BOOLEAN;
BEGIN
  -- HR/admin bypass (per memory rule: HR/admin ทำได้ทุกอย่าง)
  IF public.is_hr_or_admin() THEN
    RETURN NEW;
  END IF;

  -- ดู branch ของพนักงาน
  SELECT branch INTO v_emp_branch FROM public.employees WHERE id = NEW.employee_id;
  IF v_emp_branch IS NULL THEN RETURN NEW; END IF;

  -- ถ้า employee สังกัดสาขาเดียวกับตาราง → ไม่ต้องเช็ค borrow
  IF v_emp_branch = NEW.branch_id THEN
    RETURN NEW;
  END IF;

  -- ต้องมี approved borrow request ที่ครอบคลุมวันนี้
  SELECT EXISTS (
    SELECT 1 FROM public.cross_branch_borrow_requests
    WHERE employee_id = NEW.employee_id
      AND source_branch_id = v_emp_branch
      AND destination_branch_id = NEW.branch_id
      AND status = 'approved'
      AND NEW.work_date = ANY(work_dates)
  ) INTO v_has_approval;

  IF NOT v_has_approval THEN
    RAISE EXCEPTION 'พนักงาน % สังกัดสาขา % — ต้องมี "คำขอยืมพนักงาน" ที่ AM ของสาขา % อนุมัติก่อน',
      NEW.employee_id, v_emp_branch, v_emp_branch;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_borrow_approved ON public.schedule_entries;
CREATE TRIGGER trg_enforce_borrow_approved
  BEFORE INSERT OR UPDATE ON public.schedule_entries
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_borrow_approved();

-- ════════ 6. REALTIME ════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'cross_branch_borrow_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cross_branch_borrow_requests;
  END IF;
END $$;

-- ════════ 7. AUDIT TRIGGER ════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_trigger_fn' AND pronamespace = 'public'::regnamespace) THEN
    DROP TRIGGER IF EXISTS audit_trigger ON public.cross_branch_borrow_requests;
    CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.cross_branch_borrow_requests
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ Cross-Branch Borrow workflow ติดตั้งเสร็จ';
  RAISE NOTICE '   - table cross_branch_borrow_requests + indexes';
  RAISE NOTICE '   - RLS policies (source/destination party ดูได้)';
  RAISE NOTICE '   - RPC: create_borrow_request, review_borrow_request, cancel_borrow_request';
  RAISE NOTICE '   - trigger บน schedule_entries: block cross-branch ที่ไม่มี approval';
  RAISE NOTICE '   - realtime + audit log';
END $$;
