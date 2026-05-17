-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Migration: Uniform Management
-- ระบบจัดชุดพนักงานใหม่ — request → issue → stock + cost tracking
-- รันใน Supabase SQL Editor ครั้งเดียว (idempotent — รันซ้ำได้)
-- ═══════════════════════════════════════════════════════════

-- ── Master: ประเภท + ขนาด + stock + ราคา ──
CREATE TABLE IF NOT EXISTS public.uniform_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,             -- เสื้อยูนิฟอร์ม / กางเกง / หมวก / รองเท้า / ผ้ากันเปื้อน
  size        TEXT,                       -- S / M / L / XL / 36 / 38 / ฟรีไซส์
  stock_qty   INTEGER DEFAULT 0,
  unit_cost   NUMERIC(12,2) DEFAULT 0,
  active      BOOLEAN DEFAULT true,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, size)
);
CREATE INDEX IF NOT EXISTS idx_uniform_items_name ON public.uniform_items(name);

-- ── คำขอจัดชุดพนักงาน (header) ──
CREATE TABLE IF NOT EXISTS public.uniform_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id     TEXT REFERENCES public.employees(id) ON DELETE SET NULL,
  requested_by    TEXT,                       -- HR คนแจ้ง (ชื่อ/email)
  requested_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  needed_by       DATE,                       -- ต้องการก่อนวันเริ่มงาน
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','preparing','issued','cancelled')),
  total_cost      NUMERIC(12,2) DEFAULT 0,    -- รวมจาก issues (auto)
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uniform_requests_status   ON public.uniform_requests(status);
CREATE INDEX IF NOT EXISTS idx_uniform_requests_employee ON public.uniform_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_uniform_requests_needed   ON public.uniform_requests(needed_by);

-- ── รายการชุดที่จัดให้ (detail/line items) ──
CREATE TABLE IF NOT EXISTS public.uniform_issues (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id    UUID REFERENCES public.uniform_requests(id) ON DELETE CASCADE,
  employee_id   TEXT REFERENCES public.employees(id) ON DELETE SET NULL,
  item_id       UUID REFERENCES public.uniform_items(id) ON DELETE SET NULL,
  item_name     TEXT,                            -- snapshot ของชื่อ ณ ตอนจัด
  size          TEXT,
  qty           INTEGER NOT NULL DEFAULT 1,
  unit_cost     NUMERIC(12,2) DEFAULT 0,
  total_cost    NUMERIC(12,2) DEFAULT 0,         -- qty × unit_cost
  issued_date   DATE,
  issued_by     TEXT,                            -- HR คนจัด
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uniform_issues_employee ON public.uniform_issues(employee_id);
CREATE INDEX IF NOT EXISTS idx_uniform_issues_request  ON public.uniform_issues(request_id);
CREATE INDEX IF NOT EXISTS idx_uniform_issues_date     ON public.uniform_issues(issued_date DESC);

-- ── RLS ──
ALTER TABLE public.uniform_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uniform_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uniform_issues    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN ('uniform_items','uniform_requests','uniform_issues')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

CREATE POLICY "read_authenticated" ON public.uniform_items     FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin"        ON public.uniform_items     FOR ALL    TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "read_authenticated" ON public.uniform_requests  FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin"        ON public.uniform_requests  FOR ALL    TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "read_authenticated" ON public.uniform_issues    FOR SELECT TO authenticated USING (true);
CREATE POLICY "write_admin"        ON public.uniform_issues    FOR ALL    TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ── Realtime ──
DO $$
BEGIN
  FOR i IN 1..1 LOOP NULL; END LOOP;  -- no-op for syntax wrapper
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['uniform_items','uniform_requests','uniform_issues'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ── Auto-update updated_at ──
CREATE OR REPLACE FUNCTION public.uniform_set_updated_at()
RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS on_uniform_items_updated ON public.uniform_items;
CREATE TRIGGER on_uniform_items_updated BEFORE UPDATE ON public.uniform_items
  FOR EACH ROW EXECUTE FUNCTION public.uniform_set_updated_at();

DROP TRIGGER IF EXISTS on_uniform_requests_updated ON public.uniform_requests;
CREATE TRIGGER on_uniform_requests_updated BEFORE UPDATE ON public.uniform_requests
  FOR EACH ROW EXECUTE FUNCTION public.uniform_set_updated_at();

-- ── เริ่มต้นด้วยรายการตัวอย่าง (ลบได้ภายหลัง) ──
INSERT INTO public.uniform_items (name, size, stock_qty, unit_cost) VALUES
  ('เสื้อยูนิฟอร์ม', 'S',  20, 350),
  ('เสื้อยูนิฟอร์ม', 'M',  30, 350),
  ('เสื้อยูนิฟอร์ม', 'L',  30, 350),
  ('เสื้อยูนิฟอร์ม', 'XL', 20, 350),
  ('กางเกง',         'M',  25, 450),
  ('กางเกง',         'L',  25, 450),
  ('กางเกง',         'XL', 20, 450),
  ('หมวก',           'ฟรีไซส์', 50, 120),
  ('ผ้ากันเปื้อน',     'ฟรีไซส์', 40, 180)
ON CONFLICT (name, size) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- Status workflow:
--   pending     = แจ้งเข้ามาแล้ว รอจัด
--   preparing   = กำลังเตรียม
--   issued      = จัดส่งให้พนักงานแล้ว (มี issued_date)
--   cancelled   = ยกเลิก
-- ═══════════════════════════════════════════════════════════
