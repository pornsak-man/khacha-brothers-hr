-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Default role 'viewer' → 'branch_staff'
-- 1. แก้ trigger handle_new_user → default role ใหม่ = 'branch_staff'
-- 2. Migrate user_profiles ที่ role='viewer' ทั้งหมด → 'branch_staff'
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ── 1. แก้ trigger ให้ default role = 'branch_staff' ──
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
    'branch_staff',   -- default role ใหม่ (เดิมคือ 'viewer')
    v_emp_id
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END $$;

-- Re-create trigger (กันลำดับเก่าหาย)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 2. Migrate user_profiles ที่ยังเป็น viewer → branch_staff ──
-- (รวม user ที่มี/ไม่มี employee_id link — เปลี่ยนทั้งหมดตามที่ user ขอ)
UPDATE public.user_profiles
SET role = 'branch_staff'
WHERE role = 'viewer';

-- ── 3. แสดงผลการ migrate (จำนวนคนที่ถูกเปลี่ยน) ──
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.user_profiles WHERE role = 'branch_staff';
  RAISE NOTICE 'ตอนนี้มี user_profiles ที่ role = branch_staff รวม % คน', v_count;
END $$;

NOTIFY pgrst, 'reload schema';

-- ─── หมายเหตุ ───
-- • viewer role ยังคงใช้ได้อยู่ — ถ้า admin ต้องการสร้าง user แบบ "อ่านอย่างเดียว" (ไม่เป็นพนักงาน)
--   สามารถเปลี่ยน role เป็น viewer ทีหลังผ่าน UI ได้
-- • Trigger ใหม่จะใส่ default = branch_staff ให้ user ที่ signUp ตั้งแต่นี้เป็นต้นไป
-- ═══════════════════════════════════════════════════════════
