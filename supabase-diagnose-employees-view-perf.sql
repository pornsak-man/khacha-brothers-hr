-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — วินิจฉัย employees_view ว่าช้าเพราะอะไร
--
-- ใช้เมื่อ: Console โชว์ "slowest query: employees (~1000 ms)" ตอน login
-- เป้าหมาย: เช็คว่า view ใช้เวอร์ชัน "cached" แล้วหรือยัง
--
-- วิธีใช้: เปิด Supabase → SQL Editor → วาง → Run
--          ดูผลในตาราง Results (คอลัมน์ verdict คือคำตอบ)
-- ปลอดภัย: read-only ไม่แก้ข้อมูล/schema
--
-- หมายเหตุ: ใช้ SELECT คืนตาราง (ไม่ใช้ RAISE NOTICE) เพราะ
--           Supabase SQL Editor ไม่แสดงข้อความ NOTICE
-- ═══════════════════════════════════════════════════════════

-- ── ส่วนที่ 1 (สำคัญ): view เร่งแล้วหรือยัง ──
SELECT
  has_cached_function,
  view_uses_cached,
  CASE
    WHEN view_uses_cached THEN 'OK: view เร่งแล้ว — ถ้ายังช้าให้ดู tier/network'
    ELSE 'ACTION: ยังไม่เร่ง → ไปรันไฟล์ supabase-migration-fix-is-hr-session-cache.sql'
  END AS verdict
FROM (
  SELECT
    EXISTS (
      SELECT 1 FROM pg_proc
      WHERE proname = 'is_hr_or_admin_cached'
        AND pronamespace = 'public'::regnamespace
    ) AS has_cached_function,
    pg_get_viewdef('public.employees_view'::regclass, true)
      LIKE '%is_hr_or_admin_cached%' AS view_uses_cached
) t;

-- ── ส่วนที่ 2 (ถ้าต้องการเวลา query จริงใน DB) ──
-- เลือกคลุมบรรทัดล่าง (ลบ -- ออก) แล้ว Run แยก — ดู "Execution Time" ท้ายผล
-- EXPLAIN (ANALYZE, TIMING) SELECT * FROM public.employees_view;
