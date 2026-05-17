-- ═══════════════════════════════════════════════════════════
-- KHACHA BROTHERS HR — Migration: Foreign worker documents
-- เพิ่ม Passport + Work Permit สำหรับพนักงานต่างชาติ
-- รันใน Supabase SQL Editor ครั้งเดียว
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS passport_number     TEXT,
  ADD COLUMN IF NOT EXISTS work_permit_number  TEXT;
