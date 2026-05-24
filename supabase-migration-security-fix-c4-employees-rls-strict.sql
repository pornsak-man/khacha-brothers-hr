-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security Fix C4: ปิด direct SELECT บน employees
--
-- ปัญหาเดิม (m1-employees-view.sql):
--   - employees_view มี CASE masking สำหรับ non-HR (salary, national_id, bank → NULL)
--   - แต่ public.employees table ยังเปิดให้ authenticated user select ตรงๆ
--   - branch_staff เปิด DevTools รัน:
--       DB.client.from('employees').select('national_id, salary, bank').limit(50)
--     → เห็นข้อมูลจริงทุกฟิลด์ (bypass view masking)
--
-- การแก้ — Defense in depth:
--   1. เพิ่ม RLS policy ที่จำกัด SELECT บน public.employees
--      ให้เห็นได้ 3 กลุ่ม:
--        a) HR/admin → เห็นทุก row (per is_hr_or_admin)
--        b) Manager (BM/AM/OM) → เห็นเฉพาะ row ใน scope ของตัวเอง
--           (รองรับ scope filter จาก rls-scope.sql)
--        c) Employee ทั่วไป → เห็นเฉพาะ row ของตัวเอง (id ตรงกับ user_profile.employee_id)
--      → คนที่ไม่มีสิทธิ์เลย → 0 rows (REST + Realtime)
--   2. ไม่กระทบ UPDATE/INSERT/DELETE policy เดิม
--   3. ลูกค้า non-HR ยังต้องใช้ employees_view สำหรับฟิลด์ที่ต้อง masking
--      (view มี CASE NULL เสริม — ป้องกันกรณี future column add)
--
-- ⚠️ ผลข้างเคียง:
--   - ถ้า frontend มี code path ที่ select * from employees แบบไม่ผ่าน view
--     สำหรับ non-HR → จะได้ 0 rows
--   - ต้อง test ทุก page ที่แสดงรายชื่อพนักงาน
--
-- ต้องมี helper functions อยู่แล้ว: is_hr_or_admin(), current_user_employee_id(),
-- can_manager_see_employee(emp_id) — ถ้าไม่มีให้สร้างก่อน
--
-- รันใน Supabase SQL Editor (idempotent)
-- ═══════════════════════════════════════════════════════════

-- 1. ENABLE RLS (ถ้ายังไม่เปิด)
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

-- 2. helper: เช็คว่า user (manager) มีสิทธิ์เห็นพนักงานคนนี้ไหม
--    - HR/admin → ใช่เสมอ (early return)
--    - Manager → เช็คว่าพนักงานอยู่ใน managed_branches
--    - Staff → เช็คว่าเป็นตัวเอง
CREATE OR REPLACE FUNCTION public.can_view_employee(p_employee_id TEXT)
RETURNS BOOLEAN
LANGUAGE PLPGSQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_my_role     TEXT;
  v_my_emp_id   TEXT;
  v_my_branches TEXT[];
  v_emp_branch  TEXT;
BEGIN
  -- 1) HR / admin → เห็นทุกคน (early return per memory rule)
  IF public.is_hr_or_admin() THEN
    RETURN TRUE;
  END IF;

  -- 2) ดึง profile ของ caller
  SELECT role, employee_id, managed_branches
    INTO v_my_role, v_my_emp_id, v_my_branches
  FROM public.user_profiles
  WHERE user_id = auth.uid();

  IF v_my_role IS NULL THEN
    RETURN FALSE;
  END IF;

  -- 3) Self — เห็นข้อมูลตัวเองได้เสมอ
  IF v_my_emp_id = p_employee_id THEN
    RETURN TRUE;
  END IF;

  -- 4) Manager (BM/AM/OM) — เช็ค scope
  IF v_my_role IN ('branch_manager', 'area_manager', 'operation_manager') THEN
    SELECT branch INTO v_emp_branch FROM public.employees WHERE id = p_employee_id;
    IF v_emp_branch IS NULL THEN
      RETURN FALSE;
    END IF;
    RETURN v_emp_branch = ANY(COALESCE(v_my_branches, ARRAY[]::TEXT[]));
  END IF;

  -- 5) ที่เหลือ (viewer / branch_staff ที่ไม่ใช่เจ้าของ) → ไม่เห็น
  RETURN FALSE;
END $$;

GRANT EXECUTE ON FUNCTION public.can_view_employee(TEXT) TO authenticated;

-- 3. Drop policy เก่าที่ permissive (ชื่อหลายแบบจาก migration ก่อนๆ — drop ทั้งหมด)
DO $$
DECLARE
  v_policy RECORD;
BEGIN
  FOR v_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'employees'
      AND cmd = 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.employees', v_policy.policyname);
    RAISE NOTICE 'Dropped SELECT policy: %', v_policy.policyname;
  END LOOP;
END $$;

-- 4. policy ใหม่ — strict SELECT
CREATE POLICY "employees_select_strict" ON public.employees
  FOR SELECT TO authenticated
  USING (public.can_view_employee(id));

-- 5. Verification — log policy ที่เหลือ
DO $$
DECLARE
  v_policy RECORD;
BEGIN
  RAISE NOTICE '─── Active policies on public.employees ───';
  FOR v_policy IN
    SELECT policyname, cmd, qual
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'employees'
    ORDER BY cmd, policyname
  LOOP
    RAISE NOTICE '  [%] %', v_policy.cmd, v_policy.policyname;
  END LOOP;
END $$;

-- 6. Smoke test (informational — ไม่ throw)
DO $$
BEGIN
  RAISE NOTICE '✅ Security Fix C4 รันเสร็จแล้ว';
  RAISE NOTICE '   - public.employees มี RLS strict สำหรับ SELECT';
  RAISE NOTICE '   - non-HR + non-manager + non-self → 0 rows';
  RAISE NOTICE '   - employees_view (CASE masking) ยังใช้ได้สำหรับฟิลด์ public';
  RAISE NOTICE '   ⚠️ ต้องทดสอบ:';
  RAISE NOTICE '      1. login branch_staff → query employees ตรงๆ → ได้แค่ตัวเอง';
  RAISE NOTICE '      2. login branch_manager → ได้เฉพาะ branch ของตัวเอง';
  RAISE NOTICE '      3. login HR/admin → ได้ทุก row';
  RAISE NOTICE '      4. Realtime subscription บน employees ส่ง payload เฉพาะที่ user เห็น';
END $$;

NOTIFY pgrst, 'reload schema';
