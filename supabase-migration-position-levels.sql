-- ═══════════════════════════════════════════════════════════
-- KHACHA BROTHERS HR — Migration: Position Levels (15 ตำแหน่ง)
-- เพิ่ม column "level" และตั้งระดับตำแหน่งตามโครงสร้างจริงของคชา
-- รันสคริปต์นี้ใน Supabase SQL Editor ครั้งเดียว
-- ═══════════════════════════════════════════════════════════

-- 1) เพิ่ม column level (integer) ใน position_levels
ALTER TABLE public.position_levels ADD COLUMN IF NOT EXISTS level INTEGER;

-- 2) ลบข้อมูลตัวอย่างเก่า (P01-P05) — ระวัง: ถ้ามีพนักงานอ้างอิงตำแหน่งเดิม
--    จะถูก set เป็น NULL อัตโนมัติเพราะ FK เป็น ON DELETE SET NULL
DELETE FROM public.position_levels WHERE id IN ('P01','P02','P03','P04','P05');

-- 3) เพิ่ม 15 ตำแหน่งตามโครงสร้าง คชา บราเธอร์ส
INSERT INTO public.position_levels (id, name, level, min_salary, max_salary) VALUES
  ('P01', 'RM',               8, 0, 0),
  ('P02', 'Act.RM',            7, 0, 0),
  ('P03', 'Asst.1',            6, 0, 0),
  ('P04', 'Asst.2',            5, 0, 0),
  ('P05', 'JM',                4, 0, 0),
  ('P06', 'MT',                3, 0, 0),
  ('P07', 'Service',           2, 0, 0),
  ('P08', 'Senior Head Chef',  7, 0, 0),
  ('P09', 'Head Chef',         6, 0, 0),
  ('P10', 'Act.Head Chef',     5, 0, 0),
  ('P11', 'Sous Chef',         4, 0, 0),
  ('P12', 'Senior Chef',       3, 0, 0),
  ('P13', 'Barista',           3, 0, 0),
  ('P14', 'Chef',              2, 0, 0),
  ('P15', 'Part-time',         1, 0, 0)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  level = EXCLUDED.level;
