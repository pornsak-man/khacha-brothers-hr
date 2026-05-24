-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security Fix C2: ไม่ return password plaintext
--
-- ปัญหาเดิม (reset-password-default-natid.sql):
--   - RPC คืน password ใน JSON response → ติด browser DevTools, network log,
--     audit_log ผ่าน trigger, supabase log
--   - default password = เลขประชาชน → guessable (เลข ปชช อยู่ใน Excel export)
--   - ไม่มี force-change-on-first-login → user ไม่รู้ตัว
--
-- การแก้:
--   1. เพิ่ม column user_profiles.force_password_change (default false)
--   2. reset_employee_password ตั้ง flag = true และ "ไม่" return password
--      ถ้า HR ระบุ password เอง → คืน { needs_change: true, length: N }
--      ถ้าใช้ default natid → คืน { needs_change: true, hint: 'natid' }
--      (HR ได้ hint แต่ไม่ได้ค่าจริง → ป้องกัน HR เผลอ leak)
--   3. create_employee_user ก็ตั้ง flag = true ด้วย
--   4. ฟังก์ชันใหม่ clear_force_password_change(user_id) — เรียกหลัง user
--      เปลี่ยน password เอง
--
-- ⚠️ ต้องรันคู่กับการแก้ frontend ที่:
--   - หลัง login เช็ค user_profiles.force_password_change → ถ้า true → force modal
--   - หลัง changePassword สำเร็จ → เรียก clear_force_password_change()
--
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- 1. เพิ่ม column flag
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_profiles.force_password_change IS
  'true = ต้องเปลี่ยน password ก่อนใช้งาน (ตั้งโดย reset_employee_password / create_employee_user)';

-- 2. รีเขียน reset_employee_password — ไม่ return password plaintext
CREATE OR REPLACE FUNCTION public.reset_employee_password(
  p_employee_id TEXT,
  p_new_password TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_uid           UUID;
  v_password      TEXT;
  v_password_src  TEXT;  -- 'custom' / 'natid' / 'empid'
  v_natid         TEXT;
  v_pwd_len       INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ต้องเป็น admin เท่านั้น';
  END IF;

  SELECT regexp_replace(COALESCE(national_id, ''), '\D', '', 'g') INTO v_natid
  FROM public.employees WHERE id = p_employee_id;

  IF NULLIF(trim(p_new_password), '') IS NOT NULL THEN
    v_password := trim(p_new_password);
    v_password_src := 'custom';
  ELSIF NULLIF(v_natid, '') IS NOT NULL THEN
    v_password := v_natid;
    v_password_src := 'natid';
  ELSE
    v_password := p_employee_id;
    v_password_src := 'empid';
  END IF;

  -- บังคับความยาวขั้นต่ำ 6 ตัวอักษร (กัน HR ระบุ password สั้นเกินไป)
  IF length(v_password) < 6 THEN
    RAISE EXCEPTION 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร';
  END IF;
  v_pwd_len := length(v_password);

  SELECT user_id INTO v_uid FROM public.user_profiles WHERE employee_id = p_employee_id;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'ไม่พบบัญชีของพนักงาน %', p_employee_id;
  END IF;

  -- update password ใน auth.users
  UPDATE auth.users
  SET encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
      updated_at = now()
  WHERE id = v_uid;

  -- ตั้ง force-change flag
  UPDATE public.user_profiles
  SET force_password_change = true
  WHERE user_id = v_uid;

  -- คืนเฉพาะ metadata — ไม่มี password plaintext
  RETURN jsonb_build_object(
    'user_id',       v_uid,
    'employee_id',   p_employee_id,
    'needs_change',  true,
    'password_src',  v_password_src,   -- 'natid' / 'empid' / 'custom'
    'password_len',  v_pwd_len,        -- บอกความยาวให้ HR ตรวจสอบ
    'message',       'รีเซ็ตรหัสผ่านสำเร็จ — พนักงานต้องเปลี่ยนรหัสตอน login ครั้งถัดไป'
  );
END $$;

GRANT EXECUTE ON FUNCTION public.reset_employee_password(TEXT, TEXT) TO authenticated;

-- 3. รีเขียน create_employee_user ให้ตั้ง force_password_change = true
--    (เผื่อ create_employee_user มีอยู่แล้วจาก h5-create-user-rpc-v2.sql)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_employee_user') THEN
    -- อัพ flag ทันทีหลัง create — รัน trigger หลัง create_employee_user สำเร็จ
    -- ทำเป็น trigger ของ user_profiles INSERT
    NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.trg_set_force_pwd_change_on_create()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN
  -- ทุก user_profile ใหม่ที่สร้างผ่าน create_employee_user → ต้องเปลี่ยน pwd
  -- ยกเว้น admin manual seed (NEW.role = 'admin' AND created by service_role)
  IF NEW.role <> 'admin' OR
     COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
  THEN
    NEW.force_password_change := true;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS set_force_pwd_change_on_profile_insert ON public.user_profiles;
CREATE TRIGGER set_force_pwd_change_on_profile_insert
  BEFORE INSERT ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.trg_set_force_pwd_change_on_create();

-- 4. ฟังก์ชันเคลียร์ flag (เรียกหลัง user เปลี่ยน pwd เองสำเร็จ)
CREATE OR REPLACE FUNCTION public.clear_force_password_change()
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'ต้อง login ก่อน';
  END IF;

  UPDATE public.user_profiles
  SET force_password_change = false
  WHERE user_id = v_uid;

  RETURN jsonb_build_object('user_id', v_uid, 'cleared', true);
END $$;

GRANT EXECUTE ON FUNCTION public.clear_force_password_change() TO authenticated;

-- 5. View สำหรับ client เช็คสถานะตัวเอง (ใช้ RLS — เห็นแค่ของตัวเอง)
-- (ไม่ต้องเพิ่ม view เพราะ client query user_profiles ของตัวเองได้อยู่แล้ว
--  ผ่าน RLS policy ที่ใช้ auth.uid() = user_id)

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ Security Fix C2 รัน เสร็จแล้ว';
  RAISE NOTICE '   - reset_employee_password ไม่ return password plaintext';
  RAISE NOTICE '   - ตั้ง user_profiles.force_password_change = true';
  RAISE NOTICE '   - frontend ต้องเช็ค flag หลัง login → force change modal';
  RAISE NOTICE '   - หลัง user เปลี่ยน pwd → เรียก rpc clear_force_password_change()';
END $$;
