-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: RBAC final policy
-- ตามตาราง matrix ที่ตกลง:
--   • ตั้งค่าระบบ (company settings) = admin only
--   • บัญชีผู้ใช้/สิทธิ์ = admin + HR
--   • ปรับค่าจ้าง / กู้ / audit / master data = admin + HR
--   • HR ตั้ง role admin ไม่ได้ + แก้ admin คนอื่นไม่ได้
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ── 1. is_admin() กลับเป็น admin only (revert จาก migration ก่อนหน้า) ──
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

-- ── 2. is_hr_or_admin() คงไว้ — สำหรับ RLS policy ที่เปิดให้ HR ทำได้ ──
CREATE OR REPLACE FUNCTION public.is_hr_or_admin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_id = auth.uid() AND role IN ('admin', 'hr')
  );
$$;

-- ── 3. set_employee_role() — HR ใช้ได้ + guard ตามนโยบาย ──
DROP FUNCTION IF EXISTS public.set_employee_role(TEXT, TEXT, TEXT[]);

CREATE OR REPLACE FUNCTION public.set_employee_role(
  p_employee_id TEXT,
  p_role        TEXT,
  p_branches    TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role         TEXT;
  v_target_current_role TEXT;
BEGIN
  SELECT role INTO v_caller_role FROM public.user_profiles WHERE user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'ต้องเป็น admin หรือ HR เท่านั้น';
  END IF;

  IF p_role NOT IN ('admin', 'hr', 'operation_manager', 'area_manager', 'branch_manager', 'branch_staff', 'viewer') THEN
    RAISE EXCEPTION 'role ไม่ถูกต้อง: %', p_role;
  END IF;

  -- HR ห้ามตั้ง role ใหม่เป็น admin
  IF v_caller_role = 'hr' AND p_role = 'admin' THEN
    RAISE EXCEPTION 'HR ไม่มีสิทธิ์ตั้งพนักงานเป็น admin';
  END IF;

  -- HR ห้ามแก้ role ของพนักงานที่เป็น admin อยู่
  SELECT role INTO v_target_current_role FROM public.user_profiles WHERE employee_id = p_employee_id;
  IF v_caller_role = 'hr' AND v_target_current_role = 'admin' THEN
    RAISE EXCEPTION 'HR ไม่มีสิทธิ์แก้ role ของ admin';
  END IF;

  UPDATE public.user_profiles
  SET role             = p_role,
      managed_branches = COALESCE(p_branches, managed_branches)
  WHERE employee_id = p_employee_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบบัญชีของพนักงาน %', p_employee_id;
  END IF;

  RETURN jsonb_build_object('employee_id', p_employee_id, 'role', p_role, 'managed_branches', p_branches);
END $$;

GRANT EXECUTE ON FUNCTION public.set_employee_role(TEXT, TEXT, TEXT[]) TO authenticated;

-- ── 4. RLS policy: ปรับ table ที่ HR ต้องเขียนได้ ให้ใช้ is_hr_or_admin() แทน is_admin() ──
-- ตาม matrix: HR เขียน employees, salary_history, loans, advances, allowances, evaluations,
--             leave_requests, uniform_*, applicants, branches, departments, position_levels, user_profiles
-- (ทุก table ที่ HR ใช้งานจริง)
DO $$
DECLARE
  t TEXT;
  hr_writable_tables TEXT[] := ARRAY[
    'employees', 'salary_history', 'loans', 'advances', 'allowances', 'evaluations',
    'calendar_items', 'applicants', 'branches', 'departments', 'position_levels',
    'leave_requests', 'leave_types', 'uniform_items', 'uniform_requests', 'uniform_issues',
    'user_profiles'
  ];
BEGIN
  FOREACH t IN ARRAY hr_writable_tables LOOP
    -- ลบ policy เก่า (ถ้ามี) — รองรับทั้ง write_admin และ write_hr
    EXECUTE format('DROP POLICY IF EXISTS "write_admin" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "write_hr"    ON public.%I', t);
    -- สร้าง policy ใหม่ — HR + admin เขียนได้
    EXECUTE format('CREATE POLICY "write_hr" ON public.%I FOR ALL TO authenticated USING (public.is_hr_or_admin()) WITH CHECK (public.is_hr_or_admin())', t);
  END LOOP;
END $$;

-- company_settings ยังคง admin only (ตาม matrix)
DROP POLICY IF EXISTS "write_admin" ON public.company_settings;
DROP POLICY IF EXISTS "write_hr"    ON public.company_settings;
CREATE POLICY "write_admin" ON public.company_settings FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════
