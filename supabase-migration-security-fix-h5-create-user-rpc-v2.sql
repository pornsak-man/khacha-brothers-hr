-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Update: create_employee_user รองรับ orphan auth.users
-- ปัญหา: บัญชี auth.users เก่าที่ user_profiles ไม่ผูก → block การสร้างใหม่
--        (เกิดจาก profile ถูกลบ แต่ auth user ยังอยู่)
-- แก้:   ถ้าเจอ orphan auth user → reset password + link profile แทน throw error
-- รันใน Supabase SQL Editor (idempotent — override version เก่า)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_employee_user(p_employee_id TEXT, p_password TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_uid          UUID;
  v_email        TEXT;
  v_first        TEXT;
  v_last         TEXT;
  v_fullname     TEXT;
  v_existing_uid UUID;
  v_msg          TEXT;
BEGIN
  -- 1) Auth check
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'ต้องเป็น admin หรือ HR' USING ERRCODE = '42501';
  END IF;

  -- 2) Validate employee
  SELECT first_name, last_name INTO v_first, v_last
  FROM public.employees WHERE id = p_employee_id;
  IF v_first IS NULL THEN
    RAISE EXCEPTION 'ไม่พบพนักงาน %', p_employee_id;
  END IF;

  -- 3) ต้องยังไม่มี profile ผูก
  IF EXISTS (SELECT 1 FROM public.user_profiles WHERE employee_id = p_employee_id) THEN
    RAISE EXCEPTION 'พนักงาน % มีบัญชีอยู่แล้ว', p_employee_id;
  END IF;

  v_email := lower(p_employee_id) || '@kacha.local';
  v_fullname := COALESCE(NULLIF(trim(v_first || ' ' || COALESCE(v_last, '')), ''), p_employee_id);

  IF p_password IS NULL OR length(p_password) < 6 THEN
    RAISE EXCEPTION 'รหัสผ่านต้องอย่างน้อย 6 ตัว';
  END IF;

  -- 4) เช็คว่ามี auth.users orphan อยู่ไหม
  SELECT id INTO v_existing_uid FROM auth.users WHERE email = v_email;

  IF v_existing_uid IS NOT NULL THEN
    -- ─── ORPHAN CASE: reset password + link profile (preserve user_id) ───
    UPDATE auth.users
    SET encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
        updated_at = now(),
        raw_user_meta_data = jsonb_build_object('employee_id', p_employee_id, 'name', v_fullname),
        email_confirmed_at = COALESCE(email_confirmed_at, now())
    WHERE id = v_existing_uid;

    -- ถ้ายังไม่มี identity row ก็สร้าง
    INSERT INTO auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    )
    SELECT
      gen_random_uuid(), v_existing_uid,
      jsonb_build_object('sub', v_existing_uid::text, 'email', v_email, 'email_verified', true),
      'email', v_email, null, now(), now()
    WHERE NOT EXISTS (
      SELECT 1 FROM auth.identities
      WHERE user_id = v_existing_uid AND provider = 'email'
    );

    -- ผูก profile
    INSERT INTO public.user_profiles (user_id, employee_id, role, name)
    VALUES (v_existing_uid, p_employee_id, 'branch_staff', v_fullname)
    ON CONFLICT (user_id) DO UPDATE
      SET employee_id = EXCLUDED.employee_id,
          name        = EXCLUDED.name;

    v_uid := v_existing_uid;
    v_msg := 'สร้างบัญชีสำเร็จ (ผูกกับ auth user เก่าที่ orphan + รีเซ็ตรหัสผ่าน)';
  ELSE
    -- ─── NEW USER CASE: สร้างใหม่ตามปกติ ───
    v_uid := gen_random_uuid();

    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change_token_current,
      is_super_admin, phone_change_token, phone_change, email_change, reauthentication_token, reauthentication_sent_at
    ) VALUES (
      v_uid,
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      v_email,
      extensions.crypt(p_password, extensions.gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('employee_id', p_employee_id, 'name', v_fullname),
      now(), now(),
      '', '', '', '',
      false, '', '', '', '', null
    );

    INSERT INTO auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
      'email', v_email, null, now(), now()
    );

    -- fallback ถ้า handle_new_user trigger ไม่ทำงาน
    INSERT INTO public.user_profiles (user_id, employee_id, role, name)
    SELECT v_uid, p_employee_id, 'branch_staff', v_fullname
    WHERE NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = v_uid);

    v_msg := 'สร้างบัญชีสำเร็จ';
  END IF;

  RETURN jsonb_build_object(
    'user_id', v_uid,
    'email', v_email,
    'name', v_fullname,
    'message', v_msg
  );
END $$;

GRANT EXECUTE ON FUNCTION public.create_employee_user(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ create_employee_user v2 — รองรับ orphan auth.users';
  RAISE NOTICE '   - ปกติ: สร้าง auth.users + identities + profile ใหม่';
  RAISE NOTICE '   - Orphan case: reset password + ผูก profile (preserve user_id)';
END $$;
