-- ═══════════════════════════════════════════════════════════
-- KACHA BROTHERS HR — Patch: Role CRUD RPCs (Phase 4b)
--
-- เพิ่ม 3 RPC เพื่อให้ admin สร้าง/แก้/ลบ role ผ่าน UI
-- - create_role(id, label_th, badge_class, description, clone_from)
-- - update_role(id, label_th, badge_class, description)
-- - delete_role(id, migrate_to_role)
--
-- Safety:
-- - ต้องมี permission 'permission.edit_matrix' (default = admin)
-- - is_system role ลบไม่ได้, แก้ id ไม่ได้ (แต่แก้ label ได้)
-- - ลบ role ที่ยังมี user → ต้อง migrate ไป role อื่นก่อน (atomic)
-- - max 15 roles
-- - id ต้องเป็น snake_case (เช่น 'junior_hr')
--
-- รันหลัง supabase-migration-permissions-v1.sql (และ patch-critical)
-- ═══════════════════════════════════════════════════════════

-- ── create_role: สร้าง role ใหม่ + (option) clone permissions จาก role ที่มีอยู่ ──
CREATE OR REPLACE FUNCTION public.create_role(
  p_id           TEXT,
  p_label_th     TEXT,
  p_badge_class  TEXT DEFAULT '',
  p_description  TEXT DEFAULT '',
  p_clone_from   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
  v_next_sort INTEGER;
BEGIN
  -- authz
  IF NOT public.user_has_permission('permission.edit_matrix') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการ role';
  END IF;

  -- validate inputs
  IF p_id IS NULL OR length(trim(p_id)) = 0 THEN
    RAISE EXCEPTION 'role id ห้ามว่าง';
  END IF;
  IF NOT (p_id ~ '^[a-z][a-z0-9_]{1,31}$') THEN
    RAISE EXCEPTION 'role id ต้องเป็น snake_case (a-z, 0-9, _) ขึ้นต้นด้วยตัวอักษร — เช่น junior_hr';
  END IF;
  IF p_label_th IS NULL OR length(trim(p_label_th)) = 0 THEN
    RAISE EXCEPTION 'label_th ห้ามว่าง';
  END IF;

  -- กัน duplicate
  IF EXISTS (SELECT 1 FROM public.roles WHERE id = p_id) THEN
    RAISE EXCEPTION 'role id "%" มีอยู่แล้ว', p_id;
  END IF;

  -- max 15 roles
  SELECT COUNT(*) INTO v_count FROM public.roles;
  IF v_count >= 15 THEN
    RAISE EXCEPTION 'เกินจำนวน role สูงสุด (15 role)';
  END IF;

  -- หา sort_order ถัดไป
  SELECT COALESCE(MAX(sort_order), 0) + 10 INTO v_next_sort FROM public.roles;

  -- insert role ใหม่ (is_system = false → ลบ/แก้ได้)
  INSERT INTO public.roles (id, label_th, badge_class, description, is_system, is_protected, sort_order)
  VALUES (p_id, p_label_th, COALESCE(p_badge_class, ''), COALESCE(p_description, ''), false, false, v_next_sort);

  -- clone permissions จาก role ที่มี (ถ้าระบุ)
  IF p_clone_from IS NOT NULL AND length(trim(p_clone_from)) > 0 THEN
    IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id = p_clone_from) THEN
      RAISE EXCEPTION 'ไม่พบ role ต้นแบบ: %', p_clone_from;
    END IF;
    INSERT INTO public.role_permissions (role_id, permission_key, granted, updated_by)
    SELECT p_id, permission_key, granted, auth.uid()
    FROM public.role_permissions
    WHERE role_id = p_clone_from AND granted = true;
  END IF;

  RETURN jsonb_build_object('id', p_id, 'cloned_from', p_clone_from);
END $$;
GRANT EXECUTE ON FUNCTION public.create_role(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── update_role: แก้ label / badge / description (id แก้ไม่ได้) ──
CREATE OR REPLACE FUNCTION public.update_role(
  p_id           TEXT,
  p_label_th     TEXT,
  p_badge_class  TEXT DEFAULT '',
  p_description  TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.user_has_permission('permission.edit_matrix') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการ role';
  END IF;
  IF p_label_th IS NULL OR length(trim(p_label_th)) = 0 THEN
    RAISE EXCEPTION 'label_th ห้ามว่าง';
  END IF;
  UPDATE public.roles
  SET label_th    = p_label_th,
      badge_class = COALESCE(p_badge_class, ''),
      description = COALESCE(p_description, '')
  WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ role: %', p_id;
  END IF;
  RETURN jsonb_build_object('id', p_id, 'updated', true);
END $$;
GRANT EXECUTE ON FUNCTION public.update_role(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── delete_role: ลบ role + migrate user ที่ใช้ไป role อื่น (atomic) ──
CREATE OR REPLACE FUNCTION public.delete_role(
  p_id              TEXT,
  p_migrate_to_role TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role         public.roles%ROWTYPE;
  v_user_count   INTEGER;
  v_migrated     INTEGER := 0;
BEGIN
  IF NOT public.user_has_permission('permission.edit_matrix') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการ role';
  END IF;

  SELECT * INTO v_role FROM public.roles WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ role: %', p_id;
  END IF;
  IF v_role.is_system THEN
    RAISE EXCEPTION 'ลบ system role ไม่ได้ (%)', p_id;
  END IF;

  -- เช็คว่ามี user ใช้ role นี้ไหม
  SELECT COUNT(*) INTO v_user_count FROM public.user_profiles WHERE role = p_id;

  -- ถ้ามี user → ต้องมี migration target
  IF v_user_count > 0 THEN
    IF p_migrate_to_role IS NULL OR length(trim(p_migrate_to_role)) = 0 THEN
      RAISE EXCEPTION 'role "%" มีผู้ใช้ % คน — ต้องระบุ role ปลายทางเพื่อ migrate', p_id, v_user_count;
    END IF;
    IF p_migrate_to_role = p_id THEN
      RAISE EXCEPTION 'migrate_to_role ต้องไม่ใช่ role เดียวกับที่ลบ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id = p_migrate_to_role) THEN
      RAISE EXCEPTION 'ไม่พบ role ปลายทาง: %', p_migrate_to_role;
    END IF;
    UPDATE public.user_profiles SET role = p_migrate_to_role WHERE role = p_id;
    GET DIAGNOSTICS v_migrated = ROW_COUNT;
  END IF;

  -- ลบ role (role_permissions cascade)
  DELETE FROM public.roles WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'migrated_users', v_migrated, 'migrated_to', p_migrate_to_role);
END $$;
GRANT EXECUTE ON FUNCTION public.delete_role(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════
-- หลังรัน patch นี้ → UI matrix editor จะ enable ปุ่ม + Role / แก้ / ลบ
-- ═══════════════════════════════════════════════════════════
