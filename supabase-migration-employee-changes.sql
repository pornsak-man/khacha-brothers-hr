-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Employee changes (salary + position + branch + department)
-- ขยาย salary_history ให้รองรับการเปลี่ยนสาขา + ฝ่าย พร้อมเก็บค่าเดิม-ใหม่
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.salary_history
  ADD COLUMN IF NOT EXISTS old_position        TEXT,
  ADD COLUMN IF NOT EXISTS old_position_title  TEXT,
  ADD COLUMN IF NOT EXISTS old_branch          TEXT,
  ADD COLUMN IF NOT EXISTS new_branch          TEXT,
  ADD COLUMN IF NOT EXISTS old_department      TEXT,
  ADD COLUMN IF NOT EXISTS new_department      TEXT,
  ADD COLUMN IF NOT EXISTS change_type         TEXT;

-- change_type: salary | position | branch | department | multiple
-- (computed on insert from non-null new_* fields)

-- รีเฟรช schema cache
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- โครงสร้างใหม่ของ salary_history:
--   id, employee_id, date, reason, created_at
--   เงินเดือน:   old_salary, new_salary
--   ตำแหน่ง:    old_position, old_position_title, new_position, new_position_title
--   สาขา:       old_branch, new_branch
--   ฝ่าย:        old_department, new_department
--   change_type: ระบุประเภทการเปลี่ยน (salary/position/branch/department/multiple)
-- ═══════════════════════════════════════════════════════════
