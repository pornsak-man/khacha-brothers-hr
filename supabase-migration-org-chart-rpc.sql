-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Org Chart RPC (พนักงานทุกคนเห็นชื่อ+สาขาของกันได้)
--
-- ปัญหา:
--   - RLS ของ employees ให้ staff/viewer เห็นเฉพาะตัวเอง
--   - หน้าตารางงานต้องการชื่อ BM/AM ของสาขา
--   - getScheduleCreators ใช้ DB.getEmployee(bm_id) → undefined → ไม่เจอ → ขึ้น "ยังไม่ตั้ง BM"
--
-- แก้:
--   - สร้าง RPC `get_org_chart_employees()` แบบ SECURITY DEFINER
--   - คืนแค่ public cols: ชื่อ, สาขา, ตำแหน่ง, สถานะ (no salary/ปชช/phone/email)
--   - ทุก authenticated user เรียกได้ → ใช้สำหรับ org chart display
--
-- ปลอดภัย:
--   - SECURITY DEFINER → bypass RLS ของ employees (มีเหตุผล: org chart info เป็น public ในบริษัท)
--   - คืนเฉพาะ non-sensitive cols ที่อนุญาตให้ทุกคนเห็น
--   - ไม่กระทบ employees table RLS (สำหรับ sensitive data ยังคง strict ตามเดิม)
--
-- รันใน Supabase SQL Editor (idempotent)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_org_chart_employees()
RETURNS TABLE(
  id              TEXT,
  first_name      TEXT,
  last_name       TEXT,
  nickname        TEXT,
  title           TEXT,
  branch          TEXT,
  department      TEXT,
  position        TEXT,
  position_title  TEXT,
  status          TEXT,
  photo_url       TEXT,
  hire_date       DATE,
  termination_date DATE,
  employee_type   TEXT,
  gender          TEXT
)
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    e.id,
    e.first_name,
    e.last_name,
    e.nickname,
    e.title,
    e.branch,
    e.department,
    e.position,
    e.position_title,
    e.status,
    e.photo_url,
    e.hire_date,
    e.termination_date,
    e.employee_type,
    e.gender
  FROM public.employees e
  ORDER BY e.id;
$$;

GRANT EXECUTE ON FUNCTION public.get_org_chart_employees() TO authenticated;

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM public.employees;
  RAISE NOTICE '✅ RPC get_org_chart_employees() ติดตั้งแล้ว';
  RAISE NOTICE '   - คืน % rows (พนักงานทุกคน)', v_count;
  RAISE NOTICE '   - cols: id, first_name, last_name, nickname, title, branch, department,';
  RAISE NOTICE '           position, position_title, status, photo_url, hire_date,';
  RAISE NOTICE '           termination_date, employee_type, gender';
  RAISE NOTICE '   - ไม่มี: salary, national_id, phone, email, address, bank, sso, dob, ...';
  RAISE NOTICE '';
  RAISE NOTICE '   ใช้ใน frontend: DB.client.rpc(''get_org_chart_employees'')';
  RAISE NOTICE '   → cache เป็น _orgChartCache + DB.getEmployee() fallback ใช้';
END $$;
