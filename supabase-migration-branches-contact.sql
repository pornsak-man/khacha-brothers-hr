-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Branch contact info
-- เพิ่ม phone + email สำหรับแต่ละสาขา
-- ผู้บังคับบัญชาสูงสุดของสาขาคำนวณ on-the-fly ที่ client (จาก position level สูงสุด)
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS phone TEXT,   -- เบอร์โทรของสาขา
  ADD COLUMN IF NOT EXISTS email TEXT;   -- email ของสาขา

NOTIFY pgrst, 'reload schema';

-- ─── หมายเหตุ ───
-- • Manager ของสาขา = พนักงาน active ในสาขานั้น ที่มี position.level สูงสุด
--   (คำนวณที่ client — ไม่ต้องเก็บ field manager_id เพราะ derived)
-- • เบอร์โทรส่วนตัวของผู้บังคับบัญชา = employees.phone ของคนนั้น (อยู่แล้ว)
-- • เบอร์สาขา + email สาขา = field ใหม่ใน branches table (เพิ่มที่นี่)
-- ═══════════════════════════════════════════════════════════
