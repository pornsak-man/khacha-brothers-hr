-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Fix: create_employee_account
-- บั๊ก: พยายามใส่ employees.id (TEXT) ลงในตัวแปร UUID → cast fail
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_employee_account(p_employee_id TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid       UUID;
  v_email     TEXT;
  v_password  TEXT;
  v_name      TEXT;
  v_existing  UUID;
BEGIN
  -- เฉพาะ admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ต้องเป็น admin เท่านั้น';
  END IF;

  -- ตรวจ employee มีจริง (employees.id เป็น TEXT ไม่ใช่ UUID — ใช้ EXISTS แทน)
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_employee_id) THEN
    RAISE EXCEPTION 'ไม่พบพนักงานรหัส %', p_employee_id;
  END IF;

  v_email := lower(p_employee_id) || '@kacha.local';
  v_password := p_employee_id;

  -- ถ้ามีบัญชีอยู่แล้ว — แค่คืน user_id เดิม + link ให้แน่ใจ
  SELECT id INTO v_existing FROM auth.users WHERE email = v_email;
  IF v_existing IS NOT NULL THEN
    UPDATE public.user_profiles SET employee_id = p_employee_id WHERE user_id = v_existing AND (employee_id IS NULL OR employee_id != p_employee_id);
    RETURN jsonb_build_object('user_id', v_existing, 'email', v_email, 'created', false, 'message', 'บัญชีมีอยู่แล้ว');
  END IF;

  SELECT trim(first_name || ' ' || COALESCE(last_name, '')) INTO v_name
    FROM public.employees WHERE id = p_employee_id;

  v_uid := gen_random_uuid();

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_uid, 'authenticated', 'authenticated', v_email,
    crypt(v_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('employee_id', p_employee_id, 'name', v_name),
    now(), now()
  );

  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
    'email', v_email, NULL, now(), now()
  );

  UPDATE public.user_profiles SET employee_id = p_employee_id WHERE user_id = v_uid;

  RETURN jsonb_build_object('user_id', v_uid, 'email', v_email, 'created', true, 'message', 'สร้างบัญชีสำเร็จ');
END $$;

NOTIFY pgrst, 'reload schema';
