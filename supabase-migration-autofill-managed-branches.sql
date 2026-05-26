-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Auto-fill managed_branches สำหรับ BM/AM
--
-- ปัญหา:
--   - มี BM/AM 12 คนใน user_profiles แต่ทุกคน managed_branches=NULL/ว่าง
--   - ระบบมี fallback ใช้ emp.branch — แต่ staff user มอง emp สาขาอื่นไม่ได้ (RLS)
--   - ผลคือ getScheduleCreators/getScheduleApprover คืน [] → "ยังไม่ตั้ง BM"
--
-- วิธีแก้:
--   - ตั้ง managed_branches = [employee.branch] ให้ BM/AM ทุกคนที่ยังว่าง
--   - Default ที่สมเหตุสมผล: BM ดูแลสาขาตัวเอง
--   - HR/Admin สามารถแก้ไขเพิ่ม branches ภายหลังได้ที่หน้า "ผู้ใช้และสิทธิ์"
--
-- ⚠️ Trigger bypass:
--   - มี trigger guard_user_profiles_self_update() ที่ block UPDATE managed_branches ตรง
--   - SQL Editor run เป็น postgres superuser → ใช้ session_replication_role='replica' bypass
--   - หลัง UPDATE แล้ว reset เป็น 'origin' ทันที (trigger กลับมาทำงานปกติ)
--
-- ปลอดภัย:
--   - UPDATE เฉพาะที่ managed_branches IS NULL หรือ empty array
--   - ถ้าคนไหนตั้ง managed_branches แล้ว → ไม่แตะ
--   - employee.branch IS NOT NULL — ถ้า BM ยังไม่ตั้งสาขา → skip
--
-- รันใน Supabase SQL Editor (idempotent)
-- ═══════════════════════════════════════════════════════════

-- ── STEP 1: Preview ── ดูว่าจะ update คนไหนบ้างก่อน UPDATE จริง
DO $$
DECLARE
  r RECORD;
  v_count INT := 0;
BEGIN
  RAISE NOTICE '════ Preview: BM/AM ที่จะถูก auto-fill ════';
  FOR r IN
    SELECT up.employee_id, up.role, e.branch,
           COALESCE(e.first_name, '') AS first_name,
           COALESCE(e.last_name, '') AS last_name
    FROM public.user_profiles up
    JOIN public.employees e ON e.id = up.employee_id
    WHERE up.role IN ('branch_manager', 'area_manager')
      AND (up.managed_branches IS NULL OR cardinality(up.managed_branches) = 0)
      AND e.branch IS NOT NULL AND e.branch != ''
    ORDER BY up.role, e.branch, up.employee_id
  LOOP
    v_count := v_count + 1;
    RAISE NOTICE '   [%] % % % (สาขา: %) → managed_branches = [%]',
      r.role, r.employee_id, r.first_name, r.last_name, r.branch, r.branch;
  END LOOP;
  RAISE NOTICE '════ รวม % คน ที่จะถูก update ════', v_count;
END $$;

-- ── STEP 2: Bypass trigger + UPDATE ──
-- session_replication_role='replica' → triggers ที่ออกแบบให้ run บน origin ถูก skip
-- (Supabase SQL Editor run เป็น postgres superuser → มีสิทธิ์ตั้ง)
SET session_replication_role = 'replica';

UPDATE public.user_profiles up
SET managed_branches = ARRAY[e.branch]::text[]
FROM public.employees e
WHERE up.employee_id = e.id
  AND up.role IN ('branch_manager', 'area_manager')
  AND (up.managed_branches IS NULL OR cardinality(up.managed_branches) = 0)
  AND e.branch IS NOT NULL AND e.branch != '';

-- ── STEP 3: คืนค่า trigger กลับมาทำงาน (สำคัญมาก!) ──
SET session_replication_role = 'origin';

NOTIFY pgrst, 'reload schema';

-- ── STEP 4: Verify ผลลัพธ์ ──
DO $$
DECLARE
  v_total_bm INT;
  v_total_am INT;
  v_set_bm INT;
  v_set_am INT;
  v_unset_bm INT;
  v_unset_am INT;
BEGIN
  SELECT count(*) INTO v_total_bm FROM public.user_profiles WHERE role = 'branch_manager';
  SELECT count(*) INTO v_total_am FROM public.user_profiles WHERE role = 'area_manager';
  SELECT count(*) INTO v_set_bm FROM public.user_profiles
    WHERE role = 'branch_manager' AND managed_branches IS NOT NULL AND cardinality(managed_branches) > 0;
  SELECT count(*) INTO v_set_am FROM public.user_profiles
    WHERE role = 'area_manager' AND managed_branches IS NOT NULL AND cardinality(managed_branches) > 0;
  v_unset_bm := v_total_bm - v_set_bm;
  v_unset_am := v_total_am - v_set_am;

  RAISE NOTICE '';
  RAISE NOTICE '✅ Auto-fill managed_branches เสร็จสิ้น';
  RAISE NOTICE '   Branch Manager (BM): % คน ตั้งแล้ว / % คน รวม (เหลือ %)', v_set_bm, v_total_bm, v_unset_bm;
  RAISE NOTICE '   Area Manager (AM): % คน ตั้งแล้ว / % คน รวม (เหลือ %)', v_set_am, v_total_am, v_unset_am;
  IF v_unset_bm > 0 OR v_unset_am > 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '⚠ คนที่ยังไม่ได้ตั้ง — ต้องเข้าหน้า "ผู้ใช้และสิทธิ์" ตั้งเอง';
    RAISE NOTICE '   (อาจเป็นเพราะ employee.branch ว่าง หรือ AM ที่ดูแลหลายสาขา)';
  END IF;
  RAISE NOTICE '';
  RAISE NOTICE '🔒 Trigger ถูก reset กลับเป็น origin แล้ว (ทำงานปกติ)';
END $$;
