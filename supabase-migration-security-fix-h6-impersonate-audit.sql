-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security Fix H6: Impersonate audit log
--
-- ปัญหาเดิม:
--   - HR กดปุ่ม "ดูเสมือนพนักงาน" → set sessionStorage.kb_as_employee=1
--   - ไม่มี server-side log ว่า HR เปลี่ยน mode ตอนไหน, เพื่อทำอะไร
--   - ถ้า HR ผิดวินัย (เช่นแอบดูข้อมูลส่วนตัวพนักงานคนอื่น) ตรวจไม่ได้
--
-- การแก้:
--   1. สร้าง RPC log_impersonate_toggle(p_enabled BOOLEAN)
--   2. RPC เขียน audit_log ผ่าน SECURITY DEFINER (ปกติ user เขียน audit_log ไม่ได้)
--   3. frontend เรียก RPC ทุกครั้งที่ toggle (data.js setEmployeeView)
--   4. log จะแสดงในหน้า "ประวัติการแก้ไข" — admin เห็นว่าใคร impersonate ตอนไหน
--
-- รันใน Supabase SQL Editor (idempotent — CREATE OR REPLACE)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.log_impersonate_toggle(
  p_enabled BOOLEAN
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     UUID;
  v_user_email  TEXT;
  v_user_role   TEXT;
  v_employee_id TEXT;
  v_action      TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ต้อง login ก่อน';
  END IF;

  -- ดึง profile ของ caller
  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
  SELECT role, employee_id INTO v_user_role, v_employee_id
  FROM public.user_profiles WHERE user_id = v_user_id;

  -- เช็คว่าเป็น HR/admin จริง (กัน user ทั่วไปยิง RPC สร้าง noise log)
  IF v_user_role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'log_impersonate_toggle: เฉพาะ admin/hr เท่านั้น';
  END IF;

  -- ต้องมี employee_id ผูก (เพื่อให้ impersonate ได้)
  IF v_employee_id IS NULL THEN
    RAISE EXCEPTION 'log_impersonate_toggle: profile ต้องมี employee_id';
  END IF;

  v_action := CASE WHEN p_enabled THEN 'IMPERSONATE_ON' ELSE 'IMPERSONATE_OFF' END;

  -- เขียน audit_log ตรงๆ (bypass RLS ผ่าน SECURITY DEFINER)
  INSERT INTO public.audit_log (
    user_id, user_email, user_role,
    action, table_name, record_id, old_data, new_data
  ) VALUES (
    v_user_id, v_user_email, v_user_role,
    v_action,                       -- 'IMPERSONATE_ON' / 'IMPERSONATE_OFF'
    'user_profiles',                -- ใส่ user_profiles เพื่อให้ขึ้นในหน้า "ผู้ใช้และสิทธิ์" filter
    v_employee_id,                  -- record_id = employee_id ของ HR คนนั้น
    NULL,
    jsonb_build_object(
      'impersonate_enabled', p_enabled,
      'as_employee_id',      v_employee_id,
      'ts_bkk',              (now() AT TIME ZONE 'Asia/Bangkok')::text,
      'user_agent',          current_setting('request.headers', true)::jsonb->>'user-agent'
    )
  );

  RETURN jsonb_build_object(
    'logged',        true,
    'action',        v_action,
    'employee_id',   v_employee_id,
    'ts',            now()
  );
END $$;

GRANT EXECUTE ON FUNCTION public.log_impersonate_toggle(BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ Security Fix H6 รัน เสร็จแล้ว';
  RAISE NOTICE '   - RPC log_impersonate_toggle(BOOLEAN) พร้อมใช้';
  RAISE NOTICE '   - frontend (data.js setEmployeeView) ต้อง await DB.client.rpc()';
  RAISE NOTICE '   - audit_log จะมี action = IMPERSONATE_ON / IMPERSONATE_OFF';
  RAISE NOTICE '   - filter ในหน้า "ประวัติการแก้ไข" หา action LIKE ''IMPERSONATE_%''';
END $$;
