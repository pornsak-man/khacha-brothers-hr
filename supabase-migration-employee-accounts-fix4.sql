-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Fix #4: ใช้ signUp แทน direct INSERT
-- เลิก insert ตรงๆ ลง auth.users (ไม่ stable ระหว่าง Supabase versions)
-- ใช้ supabase.auth.signUp() จาก client + อัปเกรด handle_new_user trigger
-- ให้อ่าน employee_id จาก raw_user_meta_data → auto-link โดยอัตโนมัติ
-- ═══════════════════════════════════════════════════════════

-- ── A. ลบบัญชี @kacha.local ทั้งหมดที่สร้างผิดๆ (เริ่มต้นใหม่สะอาด) ──
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM auth.users WHERE email LIKE '%@kacha.local';
  RAISE NOTICE 'จะลบบัญชี @kacha.local จำนวน % รายการ', v_count;
  DELETE FROM auth.identities WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%@kacha.local');
  DELETE FROM auth.users WHERE email LIKE '%@kacha.local';
END $$;

-- ── B. อัปเกรด handle_new_user — ผูก employee_id อัตโนมัติจาก raw_user_meta_data ──
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
AS $$
DECLARE
  v_emp_id TEXT;
BEGIN
  v_emp_id := NEW.raw_user_meta_data->>'employee_id';
  -- ถ้า employee_id อยู่ใน metadata และมี employee จริง → ผูกให้ทันที
  IF v_emp_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employees WHERE id = v_emp_id) THEN
    v_emp_id := NULL;
  END IF;

  INSERT INTO public.user_profiles (user_id, name, role, employee_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    'viewer',
    v_emp_id
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END $$;

-- trigger ต่อ auth.users — re-create กันลำดับเก่าหาย
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── C. ลบ RPC functions เก่าที่ insert ตรงๆ — เลิกใช้ ──
DROP FUNCTION IF EXISTS public.create_employee_account(TEXT);
DROP FUNCTION IF EXISTS public.bulk_create_employee_accounts();

-- ── D. คงไว้: reset_employee_password (admin reset ผ่าน direct UPDATE) ──
-- ลบ + สร้างใหม่ — UPDATE auth.users.encrypted_password ใช้ได้ปลอดภัย
CREATE OR REPLACE FUNCTION public.reset_employee_password(p_employee_id TEXT, p_new_password TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_uid      UUID;
  v_password TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ต้องเป็น admin เท่านั้น';
  END IF;
  v_password := COALESCE(NULLIF(trim(p_new_password), ''), p_employee_id);
  SELECT user_id INTO v_uid FROM public.user_profiles WHERE employee_id = p_employee_id;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'ไม่พบบัญชีของพนักงาน %', p_employee_id;
  END IF;
  UPDATE auth.users
  SET encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
      updated_at = now()
  WHERE id = v_uid;
  RETURN jsonb_build_object('user_id', v_uid, 'password', v_password, 'message', 'รีเซ็ตรหัสผ่านสำเร็จ');
END $$;

GRANT EXECUTE ON FUNCTION public.reset_employee_password(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
