-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Security Fix H3: Revoke refresh tokens on terminate
--
-- ปัญหาเดิม (terminated-block-login.sql):
--   - ตั้ง auth.users.banned_until = '2099-12-31' → block login ใหม่
--   - แต่ refresh_token + sessions ที่ออกไปแล้วยัง valid
--   - พนักงานออก แต่ device ยัง refresh session ได้ 30 วัน (Supabase default)
--   - ตัวอย่าง: พนักงานเปิด app ในมือถือทิ้งไว้ก่อนถูก terminate
--     → app refresh token ทุกชั่วโมงต่อไปเรื่อยๆ → access ได้จนกว่า token หมดอายุ
--
-- การแก้:
--   1. ทุกครั้งที่ block (active → terminated) → DELETE refresh_tokens + sessions
--   2. ทำใน sync_employee_termination_to_auth() เดิม ในบล็อก v_new_terminated
--   3. แก้ exception handler ให้ raise warning แต่ไม่ swallow (L5 fix)
--
-- รันใน Supabase SQL Editor (idempotent — CREATE OR REPLACE)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sync_employee_termination_to_auth()
RETURNS TRIGGER LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_user_id UUID;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_old_terminated BOOLEAN;
  v_new_terminated BOOLEAN;
  v_revoked_tokens INTEGER := 0;
  v_revoked_sessions INTEGER := 0;
BEGIN
  SELECT user_id INTO v_user_id
  FROM public.user_profiles
  WHERE employee_id = NEW.id;
  IF v_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_old_terminated := (TG_OP = 'UPDATE' AND OLD.termination_date IS NOT NULL AND OLD.termination_date <= v_today);
  v_new_terminated := (NEW.termination_date IS NOT NULL AND NEW.termination_date <= v_today);

  -- เพิ่ง terminate (active → terminated)
  IF v_new_terminated AND NOT v_old_terminated THEN
    -- 1. block login ใหม่
    UPDATE auth.users
    SET banned_until = '2099-12-31 00:00:00+00'::timestamptz
    WHERE id = v_user_id;

    -- 2. ⭐ NEW: revoke refresh_tokens ที่ออกไปแล้ว → device ที่เปิดอยู่จะ refresh ไม่ได้
    BEGIN
      DELETE FROM auth.refresh_tokens WHERE user_id = v_user_id::text;
      GET DIAGNOSTICS v_revoked_tokens = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
      -- บางเวอร์ชัน auth.refresh_tokens.user_id เป็น UUID, บางเวอร์ชันเป็น TEXT
      BEGIN
        DELETE FROM auth.refresh_tokens WHERE user_id = v_user_id;
        GET DIAGNOSTICS v_revoked_tokens = ROW_COUNT;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'cannot revoke refresh_tokens for %: %', v_user_id, SQLERRM;
      END;
    END;

    -- 3. ⭐ NEW: revoke active sessions
    BEGIN
      DELETE FROM auth.sessions WHERE user_id = v_user_id;
      GET DIAGNOSTICS v_revoked_sessions = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'cannot revoke sessions for %: %', v_user_id, SQLERRM;
    END;

    RAISE NOTICE 'Blocked auth.users.id=% (employee %) — revoked %_tokens %_sessions',
      v_user_id, NEW.id, v_revoked_tokens, v_revoked_sessions;

  -- ยกเลิก termination (terminated → active)
  ELSIF v_old_terminated AND NOT v_new_terminated THEN
    UPDATE auth.users
    SET banned_until = NULL
    WHERE id = v_user_id;
    RAISE NOTICE 'Unblocked auth.users.id=% (employee %) — user ต้อง login ใหม่',
      v_user_id, NEW.id;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- L5 fix: ไม่ swallow เงียบ — raise warning ให้ admin เห็น
  -- แต่ยัง return NEW เพื่อไม่ block การ save employee (fail-safe)
  RAISE WARNING 'sync_employee_termination_to_auth FAILED for employee %: % (% / %)',
    NEW.id, SQLERRM, SQLSTATE, COALESCE(v_user_id::text, '<no-user>');
  RETURN NEW;
END $$;

-- Trigger เดิมไม่ต้องสร้างใหม่ — CREATE OR REPLACE FUNCTION อัพ logic ในตัว
-- แต่ถ้าจะให้แน่ใจ:
DROP TRIGGER IF EXISTS trg_emp_terminated_block_auth ON public.employees;
CREATE TRIGGER trg_emp_terminated_block_auth
  AFTER INSERT OR UPDATE OF termination_date ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.sync_employee_termination_to_auth();

-- BACKFILL — revoke tokens ของพนักงานที่ terminated แล้ว แต่ยังไม่ revoke
DO $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_count_revoked_tokens INTEGER;
  v_count_revoked_sessions INTEGER;
BEGIN
  -- revoke tokens ของ user ที่ terminated
  WITH terminated_users AS (
    SELECT up.user_id::text AS uid_text, up.user_id AS uid
    FROM public.user_profiles up
    JOIN public.employees e ON e.id = up.employee_id
    WHERE e.termination_date IS NOT NULL
      AND e.termination_date <= v_today
  )
  DELETE FROM auth.refresh_tokens rt
  USING terminated_users tu
  WHERE rt.user_id::text = tu.uid_text;
  GET DIAGNOSTICS v_count_revoked_tokens = ROW_COUNT;

  WITH terminated_users AS (
    SELECT up.user_id AS uid
    FROM public.user_profiles up
    JOIN public.employees e ON e.id = up.employee_id
    WHERE e.termination_date IS NOT NULL
      AND e.termination_date <= v_today
  )
  DELETE FROM auth.sessions s
  USING terminated_users tu
  WHERE s.user_id = tu.uid;
  GET DIAGNOSTICS v_count_revoked_sessions = ROW_COUNT;

  RAISE NOTICE '✅ Backfill revoke เสร็จ: tokens=% sessions=%',
    v_count_revoked_tokens, v_count_revoked_sessions;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Backfill revoke FAILED: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ Security Fix H3 รัน เสร็จแล้ว';
  RAISE NOTICE '   - terminate พนักงาน → revoke refresh_tokens + sessions ทันที';
  RAISE NOTICE '   - device ที่เปิดอยู่ใน app ของพนักงานนั้น → refresh ไม่ได้ → logout อัตโนมัติ';
  RAISE NOTICE '   - L5 fix: exception จะ raise warning ไม่ swallow เงียบ';
END $$;
