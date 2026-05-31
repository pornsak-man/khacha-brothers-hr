-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — ระบบขออัตรากำลัง (Headcount Requests)
--
-- BM สร้างคำขอ → AM อนุมัติ (ขั้น 1) → HR อนุมัติ (ขั้น 2) → จบ
-- status: pending_am → pending_hr → approved / rejected / cancelled
--
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- อิง pattern: supabase-migration-cross-branch-borrow.sql
-- ═══════════════════════════════════════════════════════════

-- ════════ 1. TABLE ════════
CREATE TABLE IF NOT EXISTS public.headcount_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       TEXT NOT NULL REFERENCES public.branches(id),
  position_id     TEXT,                       -- อ้าง position_levels.id (nullable เผื่อ freetext)
  position_title  TEXT NOT NULL,              -- ชื่อตำแหน่ง (snapshot ตอนขอ)
  headcount       INT  NOT NULL CHECK (headcount >= 1),
  reason          TEXT,
  -- 2-step chain: pending_am → pending_hr → approved/rejected/cancelled
  status          TEXT NOT NULL DEFAULT 'pending_am'
                  CHECK (status IN ('pending_am','pending_hr','approved','rejected','cancelled')),
  requested_by    UUID REFERENCES auth.users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ขั้น AM
  am_by           UUID REFERENCES auth.users(id),
  am_at           TIMESTAMPTZ,
  am_note         TEXT,
  -- ขั้น HR
  hr_by           UUID REFERENCES auth.users(id),
  hr_at           TIMESTAMPTZ,
  hr_note         TEXT,
  -- ปฏิเสธ / ยกเลิก
  reject_reason   TEXT,
  rejected_by_role TEXT CHECK (rejected_by_role IN ('am','hr')),
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hc_branch ON public.headcount_requests(branch_id);
CREATE INDEX IF NOT EXISTS idx_hc_status ON public.headcount_requests(status);
CREATE INDEX IF NOT EXISTS idx_hc_requested_at ON public.headcount_requests(requested_at DESC);

-- ════════ 2. updated_at trigger ════════
CREATE OR REPLACE FUNCTION public.fn_hc_set_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_hc_updated_at ON public.headcount_requests;
CREATE TRIGGER trg_hc_updated_at
  BEFORE UPDATE ON public.headcount_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_hc_set_updated_at();

-- ════════ 3. Helper functions ════════
-- ใครสร้างคำขอให้สาขานี้ได้: HR/admin หรือ BM/AM ของสาขานั้น
CREATE OR REPLACE FUNCTION public.hc_can_request(p_branch_id TEXT)
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
  -- BM / branch_staff → สาขาตัวเอง
  IF v_own IS NOT NULL AND v_own = p_branch_id THEN RETURN TRUE; END IF;
  -- AM / OM → สาขาในความดูแล
  IF v_role IN ('area_manager','operation_manager') AND v_branches IS NOT NULL THEN
    RETURN p_branch_id = ANY(v_branches);
  END IF;
  RETURN FALSE;
END $$;

-- ใครเห็นคำขอของสาขานี้ได้ (SELECT): HR/admin หรือ ผู้เกี่ยวข้องกับสาขา
CREATE OR REPLACE FUNCTION public.hc_is_party(p_branch_id TEXT)
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
  IF v_own IS NOT NULL AND v_own = p_branch_id THEN RETURN TRUE; END IF;
  IF v_role IN ('area_manager','operation_manager') AND v_branches IS NOT NULL THEN
    RETURN p_branch_id = ANY(v_branches);
  END IF;
  RETURN FALSE;
END $$;

-- AM/OM ดูแลสาขานี้ไหม (สำหรับขั้นอนุมัติ AM)
CREATE OR REPLACE FUNCTION public.hc_is_am_of(p_branch_id TEXT)
RETURNS BOOLEAN LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_branches TEXT[];
BEGIN
  SELECT up.role, up.managed_branches INTO v_role, v_branches
  FROM public.user_profiles up WHERE up.user_id = auth.uid();
  IF v_role NOT IN ('area_manager','operation_manager') THEN RETURN FALSE; END IF;
  IF v_branches IS NULL THEN RETURN FALSE; END IF;
  RETURN p_branch_id = ANY(v_branches);
END $$;

GRANT EXECUTE ON FUNCTION public.hc_can_request(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hc_is_party(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hc_is_am_of(TEXT) TO authenticated;

-- ════════ 4. RLS ════════
ALTER TABLE public.headcount_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hc_select" ON public.headcount_requests;
CREATE POLICY "hc_select" ON public.headcount_requests
  FOR SELECT TO authenticated
  USING (public.hc_is_party(branch_id));

DROP POLICY IF EXISTS "hc_insert" ON public.headcount_requests;
CREATE POLICY "hc_insert" ON public.headcount_requests
  FOR INSERT TO authenticated
  WITH CHECK (public.hc_can_request(branch_id));

-- UPDATE/DELETE ทำผ่าน RPC (SECURITY DEFINER) — policy นี้ defensive
DROP POLICY IF EXISTS "hc_update" ON public.headcount_requests;
CREATE POLICY "hc_update" ON public.headcount_requests
  FOR UPDATE TO authenticated
  USING (public.hc_is_party(branch_id))
  WITH CHECK (public.hc_is_party(branch_id));

DROP POLICY IF EXISTS "hc_delete" ON public.headcount_requests;
CREATE POLICY "hc_delete" ON public.headcount_requests
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ════════ 5. RPC: สร้างคำขอ ════════
CREATE OR REPLACE FUNCTION public.create_headcount_request(
  p_branch_id      TEXT,
  p_position_id    TEXT,
  p_position_title TEXT,
  p_headcount      INT,
  p_reason         TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT public.hc_can_request(p_branch_id) THEN
    RAISE EXCEPTION 'คุณไม่มีสิทธิ์สร้างคำขออัตรากำลังของสาขานี้';
  END IF;
  IF p_headcount IS NULL OR p_headcount < 1 THEN
    RAISE EXCEPTION 'จำนวนอัตราต้องอย่างน้อย 1';
  END IF;
  IF p_position_title IS NULL OR btrim(p_position_title) = '' THEN
    RAISE EXCEPTION 'ต้องระบุตำแหน่ง';
  END IF;
  INSERT INTO public.headcount_requests
    (branch_id, position_id, position_title, headcount, reason, status, requested_by)
  VALUES
    (p_branch_id, p_position_id, btrim(p_position_title), p_headcount, p_reason, 'pending_am', auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'status', 'pending_am');
END $$;
GRANT EXECUTE ON FUNCTION public.create_headcount_request(TEXT,TEXT,TEXT,INT,TEXT) TO authenticated;

-- ════════ 6. RPC: อนุมัติ/ปฏิเสธ (2-step ตามสถานะ) ════════
-- p_decision: 'approve' | 'reject'
--   pending_am + approve → pending_hr (AM endorse)
--   pending_am + reject  → rejected (by am)
--   pending_hr + approve → approved (HR final)
--   pending_hr + reject  → rejected (by hr)
CREATE OR REPLACE FUNCTION public.review_headcount_request(
  p_request_id UUID,
  p_decision   TEXT,
  p_note       TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.headcount_requests; v_is_hr BOOLEAN; v_is_am BOOLEAN; v_new_status TEXT;
BEGIN
  IF p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'decision ต้องเป็น approve หรือ reject';
  END IF;
  SELECT * INTO v_req FROM public.headcount_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;

  v_is_hr := public.is_hr_or_admin();
  v_is_am := public.hc_is_am_of(v_req.branch_id);

  IF v_req.status = 'pending_am' THEN
    -- ขั้น AM (HR/admin ทำแทนได้)
    IF NOT (v_is_hr OR v_is_am) THEN
      RAISE EXCEPTION 'ต้องเป็น AM ของสาขานี้ (หรือ HR) จึงจะอนุมัติขั้นนี้ได้';
    END IF;
    IF p_decision = 'reject' THEN
      UPDATE public.headcount_requests
        SET status='rejected', am_by=auth.uid(), am_at=now(),
            reject_reason=p_note, rejected_by_role='am'
        WHERE id = p_request_id;
      v_new_status := 'rejected';
    ELSE
      UPDATE public.headcount_requests
        SET status='pending_hr', am_by=auth.uid(), am_at=now(), am_note=p_note
        WHERE id = p_request_id;
      v_new_status := 'pending_hr';
    END IF;

  ELSIF v_req.status = 'pending_hr' THEN
    -- ขั้น HR เท่านั้น
    IF NOT v_is_hr THEN
      RAISE EXCEPTION 'ต้องเป็น HR/admin จึงจะอนุมัติขั้นสุดท้ายได้';
    END IF;
    IF p_decision = 'reject' THEN
      UPDATE public.headcount_requests
        SET status='rejected', hr_by=auth.uid(), hr_at=now(),
            reject_reason=p_note, rejected_by_role='hr'
        WHERE id = p_request_id;
      v_new_status := 'rejected';
    ELSE
      UPDATE public.headcount_requests
        SET status='approved', hr_by=auth.uid(), hr_at=now(), hr_note=p_note
        WHERE id = p_request_id;
      v_new_status := 'approved';
    END IF;
  ELSE
    RAISE EXCEPTION 'คำขอนี้ไม่อยู่ในสถานะที่อนุมัติได้ (สถานะ: %)', v_req.status;
  END IF;

  RETURN jsonb_build_object('id', p_request_id, 'status', v_new_status);
END $$;
GRANT EXECUTE ON FUNCTION public.review_headcount_request(UUID,TEXT,TEXT) TO authenticated;

-- ════════ 7. RPC: ยกเลิก (ผู้สร้าง หรือ HR) ════════
CREATE OR REPLACE FUNCTION public.cancel_headcount_request(
  p_request_id UUID,
  p_reason     TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.headcount_requests;
BEGIN
  SELECT * INTO v_req FROM public.headcount_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF v_req.status NOT IN ('pending_am','pending_hr') THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะคำขอที่ยังรออนุมัติ';
  END IF;
  IF NOT (public.is_hr_or_admin() OR v_req.requested_by = auth.uid()) THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะผู้สร้างคำขอ หรือ HR';
  END IF;
  UPDATE public.headcount_requests
    SET status='cancelled', cancelled_at=now(), cancel_reason=p_reason
    WHERE id = p_request_id;
  RETURN jsonb_build_object('id', p_request_id, 'status', 'cancelled');
END $$;
GRANT EXECUTE ON FUNCTION public.cancel_headcount_request(UUID,TEXT) TO authenticated;

-- ════════ 8. Realtime ════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='headcount_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.headcount_requests;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ════════ 9. Verify ════════
SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='headcount_requests') AS policies,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('create_headcount_request','review_headcount_request','cancel_headcount_request',
     'hc_can_request','hc_is_party','hc_is_am_of')) AS functions,
  '✅ พร้อมใช้ — ต่อไปโค้ด frontend (data.js + app.js)' AS note;
