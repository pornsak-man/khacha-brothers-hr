-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — เพิ่มสถานะ "เติมอัตราแล้ว" (fulfilled)
--
-- หลัง HR อนุมัติ (approved) → HR หาคนมาเติมได้ครบ → กด "เติมอัตราแล้ว"
-- → สถานะ fulfilled (ปิดคำขอ) ติดตามได้ว่าอัตราไหนเติมแล้ว/ยังค้าง
--
-- รันใน Supabase SQL Editor (idempotent) — ต้องรัน headcount-requests.sql ก่อน
-- ═══════════════════════════════════════════════════════════

-- 1. เพิ่มคอลัมน์ติดตามการเติมอัตรา
ALTER TABLE public.headcount_requests
  ADD COLUMN IF NOT EXISTS fulfilled_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfill_note TEXT;

-- 2. ขยาย CHECK constraint รองรับ 'fulfilled'
ALTER TABLE public.headcount_requests DROP CONSTRAINT IF EXISTS headcount_requests_status_check;
ALTER TABLE public.headcount_requests ADD CONSTRAINT headcount_requests_status_check
  CHECK (status IN ('pending_am','pending_hr','approved','fulfilled','rejected','cancelled'));

-- 3. RPC: มาร์คเติมอัตราแล้ว (เฉพาะ HR/admin, จาก approved → fulfilled)
CREATE OR REPLACE FUNCTION public.fulfill_headcount_request(
  p_request_id UUID,
  p_note       TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE PLPGSQL SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.headcount_requests;
BEGIN
  SELECT * INTO v_req FROM public.headcount_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'เฉพาะ HR/admin จึงจะมาร์คเติมอัตราได้';
  END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'ต้องเป็นคำขอที่อนุมัติแล้วเท่านั้น (สถานะปัจจุบัน: %)', v_req.status;
  END IF;
  UPDATE public.headcount_requests
    SET status='fulfilled', fulfilled_by=auth.uid(), fulfilled_at=now(), fulfill_note=p_note
    WHERE id = p_request_id;
  RETURN jsonb_build_object('id', p_request_id, 'status', 'fulfilled');
END $$;
GRANT EXECUTE ON FUNCTION public.fulfill_headcount_request(UUID,TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- 4. Verify
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='headcount_requests'
       AND column_name IN ('fulfilled_by','fulfilled_at','fulfill_note')) AS new_columns,
  (SELECT count(*) FROM pg_proc WHERE proname='fulfill_headcount_request') AS rpc,
  '✅ พร้อม — เติมอัตราแล้ว/ปิดคำขอ ใช้งานได้' AS note;
