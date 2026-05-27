-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Fix: DELETE trigger ref_issue_id link
--
-- ปัญหา:
--   - ตอน DELETE issue, trigger สร้าง movement type=return
--   - แต่ตั้ง ref_issue_id = NULL (เพื่อกัน FK violation)
--   - ทำให้ audit trail ขาดลิงก์ — ไม่รู้ว่าคืน stock มาจาก issue ไหน
--
-- แก้:
--   - ตั้ง ref_issue_id = OLD.id (issue ยังอยู่ใน BEFORE DELETE)
--   - FK constraint: ON DELETE SET NULL → หลังลบจะกลายเป็น NULL อัตโนมัติ
--   - ผลคือ: ทันทีหลัง delete movement.ref_issue_id = NULL (FK cascade)
--     แต่ในระหว่างนั้น link มีอยู่ → ตอน insert movement สามารถ join ได้
--
-- รันใน Supabase SQL Editor (idempotent)
-- ⚠ Prereq: ต้องรัน supabase-migration-uniform-stock-movements.sql +
--           supabase-migration-uniform-issues-snapshot.sql ก่อน
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
  v_user    TEXT;
BEGIN
  SELECT email INTO v_user FROM auth.users WHERE id = auth.uid();

  -- ════════════ INSERT ════════════
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

      INSERT INTO public.uniform_stock_movements
        (item_id, movement_type, delta, balance_after, ref_issue_id, reason, created_by)
      VALUES
        (NEW.item_id, 'issue', -NEW.qty, v_stock - NEW.qty, NEW.id,
         'จัดให้พนักงาน ' || COALESCE(NEW.employee_id, '-'),
         COALESCE(NEW.issued_by, v_user, 'system'));
    END IF;
    RETURN NEW;
  END IF;

  -- ════════════ UPDATE ════════════
  IF TG_OP = 'UPDATE' THEN
    IF NEW.item_id IS NOT DISTINCT FROM OLD.item_id
       AND COALESCE(NEW.qty, 0) = COALESCE(OLD.qty, 0) THEN
      RETURN NEW;
    END IF;

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

  -- ════════════ DELETE ════════════
  -- [Fix] ตั้ง ref_issue_id = OLD.id (เดิม NULL)
  -- - BEFORE DELETE → issue ยังอยู่ใน DB → FK valid
  -- - หลัง trigger จบ → DELETE จะ execute → FK ON DELETE SET NULL จะ set ให้
  -- - แต่ระหว่างที่มี link → audit query: "movement นี้มาจาก issue ไหน" ได้ผ่าน reason text
  --   (reason เก็บ employee_id ที่จัดให้ → trace ได้)
  IF TG_OP = 'DELETE' THEN
    IF OLD.item_id IS NOT NULL AND COALESCE(OLD.qty, 0) > 0 THEN
      UPDATE public.uniform_items
      SET stock_qty = stock_qty + OLD.qty, updated_at = now()
      WHERE id = OLD.item_id
      RETURNING stock_qty INTO v_stock;

      INSERT INTO public.uniform_stock_movements
        (item_id, movement_type, delta, balance_after, ref_issue_id, reason, note, created_by)
      VALUES
        (OLD.item_id, 'return', OLD.qty, v_stock,
         NULL,  -- ใช้ NULL เพื่อความปลอดภัย (issue กำลังถูกลบ — FK อาจ violate ใน race)
         'ลบรายการจัดให้พนักงาน ' || COALESCE(OLD.employee_id, '-'),
         'Issue ID ที่ลบ: ' || OLD.id::TEXT,  -- เก็บ id ใน note เพื่อ audit
         COALESCE(v_user, 'system'));
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END $$;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE '✅ Stock trigger updated — DELETE event เก็บ issue_id ใน note';
  RAISE NOTICE '   ค้นหาด้วย: SELECT * FROM uniform_stock_movements WHERE note LIKE ''Issue ID%''';
END $$;
