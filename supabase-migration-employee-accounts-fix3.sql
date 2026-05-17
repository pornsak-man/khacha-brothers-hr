-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Fix #3: auth.identities.provider_id
-- บั๊ก: provider_id ต้องเป็น user_id (UUID เป็น text) ไม่ใช่ email
-- ตาม convention ของ Supabase Auth (gotrue) สำหรับ email provider
-- ═══════════════════════════════════════════════════════════

-- ── A. ลบบัญชี 121 ที่สร้างผิด (เพื่อให้เริ่มต้นใหม่ได้สะอาด) ──
-- ระวัง: ถ้ามีคนสร้างบัญชีหลายคนแล้ว ส่วนนี้จะลบทั้งหมดที่มี email ลงท้าย @kacha.local
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- นับก่อนลบ
  SELECT COUNT(*) INTO v_count FROM auth.users WHERE email LIKE '%@kacha.local';
  RAISE NOTICE 'จะลบบัญชี % รายการ (email @kacha.local)', v_count;

  -- ลบ identities ก่อน (FK), แล้ว users — trigger จะ cascade ลบ user_profiles ผ่าน FK ON DELETE CASCADE
  DELETE FROM auth.identities WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%@kacha.local');
  DELETE FROM auth.users WHERE email LIKE '%@kacha.local';
END $$;

-- ── B. แก้ฟังก์ชัน create_employee_account ใช้ provider_id ที่ถูก ──
CREATE OR REPLACE FUNCTION public.create_employee_account(p_employee_id TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_uid       UUID;
  v_email     TEXT;
  v_password  TEXT;
  v_name      TEXT;
  v_existing  UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ต้องเป็น admin เท่านั้น';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_employee_id) THEN
    RAISE EXCEPTION 'ไม่พบพนักงานรหัส %', p_employee_id;
  END IF;

  v_email := lower(p_employee_id) || '@kacha.local';
  v_password := p_employee_id;

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
    extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('employee_id', p_employee_id, 'name', v_name),
    now(), now()
  );

  -- provider_id ต้องเป็น user_id (text) ตาม gotrue convention สำหรับ email provider
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
    'email',
    v_uid::text,                -- ← แก้: ใช้ user_id (UUID เป็น text) ไม่ใช่ email
    NULL, now(), now()
  );

  UPDATE public.user_profiles SET employee_id = p_employee_id WHERE user_id = v_uid;

  RETURN jsonb_build_object('user_id', v_uid, 'email', v_email, 'created', true, 'message', 'สร้างบัญชีสำเร็จ');
END $$;

NOTIFY pgrst, 'reload schema';
