-- ═══════════════════════════════════════════════════════════
-- เปลี่ยนรหัสพนักงาน (Primary Key) ได้อย่างปลอดภัย — สำหรับ admin/HR
--
-- ปัญหา: employees.id เป็น PK ที่ตารางอื่นอ้างถึง (FK เป็น ON DELETE CASCADE
--   แต่ "ไม่มี ON UPDATE CASCADE") → UPDATE id ตรงๆ จะ error เพราะมีข้อมูลลูกอ้างอยู่
--   + บัญชี login ใช้ email = {id}@kacha.local → ต้องอัปเดต auth ด้วยไม่งั้น login ไม่ได้
--
-- วิธีแก้ (รัน 2 STEP นี้ครั้งเดียว):
--   STEP 1 — เพิ่ม ON UPDATE CASCADE ให้ "ทุก FK ที่อ้าง employees(id)" อัตโนมัติ
--   STEP 2 — RPC rename_employee_id(old,new): เปลี่ยน id (cascade) +
--            user_profiles.employee_id + auth.users email + auth.identities
--
-- ⚠️ รันใน Supabase SQL Editor ของโปรเจกต์ kacha → xvulimfftkoiybvqdjqz เท่านั้น
--    (เช็ค URL ก่อน — org เดียวกันมี safari-world-hr ด้วย)
-- ═══════════════════════════════════════════════════════════


-- ════════ STEP 1: เพิ่ม ON UPDATE CASCADE ให้ทุก FK ที่อ้าง public.employees(id) ════════
-- ทำแบบ dynamic — ครอบทุกตารางอัตโนมัติ (รวมตารางที่เพิ่มในอนาคต ถ้ารันซ้ำ)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname,
           nsp.nspname              AS schema_name,
           rel.relname              AS table_name,
           pg_get_constraintdef(con.oid) AS def,
           con.confupdtype
    FROM pg_constraint con
    JOIN pg_class     rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE con.contype  = 'f'
      AND con.confrelid = 'public.employees'::regclass
  LOOP
    -- confupdtype: a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT
    -- ข้ามตัวที่เป็น ON UPDATE CASCADE อยู่แล้ว
    CONTINUE WHEN r.confupdtype = 'c';
    -- def เดิม เช่น 'FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE'
    -- (ON UPDATE NO ACTION เป็น default จึงไม่อยู่ใน def) → ต่อ ON UPDATE CASCADE เข้าไปได้เลย
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.schema_name, r.table_name, r.conname);
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s ON UPDATE CASCADE',
                   r.schema_name, r.table_name, r.conname, r.def);
    RAISE NOTICE '✓ ON UPDATE CASCADE: %.% (%)', r.schema_name, r.table_name, r.conname;
  END LOOP;
END $$;


-- ════════ STEP 2: RPC เปลี่ยนรหัสพนักงาน ════════
CREATE OR REPLACE FUNCTION public.rename_employee_id(p_old TEXT, p_new TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_old        TEXT := btrim(p_old);
  v_new        TEXT := btrim(p_new);
  v_old_email  TEXT;
  v_new_email  TEXT;
  v_uid        UUID;
  v_login_updated BOOLEAN := false;
BEGIN
  -- สิทธิ์: admin/HR เท่านั้น (เช็ค user ที่เรียก ไม่ใช่ owner ของ function)
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'ต้องเป็น admin หรือ HR เท่านั้น';
  END IF;

  IF v_old IS NULL OR v_old = '' OR v_new IS NULL OR v_new = '' THEN
    RAISE EXCEPTION 'รหัสเก่า/ใหม่ ห้ามว่าง';
  END IF;
  IF v_old = v_new THEN
    RAISE EXCEPTION 'รหัสใหม่เหมือนเดิม';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = v_old) THEN
    RAISE EXCEPTION 'ไม่พบพนักงานรหัส %', v_old;
  END IF;
  IF EXISTS (SELECT 1 FROM public.employees WHERE id = v_new) THEN
    RAISE EXCEPTION 'รหัสใหม่ % ซ้ำกับพนักงานที่มีอยู่แล้ว', v_new;
  END IF;

  -- 1) เปลี่ยน PK — cascade ไปทุก FK (จาก STEP 1) อัตโนมัติ
  UPDATE public.employees SET id = v_new WHERE id = v_old;

  -- 2) user_profiles.employee_id เป็น loose column (ไม่มี FK) → อัปเดตเอง
  UPDATE public.user_profiles SET employee_id = v_new WHERE employee_id = v_old;

  -- 3) บัญชี login: email = {id}@kacha.local → อัปเดต auth ถ้ามีบัญชีอยู่
  v_old_email := lower(v_old) || '@kacha.local';
  v_new_email := lower(v_new) || '@kacha.local';
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = v_old_email LIMIT 1;
  IF v_uid IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = v_new_email AND id <> v_uid) THEN
      RAISE EXCEPTION 'อีเมล login % มีบัญชีอื่นใช้แล้ว', v_new_email;
    END IF;
    UPDATE auth.users SET email = v_new_email WHERE id = v_uid;
    -- auth.identities (best-effort — กันพังถ้าโครงสร้าง auth ต่างเวอร์ชัน)
    BEGIN
      UPDATE auth.identities
         SET identity_data = jsonb_set(COALESCE(identity_data, '{}'::jsonb), '{email}', to_jsonb(v_new_email), true),
             provider_id   = CASE WHEN provider_id = v_old_email THEN v_new_email ELSE provider_id END
       WHERE user_id = v_uid AND provider = 'email';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ข้าม auth.identities update: %', SQLERRM;
    END;
    v_login_updated := true;
  END IF;

  RETURN jsonb_build_object('old', v_old, 'new', v_new, 'login_updated', v_login_updated);
END $$;

GRANT EXECUTE ON FUNCTION public.rename_employee_id(TEXT, TEXT) TO authenticated;

-- ════════ ทดสอบ (ไม่บังคับ) ════════
-- SELECT public.rename_employee_id('5468-B', '5468');
-- ตรวจหลังเปลี่ยน:
--   SELECT id FROM public.employees WHERE id IN ('5468','5468-B');
--   SELECT employee_id FROM public.user_profiles WHERE employee_id = '5468';
--   SELECT email FROM auth.users WHERE email = '5468@kacha.local';
