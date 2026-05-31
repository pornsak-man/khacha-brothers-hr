-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — ระบบบันทึกเวลาทำงาน (Time Attendance / สแกนนิ้ว)
--
-- นำเข้าข้อมูลสแกนนิ้ว เข้า-ออกงาน จากเครื่องสแกนหลายรุ่น/หลายฟอร์แมต
-- 1 แถว = 1 คน/วัน (UNIQUE employee_id+work_date → re-import = upsert ทับ)
-- แต่ละวันมีได้ถึง 4 ครั้ง: เข้า · พักออก · พักเข้า · ออก (พักเว้นได้)
--
-- ⚠️ Import/แก้/ลบ = HR/admin เท่านั้น (ผ่าน RPC SECURITY DEFINER)
-- ดู (SELECT) = HR/admin ทุกคน · OM ทุกคน · AM/BM ตามสาขา · พนักงานเห็นของตัวเอง
--
-- ※ ตั้งใจ "ไม่" เปิด realtime ให้ตารางนี้ — bulk import 1000+ แถว จะยิง event
--    ถล่มทุก client; หน้าโหลดข้อมูลรายเดือนสดอยู่แล้ว ไม่ต้องพึ่ง realtime
--
-- รันใน Supabase SQL Editor (idempotent) — โปรเจกต์ kacha = xvulimfftkoiybvqdjqz
-- อิง pattern: supabase-migration-overtime-requests.sql
-- ═══════════════════════════════════════════════════════════

-- ════════ 1. TABLE ════════
CREATE TABLE IF NOT EXISTS public.time_attendance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  employee_name   TEXT,                       -- snapshot ตอน import
  branch_id       TEXT,                       -- snapshot (ใช้ scope RLS)
  work_date       DATE NOT NULL,
  check_in        TIME,                       -- เวลาเข้างาน
  break_out       TIME,                       -- ออกพัก
  break_in        TIME,                       -- กลับจากพัก
  check_out       TIME,                       -- เวลาออกงาน
  work_minutes    INT,                        -- (ออก-เข้า) ข้ามเที่ยงคืน +1440 แล้วหักพัก
  break_minutes   INT DEFAULT 0,              -- (พักเข้า - พักออก)
  punch_count     INT DEFAULT 0,              -- จำนวนครั้งสแกนดิบของวันนั้น
  raw_punches     JSONB,                      -- เวลาดิบทั้งหมด ["08:01","12:00",...] เก็บไว้ audit/จับคู่ใหม่
  is_complete     BOOLEAN DEFAULT FALSE,      -- มีทั้งเข้า + ออก
  anomaly         TEXT,                       -- missing_in|missing_out|no_punch|check_break|many_punches|NULL
  source          TEXT NOT NULL DEFAULT 'import'
                  CHECK (source IN ('import','manual')),
  device_label    TEXT,                       -- ชื่อ/รุ่นเครื่องสแกน (เผื่อหลายเครื่อง)
  note            TEXT,
  import_batch_id UUID,                       -- จัดกลุ่มการ import ครั้งเดียว (ไว้ undo)
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_time_attendance_emp_date UNIQUE (employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_att_employee ON public.time_attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_att_date     ON public.time_attendance(work_date DESC);
CREATE INDEX IF NOT EXISTS idx_att_branch   ON public.time_attendance(branch_id);
CREATE INDEX IF NOT EXISTS idx_att_batch    ON public.time_attendance(import_batch_id);

-- ════════ 2. updated_at trigger ════════
CREATE OR REPLACE FUNCTION public.fn_att_set_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_att_updated_at ON public.time_attendance;
CREATE TRIGGER trg_att_updated_at
  BEFORE UPDATE ON public.time_attendance
  FOR EACH ROW EXECUTE FUNCTION public.fn_att_set_updated_at();

-- ════════ 3. Helper: ใครเห็นบันทึกเวลาของพนักงาน/สาขานี้ได้ ════════
-- มิเรอร์สิทธิ์ดู employees: HR/admin = ทุกคน · OM = ทุกคน · AM/BM = ตามสาขา · เจ้าตัว = ของตัวเอง
CREATE OR REPLACE FUNCTION public.att_can_view(p_employee_id TEXT, p_branch_id TEXT)
RETURNS BOOLEAN LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT; v_branches TEXT[]; v_own_emp TEXT; v_own_branch TEXT;
BEGIN
  IF public.is_hr_or_admin() THEN RETURN TRUE; END IF;
  SELECT up.role, up.managed_branches, up.employee_id, e.branch
    INTO v_role, v_branches, v_own_emp, v_own_branch
  FROM public.user_profiles up
  LEFT JOIN public.employees e ON e.id = up.employee_id
  WHERE up.user_id = auth.uid();
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  -- เจ้าตัวเห็นของตัวเองเสมอ
  IF v_own_emp IS NOT NULL AND v_own_emp = p_employee_id THEN RETURN TRUE; END IF;
  -- OM เห็นทุกคน (เหมือนสิทธิ์ดู loans/advances)
  IF v_role = 'operation_manager' THEN RETURN TRUE; END IF;
  -- AM เห็นเฉพาะสาขาที่ดูแล
  IF v_role = 'area_manager' AND v_branches IS NOT NULL THEN
    RETURN p_branch_id = ANY(v_branches);
  END IF;
  -- BM เห็นสาขาตัวเอง (+ สาขาที่ดูแลถ้ามี)
  IF v_role = 'branch_manager' THEN
    IF v_own_branch IS NOT NULL AND v_own_branch = p_branch_id THEN RETURN TRUE; END IF;
    IF v_branches IS NOT NULL AND p_branch_id = ANY(v_branches) THEN RETURN TRUE; END IF;
  END IF;
  RETURN FALSE;
END $$;
GRANT EXECUTE ON FUNCTION public.att_can_view(TEXT,TEXT) TO authenticated;

-- ════════ 4. RLS ════════
ALTER TABLE public.time_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "att_select" ON public.time_attendance;
CREATE POLICY "att_select" ON public.time_attendance
  FOR SELECT TO authenticated
  USING (public.att_can_view(employee_id, branch_id));

-- INSERT/UPDATE/DELETE ทำผ่าน RPC (SECURITY DEFINER) — policy นี้ defensive (HR/admin เท่านั้น)
DROP POLICY IF EXISTS "att_insert" ON public.time_attendance;
CREATE POLICY "att_insert" ON public.time_attendance
  FOR INSERT TO authenticated
  WITH CHECK (public.is_hr_or_admin());

DROP POLICY IF EXISTS "att_update" ON public.time_attendance;
CREATE POLICY "att_update" ON public.time_attendance
  FOR UPDATE TO authenticated
  USING (public.is_hr_or_admin())
  WITH CHECK (public.is_hr_or_admin());

DROP POLICY IF EXISTS "att_delete" ON public.time_attendance;
CREATE POLICY "att_delete" ON public.time_attendance
  FOR DELETE TO authenticated
  USING (public.is_hr_or_admin());

-- ════════ 5. RPC: นำเข้าแบบ batch (JSONB array — 1 round trip) ════════
-- p_records = [{ employee_id, work_date, check_in, break_out, break_in, check_out,
--               punch_count, raw_punches, device_label, note }, ...]
-- - JOIN employees → ข้ามแถวที่ไม่พบรหัสพนักงานอัตโนมัติ (คืนรายชื่อที่ข้าม)
-- - snapshot ชื่อ + สาขา จาก DB (กัน client ปลอม) · คำนวณ work/break/anomaly ฝั่ง server
-- - upsert ตาม (employee_id, work_date) → re-import วันเดิม = ทับ
CREATE OR REPLACE FUNCTION public.import_time_attendance(
  p_records  JSONB,
  p_batch_id UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_inserted  INT := 0;
  v_updated   INT := 0;
  v_total     INT := 0;
  v_matched   INT := 0;
  v_skipped_ids TEXT[];
BEGIN
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'นำเข้าข้อมูลสแกนนิ้วได้เฉพาะ HR/admin';
  END IF;
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'p_records ต้องเป็น JSON array';
  END IF;

  SELECT count(*) INTO v_total FROM jsonb_array_elements(p_records);

  WITH input AS (
    SELECT
      btrim(r->>'employee_id')                       AS emp_id,
      (r->>'work_date')::date                         AS work_date,
      NULLIF(btrim(r->>'check_in'),'')::time          AS check_in,
      NULLIF(btrim(r->>'break_out'),'')::time         AS break_out,
      NULLIF(btrim(r->>'break_in'),'')::time          AS break_in,
      NULLIF(btrim(r->>'check_out'),'')::time         AS check_out,
      COALESCE((r->>'punch_count')::int, 0)           AS punch_count,
      CASE WHEN jsonb_typeof(r->'raw_punches') = 'array'
           THEN r->'raw_punches' ELSE NULL END        AS raw_punches,
      NULLIF(btrim(r->>'device_label'),'')            AS device_label,
      NULLIF(btrim(r->>'note'),'')                    AS note
    FROM jsonb_array_elements(p_records) AS r
    WHERE (r->>'work_date') IS NOT NULL
      AND btrim(coalesce(r->>'employee_id','')) <> ''
  ),
  matched AS (
    SELECT i.*,
           e.branch AS branch_id,
           btrim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')) AS emp_name
    FROM input i
    JOIN public.employees e ON e.id = i.emp_id
  ),
  calc AS (
    SELECT m.*,
      CASE WHEN m.break_out IS NOT NULL AND m.break_in IS NOT NULL
        THEN GREATEST(0,
          (EXTRACT(EPOCH FROM (m.break_in - m.break_out)) / 60)::int
          + CASE WHEN m.break_in < m.break_out THEN 1440 ELSE 0 END)
        ELSE 0 END AS break_min
    FROM matched m
  ),
  calc2 AS (
    SELECT c.*,
      CASE WHEN c.check_in IS NOT NULL AND c.check_out IS NOT NULL THEN
        ((EXTRACT(EPOCH FROM (c.check_out - c.check_in)) / 60)::int
         + CASE WHEN c.check_out < c.check_in THEN 1440 ELSE 0 END) - c.break_min
      ELSE NULL END AS work_min,
      (c.check_in IS NOT NULL AND c.check_out IS NOT NULL) AS complete,
      CASE
        WHEN c.check_in IS NULL AND c.check_out IS NULL THEN 'no_punch'
        WHEN c.check_in  IS NULL THEN 'missing_in'
        WHEN c.check_out IS NULL THEN 'missing_out'
        WHEN c.punch_count > 4   THEN 'many_punches'
        WHEN c.punch_count = 3   THEN 'check_break'
        ELSE NULL
      END AS anomaly
    FROM calc c
  ),
  ups AS (
    INSERT INTO public.time_attendance AS t
      (employee_id, employee_name, branch_id, work_date,
       check_in, break_out, break_in, check_out,
       work_minutes, break_minutes, punch_count, raw_punches,
       is_complete, anomaly, source, device_label, note, import_batch_id, created_by)
    SELECT
      emp_id, emp_name, branch_id, work_date,
      check_in, break_out, break_in, check_out,
      work_min, break_min, punch_count, raw_punches,
      complete, anomaly, 'import', device_label, note, p_batch_id, v_uid
    FROM calc2
    ON CONFLICT (employee_id, work_date) DO UPDATE SET
      employee_name   = EXCLUDED.employee_name,
      branch_id       = EXCLUDED.branch_id,
      check_in        = EXCLUDED.check_in,
      break_out       = EXCLUDED.break_out,
      break_in        = EXCLUDED.break_in,
      check_out       = EXCLUDED.check_out,
      work_minutes    = EXCLUDED.work_minutes,
      break_minutes   = EXCLUDED.break_minutes,
      punch_count     = EXCLUDED.punch_count,
      raw_punches     = EXCLUDED.raw_punches,
      is_complete     = EXCLUDED.is_complete,
      anomaly         = EXCLUDED.anomaly,
      source          = 'import',
      device_label    = EXCLUDED.device_label,
      note            = COALESCE(EXCLUDED.note, t.note),
      import_batch_id = EXCLUDED.import_batch_id,
      updated_at      = now()
    RETURNING (xmax = 0) AS was_insert
  )
  SELECT
    count(*) FILTER (WHERE was_insert),
    count(*) FILTER (WHERE NOT was_insert),
    count(*)
  INTO v_inserted, v_updated, v_matched
  FROM ups;

  -- รหัสที่ import มาแต่ไม่พบในทะเบียนพนักงาน (distinct)
  SELECT array_agg(DISTINCT emp_id) INTO v_skipped_ids
  FROM (
    SELECT btrim(r->>'employee_id') AS emp_id
    FROM jsonb_array_elements(p_records) AS r
    WHERE btrim(coalesce(r->>'employee_id','')) <> ''
      AND NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = btrim(r->>'employee_id'))
  ) s;

  RETURN jsonb_build_object(
    'total',     v_total,
    'matched',   v_matched,
    'inserted',  v_inserted,
    'updated',   v_updated,
    'skipped',   COALESCE(array_length(v_skipped_ids, 1), 0),
    'skipped_ids', COALESCE(to_jsonb(v_skipped_ids), '[]'::jsonb)
  );
END $$;
GRANT EXECUTE ON FUNCTION public.import_time_attendance(JSONB, UUID) TO authenticated;

-- ════════ 6. RPC: เพิ่ม/แก้ บันทึกเดียว (HR กรอกมือ) ════════
CREATE OR REPLACE FUNCTION public.upsert_time_attendance(
  p_employee_id TEXT,
  p_work_date   DATE,
  p_check_in    TIME DEFAULT NULL,
  p_break_out   TIME DEFAULT NULL,
  p_break_in    TIME DEFAULT NULL,
  p_check_out   TIME DEFAULT NULL,
  p_note        TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_branch TEXT; v_name TEXT;
  v_break  INT; v_work INT; v_cnt INT; v_anom TEXT; v_id UUID;
BEGIN
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'แก้ไขบันทึกเวลาได้เฉพาะ HR/admin';
  END IF;
  IF p_employee_id IS NULL OR p_work_date IS NULL THEN
    RAISE EXCEPTION 'ต้องระบุพนักงาน + วันที่';
  END IF;

  SELECT e.branch, btrim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,''))
    INTO v_branch, v_name
  FROM public.employees e WHERE e.id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบพนักงานรหัส %', p_employee_id; END IF;

  v_break := CASE WHEN p_break_out IS NOT NULL AND p_break_in IS NOT NULL
    THEN GREATEST(0, (EXTRACT(EPOCH FROM (p_break_in - p_break_out)) / 60)::int
      + CASE WHEN p_break_in < p_break_out THEN 1440 ELSE 0 END)
    ELSE 0 END;
  v_work := CASE WHEN p_check_in IS NOT NULL AND p_check_out IS NOT NULL THEN
    ((EXTRACT(EPOCH FROM (p_check_out - p_check_in)) / 60)::int
     + CASE WHEN p_check_out < p_check_in THEN 1440 ELSE 0 END) - v_break
    ELSE NULL END;
  v_cnt := (p_check_in IS NOT NULL)::int + (p_break_out IS NOT NULL)::int
         + (p_break_in IS NOT NULL)::int + (p_check_out IS NOT NULL)::int;
  v_anom := CASE
    WHEN p_check_in IS NULL AND p_check_out IS NULL THEN 'no_punch'
    WHEN p_check_in  IS NULL THEN 'missing_in'
    WHEN p_check_out IS NULL THEN 'missing_out'
    ELSE NULL END;

  INSERT INTO public.time_attendance AS t
    (employee_id, employee_name, branch_id, work_date,
     check_in, break_out, break_in, check_out,
     work_minutes, break_minutes, punch_count, raw_punches,
     is_complete, anomaly, source, note, created_by)
  VALUES
    (p_employee_id, v_name, v_branch, p_work_date,
     p_check_in, p_break_out, p_break_in, p_check_out,
     v_work, v_break, v_cnt, NULL,
     (p_check_in IS NOT NULL AND p_check_out IS NOT NULL), v_anom, 'manual', p_note, v_uid)
  ON CONFLICT (employee_id, work_date) DO UPDATE SET
    employee_name = EXCLUDED.employee_name,
    branch_id     = EXCLUDED.branch_id,
    check_in      = EXCLUDED.check_in,
    break_out     = EXCLUDED.break_out,
    break_in      = EXCLUDED.break_in,
    check_out     = EXCLUDED.check_out,
    work_minutes  = EXCLUDED.work_minutes,
    break_minutes = EXCLUDED.break_minutes,
    punch_count   = EXCLUDED.punch_count,
    is_complete   = EXCLUDED.is_complete,
    anomaly       = EXCLUDED.anomaly,
    source        = 'manual',
    note          = EXCLUDED.note,
    updated_at    = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'work_minutes', v_work);
END $$;
GRANT EXECUTE ON FUNCTION public.upsert_time_attendance(TEXT,DATE,TIME,TIME,TIME,TIME,TEXT) TO authenticated;

-- ════════ 7. RPC: ลบบันทึกเดียว / ยกเลิกทั้ง batch ════════
CREATE OR REPLACE FUNCTION public.delete_time_attendance(p_id UUID)
RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INT;
BEGIN
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'ลบบันทึกเวลาได้เฉพาะ HR/admin';
  END IF;
  DELETE FROM public.time_attendance WHERE id = p_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('deleted', v_n);
END $$;
GRANT EXECUTE ON FUNCTION public.delete_time_attendance(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_time_attendance_batch(p_batch_id UUID)
RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INT;
BEGIN
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'ยกเลิกการนำเข้าได้เฉพาะ HR/admin';
  END IF;
  IF p_batch_id IS NULL THEN RAISE EXCEPTION 'ต้องระบุ batch_id'; END IF;
  DELETE FROM public.time_attendance WHERE import_batch_id = p_batch_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('deleted', v_n);
END $$;
GRANT EXECUTE ON FUNCTION public.delete_time_attendance_batch(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ════════ 8. Verify ════════
SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='time_attendance') AS policies,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('import_time_attendance','upsert_time_attendance','delete_time_attendance',
     'delete_time_attendance_batch','att_can_view','fn_att_set_updated_at')) AS functions,
  '✅ พร้อมใช้ — ต่อไปโค้ด frontend (data.js + app.js + index.html)' AS note;
