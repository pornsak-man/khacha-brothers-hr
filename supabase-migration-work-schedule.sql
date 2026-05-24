-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Work Schedule (ตารางงานพนักงาน)
-- รายสัปดาห์ · หลายสาขา · หลายกะ · มีขออนุมัติ
--
-- โครงสร้าง 3 ตาราง:
--   1. shifts            — กะตั้งต้น (กะเช้า / บ่าย / ดึก / OFF ฯลฯ) — HR CRUD ได้
--   2. schedule_weeks    — ตารางงาน 1 สาขา × 1 สัปดาห์ = 1 แถว (มีสถานะ + ผู้อนุมัติ)
--   3. schedule_entries  — รายการพนักงาน × วัน × กะ (cell ในตาราง)
--
-- Workflow:
--   draft → submitted → approved (HR/admin) | rejected → กลับมา draft
--   HR/admin override ได้ทุกขั้นตอน (ตามนโยบายทั่วไปของระบบ)
--
-- รันใน Supabase SQL Editor ครั้งเดียว — idempotent (รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ─── 1. SHIFTS (มาสเตอร์กะตั้งต้น) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.shifts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code            TEXT NOT NULL UNIQUE,              -- 'M','A','N','OFF','OFFICE' (ขึ้นใน cell แบบสั้น)
  name            TEXT NOT NULL,                     -- 'กะเช้า','กะบ่าย','กะดึก','วันหยุด','สำนักงาน'
  start_time      TIME,                              -- NULL = กะที่ไม่มีเวลา (เช่น OFF)
  end_time        TIME,
  break_minutes   INTEGER NOT NULL DEFAULT 0,        -- พักกี่นาที (หักออกจากชั่วโมงรวม)
  color           TEXT NOT NULL DEFAULT '#2563eb',   -- สี badge ใน UI
  is_off_day      BOOLEAN NOT NULL DEFAULT false,    -- true = วันหยุด (ไม่นับชั่วโมงทำงาน)
  employee_types  JSONB NOT NULL DEFAULT '[]'::jsonb,-- ['fulltime','parttime','office'] (ว่าง = ใช้ได้ทุกประเภท)
  branch_id       TEXT REFERENCES public.branches(id) ON DELETE CASCADE, -- NULL = ใช้ได้ทุกสาขา
  active          BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 100,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shifts_active  ON public.shifts(active);
CREATE INDEX IF NOT EXISTS idx_shifts_branch  ON public.shifts(branch_id);
CREATE INDEX IF NOT EXISTS idx_shifts_sort    ON public.shifts(sort_order, code);

-- ─── 2. SCHEDULE_WEEKS (1 สาขา × 1 สัปดาห์) ─────────────────
CREATE TABLE IF NOT EXISTS public.schedule_weeks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id       TEXT NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  week_start      DATE NOT NULL,                     -- วันจันทร์ของสัปดาห์ (ISO week start)
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_by    UUID,                              -- user_id ของผู้ส่งขออนุมัติ
  submitted_at    TIMESTAMPTZ,
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  approver_note   TEXT,
  rejected_at     TIMESTAMPTZ,
  reject_reason   TEXT,
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_sched_weeks_branch ON public.schedule_weeks(branch_id);
CREATE INDEX IF NOT EXISTS idx_sched_weeks_status ON public.schedule_weeks(status);
CREATE INDEX IF NOT EXISTS idx_sched_weeks_week   ON public.schedule_weeks(week_start);

-- ─── 3. SCHEDULE_ENTRIES (cell ใน grid) ─────────────────────
CREATE TABLE IF NOT EXISTS public.schedule_entries (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_week_id  UUID NOT NULL REFERENCES public.schedule_weeks(id) ON DELETE CASCADE,
  employee_id       TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  work_date         DATE NOT NULL,
  shift_id          UUID REFERENCES public.shifts(id) ON DELETE SET NULL, -- NULL = ยังไม่กำหนด (placeholder row)
  branch_id         TEXT REFERENCES public.branches(id) ON DELETE SET NULL, -- สาขาที่ทำงานวันนั้น (อาจไม่ตรงกับ employee.branch กรณีข้ามสาขา)
  is_cross_branch   BOOLEAN NOT NULL DEFAULT false,  -- true = พนักงานข้ามสาขามาช่วย
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_week_id, employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_sched_entries_week  ON public.schedule_entries(schedule_week_id);
CREATE INDEX IF NOT EXISTS idx_sched_entries_emp   ON public.schedule_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_sched_entries_date  ON public.schedule_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_sched_entries_shift ON public.schedule_entries(shift_id);

-- ─── RLS ────────────────────────────────────────────────────
ALTER TABLE public.shifts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_weeks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_entries  ENABLE ROW LEVEL SECURITY;

-- shifts: ทุกคนที่ login เห็นได้ (ต้องใช้ render UI), เขียนได้เฉพาะ HR/admin
DROP POLICY IF EXISTS "shifts_read_all"     ON public.shifts;
DROP POLICY IF EXISTS "shifts_write_hr"     ON public.shifts;
CREATE POLICY "shifts_read_all" ON public.shifts FOR SELECT TO authenticated USING (true);
CREATE POLICY "shifts_write_hr" ON public.shifts FOR ALL TO authenticated
  USING (public.is_admin() OR EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = auth.uid() AND role IN ('admin','hr')))
  WITH CHECK (public.is_admin() OR EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = auth.uid() AND role IN ('admin','hr')));

-- schedule_weeks:
--   READ: admin/hr ดูได้ทุกสาขา, manager/staff ดูเฉพาะสาขาที่ตัวเองอยู่ (เห็นเฉพาะของพนักงานในตัวเอง)
--   WRITE: admin/hr/branch_manager/area_manager (manager เฉพาะสาขาตัวเอง — JS เป็นด่านที่สอง)
DROP POLICY IF EXISTS "sched_weeks_read"  ON public.schedule_weeks;
DROP POLICY IF EXISTS "sched_weeks_write" ON public.schedule_weeks;
CREATE POLICY "sched_weeks_read" ON public.schedule_weeks FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = auth.uid() AND role IN ('admin','hr','operation_manager'))
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      JOIN public.employees e ON e.id = up.employee_id
      WHERE up.user_id = auth.uid() AND e.branch = schedule_weeks.branch_id
    )
    -- branch_staff: เห็นเฉพาะของสาขาตัวเอง (เพื่อดูตารางตัวเอง)
  );
CREATE POLICY "sched_weeks_write" ON public.schedule_weeks FOR ALL TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = auth.uid() AND role IN ('admin','hr','operation_manager'))
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      JOIN public.employees e ON e.id = up.employee_id
      WHERE up.user_id = auth.uid()
        AND up.role IN ('branch_manager','area_manager')
        AND e.branch = schedule_weeks.branch_id
    )
  )
  WITH CHECK (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = auth.uid() AND role IN ('admin','hr','operation_manager'))
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      JOIN public.employees e ON e.id = up.employee_id
      WHERE up.user_id = auth.uid()
        AND up.role IN ('branch_manager','area_manager')
        AND e.branch = schedule_weeks.branch_id
    )
  );

-- schedule_entries: เหมือน schedule_weeks แต่ join ผ่าน week_id เพื่อตรวจสาขา
DROP POLICY IF EXISTS "sched_entries_read"  ON public.schedule_entries;
DROP POLICY IF EXISTS "sched_entries_write" ON public.schedule_entries;
CREATE POLICY "sched_entries_read" ON public.schedule_entries FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = auth.uid() AND role IN ('admin','hr','operation_manager'))
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      JOIN public.employees e ON e.id = up.employee_id
      JOIN public.schedule_weeks sw ON sw.id = schedule_entries.schedule_week_id
      WHERE up.user_id = auth.uid() AND e.branch = sw.branch_id
    )
    -- พนักงานเห็นแถวของตัวเองได้ (เพื่อดูตารางตัวเองข้ามสาขา ฯลฯ)
    OR employee_id IN (SELECT employee_id FROM public.user_profiles WHERE user_id = auth.uid())
  );
CREATE POLICY "sched_entries_write" ON public.schedule_entries FOR ALL TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = auth.uid() AND role IN ('admin','hr','operation_manager'))
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      JOIN public.employees e ON e.id = up.employee_id
      JOIN public.schedule_weeks sw ON sw.id = schedule_entries.schedule_week_id
      WHERE up.user_id = auth.uid()
        AND up.role IN ('branch_manager','area_manager')
        AND e.branch = sw.branch_id
    )
  )
  WITH CHECK (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.user_profiles WHERE user_id = auth.uid() AND role IN ('admin','hr','operation_manager'))
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      JOIN public.employees e ON e.id = up.employee_id
      JOIN public.schedule_weeks sw ON sw.id = schedule_entries.schedule_week_id
      WHERE up.user_id = auth.uid()
        AND up.role IN ('branch_manager','area_manager')
        AND e.branch = sw.branch_id
    )
  );

-- ─── Auto-update updated_at ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_schedule_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_shifts_updated_at ON public.shifts;
CREATE TRIGGER trg_shifts_updated_at BEFORE UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.set_schedule_updated_at();

DROP TRIGGER IF EXISTS trg_sched_weeks_updated_at ON public.schedule_weeks;
CREATE TRIGGER trg_sched_weeks_updated_at BEFORE UPDATE ON public.schedule_weeks
  FOR EACH ROW EXECUTE FUNCTION public.set_schedule_updated_at();

DROP TRIGGER IF EXISTS trg_sched_entries_updated_at ON public.schedule_entries;
CREATE TRIGGER trg_sched_entries_updated_at BEFORE UPDATE ON public.schedule_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_schedule_updated_at();

-- ─── Realtime publication ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='shifts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.shifts;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='schedule_weeks') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.schedule_weeks;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='schedule_entries') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.schedule_entries;
  END IF;
END $$;

-- ─── Audit trigger (ถ้ามี audit-log migration แล้ว) ─────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='audit_trigger_fn' AND pronamespace='public'::regnamespace) THEN
    DROP TRIGGER IF EXISTS audit_trigger ON public.shifts;
    CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.shifts
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();
    DROP TRIGGER IF EXISTS audit_trigger ON public.schedule_weeks;
    CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.schedule_weeks
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();
    DROP TRIGGER IF EXISTS audit_trigger ON public.schedule_entries;
    CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.schedule_entries
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();
  END IF;
END $$;

-- ─── SEED กะตั้งต้น (เฉพาะตอนตารางว่าง — ON CONFLICT DO NOTHING) ───
INSERT INTO public.shifts (code, name, start_time, end_time, break_minutes, color, is_off_day, employee_types, sort_order, note)
VALUES
  ('M',      'กะเช้า',     '09:00', '18:00', 60, '#2563eb', false, '["fulltime","parttime"]'::jsonb, 10, '9 ชม. — พัก 1 ชม.'),
  ('A',      'กะบ่าย',     '12:00', '21:00', 60, '#f59e0b', false, '["fulltime","parttime"]'::jsonb, 20, '9 ชม. — พัก 1 ชม.'),
  ('N',      'กะดึก',      '16:00', '24:00', 30, '#7c3aed', false, '["fulltime","parttime"]'::jsonb, 30, '8 ชม. — พัก 30 นาที'),
  ('PT4',    'PT 4 ชม.',  '17:00', '21:00',  0, '#06b6d4', false, '["parttime"]'::jsonb,            40, 'พาร์ทไทม์ช่วงเย็น'),
  ('OFFICE', 'สำนักงาน',  '08:30', '17:30', 60, '#16a34a', false, '["office","fulltime"]'::jsonb,   50, 'เวลาราชการ'),
  ('OFF',    'วันหยุด',   NULL,    NULL,     0, '#94a3b8', true,  '[]'::jsonb,                       90, 'OFF — ไม่นับเป็นชั่วโมงงาน')
ON CONFLICT (code) DO NOTHING;

NOTIFY pgrst, 'reload schema';
