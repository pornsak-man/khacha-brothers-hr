-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Leave Security Hardening
-- แก้ Bug #2, #3, #4 จาก audit เรื่อง approval routing
--
-- Bug #2 (Critical): UPDATE policy ขาด WITH CHECK → user แก้ status เป็น
--                    'approved' ผ่าน Supabase API ตรงๆ ได้
-- Bug #3 (Critical): INSERT policy ไม่บังคับ status='pending' →
--                    submitter ส่ง pre-approved request ได้
-- Bug #4 (High)    : leave_approver_for() ไม่ทำ escalation → หัวสาขา
--                    อนุมัติคำขอตัวเองผ่าน DB ได้
--
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ─── Bug #4 fix: leave_approver_for() ทำ escalation เหมือน JS ───
-- เปลี่ยน SQL → PLPGSQL เพื่อรองรับ if/then escalation logic
CREATE OR REPLACE FUNCTION public.leave_approver_for(p_employee_id TEXT)
RETURNS TEXT
LANGUAGE PLPGSQL
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_branch TEXT;
  v_top_id TEXT;
  v_am_id TEXT;
  v_hr_id TEXT;
BEGIN
  -- หาสาขาของ requester
  SELECT branch INTO v_branch FROM public.employees WHERE id = p_employee_id;
  IF v_branch IS NULL THEN RETURN NULL; END IF;

  -- หา top position holder ในสาขาเดียวกัน (เรียง level DESC, id ASC)
  SELECT e.id INTO v_top_id
  FROM public.employees e
  LEFT JOIN public.position_levels pl ON pl.id = e.position
  WHERE e.branch = v_branch
    AND COALESCE(e.status, 'active') != 'resigned'
  ORDER BY COALESCE(pl.level, 0) DESC, e.id ASC
  LIMIT 1;

  -- ถ้า top ≠ requester → คืน top เป็นผู้อนุมัติ
  IF v_top_id IS NOT NULL AND v_top_id <> p_employee_id THEN
    RETURN v_top_id;
  END IF;

  -- requester = top (หรือ branch มีคนเดียว) → escalate ไปหา Area Manager
  -- (กัน self-approval: ถ้าหัวสาขาขอลาเอง → ต้อง AM/HR อนุมัติ ไม่ใช่ตัวเอง)
  SELECT e.id INTO v_am_id
  FROM public.user_profiles p
  JOIN public.employees e ON e.id = p.employee_id
  WHERE p.role = 'area_manager'
    AND v_branch = ANY(p.managed_branches)
    AND COALESCE(e.status, 'active') != 'resigned'
    AND e.id <> p_employee_id  -- กัน self-approval ขั้นที่สอง
  ORDER BY p.employee_id ASC
  LIMIT 1;
  IF v_am_id IS NOT NULL THEN RETURN v_am_id; END IF;

  -- ไม่มี AM → fallback HR (deterministic: เรียง employee_id ASC)
  SELECT e.id INTO v_hr_id
  FROM public.user_profiles p
  JOIN public.employees e ON e.id = p.employee_id
  WHERE p.role = 'hr'
    AND p.employee_id IS NOT NULL
    AND COALESCE(e.status, 'active') != 'resigned'
    AND e.id <> p_employee_id
  ORDER BY p.employee_id ASC
  LIMIT 1;
  IF v_hr_id IS NOT NULL THEN RETURN v_hr_id; END IF;

  -- ไม่มีใคร → null (admin override only)
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.leave_approver_for(TEXT) TO authenticated;

-- ─── Bug #3 fix: INSERT policy บังคับ status='pending' สำหรับ non-HR/admin ───
DROP POLICY IF EXISTS "insert_self_or_admin" ON public.leave_requests;
CREATE POLICY "insert_self_or_admin" ON public.leave_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    -- HR/admin: ส่งให้ใครก็ได้ ด้วย status ใดก็ได้
    public.is_hr_or_admin()
    OR (
      -- ผู้ใช้ทั่วไป: ส่งของตัวเอง + บังคับ status='pending' (กัน pre-approved tampering)
      status = 'pending'
      AND approved_by IS NULL
      AND approved_at IS NULL
      AND employee_id IN (SELECT employee_id FROM public.user_profiles WHERE user_id = auth.uid())
    )
  );

-- ─── Bug #2 fix: UPDATE policy + WITH CHECK ───
-- ป้องกัน user แก้ status เป็น 'approved'/'rejected' ผ่าน console
DROP POLICY IF EXISTS "update_admin_or_own_pending" ON public.leave_requests;
DROP POLICY IF EXISTS "update_admin_or_approver_or_own_pending" ON public.leave_requests;
CREATE POLICY "update_admin_or_approver_or_own_pending" ON public.leave_requests
  FOR UPDATE TO authenticated
  USING (
    -- ใครอ่าน + แก้ row นี้ได้บ้าง
    public.is_hr_or_admin()
    OR public.can_approve_leave_for(employee_id)
    OR (
      status = 'pending'
      AND employee_id IN (SELECT employee_id FROM public.user_profiles WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    -- หลังจาก UPDATE row ต้องอยู่ในกรอบนี้
    public.is_hr_or_admin()  -- HR/admin: ไม่จำกัด (ตั้ง status อะไรก็ได้)
    OR (
      -- Approver: ตั้ง status ได้ทุกอย่าง (approve/reject/back to pending)
      public.can_approve_leave_for(employee_id)
    )
    OR (
      -- เจ้าของคำขอ: status ใหม่ต้องเป็น 'pending' หรือ 'cancelled' เท่านั้น
      -- (ห้าม self-approve, ห้าม self-reject)
      status IN ('pending', 'cancelled')
      AND employee_id IN (SELECT employee_id FROM public.user_profiles WHERE user_id = auth.uid())
    )
  );

-- ─── Bonus: DELETE policy เปิดให้ HR ลบได้ ───
-- (เดิม admin-only — สอดคล้องกับ matrix policy ที่ HR write ได้)
DROP POLICY IF EXISTS "delete_admin" ON public.leave_requests;
DROP POLICY IF EXISTS "delete_hr_or_admin" ON public.leave_requests;
CREATE POLICY "delete_hr_or_admin" ON public.leave_requests
  FOR DELETE TO authenticated
  USING (public.is_hr_or_admin());

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- หมายเหตุการทดสอบ:
--
-- 1. ทดสอบ Bug #3 (INSERT):
--    login เป็น branch_staff → console:
--    await DB.client.from('leave_requests').insert({
--      employee_id: myId, status: 'approved', ...
--    })
--    → ควร error "violates row-level security policy"
--
-- 2. ทดสอบ Bug #2 (UPDATE):
--    login เป็น branch_staff + ส่งคำขอลา (status='pending') → console:
--    await DB.client.from('leave_requests')
--      .update({ status: 'approved' })
--      .eq('id', myPendingId)
--    → ควร error / row count = 0
--
-- 3. ทดสอบ Bug #4 (SQL escalation):
--    login เป็น branch_manager → ส่งคำขอลาตัวเอง → ลองอนุมัติเอง
--    → ปุ่ม "อนุมัติ" ไม่ควรขึ้น (canApproveLeaveFor คืน false)
--    → DB policy block ด้วย (can_approve_leave_for return false)
-- ═══════════════════════════════════════════════════════════
