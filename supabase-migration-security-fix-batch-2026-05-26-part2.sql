-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security Fix Batch Part 2 (2026-05-26)
--
-- ต่อจาก batch แรก — แก้ High + Medium ที่เหลือ:
--   H-2: role_permissions SELECT policy = USING(true) → restrict ตาม caller's role
--   M-1: is_hr_or_admin_cached GUC key รวม auth.uid() (defense-in-depth pgbouncer)
--   M-3: audit_redact_sensitive เพิ่ม sso_no, work_permit_number, email, address
--
-- รันใน Supabase SQL Editor หลัง part 1
-- ═══════════════════════════════════════════════════════════

-- ════════ H-2: role_permissions — เห็นเฉพาะ permission ของ role ตัวเอง ════════
-- เดิม: USING(true) → ทุก authenticated user เห็น matrix ทั้งหมด (privilege model leak)
-- ใหม่: เห็นเฉพาะ permission ของ role ตัวเอง + HR/admin เห็นทั้งหมด (UI management)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='role_permissions'
  ) THEN
    DROP POLICY IF EXISTS "role_permissions_read_all" ON public.role_permissions;
    DROP POLICY IF EXISTS "role_permissions_read"     ON public.role_permissions;
    DROP POLICY IF EXISTS "rp_read"                   ON public.role_permissions;

    CREATE POLICY "role_permissions_read" ON public.role_permissions
      FOR SELECT TO authenticated
      USING (
        -- HR/admin → เห็นทั้งหมด (เพื่อ UI permission matrix)
        public.is_hr_or_admin()
        -- user อื่น → เห็นเฉพาะ permission ของ role ตัวเอง
        OR role_id = (SELECT role FROM public.user_profiles WHERE user_id = auth.uid())
      );
    RAISE NOTICE '✅ H-2: role_permissions SELECT restricted';
  ELSE
    RAISE NOTICE 'ℹ role_permissions table ไม่มี — ข้าม H-2';
  END IF;
END $$;


-- ════════ M-1: is_hr_or_admin_cached — include auth.uid() ใน GUC key ════════
-- defense-in-depth: ถ้า pgbouncer ตั้งเป็น transaction-pooling ผิด → connection อาจ shared
-- ระหว่าง user → cache ของ user A อาจ apply กับ user B
-- → ใส่ uid ใน GUC key เพื่อบังคับให้ different user ได้ cache แยก
CREATE OR REPLACE FUNCTION public.is_hr_or_admin_cached()
RETURNS BOOLEAN
LANGUAGE PLPGSQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid_txt TEXT;
  v_key     TEXT;
  v_cached  TEXT;
  v_result  BOOLEAN;
BEGIN
  v_uid_txt := COALESCE(auth.uid()::text, 'anon');
  v_key := 'khb.is_hr_cache_' || replace(v_uid_txt, '-', '');  -- GUC ห้ามมี dash

  v_cached := current_setting(v_key, true);
  IF v_cached = 'true' THEN RETURN TRUE; END IF;
  IF v_cached = 'false' THEN RETURN FALSE; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_id = auth.uid()
      AND role IN ('admin', 'hr')
  ) INTO v_result;

  PERFORM set_config(v_key, v_result::TEXT, true);
  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.is_hr_or_admin_cached() TO authenticated;


-- ════════ M-3: extend audit_redact_sensitive ════════
-- เดิม redact: national_id, bank_account, passport, phone, mobile + drop tokens
-- เพิ่ม: sso_no, work_permit_number, email, address (PDPA + contact info)
CREATE OR REPLACE FUNCTION public.audit_redact_sensitive(p_data JSONB)
RETURNS JSONB
LANGUAGE PLPGSQL
IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
  v_out JSONB;
  v_val TEXT;
BEGIN
  IF p_data IS NULL THEN RETURN NULL; END IF;
  v_out := p_data;

  -- drop auth secrets
  v_out := v_out
    - 'encrypted_password'
    - 'password'
    - 'recovery_token'
    - 'confirmation_token'
    - 'email_change_token_new'
    - 'email_change_token_current'
    - 'phone_change_token'
    - 'reauthentication_token';

  -- helper: mask field ที่เป็น text แบบ "[REDACTED-Nch]" + เก็บ length
  v_val := v_out->>'national_id';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{national_id}', to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  v_val := v_out->>'bank_account';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{bank_account}', to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  v_val := v_out->>'passport_number';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{passport_number}', to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  -- ★ M-3 new: work_permit_number, sso_no
  v_val := v_out->>'work_permit_number';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{work_permit_number}', to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  v_val := v_out->>'sso_no';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{sso_no}', to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  -- phone — เก็บ 3 ตัวสุดท้าย (audit trail ดูได้ว่าเปลี่ยนเลข)
  v_val := v_out->>'phone';
  IF v_val IS NOT NULL AND length(v_val) >= 4 THEN
    v_out := jsonb_set(v_out, '{phone}', to_jsonb(repeat('•', length(v_val) - 3) || right(v_val, 3)));
  END IF;

  v_val := v_out->>'mobile';
  IF v_val IS NOT NULL AND length(v_val) >= 4 THEN
    v_out := jsonb_set(v_out, '{mobile}', to_jsonb(repeat('•', length(v_val) - 3) || right(v_val, 3)));
  END IF;

  -- ★ M-3 new: email — เก็บ domain
  v_val := v_out->>'email';
  IF v_val IS NOT NULL AND position('@' IN v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{email}', to_jsonb('•••@' || split_part(v_val, '@', 2)));
  END IF;

  -- ★ M-3 new: address — เก็บแค่ "[REDACTED-Nch]" (address ละเอียดเกินไป)
  v_val := v_out->>'address';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{address}', to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  RETURN v_out;
END $$;


-- ════════ Final ════════
NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════';
  RAISE NOTICE '✅ Security Fix Batch Part 2 ติดตั้งเสร็จ';
  RAISE NOTICE '  H-2: role_permissions ปกป้อง privilege model';
  RAISE NOTICE '  M-1: is_hr_or_admin_cached GUC key ใส่ uid (defense-in-depth)';
  RAISE NOTICE '  M-3: audit_redact_sensitive เพิ่ม sso_no, work_permit, email, address';
  RAISE NOTICE '═══════════════════════════════════════════';
END $$;
