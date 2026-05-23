-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security fix: CRITICAL RLS gaps
-- แก้ช่องโหว่ระดับ Critical 3 ข้อ:
--   C1) Self-role escalation — ผู้ใช้แก้ role ของตัวเองเป็น admin ได้
--   C2) applicants — branch_staff อ่านข้อมูลผู้สมัครทั้งหมดได้
--   C3) uniform_requests/uniform_issues/role_permission_matrix — รั่วทั่วถึงทุกคน
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ─── C1: ป้องกัน self-role escalation ────────────────────
-- ปัญหา: policy "update_own" บน user_profiles อนุญาตให้ user อัปเดต row ตัวเองได้
--        แต่ไม่ filter column → user รัน update({ role: 'admin' }).eq('user_id', me) ได้ใน console
-- แก้:   เพิ่ม BEFORE UPDATE trigger บังคับ role/employee_id/managed_branches
--        ห้ามแก้จาก self-update — admin/service_role เท่านั้นที่แก้ได้
CREATE OR REPLACE FUNCTION public.guard_user_profiles_self_update()
RETURNS TRIGGER LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_is_admin BOOLEAN;
BEGIN
  -- service_role bypass (สำหรับ admin functions ที่ทำผ่าน SECURITY DEFINER)
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;
  -- ตรวจว่าผู้ใช้ปัจจุบันเป็น admin จริงไหม (จาก OLD ของตาราง — ก่อนแก้)
  SELECT (role = 'admin') INTO v_is_admin
  FROM public.user_profiles
  WHERE user_id = auth.uid();
  -- admin → ปล่อยผ่าน (แก้ใครก็ได้)
  IF COALESCE(v_is_admin, false) THEN
    RETURN NEW;
  END IF;
  -- ไม่ใช่ admin: ถ้าพยายามแก้ตัวเอง — บังคับ revert sensitive fields กลับเป็น OLD
  IF OLD.user_id = auth.uid() THEN
    NEW.role := OLD.role;
    NEW.employee_id := OLD.employee_id;
    NEW.managed_branches := OLD.managed_branches;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_user_profiles_self_guard ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_self_guard
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_profiles_self_update();

-- ─── C2: applicants → SELECT เฉพาะ HR/admin ──────────────
-- ปัญหา: branch_staff/viewer อ่าน phone/email/expected_salary/note ของผู้สมัครได้ทั้งหมด
DROP POLICY IF EXISTS "read_authenticated" ON public.applicants;
DROP POLICY IF EXISTS "applicants_select_hr" ON public.applicants;
CREATE POLICY "applicants_select_hr" ON public.applicants
  FOR SELECT TO authenticated
  USING (public.is_hr_or_admin());

-- ─── C3a: uniform_requests → HR + เจ้าของ ─────────────────
-- พนักงาน: เห็น request ของตัวเอง (employee_id ตรงกับ profile)
-- HR/admin: เห็นทั้งหมด (รวมที่ผูกกับ applicant_id ก่อนรับเข้า)
DROP POLICY IF EXISTS "read_authenticated" ON public.uniform_requests;
DROP POLICY IF EXISTS "uniform_req_select_scoped" ON public.uniform_requests;
CREATE POLICY "uniform_req_select_scoped" ON public.uniform_requests
  FOR SELECT TO authenticated
  USING (
    public.is_hr_or_admin()
    OR employee_id = (
      SELECT employee_id FROM public.user_profiles
      WHERE user_id = auth.uid()
    )
  );

-- ─── C3b: uniform_issues → HR + เจ้าของ ──────────────────
DROP POLICY IF EXISTS "read_authenticated" ON public.uniform_issues;
DROP POLICY IF EXISTS "uniform_iss_select_scoped" ON public.uniform_issues;
CREATE POLICY "uniform_iss_select_scoped" ON public.uniform_issues
  FOR SELECT TO authenticated
  USING (
    public.is_hr_or_admin()
    OR employee_id = (
      SELECT employee_id FROM public.user_profiles
      WHERE user_id = auth.uid()
    )
  );

-- ─── C3c: role_permission_matrix → HR/admin เท่านั้น ────────
-- เปิดเผยโครงสร้างสิทธิ์ทั้งระบบ — ไม่ควรให้พนักงานทั่วไปเห็น
DROP POLICY IF EXISTS "read_authenticated" ON public.role_permission_matrix;
DROP POLICY IF EXISTS "role_matrix_select_hr" ON public.role_permission_matrix;
CREATE POLICY "role_matrix_select_hr" ON public.role_permission_matrix
  FOR SELECT TO authenticated
  USING (public.is_hr_or_admin());

NOTIFY pgrst, 'reload schema';

-- ─── ตรวจสอบหลัง migration ────────────────────────────────
DO $$
DECLARE
  v_trigger_count INTEGER;
  v_applicants_open BOOLEAN;
  v_uniform_req_open BOOLEAN;
  v_uniform_iss_open BOOLEAN;
  v_role_matrix_open BOOLEAN;
BEGIN
  -- trigger guard มีจริงไหม
  SELECT COUNT(*) INTO v_trigger_count
  FROM pg_trigger
  WHERE tgname = 'trg_user_profiles_self_guard'
    AND tgrelid = 'public.user_profiles'::regclass;

  -- ยังมี policy "read_authenticated" บนตารางเสี่ยงไหม
  SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='applicants' AND policyname='read_authenticated') INTO v_applicants_open;
  SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='uniform_requests' AND policyname='read_authenticated') INTO v_uniform_req_open;
  SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='uniform_issues' AND policyname='read_authenticated') INTO v_uniform_iss_open;
  SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='role_permission_matrix' AND policyname='read_authenticated') INTO v_role_matrix_open;

  RAISE NOTICE '═══ ผลลัพธ์ Security Fix ═══';
  RAISE NOTICE 'C1) Self-role-guard trigger: %', CASE WHEN v_trigger_count = 1 THEN '✅ ติดตั้งแล้ว' ELSE '❌ ไม่พบ' END;
  RAISE NOTICE 'C2) applicants read-all: %',     CASE WHEN v_applicants_open  THEN '❌ ยังเปิดอยู่' ELSE '✅ ปิดแล้ว' END;
  RAISE NOTICE 'C3a) uniform_requests read-all: %', CASE WHEN v_uniform_req_open THEN '❌ ยังเปิดอยู่' ELSE '✅ ปิดแล้ว' END;
  RAISE NOTICE 'C3b) uniform_issues read-all: %',   CASE WHEN v_uniform_iss_open THEN '❌ ยังเปิดอยู่' ELSE '✅ ปิดแล้ว' END;
  RAISE NOTICE 'C3c) role_matrix read-all: %',    CASE WHEN v_role_matrix_open THEN '❌ ยังเปิดอยู่' ELSE '✅ ปิดแล้ว' END;
  IF v_trigger_count = 1 AND NOT v_applicants_open AND NOT v_uniform_req_open AND NOT v_uniform_iss_open AND NOT v_role_matrix_open THEN
    RAISE NOTICE '🎉 ครบทุก critical fix';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════
-- ทดสอบหลังรัน:
--   1) Login เป็น branch_staff → เปิด console รัน:
--      DB.client.from('user_profiles').update({ role: 'admin' }).eq('user_id', DB.user.id)
--      → ผลควรเป็น: row อัปเดตสำเร็จ แต่ role ยังเป็นค่าเดิม (trigger revert)
--   2) Login เป็น branch_staff → รัน:
--      DB.client.from('applicants').select('*')
--      → ควรได้ empty array (RLS block)
--   3) Login เป็น branch_staff → รัน:
--      DB.client.from('uniform_requests').select('*')
--      → ควรได้เฉพาะของตัวเอง (employee_id matches profile)
-- ═══════════════════════════════════════════════════════════
