-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — RPC: รายชื่อพนักงานทุกสาขา (สำหรับ assign ข้ามสาขา)
--
-- ปัญหา: RLS scope ของ employees ปิดให้ผู้จัดการสาขาเห็นเฉพาะสาขาตัวเอง
--        → ใช้ feature "+ พนักงานข้ามสาขา" ในตารางงานไม่ได้
-- แก้:   สร้าง RPC SECURITY DEFINER ที่เปิดให้ role ระดับ manager+ อ่าน
--        เฉพาะคอลัมน์ที่จำเป็นต่อการ assign (data minimization ตาม PDPA):
--        id, ชื่อ, สาขา, ตำแหน่ง, ประเภทพนักงาน
--        — ไม่เปิดเงินเดือน, ปชช, ที่อยู่, เบอร์, allowance, sso ฯลฯ
--
-- รันใน Supabase SQL Editor ครั้งเดียว — idempotent
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.list_employees_for_cross_branch()
RETURNS TABLE(
  id              TEXT,
  first_name      TEXT,
  last_name       TEXT,
  nickname        TEXT,
  branch          TEXT,
  department      TEXT,
  position_id     TEXT,
  position_title  TEXT,
  employee_type   TEXT,
  hire_date       DATE
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
    e.branch,
    e.department,
    e.position AS position_id,
    e.position_title,
    e.employee_type,
    e.hire_date
  FROM public.employees e
  WHERE
    -- เฉพาะ active (ไม่นับพ้นสภาพ)
    e.termination_date IS NULL
    AND (e.status IS NULL OR e.status NOT IN ('resigned', 'terminated'))
    -- เปิดเฉพาะ role ที่มีสิทธิ์จัดตาราง — staff/viewer เรียกได้แต่ได้ array ว่าง
    AND public.current_user_role() IN ('admin', 'hr', 'operation_manager', 'area_manager', 'branch_manager')
  ORDER BY e.branch, e.first_name;
$$;

REVOKE ALL ON FUNCTION public.list_employees_for_cross_branch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_employees_for_cross_branch() TO authenticated;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ RPC list_employees_for_cross_branch() พร้อมใช้';
  RAISE NOTICE '   เปิดให้: admin / hr / operation_manager / area_manager / branch_manager';
  RAISE NOTICE '   ปิดให้:   branch_staff / viewer (คืน array ว่าง)';
  RAISE NOTICE '   คอลัมน์: id, ชื่อ, สาขา, ตำแหน่ง, ประเภท, วันเริ่มงาน — ไม่มี PII/finance';
END $$;
