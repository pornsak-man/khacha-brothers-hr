-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security Fix H4: Redact PII ใน audit_log
--
-- ปัญหาเดิม (audit-log.sql):
--   - audit_trigger_fn ใช้ to_jsonb(NEW) เก็บทุก column → รวม
--       * encrypted_password (ของ auth.users ถ้าผูก trigger)
--       * national_id (เลขประจำตัวประชาชน — PDPA sensitive)
--       * bank_account / bank
--   - HR เปิดหน้า "ประวัติการแก้ไข" → เห็น national_id + bank ของทุกคนใน
--     log ย้อนหลัง → expand PII exposure จาก "view current" เป็น "view history"
--
-- การแก้:
--   1. สร้าง helper audit_redact_sensitive(JSONB) → JSONB
--   2. ลบ field ที่เป็นความลับสุดยอด: encrypted_password, password, recovery_token
--   3. Mask field ที่เป็น PII: national_id → '[REDACTED-13]' (เก็บความยาวบอกว่าฟอร์แมตถูก)
--      bank_account → '[REDACTED-N]'
--   4. Keep: salary, amounts, dates, name, address, phone (HR ต้องเห็นเพื่อ audit)
--      (ถ้าจะ redact เพิ่มในอนาคต — แก้แค่ helper ฟังก์ชันเดียว)
--   5. แก้ audit_trigger_fn ให้เรียก helper
--
-- รันใน Supabase SQL Editor (idempotent — CREATE OR REPLACE)
-- ═══════════════════════════════════════════════════════════

-- 1. Helper redact
CREATE OR REPLACE FUNCTION public.audit_redact_sensitive(p_data JSONB)
RETURNS JSONB
LANGUAGE PLPGSQL
IMMUTABLE
AS $$
DECLARE
  v_out JSONB;
  v_val TEXT;
BEGIN
  IF p_data IS NULL THEN
    RETURN NULL;
  END IF;
  v_out := p_data;

  -- ─── ลบทิ้งทั้ง field (auth secret — ห้าม leak ใน audit) ───
  v_out := v_out
    - 'encrypted_password'
    - 'password'
    - 'recovery_token'
    - 'confirmation_token'
    - 'email_change_token_new'
    - 'email_change_token_current'
    - 'phone_change_token'
    - 'reauthentication_token';

  -- ─── Mask national_id (PDPA — เลข ปชช) ───
  v_val := v_out->>'national_id';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{national_id}',
      to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  -- ─── Mask bank account ───
  v_val := v_out->>'bank_account';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{bank_account}',
      to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  -- ─── Mask passport ───
  v_val := v_out->>'passport_number';
  IF v_val IS NOT NULL AND length(v_val) > 0 THEN
    v_out := jsonb_set(v_out, '{passport_number}',
      to_jsonb('[REDACTED-' || length(v_val) || 'ch]'));
  END IF;

  -- ─── Mask phone (เก็บ 3 ตัวสุดท้าย เพื่อบอกว่าเปลี่ยนเป็นอันใหม่จริงไหม) ───
  v_val := v_out->>'phone';
  IF v_val IS NOT NULL AND length(v_val) >= 4 THEN
    v_out := jsonb_set(v_out, '{phone}',
      to_jsonb(repeat('•', length(v_val) - 3) || right(v_val, 3)));
  END IF;

  v_val := v_out->>'mobile';
  IF v_val IS NOT NULL AND length(v_val) >= 4 THEN
    v_out := jsonb_set(v_out, '{mobile}',
      to_jsonb(repeat('•', length(v_val) - 3) || right(v_val, 3)));
  END IF;

  RETURN v_out;
END $$;

-- 2. แก้ audit_trigger_fn ให้เรียก helper
CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS TRIGGER LANGUAGE PLPGSQL SECURITY DEFINER AS $$
DECLARE
  v_user_id    UUID;
  v_user_email TEXT;
  v_user_role  TEXT;
  v_record_id  TEXT;
  v_old        JSONB;
  v_new        JSONB;
BEGIN
  BEGIN
    v_user_id := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_user_id := NULL;
  END;
  IF v_user_id IS NOT NULL THEN
    SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
    SELECT role INTO v_user_role FROM public.user_profiles WHERE user_id = v_user_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old := public.audit_redact_sensitive(to_jsonb(OLD));
    v_new := NULL;
    BEGIN v_record_id := (to_jsonb(OLD)->>'id'); EXCEPTION WHEN OTHERS THEN v_record_id := NULL; END;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := public.audit_redact_sensitive(to_jsonb(OLD));
    v_new := public.audit_redact_sensitive(to_jsonb(NEW));
    BEGIN v_record_id := (to_jsonb(NEW)->>'id'); EXCEPTION WHEN OTHERS THEN v_record_id := NULL; END;
  ELSE  -- INSERT
    v_old := NULL;
    v_new := public.audit_redact_sensitive(to_jsonb(NEW));
    BEGIN v_record_id := (to_jsonb(NEW)->>'id'); EXCEPTION WHEN OTHERS THEN v_record_id := NULL; END;
  END IF;

  INSERT INTO public.audit_log (
    user_id, user_email, user_role,
    action, table_name, record_id, old_data, new_data
  ) VALUES (
    v_user_id, v_user_email, v_user_role,
    TG_OP, TG_TABLE_NAME, v_record_id, v_old, v_new
  );

  RETURN COALESCE(NEW, OLD);
END $$;

-- 3. Backfill — redact log เก่าที่มี PII ค้างอยู่
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.audit_log
  SET old_data = public.audit_redact_sensitive(old_data),
      new_data = public.audit_redact_sensitive(new_data)
  WHERE (old_data ? 'national_id' OR old_data ? 'bank_account' OR old_data ? 'encrypted_password' OR old_data ? 'passport_number'
      OR new_data ? 'national_id' OR new_data ? 'bank_account' OR new_data ? 'encrypted_password' OR new_data ? 'passport_number');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '✅ Backfill redact log เก่า: % rows', v_count;
END $$;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ Security Fix H4 รัน เสร็จแล้ว';
  RAISE NOTICE '   - audit_trigger_fn redact PII ก่อนเขียน audit_log';
  RAISE NOTICE '   - log เก่าที่มี PII ถูก redact backfill แล้ว';
  RAISE NOTICE '   - national_id/bank_account/passport → [REDACTED-Nch]';
  RAISE NOTICE '   - phone/mobile → •••XXX (เก็บ 3 ตัวท้าย)';
  RAISE NOTICE '   - encrypted_password/recovery_token → ลบทิ้ง';
END $$;
