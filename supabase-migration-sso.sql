-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: SSO (ประกันสังคม)
-- เพิ่มฟิลด์สำหรับการแจ้งเข้า/แจ้งออกประกันสังคม
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS sso_no              TEXT,   -- เลขประกันสังคม (มักเป็นเลขบัตร ปชช. แต่บางคนเป็นเลขเฉพาะ)
  ADD COLUMN IF NOT EXISTS sso_enrolled_date   DATE,   -- วันที่แจ้งขึ้นทะเบียนผู้ประกันตน (สปส.1-03)
  ADD COLUMN IF NOT EXISTS sso_terminated_date DATE,   -- วันที่แจ้งสิ้นสุดความเป็นผู้ประกันตน (สปส.6-09)
  ADD COLUMN IF NOT EXISTS sso_hospital        TEXT;   -- สถานพยาบาลที่เลือก (optional)

-- รีเฟรช schema cache ของ Supabase REST API
NOTIFY pgrst, 'reload schema';

-- ─── หมายเหตุการใช้งาน ───
-- • พนักงานเข้าใหม่: ต้องแจ้งภายใน 30 วันนับแต่วันเริ่มงาน (สปส.1-03)
--   ─ list "ต้องแจ้งเข้า" = พนักงาน active ที่ hire_date <= วันนี้ AND sso_enrolled_date IS NULL
--   ─ "เกินกำหนด" = วันนี้ - hire_date > 30 วัน
--
-- • พนักงานพ้นสภาพ: ต้องแจ้งภายในวันที่ 15 ของเดือนถัดจากเดือนที่พ้นสภาพ (สปส.6-09)
--   ─ list "ต้องแจ้งออก" = พนักงานที่ termination_date <= วันนี้ AND sso_terminated_date IS NULL
--   ─ "เกินกำหนด" = วันนี้ > วันที่ 15 ของเดือนถัดจากเดือน termination_date
-- ═══════════════════════════════════════════════════════════
