-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — เพิ่มวันหยุดประเพณีไทย ปี 2569 (2026)
--
-- ตามประกาศวันหยุดราชการของไทย ปี 2569 (พ.ศ. 2569 = ค.ศ. 2026)
-- ไม่ซ้ำกับที่มีอยู่แล้วในระบบ (ปีใหม่/สงกรานต์/แรงงาน/ร.9/รัฐธรรมนูญ/สิ้นปี)
--
-- ใช้ ON CONFLICT (date, title) → idempotent (รันซ้ำได้)
-- ถ้าวันใดประกาศแก้ → ลบใน UI แล้วรัน migration ใหม่
-- ═══════════════════════════════════════════════════════════

-- เพิ่ม UNIQUE constraint ก่อน (idempotent — กันเพิ่มซ้ำ)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calendar_items_date_title_unique'
  ) THEN
    ALTER TABLE public.calendar_items
      ADD CONSTRAINT calendar_items_date_title_unique UNIQUE (date, title);
  END IF;
END $$;

-- ════════ Insert 11 วันหยุดมาตรฐาน ปี 2569 ════════
INSERT INTO public.calendar_items (date, title, type) VALUES
  ('2026-03-03', 'วันมาฆบูชา',                                'holiday'),
  ('2026-04-06', 'วันจักรี',                                  'holiday'),
  ('2026-05-04', 'วันฉัตรมงคล',                               'holiday'),
  ('2026-06-01', 'วันหยุดชดเชยวันวิสาขบูชา',                  'holiday'),
  ('2026-06-03', 'วันเฉลิมพระชนมพรรษาสมเด็จพระบรมราชินี',    'holiday'),
  ('2026-07-28', 'วันเฉลิมพระชนมพรรษาในหลวง ร.๑๐',           'holiday'),
  ('2026-07-29', 'วันอาสาฬหบูชา',                             'holiday'),
  ('2026-07-30', 'วันเข้าพรรษา',                              'holiday'),
  ('2026-08-12', 'วันแม่แห่งชาติ',                            'holiday'),
  ('2026-10-13', 'วันคล้ายวันสวรรคต ร.๙',                     'holiday'),
  ('2026-10-23', 'วันปิยมหาราช',                              'holiday')
ON CONFLICT (date, title) DO NOTHING;

-- ════════ Verify — แสดงวันหยุดทั้งหมดในปี 2569 ════════
DO $$
DECLARE
  v_count INT;
  v_row RECORD;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.calendar_items
  WHERE date >= '2026-01-01' AND date <= '2026-12-31'
    AND type = 'holiday';

  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════';
  RAISE NOTICE '✅ วันหยุดประเพณีปี 2569: % รายการ', v_count;
  RAISE NOTICE '═══════════════════════════════════════════';
  RAISE NOTICE '';
  FOR v_row IN
    SELECT date, title FROM public.calendar_items
    WHERE date >= '2026-01-01' AND date <= '2026-12-31'
      AND type = 'holiday'
    ORDER BY date
  LOOP
    RAISE NOTICE '  % — %', to_char(v_row.date, 'DD Mon YYYY'), v_row.title;
  END LOOP;
END $$;
