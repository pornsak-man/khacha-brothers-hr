-- ═══════════════════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: SSO Smart Auto-Backdate
-- ─────────────────────────────────────────────────────────────────────
-- 🧠 Auto-fill sso_enrolled_date / sso_terminated_date เมื่อ insert/update
-- พนักงานที่ hire_date หรือ termination_date เก่ากว่า window
--
-- หลักการ:
--   • แจ้งเข้า: window 30 วัน — ถ้า hire_date < today - 30
--     และ sso_enrolled_date ยังว่าง → auto-set = hire_date
--   • แจ้งออก: window 15 วัน — ถ้า termination_date < today - 15
--     และ sso_terminated_date ยังว่าง → auto-set = termination_date
--
-- ประโยชน์:
--   ✅ Import พนักงานเก่า → ไม่ขึ้น "ต้องแจ้ง" ที่ผ่านเขตเวลาแล้ว
--   ✅ Import พนักงานใหม่ (เพิ่งจ้าง) → ขึ้น "รอแจ้ง" ปกติ
--   ✅ HR ไม่ต้องไล่ตามแจ้งย้อนหลังพนักงานก่อนระบบ
--
-- ใช้ BEFORE INSERT OR UPDATE — ไม่ทำงานเมื่อ HR กรอก enrolled_date เอง
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_sso_auto_backdate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_hire_cutoff DATE := CURRENT_DATE - INTERVAL '30 days';
  v_term_cutoff DATE := CURRENT_DATE - INTERVAL '15 days';
BEGIN
  -- ── Smart hire backdate ──
  -- เงื่อนไข: มี hire_date + sso_enrolled_date ยังว่าง + hire_date เก่ากว่า window
  IF NEW.hire_date IS NOT NULL
     AND NEW.sso_enrolled_date IS NULL
     AND NEW.hire_date < v_hire_cutoff
  THEN
    NEW.sso_enrolled_date := NEW.hire_date;
  END IF;

  -- ── Smart termination backdate ──
  -- เงื่อนไข: มี termination_date + sso_terminated_date ยังว่าง + เก่ากว่า window
  IF NEW.termination_date IS NOT NULL
     AND NEW.sso_terminated_date IS NULL
     AND NEW.termination_date < v_term_cutoff
  THEN
    NEW.sso_terminated_date := NEW.termination_date;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- ไม่ block insert/update — แค่ skip backdate ถ้า error
  RAISE WARNING 'SSO auto-backdate error for emp %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sso_auto_backdate ON public.employees;
CREATE TRIGGER trg_sso_auto_backdate
  BEFORE INSERT OR UPDATE OF hire_date, termination_date, sso_enrolled_date, sso_terminated_date
  ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.fn_sso_auto_backdate();

NOTIFY pgrst, 'reload schema';

-- ─── ตรวจสอบ ───
SELECT '✅ SSO Smart Auto-Backdate ติดตั้งเสร็จ' AS status;
SELECT
  '🆕 Import/INSERT พนักงานใหม่ที่ hire_date > 30 วัน → auto-set sso_enrolled_date' AS info_1,
  '🆕 termination_date > 15 วัน → auto-set sso_terminated_date' AS info_2,
  '🛡️ ไม่ override ค่าที่ HR กรอกเองอยู่แล้ว' AS info_3;
