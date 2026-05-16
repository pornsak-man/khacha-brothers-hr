-- ═══════════════════════════════════════════════════════════
-- KHACHA BROTHERS HR — Supabase Schema
-- รันสคริปต์นี้ใน Supabase SQL Editor ทั้งหมดในครั้งเดียว
-- ปลอดภัย: ใช้ IF NOT EXISTS / DROP IF EXISTS — รันซ้ำได้
-- ═══════════════════════════════════════════════════════════

-- ─── EXTENSIONS ───
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ═══════════════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════════════

-- ── ฝ่าย / แผนก ──
CREATE TABLE IF NOT EXISTS public.departments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  manager_id  TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── ระดับตำแหน่ง ──
CREATE TABLE IF NOT EXISTS public.position_levels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  min_salary  NUMERIC(12,2) DEFAULT 0,
  max_salary  NUMERIC(12,2) DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── พนักงาน ──
CREATE TABLE IF NOT EXISTS public.employees (
  id                  TEXT PRIMARY KEY,
  title               TEXT,
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  nickname            TEXT,
  national_id         TEXT,
  dob                 DATE,
  gender              TEXT,
  nationality         TEXT DEFAULT 'ไทย',
  religion            TEXT,
  education           TEXT,
  phone               TEXT,
  email               TEXT,
  address             TEXT,
  department          TEXT REFERENCES public.departments(id) ON DELETE SET NULL,
  branch              TEXT,
  position            TEXT REFERENCES public.position_levels(id) ON DELETE SET NULL,
  position_title      TEXT,
  employee_type       TEXT,
  hire_date           DATE,
  salary              NUMERIC(12,2) DEFAULT 0,
  allowance_position  NUMERIC(12,2) DEFAULT 0,
  allowance_travel    NUMERIC(12,2) DEFAULT 0,
  allowance_food      NUMERIC(12,2) DEFAULT 0,
  allowance_per_diem  NUMERIC(12,2) DEFAULT 0,
  allowance_language  NUMERIC(12,2) DEFAULT 0,
  allowance_other     NUMERIC(12,2) DEFAULT 0,
  bank                TEXT,
  bank_account        TEXT,
  status              TEXT DEFAULT 'active',
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employees_department ON public.employees(department);
CREATE INDEX IF NOT EXISTS idx_employees_status ON public.employees(status);
CREATE INDEX IF NOT EXISTS idx_employees_name ON public.employees(first_name, last_name);

-- เพิ่ม FK department.manager → employees (ต้องสร้างหลัง employees)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'departments_manager_fk'
  ) THEN
    ALTER TABLE public.departments
    ADD CONSTRAINT departments_manager_fk
    FOREIGN KEY (manager_id) REFERENCES public.employees(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── ประวัติเงินเดือน ──
CREATE TABLE IF NOT EXISTS public.salary_history (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id         TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date                DATE NOT NULL,
  old_salary          NUMERIC(12,2),
  new_salary          NUMERIC(12,2),
  new_position        TEXT,
  new_position_title  TEXT,
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_salary_history_employee ON public.salary_history(employee_id, date DESC);

-- ── การกู้เงิน ──
CREATE TABLE IF NOT EXISTS public.loans (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id      TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  amount           NUMERIC(12,2) NOT NULL,
  monthly_payment  NUMERIC(12,2) DEFAULT 0,
  remaining        NUMERIC(12,2) DEFAULT 0,
  status           TEXT DEFAULT 'active',
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loans_employee ON public.loans(employee_id);

-- ── เบิกล่วงหน้า ──
CREATE TABLE IF NOT EXISTS public.advances (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id  TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  amount       NUMERIC(12,2) NOT NULL,
  reason       TEXT,
  status       TEXT DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advances_employee ON public.advances(employee_id);

-- ── เบี้ยเลี้ยงรายเดือน ──
CREATE TABLE IF NOT EXISTS public.allowances (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id  TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,
  type         TEXT,
  amount       NUMERIC(12,2) NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allowances_employee_month ON public.allowances(employee_id, month);

-- ── ประเมินผล ──
CREATE TABLE IF NOT EXISTS public.evaluations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id  TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  period       TEXT,
  score        INTEGER CHECK (score >= 0 AND score <= 100),
  grade        TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evaluations_employee ON public.evaluations(employee_id, date DESC);

-- ── ปฏิทิน HR ──
CREATE TABLE IF NOT EXISTS public.calendar_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date        DATE NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'holiday',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_date ON public.calendar_items(date);

-- ── ข้อมูลบริษัท (เก็บแค่ row เดียว) ──
CREATE TABLE IF NOT EXISTS public.company_settings (
  id        INTEGER PRIMARY KEY DEFAULT 1,
  name      TEXT,
  name_en   TEXT,
  tax_id    TEXT,
  address   TEXT,
  phone     TEXT,
  email     TEXT,
  CONSTRAINT singleton CHECK (id = 1)
);

-- ── User profiles (เชื่อมกับ Supabase Auth) ──
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT,
  role         TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  employee_id  TEXT REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════
-- HELPER: ตรวจสอบ role
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

-- Auto-create user profile เมื่อมี user signup ใหม่ (default role = viewer)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    'viewer'
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ═══════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════
ALTER TABLE public.departments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.position_levels   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loans             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advances          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allowances        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evaluations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles     ENABLE ROW LEVEL SECURITY;

-- Helper: drop all existing policies on a table (idempotent re-run)
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('departments','position_levels','employees','salary_history',
                        'loans','advances','allowances','evaluations','calendar_items',
                        'company_settings','user_profiles')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- Pattern: authenticated users สามารถอ่านได้ทั้งหมด, admin เท่านั้นที่ insert/update/delete
-- (Phase 1 — ง่ายและปลอดภัย เพิ่ม granularity ภายหลังได้)

-- departments
CREATE POLICY "read_authenticated" ON public.departments FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.departments FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- position_levels
CREATE POLICY "read_authenticated" ON public.position_levels FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.position_levels FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- employees
CREATE POLICY "read_authenticated" ON public.employees FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.employees FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- salary_history
CREATE POLICY "read_authenticated" ON public.salary_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.salary_history FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- loans
CREATE POLICY "read_authenticated" ON public.loans FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.loans FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- advances
CREATE POLICY "read_authenticated" ON public.advances FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.advances FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- allowances
CREATE POLICY "read_authenticated" ON public.allowances FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.allowances FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- evaluations
CREATE POLICY "read_authenticated" ON public.evaluations FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.evaluations FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- calendar_items
CREATE POLICY "read_authenticated" ON public.calendar_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.calendar_items FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- company_settings
CREATE POLICY "read_authenticated" ON public.company_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin" ON public.company_settings FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- user_profiles
-- ผู้ใช้เห็น profile ของตัวเองได้, admin เห็นทุกคน, admin แก้ role คนอื่นได้
CREATE POLICY "read_own_or_admin" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "update_own" ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (
    user_id = auth.uid() OR public.is_admin()
  );

CREATE POLICY "insert_admin_only" ON public.user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "delete_admin_only" ON public.user_profiles
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ═══════════════════════════════════════════════════════════
-- SEED DATA (เฉพาะถ้าตารางว่าง)
-- ═══════════════════════════════════════════════════════════

-- ── ข้อมูลบริษัท ──
INSERT INTO public.company_settings (id, name, name_en)
VALUES (1, 'บริษัท คชา บราเธอร์ส จำกัด', 'Khacha Brothers Co., Ltd.')
ON CONFLICT (id) DO NOTHING;

-- ── ฝ่าย ──
INSERT INTO public.departments (id, name) VALUES
  ('D001', 'ฝ่ายบริหาร'),
  ('D002', 'ฝ่ายบุคคล'),
  ('D003', 'ฝ่ายบัญชี-การเงิน'),
  ('D004', 'ฝ่ายขาย-การตลาด'),
  ('D005', 'ฝ่ายปฏิบัติการ')
ON CONFLICT (id) DO NOTHING;

-- ── ระดับตำแหน่ง ──
INSERT INTO public.position_levels (id, name, min_salary, max_salary) VALUES
  ('P01', 'พนักงาน', 12000, 20000),
  ('P02', 'พนักงานอาวุโส', 18000, 28000),
  ('P03', 'หัวหน้าทีม', 25000, 40000),
  ('P04', 'ผู้จัดการ', 35000, 60000),
  ('P05', 'ผู้อำนวยการ', 55000, 120000)
ON CONFLICT (id) DO NOTHING;

-- ── พนักงานตัวอย่าง ──
INSERT INTO public.employees
  (id, title, first_name, last_name, nickname, national_id, dob, gender, phone, email, address, department, position, position_title, hire_date, salary, status) VALUES
  ('KB0001', 'นาย', 'สมชาย', 'ใจดี', 'ชาย', '1234567890123', '1990-05-15', 'ชาย', '081-234-5678', 'somchai@khacha.co.th', '123 ถ.สุขุมวิท กรุงเทพฯ 10110', 'D001', 'P05', 'ประธานเจ้าหน้าที่บริหาร', '2020-01-15', 80000, 'active'),
  ('KB0002', 'นางสาว', 'สุดา', 'รักงาน', 'ดา', '1234567890124', '1992-08-22', 'หญิง', '082-345-6789', 'suda@khacha.co.th', '456 ถ.พระราม 9 กรุงเทพฯ 10310', 'D002', 'P04', 'ผู้จัดการฝ่ายบุคคล', '2021-03-01', 45000, 'active'),
  ('KB0003', 'นาย', 'วิชัย', 'มั่นคง', 'ชัย', '1234567890125', '1988-11-10', 'ชาย', '083-456-7890', 'wichai@khacha.co.th', '789 ถ.รัชดาภิเษก กรุงเทพฯ 10400', 'D003', 'P04', 'ผู้จัดการฝ่ายบัญชี', '2020-06-15', 48000, 'active'),
  ('KB0004', 'นางสาว', 'พิมพ์ใจ', 'อ่อนหวาน', 'พิม', '1234567890126', '1995-02-18', 'หญิง', '084-567-8901', 'pim@khacha.co.th', '321 ถ.ลาดพร้าว กรุงเทพฯ 10230', 'D004', 'P03', 'หัวหน้าทีมการตลาด', '2022-04-10', 32000, 'active'),
  ('KB0005', 'นาย', 'ประยุทธ', 'ขยัน', 'ยุทธ', '1234567890127', '1993-07-05', 'ชาย', '085-678-9012', 'prayut@khacha.co.th', '654 ถ.พหลโยธิน กรุงเทพฯ 10900', 'D005', 'P02', 'ช่างเทคนิคอาวุโส', '2021-09-20', 25000, 'active'),
  ('KB0006', 'นางสาว', 'มาลี', 'สดใส', 'มา', '1234567890128', '1997-12-30', 'หญิง', '086-789-0123', 'malee@khacha.co.th', '987 ถ.วิภาวดี กรุงเทพฯ 10900', 'D002', 'P01', 'เจ้าหน้าที่บุคคล', '2023-06-01', 18000, 'active'),
  ('KB0007', 'นาย', 'อนุชา', 'สู้ชีวิต', 'อนุ', '1234567890129', '1991-04-12', 'ชาย', '087-890-1234', 'anucha@khacha.co.th', '147 ถ.รามคำแหง กรุงเทพฯ 10240', 'D004', 'P02', 'พนักงานขายอาวุโส', '2022-01-15', 24000, 'active'),
  ('KB0008', 'นางสาว', 'รัตนา', 'งดงาม', 'รัตน์', '1234567890130', '1996-09-25', 'หญิง', '088-901-2345', 'rattana@khacha.co.th', '258 ถ.บางนา กรุงเทพฯ 10260', 'D003', 'P01', 'เจ้าหน้าที่บัญชี', '2023-10-01', 17500, 'active')
ON CONFLICT (id) DO NOTHING;

-- ── ปฏิทินวันหยุด 2026 ──
INSERT INTO public.calendar_items (date, title, type) VALUES
  ('2026-01-01', 'วันขึ้นปีใหม่', 'holiday'),
  ('2026-04-13', 'วันสงกรานต์', 'holiday'),
  ('2026-04-14', 'วันสงกรานต์', 'holiday'),
  ('2026-04-15', 'วันสงกรานต์', 'holiday'),
  ('2026-05-01', 'วันแรงงานแห่งชาติ', 'holiday'),
  ('2026-12-05', 'วันคล้ายวันพระบรมราชสมภพ ร.๙', 'holiday'),
  ('2026-12-10', 'วันรัฐธรรมนูญ', 'holiday'),
  ('2026-12-31', 'วันสิ้นปี', 'holiday')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- REALTIME (เปิดให้ทุกตาราง broadcast change)
-- ═══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- เพิ่มตารางเข้า publication supabase_realtime (ถ้ายังไม่มี)
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='employees') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.employees;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='departments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.departments;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='position_levels') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.position_levels;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='loans') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.loans;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='advances') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.advances;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='allowances') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.allowances;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='evaluations') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.evaluations;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='salary_history') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.salary_history;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='calendar_items') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.calendar_items;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════
-- ขั้นตอนถัดไป:
-- 1. ไป Authentication → Users → "+ Add user" → กรอก email + password ของคุณ
-- 2. กลับมาที่ SQL Editor รัน 1 บรรทัดเพื่อเลื่อน role เป็น admin:
--      UPDATE public.user_profiles SET role = 'admin' WHERE user_id = (SELECT id FROM auth.users WHERE email = 'YOUR_EMAIL@example.com');
-- 3. เสร็จ — login เข้าเว็บได้ทุกเครื่อง พร้อม realtime sync
