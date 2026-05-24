/* ═══════════════════════════════════════════════════════════
   KACHA BROTHERS HR — DATA LAYER (Supabase)
   - ใช้ Supabase สำหรับ auth + storage + realtime
   - cache ข้อมูลใน memory เพื่อให้ getter sync ได้
   - มี realtime subscription คอยอัปเดต cache อัตโนมัติ
   ═══════════════════════════════════════════════════════════ */

const DB = {
  client: null,
  user: null,
  profile: null,
  isAdmin: false,
  ready: false,

  data: {
    company: { name: 'บริษัท คชา บราเธอร์ส จำกัด', nameEn: 'Kacha Brothers Co., Ltd.', taxId: '', address: '', phone: '', email: '' },
    departments: [],
    positionLevels: [],
    positionScopes: [],
    employees: [],
    salaryHistory: [],
    loans: [],
    advances: [],
    allowances: [],
    evaluations: [],
    calendar: [],
    applicants: [],
    uniformItems: [],
    uniformRequests: [],
    uniformIssues: [],
    uniformSchedule: [],
    branches: [],
    leaveRequests: [],
    leaveTypes: [],
    holidaySwapRequests: [],
    announcements: []
  },

  // ─── INDEX CACHES (O(1) lookup; rebuild lazily after data change) ───
  _empIndex: null,
  _deptIndex: null,
  _posIndex: null,
  // ─── STATS CACHE (memoize expensive computations) ───
  // คีย์ = `{method}:{params}:{dataVersion}` — เพิ่ม dataVersion เมื่อ data เปลี่ยน
  // → invalidate อัตโนมัติเมื่อ realtime update / save methods เรียก _invalidateIndex
  _statsCache: new Map(),
  _dataVersion: 0,
  _invalidateIndex(table) {
    if (table === 'employees' || !table) this._empIndex = null;
    if (table === 'departments' || !table) this._deptIndex = null;
    if (table === 'position_levels' || !table) this._posIndex = null;
    // Stats cache invalidate — table ที่กระทบ stats: employees, positions, depts, leaves, scopes
    const statsAffected = ['employees', 'position_levels', 'departments', 'leave_requests', 'position_scopes'];
    if (!table || statsAffected.includes(table)) {
      this._dataVersion++;
      this._statsCache.clear();
    }
  },
  // Memoize wrapper สำหรับ stats methods — เก็บ Map ไม่เกิน 50 entries (LRU-ish: ลบที่เก่าสุดออก)
  _cachedStats(key, computeFn) {
    const cacheKey = `${this._dataVersion}:${key}`;
    if (this._statsCache.has(cacheKey)) {
      // touch — เลื่อนไป end ของ insertion order (รักษา hot entries)
      const v = this._statsCache.get(cacheKey);
      this._statsCache.delete(cacheKey);
      this._statsCache.set(cacheKey, v);
      return v;
    }
    const result = computeFn();
    this._statsCache.set(cacheKey, result);
    if (this._statsCache.size > 50) {
      // ลบ entry แรกสุด (เก่าสุดตาม insertion order)
      const firstKey = this._statsCache.keys().next().value;
      this._statsCache.delete(firstKey);
    }
    return result;
  },

  // ─── INIT / AUTH ───
  async init() {
    if (typeof supabase === 'undefined') throw new Error('Supabase SDK not loaded');
    const { SUPABASE_URL, SUPABASE_KEY } = window.KB_CONFIG;
    this.client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });

    const { data: { session } } = await this.client.auth.getSession();
    if (session?.user) {
      this.user = session.user;
      // ─── PERF: ยิง loadProfile + loadAll คู่ขนาน (เดิม serial) ───
      // loadAll ใช้ profile แค่ใน fetchMyAnnReads — รอ profilePromise ภายในตัวเอง
      // → กำไร 1 round-trip ของ loadProfile (100-300ms) ใน critical path login
      const profilePromise = this.loadProfile();
      await Promise.all([profilePromise, this.loadAll(profilePromise)]);
      this.subscribeRealtime();
      this.ready = true;
    }

    this.client.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        this.user = null;
        this.profile = null;
        this.isAdmin = false;
        this.ready = false;
      }
    });
  },

  // ─── hCaptcha invisible widget ───
  // ขอ token ก่อนเรียก auth endpoint ที่ต้องการ captcha (signIn, signUp ใน Supabase)
  // SITE_KEY ว่าง = ปิด captcha (สำหรับ dev/local) → คืน undefined → Supabase ไม่ require
  _hcaptchaWidgetId: null,
  async _getCaptchaToken(actionLabel = 'auth') {
    const siteKey = window.KB_CONFIG?.HCAPTCHA_SITE_KEY;
    if (!siteKey) return undefined;  // ปิด captcha
    // รอจน hCaptcha API พร้อม (lazy-loaded script)
    const ready = await new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        if (window.hcaptcha?.render && window.hcaptcha?.execute) return resolve(true);
        if (++tries > 100) return resolve(false);  // 10s timeout
        setTimeout(check, 100);
      };
      check();
    });
    if (!ready) throw new Error('Captcha ยังโหลดไม่เสร็จ — ลองใหม่ในอีกครู่');
    // render widget ครั้งแรก (reuse ครั้งต่อๆ ไป)
    if (this._hcaptchaWidgetId === null) {
      const container = document.getElementById('hcaptcha-container')
        || (() => { const d = document.createElement('div'); d.id = 'hcaptcha-container'; d.style.display = 'none'; document.body.appendChild(d); return d; })();
      this._hcaptchaWidgetId = window.hcaptcha.render(container, { sitekey: siteKey, size: 'invisible' });
    }
    // ขอ token (invisible mode — ปกติไม่มี challenge ขึ้น, ถ้า traffic น่าสงสัยอาจมี)
    const { response } = await window.hcaptcha.execute(this._hcaptchaWidgetId, { async: true });
    return response;
  },

  async signIn(email, password) {
    const captchaToken = await this._getCaptchaToken('signIn');
    const { data, error } = await this.client.auth.signInWithPassword({
      email, password,
      options: captchaToken ? { captchaToken } : undefined
    });
    if (error) throw error;
    this.user = data.user;
    // PERF: parallel เหมือนใน init() — โหลด data ทันทีไม่รอ profile เสร็จ
    const profilePromise = this.loadProfile();
    await Promise.all([profilePromise, this.loadAll(profilePromise)]);
    this.subscribeRealtime();
    this.ready = true;
    return data.user;
  },

  async signOut() {
    await this.client.auth.signOut();
    this.user = null;
    this.profile = null;
    this.isAdmin = false;
    this._asEmployee = false;
    try { sessionStorage.removeItem('kb_as_employee'); } catch (e) {}
    this.ready = false;
  },

  async loadProfile() {
    if (!this.user) return;
    const { data } = await this.client.from('user_profiles').select('*').eq('user_id', this.user.id).maybeSingle();
    this.profile = data;
    this.role = data?.role || 'viewer';
    this.isAdmin = this.role === 'admin';                          // เฉพาะ admin
    this.isHR    = this.role === 'admin' || this.role === 'hr';    // admin + hr
    this._managedBranches = Array.isArray(data?.managed_branches) ? data.managed_branches.filter(Boolean) : [];
    // restore "ดูเสมือนพนักงาน" จาก session (กรณีรีเฟรชหน้า) — เฉพาะ HR ที่ผูก employee_id
    try {
      const flag = sessionStorage.getItem('kb_as_employee') === '1';
      this._asEmployee = flag && this.isHR && !!this.profile?.employee_id;
    } catch (e) { this._asEmployee = false; }
  },

  // ─── EMPLOYEE-VIEW MODE (impersonation) ───
  // HR/admin สลับมุมมองเป็น "เสมือนพนักงาน" เพื่อขอลา / ดูยอดวันลา ตารางกะ ฯลฯ ของตัวเอง
  // โดยไม่ต้อง logout/login ใหม่ — สิทธิ์เขียน/แก้ยังเป็น HR เหมือนเดิม (UI behavior เท่านั้น)
  isViewingAsEmployee() {
    return !!this._asEmployee && this.isHR && !!this.profile?.employee_id;
  },
  setEmployeeView(on) {
    const enabled = !!on && this.isHR && !!this.profile?.employee_id;
    this._asEmployee = enabled;
    try {
      if (enabled) sessionStorage.setItem('kb_as_employee', '1');
      else sessionStorage.removeItem('kb_as_employee');
    } catch (e) {}
    return enabled;
  },

  // ─── PERMISSION HELPERS (ตาม matrix) ───
  // admin + hr ทำได้เหมือนกัน ยกเว้น "ตั้งค่าระบบ" (company settings) = admin only
  canEdit()         { return this.isHR; },
  canDelete()       { return this.isHR; },
  canSeeSalary()    { return this.isHR; },
  canEditMaster()   { return this.isHR; },
  canManageUsers()  { return this.isHR; },         // HR ตั้งสิทธิ์/จัดการ user ได้
  canEditCompany()  { return this.isAdmin; },      // "ตั้งค่าระบบ" company info = admin only
  canSeeAudit()     { return this.isHR; },
  canManageBlacklist() { return this.isHR; },  // จัดการ blacklist เฉพาะ admin/HR
  canApproveLeave() {
    return ['admin', 'hr', 'operation_manager', 'area_manager', 'branch_manager'].includes(this.role);
  },

  // ─── SCOPE FILTER (สาขาที่ดูแลได้) ───
  // คืน array ของ branch IDs ที่ user ดูแล หรือ null = ทุกสาขา (no filter)
  scopedBranches() {
    if (this.role === 'admin' || this.role === 'hr' || this.role === 'operation_manager') return null;
    if (this.role === 'area_manager') {
      // override: ถ้า admin กำหนด managed_branches → ใช้ตามนั้น
      if (this._managedBranches.length) return this._managedBranches;
      // auto: ใช้สาขาของตัวเอง (Area Manager ที่ยังไม่ override จะดูได้สาขาเดียวก่อน)
      const myBranch = this._myBranch();
      return myBranch ? [myBranch] : [];
    }
    if (this.role === 'branch_manager') {
      const myBranch = this._myBranch();
      return myBranch ? [myBranch] : [];
    }
    // branch_staff / viewer → ดูได้เฉพาะตัวเอง — return empty array → caller จัดการเอง
    return [];
  },
  _myBranch() {
    if (!this.profile?.employee_id) return null;
    const e = this.getEmployee?.(this.profile.employee_id);
    return e?.branch || null;
  },

  // ตรวจว่า employee อยู่ใน scope ของ user ปัจจุบันไหม
  isInScope(employee) {
    if (!employee) return false;
    const scoped = this.scopedBranches();
    if (scoped === null) return true; // admin/hr/op_manager เห็นทุกคน
    if (this.role === 'branch_staff' || this.role === 'viewer') {
      // ดูได้เฉพาะตัวเอง
      return employee.id === this.profile?.employee_id;
    }
    return scoped.includes(employee.branch);
  },

  // ─── AUTO-DETECT ROLE จาก positionTitle ของพนักงาน ───
  // ใช้เมื่อสร้างพนักงานใหม่ (auto-create account) หรือ bulk import จาก Excel
  // คืน role ที่ derived; default = 'branch_staff' (ปลอดภัยที่สุด) ถ้าไม่ match อะไรชัดเจน
  //
  // กฎความปลอดภัย:
  //   1. ตำแหน่ง junior/ฝึกงาน/ผู้ช่วย → ห้าม promote เป็น manager/hr (ป้องกัน "HR Intern" ได้สิทธิ์ HR)
  //   2. ใช้ word-boundary regex (Latin + Thai) แทน partial match
  //      → "Senior Operation Specialist" จะไม่ match "operation manager"
  //      → "HR Officer" ยัง match "hr" ปกติ (word เดี่ยว)
  autoDetectRole(employee) {
    if (!employee) return null;
    const title = (employee.positionTitle || '').toLowerCase().trim();
    const dept  = (employee.department || '').toUpperCase();

    // ── Guardrail: ตำแหน่งระดับ junior → ไม่อนุญาตให้ promote เป็น manager/HR อัตโนมัติ ──
    // คำเหล่านี้บ่งชี้ว่ายังไม่ใช่ตำแหน่งเต็ม → ต้องตั้ง role manually ทีหลัง
    if (/(intern|trainee|junior|jr\b|assistant|asst\b|helper|ฝึกงาน|ฝึกหัด|ผู้ช่วย|ทดลอง|รุ่นใหม่)/i.test(title)) {
      return 'branch_staff';
    }

    // ── helper: word-boundary match รองรับ Latin (a-z0-9) + Thai (ก-๙) ──
    const matchWord = (pat) => new RegExp(`(^|[^a-z0-9ก-๙])(?:${pat})($|[^a-z0-9ก-๙])`, 'i').test(title);

    // HR: department = D002 (ฝ่ายบุคคล) เชื่อถือได้ที่สุด — เป็น authoritative
    if (dept === 'D002') return 'hr';
    if (matchWord('hr|human\\s*resources?|ฝ่ายบุคคล|บุคคล')) return 'hr';

    // Operation Manager — ต้องเป็นคำเต็ม ไม่ใช่ "operation" ลำพัง
    if (matchWord('operations?\\s*(manager|director|head|มง|mng)|ผู้จัดการ(\\s*ฝ่าย)?\\s*ปฏิบัติการ|om')) return 'operation_manager';

    // Area Manager
    if (matchWord('area\\s*(manager|director|head|มง|mng)|ผู้จัดการเขต|am')) return 'area_manager';

    // Branch Manager / Store Manager
    if (matchWord('branch\\s*(manager|director|head|มง|mng)|store\\s*manager|ผู้จัดการสาขา|ผู้จัดการร้าน|bm')) return 'branch_manager';

    // default = พนักงานสาขาทั่วไป
    return 'branch_staff';
  },

  // ─── DATA LOAD ───
  // Supabase default คืน max 1000 rows ต่อ query — ใช้ pagination ดึงทุก batch ต่อเนื่อง
  async _fetchAllPages(table, orderField, ascending = true) {
    const PAGE = 1000;
    const all = [];
    let from = 0;
    while (true) {
      const { data, error } = await this.client
        .from(table)
        .select('*')
        .order(orderField, { ascending })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  },

  async loadAll(profilePromise = null) {
    // ─── PERF: per-query timing — log to console + window.__bootTimings ───
    // ดูได้ใน DevTools Console; เก็บไว้ใน window.__bootTimings สำหรับ debug
    const _bootT0 = performance.now();
    window.__bootTimings = { _start: _bootT0, queries: {}, phases: {} };
    const timed = (label, p) => {
      const t0 = performance.now();
      return Promise.resolve(p).then(
        (r) => { const ms = performance.now() - t0; window.__bootTimings.queries[label] = Math.round(ms); return r; },
        (e) => { const ms = performance.now() - t0; window.__bootTimings.queries[label] = Math.round(ms) + ' (err)'; throw e; }
      );
    };
    // ─── Phase 1 (critical) — รวม Promise.all เดียวให้ parallel สูงสุด ───
    // เฉพาะ table ที่ dashboard + sidebar badges ต้องใช้ทันที
    // (5 queries ที่ใช้เฉพาะหน้า leave/calendar/swap/settings ย้ายไป Phase 2)
    //
    // Optimization: โหลด employees เฉพาะ active + พ้นสภาพไม่เกิน 1 ปีย้อนหลัง
    //   พนักงานเก่ากว่านั้น (เก็บประวัติยาว) → load Phase 2 background
    //   ผลลัพธ์: ลด employees ที่โหลดจาก 5000 → ~700 (active 500 + recent resigned 200)
    const oneYearAgo = (() => {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    // _fetchAllPagesFiltered: เหมือน _fetchAllPages แต่รับ extra filter callback
    const fetchEmployeesActive = async () => {
      const PAGE = 1000;
      const all = [];
      let from = 0;
      while (true) {
        // [Security M1] อ่านผ่าน employees_view ที่ mask sensitive cols (salary, ปชช, bank, ฯลฯ)
        // สำหรับ non-HR → DB คืน NULL, HR คืนค่าจริง (CASE ใน view)
        const { data, error } = await this.client.from('employees_view')
          .select('*').order('id', { ascending: true })
          .or(`termination_date.is.null,termination_date.gte.${oneYearAgo}`)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return all;
    };

    // โหลด read receipts ของพนักงานคนนี้ — สำหรับ unread badge
    // โหลดให้ HR ด้วย เพื่อรองรับโหมด "ดูเสมือนพนักงาน" (query ขนาดเล็ก — filter by employee_id)
    // PERF: ถ้าผู้เรียกส่ง profilePromise มา → loadAll ยิงคู่ขนานกับ loadProfile,
    //       fetchMyAnnReads รอ profile เฉพาะตอนใช้ (other queries เริ่มทันที)
    const fetchMyAnnReads = async () => {
      if (profilePromise) { try { await profilePromise; } catch (e) { /* profile fail → no reads */ } }
      if (!this.profile?.employee_id) return [];
      const { data } = await this.client.from('announcement_reads')
        .select('announcement_id')
        .eq('employee_id', this.profile.employee_id);
      return data || [];
    };

    const critical = await Promise.all([
      timed('departments',     this.client.from('departments').select('*').order('id')),
      timed('position_levels', this.client.from('position_levels').select('*').order('id')),
      timed('employees',       fetchEmployeesActive()),
      timed('branches',        this._fetchAllPages('branches', 'id', true).catch(() => [])),
      timed('user_profiles',   this.client.from('user_profiles').select('*').then(r => r.data || [], () => [])),
      timed('announcements',   this._fetchAllPages('company_announcements', 'created_at', false).catch(() => [])),
      timed('ann_reads',       fetchMyAnnReads().catch(() => [])),
      timed('position_scopes', this._fetchAllPages('position_scopes', 'sort_order', true).catch(() => []))
    ]);
    const [deps, pos, emps, branchRows, ups, anns, myReads, scopes] = critical;
    window.__bootTimings.phases.phase1_total = Math.round(performance.now() - _bootT0);

    this.data.departments = (deps.data || []).map(this._depFromDB);
    this.data.positionLevels = (pos.data || []).map(this._posFromDB);
    this.data.positionScopes = (scopes || []).map(this._scopeFromDB);
    this.data.employees = emps.map(this._empFromDB);
    this.data.branches = (branchRows || []).map(this._branchFromDB);
    this.data.announcements = (anns || []).map(this._annFromDB);
    this._userProfiles = ups || [];
    this._myAnnReads = new Set((myReads || []).map(r => r.announcement_id));

    this._invalidateIndex();

    // ─── PERF: log boot timings ทันทีหลัง Phase 1 เสร็จ (dashboard render ต่อ) ───
    // เปิด DevTools Console เห็นว่า query ไหนช้า / ส่ง screenshot/log มาบอกได้
    try {
      const t = window.__bootTimings;
      const slowest = Object.entries(t.queries).sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0))[0];
      console.log('%c⏱ Boot Phase 1 done in ' + t.phases.phase1_total + ' ms', 'color:#2e74ff;font-weight:bold');
      console.table(t.queries);
      if (slowest) console.log(`%c  slowest query: ${slowest[0]} (${slowest[1]} ms)`, 'color:#dc2626');
    } catch (e) {}

    // ─── Phase 2 (deferred) — โหลดเบื้องหลังไม่ block login ───
    // ใช้ตอนผู้ใช้กดเข้าหน้าที่ต้องการ (เงินเดือน, ลา, จัดชุด, ฯลฯ)
    // + พนักงานที่พ้นสภาพ > 1 ปีย้อนหลัง (เก็บประวัติยาว)
    // ถ้าผู้ใช้กดก่อนโหลดเสร็จ → ตารางจะค่อยๆ populated เมื่อ promise resolve
    const fetchEmployeesArchive = async () => {
      const PAGE = 1000;
      const all = [];
      let from = 0;
      while (true) {
        // [Security M1] ผ่าน view เช่นเดียวกับ active fetch
        const { data, error } = await this.client.from('employees_view')
          .select('*').order('id', { ascending: true })
          .not('termination_date', 'is', null)
          .lt('termination_date', oneYearAgo)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return all;
    };

    const _p2T0 = performance.now();
    this._secondaryLoadPromise = Promise.all([
      // ─── จาก Phase 1 (เดิม block login) ย้ายมา Phase 2 — ไม่จำเป็นต่อ dashboard ───
      timed('calendar_items',          this.client.from('calendar_items').select('*').order('date').catch(() => ({ data: [] }))),
      timed('company_settings',        this.client.from('company_settings').select('*').eq('id', 1).maybeSingle().catch(() => ({ data: null }))),
      timed('leave_requests',          this._fetchAllPages('leave_requests', 'start_date', false).catch(() => [])),
      timed('leave_types',             this._fetchAllPages('leave_types', 'sort_order', true).catch(() => [])),
      timed('holiday_swap_requests',   this._fetchAllPages('holiday_swap_requests', 'requested_at', false).catch(() => [])),
      // ─── เดิม Phase 2 ───
      timed('loans',                   this._fetchAllPages('loans', 'date', false).catch(() => [])),
      timed('advances',                this._fetchAllPages('advances', 'date', false).catch(() => [])),
      timed('allowances',              this._fetchAllPages('allowances', 'month', false).catch(() => [])),
      timed('evaluations',             this._fetchAllPages('evaluations', 'date', false).catch(() => [])),
      timed('salary_history',          this._fetchAllPages('salary_history', 'date', false).catch(() => [])),
      timed('applicants',              this._fetchAllPages('applicants', 'applied_date', false).catch(() => [])),
      timed('uniform_items',           this._fetchAllPages('uniform_items', 'name', true).catch(() => [])),
      timed('uniform_requests',        this._fetchAllPages('uniform_requests', 'requested_date', false).catch(() => [])),
      timed('uniform_issues',          this._fetchAllPages('uniform_issues', 'issued_date', false).catch(() => [])),
      timed('uniform_delivery_sched',  this._fetchAllPages('uniform_delivery_schedule', 'branch_code', true).catch(() => [])),
      timed('role_permission_matrix',  this.client.from('role_permission_matrix').select('*').order('sort_order').then(r => r.data || [], () => [])),
      timed('employees_archive',       fetchEmployeesArchive().catch(() => []))
    ]).then(([cal, comp, leaves, lvTypes, swapReqs,
              loans, advs, allow, evals, sal, appls,
              uniItems, uniReqs, uniIssues, uniSched, rm, oldEmps]) => {
      // ใหม่: ตาราง critical-but-not-dashboard ที่ย้ายมา
      this.data.calendar = ((cal && cal.data) || []).map(this._calFromDB);
      if (comp && comp.data) this.data.company = this._compFromDB(comp.data);
      this.data.leaveRequests = (leaves || []).map(this._leaveFromDB);
      this.data.leaveTypes = (lvTypes || []).map(this._leaveTypeFromDB);
      this.data.holidaySwapRequests = (swapReqs || []).map(this._swapReqFromDB);
      // เดิม
      this.data.loans = loans.map(this._loanFromDB);
      this.data.advances = advs.map(this._advFromDB);
      this.data.allowances = allow.map(this._allowFromDB);
      this.data.evaluations = evals.map(this._evalFromDB);
      this.data.salaryHistory = sal.map(this._salFromDB);
      this.data.applicants = appls.map(this._applFromDB);
      this.data.uniformItems = uniItems.map(this._uniItemFromDB);
      this.data.uniformRequests = uniReqs.map(this._uniReqFromDB);
      this.data.uniformIssues = uniIssues.map(this._uniIssueFromDB);
      this.data.uniformSchedule = uniSched.map(this._uniSchedFromDB);
      this.data.roleMatrix = rm.map(this._matrixFromDB);
      // Merge employees เก่าเข้ากับ active employees (เรียง id เพื่อให้ stable)
      if (oldEmps.length) {
        const existingIds = new Set(this.data.employees.map(e => e.id));
        const newOldEmps = oldEmps.filter(e => !existingIds.has(e.id)).map(this._empFromDB);
        this.data.employees = [...this.data.employees, ...newOldEmps].sort((a, b) => a.id.localeCompare(b.id));
        this._invalidateIndex();
      }
      this._secondaryLoaded = true;
      window.__bootTimings.phases.phase2_total = Math.round(performance.now() - _p2T0);
      try { console.log('%c⏱ Boot Phase 2 done in ' + window.__bootTimings.phases.phase2_total + ' ms (background)', 'color:#16a34a'); } catch (e) {}
      // Refresh sidebar badges ที่อาศัย table ของ Phase 2 (leave / swap)
      try {
        if (typeof updateLeaveBadge === 'function') updateLeaveBadge();
        if (typeof updateCalendarBadge === 'function') updateCalendarBadge();
      } catch (e) { /* badges may not exist yet */ }
      // Re-render หน้าปัจจุบันถ้าผู้ใช้อยู่บนหน้าที่ใช้ secondary data
      // เพิ่ม: dashboard (personal), leave, calendar — ใช้ table ที่เพิ่ง defer
      if (typeof router !== 'undefined' && router.current) {
        const usesSecondary = ['loans', 'advances', 'allowance', 'evaluations', 'recruit', 'uniform', 'salary-adjust', 'employees',
                               'dashboard', 'leave', 'calendar'];
        if (usesSecondary.includes(router.current)) router.go(router.current);
      }
    }).catch(err => {
      console.warn('Secondary data load failed:', err);
    });
  },

  // ─── REALTIME ───
  subscribeRealtime() {
    if (this._channel) this._channel.unsubscribe();
    this._channel = this.client
      .channel('kb-hr-realtime')
      .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
        this._applyChange(payload);
        if (window.onRealtimeChange) window.onRealtimeChange(payload);
      })
      .subscribe();
  },

  _applyChange(payload) {
    const { table, eventType, new: newRow, old: oldRow } = payload;
    // announcement_reads — update local set (เฉพาะ rows ของตัวเอง)
    if (table === 'announcement_reads') {
      const myEmpId = this.profile?.employee_id;
      if (this._myAnnReads && myEmpId) {
        if (eventType === 'INSERT' && newRow?.employee_id === myEmpId) {
          this._myAnnReads.add(newRow.announcement_id);
        } else if (eventType === 'DELETE' && oldRow?.employee_id === myEmpId) {
          this._myAnnReads.delete(oldRow.announcement_id);
        }
      }
      return;
    }
    const map = {
      employees: { list: 'employees', from: this._empFromDB },
      departments: { list: 'departments', from: this._depFromDB },
      position_levels: { list: 'positionLevels', from: this._posFromDB },
      position_scopes: { list: 'positionScopes', from: this._scopeFromDB },
      loans: { list: 'loans', from: this._loanFromDB },
      advances: { list: 'advances', from: this._advFromDB },
      allowances: { list: 'allowances', from: this._allowFromDB },
      evaluations: { list: 'evaluations', from: this._evalFromDB },
      salary_history: { list: 'salaryHistory', from: this._salFromDB },
      calendar_items: { list: 'calendar', from: this._calFromDB },
      applicants: { list: 'applicants', from: this._applFromDB },
      uniform_items: { list: 'uniformItems', from: this._uniItemFromDB },
      uniform_requests: { list: 'uniformRequests', from: this._uniReqFromDB },
      uniform_issues: { list: 'uniformIssues', from: this._uniIssueFromDB },
      uniform_delivery_schedule: { list: 'uniformSchedule', from: this._uniSchedFromDB },
      branches: { list: 'branches', from: this._branchFromDB },
      leave_requests: { list: 'leaveRequests', from: this._leaveFromDB },
      leave_types: { list: 'leaveTypes', from: this._leaveTypeFromDB },
      holiday_swap_requests: { list: 'holidaySwapRequests', from: this._swapReqFromDB },
      company_announcements: { list: 'announcements', from: this._annFromDB }
    };
    const m = map[table];
    if (!m) return;
    const list = this.data[m.list];
    if (eventType === 'INSERT' && newRow) {
      if (!list.find(x => x.id === newRow.id)) list.unshift(m.from(newRow));
    } else if (eventType === 'UPDATE' && newRow) {
      const idx = list.findIndex(x => x.id === newRow.id);
      if (idx >= 0) list[idx] = m.from(newRow);
      else list.unshift(m.from(newRow));
    } else if (eventType === 'DELETE' && oldRow) {
      this.data[m.list] = list.filter(x => x.id !== oldRow.id);
    }
    this._invalidateIndex(table);
  },

  // ─── ROW MAPPERS (DB ↔ JS) ───
  // [Security M1] Defense-in-depth ฝั่ง JS — mask sensitive cols ถ้า caller ไม่ใช่ HR/admin
  //   - Initial fetch มาจาก employees_view (DB mask อยู่แล้ว) → ค่าเข้ามาเป็น NULL อยู่แล้ว
  //   - Realtime payload มาจากตาราง employees (RAW) → ต้อง mask ใน mapper เพื่อกัน leak
  //   - HR/admin → ส่งค่าจริงตามที่ได้จาก DB
  _empFromDB: (r) => {
    // Reference DB via top-level const (resolved at call time, not literal time)
    const hr = typeof DB !== 'undefined' && DB.isHR;
    return {
      id: r.id, title: r.title || '', firstName: r.first_name, lastName: r.last_name,
      nickname: r.nickname || '',
      nationalId: hr ? (r.national_id || '') : '',
      dob: r.dob || '', gender: r.gender || '',
      nationality: r.nationality || 'ไทย', religion: r.religion || '',
      education: r.education || '',
      phone: r.phone || '', email: r.email || '', address: r.address || '',
      subDistrict: r.sub_district || '', district: r.district || '',
      province: r.province || '', postalCode: r.postal_code || '',
      department: r.department || '', branch: r.branch || '',
      position: r.position || '', positionTitle: r.position_title || '',
      employeeType: r.employee_type || '',
      hireDate: r.hire_date || '',
      salary: hr ? Number(r.salary || 0) : 0,
      allowancePosition: hr ? Number(r.allowance_position || 0) : 0,
      allowanceTravel:   hr ? Number(r.allowance_travel   || 0) : 0,
      allowanceFood:     hr ? Number(r.allowance_food     || 0) : 0,
      allowancePerDiem:  hr ? Number(r.allowance_per_diem || 0) : 0,
      allowanceLanguage: hr ? Number(r.allowance_language || 0) : 0,
      allowanceOther:    hr ? Number(r.allowance_other    || 0) : 0,
      bank: hr ? (r.bank || '') : '',
      bankAccount: hr ? (r.bank_account || '') : '',
      passportNumber: hr ? (r.passport_number || '') : '',
      workPermitNumber: hr ? (r.work_permit_number || '') : '',
      photoUrl: r.photo_url || '',
      terminationDate: r.termination_date || '',
      terminationReason: r.termination_reason || '',
      terminationNote: r.termination_note || '',
      ssoNo: hr ? (r.sso_no || '') : '',
      ssoEnrolledDate: hr ? (r.sso_enrolled_date || '') : '',
      ssoTerminatedDate: hr ? (r.sso_terminated_date || '') : '',
      ssoHospital: hr ? (r.sso_hospital || '') : '',
      status: r.status || 'active', note: r.note || ''
    };
  },
  _empToDB: (e) => ({
    id: e.id, title: e.title, first_name: e.firstName, last_name: e.lastName,
    nickname: e.nickname, national_id: e.nationalId,
    dob: e.dob || null, gender: e.gender,
    nationality: e.nationality || null, religion: e.religion || null,
    education: e.education || null,
    phone: e.phone, email: e.email, address: e.address,
    sub_district: e.subDistrict || null, district: e.district || null,
    province: e.province || null, postal_code: e.postalCode || null,
    department: e.department || null, branch: e.branch || null,
    position: e.position || null, position_title: e.positionTitle,
    employee_type: e.employeeType || null,
    hire_date: e.hireDate || null, salary: Number(e.salary || 0),
    allowance_position: Number(e.allowancePosition || 0),
    allowance_travel: Number(e.allowanceTravel || 0),
    allowance_food: Number(e.allowanceFood || 0),
    allowance_per_diem: Number(e.allowancePerDiem || 0),
    allowance_language: Number(e.allowanceLanguage || 0),
    allowance_other: Number(e.allowanceOther || 0),
    bank: e.bank || null, bank_account: e.bankAccount || null,
    passport_number: e.passportNumber || null,
    work_permit_number: e.workPermitNumber || null,
    photo_url: e.photoUrl || null,
    termination_date: e.terminationDate || null,
    termination_reason: e.terminationReason || null,
    termination_note: e.terminationNote || null,
    sso_no: e.ssoNo || null,
    sso_enrolled_date: e.ssoEnrolledDate || null,
    sso_terminated_date: e.ssoTerminatedDate || null,
    sso_hospital: e.ssoHospital || null,
    status: e.status, note: e.note
  }),
  _depFromDB: (r) => ({ id: r.id, name: r.name, manager: r.manager_id || '', note: r.note || '', scope: r.scope || '' }),
  _depToDB: (d) => ({ id: d.id, name: d.name, manager_id: d.manager || null, note: d.note, scope: d.scope || null }),
  _posFromDB: (r) => ({ id: r.id, name: r.name, level: Number(r.level || 0), minSalary: Number(r.min_salary || 0), maxSalary: Number(r.max_salary || 0), scope: r.scope || '' }),
  _posToDB: (p) => ({ id: p.id, name: p.name, level: Number(p.level || 0), min_salary: Number(p.minSalary || 0), max_salary: Number(p.maxSalary || 0), scope: p.scope || null }),
  _loanFromDB: (r) => ({ id: r.id, employeeId: r.employee_id, date: r.date, amount: Number(r.amount), monthlyPayment: Number(r.monthly_payment || 0), remaining: Number(r.remaining || 0), status: r.status, reason: r.reason || '' }),
  _loanToDB: (l) => ({ employee_id: l.employeeId, date: l.date, amount: Number(l.amount), monthly_payment: Number(l.monthlyPayment || 0), remaining: Number(l.remaining || 0), status: l.status, reason: l.reason }),
  _advFromDB: (r) => ({ id: r.id, employeeId: r.employee_id, date: r.date, amount: Number(r.amount), reason: r.reason || '', status: r.status }),
  _advToDB: (a) => ({ employee_id: a.employeeId, date: a.date, amount: Number(a.amount), reason: a.reason, status: a.status }),
  _allowFromDB: (r) => ({ id: r.id, employeeId: r.employee_id, month: r.month, type: r.type || '', amount: Number(r.amount), note: r.note || '' }),
  _allowToDB: (a) => ({ employee_id: a.employeeId, month: a.month, type: a.type, amount: Number(a.amount), note: a.note }),
  _evalFromDB: (r) => ({ id: r.id, employeeId: r.employee_id, date: r.date, period: r.period || '', score: r.score, grade: r.grade || '', note: r.note || '' }),
  _evalToDB: (e) => ({ employee_id: e.employeeId, date: e.date, period: e.period, score: Number(e.score), grade: e.grade, note: e.note }),
  _salFromDB: (r) => ({
    id: r.id, employeeId: r.employee_id, date: r.date,
    oldSalary: Number(r.old_salary || 0), newSalary: Number(r.new_salary || 0),
    oldPosition: r.old_position || '', oldPositionTitle: r.old_position_title || '',
    newPosition: r.new_position || '', newPositionTitle: r.new_position_title || '',
    oldBranch: r.old_branch || '', newBranch: r.new_branch || '',
    oldDepartment: r.old_department || '', newDepartment: r.new_department || '',
    // allowances (old + new) — null คือ "ไม่เปลี่ยน"
    oldAllowancePosition: r.old_allowance_position != null ? Number(r.old_allowance_position) : null,
    newAllowancePosition: r.new_allowance_position != null ? Number(r.new_allowance_position) : null,
    oldAllowanceTravel:   r.old_allowance_travel   != null ? Number(r.old_allowance_travel)   : null,
    newAllowanceTravel:   r.new_allowance_travel   != null ? Number(r.new_allowance_travel)   : null,
    oldAllowanceFood:     r.old_allowance_food     != null ? Number(r.old_allowance_food)     : null,
    newAllowanceFood:     r.new_allowance_food     != null ? Number(r.new_allowance_food)     : null,
    oldAllowancePerDiem:  r.old_allowance_per_diem != null ? Number(r.old_allowance_per_diem) : null,
    newAllowancePerDiem:  r.new_allowance_per_diem != null ? Number(r.new_allowance_per_diem) : null,
    oldAllowanceLanguage: r.old_allowance_language != null ? Number(r.old_allowance_language) : null,
    newAllowanceLanguage: r.new_allowance_language != null ? Number(r.new_allowance_language) : null,
    oldAllowanceOther:    r.old_allowance_other    != null ? Number(r.old_allowance_other)    : null,
    newAllowanceOther:    r.new_allowance_other    != null ? Number(r.new_allowance_other)    : null,
    changeType: r.change_type || '',
    reason: r.reason || ''
  }),
  _salToDB: (s) => ({
    employee_id: s.employeeId, date: s.date,
    old_salary: s.oldSalary != null ? Number(s.oldSalary) : null,
    new_salary: s.newSalary != null ? Number(s.newSalary) : null,
    old_position: s.oldPosition || null,
    old_position_title: s.oldPositionTitle || null,
    new_position: s.newPosition || null,
    new_position_title: s.newPositionTitle || null,
    old_branch: s.oldBranch || null,
    new_branch: s.newBranch || null,
    old_department: s.oldDepartment || null,
    new_department: s.newDepartment || null,
    old_allowance_position: s.oldAllowancePosition != null ? Number(s.oldAllowancePosition) : null,
    new_allowance_position: s.newAllowancePosition != null ? Number(s.newAllowancePosition) : null,
    old_allowance_travel:   s.oldAllowanceTravel   != null ? Number(s.oldAllowanceTravel)   : null,
    new_allowance_travel:   s.newAllowanceTravel   != null ? Number(s.newAllowanceTravel)   : null,
    old_allowance_food:     s.oldAllowanceFood     != null ? Number(s.oldAllowanceFood)     : null,
    new_allowance_food:     s.newAllowanceFood     != null ? Number(s.newAllowanceFood)     : null,
    old_allowance_per_diem:  s.oldAllowancePerDiem  != null ? Number(s.oldAllowancePerDiem)  : null,
    new_allowance_per_diem:  s.newAllowancePerDiem  != null ? Number(s.newAllowancePerDiem)  : null,
    old_allowance_language: s.oldAllowanceLanguage != null ? Number(s.oldAllowanceLanguage) : null,
    new_allowance_language: s.newAllowanceLanguage != null ? Number(s.newAllowanceLanguage) : null,
    old_allowance_other:    s.oldAllowanceOther    != null ? Number(s.oldAllowanceOther)    : null,
    new_allowance_other:    s.newAllowanceOther    != null ? Number(s.newAllowanceOther)    : null,
    change_type: s.changeType || null,
    reason: s.reason || null
  }),
  _calFromDB: (r) => ({
    id: r.id,
    date: r.date,
    title: r.title,
    type: r.type || 'holiday'
  }),
  _calToDB: (c) => ({
    date: c.date,
    title: c.title,
    type: c.type
  }),
  _annFromDB: (r) => ({
    id: r.id,
    type: r.type || 'announcement',
    docNumber: r.doc_number || '',
    title: r.title,
    body: r.body || '',
    imageUrl: r.image_url || null,
    effectiveDate: r.effective_date || null,
    expiresDate: r.expires_date || null,
    priority: r.priority || 'normal',
    pinned: !!r.pinned,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }),
  _annToDB: (a) => ({
    type: a.type || 'announcement',
    doc_number: (a.docNumber || '').trim() || null,
    title: a.title,
    body: a.body || '',
    image_url: a.imageUrl || null,
    effective_date: a.effectiveDate || null,
    expires_date: a.expiresDate || null,
    priority: a.priority || 'normal',
    pinned: !!a.pinned
  }),

  _swapReqFromDB: (r) => ({
    id: r.id,
    calendarItemId: r.calendar_item_id,
    employeeId: r.employee_id,
    swapToDate: r.swap_to_date,
    reason: r.reason || '',
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    approverNote: r.approver_note || '',
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    cancelReason: r.cancel_reason || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }),
  _swapReqToDB(s) {
    return {
      calendar_item_id: s.calendarItemId,
      employee_id: s.employeeId,
      swap_to_date: s.swapToDate,
      reason: s.reason || null,
      status: s.status || 'pending'
    };
  },
  _applFromDB: (r) => ({
    id: r.id,
    firstName: r.first_name || '',
    lastName: r.last_name || '',
    nickname: r.nickname || '',
    phone: r.phone || '',
    email: r.email || '',
    position: r.position || '',
    positionTitle: r.position_title || '',
    department: r.department || '',
    branch: r.branch || '',
    expectedSalary: Number(r.expected_salary || 0),
    source: r.source || '',
    status: r.status || 'new',
    appliedDate: r.applied_date || '',
    interviewDate: r.interview_date || '',
    decidedDate: r.decided_date || '',
    hiredEmployeeId: r.hired_employee_id || '',
    note: r.note || ''
  }),
  _applToDB: (a) => ({
    first_name: a.firstName,
    last_name: a.lastName || null,
    nickname: a.nickname || null,
    phone: a.phone || null,
    email: a.email || null,
    position: a.position || null,
    position_title: a.positionTitle || null,
    department: a.department || null,
    branch: a.branch || null,
    expected_salary: Number(a.expectedSalary || 0),
    source: a.source || null,
    status: a.status || 'new',
    applied_date: a.appliedDate || null,
    interview_date: a.interviewDate || null,
    decided_date: a.decidedDate || null,
    hired_employee_id: a.hiredEmployeeId || null,
    note: a.note || null
  }),
  _compFromDB: (r) => ({ name: r.name || '', nameEn: r.name_en || '', taxId: r.tax_id || '', address: r.address || '', phone: r.phone || '', email: r.email || '' }),

  // ─── UNIFORM mappers ───
  _uniItemFromDB: (r) => ({
    id: r.id,
    name: r.name || '',
    size: r.size || '',
    stockQty: Number(r.stock_qty || 0),
    unitCost: Number(r.unit_cost || 0),
    active: r.active !== false,
    note: r.note || ''
  }),
  _uniItemToDB: (i) => ({
    name: i.name,
    size: i.size || null,
    stock_qty: Number(i.stockQty || 0),
    unit_cost: Number(i.unitCost || 0),
    active: i.active !== false,
    note: i.note || null
  }),
  _uniReqFromDB: (r) => ({
    id: r.id,
    employeeId: r.employee_id || '',
    applicantId: r.applicant_id || '',
    requestedBy: r.requested_by || '',
    requestedDate: r.requested_date || '',
    neededBy: r.needed_by || '',
    status: r.status || 'pending',
    totalCost: Number(r.total_cost || 0),
    note: r.note || ''
  }),
  _uniReqToDB: (r) => ({
    employee_id: r.employeeId || null,
    applicant_id: r.applicantId || null,
    requested_by: r.requestedBy || null,
    requested_date: r.requestedDate || null,
    needed_by: r.neededBy || null,
    status: r.status || 'pending',
    total_cost: Number(r.totalCost || 0),
    note: r.note || null
  }),
  _uniIssueFromDB: (r) => ({
    id: r.id,
    requestId: r.request_id || '',
    employeeId: r.employee_id || '',
    itemId: r.item_id || '',
    itemName: r.item_name || '',
    size: r.size || '',
    qty: Number(r.qty || 0),
    unitCost: Number(r.unit_cost || 0),
    totalCost: Number(r.total_cost || 0),
    issuedDate: r.issued_date || '',
    issuedBy: r.issued_by || '',
    note: r.note || ''
  }),
  _uniIssueToDB: (i) => ({
    request_id: i.requestId || null,
    employee_id: i.employeeId || null,
    item_id: i.itemId || null,
    item_name: i.itemName || null,
    size: i.size || null,
    qty: Number(i.qty || 0),
    unit_cost: Number(i.unitCost || 0),
    total_cost: Number(i.totalCost || 0),
    issued_date: i.issuedDate || null,
    issued_by: i.issuedBy || null,
    note: i.note || null
  }),
  _uniSchedFromDB: (r) => ({
    id: r.id,
    branchCode: r.branch_code || '',
    dayOfWeek: Number(r.day_of_week ?? 0),
    active: r.active !== false,
    note: r.note || ''
  }),
  _uniSchedToDB: (s) => ({
    branch_code: s.branchCode,
    day_of_week: Number(s.dayOfWeek),
    active: s.active !== false,
    note: s.note || null
  }),
  // ─── ROLE MATRIX (เอกสารอ้างอิงสิทธิ์ — admin/HR แก้ได้) ───
  _matrixFromDB: (r) => ({
    id: r.id,
    menuLabel: r.menu_label || '',
    admin: r.admin_val || '',
    hr: r.hr_val || '',
    opMgr: r.op_mgr_val || '',
    areaMgr: r.area_mgr_val || '',
    branchMgr: r.branch_mgr_val || '',
    branchStaff: r.branch_staff_val || '',
    sortOrder: Number(r.sort_order || 0),
    note: r.note || ''
  }),
  _matrixToDB: (m) => ({
    menu_label: m.menuLabel || '',
    admin_val: m.admin || '',
    hr_val: m.hr || '',
    op_mgr_val: m.opMgr || '',
    area_mgr_val: m.areaMgr || '',
    branch_mgr_val: m.branchMgr || '',
    branch_staff_val: m.branchStaff || '',
    sort_order: Number(m.sortOrder || 0),
    note: m.note || null
  }),
  getRoleMatrix() {
    return (this.data.roleMatrix || []).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  },
  async saveRoleMatrixRow(row) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const r = this._matrixToDB(row);
    if (row.id) r.id = row.id;
    const { data, error } = await this.client.from('role_permission_matrix').upsert(r).select().single();
    if (error) throw error;
    return this._matrixFromDB(data);
  },
  async deleteRoleMatrixRow(id) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const { error } = await this.client.from('role_permission_matrix').delete().eq('id', id);
    if (error) throw error;
  },

  _branchFromDB: (r) => ({
    id: r.id,
    name: r.name || '',
    active: r.active !== false,
    note: r.note || '',
    phone: r.phone || '',
    email: r.email || ''
  }),
  _branchToDB: (b) => ({
    id: b.id,
    name: b.name || null,
    active: b.active !== false,
    note: b.note || null,
    phone: b.phone || null,
    email: b.email || null
  }),

  // ผู้บังคับบัญชาสูงสุดของสาขา — derive จากระดับตำแหน่งงานสูงสุดของพนักงาน active ในสาขานั้น
  // คืน object พนักงาน หรือ null ถ้าไม่มี
  getBranchManager(branchId) {
    if (!branchId) return null;
    const empsInBranch = this.data.employees.filter(e =>
      e.branch === branchId && this.empStatus(e) !== 'resigned'
    );
    if (!empsInBranch.length) return null;
    // จับคู่ position level (สูงสุด = ผู้บังคับบัญชา)
    let best = null;
    let bestLevel = -1;
    for (const e of empsInBranch) {
      const pos = this.getPosition?.(e.position);
      const lvl = Number(pos?.level || 0);
      if (lvl > bestLevel) {
        bestLevel = lvl;
        best = e;
      }
    }
    return best;
  },

  // ─── EMPLOYEES ───
  // สถานะที่แท้จริง (effective status) — คำนวณจาก terminationDate
  // 'active'    = ปฏิบัติงาน (ไม่มีวันพ้นสภาพ)
  // 'pending'   = นัดพ้นสภาพ (วันพ้นสภาพอยู่ในอนาคต — ยังทำงานอยู่)
  // 'resigned'  = พ้นสภาพแล้ว (วันพ้นสภาพผ่านไปแล้ว หรือ status='resigned' ตั้งแต่ import)
  // วันที่ปัจจุบัน (Asia/Bangkok, YYYY-MM-DD) — cache 60 วินาทีเพื่อหลีกเลี่ยง
  // ค่าใช้จ่ายของ toLocaleDateString({timeZone}) ที่ถูกเรียกพันครั้งต่อ render
  _todayCache: { value: null, ts: 0 },
  todayBkk() {
    const now = Date.now();
    const c = this._todayCache;
    if (!c.value || now - c.ts > 60000) {
      c.value = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      c.ts = now;
    }
    return c.value;
  },
  empStatus(emp) {
    if (!emp.terminationDate) {
      // Fallback: ข้อมูล legacy ที่ import มามี status='resigned' แต่ลืมกรอกวันพ้นสภาพ
      // ถือว่าออกแล้ว (เคารพการตั้ง status ของ HR) — มิฉะนั้นจะนับเป็น active ผิด
      if (emp.status === 'resigned') return 'resigned';
      return 'active';
    }
    return emp.terminationDate > this.todayBkk() ? 'pending' : 'resigned';
  },

  getEmployees(filter = {}) {
    let list = this.data.employees.slice();
    if (filter.search) {
      const s = filter.search.toLowerCase();
      const sDigits = s.replace(/\D/g, '');
      list = list.filter(e =>
        (e.firstName + ' ' + e.lastName).toLowerCase().includes(s) ||
        String(e.id).toLowerCase().includes(s) ||
        (e.nickname || '').toLowerCase().includes(s) ||
        (e.positionTitle || '').toLowerCase().includes(s) ||
        (sDigits && (e.nationalId || '').includes(sDigits))
      );
    }
    if (filter.branch) list = list.filter(e => e.branch === filter.branch);
    if (filter.position) {
      // dropdown ส่ง position.id มา — แต่บางแถว (legacy import) มี e.position เป็น "" / ชื่อตำแหน่ง / id เก่า
      // เปรียบเทียบทั้ง FK + ชื่อตำแหน่ง (positionTitle) แบบ exact (ตำแหน่งเก็บเป็นชื่อเต็มตามที่ admin ตั้ง ไม่มี free-form suffix)
      // หมายเหตุ: ใช้ exact match ไม่ใช้ contains/word-boundary เพราะตำแหน่งเช่น "RM" กับ "Act.RM" หรือ "Service" กับ "Service (PT)" เป็นคนละตัวกัน
      const pos = this.getPosition(filter.position);
      const posName = (pos?.name || '').trim();
      const posNameLc = posName.toLowerCase();
      list = list.filter(e => {
        if (e.position === filter.position) return true;          // FK match ปกติ
        if (posName && e.position === posName) return true;         // legacy: position เก็บเป็นชื่อ
        if (posNameLc && (e.positionTitle || '').trim().toLowerCase() === posNameLc) return true; // เทียบ snapshot title
        return false;
      });
    }
    if (filter.department) list = list.filter(e => e.department === filter.department);
    if (filter.status) {
      // ใช้ effective status — รองรับ "active" (รวม pending) และ "resigned"
      if (filter.status === 'active') list = list.filter(e => this.empStatus(e) !== 'resigned');
      else if (filter.status === 'pending') list = list.filter(e => this.empStatus(e) === 'pending');
      else if (filter.status === 'resigned') list = list.filter(e => this.empStatus(e) === 'resigned');
    }
    // ─── Auto-scope ตามสิทธิ์ user ปัจจุบัน (RBAC Phase 2) ───
    // ผ่าน filter._noScope = true เพื่อ bypass (ใช้ใน internal aggregator เช่น getStats, dashboard KPI ของ admin)
    if (!filter._noScope && this.role) {
      const scoped = this.scopedBranches();
      if (scoped === null) {
        // admin / hr / operation_manager → no filter (เห็นทุกคน)
      } else if (this.role === 'branch_staff' || this.role === 'viewer') {
        // ดูได้เฉพาะตัวเอง
        list = list.filter(e => e.id === this.profile?.employee_id);
      } else {
        // area_manager / branch_manager → filter ตาม managed branches
        list = list.filter(e => scoped.includes(e.branch));
      }
    }
    return list;
  },

  // ดึงรายชื่อสาขาทั้งหมด — รวม master (active) + ที่ใช้จริงในพนักงาน
  getBranches() {
    const set = new Set();
    // master ก่อน (active เท่านั้น)
    for (const b of this.data.branches) {
      if (b.active && b.id) set.add(b.id);
    }
    // employees field — เผื่อ legacy ที่ยังไม่ได้ register
    for (const e of this.data.employees) {
      if (e.branch && e.branch.trim()) set.add(e.branch.trim());
    }
    return [...set].sort();
  },
  // ─── BRANCH MASTER ───
  getBranchMaster({ activeOnly = false } = {}) {
    let list = this.data.branches.slice();
    if (activeOnly) list = list.filter(b => b.active);
    return list.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  },
  getBranch(id) { return this.data.branches.find(b => b.id === id); },
  // นับจำนวนพนักงานที่ใช้สาขานี้ (เฉพาะที่ยังปฏิบัติงาน)
  getBranchEmployeeCount(branchId) {
    return this.data.employees.filter(e => e.branch === branchId && this.empStatus(e) !== 'resigned').length;
  },
  async saveBranch(branch) {
    if (!branch.id) throw new Error('รหัสสาขาว่าง');
    const row = this._branchToDB(branch);
    const { data, error } = await this.client.from('branches').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._branchFromDB(data);
    const idx = this.data.branches.findIndex(b => b.id === mapped.id);
    if (idx >= 0) this.data.branches[idx] = mapped;
    else this.data.branches.unshift(mapped);
    return mapped;
  },
  async deleteBranch(id) {
    // เช็คก่อน — ห้ามลบถ้ามีพนักงานใช้สาขานี้อยู่
    if (this.data.employees.some(e => e.branch === id)) {
      return { ok: false, reason: 'มีพนักงานใช้สาขานี้อยู่' };
    }
    const { error } = await this.client.from('branches').delete().eq('id', id);
    if (error) throw error;
    this.data.branches = this.data.branches.filter(b => b.id !== id);
    return { ok: true };
  },
  getEmployee(id) {
    if (!this._empIndex) {
      this._empIndex = new Map();
      for (const e of this.data.employees) this._empIndex.set(e.id, e);
    }
    return this._empIndex.get(id);
  },

  async saveEmployee(emp) {
    // auto-set status จาก terminationDate
    emp.status = this.empStatus(emp) === 'resigned' ? 'resigned' : 'active';
    const row = this._empToDB(emp);
    const { data, error } = await this.client.from('employees').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._empFromDB(data);
    const idx = this.data.employees.findIndex(e => e.id === mapped.id);
    if (idx >= 0) this.data.employees[idx] = mapped;
    else this.data.employees.unshift(mapped);
    this._invalidateIndex('employees');
    return mapped;
  },
  async deleteEmployee(id) {
    const { error } = await this.client.from('employees').delete().eq('id', id);
    if (error) throw error;
    this.data.employees = this.data.employees.filter(e => e.id !== id);
    this._invalidateIndex('employees');
  },
  nextEmployeeId() {
    // รหัสพนักงาน: ตัวเลขล้วน ไม่มี padding (เช่น "8", "121", "62002")
    const nums = this.data.employees.map(e => parseInt(String(e.id).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return String(max + 1);
  },

  // ─── PHOTOS ───
  // Compress image client-side (max width 800px, JPEG 0.85 quality)
  async compressImage(file, maxWidth = 800, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          URL.revokeObjectURL(img.src);
          blob ? resolve(blob) : reject(new Error('Compression failed'));
        }, 'image/jpeg', quality);
      };
      img.onerror = () => reject(new Error('Invalid image'));
      img.src = URL.createObjectURL(file);
    });
  },

  async uploadEmployeePhoto(blob, employeeId) {
    // [Security H1] ใช้ UUID แทน ${id}-${ts}.jpg ที่เดาได้
    // ป้องกันการเดา URL → enumerate รูปพนักงานคนอื่น (bucket ยังเป็น public read)
    // เก็บใน folder ตาม employeeId เพื่อจัดระเบียบ
    const uuid = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const path = `${employeeId}/${uuid}.jpg`;
    const { error: uploadError } = await this.client.storage
      .from('employee-photos')
      .upload(path, blob, { cacheControl: '3600', upsert: true, contentType: 'image/jpeg' });
    if (uploadError) throw uploadError;
    const { data } = this.client.storage.from('employee-photos').getPublicUrl(path);
    return data.publicUrl;
  },

  // ─── BULK PHOTO UPLOAD (ปาราเลล 12 connection + bulk DB update) ───
  async bulkUploadEmployeePhotos(matches, options = {}) {
    const { concurrency = 12, onProgress } = options;
    let i = 0;
    let succeeded = 0;
    const failed = [];
    const updates = []; // [{ id, photo_url }]

    // ตัวคุมงาน N workers พร้อมกัน
    const worker = async () => {
      while (true) {
        const idx = i++;
        if (idx >= matches.length) break;
        const { file, employee } = matches[idx];
        try {
          const blob = await this.compressImage(file);
          const url = await this.uploadEmployeePhoto(blob, employee.id);
          updates.push({ id: employee.id, photo_url: url });
          succeeded++;
        } catch (ex) {
          failed.push({ id: employee.id, file: file.name, error: ex.message || String(ex) });
        }
        if (onProgress) onProgress(idx + 1, matches.length, succeeded, failed.length);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    // Bulk update photo_url (ทีละ 100 records)
    for (let j = 0; j < updates.length; j += 100) {
      const chunk = updates.slice(j, j + 100);
      const { error } = await this.client.from('employees').upsert(chunk);
      if (error) {
        failed.push({ id: `batch ${j / 100 + 1}`, error: error.message });
        continue;
      }
      // update local cache
      for (const u of chunk) {
        const emp = this.getEmployee(u.id);
        if (emp) emp.photoUrl = u.photo_url;
      }
    }
    return { succeeded, failed };
  },

  // ─── BULK IMPORT ───
  async bulkUpsertEmployees(rows, onProgress) {
    const CHUNK_SIZE = 100;
    const result = { inserted: 0, failed: 0, errors: [] };
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE).map(r => this._empToDB(r));
      const { data, error } = await this.client
        .from('employees')
        .upsert(chunk, { onConflict: 'id' })
        .select();
      if (error) {
        result.failed += chunk.length;
        result.errors.push({ chunk: i / CHUNK_SIZE + 1, message: error.message });
      } else {
        result.inserted += data.length;
        // update local cache
        for (const row of data) {
          const mapped = this._empFromDB(row);
          const idx = this.data.employees.findIndex(e => e.id === mapped.id);
          if (idx >= 0) this.data.employees[idx] = mapped;
          else this.data.employees.push(mapped);
        }
        this._invalidateIndex('employees');
      }
      if (onProgress) onProgress(Math.min(i + CHUNK_SIZE, rows.length), rows.length);
      // ปล่อย event loop เพื่อให้ progress UI update ไหลลื่น
      await new Promise(r => requestAnimationFrame(r));
    }
    return result;
  },

  // ─── DEPARTMENTS ───
  // เรียงตามชื่อ (ภาษาไทย) — sort ใน getDepartments() เพื่อให้ทุก dropdown/list สอดคล้องกัน
  getDepartments() {
    return this.data.departments.slice().sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', 'th')
    );
  },
  getDepartment(id) {
    if (!this._deptIndex) {
      this._deptIndex = new Map();
      for (const d of this.data.departments) this._deptIndex.set(d.id, d);
    }
    return this._deptIndex.get(id);
  },
  // saveDepartment(dept) — เพิ่ม/แก้ไขทั่วไป (id ไม่เปลี่ยน)
  // saveDepartment(dept, originalId) — รองรับการ rename id (originalId !== dept.id)
  //   FK ของ employees + applicants ตั้ง ON UPDATE CASCADE แล้ว → cascade อัตโนมัติใน DB
  //   client cache ต้อง mirror update เอง (employees/applicants.department field)
  async saveDepartment(dept, originalId = null) {
    if (originalId && originalId !== dept.id) {
      // Rename: UPDATE row เดิม (PK ใหม่จะ cascade ผ่าน FK)
      const { data, error } = await this.client.from('departments')
        .update(this._depToDB(dept)).eq('id', originalId).select().single();
      if (error) throw error;
      const mapped = this._depFromDB(data);
      const idx = this.data.departments.findIndex(d => d.id === originalId);
      if (idx >= 0) this.data.departments[idx] = mapped;
      // mirror FK cascade ใน local cache (Postgres ทำให้แล้วใน DB)
      for (const e of (this.data.employees || [])) {
        if (e.department === originalId) e.department = dept.id;
      }
      for (const a of (this.data.applicants || [])) {
        if (a.department === originalId) a.department = dept.id;
      }
      this._invalidateIndex('departments');
      return mapped;
    }
    const { data, error } = await this.client.from('departments').upsert(this._depToDB(dept)).select().single();
    if (error) throw error;
    const mapped = this._depFromDB(data);
    const idx = this.data.departments.findIndex(d => d.id === mapped.id);
    if (idx >= 0) this.data.departments[idx] = mapped;
    else this.data.departments.push(mapped);
    this._invalidateIndex('departments');
    return mapped;
  },
  async deleteDepartment(id) {
    if (this.data.employees.some(e => e.department === id)) return false;
    const { error } = await this.client.from('departments').delete().eq('id', id);
    if (error) throw error;
    this.data.departments = this.data.departments.filter(d => d.id !== id);
    this._invalidateIndex('departments');
    return true;
  },
  nextDepartmentId() {
    const nums = this.data.departments.map(d => parseInt(String(d.id).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return 'D' + String(max + 1).padStart(3, '0');
  },

  // ─── POSITION SCOPES (สายงาน) — Master ที่ admin/HR จัดการเองได้ ───
  _scopeFromDB: (r) => ({
    id: r.id,
    label: r.label,
    badgeBg: r.badge_bg || 'rgba(148,163,184,0.15)',
    badgeColor: r.badge_color || '#475569',
    sortOrder: Number(r.sort_order || 100),
    active: r.active !== false,
    note: r.note || ''
  }),
  _scopeToDB(s) {
    return {
      id: s.id,
      label: s.label,
      badge_bg: s.badgeBg || 'rgba(148,163,184,0.15)',
      badge_color: s.badgeColor || '#475569',
      sort_order: Number(s.sortOrder || 100),
      active: s.active !== false,
      note: s.note || null
    };
  },
  getScopes(includeInactive = false) {
    const list = (this.data.positionScopes || []).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    return includeInactive ? list : list.filter(s => s.active);
  },
  getScope(id) { return (this.data.positionScopes || []).find(s => s.id === id); },
  async saveScope(scope) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const id = (scope.id || '').trim().toLowerCase();
    const label = (scope.label || '').trim();
    if (!id) throw new Error('ต้องระบุรหัส (id) ของสายงาน');
    if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('รหัสต้องเป็น a-z, 0-9, _, - เท่านั้น');
    if (!label) throw new Error('ต้องระบุชื่อสายงาน');
    // ห้ามชื่อซ้ำ (case-insensitive)
    const labelLc = label.toLowerCase();
    const dup = this.data.positionScopes.find(s => s.id !== id && (s.label || '').trim().toLowerCase() === labelLc);
    if (dup) throw new Error(`ชื่อสายงาน "${label}" ซ้ำกับรหัส ${dup.id}`);
    const row = this._scopeToDB({ ...scope, id });
    const { data, error } = await this.client.from('position_scopes').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._scopeFromDB(data);
    const idx = this.data.positionScopes.findIndex(s => s.id === mapped.id);
    if (idx >= 0) this.data.positionScopes[idx] = mapped;
    else this.data.positionScopes.push(mapped);
    return mapped;
  },
  async deleteScope(id) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    // ตรวจ FK: ห้ามลบถ้ามี positions/departments ใช้
    const usedByPos = this.data.positionLevels.some(p => p.scope === id);
    const usedByDept = this.data.departments.some(d => d.scope === id);
    if (usedByPos || usedByDept) {
      const where = [usedByPos && 'ตำแหน่ง', usedByDept && 'ฝ่าย'].filter(Boolean).join(' + ');
      throw new Error(`ลบไม่ได้ — มี ${where} ใช้สายงานนี้อยู่ · ย้ายไปสายอื่นก่อน หรือ soft-delete (ปิด active) แทน`);
    }
    const { error } = await this.client.from('position_scopes').delete().eq('id', id);
    if (error) throw error;
    this.data.positionScopes = this.data.positionScopes.filter(s => s.id !== id);
  },

  // ─── POSITIONS ───
  getPositions() { return this.data.positionLevels.slice(); },
  // ─── ตำแหน่งที่เหมาะกับฝ่ายนั้น ตาม scope (ปฏิบัติ/สำนักงาน) ───
  // ถ้าฝ่ายไม่มี scope (NULL) → คืนทุกตำแหน่ง (no filter)
  // ถ้าฝ่าย scope = 'operation' → คืนตำแหน่งที่ scope = 'operation' หรือ NULL
  // ถ้าฝ่าย scope = 'office'    → คืนตำแหน่งที่ scope = 'office' หรือ NULL
  // ตำแหน่งที่ scope = NULL ถือว่า "ใช้ได้ทุกฝ่าย" — graceful default ก่อนตั้งค่า
  getPositionsForDepartment(deptId) {
    const all = this.data.positionLevels.slice();
    if (!deptId) return all;
    const dept = this.getDepartment(deptId);
    const scope = dept?.scope || '';
    if (!scope) return all;
    return all.filter(p => !p.scope || p.scope === scope);
  },
  getPosition(id) {
    if (!this._posIndex) {
      this._posIndex = new Map();
      for (const p of this.data.positionLevels) this._posIndex.set(p.id, p);
    }
    return this._posIndex.get(id);
  },
  async savePosition(pos) {
    // ── Validation: ห้ามชื่อตำแหน่งซ้ำ (case-insensitive + trim) ──
    // เพราะ filter ทะเบียนพนักงาน + positionTitle snapshot ใช้ชื่อตำแหน่งเทียบกัน
    // ถ้ามี 2 records ที่ชื่อเดียวกัน → dropdown แสดงซ้ำ + filter จะรวมพนักงานของทั้ง 2 records
    const name = (pos.name || '').trim();
    if (!name) throw new Error('ต้องระบุชื่อตำแหน่ง');
    const nameLc = name.toLowerCase();
    const duplicate = this.data.positionLevels.find(p =>
      p.id !== pos.id && (p.name || '').trim().toLowerCase() === nameLc
    );
    if (duplicate) {
      throw new Error(`ชื่อตำแหน่ง "${name}" ซ้ำกับรหัส ${duplicate.id} — กรุณาใช้ชื่ออื่น หรือแก้ไขตำแหน่งเดิมแทน`);
    }

    // จับชื่อเดิมก่อน upsert — ถ้าเปลี่ยน (rename) ต้อง cascade ไป positionTitle ของพนักงาน
    const existing = pos.id ? this.getPosition(pos.id) : null;
    const oldName = existing ? (existing.name || '').trim() : '';
    const isRename = existing && oldName !== name;

    const { data, error } = await this.client.from('position_levels').upsert(this._posToDB(pos)).select().single();
    if (error) throw error;
    const mapped = this._posFromDB(data);
    const idx = this.data.positionLevels.findIndex(p => p.id === mapped.id);
    if (idx >= 0) this.data.positionLevels[idx] = mapped;
    else this.data.positionLevels.push(mapped);
    this._invalidateIndex('position_levels');

    // Cascade sync: ถ้า rename → อัปเดต positionTitle ของพนักงานทั้งหมดที่ link FK กับตำแหน่งนี้
    // (มิฉะนั้น dropdown filter ใหม่จะหาพนักงานเดิมไม่เจอ — เพราะ snapshot title ยังเป็นชื่อเก่า)
    mapped._syncedCount = 0;
    if (isRename) {
      mapped._syncedCount = await this._syncEmployeePositionTitle(mapped.id, mapped.name);
    }
    return mapped;
  },

  // Bulk update employees.positionTitle ของพนักงานที่ position FK = positionId
  // ใช้ตอน rename ตำแหน่ง (auto) หรือ HR กดปุ่ม "ซิงค์ snapshot" (manual)
  // คืนจำนวนพนักงานที่ถูกอัปเดตจริง
  async _syncEmployeePositionTitle(positionId, newName) {
    if (!positionId) return 0;
    const affected = this.data.employees
      .filter(e => e.position === positionId && (e.positionTitle || '') !== newName);
    if (!affected.length) return 0;
    const ids = affected.map(e => e.id);
    const { error } = await this.client.from('employees')
      .update({ position_title: newName })
      .in('id', ids);
    if (error) throw error;
    // อัปเดต local cache ทันที (ไม่รอ realtime) — UI จะเห็นการเปลี่ยนแปลงทันใจ
    for (const e of affected) e.positionTitle = newName;
    return affected.length;
  },

  async deletePosition(id) {
    if (this.data.employees.some(e => e.position === id)) return false;
    const { error } = await this.client.from('position_levels').delete().eq('id', id);
    if (error) throw error;
    this.data.positionLevels = this.data.positionLevels.filter(p => p.id !== id);
    this._invalidateIndex('position_levels');
    return true;
  },
  nextPositionId() {
    const nums = this.data.positionLevels.map(p => parseInt(String(p.id).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return 'P' + String(max + 1).padStart(2, '0');
  },

  // ─── EMPLOYEE CHANGE HISTORY (salary / position / branch / department) ───
  getSalaryHistory(employeeId = null) {
    let list = this.data.salaryHistory.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (employeeId) list = list.filter(s => s.employeeId === employeeId);
    return list;
  },
  // Add change record + update employee with new values (current snapshot stays in employees table)
  // rec จะมีฟิลด์ newSalary / newPosition / newPositionTitle / newBranch / newDepartment
  // อย่างน้อย 1 อย่าง — ฟิลด์ old_* จะถูกเติมอัตโนมัติจาก state ปัจจุบันของพนักงาน
  async addSalaryAdjustment(rec) {
    const emp = this.getEmployee(rec.employeeId);
    if (!emp) throw new Error('ไม่พบพนักงาน: ' + rec.employeeId);

    // กรอก old_* จาก current state ของพนักงาน — ทำให้ประวัติเป็น snapshot ที่สมบูรณ์
    // allowance เก่า: กรอกเฉพาะคู่ที่ new_* ระบุ (ไม่กรอกถ้า new_ = null = "ไม่เปลี่ยน")
    const enriched = {
      ...rec,
      oldSalary: rec.oldSalary != null ? rec.oldSalary : emp.salary,
      oldPosition: rec.oldPosition || emp.position || '',
      oldPositionTitle: rec.oldPositionTitle || emp.positionTitle || '',
      oldBranch: rec.oldBranch || emp.branch || '',
      oldDepartment: rec.oldDepartment || emp.department || '',
      oldAllowancePosition: rec.newAllowancePosition != null ? (rec.oldAllowancePosition != null ? rec.oldAllowancePosition : emp.allowancePosition) : null,
      oldAllowanceTravel:   rec.newAllowanceTravel   != null ? (rec.oldAllowanceTravel   != null ? rec.oldAllowanceTravel   : emp.allowanceTravel)   : null,
      oldAllowanceFood:     rec.newAllowanceFood     != null ? (rec.oldAllowanceFood     != null ? rec.oldAllowanceFood     : emp.allowanceFood)     : null,
      oldAllowancePerDiem:  rec.newAllowancePerDiem  != null ? (rec.oldAllowancePerDiem  != null ? rec.oldAllowancePerDiem  : emp.allowancePerDiem)  : null,
      oldAllowanceLanguage: rec.newAllowanceLanguage != null ? (rec.oldAllowanceLanguage != null ? rec.oldAllowanceLanguage : emp.allowanceLanguage) : null,
      oldAllowanceOther:    rec.newAllowanceOther    != null ? (rec.oldAllowanceOther    != null ? rec.oldAllowanceOther    : emp.allowanceOther)    : null
    };

    // คำนวณ change_type อัตโนมัติจากฟิลด์ที่เปลี่ยน
    const changed = [];
    if (enriched.newSalary != null && Number(enriched.newSalary) !== Number(enriched.oldSalary)) changed.push('salary');
    if (enriched.newPosition && enriched.newPosition !== enriched.oldPosition) changed.push('position');
    if (enriched.newBranch && enriched.newBranch !== enriched.oldBranch) changed.push('branch');
    if (enriched.newDepartment && enriched.newDepartment !== enriched.oldDepartment) changed.push('department');
    // allowance changes count as "allowance" change_type (single bucket)
    if (
      (enriched.newAllowancePosition != null && Number(enriched.newAllowancePosition) !== Number(enriched.oldAllowancePosition)) ||
      (enriched.newAllowanceTravel   != null && Number(enriched.newAllowanceTravel)   !== Number(enriched.oldAllowanceTravel))   ||
      (enriched.newAllowanceFood     != null && Number(enriched.newAllowanceFood)     !== Number(enriched.oldAllowanceFood))     ||
      (enriched.newAllowancePerDiem  != null && Number(enriched.newAllowancePerDiem)  !== Number(enriched.oldAllowancePerDiem))  ||
      (enriched.newAllowanceLanguage != null && Number(enriched.newAllowanceLanguage) !== Number(enriched.oldAllowanceLanguage)) ||
      (enriched.newAllowanceOther    != null && Number(enriched.newAllowanceOther)    !== Number(enriched.oldAllowanceOther))
    ) changed.push('allowance');
    enriched.changeType = changed.length > 1 ? 'multiple' : (changed[0] || 'salary');

    // Insert ประวัติ
    const { data, error } = await this.client.from('salary_history').insert(this._salToDB(enriched)).select().single();
    if (error) throw error;
    const mapped = this._salFromDB(data);
    this.data.salaryHistory.unshift(mapped);

    // Update employee state (snapshot ล่าสุด)
    if (enriched.newSalary != null && Number(enriched.newSalary) > 0) emp.salary = Number(enriched.newSalary);
    if (enriched.newPosition) emp.position = enriched.newPosition;
    if (enriched.newPositionTitle) emp.positionTitle = enriched.newPositionTitle;
    if (enriched.newBranch) emp.branch = enriched.newBranch;
    if (enriched.newDepartment) emp.department = enriched.newDepartment;
    if (enriched.newAllowancePosition != null) emp.allowancePosition = Number(enriched.newAllowancePosition);
    if (enriched.newAllowanceTravel   != null) emp.allowanceTravel   = Number(enriched.newAllowanceTravel);
    if (enriched.newAllowanceFood     != null) emp.allowanceFood     = Number(enriched.newAllowanceFood);
    if (enriched.newAllowancePerDiem  != null) emp.allowancePerDiem  = Number(enriched.newAllowancePerDiem);
    if (enriched.newAllowanceLanguage != null) emp.allowanceLanguage = Number(enriched.newAllowanceLanguage);
    if (enriched.newAllowanceOther    != null) emp.allowanceOther    = Number(enriched.newAllowanceOther);
    await this.saveEmployee(emp);

    return mapped;
  },

  // Bulk insert changes — ใช้สำหรับ Excel import
  // แต่ละแถวต้องมี employeeId; field new_* อย่างน้อย 1
  async bulkAddSalaryAdjustments(rows, onProgress) {
    const result = { inserted: 0, failed: 0, errors: [] };
    for (let i = 0; i < rows.length; i++) {
      try {
        await this.addSalaryAdjustment(rows[i]);
        result.inserted++;
      } catch (ex) {
        result.failed++;
        result.errors.push({ row: i + 2, message: ex.message || String(ex) });
      }
      if (onProgress && (i % 10 === 0 || i === rows.length - 1)) {
        onProgress(i + 1, rows.length);
        await new Promise(r => requestAnimationFrame(r));
      }
    }
    return result;
  },

  // ─── SCOPE FILTER HELPER ───
  // กรอง records ตาม RBAC scope ของ user ปัจจุบัน
  // - admin/hr/operation_manager → ไม่กรอง
  // - branch_staff/viewer → เฉพาะของตัวเอง
  // - branch_manager/area_manager → เฉพาะคนในสาขาที่ดูแล
  // getEmpId: function ที่ดึง employee_id จาก record
  _filterByScope(records, getEmpId) {
    if (!this.role) return records;
    if (this.role === 'admin' || this.role === 'hr' || this.role === 'operation_manager') return records;
    if (this.role === 'branch_staff' || this.role === 'viewer') {
      const myId = this.profile?.employee_id;
      return records.filter(r => getEmpId(r) === myId);
    }
    // branch_manager / area_manager
    const scoped = this.scopedBranches() || [];
    const scopedEmpIds = new Set(this.data.employees.filter(e => scoped.includes(e.branch)).map(e => e.id));
    return records.filter(r => scopedEmpIds.has(getEmpId(r)));
  },

  // ─── LOANS ───
  getLoans(employeeId = null) {
    let list = this.data.loans.slice();
    if (employeeId) return list.filter(l => l.employeeId === employeeId);
    return this._filterByScope(list, l => l.employeeId);
  },
  async saveLoan(loan) {
    const row = this._loanToDB(loan);
    if (loan.id) row.id = loan.id;
    const { data, error } = await this.client.from('loans').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._loanFromDB(data);
    const idx = this.data.loans.findIndex(l => l.id === mapped.id);
    if (idx >= 0) this.data.loans[idx] = mapped;
    else this.data.loans.unshift(mapped);
    return mapped;
  },
  async deleteLoan(id) {
    const { error } = await this.client.from('loans').delete().eq('id', id);
    if (error) throw error;
    this.data.loans = this.data.loans.filter(l => l.id !== id);
  },

  // ─── ADVANCES ───
  getAdvances(employeeId = null) {
    let list = this.data.advances.slice();
    if (employeeId) return list.filter(a => a.employeeId === employeeId);
    return this._filterByScope(list, a => a.employeeId);
  },
  async saveAdvance(adv) {
    const row = this._advToDB(adv);
    if (adv.id) row.id = adv.id;
    const { data, error } = await this.client.from('advances').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._advFromDB(data);
    const idx = this.data.advances.findIndex(a => a.id === mapped.id);
    if (idx >= 0) this.data.advances[idx] = mapped;
    else this.data.advances.unshift(mapped);
    return mapped;
  },
  async deleteAdvance(id) {
    const { error } = await this.client.from('advances').delete().eq('id', id);
    if (error) throw error;
    this.data.advances = this.data.advances.filter(a => a.id !== id);
  },

  // ─── ALLOWANCES ───
  getAllowances(employeeId = null) {
    let list = this.data.allowances.slice();
    if (employeeId) return list.filter(a => a.employeeId === employeeId);
    return this._filterByScope(list, a => a.employeeId);
  },
  async saveAllowance(rec) {
    const row = this._allowToDB(rec);
    if (rec.id) row.id = rec.id;
    const { data, error } = await this.client.from('allowances').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._allowFromDB(data);
    const idx = this.data.allowances.findIndex(a => a.id === mapped.id);
    if (idx >= 0) this.data.allowances[idx] = mapped;
    else this.data.allowances.unshift(mapped);
    return mapped;
  },
  async deleteAllowance(id) {
    const { error } = await this.client.from('allowances').delete().eq('id', id);
    if (error) throw error;
    this.data.allowances = this.data.allowances.filter(a => a.id !== id);
  },

  // ─── EVALUATIONS ───
  getEvaluations(employeeId = null) {
    let list = this.data.evaluations.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (employeeId) return list.filter(e => e.employeeId === employeeId);
    return this._filterByScope(list, e => e.employeeId);
  },
  async saveEvaluation(ev) {
    const row = this._evalToDB(ev);
    if (ev.id) row.id = ev.id;
    const { data, error } = await this.client.from('evaluations').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._evalFromDB(data);
    const idx = this.data.evaluations.findIndex(e => e.id === mapped.id);
    if (idx >= 0) this.data.evaluations[idx] = mapped;
    else this.data.evaluations.unshift(mapped);
    return mapped;
  },
  async deleteEvaluation(id) {
    const { error } = await this.client.from('evaluations').delete().eq('id', id);
    if (error) throw error;
    this.data.evaluations = this.data.evaluations.filter(e => e.id !== id);
  },

  // ─── APPLICANTS (Recruit) ───
  // Status: new / screening / interviewed / passed / rejected / hired
  getApplicants(filter = {}) {
    let list = this.data.applicants.slice();
    if (filter.status) list = list.filter(a => a.status === filter.status);
    if (filter.year)   list = list.filter(a => String(a.appliedDate || '').startsWith(String(filter.year)));
    if (filter.search) {
      const s = filter.search.toLowerCase();
      list = list.filter(a =>
        ((a.firstName || '') + ' ' + (a.lastName || '')).toLowerCase().includes(s) ||
        (a.nickname || '').toLowerCase().includes(s) ||
        (a.phone || '').includes(s) ||
        (a.email || '').toLowerCase().includes(s) ||
        (a.positionTitle || '').toLowerCase().includes(s)
      );
    }
    // เรียงล่าสุดก่อน
    return list.sort((a, b) => (b.appliedDate || '').localeCompare(a.appliedDate || ''));
  },
  getApplicant(id) { return this.data.applicants.find(a => a.id === id); },

  // ─── BLACKLIST ───
  // จัดการรายชื่อบุคคลที่ห้ามจ้าง — auto-check ตอน add employee + แสดง modal เตือน
  // ใช้ RPC check_blacklist เพื่อ bypass RLS (SECURITY DEFINER)
  async checkBlacklist(nationalId) {
    if (!nationalId) return [];
    const digits = String(nationalId).replace(/\D/g, '');
    if (!digits) return [];
    try {
      const { data, error } = await this.client.rpc('check_blacklist', { p_national_id: digits });
      if (error) {
        // ถ้า RPC ไม่มี (ยังไม่ได้รัน migration) → return [] เงียบๆ
        if (String(error.message || '').includes('does not exist')) return [];
        throw error;
      }
      return data || [];
    } catch (ex) {
      console.warn('checkBlacklist failed:', ex);
      return [];
    }
  },
  async getBlacklist({ includeRemoved = false } = {}) {
    if (!this.isHR) return [];
    let q = this.client.from('employee_blacklist').select('*').order('created_at', { ascending: false });
    if (!includeRemoved) q = q.is('removed_at', null);
    const { data, error } = await q;
    if (error) {
      if (String(error.message || '').includes('does not exist')) return [];
      throw error;
    }
    return data || [];
  },
  async saveBlacklistEntry(entry) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const row = {
      national_id: String(entry.nationalId || '').replace(/\D/g, ''),
      full_name: (entry.fullName || '').trim(),
      nickname: entry.nickname || null,
      phone: entry.phone || null,
      previous_emp_id: entry.previousEmpId || null,
      reason: (entry.reason || '').trim(),
      category: entry.category || 'other',
      severity: entry.severity || 'permanent',
      review_date: entry.reviewDate || null,
      notes: entry.notes || null,
      created_by: this.profile?.employee_id || this.user?.email || 'HR'
    };
    if (!row.national_id) throw new Error('ต้องระบุเลขประจำตัวประชาชน');
    if (!row.full_name) throw new Error('ต้องระบุชื่อ-นามสกุล');
    if (!row.reason) throw new Error('ต้องระบุเหตุผล');
    if (row.severity === 'temporary' && !row.review_date) throw new Error('ลักษณะ "ห้ามชั่วคราว" ต้องระบุ review_date');
    if (entry.id) row.id = entry.id;
    const { data, error } = await this.client.from('employee_blacklist').upsert(row).select().single();
    if (error) throw error;
    return data;
  },
  async removeBlacklistEntry(id, reason = '') {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const { error } = await this.client.from('employee_blacklist').update({
      removed_at: new Date().toISOString(),
      removed_by: this.profile?.employee_id || this.user?.email || 'HR',
      removed_reason: reason || null
    }).eq('id', id);
    if (error) throw error;
  },

  async saveApplicant(appl) {
    const row = this._applToDB(appl);
    if (appl.id) row.id = appl.id;
    const { data, error } = await this.client.from('applicants').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._applFromDB(data);
    const idx = this.data.applicants.findIndex(a => a.id === mapped.id);
    if (idx >= 0) this.data.applicants[idx] = mapped;
    else this.data.applicants.unshift(mapped);
    return mapped;
  },
  async deleteApplicant(id) {
    const { error } = await this.client.from('applicants').delete().eq('id', id);
    if (error) throw error;
    this.data.applicants = this.data.applicants.filter(a => a.id !== id);
  },
  // เปลี่ยนสถานะอย่างเดียว — เร็วกว่าโหลด full record
  async setApplicantStatus(id, status, extraFields = {}) {
    const update = { status, ...extraFields };
    const { data, error } = await this.client.from('applicants').update(update).eq('id', id).select().single();
    if (error) throw error;
    const mapped = this._applFromDB(data);
    const idx = this.data.applicants.findIndex(a => a.id === mapped.id);
    if (idx >= 0) this.data.applicants[idx] = mapped;
    return mapped;
  },
  // Bulk insert applicants — ใช้สำหรับ import จาก Excel
  async bulkInsertApplicants(rows, onProgress) {
    const CHUNK = 100;
    const result = { inserted: 0, failed: 0, errors: [] };
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map(r => this._applToDB(r));
      const { data, error } = await this.client.from('applicants').insert(chunk).select();
      if (error) {
        result.failed += chunk.length;
        result.errors.push({ chunk: i / CHUNK + 1, message: error.message });
      } else {
        result.inserted += data.length;
        for (const row of data) {
          const mapped = this._applFromDB(row);
          this.data.applicants.unshift(mapped);
        }
      }
      if (onProgress) onProgress(Math.min(i + CHUNK, rows.length), rows.length);
      await new Promise(r => requestAnimationFrame(r));
    }
    return result;
  },

  getApplicantStats() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const thisMonth = today.slice(0, 7);
    const list = this.data.applicants;
    const inMonth = list.filter(a => (a.appliedDate || '').startsWith(thisMonth));
    return {
      total: list.length,
      newThisMonth: inMonth.length,
      pendingInterview: list.filter(a => a.status === 'screening').length,
      interviewed: list.filter(a => a.status === 'interviewed').length,
      passed: list.filter(a => a.status === 'passed').length,
      hiredYTD: list.filter(a => a.status === 'hired' && (a.decidedDate || '').slice(0, 4) === today.slice(0, 4)).length,
      rejected: list.filter(a => a.status === 'rejected').length
    };
  },

  // ─── UNIFORM ITEMS (master) ───
  getUniformItems({ activeOnly = false } = {}) {
    let list = this.data.uniformItems.slice();
    if (activeOnly) list = list.filter(i => i.active);
    return list.sort((a, b) => (a.name || '').localeCompare(b.name || '') || (a.size || '').localeCompare(b.size || ''));
  },
  getUniformItem(id) { return this.data.uniformItems.find(i => i.id === id); },
  async saveUniformItem(item) {
    const row = this._uniItemToDB(item);
    if (item.id) row.id = item.id;
    const { data, error } = await this.client.from('uniform_items').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._uniItemFromDB(data);
    const idx = this.data.uniformItems.findIndex(i => i.id === mapped.id);
    if (idx >= 0) this.data.uniformItems[idx] = mapped;
    else this.data.uniformItems.unshift(mapped);
    return mapped;
  },
  async deleteUniformItem(id) {
    const { error } = await this.client.from('uniform_items').delete().eq('id', id);
    if (error) throw error;
    this.data.uniformItems = this.data.uniformItems.filter(i => i.id !== id);
  },
  // Adjust stock — positive to add, negative to deduct
  async adjustUniformStock(itemId, delta) {
    const item = this.getUniformItem(itemId);
    if (!item) return;
    const newQty = Math.max(0, Number(item.stockQty || 0) + Number(delta));
    const { data, error } = await this.client.from('uniform_items')
      .update({ stock_qty: newQty })
      .eq('id', itemId)
      .select().single();
    if (error) throw error;
    const mapped = this._uniItemFromDB(data);
    const idx = this.data.uniformItems.findIndex(i => i.id === mapped.id);
    if (idx >= 0) this.data.uniformItems[idx] = mapped;
  },

  // ─── UNIFORM REQUESTS (header) ───
  getUniformRequests({ status, employeeId, _noScope = false } = {}) {
    let list = this.data.uniformRequests.slice();
    if (status) list = list.filter(r => r.status === status);
    if (employeeId) list = list.filter(r => r.employeeId === employeeId);
    // Auto-scope (เฉพาะเมื่อไม่ได้ระบุ employeeId)
    if (!_noScope && !employeeId) {
      list = this._filterByScope(list, r => r.employeeId);
    }
    return list.sort((a, b) => (b.requestedDate || '').localeCompare(a.requestedDate || ''));
  },
  getUniformRequest(id) { return this.data.uniformRequests.find(r => r.id === id); },
  // หาคำขอที่ link กับ applicant (อาจจะมี 1 รายการ ถ้าสร้างจาก recruit flow)
  getUniformRequestByApplicant(applicantId) {
    return this.data.uniformRequests.find(r => r.applicantId === applicantId);
  },
  // เรียกหลัง hire → link คำขอเดิมของ applicant ไปยัง employee_id ใหม่
  async linkUniformRequestToEmployee(applicantId, employeeId) {
    const req = this.getUniformRequestByApplicant(applicantId);
    if (!req || req.employeeId) return null;
    const { data, error } = await this.client.from('uniform_requests')
      .update({ employee_id: employeeId })
      .eq('id', req.id)
      .select().single();
    if (error) throw error;
    const mapped = this._uniReqFromDB(data);
    const idx = this.data.uniformRequests.findIndex(r => r.id === req.id);
    if (idx >= 0) this.data.uniformRequests[idx] = mapped;
    // อัปเดต issues ที่ link กับ request นี้ด้วย
    await this.client.from('uniform_issues').update({ employee_id: employeeId }).eq('request_id', req.id);
    this.data.uniformIssues.forEach(i => { if (i.requestId === req.id) i.employeeId = employeeId; });
    return mapped;
  },
  async saveUniformRequest(req) {
    const row = this._uniReqToDB(req);
    if (req.id) row.id = req.id;
    const { data, error } = await this.client.from('uniform_requests').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._uniReqFromDB(data);
    const idx = this.data.uniformRequests.findIndex(r => r.id === mapped.id);
    if (idx >= 0) this.data.uniformRequests[idx] = mapped;
    else this.data.uniformRequests.unshift(mapped);
    return mapped;
  },
  async deleteUniformRequest(id) {
    const { error } = await this.client.from('uniform_requests').delete().eq('id', id);
    if (error) throw error;
    this.data.uniformRequests = this.data.uniformRequests.filter(r => r.id !== id);
    // child issues จะถูกลบโดย CASCADE ใน DB — clean local too
    this.data.uniformIssues = this.data.uniformIssues.filter(i => i.requestId !== id);
  },

  // ─── UNIFORM ISSUES (line items) ───
  getUniformIssues({ requestId, employeeId } = {}) {
    let list = this.data.uniformIssues.slice();
    if (requestId) list = list.filter(i => i.requestId === requestId);
    if (employeeId) list = list.filter(i => i.employeeId === employeeId);
    return list.sort((a, b) => (b.issuedDate || '').localeCompare(a.issuedDate || ''));
  },
  // Save issue + auto-deduct stock + recalc request.total_cost
  async saveUniformIssue(issue) {
    issue.totalCost = Number(issue.qty || 0) * Number(issue.unitCost || 0);
    const row = this._uniIssueToDB(issue);
    if (issue.id) row.id = issue.id;
    const { data, error } = await this.client.from('uniform_issues').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._uniIssueFromDB(data);
    const idx = this.data.uniformIssues.findIndex(i => i.id === mapped.id);
    const isNew = idx < 0;
    if (isNew) this.data.uniformIssues.unshift(mapped);
    else this.data.uniformIssues[idx] = mapped;

    // deduct stock เฉพาะตอน insert ใหม่ (กัน double-deduct ตอน update)
    if (isNew && issue.itemId && Number(issue.qty) > 0) {
      try { await this.adjustUniformStock(issue.itemId, -Number(issue.qty)); }
      catch (ex) { console.warn('Stock deduct failed:', ex); }
    }
    // recalc parent request total
    if (mapped.requestId) await this._recalcUniformRequestTotal(mapped.requestId);
    return mapped;
  },
  async deleteUniformIssue(id) {
    const issue = this.data.uniformIssues.find(i => i.id === id);
    if (!issue) return;
    const { error } = await this.client.from('uniform_issues').delete().eq('id', id);
    if (error) throw error;
    this.data.uniformIssues = this.data.uniformIssues.filter(i => i.id !== id);
    // คืน stock + recalc total
    if (issue.itemId && Number(issue.qty) > 0) {
      try { await this.adjustUniformStock(issue.itemId, +Number(issue.qty)); } catch (ex) {}
    }
    if (issue.requestId) await this._recalcUniformRequestTotal(issue.requestId);
  },
  async _recalcUniformRequestTotal(requestId) {
    const issues = this.data.uniformIssues.filter(i => i.requestId === requestId);
    const total = issues.reduce((s, i) => s + Number(i.totalCost || 0), 0);
    const req = this.getUniformRequest(requestId);
    if (!req) return;
    const newStatus = issues.length > 0 ? 'issued' : req.status;
    const { data, error } = await this.client.from('uniform_requests')
      .update({ total_cost: total, status: newStatus })
      .eq('id', requestId)
      .select().single();
    if (error) return;
    const mapped = this._uniReqFromDB(data);
    const idx = this.data.uniformRequests.findIndex(r => r.id === requestId);
    if (idx >= 0) this.data.uniformRequests[idx] = mapped;
  },

  // ─── UNIFORM DELIVERY SCHEDULE (รอบการจัดส่ง) ───
  // เก็บ "สาขา X ส่งวัน Y" — ใช้คำนวณวันส่งถัดไปอัตโนมัติ
  getUniformSchedules({ branchCode, activeOnly = false } = {}) {
    let list = this.data.uniformSchedule.slice();
    if (branchCode) list = list.filter(s => s.branchCode === branchCode);
    if (activeOnly) list = list.filter(s => s.active);
    return list.sort((a, b) => (a.branchCode || '').localeCompare(b.branchCode || '') || (a.dayOfWeek - b.dayOfWeek));
  },
  getUniformSchedule(id) { return this.data.uniformSchedule.find(s => s.id === id); },
  async saveUniformSchedule(sched) {
    const row = this._uniSchedToDB(sched);
    if (sched.id) row.id = sched.id;
    const { data, error } = await this.client.from('uniform_delivery_schedule').upsert(row, { onConflict: 'branch_code,day_of_week' }).select().single();
    if (error) throw error;
    const mapped = this._uniSchedFromDB(data);
    const idx = this.data.uniformSchedule.findIndex(s => s.id === mapped.id);
    if (idx >= 0) this.data.uniformSchedule[idx] = mapped;
    else this.data.uniformSchedule.unshift(mapped);
    return mapped;
  },
  async deleteUniformSchedule(id) {
    const { error } = await this.client.from('uniform_delivery_schedule').delete().eq('id', id);
    if (error) throw error;
    this.data.uniformSchedule = this.data.uniformSchedule.filter(s => s.id !== id);
  },
  // คำนวณวันส่งถัดไปสำหรับสาขา (อิงเวลาไทย) — คืน {date: 'YYYY-MM-DD', dayName: 'พุธ'} หรือ null
  getNextDeliveryDate(branchCode, fromDate = null) {
    if (!branchCode) return null;
    const schedules = this.getUniformSchedules({ branchCode, activeOnly: true });
    if (!schedules.length) return null;
    const days = schedules.map(s => s.dayOfWeek);
    // เริ่มจาก fromDate (default = วันนี้ +1) — หาวันถัดไปที่ตรงกับ schedule
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const start = fromDate || todayStr;
    const [y, m, d] = start.split('-').map(Number);
    // สแกน 14 วันข้างหน้า — ครอบ 2 รอบสัปดาห์
    for (let offset = 1; offset <= 14; offset++) {
      const dt = new Date(y, m - 1, d + offset);
      const dow = dt.getDay();
      if (days.includes(dow)) {
        const pad = (n) => String(n).padStart(2, '0');
        const dayNames = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
        return {
          date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
          dayName: dayNames[dow]
        };
      }
    }
    return null;
  },

  // KPI สำหรับหน้า dashboard uniform
  getUniformStats() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const thisMonth = today.slice(0, 7);
    const reqs = this.data.uniformRequests;
    const issues = this.data.uniformIssues;
    return {
      pending: reqs.filter(r => r.status === 'pending').length,
      preparing: reqs.filter(r => r.status === 'preparing').length,
      issuedThisMonth: reqs.filter(r => r.status === 'issued' && (r.requestedDate || '').startsWith(thisMonth)).length,
      totalUnpaid: issues.reduce((s, i) => s + Number(i.totalCost || 0), 0),
      lowStock: this.data.uniformItems.filter(i => i.active && Number(i.stockQty || 0) < 5).length
    };
  },
  // ค่าชุดทั้งหมดของพนักงาน (สำหรับแสดงใน profile)
  getUniformCostForEmployee(employeeId) {
    return this.data.uniformIssues
      .filter(i => i.employeeId === employeeId)
      .reduce((s, i) => s + Number(i.totalCost || 0), 0);
  },

  // ─── CALENDAR ───
  getCalendar() { return this.data.calendar.slice().sort((a, b) => a.date.localeCompare(b.date)); },
  async saveCalendarItem(item) {
    const row = this._calToDB(item);
    if (item.id) row.id = item.id;
    const { data, error } = await this.client.from('calendar_items').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._calFromDB(data);
    const idx = this.data.calendar.findIndex(c => c.id === mapped.id);
    if (idx >= 0) this.data.calendar[idx] = mapped;
    else this.data.calendar.push(mapped);
    return mapped;
  },
  async deleteCalendarItem(id) {
    const { error } = await this.client.from('calendar_items').delete().eq('id', id);
    if (error) throw error;
    this.data.calendar = this.data.calendar.filter(c => c.id !== id);
  },

  // ─── COMPANY SETTINGS ───
  async saveCompany(data) {
    const row = {
      id: 1,
      name: data.name, name_en: data.nameEn, tax_id: data.taxId,
      address: data.address, phone: data.phone, email: data.email
    };
    const { error } = await this.client.from('company_settings').upsert(row);
    if (error) throw error;
    this.data.company = { ...data };
  },

  // ─── PASSWORD ───
  // เปลี่ยนรหัสผ่านพนักงานเอง — verify รหัสเก่าก่อนเปลี่ยน
  // newPassword ต้องอย่างน้อย 8 ตัว
  async changePassword(oldPassword, newPassword) {
    if (!this.user?.email) throw new Error('ไม่มี session ปัจจุบัน — กรุณา login ใหม่');
    if (!oldPassword) throw new Error('กรุณากรอกรหัสผ่านปัจจุบัน');
    if (!newPassword || newPassword.length < 8) throw new Error('รหัสผ่านใหม่ต้องอย่างน้อย 8 ตัว');
    if (oldPassword === newPassword) throw new Error('รหัสผ่านใหม่ต้องต่างจากรหัสเดิม');
    // ─── 1) Verify old password ผ่าน signInWithPassword ───
    // ถ้าผ่าน session ใหม่จะ replace อันเดิม (เป็นคนเดิม) → ใช้งานต่อได้ทันที
    const captchaToken = await this._getCaptchaToken('reauth');
    const { error: verifyErr } = await this.client.auth.signInWithPassword({
      email: this.user.email,
      password: oldPassword,
      options: captchaToken ? { captchaToken } : undefined
    });
    if (verifyErr) throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    // ─── 2) Update เป็นรหัสใหม่ ───
    const { error: updErr } = await this.client.auth.updateUser({ password: newPassword });
    if (updErr) throw updErr;
  },

  // ─── EMPLOYEE ACCOUNT MANAGEMENT (admin only — RPC calls) ───
  async refetchUserProfiles() {
    // ใช้เพื่อรีเฟรช cache ของบัญชีหลังสร้าง/แก้ไข
    const { data, error } = await this.client.from('user_profiles').select('*');
    if (error) throw error;
    this._userProfiles = data || [];
    return this._userProfiles;
  },

  async getUserProfilesList() {
    if (!this._userProfiles) await this.refetchUserProfiles();
    return this._userProfiles;
  },

  // คำนวณรหัสผ่านเริ่มต้นจากข้อมูลพนักงาน
  // นโยบายของบริษัท: ใช้เลข ปชช เป็นรหัสผ่านเริ่มต้นให้ทุกคน (สะดวกสำหรับ HR)
  //  1) เลข ปชช (>= 6 หลัก, strip non-digit) → ใช้
  //  2) Passport number (>= 6 ตัว) → ใช้ (สำหรับชาวต่างชาติ)
  //  3) Fallback → "kacha{employee_id}"
  // ⚠️ Security note: เพื่อนร่วมงานที่อ่าน RLS scope ของ employees ในสาขาเดียวกัน
  //    เห็นเลข ปชช ของกัน → สามารถ login เป็นกันได้ — แนะนำให้พนักงานเปลี่ยนรหัสผ่าน
  //    ผ่านปุ่ม 🔒 มุมล่างซ้ายหลัง login ครั้งแรก
  _computeInitialPassword(emp) {
    const nat = String(emp.nationalId || '').replace(/\D/g, '');
    if (nat.length >= 6) return { password: nat, source: 'เลขประชาชน' };
    const pp = String(emp.passportNumber || '').trim();
    if (pp.length >= 6) return { password: pp, source: 'passport' };
    return { password: `kacha${emp.id}`, source: 'kacha+รหัส' };
  },

  // [Security H5] สร้างบัญชีพนักงานผ่าน SECURITY DEFINER RPC แทน public signUp
  // เดิม: signUp() เปิด public → attacker เดา employee_id แล้ว claim ได้
  // ใหม่: RPC create_employee_user เช็ค is_hr_or_admin() ก่อน — ปลอดภัยแม้ปิด public signup
  async createEmployeeAccount(employeeId) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const emp = this.getEmployee(employeeId);
    if (!emp) throw new Error('ไม่พบพนักงาน ' + employeeId);

    const { password, source } = this._computeInitialPassword(emp);
    const email = `${String(employeeId).toLowerCase()}@kacha.local`;

    const { data, error } = await this.client.rpc('create_employee_user', {
      p_employee_id: employeeId,
      p_password: password
    });
    if (error) throw error;

    // refresh local user_profiles cache (handle_new_user trigger สร้าง row ใหม่ใน DB แล้ว)
    await this.refetchUserProfiles();

    return {
      user_id: data?.user_id,
      email: data?.email || email,
      password,
      source,
      created: true,
      message: data?.message || 'สร้างบัญชีสำเร็จ'
    };
  },

  async bulkCreateEmployeeAccounts() {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const profiles = await this.refetchUserProfiles();
    const linked = new Set((profiles || []).filter(p => p.employee_id).map(p => p.employee_id));
    const todo = this.data.employees.filter(e => this.empStatus(e) !== 'resigned' && !linked.has(e.id));
    const results = [];
    for (const emp of todo) {
      try {
        const res = await this.createEmployeeAccount(emp.id);
        results.push({ employee_id: emp.id, email: res.email, password: res.password, source: res.source, created: !!res.created, message: res.message });
      } catch (ex) {
        results.push({ employee_id: emp.id, email: `${emp.id.toLowerCase()}@kacha.local`, created: false, message: 'ERROR: ' + (ex.message || String(ex)) });
      }
    }
    await this.refetchUserProfiles();
    return results;
  },

  async resetEmployeePassword(employeeId, newPassword = null) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const { data, error } = await this.client.rpc('reset_employee_password', {
      p_employee_id: employeeId,
      p_new_password: newPassword
    });
    if (error) throw error;
    return data;
  },

  async setEmployeeRole(employeeId, role, branches = null) {
    // Guard ฝั่ง client: admin หรือ hr — RPC ตรวจซ้ำที่ฝั่ง DB อยู่ดี (defense in depth)
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    // [Security M6] HR ตั้ง role ระดับสูง (admin/hr/operation_manager) ไม่ได้ — เฉพาะ admin
    // ป้องกัน HR สร้าง user proxy ที่เห็นข้อมูลทั่วบริษัทผ่าน operation_manager
    if (!this.isAdmin) {
      const HR_ALLOWED = ['area_manager', 'branch_manager', 'branch_staff', 'viewer'];
      if (!HR_ALLOWED.includes(role)) {
        throw new Error('HR ตั้ง role นี้ไม่ได้ — admin เท่านั้น (เช่น hr, operation_manager)');
      }
    }
    const { data, error } = await this.client.rpc('set_employee_role', {
      p_employee_id: employeeId,
      p_role: role,
      p_branches: branches // null = คงค่าเดิม; [] = เคลียร์; [...] = ตั้งใหม่
    });
    if (error) throw error;
    await this.refetchUserProfiles();
    return data;
  },

  // ─── AUDIT LOG (admin only) ───
  // ไม่ cache — query on demand เพราะข้อมูลโตเรื่อยๆ + ต้องการ filter
  // คืน { rows: [...], total: N } — pagination ที่ฝั่งเซิร์ฟเวอร์
  async fetchAuditLog({ limit = 100, offset = 0, table = null, action = null, recordId = null, search = null, from = null, to = null } = {}) {
    if (!this.isAdmin) throw new Error('ดูได้เฉพาะ admin');
    let q = this.client.from('audit_log').select('*', { count: 'exact' });
    if (table) q = q.eq('table_name', table);
    if (action) q = q.eq('action', action);
    if (recordId) q = q.eq('record_id', recordId);
    if (from) q = q.gte('ts', from);
    if (to) q = q.lte('ts', to);
    if (search) {
      // search ใน user_email หรือ record_id — strip chars ที่ break PostgREST .or() syntax
      // [Security M5] escape LIKE wildcards (% _ \) เพื่อไม่ให้ user ใส่ _ แล้ว match ทุกตัว
      const s = String(search).replace(/[,()]/g, ' ').trim();
      if (s) {
        const escaped = s.replace(/[\\%_]/g, '\\$&');
        q = q.or(`user_email.ilike.%${escaped}%,record_id.ilike.%${escaped}%`);
      }
    }
    q = q.order('ts', { ascending: false }).range(offset, offset + limit - 1);
    const { data, count, error } = await q;
    if (error) throw error;
    return { rows: data || [], total: count || 0 };
  },

  // ─── HOLIDAY SWAP HISTORY (admin only) ───
  // ดึง audit_log เฉพาะ calendar_items แล้วกรองเฉพาะที่มีการเปลี่ยน swap_to_date
  // คืนรายการ { ts, userEmail, userRole, action, holidayDate, holidayTitle, oldSwap, newSwap, oldNote, newNote }
  async fetchHolidaySwapHistory({ limit = 100 } = {}) {
    if (!this.isAdmin) throw new Error('ดูได้เฉพาะ admin');
    const { rows } = await this.fetchAuditLog({ table: 'calendar_items', limit });
    const result = [];
    for (const r of rows) {
      const oldSwap = r.old_data?.swap_to_date || null;
      const newSwap = r.new_data?.swap_to_date || null;
      const oldNote = r.old_data?.swap_note || null;
      const newNote = r.new_data?.swap_note || null;
      // เก็บเฉพาะแถวที่เกี่ยวกับการเปลี่ยน swap
      const swapChanged = oldSwap !== newSwap || oldNote !== newNote;
      const insertWithSwap = r.action === 'INSERT' && newSwap;
      const deleteWithSwap = r.action === 'DELETE' && oldSwap;
      if (!swapChanged && !insertWithSwap && !deleteWithSwap) continue;
      result.push({
        ts: r.ts,
        userEmail: r.user_email || '',
        userRole: r.user_role || '',
        action: r.action,
        holidayDate: r.new_data?.date || r.old_data?.date || '',
        holidayTitle: r.new_data?.title || r.old_data?.title || '',
        oldSwap, newSwap, oldNote, newNote
      });
    }
    return result;
  },

  // ─── LEAVE MANAGEMENT (การลางาน) ───
  // ประเภทการลาเก็บใน table leave_types — admin แก้ไขได้ทั้ง label, max_days, gender, allow_backdate
  // ฟิลด์ rule = 'tenure' → ใช้สูตรลาพักร้อน (6 วันเมื่อครบ 1 ปี +1/ปี max=max_days)
  _leaveTypeFromDB: (r) => ({
    id: r.id,
    label: r.label,
    maxDays: r.max_days != null ? Number(r.max_days) : null,
    rule: r.rule || null,
    gender: r.gender || null,
    allowBackdate: !!r.allow_backdate,
    badge: r.badge || 'badge-info',
    sortOrder: Number(r.sort_order || 100),
    active: r.active !== false,
    note: r.note || ''
  }),

  _leaveTypeToDB(t) {
    return {
      id: t.id,
      label: t.label,
      max_days: t.maxDays != null && t.maxDays !== '' ? Number(t.maxDays) : null,
      rule: t.rule || null,
      gender: t.gender || null,
      allow_backdate: !!t.allowBackdate,
      badge: t.badge || 'badge-info',
      sort_order: Number(t.sortOrder || 100),
      active: t.active !== false,
      note: t.note || null
    };
  },

  // คืน config object ของประเภทการลาในรูปแบบ { id: { label, max, gender, badge, allowBackdate, rule } }
  // ใช้แทน LEAVE_TYPES เดิม — เพิ่มเฉพาะที่ active = true
  get LEAVE_TYPES() {
    const obj = {};
    const sorted = (this.data.leaveTypes || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
    for (const t of sorted) {
      if (!t.active) continue;
      obj[t.id] = {
        label: t.label,
        max: t.rule === 'tenure' ? 'tenure' : (t.maxDays || 0),
        maxCap: t.maxDays || 0,            // เพดานสำหรับสูตร tenure
        rule: t.rule || null,
        gender: t.gender || null,
        badge: t.badge || 'badge-info',
        allowBackdate: !!t.allowBackdate
      };
    }
    return obj;
  },

  getLeaveTypesList(includeInactive = false) {
    const list = (this.data.leaveTypes || []).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    return includeInactive ? list : list.filter(t => t.active);
  },

  getLeaveType(id) { return (this.data.leaveTypes || []).find(t => t.id === id); },

  async saveLeaveType(t) {
    if (!this.isAdmin) throw new Error('ต้องเป็น admin');
    const row = this._leaveTypeToDB(t);
    const { data, error } = await this.client.from('leave_types').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._leaveTypeFromDB(data);
    const idx = this.data.leaveTypes.findIndex(x => x.id === mapped.id);
    if (idx >= 0) this.data.leaveTypes[idx] = mapped;
    else this.data.leaveTypes.push(mapped);
    return mapped;
  },

  async deleteLeaveType(id) {
    if (!this.isAdmin) throw new Error('ต้องเป็น admin');
    // ป้องกัน FK error — เช็คก่อนว่ามี leave_requests อ้างอิงอยู่ไหม
    const used = this.data.leaveRequests.some(r => r.leaveType === id);
    if (used) throw new Error('มีคำขอลาใช้ประเภทนี้อยู่ — soft delete (ปิด active) แทน');
    const { error } = await this.client.from('leave_types').delete().eq('id', id);
    if (error) throw error;
    this.data.leaveTypes = this.data.leaveTypes.filter(x => x.id !== id);
  },

  _leaveFromDB: (r) => ({
    id: r.id,
    employeeId: r.employee_id,
    leaveType: r.leave_type,
    startDate: r.start_date,
    endDate: r.end_date,
    days: Number(r.days),
    reason: r.reason || '',
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    approverNote: r.approver_note || '',
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    cancelReason: r.cancel_reason || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }),

  _leaveToDB(l) {
    return {
      employee_id: l.employeeId,
      leave_type: l.leaveType,
      start_date: l.startDate,
      end_date: l.endDate,
      days: Number(l.days),
      reason: l.reason || null,
      status: l.status || 'pending'
    };
  },

  // normalize ค่า gender จากฐานข้อมูล (ไทย 'ชาย'/'หญิง' หรืออังกฤษ 'M'/'F') → 'M'/'F'/null
  genderCode(g) {
    if (!g) return null;
    const v = String(g).trim().toLowerCase();
    if (v === 'm' || v === 'ชาย' || v === 'male')   return 'M';
    if (v === 'f' || v === 'หญิง' || v === 'female') return 'F';
    return null;
  },

  // คำนวณโควต้าของพนักงาน ณ ปีหนึ่ง — ขึ้นกับ gender + อายุงาน (สำหรับ rule = 'tenure')
  calcLeaveQuota(emp, leaveType, year = new Date().getFullYear()) {
    const cfg = this.LEAVE_TYPES[leaveType];
    if (!cfg || !emp) return 0;
    if (cfg.gender && cfg.gender !== this.genderCode(emp.gender)) return 0;
    if (cfg.rule === 'tenure') {
      if (!emp.hireDate) return 0;
      const m = String(emp.hireDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!m) return 0;
      const hire = new Date(+m[1], +m[2] - 1, +m[3]);
      const endOfYear = new Date(year, 11, 31);
      let years = endOfYear.getFullYear() - hire.getFullYear();
      const beforeAnniv = (endOfYear.getMonth() < hire.getMonth()) ||
                          (endOfYear.getMonth() === hire.getMonth() && endOfYear.getDate() < hire.getDate());
      if (beforeAnniv) years--;
      if (years < 1) return 0;
      const cap = Number(cfg.maxCap || 12);
      return Math.min(cap, 6 + (years - 1));  // ครบ 1 ปี = 6 วัน, +1/ปี, max ตาม config
    }
    return Number(cfg.max || 0);
  },

  // นับวันที่ใช้ไปแล้ว — เฉพาะสถานะ approved + ในปีที่ระบุ
  calcLeaveUsed(empId, leaveType, year = new Date().getFullYear()) {
    return this.data.leaveRequests
      .filter(r => r.employeeId === empId && r.leaveType === leaveType && r.status === 'approved')
      .filter(r => {
        const m = String(r.startDate).match(/^(\d{4})/);
        return m && Number(m[1]) === year;
      })
      .reduce((s, r) => s + Number(r.days || 0), 0);
  },

  // คงเหลือ = โควต้า - ใช้ไป
  calcLeaveBalance(empId, leaveType, year = new Date().getFullYear()) {
    const emp = this.getEmployee(empId);
    if (!emp) return { quota: 0, used: 0, remaining: 0 };
    const quota = this.calcLeaveQuota(emp, leaveType, year);
    const used = this.calcLeaveUsed(empId, leaveType, year);
    return { quota, used, remaining: Math.max(0, quota - used) };
  },

  // หาผู้อนุมัติของพนักงานคนนี้
  // - พนักงานทั่วไป → ผู้จัดการสาขา (= position_level สูงสุดในสาขา)
  // - ถ้า requester เอง = ผู้จัดการสาขา → escalate ไปหา Area Manager ที่ดูแลสาขานั้น
  // - ถ้าไม่มี Area Manager → fallback ไป HR (คนแรกที่เจอ)
  getLeaveApprover(empId) {
    const emp = this.getEmployee(empId);
    if (!emp || !emp.branch) return null;
    const sameBranch = this.data.employees
      .filter(e => e.branch === emp.branch && this.empStatus(e) !== 'resigned');
    if (!sameBranch.length) return null;

    // ลำดับชั้นในสาขา (level สูง → ต่ำ)
    // Bug #6 fix: ใช้ byte-order comparison ให้ตรงกับ SQL (e.id ASC) — กัน JS/DB disagree สำหรับ ID พิเศษ
    const withLevel = sameBranch.map(e => {
      const pos = this.getPosition(e.position);
      return { emp: e, level: pos ? Number(pos.level || 0) : 0 };
    });
    withLevel.sort((a, b) => b.level - a.level || (a.emp.id < b.emp.id ? -1 : a.emp.id > b.emp.id ? 1 : 0));
    const topInBranch = withLevel[0].emp;

    // ถ้า requester ≠ ผู้จัดการสาขา → ผู้จัดการสาขาคืออนุมัติ
    if (topInBranch.id !== empId) return topInBranch;

    // requester = ผู้จัดการสาขา → escalate หา Area Manager
    // (1) หา user_profiles ที่ role='area_manager' + managed_branches มี branch นี้
    //     Bug #5 fix: sort by employee_id เพื่อให้ deterministic (ไม่สุ่มเปลี่ยน AM ระหว่าง session)
    const profiles = this._userProfiles || [];
    const amCandidates = profiles.filter(p =>
      p.role === 'area_manager' &&
      Array.isArray(p.managed_branches) &&
      p.managed_branches.includes(emp.branch) &&
      p.employee_id
    ).sort((a, b) => (a.employee_id < b.employee_id ? -1 : a.employee_id > b.employee_id ? 1 : 0));
    if (amCandidates.length) {
      const amEmp = this.getEmployee(amCandidates[0].employee_id);
      if (amEmp && this.empStatus(amEmp) !== 'resigned') return amEmp;
    }

    // (2) Fallback หา HR — Bug #5 fix: sort by employee_id ให้ deterministic
    const hrProfiles = profiles.filter(p => p.role === 'hr' && p.employee_id)
      .sort((a, b) => (a.employee_id < b.employee_id ? -1 : a.employee_id > b.employee_id ? 1 : 0));
    for (const hp of hrProfiles) {
      const hrEmp = this.getEmployee(hp.employee_id);
      if (hrEmp && this.empStatus(hrEmp) !== 'resigned') return hrEmp;
    }

    // (3) ไม่มี — คืน null (admin override only)
    return null;
  },

  // current user สามารถอนุมัติของ empId นี้ได้ไหม
  canApproveLeaveFor(empId) {
    if (this.isHR) return true; // admin + hr อนุมัติทุกคำขอ
    const approver = this.getLeaveApprover(empId);
    if (!approver) return false;
    return this.profile?.employee_id === approver.id;
  },

  getLeaveRequests({ employeeId = null, status = null, year = null, _noScope = false } = {}) {
    let list = this.data.leaveRequests.slice();
    if (employeeId) list = list.filter(r => r.employeeId === employeeId);
    if (status)     list = list.filter(r => r.status === status);
    if (year)       list = list.filter(r => String(r.startDate).startsWith(String(year)));
    // ─── Auto-scope ตาม RBAC (Phase 3) ───
    // branch_staff / viewer → เห็นเฉพาะของตัวเอง
    // branch_manager / area_manager → เห็นเฉพาะของพนักงานในสาขาที่ดูแล
    if (!_noScope && this.role && !employeeId) {
      if (this.role === 'branch_staff' || this.role === 'viewer') {
        const myId = this.profile?.employee_id;
        list = list.filter(r => r.employeeId === myId);
      } else if (this.role === 'branch_manager' || this.role === 'area_manager') {
        const scoped = this.scopedBranches() || [];
        const scopedEmpIds = new Set(this.data.employees.filter(e => scoped.includes(e.branch)).map(e => e.id));
        list = list.filter(r => scopedEmpIds.has(r.employeeId));
      }
    }
    return list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '') || (b.requestedAt || '').localeCompare(a.requestedAt || ''));
  },

  getLeaveRequest(id) {
    return this.data.leaveRequests.find(r => r.id === id);
  },

  async saveLeaveRequest(leave) {
    const row = this._leaveToDB(leave);
    if (leave.id) row.id = leave.id;
    if (!leave.id && this.user?.id) row.requested_by = this.user.id;
    const { data, error } = await this.client.from('leave_requests').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._leaveFromDB(data);
    const idx = this.data.leaveRequests.findIndex(x => x.id === mapped.id);
    if (idx >= 0) this.data.leaveRequests[idx] = mapped;
    else this.data.leaveRequests.unshift(mapped);
    return mapped;
  },

  // ตรวจสิทธิ์อนุมัติ: admin/hr → ทุกคำขอ, area_manager/branch_manager → เฉพาะคนที่ตัวเองเป็น approver ของ
  _ensureCanApproveLeave(requestId) {
    if (this.isHR) return; // admin + hr override ได้
    const req = this.getLeaveRequest(requestId);
    if (!req) throw new Error('ไม่พบคำขอลา');
    if (!this.canApproveLeaveFor(req.employeeId)) {
      throw new Error('คุณไม่ใช่ผู้อนุมัติของคำขอนี้');
    }
  },

  // กฎทางธุรกิจ: ห้ามอนุมัติคำขอลาที่วันสิ้นสุดผ่านไปแล้ว
  // ยกเว้น (1) ประเภทที่ allow_backdate (ลาป่วย / ลาคลอด / ลาคลอดช่วยภริยา)
  //       (2) admin / HR — override ได้ทุกกรณี (ทำได้ทุกอย่างไม่มีข้อยกเว้น)
  // ใช้กับ branch_manager / area_manager เท่านั้น
  _ensureLeaveDateApprovable(req) {
    if (this.isHR) return; // admin + hr bypass ทุกกรณี
    const cfg = this.LEAVE_TYPES[req.leaveType];
    if (cfg?.allowBackdate) return;
    const today = this.todayBkk();
    if (req.endDate && req.endDate < today) {
      const label = cfg?.label || req.leaveType;
      throw new Error(`ไม่สามารถอนุมัติได้ — วันลาผ่านไปแล้ว (สิ้นสุด ${req.endDate}) · ประเภท "${label}" ไม่อนุญาตให้อนุมัติย้อนหลัง · กรุณาปฏิเสธหรือยกเลิกคำขอนี้`);
    }
  },

  async approveLeaveRequest(id, note = '') {
    this._ensureCanApproveLeave(id);
    const req = this.getLeaveRequest(id);
    if (!req) throw new Error('ไม่พบคำขอลา');
    this._ensureLeaveDateApprovable(req);
    const { data, error } = await this.client.from('leave_requests')
      .update({ status: 'approved', approved_by: this.user?.id || null, approved_at: new Date().toISOString(), approver_note: note || null })
      .eq('id', id).select().single();
    if (error) throw error;
    return this._leaveFromDB(data);
  },

  async rejectLeaveRequest(id, note = '') {
    this._ensureCanApproveLeave(id);
    const { data, error } = await this.client.from('leave_requests')
      .update({ status: 'rejected', approved_by: this.user?.id || null, approved_at: new Date().toISOString(), approver_note: note || null })
      .eq('id', id).select().single();
    if (error) throw error;
    return this._leaveFromDB(data);
  },

  async cancelLeaveRequest(id, reason = '') {
    const { data, error } = await this.client.from('leave_requests')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: this.user?.id || null, cancel_reason: reason || null })
      .eq('id', id).select().single();
    if (error) throw error;
    return this._leaveFromDB(data);
  },

  async deleteLeaveRequest(id) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const { error } = await this.client.from('leave_requests').delete().eq('id', id);
    if (error) throw error;
    this.data.leaveRequests = this.data.leaveRequests.filter(r => r.id !== id);
  },

  // ─── HOLIDAY SWAP REQUESTS — ใช้ chain อนุมัติเดียวกับการลา ───
  // canApproveHolidaySwapFor reuses canApproveLeaveFor — same business rules
  canApproveHolidaySwapFor(empId) { return this.canApproveLeaveFor(empId); },
  getHolidaySwapApprover(empId)   { return this.getLeaveApprover(empId); },

  getHolidaySwapRequests({ status = null, calendarItemId = null, _noScope = false } = {}) {
    let list = (this.data.holidaySwapRequests || []).slice();
    if (status)         list = list.filter(r => r.status === status);
    if (calendarItemId) list = list.filter(r => r.calendarItemId === calendarItemId);
    // Auto-scope ตาม RBAC (เลียน leave): branch_staff/viewer เห็นของตัวเอง, manager เห็นใน scope สาขา
    if (!_noScope && this.role) {
      if (this.role === 'branch_staff' || this.role === 'viewer') {
        const myId = this.profile?.employee_id;
        list = list.filter(r => r.employeeId === myId);
      } else if (this.role === 'branch_manager' || this.role === 'area_manager') {
        const scoped = this.scopedBranches() || [];
        const scopedEmpIds = new Set(this.data.employees.filter(e => scoped.includes(e.branch)).map(e => e.id));
        list = list.filter(r => scopedEmpIds.has(r.employeeId));
      }
    }
    return list.sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
  },

  getHolidaySwapRequest(id) {
    return (this.data.holidaySwapRequests || []).find(r => r.id === id);
  },

  async saveHolidaySwapRequest(req) {
    const row = this._swapReqToDB(req);
    if (req.id) row.id = req.id;
    if (!req.id && this.user?.id) row.requested_by = this.user.id;
    const { data, error } = await this.client.from('holiday_swap_requests').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._swapReqFromDB(data);
    const idx = this.data.holidaySwapRequests.findIndex(x => x.id === mapped.id);
    if (idx >= 0) this.data.holidaySwapRequests[idx] = mapped;
    else this.data.holidaySwapRequests.unshift(mapped);
    return mapped;
  },

  _ensureCanApproveSwap(requestId) {
    if (this.isHR) return;
    const req = this.getHolidaySwapRequest(requestId);
    if (!req) throw new Error('ไม่พบคำขอเปลี่ยนวันหยุด');
    if (!this.canApproveHolidaySwapFor(req.employeeId)) {
      throw new Error('คุณไม่ใช่ผู้อนุมัติของคำขอนี้');
    }
  },

  async approveHolidaySwapRequest(id, note = '') {
    this._ensureCanApproveSwap(id);
    const { data, error } = await this.client.from('holiday_swap_requests')
      .update({ status: 'approved', approved_by: this.user?.id || null, approved_at: new Date().toISOString(), approver_note: note || null })
      .eq('id', id).select().single();
    if (error) throw error;
    return this._swapReqFromDB(data);
  },

  async rejectHolidaySwapRequest(id, note = '') {
    this._ensureCanApproveSwap(id);
    const { data, error } = await this.client.from('holiday_swap_requests')
      .update({ status: 'rejected', approved_by: this.user?.id || null, approved_at: new Date().toISOString(), approver_note: note || null })
      .eq('id', id).select().single();
    if (error) throw error;
    return this._swapReqFromDB(data);
  },

  async cancelHolidaySwapRequest(id, reason = '') {
    const { data, error } = await this.client.from('holiday_swap_requests')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: this.user?.id || null, cancel_reason: reason || null })
      .eq('id', id).select().single();
    if (error) throw error;
    return this._swapReqFromDB(data);
  },

  async deleteHolidaySwapRequest(id) {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    const { error } = await this.client.from('holiday_swap_requests').delete().eq('id', id);
    if (error) throw error;
    this.data.holidaySwapRequests = this.data.holidaySwapRequests.filter(r => r.id !== id);
  },

  // ─── COMPANY ANNOUNCEMENTS — ประกาศ + คำสั่งบริษัท ───
  getAnnouncements({ type = null, year = null } = {}) {
    let list = (this.data.announcements || []).slice();
    if (type) list = list.filter(a => a.type === type);
    if (year) list = list.filter(a => String(a.createdAt || '').startsWith(String(year)));
    // เรียง: pinned ก่อน, แล้ว createdAt ใหม่สุด
    return list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
  },

  getAnnouncement(id) {
    return (this.data.announcements || []).find(a => a.id === id);
  },

  // เลขที่ถัดไป (เช่น "003/2569") — นับจากประกาศ/คำสั่งประเภทเดียวกันในปี พ.ศ. ปัจจุบัน
  // คืน null ถ้ามีเลข custom format ที่ parse ไม่ออก (ปล่อยให้ user พิมพ์เอง)
  suggestNextAnnouncementNumber(type = 'announcement') {
    const today = new Date();
    const beYear = today.getFullYear() + 543;
    const list = (this.data.announcements || []).filter(a => a.type === type && a.docNumber);
    // หา running number สูงสุดของปี BE นี้
    let maxRunning = 0;
    const yearStr = String(beYear);
    for (const a of list) {
      const m = String(a.docNumber).match(/^(\d+)\s*\/\s*(\d{4})$/);
      if (!m) continue;
      if (m[2] !== yearStr) continue;
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxRunning) maxRunning = n;
    }
    return `${String(maxRunning + 1).padStart(3, '0')}/${beYear}`;
  },

  async saveAnnouncement(ann) {
    if (!this.isHR) throw new Error('เฉพาะ admin / HR เท่านั้น');
    const row = this._annToDB(ann);
    if (ann.id) row.id = ann.id;
    if (!ann.id && this.user?.id) row.created_by = this.user.id;
    const { data, error } = await this.client.from('company_announcements').upsert(row).select().single();
    if (error) throw error;
    const mapped = this._annFromDB(data);
    const idx = this.data.announcements.findIndex(a => a.id === mapped.id);
    if (idx >= 0) this.data.announcements[idx] = mapped;
    else this.data.announcements.unshift(mapped);
    return mapped;
  },

  async deleteAnnouncement(id) {
    if (!this.isHR) throw new Error('เฉพาะ admin / HR เท่านั้น');
    // ลบรูปใน storage ก่อน (ถ้ามี)
    const ann = this.getAnnouncement(id);
    if (ann?.imageUrl) {
      try {
        const path = ann.imageUrl.split('/announcement-images/')[1];
        if (path) await this.client.storage.from('announcement-images').remove([path]);
      } catch (e) { /* image อาจถูกลบไปแล้ว — ปล่อยผ่าน */ }
    }
    const { error } = await this.client.from('company_announcements').delete().eq('id', id);
    if (error) throw error;
    this.data.announcements = this.data.announcements.filter(a => a.id !== id);
  },

  // ─── ANNOUNCEMENT READ RECEIPTS ───
  // mark = พนักงานเปิดอ่าน (ignore duplicate — เก็บเวลาอ่านครั้งแรก)
  // admin/HR ไม่ถูกบันทึก (พวกเขาเป็นคนสร้าง — ไม่ใช่ผู้รับสาร)
  async markAnnouncementRead(announcementId) {
    // HR ปกติ: ไม่บันทึก (เป็นผู้สร้างประกาศ ไม่ใช่ผู้รับ)
    // HR ใน "ดูเสมือนพนักงาน": บันทึกได้
    if (this.isHR && !this.isViewingAsEmployee()) return;
    const empId = this.profile?.employee_id;
    if (!empId) return;     // ไม่มี employee_id (เช่น admin ที่ไม่ผูกพนักงาน)
    if (this._myAnnReads?.has(announcementId)) return; // อ่านแล้ว — skip network
    try {
      await this.client.from('announcement_reads').upsert({
        announcement_id: announcementId,
        employee_id: empId,
        user_id: this.user?.id || null
      }, { onConflict: 'announcement_id,employee_id', ignoreDuplicates: true });
      if (this._myAnnReads) this._myAnnReads.add(announcementId);
    } catch (e) {
      console.warn('[ann-read] mark failed:', e.message || e);
    }
  },

  // เช็คว่าประกาศนี้ฉันอ่านแล้วหรือยัง
  isAnnouncementRead(id) { return this._myAnnReads?.has(id) || false; },

  // จำนวนประกาศที่ยังไม่ได้อ่าน (สำหรับ badge sidebar)
  // - HR ปกติ → 0 (ไม่นับ unread เพราะเป็นผู้สร้าง)
  // - HR ที่กำลังดูเสมือนพนักงาน → นับจริง
  // - พนักงานทั่วไป → นับจริง
  getUnreadAnnouncementCount() {
    if (this.isHR && !this.isViewingAsEmployee()) return 0;
    if (!this.profile?.employee_id || !this._myAnnReads) return 0;
    let count = 0;
    for (const a of (this.data.announcements || [])) {
      if (!this._myAnnReads.has(a.id)) count++;
    }
    return count;
  },

  // ดึงรายชื่อผู้อ่าน + ผู้ที่ยังไม่อ่าน — เฉพาะ admin/HR
  // คืน { readers: [{employeeId, name, branch, position, readAt}], unread: [...] }
  async getAnnouncementReaders(announcementId) {
    if (!this.isHR) return { readers: [], unread: [] };
    const { data, error } = await this.client.from('announcement_reads')
      .select('employee_id, read_at')
      .eq('announcement_id', announcementId)
      .order('read_at', { ascending: false });
    if (error) throw error;
    const empById = new Map(this.data.employees.map(e => [e.id, e]));
    const readMap = new Map((data || []).map(r => [r.employee_id, r.read_at]));
    const fmt = (e) => ({
      employeeId: e.id,
      name: `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.id,
      branch: e.branch || '',
      position: e.positionTitle || ''
    });
    const readers = (data || []).map(r => {
      const e = empById.get(r.employee_id);
      return e ? { ...fmt(e), readAt: r.read_at } : { employeeId: r.employee_id, name: r.employee_id, branch: '', position: '', readAt: r.read_at };
    });
    // ยังไม่อ่าน: พนักงานที่ยังปฏิบัติงาน + ไม่อยู่ใน readMap
    const unread = this.data.employees
      .filter(e => this.empStatus(e) !== 'resigned' && !readMap.has(e.id))
      .map(fmt)
      .sort((a, b) => (a.branch || '').localeCompare(b.branch || '', 'th') || a.name.localeCompare(b.name, 'th'));
    return { readers, unread };
  },

  // upload รูปประกาศ → คืน public URL
  async uploadAnnouncementImage(file) {
    if (!this.isHR) throw new Error('เฉพาะ admin / HR เท่านั้น');
    if (!file) throw new Error('ไม่พบไฟล์');
    if (file.size > 5 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 5 MB');
    // [Security H1] สร้างชื่อไฟล์ UUID — ป้องกันการเดา URL
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const uuid = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const path = `${uuid}.${ext || 'jpg'}`;
    const { error: uploadError } = await this.client.storage
      .from('announcement-images')
      .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type || 'image/jpeg' });
    if (uploadError) throw uploadError;
    const { data } = this.client.storage.from('announcement-images').getPublicUrl(path);
    return data.publicUrl;
  },

  // ─── PROBATION DUE — พนักงานที่อายุงานครบ N วันในเดือนนี้ ───
  // 90 = ครบทดลองงาน, 119 = ก่อนครบ 120 วัน (deadline กฎหมายแรงงาน)
  getProbationDue(days) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const [ty, tm] = today.split('-').map(Number);
    const results = [];
    for (const e of this.data.employees) {
      if (this.empStatus(e) === 'resigned') continue;
      if (!e.hireDate) continue;
      const m = String(e.hireDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!m) continue;
      const hire = new Date(+m[1], +m[2] - 1, +m[3]);
      const reach = new Date(hire.getTime() + days * 86400000);
      if (reach.getFullYear() === ty && reach.getMonth() + 1 === tm) {
        const ry = reach.getFullYear();
        const rm = String(reach.getMonth() + 1).padStart(2, '0');
        const rd = String(reach.getDate()).padStart(2, '0');
        results.push({ ...e, reachDate: `${ry}-${rm}-${rd}` });
      }
    }
    results.sort((a, b) => a.reachDate.localeCompare(b.reachDate));
    return results;
  },

  // ─── DASHBOARD KPI (Safari-style) ───
  getDashboardKPI({ scope = '' } = {}) {
    return this._cachedStats(`kpi:${scope}:${this.role || ''}`, () => this._computeDashboardKPI({ scope }));
  },
  _computeDashboardKPI({ scope = '' } = {}) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const [ty, tm] = today.split('-').map(Number);
    const thisYM = `${ty}-${String(tm).padStart(2, '0')}`;
    const yearStart = `${ty}-01-01`;
    // ใช้ getEmployees() เพื่อ auto-scope ตาม RBAC (admin/hr เห็นทั้งหมด, manager เห็นเฉพาะสาขา)
    // + กรอง scope (สายงาน) เพิ่มเติม ถ้า dashboard ระบุมา
    const emps = this._filterByScope(this.getEmployees(), scope);
    const active = emps.filter(e => this.empStatus(e) !== 'resigned');
    // Turnover คิดเฉพาะ "พนักงานประจำ" (full-time) เท่านั้น — ไม่รวม part-time/contract/probation
    const isFullTime = (e) => e.employeeType === 'พนักงานประจำ';
    const ftActive = active.filter(isFullTime);
    const ftExitThisMonth = emps.filter(e => isFullTime(e) && e.terminationDate && String(e.terminationDate).startsWith(thisYM)).length;
    const ftExitYTD = emps.filter(e => isFullTime(e) && e.terminationDate && e.terminationDate >= yearStart && e.terminationDate <= today).length;
    // หัว KPI อื่นยังนับทั้งหมด
    const newThisMonth = emps.filter(e => e.hireDate && String(e.hireDate).startsWith(thisYM)).length;
    const exitThisMonth = emps.filter(e => e.terminationDate && String(e.terminationDate).startsWith(thisYM)).length;
    const exitYTD = emps.filter(e => e.terminationDate && e.terminationDate >= yearStart && e.terminationDate <= today).length;
    const hireYTD = emps.filter(e => e.hireDate && e.hireDate >= yearStart && e.hireDate <= today).length;
    const headcount = active.length;
    const ftHeadcount = ftActive.length;
    const turnoverMonth = ftHeadcount ? (ftExitThisMonth / ftHeadcount * 100) : 0;
    const turnoverYTD = ftHeadcount ? (ftExitYTD / ftHeadcount * 100) : 0;
    const turnoverAnnualized = tm ? (turnoverYTD * 12 / tm) : 0;
    // ─── พนักงานลางานวันนี้ — leave_requests ที่ approved + วันนี้อยู่ในช่วง ───
    // auto-scope ผ่าน leaveRequests ที่ admin/hr เห็นทุก row แต่ manager เห็นเฉพาะของในสาขา
    // เพื่อความเรียบง่าย — นับจาก data ทั้งหมด แต่ filter ตาม emp.branch ที่ user เห็น
    const visibleEmpIds = new Set(emps.map(e => e.id));
    const onLeaveToday = (this.data.leaveRequests || []).filter(r =>
      r.status === 'approved' &&
      r.startDate <= today && r.endDate >= today &&
      visibleEmpIds.has(r.employeeId)
    );

    // ─── อัตราผ่านทดลองงาน (120 วันแรก) — เฉพาะพนักงานประจำ ───
    // Cohort: พนักงานประจำที่จ้างใน 12 เดือนล่าสุด + เลย 120 วันแรกแล้ว
    //   (ไม่รวม part-time/contract/probation/intern/daily — รวมเฉพาะ ปจ.)
    //   (ไม่นับคนที่ยังไม่ครบ 120 วัน เพราะยังตัดสินไม่ได้)
    // Passed = ยังทำงานอยู่ หรือ ลาออก หลัง วันจ้าง + 120 วัน
    // Failed = ลาออก ภายใน 120 วันแรก
    const addDays = (dateStr, days) => {
      const m = String(dateStr).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3] + days);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const todayDay = Number(today.slice(8, 10)) || 1;
    const twelveMonthsAgo = (() => {
      const d = new Date(ty, tm - 13, todayDay);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    // Cohort: เฉพาะพนักงานประจำ + hireDate ใน 12 เดือนย้อนหลัง + (hireDate + 120) <= today
    const cohort = emps.filter(e => {
      if (!isFullTime(e)) return false;  // เฉพาะพนักงานประจำ
      if (!e.hireDate || e.hireDate < twelveMonthsAgo || e.hireDate > today) return false;
      const day120 = addDays(e.hireDate, 120);
      return day120 && day120 <= today;  // ผ่าน 120 วันแล้ว (รู้ผลแล้ว)
    });
    let probationPassed = 0;
    let probationFailed = 0;
    for (const e of cohort) {
      const day120 = addDays(e.hireDate, 120);
      if (!e.terminationDate || e.terminationDate > day120) {
        probationPassed++;
      } else {
        probationFailed++;
      }
    }
    const probationCohortSize = cohort.length;
    const probationPassRate = probationCohortSize > 0
      ? (probationPassed / probationCohortSize * 100)
      : null;
    // คนกำลังทดลอง (พนักงานประจำ + ยังไม่ครบ 120 วัน + ไม่พ้นสภาพ)
    const inProbation = emps.filter(e => {
      if (!isFullTime(e)) return false;
      if (!e.hireDate || this.empStatus(e) === 'resigned') return false;
      const day120 = addDays(e.hireDate, 120);
      return day120 && day120 > today && e.hireDate <= today;
    }).length;

    return {
      headcount, ftHeadcount, total: emps.length,
      newThisMonth, exitThisMonth, hireYTD, exitYTD,
      turnoverMonth, turnoverYTD, turnoverAnnualized,
      onLeaveToday: onLeaveToday.length,
      probationPassRate, probationPassed, probationFailed,
      probationCohortSize, inProbation,
      year: ty, monthsElapsed: tm
    };
  },

  // ─── BRANCH STATS (จำนวนพนักงานต่อสาขา — เฉพาะที่ยังปฏิบัติงาน) ───
  // ─── Helper: กรอง employees ตาม scope (สายงาน) ───
  // ใช้ใน dashboard filters: scope = 'operation'/'office'/'scm'/... | '' = no filter
  // chain: employee.position → positionLevels.scope → match กับ scope ที่กรอง
  _filterByScope(emps, scope) {
    if (!scope) return emps;
    return emps.filter(e => {
      const pos = e.position ? this.getPosition(e.position) : null;
      return pos?.scope === scope;
    });
  },

  getBranchStats({ scope = '' } = {}) {
    return this._cachedStats(`branchStats:${scope}`, () => this._computeBranchStats({ scope }));
  },
  _computeBranchStats({ scope = '' } = {}) {
    const counts = new Map();
    const list = this._filterByScope(this.data.employees, scope);
    for (const e of list) {
      if (this.empStatus(e) === 'resigned') continue;
      const b = (e.branch || 'ไม่ระบุ').trim() || 'ไม่ระบุ';
      counts.set(b, (counts.get(b) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([branch, count]) => ({ branch, count }))
      .sort((a, b) => b.count - a.count);
  },

  // ─── สถิติพนักงานตามสายงาน (scope) — ใช้ใน dashboard ───
  // หา scope ผ่าน position FK: employee.position → positionLevels.scope → positionScopes.id
  // คนที่ไม่มี position หรือ position ไม่มี scope → จัดเป็น "ไม่ระบุ"
  getScopeStats() {
    return this._cachedStats('scopeStats', () => this._computeScopeStats());
  },
  _computeScopeStats() {
    const counts = new Map();
    for (const e of this.data.employees) {
      if (this.empStatus(e) === 'resigned') continue;
      const pos = e.position ? this.getPosition(e.position) : null;
      const scopeId = pos?.scope || null;
      const key = scopeId || '__none__';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const result = [];
    for (const [id, count] of counts.entries()) {
      if (id === '__none__') {
        result.push({ id: null, label: 'ไม่ระบุสาย', badgeBg: 'rgba(148,163,184,0.15)', badgeColor: '#475569', count });
      } else {
        const sc = this.getScope(id);
        result.push({
          id,
          label: sc?.label || id,
          badgeBg: sc?.badgeBg || 'rgba(148,163,184,0.15)',
          badgeColor: sc?.badgeColor || '#475569',
          count
        });
      }
    }
    return result.sort((a, b) => b.count - a.count);
  },

  // ─── อัตราผ่านทดลองงาน (120 วัน) แยกตามสาขา — เฉพาะพนักงานประจำ (Full-time) ───
  // ใช้เกณฑ์เดียวกับ getDashboardKPI(): cohort = ปจ. ที่จ้างใน 12 เดือนล่าสุด + ครบ 120 วันแล้ว
  // Passed = ยังทำงานอยู่ หรือลาออกหลังวันจ้าง+120 / Failed = ลาออกภายใน 120 วันแรก
  // inProbation = ปจ. ที่ยังไม่ครบ 120 วัน + ยังทำงานอยู่ (เพื่อบอก context)
  getProbationPassByBranch() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const [ty, tm] = today.split('-').map(Number);
    const todayDay = Number(today.slice(8, 10)) || 1;
    const twelveMonthsAgo = (() => {
      const d = new Date(ty, tm - 13, todayDay);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const addDays = (dateStr, days) => {
      const m = String(dateStr).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3] + days);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const isFullTime = (e) => e.employeeType === 'พนักงานประจำ';
    const emps = this.getEmployees();
    const stats = new Map();
    const ensure = (branch) => {
      if (!stats.has(branch)) {
        stats.set(branch, { branch, cohort: 0, passed: 0, failed: 0, inProbation: 0 });
      }
      return stats.get(branch);
    };
    for (const e of emps) {
      if (!isFullTime(e)) continue;
      if (!e.hireDate || e.hireDate > today) continue;
      const branch = (e.branch || 'ไม่ระบุ').trim() || 'ไม่ระบุ';
      const day120 = addDays(e.hireDate, 120);
      if (!day120) continue;
      if (day120 > today) {
        if (this.empStatus(e) !== 'resigned') ensure(branch).inProbation++;
        continue;
      }
      if (e.hireDate < twelveMonthsAgo) continue;
      const rec = ensure(branch);
      rec.cohort++;
      if (!e.terminationDate || e.terminationDate > day120) rec.passed++;
      else rec.failed++;
    }
    const rows = [...stats.values()].map(r => ({
      ...r,
      rate: r.cohort > 0 ? (r.passed / r.cohort * 100) : null
    }));
    rows.sort((a, b) => {
      if (a.cohort === 0 && b.cohort === 0) return b.inProbation - a.inProbation || a.branch.localeCompare(b.branch, 'th');
      if (a.cohort === 0) return 1;
      if (b.cohort === 0) return -1;
      if (b.rate !== a.rate) return b.rate - a.rate;
      return b.cohort - a.cohort;
    });
    return rows;
  },

  // ─── YEARLY HIRE / EXIT (ปฏิทินทั้งปี ม.ค.-ธ.ค.) ───
  getYearlyHireExit(year = null, { scope = '' } = {}) {
    return this._cachedStats(`yearly:${year || 'auto'}:${scope}`, () => this._computeYearlyHireExit(year, { scope }));
  },
  _computeYearlyHireExit(year = null, { scope = '' } = {}) {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const y = year || parseInt(todayStr.slice(0, 4), 10);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      months.push({
        ym: `${y}-${String(m).padStart(2, '0')}`,
        year: y, month: m,
        hires: 0, exits: 0
      });
    }
    const idx = new Map(months.map(m => [m.ym, m]));
    for (const e of this._filterByScope(this.data.employees, scope)) {
      if (e.hireDate) {
        const ym = String(e.hireDate).slice(0, 7);
        const m = idx.get(ym);
        if (m) m.hires++;
      }
      if (e.terminationDate) {
        const ym = String(e.terminationDate).slice(0, 7);
        const m = idx.get(ym);
        if (m) m.exits++;
      }
    }
    return { year: y, months };
  },

  // ─── MONTHLY HIRE / EXIT (สำหรับ Dashboard chart) ───
  getMonthlyHireExit(monthsBack = 12, { scope = '' } = {}) {
    return this._cachedStats(`monthly:${monthsBack}:${scope}`, () => this._computeMonthlyHireExit(monthsBack, { scope }));
  },
  _computeMonthlyHireExit(monthsBack = 12, { scope = '' } = {}) {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const [ty, tm] = todayStr.split('-').map(Number);
    const months = [];
    for (let i = monthsBack - 1; i >= 0; i--) {
      const totalMonths = ty * 12 + (tm - 1) - i;
      const y = Math.floor(totalMonths / 12);
      const m = (totalMonths % 12) + 1;
      months.push({
        ym: `${y}-${String(m).padStart(2, '0')}`,
        year: y, month: m,
        hires: 0, exits: 0
      });
    }
    const idx = new Map(months.map(m => [m.ym, m]));
    for (const e of this._filterByScope(this.data.employees, scope)) {
      if (e.hireDate) {
        const ym = String(e.hireDate).slice(0, 7);
        const m = idx.get(ym);
        if (m) m.hires++;
      }
      if (e.terminationDate) {
        const ym = String(e.terminationDate).slice(0, 7);
        const m = idx.get(ym);
        if (m) m.exits++;
      }
    }
    return months;
  },

  // ─── AGE DISTRIBUTION ───
  // คำนวณช่วงอายุของพนักงานที่ยังปฏิบัติงาน
  // คืน [{ label, count }] สำหรับ chart — ครอบคลุม < 20, 20-29, 30-39, 40-49, 50-59, 60+, ไม่ระบุ
  getAgeDistribution({ scope = '' } = {}) {
    const buckets = [
      { label: 'ต่ำกว่า 20 ปี', min: 0,  max: 19,  count: 0 },
      { label: '20-29 ปี',       min: 20, max: 29,  count: 0 },
      { label: '30-39 ปี',       min: 30, max: 39,  count: 0 },
      { label: '40-49 ปี',       min: 40, max: 49,  count: 0 },
      { label: '50-59 ปี',       min: 50, max: 59,  count: 0 },
      { label: '60 ปีขึ้นไป',    min: 60, max: 200, count: 0 }
    ];
    const noBirth = { label: 'ไม่ระบุวันเกิด', count: 0 };
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const [ty, tm, td] = today.split('-').map(Number);

    for (const e of this._filterByScope(this.data.employees, scope)) {
      if (this.empStatus(e) === 'resigned') continue;
      const m = String(e.dob || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!m) { noBirth.count++; continue; }
      let age = ty - +m[1];
      if (tm < +m[2] || (tm === +m[2] && td < +m[3])) age--;
      if (age < 0 || age > 120) { noBirth.count++; continue; }
      const b = buckets.find(x => age >= x.min && age <= x.max);
      if (b) b.count++;
    }
    const result = buckets.filter(b => b.count > 0).map(b => ({ label: b.label, count: b.count }));
    if (noBirth.count > 0) result.push(noBirth);
    return result;
  },

  // ─── SALARY BY POSITION ───
  // คำนวณรายได้รวม (เงินเดือน + ค่าตำแหน่ง + เดินทาง + อาหาร + เบี้ยเลี้ยง + ภาษา + อื่นๆ)
  // avg/min/max ต่อตำแหน่งงาน — เฉพาะที่ยังปฏิบัติงาน
  // คืน [{ name, avg, min, max, count, level }] เรียง avg มาก → น้อย
  // ─── TURNOVER RATE per branch (rolling 12 months) — เฉพาะพนักงานประจำ ───
  // สูตร: (จำนวนพนักงานประจำที่ลาออกใน 12 เดือนล่าสุด / จำนวนพนักงานประจำเฉลี่ย) × 100
  // avgHeadcount ใช้สูตรประมาณ: active ปัจจุบัน + (exits / 2) — สะท้อนค่าเฉลี่ยช่วงเวลา
  // กรอง: employeeType === 'พนักงานประจำ' เท่านั้น (ไม่รวม part-time, สัญญา, ทดลองงาน, ฝึกงาน)
  getTurnoverByBranch() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    // คำนวณวันที่ 12 เดือนย้อนหลัง
    const ymd = String(today).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!ymd) return [];
    const startDate = new Date(Number(ymd[1]) - 1, Number(ymd[2]) - 1, Number(ymd[3]));
    const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
    const map = new Map(); // branch → { active, exits }
    for (const e of this.data.employees) {
      if (!e.branch) continue;
      // กรองเฉพาะพนักงานประจำ
      if (e.employeeType !== 'พนักงานประจำ') continue;
      if (!map.has(e.branch)) map.set(e.branch, { active: 0, exits: 0 });
      const stat = map.get(e.branch);
      const status = this.empStatus(e);
      if (status !== 'resigned') stat.active++;
      // นับ exits ในช่วง 12 เดือน
      if (e.terminationDate && e.terminationDate >= startStr && e.terminationDate <= today) {
        stat.exits++;
      }
    }
    const result = [];
    for (const [branch, stat] of map) {
      // ข้ามสาขาที่ไม่มีพนักงานปัจจุบัน — turnover จะแกว่งสูงไม่มีความหมาย
      if (stat.active === 0) continue;
      const avgHeadcount = stat.active + stat.exits / 2;
      const turnover = avgHeadcount > 0 ? (stat.exits / avgHeadcount) * 100 : 0;
      result.push({
        branch,
        active: stat.active,
        exits: stat.exits,
        avgHeadcount: Math.round(avgHeadcount * 10) / 10,
        turnover: Math.round(turnover * 10) / 10
      });
    }
    // เรียง turnover สูงสุด → ต่ำสุด
    return result.sort((a, b) => b.turnover - a.turnover);
  },

  getSalaryByPosition() {
    const totalIncome = (e) =>
      Number(e.salary || 0) +
      Number(e.allowancePosition || 0) +
      Number(e.allowanceTravel || 0) +
      Number(e.allowanceFood || 0) +
      Number(e.allowancePerDiem || 0) +
      Number(e.allowanceLanguage || 0) +
      Number(e.allowanceOther || 0);
    const map = new Map();
    for (const e of this.data.employees) {
      if (this.empStatus(e) === 'resigned') continue;
      if (!e.position) continue;
      const income = totalIncome(e);
      if (income <= 0) continue; // ข้าม row ที่ไม่มีรายได้เลย
      if (!map.has(e.position)) map.set(e.position, { sum: 0, count: 0, min: Infinity, max: -Infinity });
      const stat = map.get(e.position);
      stat.sum += income;
      stat.count++;
      if (income < stat.min) stat.min = income;
      if (income > stat.max) stat.max = income;
    }
    const result = [];
    for (const [posId, stat] of map) {
      const pos = this.getPosition(posId);
      if (!pos) continue;
      result.push({
        name: pos.name,
        avg: Math.round(stat.sum / stat.count),
        min: stat.min,
        max: stat.max,
        count: stat.count,
        level: pos.level || 0
      });
    }
    return result.sort((a, b) => b.avg - a.avg);
  },

  // ─── STATS ───
  getStats({ scope = '' } = {}) {
    return this._cachedStats(`stats:${scope}:${this.role || ''}`, () => this._computeStats({ scope }));
  },
  _computeStats({ scope = '' } = {}) {
    // ใช้ getEmployees() เพื่อ auto-scope ตาม RBAC + กรอง scope ที่ dashboard เลือก
    const emps = this._filterByScope(this.getEmployees(), scope);
    // ใช้ effective status (ตามวันพ้นสภาพ — ไม่ใช่ field 'status' ที่อาจ stale)
    const active = emps.filter(e => this.empStatus(e) !== 'resigned');
    const totalSalary = active.reduce((s, e) => s + (e.salary || 0), 0);
    const activeLoans = this.data.loans.filter(l => l.status !== 'completed').length;
    const pendingAdvances = this.data.advances.filter(a => a.status !== 'paid').length;
    // byPosition: เรียงจำนวนมาก → น้อย (โชว์ตำแหน่งที่มีคนเยอะก่อน), ตัดที่ count = 0 ออก
    const byPosition = this.data.positionLevels
      .map(p => ({ name: p.name, count: active.filter(e => e.position === p.id).length, level: p.level || 0 }))
      .filter(p => p.count > 0)
      .sort((a, b) => b.count - a.count || (b.level - a.level));
    return {
      totalEmployees: emps.length,
      activeEmployees: active.length,
      departments: this.data.departments.length,
      totalMonthlySalary: totalSalary,
      activeLoans,
      pendingAdvances,
      byDepartment: this.data.departments.map(d => ({
        name: d.name,
        count: active.filter(e => e.department === d.id).length
      })),
      byPosition,
      byAge: this.getAgeDistribution({ scope }),
      salaryByPosition: this.getSalaryByPosition(),
      turnoverByBranch: this.getTurnoverByBranch(),
      byGender: {
        male: active.filter(e => e.gender === 'ชาย').length,
        female: active.filter(e => e.gender === 'หญิง').length
      }
    };
  }
};
