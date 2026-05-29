-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — วินิจฉัย employees_view ว่าช้าเพราะอะไร
--
-- ใช้เมื่อ: Console โชว์ "slowest query: employees (~1000 ms)" ตอน login
-- เป้าหมาย: เช็คว่า view ใช้เวอร์ชัน "cached" แล้วหรือยัง + วัดเวลาจริง
--
-- วิธีใช้: เปิด Supabase → SQL Editor → วางทั้งไฟล์ → Run
--          แล้วดูข้อความใน "Messages" / "Notices" ด้านล่าง
-- ปลอดภัย: read-only ทั้งหมด ไม่แก้ข้อมูล/ไม่แก้ schema
-- ═══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_def           TEXT;
  v_has_cached_fn BOOLEAN;
  v_uses_cached   BOOLEAN;
  v_uses_plain    BOOLEAN;
  v_count         INT;
  v_start         TIMESTAMP;
  v_ms            NUMERIC;
BEGIN
  -- 1) view definition ปัจจุบัน
  SELECT pg_get_viewdef('public.employees_view'::regclass, true) INTO v_def;

  -- 2) มี function เวอร์ชัน cached อยู่ไหม
  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'is_hr_or_admin_cached' AND pronamespace = 'public'::regnamespace
  ) INTO v_has_cached_fn;

  v_uses_cached := position('is_hr_or_admin_cached' in v_def) > 0;
  -- ใช้ตัวเก่า (ไม่ cached) = พบ 'is_hr_or_admin' แต่ไม่พบ '_cached'
  v_uses_plain  := (position('is_hr_or_admin' in v_def) > 0) AND NOT v_uses_cached;

  -- 3) วัดเวลาจริง (warm cache ภายใน transaction นี้)
  PERFORM set_config('khb.is_hr_cache', '', true);
  v_start := clock_timestamp();
  SELECT count(*) INTO v_count FROM (SELECT * FROM public.employees_view LIMIT 1000) t;
  v_ms := extract(milliseconds FROM clock_timestamp() - v_start);

  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════';
  RAISE NOTICE ' ผลวินิจฉัย employees_view';
  RAISE NOTICE '═══════════════════════════════════════════════════';
  RAISE NOTICE ' • จำนวนแถวที่อ่าน (≤1000): % rows', v_count;
  RAISE NOTICE ' • เวลา SELECT ใน DB: % ms', ROUND(v_ms, 1);
  RAISE NOTICE ' • มี function is_hr_or_admin_cached(): %', CASE WHEN v_has_cached_fn THEN 'มี ✅' ELSE 'ไม่มี ❌' END;
  RAISE NOTICE ' • view ใช้เวอร์ชัน cached: %', CASE WHEN v_uses_cached THEN 'ใช่ ✅ (เร่งแล้ว)' ELSE 'ยัง ❌' END;
  RAISE NOTICE '───────────────────────────────────────────────────';

  IF v_uses_cached THEN
    RAISE NOTICE ' สรุป: view เร่งแล้ว (ใช้ is_hr_or_admin_cached)';
    IF v_ms > 400 THEN
      RAISE NOTICE ' ⚠ แต่ยังช้า %ms — เวลาที่เหลือน่าจะเป็น network/tier latency', ROUND(v_ms,1);
      RAISE NOTICE '   (Supabase free/nano tier อาจ cold start). พิจารณา:';
      RAISE NOTICE '   - upgrade tier, หรือ';
      RAISE NOTICE '   - เพิ่ม index: CREATE INDEX ON employees (termination_date);';
    ELSE
      RAISE NOTICE ' ✅ เวลา DB เร็วดีแล้ว (<400ms). ถ้า Console ยังโชว์สูง';
      RAISE NOTICE '    = เวลาส่วนใหญ่อยู่ที่ network round-trip ไม่ใช่ query.';
    END IF;
  ELSE
    RAISE NOTICE ' 🔧 สรุป: view ยังไม่ได้เร่ง! (ยังเรียก is_hr_or_admin ต่อแถว)';
    RAISE NOTICE '    นี่คือสาเหตุที่ employees query ช้า ~1 วินาที';
    RAISE NOTICE '';
    RAISE NOTICE ' ➜ วิธีแก้: เปิดไฟล์ supabase-migration-fix-is-hr-session-cache.sql';
    RAISE NOTICE '            ใน repo → วางใน SQL Editor → Run (รันครั้งเดียวจบ)';
    RAISE NOTICE '            แล้วรันไฟล์วินิจฉัยนี้ซ้ำเพื่อยืนยัน';
  END IF;
  RAISE NOTICE '═══════════════════════════════════════════════════';
END $$;

-- เผื่ออยากเห็น view definition เต็มๆ ด้วยตา (uncomment บรรทัดล่าง)
-- SELECT pg_get_viewdef('public.employees_view'::regclass, true);
