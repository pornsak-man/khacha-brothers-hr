-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security fix H5: Server-side account creation
-- ปัญหา: public signUp() endpoint เปิดให้ทุกคนสมัครได้
--        Attacker เดา employee_id ที่ยังไม่มี user_profile → claim บัญชีนั้น
-- แก้:   สร้าง RPC `create_employee_user` (SECURITY DEFINER, HR-only)
--        แทน signUp() → จากนั้นปิด "Allow new users to sign up" ใน Dashboard
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_employee_user(p_employee_id TEXT, p_password TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_uid       UUID;
  v_email     TEXT;
  v_first     TEXT;
  v_last      TEXT;
  v_fullname  TEXT;
BEGIN
  -- ─── 1) Auth check — HR/admin เท่านั้น ──────────────────
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'ต้องเป็น admin หรือ HR' USING ERRCODE = '42501';
  END IF;

  -- ─── 2) Validate employee ──────────────────────────────
  SELECT first_name, last_name INTO v_first, v_last
  FROM public.employees WHERE id = p_employee_id;
  IF v_first IS NULL THEN
    RAISE EXCEPTION 'ไม่พบพนักงาน %', p_employee_id;
  END IF;

  -- ─── 3) ต้องยังไม่มีบัญชีผูกอยู่ ──────────────────────
  IF EXISTS (SELECT 1 FROM public.user_profiles WHERE employee_id = p_employee_id) THEN
    RAISE EXCEPTION 'พนักงาน % มีบัญชีอยู่แล้ว', p_employee_id;
  END IF;

  v_email := lower(p_employee_id) || '@kacha.local';
  v_fullname := COALESCE(NULLIF(trim(v_first || ' ' || COALESCE(v_last, '')), ''), p_employee_id);

  -- ─── 4) Email ต้องไม่ซ้ำ ───────────────────────────────
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_email) THEN
    RAISE EXCEPTION 'Email % มีอยู่แล้วในระบบ', v_email;
  END IF;

  -- ─── 5) Validate password ──────────────────────────────
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RAISE EXCEPTION 'รหัสผ่านต้องอย่างน้อย 6 ตัว';
  END IF;

  v_uid := gen_random_uuid();

  -- ─── 6) Insert into auth.users ─────────────────────────
  -- ใช้รูปแบบเดียวกับที่ supabase signUp สร้าง — รวม raw_user_meta_data
  -- ที่ handle_new_user trigger จะอ่านไปสร้าง user_profiles อัตโนมัติ
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change_token_current,
    is_super_admin, phone_change_token, phone_change, email_change, reauthentication_token, reauthentication_sent_at
  ) VALUES (
    v_uid,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('employee_id', p_employee_id, 'name', v_fullname),
    now(), now(),
    '', '', '', '',
    false, '', '', '', '', null
  );

  -- ─── 7) Insert into auth.identities ────────────────────
  -- Supabase email/password auth ต้องการ row นี้ — เก็บ identity_data ของ provider
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(),
    v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
    'email',
    v_email,
    null,
    now(), now()
  );

  -- ─── 8) handle_new_user trigger จะ auto-create user_profiles ─
  -- (ตรงตาม migration-employee-accounts-fix4.sql)
  -- แต่เผื่อเงื่อนไขเฉพาะ — ใส่ fallback insert ถ้า trigger ไม่ทำงาน
  INSERT INTO public.user_profiles (user_id, employee_id, role, name)
  SELECT v_uid, p_employee_id, 'branch_staff', v_fullname
  WHERE NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = v_uid);

  RETURN jsonb_build_object(
    'user_id', v_uid,
    'email', v_email,
    'name', v_fullname,
    'message', 'สร้างบัญชีสำเร็จ'
  );
END $$;

GRANT EXECUTE ON FUNCTION public.create_employee_user(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ create_employee_user RPC สร้างแล้ว';
  RAISE NOTICE '   HR เรียกผ่าน DB.client.rpc(''create_employee_user'', {...})';
  RAISE NOTICE '   ไม่ใช้ signUp endpoint อีกต่อไป → ปิด public signup ได้';
  RAISE NOTICE '';
  RAISE NOTICE '⚠️  ขั้นตอนถัดไป — ใน Supabase Dashboard:';
  RAISE NOTICE '   Authentication → Sign In/Providers → Email →';
  RAISE NOTICE '   ปิด "Allow new users to sign up" → Save changes';
END $$;
