-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Fix: BM/AM ที่ไม่มี managed_branches set
-- ให้ fallback ไปดู emp.branch ของตัวเอง (สาขาที่ตัวเองสังกัด)
--
-- ปัญหา: หลังรัน security-fix-c4-employees-rls-strict.sql
--   BM ของสาขา KW ที่ไม่ได้ตั้ง managed_branches ใน user_profiles
--   → can_view_employee() ตรวจกับ ANY(ARRAY[]) = FALSE → เห็น 0 พนักงาน
--   → ยกเว้นตัวเอง (ผ่าน self check)
--
-- รากเหตุ: `canCreateScheduleForBranch` ใน data.js มี fallback ไปสาขาตัวเอง
--   แต่ SQL function ไม่มี → behavior ไม่ตรงกัน
--
-- แก้: เพิ่ม fallback — ถ้า managed_branches ว่าง → ใช้ emp.branch ของ user
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.can_view_employee(p_employee_id TEXT)
RETURNS BOOLEAN
LANGUAGE PLPGSQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_my_role      TEXT;
  v_my_emp_id    TEXT;
  v_my_branches  TEXT[];
  v_my_own_branch TEXT;
  v_emp_branch   TEXT;
  v_effective_branches TEXT[];
BEGIN
  -- 1) HR / admin → เห็นทุกคน
  IF public.is_hr_or_admin() THEN RETURN TRUE; END IF;

  -- 2) ดึง profile + emp.branch ของตัวเอง
  SELECT up.role, up.employee_id, up.managed_branches, e.branch
    INTO v_my_role, v_my_emp_id, v_my_branches, v_my_own_branch
  FROM public.user_profiles up
  LEFT JOIN public.employees e ON e.id = up.employee_id
  WHERE up.user_id = auth.uid();

  IF v_my_role IS NULL THEN
    RETURN FALSE;
  END IF;

  -- 3) Self — เห็นตัวเองเสมอ
  IF v_my_emp_id = p_employee_id THEN
    RETURN TRUE;
  END IF;

  -- 4) Manager (BM/AM/OM) — เช็ค scope
  IF v_my_role IN ('branch_manager', 'area_manager', 'operation_manager') THEN
    SELECT branch INTO v_emp_branch FROM public.employees WHERE id = p_employee_id;
    IF v_emp_branch IS NULL THEN
      RETURN FALSE;
    END IF;

    -- ★ FIX: ถ้า managed_branches ว่าง → fallback ไป emp.branch ของตัวเอง
    -- ป้องกัน BM/AM ที่ admin ยังไม่ตั้ง managed_branches เห็น 0 พนักงาน
    IF v_my_branches IS NOT NULL AND array_length(v_my_branches, 1) > 0 THEN
      v_effective_branches := v_my_branches;
    ELSIF v_my_own_branch IS NOT NULL THEN
      v_effective_branches := ARRAY[v_my_own_branch];
    ELSE
      RETURN FALSE;  -- ไม่มีทั้ง managed_branches และ emp.branch → unsafe → block
    END IF;

    RETURN v_emp_branch = ANY(v_effective_branches);
  END IF;

  -- 5) ที่เหลือ (viewer / branch_staff ที่ไม่ใช่ตัวเอง) → ไม่เห็น
  RETURN FALSE;
END $$;

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_count INT;
  v_sample RECORD;
BEGIN
  RAISE NOTICE '✅ can_view_employee แก้แล้ว — fallback ไปสาขาตัวเอง';
  RAISE NOTICE '   - BM/AM ที่ managed_branches ว่าง → ใช้ emp.branch ของตัวเอง';
  RAISE NOTICE '   - HR/admin ยังเห็นทุกคนเหมือนเดิม';
  RAISE NOTICE '';
  RAISE NOTICE '─── BM/AM ที่ยังไม่ตั้ง managed_branches (ตรวจสอบ) ───';
  FOR v_sample IN
    SELECT up.user_id, up.role, up.employee_id, e.branch AS own_branch
    FROM public.user_profiles up
    LEFT JOIN public.employees e ON e.id = up.employee_id
    WHERE up.role IN ('branch_manager', 'area_manager', 'operation_manager')
      AND (up.managed_branches IS NULL OR array_length(up.managed_branches, 1) IS NULL)
    LIMIT 5
  LOOP
    RAISE NOTICE '   role=% emp=% own_branch=% → fallback จะใช้ %',
      v_sample.role, v_sample.employee_id, v_sample.own_branch, COALESCE(v_sample.own_branch, '(ไม่มี — block)');
  END LOOP;
END $$;
