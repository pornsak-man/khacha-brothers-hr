-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Uniform Stock Movements (ledger)
--
-- เพิ่มระบบ:
--   1. ตาราง uniform_stock_movements — ledger ทุก in/out ของ stock
--   2. Trigger ใหม่ (ทับ trigger เดิม) — auto-log movement เมื่อจัดชุด
--   3. RPC receive_uniform_stock() — รับเข้า stock + log อัตโนมัติ
--   4. RPC adjust_uniform_stock_manual() — HR ปรับ stock manual (นับ stock)
--
-- Movement types:
--   - receive = รับเข้า (+, สั่งผลิต/สั่งซื้อ/บริจาค)
--   - issue   = จ่ายออก (-, จากการจัดชุด)
--   - return  = คืน (+, จากลบ issue)
--   - adjust  = ปรับ (+/-, HR ปรับ manual)
--
-- รันใน Supabase SQL Editor (idempotent)
-- ⚠ Prereq: ต้องรัน supabase-migration-uniform-stock-trigger.sql ก่อน
-- ═══════════════════════════════════════════════════════════

-- ─── Movement ledger table ───
CREATE TABLE IF NOT EXISTS public.uniform_stock_movements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id         UUID NOT NULL REFERENCES public.uniform_items(id) ON DELETE CASCADE,
  movement_type   TEXT NOT NULL CHECK (movement_type IN ('receive', 'issue', 'return', 'adjust')),
  delta           INTEGER NOT NULL,      -- + เข้า / - ออก
  balance_after   INTEGER NOT NULL,      -- snapshot stock_qty หลัง movement
  ref_issue_id    UUID REFERENCES public.uniform_issues(id) ON DELETE SET NULL,
  reason          TEXT,                  -- "สั่งผลิต", "จัดให้พนักงาน 121", "ปรับ stock", ...
  note            TEXT,
  created_by      TEXT,                  -- ผู้ทำรายการ (email / name)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uniform_movements_item     ON public.uniform_stock_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_uniform_movements_date     ON public.uniform_stock_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uniform_movements_type     ON public.uniform_stock_movements(movement_type);
CREATE INDEX IF NOT EXISTS idx_uniform_movements_issue    ON public.uniform_stock_movements(ref_issue_id);

-- ─── RLS ───
ALTER TABLE public.uniform_stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_authenticated" ON public.uniform_stock_movements;
DROP POLICY IF EXISTS "write_hr_admin"     ON public.uniform_stock_movements;
CREATE POLICY "read_authenticated" ON public.uniform_stock_movements
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_hr_admin" ON public.uniform_stock_movements
  FOR INSERT TO authenticated WITH CHECK (public.is_hr_or_admin());
-- ห้าม UPDATE/DELETE — ledger ห้ามแก้ย้อน (immutable audit trail)

-- ─── Realtime ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'uniform_stock_movements'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.uniform_stock_movements;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════
-- Replace trigger function — เพิ่ม movement log
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.uniform_issues_stock_trigger()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stock   INTEGER;
  v_name    TEXT;
  v_size    TEXT;
  v_emp_id  TEXT;
  v_user    TEXT;
BEGIN
  -- ระบุผู้ทำ (สำหรับ audit log)
  SELECT email INTO v_user FROM auth.users WHERE id = auth.uid();

  -- ════════════════════════════════════════════════════
  -- INSERT: ตัด stock + log movement (type=issue)
  -- ════════════════════════════════════════════════════
  IF TG_OP = 'INSERT' THEN
    IF NEW.item_id IS NOT NULL AND COALESCE(NEW.qty, 0) > 0 THEN
      SELECT stock_qty, name, size INTO v_stock, v_name, v_size
      FROM public.uniform_items WHERE id = NEW.item_id FOR UPDATE;

      IF v_stock IS NULL THEN
        RAISE EXCEPTION 'ไม่พบรายการชุดในระบบ (item_id %)', NEW.item_id;
      END IF;
      IF v_stock < NEW.qty THEN
        RAISE EXCEPTION 'Stock ไม่พอ: % ขนาด % เหลือ % ชิ้น แต่ต้องการจัด % ชิ้น',
          v_name, COALESCE(v_size, '-'), v_stock, NEW.qty;
      END IF;

      UPDATE public.uniform_items
      SET stock_qty = stock_qty - NEW.qty, updated_at = now()
      WHERE id = NEW.item_id;

      -- log movement
      INSERT INTO public.uniform_stock_movements
        (item_id, movement_type, delta, balance_after, ref_issue_id, reason, created_by)
      VALUES
        (NEW.item_id, 'issue', -NEW.qty, v_stock - NEW.qty, NEW.id,
         'จัดให้พนักงาน ' || COALESCE(NEW.employee_id, '-'),
         COALESCE(NEW.issued_by, v_user, 'system'));
    END IF;
    RETURN NEW;
  END IF;

  -- ════════════════════════════════════════════════════
  -- UPDATE: ปรับ stock ตาม diff + log 2 movement (return OLD, issue NEW)
  -- ════════════════════════════════════════════════════
  IF TG_OP = 'UPDATE' THEN
    IF NEW.item_id IS NOT DISTINCT FROM OLD.item_id
       AND COALESCE(NEW.qty, 0) = COALESCE(OLD.qty, 0) THEN
      RETURN NEW;
    END IF;

    -- คืน OLD
    IF OLD.item_id IS NOT NULL AND COALESCE(OLD.qty, 0) > 0 THEN
      UPDATE public.uniform_items
      SET stock_qty = stock_qty + OLD.qty, updated_at = now()
      WHERE id = OLD.item_id
      RETURNING stock_qty INTO v_stock;

      INSERT INTO public.uniform_stock_movements
        (item_id, movement_type, delta, balance_after, ref_issue_id, reason, created_by)
      VALUES
        (OLD.item_id, 'return', OLD.qty, v_stock, OLD.id,
         'แก้ไขรายการ — คืน stock เดิม',
         COALESCE(v_user, 'system'));
    END IF;

    -- ตัด NEW
    IF NEW.item_id IS NOT NULL AND COALESCE(NEW.qty, 0) > 0 THEN
      SELECT stock_qty, name, size INTO v_stock, v_name, v_size
      FROM public.uniform_items WHERE id = NEW.item_id FOR UPDATE;

      IF v_stock IS NULL THEN
        RAISE EXCEPTION 'ไม่พบรายการชุดในระบบ (item_id %)', NEW.item_id;
      END IF;
      IF v_stock < NEW.qty THEN
        RAISE EXCEPTION 'Stock ไม่พอ: % ขนาด % เหลือ % ชิ้น แต่ต้องการจัด % ชิ้น',
          v_name, COALESCE(v_size, '-'), v_stock, NEW.qty;
      END IF;

      UPDATE public.uniform_items
      SET stock_qty = stock_qty - NEW.qty, updated_at = now()
      WHERE id = NEW.item_id;

      INSERT INTO public.uniform_stock_movements
        (item_id, movement_type, delta, balance_after, ref_issue_id, reason, created_by)
      VALUES
        (NEW.item_id, 'issue', -NEW.qty, v_stock - NEW.qty, NEW.id,
         'แก้ไขรายการ — จัดให้พนักงาน ' || COALESCE(NEW.employee_id, '-'),
         COALESCE(NEW.issued_by, v_user, 'system'));
    END IF;
    RETURN NEW;
  END IF;

  -- ════════════════════════════════════════════════════
  -- DELETE: คืน stock + log movement (type=return)
  -- ════════════════════════════════════════════════════
  IF TG_OP = 'DELETE' THEN
    IF OLD.item_id IS NOT NULL AND COALESCE(OLD.qty, 0) > 0 THEN
      UPDATE public.uniform_items
      SET stock_qty = stock_qty + OLD.qty, updated_at = now()
      WHERE id = OLD.item_id
      RETURNING stock_qty INTO v_stock;

      INSERT INTO public.uniform_stock_movements
        (item_id, movement_type, delta, balance_after, ref_issue_id, reason, created_by)
      VALUES
        (OLD.item_id, 'return', OLD.qty, v_stock, NULL,  -- ref_issue_id เป็น NULL เพราะ issue ถูกลบ
         'ลบรายการจัดให้พนักงาน ' || COALESCE(OLD.employee_id, '-') || ' — คืน stock',
         COALESCE(v_user, 'system'));
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════
-- RPC: receive_uniform_stock() — รับเข้า stock + log
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.receive_uniform_stock(
  p_item_id UUID,
  p_qty     INTEGER,
  p_reason  TEXT DEFAULT 'รับเข้า stock',
  p_note    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance INTEGER;
  v_user    TEXT;
  v_item_exists BOOLEAN;
BEGIN
  -- permission check
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'เฉพาะ HR/admin เท่านั้นที่รับเข้า stock ได้';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'จำนวนรับเข้าต้อง > 0';
  END IF;
  IF p_qty > 100000 THEN
    RAISE EXCEPTION 'จำนวนรับเข้าเกิน 100000 — ผิดปกติ';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.uniform_items WHERE id = p_item_id) INTO v_item_exists;
  IF NOT v_item_exists THEN
    RAISE EXCEPTION 'ไม่พบรายการชุด (item_id %)', p_item_id;
  END IF;

  SELECT email INTO v_user FROM auth.users WHERE id = auth.uid();

  -- update stock
  UPDATE public.uniform_items
  SET stock_qty = stock_qty + p_qty, updated_at = now()
  WHERE id = p_item_id
  RETURNING stock_qty INTO v_balance;

  -- log movement
  INSERT INTO public.uniform_stock_movements
    (item_id, movement_type, delta, balance_after, reason, note, created_by)
  VALUES
    (p_item_id, 'receive', p_qty, v_balance, p_reason, p_note, COALESCE(v_user, 'system'));

  RETURN jsonb_build_object('ok', true, 'balance_after', v_balance, 'delta', p_qty);
END $$;

GRANT EXECUTE ON FUNCTION public.receive_uniform_stock(UUID, INTEGER, TEXT, TEXT) TO authenticated;

-- ═══════════════════════════════════════════════════════════
-- RPC: adjust_uniform_stock_manual() — HR ปรับ stock manual (นับ stock จริง)
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.adjust_uniform_stock_manual(
  p_item_id UUID,
  p_new_qty INTEGER,
  p_reason  TEXT DEFAULT 'ปรับ stock manual',
  p_note    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_qty INTEGER;
  v_delta   INTEGER;
  v_user    TEXT;
BEGIN
  IF NOT public.is_hr_or_admin() THEN
    RAISE EXCEPTION 'เฉพาะ HR/admin เท่านั้น';
  END IF;
  IF p_new_qty IS NULL OR p_new_qty < 0 THEN
    RAISE EXCEPTION 'จำนวน stock ใหม่ต้อง >= 0';
  END IF;

  SELECT email INTO v_user FROM auth.users WHERE id = auth.uid();

  SELECT stock_qty INTO v_old_qty
  FROM public.uniform_items WHERE id = p_item_id FOR UPDATE;
  IF v_old_qty IS NULL THEN
    RAISE EXCEPTION 'ไม่พบรายการชุด';
  END IF;

  v_delta := p_new_qty - v_old_qty;
  IF v_delta = 0 THEN
    RETURN jsonb_build_object('ok', true, 'balance_after', p_new_qty, 'delta', 0, 'note', 'no change');
  END IF;

  UPDATE public.uniform_items
  SET stock_qty = p_new_qty, updated_at = now()
  WHERE id = p_item_id;

  INSERT INTO public.uniform_stock_movements
    (item_id, movement_type, delta, balance_after, reason, note, created_by)
  VALUES
    (p_item_id, 'adjust', v_delta, p_new_qty, p_reason, p_note, COALESCE(v_user, 'system'));

  RETURN jsonb_build_object('ok', true, 'balance_after', p_new_qty, 'delta', v_delta);
END $$;

GRANT EXECUTE ON FUNCTION public.adjust_uniform_stock_manual(UUID, INTEGER, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ─── Verify ───
DO $$
BEGIN
  RAISE NOTICE '✅ Uniform Stock Movements ติดตั้งแล้ว';
  RAISE NOTICE '';
  RAISE NOTICE '   ตาราง: uniform_stock_movements (ledger immutable)';
  RAISE NOTICE '   - movement_type: receive (รับเข้า) / issue (จ่ายออก) / return (คืน) / adjust (ปรับ)';
  RAISE NOTICE '   - delta: +/-, balance_after: snapshot stock หลัง movement';
  RAISE NOTICE '';
  RAISE NOTICE '   Trigger uniform_issues_stock_trigger (updated):';
  RAISE NOTICE '   - INSERT issue → ตัด stock + log type=issue';
  RAISE NOTICE '   - UPDATE issue → คืน OLD + ตัด NEW + log 2 movements';
  RAISE NOTICE '   - DELETE issue → คืน stock + log type=return';
  RAISE NOTICE '';
  RAISE NOTICE '   RPC สำหรับ frontend:';
  RAISE NOTICE '   - receive_uniform_stock(item_id, qty, reason, note) — รับเข้า';
  RAISE NOTICE '   - adjust_uniform_stock_manual(item_id, new_qty, reason, note) — ปรับ stock manual';
END $$;
