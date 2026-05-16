-- ═══════════════════════════════════════════════════════════
-- KHACHA BROTHERS HR — Migration: Extended Employee Fields
-- เพิ่ม columns ใหม่ใน employees table (สาขา, ประเภท, การศึกษา, ฯลฯ)
-- รันสคริปต์นี้ใน Supabase SQL Editor ครั้งเดียว
-- ปลอดภัย: ใช้ IF NOT EXISTS — รันซ้ำได้
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS branch              TEXT,
  ADD COLUMN IF NOT EXISTS employee_type       TEXT,
  ADD COLUMN IF NOT EXISTS education           TEXT,
  ADD COLUMN IF NOT EXISTS nationality         TEXT DEFAULT 'ไทย',
  ADD COLUMN IF NOT EXISTS religion            TEXT,
  ADD COLUMN IF NOT EXISTS bank                TEXT,
  ADD COLUMN IF NOT EXISTS bank_account        TEXT,
  ADD COLUMN IF NOT EXISTS allowance_position  NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allowance_travel    NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allowance_food      NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allowance_per_diem  NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allowance_language  NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allowance_other     NUMERIC(12,2) DEFAULT 0;

-- ตั้งค่า default 'ไทย' สำหรับพนักงานเดิมที่ nationality ยังว่าง
UPDATE public.employees SET nationality = 'ไทย' WHERE nationality IS NULL;
