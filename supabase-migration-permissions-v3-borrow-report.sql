-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Permissions v3: borrow + report keys ที่ขาด
--
-- ตรวจพบ 2 feature ที่ยังไม่มี permission key ใน matrix:
--   1. ขอยืมพนักงาน (cross-branch borrow) — ไม่มี borrow.* เลย
--   2. เมนูรายงาน (reports) — มีแค่ report.export_payroll ไม่มี report.view
--
-- เพิ่ม 3 keys + default role grants
-- รันใน Supabase SQL Editor (idempotent)
-- ⚠ Prereq: ต้องรัน permissions-v1.sql + v2-missing-keys.sql ก่อน
-- ═══════════════════════════════════════════════════════════

-- ═════════════ 1. INSERT permissions ใหม่ ═════════════
INSERT INTO public.permissions (key, scope, label_th, description, is_dangerous, is_critical, sort_order) VALUES
  -- ── BORROW (ขอยืมพนักงานข้ามสาขา) ──
  ('borrow.view',   'leave',   'เห็นเมนู "ขอยืมพนักงาน"',       'ดูคำขอยืมพนักงานข้ามสาขา',              false, false, 670),
  ('borrow.manage', 'leave',   'สร้าง/อนุมัติคำขอยืมพนักงาน',    'BM ขอยืม · AM/OM อนุมัติข้ามสาขา',        false, false, 680),
  -- ── REPORT (เมนูรายงาน) ──
  ('report.view',   'payroll', 'เห็นเมนู "รายงาน / Export"',     'หน้ารวมรายงาน — export แยกที่ report.export_payroll', false, false, 440)
ON CONFLICT (key) DO UPDATE SET
  scope        = EXCLUDED.scope,
  label_th     = EXCLUDED.label_th,
  description  = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous,
  is_critical  = EXCLUDED.is_critical,
  sort_order   = EXCLUDED.sort_order;

-- ═════════════ 2. SEED default role_permissions ═════════════
WITH grants (role_id, permission_key) AS (VALUES
  -- ── ADMIN ทำได้ทุกอย่าง ──
  ('admin', 'borrow.view'), ('admin', 'borrow.manage'), ('admin', 'report.view'),
  -- ── HR เท่า admin ──
  ('hr', 'borrow.view'), ('hr', 'borrow.manage'), ('hr', 'report.view'),
  -- ── OPERATION MANAGER (ดูยืม + อนุมัติข้ามสาขา + รายงาน) ──
  ('operation_manager', 'borrow.view'), ('operation_manager', 'borrow.manage'),
  ('operation_manager', 'report.view'),
  -- ── AREA MANAGER (อนุมัติยืมข้ามสาขาที่ดูแล) ──
  ('area_manager', 'borrow.view'), ('area_manager', 'borrow.manage'),
  -- ── BRANCH MANAGER (ขอยืมพนักงานเข้าสาขาตัวเอง) ──
  ('branch_manager', 'borrow.view'), ('branch_manager', 'borrow.manage')
  -- branch_staff / viewer: ไม่เกี่ยวกับการยืมพนักงาน → ไม่ให้
)
INSERT INTO public.role_permissions (role_id, permission_key, granted)
SELECT g.role_id, g.permission_key, true
FROM grants g
WHERE EXISTS (SELECT 1 FROM public.roles       r WHERE r.id  = g.role_id)
  AND EXISTS (SELECT 1 FROM public.permissions p WHERE p.key = g.permission_key)
ON CONFLICT (role_id, permission_key) DO NOTHING;

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE v_total INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM public.permissions;
  RAISE NOTICE '✅ Permissions v3 — เพิ่ม borrow + report keys';
  RAISE NOTICE '   - borrow.view, borrow.manage (ขอยืมพนักงานข้ามสาขา)';
  RAISE NOTICE '   - report.view (เมนูรายงาน)';
  RAISE NOTICE '   - รวมตอนนี้: % permission keys', v_total;
  RAISE NOTICE '   - ครอบคลุมครบทั้ง 27 หน้าในระบบแล้ว';
END $$;
