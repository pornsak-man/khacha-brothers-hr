-- ═══════════════════════════════════════════════════════════
-- วินิจฉัย: "ผู้จัดตารางงาน" (branch_manager) ของสาขา คนละสายงานกับพนักงาน
--
-- บริบท: หน้า "ตารางงาน" แสดง "ผู้จัดตาราง" = getScheduleCreators(branchId)
--   = พนักงานที่ role='branch_manager' และผูกกับสาขานั้น
--     (managed_branches มีสาขานี้  หรือ  ถ้าไม่ตั้ง managed_branches → employees.branch = สาขานี้)
--   ★ ตรรกะนี้ "ไม่ดูสายงาน (scope) เลย" → ใครเป็น ผจก.สาขา ก็ขึ้นให้พนักงานทุกสายในสาขานั้น
--
-- รันใน Supabase SQL Editor (อ่านอย่างเดียว ไม่แก้ข้อมูล)
-- ═══════════════════════════════════════════════════════════

-- ════════ Q1. เจาะเคส 5457 ↔ 5281 — ทำไม 5281 ขึ้นเป็นผู้จัดตารางของ 5457 ════════
SELECT up.employee_id                                   AS รหัส,
       btrim(coalesce(e.first_name,'')||' '||coalesce(e.last_name,'')) AS ชื่อ,
       up.role                                          AS role,
       e.branch                                         AS สาขา_ในทะเบียน,
       up.managed_branches                              AS สาขาที่ดูแล,
       COALESCE(pl.scope, d.scope)                      AS สายงาน
FROM public.user_profiles up
JOIN public.employees e        ON e.id = up.employee_id
LEFT JOIN public.position_levels pl ON pl.id = e.position
LEFT JOIN public.departments     d  ON d.id = e.department
WHERE up.employee_id IN ('5457','5281');
-- อ่านผล: ดูว่า 5281 role=branch_manager แล้ว "สาขาที่ดูแล" (หรือ สาขา_ในทะเบียน)
--   ครอบสาขาเดียวกับ 5457 ไหม → ถ้าใช่ นั่นคือเหตุผลที่ขึ้นเป็นผู้จัดตาราง
--   ถ้า "สายงาน" ของ 5281 (เช่น office) ต่างจาก 5457 (operation) = เคสที่รายงาน


-- ════════ Q2. หากรณีแบบเดียวกัน "ทั้งระบบ" ════════
-- แต่ละสาขา: ใครเป็นผู้จัดตาราง (BM) + สายงานของเขา เทียบกับจำนวนพนักงานแต่ละสายในสาขา
-- แถวที่ ผจก.ไม่ใช่สาย operation แต่สาขามีพนักงาน operation = "คนละสายงาน" (เด้งขึ้นบนสุด)
WITH bm AS (
  SELECT up.employee_id AS bm_id,
         btrim(coalesce(e.first_name,'')||' '||coalesce(e.last_name,'')) AS bm_name,
         COALESCE(pl.scope, d.scope) AS bm_scope,
         CASE WHEN up.managed_branches IS NOT NULL AND array_length(up.managed_branches,1) > 0
              THEN up.managed_branches
              ELSE ARRAY[e.branch] END AS branches
  FROM public.user_profiles up
  JOIN public.employees e        ON e.id = up.employee_id
  LEFT JOIN public.position_levels pl ON pl.id = e.position
  LEFT JOIN public.departments     d  ON d.id = e.department
  WHERE up.role = 'branch_manager'
    AND coalesce(e.status,'active') <> 'resigned'
),
bm_b AS (SELECT bm_id, bm_name, bm_scope, unnest(branches) AS branch FROM bm)
SELECT b.branch                                                          AS สาขา,
       b.bm_id                                                           AS "รหัส ผจก.",
       b.bm_name                                                         AS "ชื่อ ผจก.",
       b.bm_scope                                                        AS "สาย ผจก.",
       count(e.id) FILTER (WHERE COALESCE(pl.scope,d.scope)='operation') AS "พนง.ปฏิบัติการในสาขา",
       count(e.id) FILTER (WHERE COALESCE(pl.scope,d.scope)='office')    AS "พนง.สำนักงานในสาขา",
       CASE WHEN b.bm_scope IS DISTINCT FROM 'operation'
             AND count(e.id) FILTER (WHERE COALESCE(pl.scope,d.scope)='operation') > 0
            THEN '⚠ คนละสาย' ELSE '' END                                AS หมายเหตุ
FROM bm_b b
LEFT JOIN public.employees e        ON e.branch = b.branch AND coalesce(e.status,'active') <> 'resigned'
LEFT JOIN public.position_levels pl ON pl.id = e.position
LEFT JOIN public.departments     d  ON d.id = e.department
GROUP BY b.branch, b.bm_id, b.bm_name, b.bm_scope
ORDER BY (b.bm_scope IS DISTINCT FROM 'operation'
          AND count(e.id) FILTER (WHERE COALESCE(pl.scope,d.scope)='operation') > 0) DESC,
         b.branch;


-- ════════ Q3. (เสริม) สาขาที่มี ผจก.สาขา > 1 คน (ผู้จัดตารางขึ้นหลายชื่อ) ════════
WITH bm_b AS (
  SELECT up.employee_id AS bm_id,
         unnest(CASE WHEN up.managed_branches IS NOT NULL AND array_length(up.managed_branches,1) > 0
                     THEN up.managed_branches ELSE ARRAY[e.branch] END) AS branch
  FROM public.user_profiles up
  JOIN public.employees e ON e.id = up.employee_id
  WHERE up.role = 'branch_manager' AND coalesce(e.status,'active') <> 'resigned'
)
SELECT branch AS สาขา, count(*) AS จำนวนผจก, array_agg(bm_id) AS รหัสผจก
FROM bm_b GROUP BY branch HAVING count(*) > 1 ORDER BY count(*) DESC;


-- ════════ Q4. หา "พนักงานแบบ 5457" ทั้งระบบ ════════
-- พนักงานที่สายงานตัวเอง "ไม่ใช่ operation" (office / ยังไม่ระบุสาย / สายอื่น)
-- แต่ branch อยู่สาขาที่มี ผจก.สาขา (ตารางกะ operation) → เปิดหน้าตารางจะเห็น
-- ผจก.สาขา (operation) เป็น "ผู้จัดตาราง" ทั้งที่คนละสาย (เหมือนเคส 5457)
WITH bm_branch AS (
  SELECT DISTINCT unnest(CASE WHEN up.managed_branches IS NOT NULL AND array_length(up.managed_branches,1) > 0
                              THEN up.managed_branches ELSE ARRAY[e.branch] END) AS branch
  FROM public.user_profiles up
  JOIN public.employees e ON e.id = up.employee_id
  WHERE up.role = 'branch_manager' AND coalesce(e.status,'active') <> 'resigned'
)
SELECT e.id                              AS รหัส,
       btrim(coalesce(e.first_name,'')||' '||coalesce(e.last_name,'')) AS ชื่อ,
       e.branch                          AS สาขา,
       COALESCE(pl.scope, d.scope)       AS สายงาน,
       e.position                        AS รหัสตำแหน่ง,
       e.position_title                  AS ตำแหน่ง,
       up.role                           AS role_login
FROM public.employees e
LEFT JOIN public.position_levels pl ON pl.id = e.position
LEFT JOIN public.departments     d  ON d.id = e.department
LEFT JOIN public.user_profiles   up ON up.employee_id = e.id
WHERE coalesce(e.status,'active') <> 'resigned'
  AND e.branch IN (SELECT branch FROM bm_branch)
  AND COALESCE(pl.scope, d.scope) IS DISTINCT FROM 'operation'   -- สายตัวเองไม่ใช่ operation
ORDER BY e.branch, (COALESCE(pl.scope, d.scope) IS NULL) DESC, e.id;
-- ถ้าผลว่าง = ไม่มีเคสอื่น (5457 อาจเป็นรายเดียว) · ถ้ามีหลายแถว = เคสแบบเดียวกันที่เหลือ
-- คอลัมน์ "สายงาน" ว่าง (NULL) = พนักงานยังไม่ถูกตั้งสาย (ตำแหน่ง/ฝ่ายไม่มี scope) → ควรไปตั้งให้ถูก
