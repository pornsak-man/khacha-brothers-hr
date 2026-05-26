-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Open SELECT user_profiles (org chart public)
--
-- ปัญหา:
--   - Policy เก่า "read_own_or_admin" ให้ user ปกติเห็นแค่ profile ตัวเอง
--   - หน้า "ตารางงาน" ใช้ user_profiles เพื่อหา BM/AM ของสาขา
--     → พนักงานทั่วไปมองไม่เห็น BM/AM อื่นๆ → แสดง "ยังไม่ตั้ง BM"
--
-- เหตุผลที่ปลอดภัย:
--   - user_profiles มีแค่ user_id (UUID), employee_id, role, managed_branches
--   - ไม่มี email, password, settings ส่วนตัว
--   - role + managed_branches = org chart information (ใครคุมใคร)
--     → เป็น public info ในบริษัท (พนักงานควรรู้ว่าหัวหน้าตนเองคือใคร)
--
-- รันใน Supabase SQL Editor (idempotent)
-- ═══════════════════════════════════════════════════════════

-- Drop policy เก่า
DROP POLICY IF EXISTS "read_own_or_admin" ON public.user_profiles;
DROP POLICY IF EXISTS "read_all_authenticated" ON public.user_profiles;

-- ════════ Policy ใหม่: ทุก authenticated user SELECT ได้ (org chart) ════════
CREATE POLICY "read_all_authenticated" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (true);

-- UPDATE / INSERT / DELETE — keep เดิม (admin only / own profile)
-- (policy update_own + admin policies ที่มีอยู่แล้วยังใช้ได้)

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM public.user_profiles;
  RAISE NOTICE '✅ Policy "read_all_authenticated" ติดตั้งแล้ว';
  RAISE NOTICE '   - authenticated user เห็น user_profiles ทั้งหมด (% rows)', v_count;
  RAISE NOTICE '   - กระทบ: org chart, getScheduleCreators, getScheduleApprover, branch managers list';
  RAISE NOTICE '   - field ที่เปิดเห็น: user_id, employee_id, role, managed_branches (ไม่มี sensitive data)';
  RAISE NOTICE '';
  RAISE NOTICE '   UPDATE/INSERT/DELETE policy ยังเป็นเดิม (admin/self only)';
END $$;
