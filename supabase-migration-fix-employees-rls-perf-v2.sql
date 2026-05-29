-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Fix RLS Performance v2: Path 1 InitPlan
--
-- ปัญหา: employees query ยังช้า ~1000ms (ลดจาก 2.6s แต่ไม่ถึงเป้า <500ms)
-- รากเหตุ: policy "employees_select_strict" Path 1 ใช้
--     EXISTS (SELECT 1 WHERE my_branch_scope() IS NULL)
--   → Postgres ประเมิน EXISTS เป็น "SubPlan ต่อแถว" ไม่ใช่ InitPlan
--   → my_branch_scope() (JOIN user_profiles + employees) ถูกเรียก ~700 ครั้ง
--   → HR ที่โหลด dashboard (match Path 1) เจอ overhead เต็มๆ
--
--   เทียบ Path 2/3 ที่ใช้ (SELECT ...) → Postgres hoist เป็น InitPlan
--   → รันครั้งเดียวต่อ query (เร็ว)
--
-- แก้: เปลี่ยน Path 1 จาก EXISTS → scalar subquery
--     (SELECT public.my_branch_scope()) IS NULL
--   → กลายเป็น InitPlan รันครั้งเดียว เหมือน Path 2/3
--   → logic เหมือนเดิมเป๊ะ: HR/admin/OM (scope = NULL) เห็นทุกแถว
--
-- ความปลอดภัย: ไม่เปลี่ยน semantic — แค่เปลี่ยนรูปแบบให้ planner hoist ได้
--   - scope IS NULL  → HR/admin/OM → เห็นทุกแถว (เหมือนเดิม)
--   - branch IN scope → BM/AM → เฉพาะสาขาตัวเอง (เหมือนเดิม)
--   - id = my_emp_id  → ทุกคนเห็นตัวเอง (เหมือนเดิม)
--
-- รันใน Supabase SQL Editor (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ════════ 1. สร้าง policy ใหม่ — Path 1 เป็น scalar subquery (InitPlan) ════════
DROP POLICY IF EXISTS "employees_select_strict" ON public.employees;

CREATE POLICY "employees_select_strict" ON public.employees
  FOR SELECT TO authenticated
  USING (
    -- ★ Path 1: HR/admin/OM → my_branch_scope() = NULL → เห็นทุกแถว
    --   ใช้ (SELECT ...) scalar subquery → Postgres hoist เป็น InitPlan (รันครั้งเดียว)
    (SELECT public.my_branch_scope()) IS NULL
    --
    -- ★ Path 2: BM/AM → branch ของพนักงานต้องอยู่ใน scope (InitPlan เดิม)
    OR branch IN (SELECT unnest(public.my_branch_scope()))
    --
    -- ★ Path 3: Self — เห็นตัวเองเสมอ (InitPlan เดิม)
    OR id = (SELECT public.my_employee_id())
  );

-- ════════ 2. Reload PostgREST schema cache ════════
NOTIFY pgrst, 'reload schema';

-- ════════ 3. Verify — ดู policy ใหม่ในตาราง Results ════════
-- ควรเห็น new_using_expr ขึ้นต้นด้วย "(( SELECT my_branch_scope() ...) IS NULL)"
-- (ไม่ใช่ "EXISTS (...)" อีกแล้ว)
SELECT
  polname,
  pg_get_expr(polqual, polrelid) AS new_using_expr
FROM pg_policy
WHERE polrelid = 'public.employees'::regclass
  AND polname  = 'employees_select_strict';

-- ───────────────────────────────────────────────────────────
-- ทดสอบที่หน้าเว็บ:
--   1. Ctrl+Shift+R ล้าง cache
--   2. login → เปิด DevTools Console
--   3. ดู "slowest query: employees" — ควรลดจาก ~1000ms เหลือ < 300ms
--   4. ทดสอบสิทธิ์: login HR เห็นทุกคน / BM เห็นเฉพาะสาขาตัวเอง / staff เห็นตัวเอง
-- ───────────────────────────────────────────────────────────
