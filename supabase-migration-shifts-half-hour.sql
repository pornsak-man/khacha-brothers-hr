-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Seed: กะเริ่มงานทุกครึ่งชั่วโมง (09:00 – 14:00)
-- กะยาว 9 ชม. พัก 1 ชม. (ทำงานจริง 8 ชม. — ตามกฎหมายแรงงาน §38)
-- 11 กะ ครอบคลุมช่วงร้านในศูนย์การค้า
--
-- รันใน Supabase SQL Editor ครั้งเดียว — idempotent (ON CONFLICT DO NOTHING)
-- ═══════════════════════════════════════════════════════════

INSERT INTO public.shifts (code, name, start_time, end_time, break_minutes, color, is_off_day, employee_types, sort_order, note)
VALUES
  -- ─── เช้า ───
  ('0900', 'กะ 09:00–18:00', '09:00', '18:00', 60, '#1d4ed8', false, '["fulltime","parttime"]'::jsonb,  900, '9 ชม. พัก 1 ชม.'),
  ('0930', 'กะ 09:30–18:30', '09:30', '18:30', 60, '#2563eb', false, '[]'::jsonb,                       930, '9 ชม. พัก 1 ชม.'),
  ('1000', 'กะ 10:00–19:00', '10:00', '19:00', 60, '#0ea5e9', false, '[]'::jsonb,                      1000, '9 ชม. พัก 1 ชม.'),
  ('1030', 'กะ 10:30–19:30', '10:30', '19:30', 60, '#06b6d4', false, '[]'::jsonb,                      1030, '9 ชม. พัก 1 ชม.'),
  -- ─── สาย ───
  ('1100', 'กะ 11:00–20:00', '11:00', '20:00', 60, '#14b8a6', false, '[]'::jsonb,                      1100, '9 ชม. พัก 1 ชม.'),
  ('1130', 'กะ 11:30–20:30', '11:30', '20:30', 60, '#10b981', false, '[]'::jsonb,                      1130, '9 ชม. พัก 1 ชม.'),
  -- ─── เที่ยง/บ่าย ───
  ('1200', 'กะ 12:00–21:00', '12:00', '21:00', 60, '#84cc16', false, '[]'::jsonb,                      1200, '9 ชม. พัก 1 ชม.'),
  ('1230', 'กะ 12:30–21:30', '12:30', '21:30', 60, '#eab308', false, '[]'::jsonb,                      1230, '9 ชม. พัก 1 ชม.'),
  ('1300', 'กะ 13:00–22:00', '13:00', '22:00', 60, '#f59e0b', false, '[]'::jsonb,                      1300, '9 ชม. พัก 1 ชม.'),
  -- ─── บ่ายเย็น ───
  ('1330', 'กะ 13:30–22:30', '13:30', '22:30', 60, '#f97316', false, '[]'::jsonb,                      1330, '9 ชม. พัก 1 ชม.'),
  ('1400', 'กะ 14:00–23:00', '14:00', '23:00', 60, '#ea580c', false, '[]'::jsonb,                      1400, '9 ชม. พัก 1 ชม. — กะปิดร้าน')
ON CONFLICT (code) DO NOTHING;

-- ─── ปรับ sort_order ของกะเดิม (M/A/N) ให้เรียงตามเวลาเริ่มเข้ากับกะใหม่ ───
-- (เฉพาะถ้ายังเป็นค่า seed เดิม — ไม่ override การปรับด้วยมือของ HR)
UPDATE public.shifts SET sort_order =  900 WHERE code = 'M'      AND sort_order = 10;
UPDATE public.shifts SET sort_order = 1200 WHERE code = 'A'      AND sort_order = 20;
UPDATE public.shifts SET sort_order = 1600 WHERE code = 'N'      AND sort_order = 30;
UPDATE public.shifts SET sort_order = 1700 WHERE code = 'PT4'    AND sort_order = 40;
UPDATE public.shifts SET sort_order =  830 WHERE code = 'OFFICE' AND sort_order = 50;
-- OFF ปล่อยให้ขึ้นท้ายเหมือนเดิม (sort_order = 90)

NOTIFY pgrst, 'reload schema';
