-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Leave Approval by Branch Head
-- กฎ: ผู้อนุมัติคำขอลา = พนักงานที่มี position_level สูงสุดของสาขา
-- ที่พนักงานคำขอนั้นสังกัด (เทียบจาก employees.branch + position_levels.level)
--
-- ผลกระทบ: viewer (non-admin) ที่เป็นหัวหน้าสาขา จะ approve/reject ได้
-- (จากเดิม admin เท่านั้น) — admin ยัง override ได้ตลอด
-- ═══════════════════════════════════════════════════════════

-- คืน employee_id ของผู้อนุมัติ (top position holder ในสาขาเดียวกัน)
-- ถ้าเสมอกัน — เรียง id แล้วเอาตัวแรก
CREATE OR REPLACE FUNCTION public.leave_approver_for(p_employee_id TEXT)
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT e.id
  FROM public.employees e
  LEFT JOIN public.position_levels pl ON pl.id = e.position
  WHERE e.branch = (SELECT branch FROM public.employees WHERE id = p_employee_id)
    AND COALESCE(e.status, 'active') != 'resigned'
  ORDER BY COALESCE(pl.level, 0) DESC, e.id ASC
  LIMIT 1
$$;

-- ตรวจว่า current user เป็นผู้อนุมัติของพนักงานนี้หรือไม่
CREATE OR REPLACE FUNCTION public.can_approve_leave_for(p_employee_id TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.user_id = auth.uid()
      AND up.employee_id IS NOT NULL
      AND up.employee_id = public.leave_approver_for(p_employee_id)
  )
$$;

-- อัปเดต UPDATE policy: admin หรือ approver หรือ เจ้าของ pending
DROP POLICY IF EXISTS "update_admin_or_own_pending" ON public.leave_requests;
DROP POLICY IF EXISTS "update_admin_or_approver_or_own_pending" ON public.leave_requests;
CREATE POLICY "update_admin_or_approver_or_own_pending" ON public.leave_requests FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.can_approve_leave_for(employee_id)
    OR (status = 'pending' AND employee_id IN (SELECT employee_id FROM public.user_profiles WHERE user_id = auth.uid()))
  );

NOTIFY pgrst, 'reload schema';
