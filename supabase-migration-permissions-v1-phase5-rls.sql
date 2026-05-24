-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Phase 5: RLS Dynamic Enforcement
--
-- ทำให้ permission matrix (table role_permissions) มีผลกับ RLS จริง
-- กลยุทธ์: Hybrid A+B — rewrite 2 helper functions ใช้ user_has_permission()
--   → policies 100+ ตัวที่เรียก helper จะ "เปลี่ยน semantics" อัตโนมัติ
--   → ไม่ต้อง refactor policies ทีละตัว
--
-- + แก้ 3 RPC + 1 trigger ที่ check role inline (เลี่ยง helper)
-- + ฉวยโอกาสแก้ 2 bugs เก่า (audit_log + salary_history policy collision)
--
-- ⚠️ ห้ามรันก่อน:
--   1. supabase-migration-permissions-v1.sql (ต้องมี user_has_permission)
--   2. supabase-migration-permissions-v1-patch-critical.sql (RPC fix)
--
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — CREATE OR REPLACE ทั้งหมด)
--
-- ═══════════════════════════════════════════════════════════
-- ROLLBACK PLAN (paste เพื่อ revert):
--   CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN
--     LANGUAGE SQL SECURITY DEFINER STABLE AS $$
--     SELECT EXISTS (SELECT 1 FROM public.user_profiles
--                    WHERE user_id = auth.uid() AND role = 'admin');
--   $$;
--   CREATE OR REPLACE FUNCTION public.is_hr_or_admin() RETURNS BOOLEAN
--     LANGUAGE SQL SECURITY DEFINER STABLE AS $$
--     SELECT EXISTS (SELECT 1 FROM public.user_profiles
--                    WHERE user_id = auth.uid() AND role IN ('admin', 'hr'));
--   $$;
-- ═══════════════════════════════════════════════════════════

-- ═════════════ STEP 1: is_admin() → delegate ไป permission.edit_matrix ═════════════
-- semantics: "admin = ใครที่แก้ matrix ได้" — ตรงกับ critical+protected ของ seed
-- จะกระทบ 30 caller (RLS + RPC) ที่ใช้ is_admin() ปัจจุบัน
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT public.user_has_permission('permission.edit_matrix');
$$;

-- ═════════════ STEP 2: is_hr_or_admin() → delegate ไป employee.edit OR edit_matrix ═════════════
-- semantics: "HR-class = ใครที่แก้พนักงานได้ หรือเป็น admin"
-- จะกระทบ 72 caller — รวมหมดในนี้
CREATE OR REPLACE FUNCTION public.is_hr_or_admin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT public.user_has_permission('employee.edit')
      OR public.user_has_permission('permission.edit_matrix');
$$;

-- ═════════════ STEP 3: set_employee_role() RPC — ใช้ permission check แทน role literal ═════════════
-- ปัจจุบัน: v_caller_role NOT IN ('admin','hr') → custom role ใช้ไม่ได้
-- ใหม่: เช็ค user.set_role / user.set_role_admin โดยตรง
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
  v_target_current_role TEXT;
BEGIN
  -- 1. ต้องมี permission user.set_role พื้นฐาน
  IF NOT public.user_has_permission('user.set_role') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตั้ง role';
  END IF;

  -- 2. role ต้องมีอยู่ในตาราง roles (รองรับ custom role จาก Phase 4b)
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id = p_role) THEN
    RAISE EXCEPTION 'role ไม่ถูกต้อง: %', p_role;
  END IF;

  -- 3. ถ้าจะตั้งเป็น admin ต้องมี user.set_role_admin
  IF p_role = 'admin' AND NOT public.user_has_permission('user.set_role_admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตั้งพนักงานเป็น admin';
  END IF;

  -- 4. ห้ามแก้ role ของ admin คนอื่น ถ้าไม่มี user.set_role_admin
  SELECT role INTO v_target_current_role FROM public.user_profiles WHERE employee_id = p_employee_id;
  IF v_target_current_role = 'admin' AND NOT public.user_has_permission('user.set_role_admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ role ของ admin';
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

-- ═════════════ STEP 4: create_employee_user() RPC — ใช้ user.create_account ═════════════
-- เดิม: is_hr_or_admin() → หลัง Phase 5 = employee.edit (อาจไม่ตรง intent)
-- ใหม่: user.create_account ตรงๆ ตามที่ seed (admin + hr ได้)
DO $$
DECLARE
  v_exists BOOLEAN;
BEGIN
  -- เช็คว่ามี function นี้อยู่จริงไหม (จาก h5-create-user-rpc-v2.sql)
  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'create_employee_user'
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE NOTICE '⚠️ ไม่พบ create_employee_user() — ข้าม STEP 4 (ยังไม่ได้รัน h5-create-user-rpc-v2)';
    RETURN;
  END IF;
  -- มี → patch body ผ่าน plpgsql block
  EXECUTE $body$
    CREATE OR REPLACE FUNCTION public.create_employee_user(
      p_employee_id TEXT,
      p_password    TEXT DEFAULT NULL
    )
    RETURNS JSONB
    LANGUAGE PLPGSQL
    SECURITY DEFINER
    SET search_path = public, auth, extensions
    AS $inner$
    DECLARE
      v_email        TEXT;
      v_password     TEXT;
      v_first        TEXT;
      v_last         TEXT;
      v_fullname     TEXT;
      v_existing_uid UUID;
      v_msg          TEXT;
    BEGIN
      -- Auth check — ใช้ permission ใหม่
      IF NOT public.user_has_permission('user.create_account') THEN
        RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างบัญชีผู้ใช้' USING ERRCODE = '42501';
      END IF;

      -- (เนื้อหาเดิมไม่เปลี่ยน — แต่ผ่าน CREATE OR REPLACE ต้อง redefine ทั้ง body)
      SELECT first_name, last_name INTO v_first, v_last
      FROM public.employees WHERE id = p_employee_id;
      IF v_first IS NULL THEN
        RAISE EXCEPTION 'ไม่พบพนักงาน %', p_employee_id;
      END IF;

      v_email := lower(p_employee_id) || '@kacha.local';
      v_password := COALESCE(
        NULLIF(trim(p_password), ''),
        regexp_replace(COALESCE((SELECT national_id FROM public.employees WHERE id = p_employee_id), ''), '\D', '', 'g'),
        p_employee_id
      );
      v_fullname := trim(COALESCE(v_first,'') || ' ' || COALESCE(v_last,''));

      SELECT id INTO v_existing_uid FROM auth.users WHERE email = v_email;
      IF v_existing_uid IS NOT NULL THEN
        INSERT INTO public.user_profiles (user_id, employee_id, role)
        VALUES (v_existing_uid, p_employee_id, COALESCE((SELECT role FROM public.user_profiles WHERE user_id = v_existing_uid), 'viewer'))
        ON CONFLICT (user_id) DO UPDATE SET employee_id = EXCLUDED.employee_id;
        RETURN jsonb_build_object(
          'email', v_email, 'password', '(unchanged)', 'source', 'linked-existing',
          'created', false, 'user_id', v_existing_uid
        );
      END IF;

      INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
      VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', v_email, extensions.crypt(v_password, extensions.gen_salt('bf')), now(), jsonb_build_object('provider','email','providers',ARRAY['email']), jsonb_build_object('full_name', v_fullname), now(), now(), '', '', '', '')
      RETURNING id INTO v_existing_uid;

      INSERT INTO public.user_profiles (user_id, employee_id, role)
      VALUES (v_existing_uid, p_employee_id, 'viewer');

      RETURN jsonb_build_object(
        'email', v_email, 'password', v_password, 'source', 'created-new',
        'created', true, 'user_id', v_existing_uid
      );
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      RAISE EXCEPTION 'create_employee_user fail: % (employee=%)', v_msg, p_employee_id;
    END $inner$;
  $body$;
  RAISE NOTICE '✅ STEP 4: create_employee_user() patched';
END $$;

-- ═════════════ STEP 5: reset_employee_password() RPC — ใช้ user.reset_password ═════════════
-- เดิม: is_admin() → หลัง Phase 5 = permission.edit_matrix
-- ⚠️ regression: HR เคยใช้ได้ → ใช้ไม่ได้! (HR ไม่มี edit_matrix)
-- ใหม่: user.reset_password (granted ให้ admin + hr ตาม seed) → HR ใช้ได้เหมือนเดิม
CREATE OR REPLACE FUNCTION public.reset_employee_password(p_employee_id TEXT, p_new_password TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_uid       UUID;
  v_password  TEXT;
  v_natid     TEXT;
BEGIN
  -- ใช้ permission check ใหม่ (ไม่ใช่ is_admin literal)
  IF NOT public.user_has_permission('user.reset_password') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์รีเซ็ตรหัสผ่าน';
  END IF;

  -- หาเลข ปชช เพื่อใช้เป็น default ถ้าไม่ส่งรหัสผ่านใหม่มา
  SELECT regexp_replace(COALESCE(national_id, ''), '\D', '', 'g') INTO v_natid
  FROM public.employees WHERE id = p_employee_id;

  v_password := COALESCE(
    NULLIF(trim(p_new_password), ''),
    NULLIF(v_natid, ''),
    p_employee_id
  );

  SELECT user_id INTO v_uid FROM public.user_profiles WHERE employee_id = p_employee_id;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'ไม่พบบัญชี user ของพนักงาน %', p_employee_id;
  END IF;

  UPDATE auth.users
  SET encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
      updated_at         = now()
  WHERE id = v_uid;

  RETURN jsonb_build_object('employee_id', p_employee_id, 'password', v_password, 'source', CASE WHEN NULLIF(trim(p_new_password), '') IS NOT NULL THEN 'custom' WHEN NULLIF(v_natid, '') IS NOT NULL THEN 'national_id' ELSE 'employee_id' END);
END $$;
GRANT EXECUTE ON FUNCTION public.reset_employee_password(TEXT, TEXT) TO authenticated;

-- ═════════════ STEP 6: guard_user_profiles_self_update() trigger — รองรับ custom role ═════════════
-- เดิม: SELECT (role = 'admin') → custom role เช่น 'super_hr' ที่ admin มอบ set_role ให้ จะ block
-- ใหม่: เช็ค permission user.set_role / user.set_role_admin
CREATE OR REPLACE FUNCTION public.guard_user_profiles_self_update()
RETURNS TRIGGER LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_changed_role     BOOLEAN;
  v_changed_emp      BOOLEAN;
  v_changed_branches BOOLEAN;
BEGIN
  -- service_role bypass (admin RPC ที่ run ใน service context)
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- มี permission set_role หรือ set_role_admin → ปล่อยผ่าน
  IF public.user_has_permission('user.set_role')
     OR public.user_has_permission('user.set_role_admin') THEN
    RETURN NEW;
  END IF;

  -- ไม่มี → ห้ามแก้ sensitive fields
  v_changed_role     := (NEW.role IS DISTINCT FROM OLD.role);
  v_changed_emp      := (NEW.employee_id IS DISTINCT FROM OLD.employee_id);
  v_changed_branches := (NEW.managed_branches IS DISTINCT FROM OLD.managed_branches);

  IF v_changed_role OR v_changed_emp OR v_changed_branches THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ role/employee_id/managed_branches — ใช้ set_employee_role() RPC แทน';
  END IF;

  RETURN NEW;
END $$;

-- ═════════════ STEP 7: audit_log policy — ใช้ system.view_audit ตรงๆ ═════════════
-- เดิม: USING is_admin() → ผูกกับ edit_matrix ไม่ตรง intent
-- ใหม่: USING user_has_permission('system.view_audit')
DROP POLICY IF EXISTS "read_admin_only" ON public.audit_log;
DROP POLICY IF EXISTS "read_view_audit" ON public.audit_log;
CREATE POLICY "read_view_audit" ON public.audit_log FOR SELECT TO authenticated
  USING (public.user_has_permission('system.view_audit'));

-- ═════════════ STEP 8: salary_history policies — ใช้ salary.view_history / salary.adjust ═════════════
-- เดิม: read_admin_only USING is_admin() + write_hr USING is_hr_or_admin() ซ้อน → semantics เพี้ยน
-- ใหม่: แยก SELECT/INSERT/UPDATE/DELETE ตาม permission ที่เหมาะสม
DROP POLICY IF EXISTS "read_admin_only" ON public.salary_history;
DROP POLICY IF EXISTS "write_hr"        ON public.salary_history;
DROP POLICY IF EXISTS "write_admin"     ON public.salary_history;
DROP POLICY IF EXISTS "read_scoped"     ON public.salary_history;
DROP POLICY IF EXISTS "salary_history_read"   ON public.salary_history;
DROP POLICY IF EXISTS "salary_history_write"  ON public.salary_history;
DROP POLICY IF EXISTS "salary_history_update" ON public.salary_history;
DROP POLICY IF EXISTS "salary_history_delete" ON public.salary_history;

CREATE POLICY "salary_history_read" ON public.salary_history FOR SELECT TO authenticated
  USING (public.user_has_permission('salary.view_history'));
CREATE POLICY "salary_history_write" ON public.salary_history FOR INSERT TO authenticated
  WITH CHECK (public.user_has_permission('salary.adjust'));
CREATE POLICY "salary_history_update" ON public.salary_history FOR UPDATE TO authenticated
  USING (public.user_has_permission('salary.adjust'))
  WITH CHECK (public.user_has_permission('salary.adjust'));
CREATE POLICY "salary_history_delete" ON public.salary_history FOR DELETE TO authenticated
  USING (public.user_has_permission('salary.adjust'));

-- ═════════════ STEP 9: NOTIFY + smoke test info ═════════════
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_admin_count   INTEGER;
  v_hr_count      INTEGER;
  v_perm_count    INTEGER;
BEGIN
  -- ทดสอบ helper ที่ปรับใหม่ — ไม่ raise (no auth.uid in DO block, แต่ check syntax + recursion)
  PERFORM public.is_admin();
  PERFORM public.is_hr_or_admin();

  -- ดู baseline ของ matrix
  SELECT COUNT(*) INTO v_admin_count FROM public.role_permissions
    WHERE role_id = 'admin' AND granted = true;
  SELECT COUNT(*) INTO v_hr_count    FROM public.role_permissions
    WHERE role_id = 'hr'    AND granted = true;
  SELECT COUNT(*) INTO v_perm_count  FROM public.permissions;

  RAISE NOTICE '✅ Phase 5 complete — RLS ใช้ permission matrix แล้ว';
  RAISE NOTICE '   admin มี % / % permissions', v_admin_count, v_perm_count;
  RAISE NOTICE '   hr    มี % / % permissions', v_hr_count, v_perm_count;
  RAISE NOTICE '   หลังจากนี้: admin ปลด permission ของ HR ใน UI → RLS บล็อกจริงทันที';
  RAISE NOTICE '   ทดสอบ: login เป็น 7 role ลองอ่าน/เขียน 5-10 actions แต่ละ';
END $$;

-- ═══════════════════════════════════════════════════════════
-- POST-DEPLOY CHECKLIST (manual test ฝั่ง user):
-- 1) Admin login → เปิด matrix → ลองปลด employee.edit ของ HR → Save
-- 2) Logout → Login เป็น HR → เปิดทะเบียนพนักงาน → กดแก้พนักงาน
--    → ควรเจอ error จาก RLS (ไม่ใช่แค่ client toast)
-- 3) Network tab: PATCH /rest/v1/employees → status 401/403
-- 4) Admin → คืน employee.edit ให้ HR → HR แก้ได้ปกติ
-- 5) ลองสร้าง custom role 'junior_hr' (Phase 4b) → assign 1 user → login →
--    permission ของ junior_hr มีผลจริงทั้ง client + server
-- ═══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════
-- OPTIONAL — ถ้าจะใช้ custom role (Phase 4b) ต้องลบ CHECK constraint เก่า:
--   ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
--   ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_role_fk
--     FOREIGN KEY (role) REFERENCES public.roles(id) ON UPDATE CASCADE;
-- ⚠️ destructive — เป็น schema change, แนะนำรันแยกหลังทดสอบ Phase 5 แล้ว
-- ═══════════════════════════════════════════════════════════
