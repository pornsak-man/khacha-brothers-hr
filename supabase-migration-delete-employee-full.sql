-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — ลบพนักงานพร้อมเคลียร์บัญชี login ให้ครบ (ไม่เหลือ orphan)
--
-- ปัญหาเดิม: DB.deleteEmployee ลบแค่แถวใน public.employees แต่บัญชี login ที่ผูกอยู่
--   (auth.users email = {id}@kacha.local + auth.identities + user_profiles)
--   ไม่ถูกลบตาม → เกิด "orphan login account" ค้างในระบบ
--   ผลจริง: ตอน rename 5468-B → 5468 เคยติด error "อีเมล 5468@kacha.local มีบัญชีอื่นใช้แล้ว"
--   เพราะพนักงาน 5468 เดิมถูกลบไปแล้ว แต่บัญชี login ยังค้าง
--   (ภายหลังแก้ที่ rename_employee_id ให้ auto-clean orphan — migration นี้แก้ที่ "การลบ" ให้ครบ)
--
-- วิธีแก้: RPC delete_employee_full(p_employee_id) — SECURITY DEFINER, เช็ค is_hr_or_admin()
--   ลบในทรานแซกชันเดียว (RPC = 1 transaction): auth.identities + user_profiles + auth.users + employees
--   (อ้าง pattern การจัดการ auth จาก rename_employee_id — supabase-migration-rename-employee-id.sql)
--   แล้วให้ DB.deleteEmployee เรียก RPC นี้แทน .from('employees').delete()
--
-- ★ ความปลอดภัย (สำคัญ):
--   - ลบบัญชี auth "เฉพาะที่อีเมลลงท้าย @kacha.local" (บัญชีพนักงานอัตโนมัติ) เท่านั้น
--   - บัญชี admin/HR พิเศษ (อีเมลจริง ไม่ใช่ @kacha.local) ที่บังเอิญผูก employee_id นี้
--     → ไม่ลบ · แค่ตัดลิงก์ employee_id (กัน dangling reference) แต่คงบัญชีไว้
--   - target อีเมลคำนวณจาก {id}@kacha.local เสมอ → ลบ "ของพนักงานคนนั้นจริงๆ" ไม่ลบมั่ว
--   - กันลบบัญชี login ของผู้เรียกเอง (กัน self-lockout กลางคัน)
--
-- ⚠️ รันใน Supabase SQL Editor ของโปรเจกต์ kacha → xvulimfftkoiybvqdjqz เท่านั้น
--    (org เดียวกันมี safari-world-hr ด้วย — เช็ค URL ก่อนรัน)
-- idempotent — รันซ้ำได้
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.delete_employee_full(p_employee_id TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_id            TEXT := btrim(p_employee_id);
  v_email         TEXT;
  v_emp_exists    BOOLEAN;
  v_caller        UUID := auth.uid();
  v_login_deleted INT  := 0;
  v_protected     INT  := 0;
  r RECORD;
BEGIN
  -- สิทธิ์: admin/HR เท่านั้น (เช็ค user ที่เรียก ไม่ใช่ owner ของ function)
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'ต้องเป็น admin หรือ HR เท่านั้น';
  END IF;

  IF v_id IS NULL OR v_id = '' THEN
    RAISE EXCEPTION 'รหัสพนักงานห้ามว่าง';
  END IF;

  v_email      := lower(v_id) || '@kacha.local';
  v_emp_exists := EXISTS (SELECT 1 FROM public.employees WHERE id = v_id);

  -- ── 1) เคลียร์บัญชี login ที่เกี่ยวกับพนักงานคนนี้ ──
  -- หาได้ 2 ทาง: (ก) อีเมล = {id}@kacha.local   (ข) user_profiles.employee_id = id
  -- ปกติทั้งสองทางชี้ uid เดียวกัน · DISTINCT รวมให้เหลือรายการเดียว
  FOR r IN
    SELECT DISTINCT u.id AS uid, lower(u.email) AS email
    FROM auth.users u
    WHERE lower(u.email) = v_email
       OR u.id IN (SELECT user_id FROM public.user_profiles WHERE employee_id = v_id)
  LOOP
    IF r.email LIKE '%@kacha.local' THEN
      -- บัญชีพนักงานอัตโนมัติ → ลบทั้งหมด (identities → user_profiles → auth.users)
      -- กัน self-lockout: ห้ามลบบัญชี login ของผู้เรียกเอง (rollback ทั้งทรานแซกชัน)
      IF r.uid = v_caller THEN
        RAISE EXCEPTION 'ไม่สามารถลบพนักงานที่ผูกกับบัญชี login ของคุณเองได้ (กันล็อกตัวเอง)';
      END IF;
      -- identities (best-effort — โครงสร้าง auth ต่างเวอร์ชันกันพังได้)
      BEGIN
        DELETE FROM auth.identities WHERE user_id = r.uid;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'ข้าม auth.identities delete (%): %', r.uid, SQLERRM;
      END;
      DELETE FROM public.user_profiles WHERE user_id = r.uid;
      DELETE FROM auth.users          WHERE id      = r.uid;
      v_login_deleted := v_login_deleted + 1;
    ELSE
      -- บัญชี admin/HR พิเศษ (อีเมลจริง ไม่ใช่ @kacha.local) → ไม่ลบ
      -- แค่ตัดลิงก์ employee_id ที่กำลังจะกลายเป็น dangling (กัน orphan link)
      UPDATE public.user_profiles SET employee_id = NULL
        WHERE user_id = r.uid AND employee_id = v_id;
      v_protected := v_protected + 1;
    END IF;
  END LOOP;

  -- ── 2) ลบแถวพนักงาน — cascade ไปทุกตารางลูก (FK ON DELETE CASCADE) อัตโนมัติ ──
  IF v_emp_exists THEN
    DELETE FROM public.employees WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object(
    'employee_id',      v_id,
    'employee_deleted', v_emp_exists,
    'login_deleted',    v_login_deleted,   -- จำนวนบัญชี @kacha.local ที่ลบ (ปกติ 0 หรือ 1)
    'protected_kept',   v_protected        -- จำนวนบัญชีอีเมลจริงที่ "ไม่ลบ" แค่ตัดลิงก์
  );
END $$;

GRANT EXECUTE ON FUNCTION public.delete_employee_full(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ════════ ทดสอบ (ไม่บังคับ — ใส่รหัสจริงเอง) ════════
-- SELECT public.delete_employee_full('TESTID');
-- ตรวจหลังลบ — ทั้ง 3 ควรว่างหมด:
--   SELECT id          FROM public.employees     WHERE id          = 'TESTID';
--   SELECT email       FROM auth.users           WHERE lower(email)= 'testid@kacha.local';
--   SELECT employee_id FROM public.user_profiles WHERE employee_id = 'TESTID';
