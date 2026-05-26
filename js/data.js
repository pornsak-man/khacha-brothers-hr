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
    announcements: [],
    // ─── ตารางงานพนักงาน (Work Schedule) ───
    shifts: [],            // กะตั้งต้น HR CRUD
    scheduleWeeks: [],     // 1 สาขา × 1 สัปดาห์ = 1 แถว
    scheduleEntries: [],   // เซลล์ใน grid: พนักงาน × วัน × กะ
    borrowRequests: []     // ขอยืมพนักงานข้ามสาขา (Phase 3 Level 3)
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
  // ─── [PERF] Pre-warm captcha cache ───
  // hCaptcha invisible execute() ใช้เวลา ~2-2.5 วินาที — ก่อนหน้านี้เกิดบน critical path
  // ของ signIn() ทำให้กดเข้าระบบช้า แก้โดยเริ่ม execute ตอน user focus input
  // ครั้งแรก → token พร้อมเมื่อ user กด "เข้าสู่ระบบ" → ไม่ต้องรออีก
  // Token TTL ของ hCaptcha = ~2 นาที, cache ที่นี่ตั้ง expiry 90s กันใช้หมดอายุ
  _captchaPrewarm: null,
  prewarmCaptcha() {
    if (!window.KB_CONFIG?.HCAPTCHA_SITE_KEY) return;
    // ถ้ามี promise อยู่แล้วและ token ยังไม่หมดอายุ → ไม่ทำซ้ำ
    if (this._captchaPrewarm) {
      if (!this._captchaPrewarm.expiresAt || Date.now() < this._captchaPrewarm.expiresAt) return;
    }
    const entry = { promise: null, token: null, expiresAt: 0 };
    entry.promise = this._getCaptchaToken('signIn').then(
      (token) => { entry.token = token; entry.expiresAt = Date.now() + 90_000; return token; },
      (err) => { this._captchaPrewarm = null; throw err; }
    );
    this._captchaPrewarm = entry;
  },
  async _getCachedCaptchaToken() {
    if (!window.KB_CONFIG?.HCAPTCHA_SITE_KEY) return undefined;
    const c = this._captchaPrewarm;
    if (c && c.promise) {
      try {
        const token = await c.promise;
        if (c.expiresAt && Date.now() < c.expiresAt) {
          this._captchaPrewarm = null;  // consume cache
          return token;
        }
      } catch (e) { /* fall through to fresh execute */ }
    }
    return this._getCaptchaToken('signIn');
  },
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
    // ─── PERF: timestamp ก่อน captcha → ก่อน auth → ก่อน data ───
    const _tSignIn0 = performance.now();
    // ใช้ cached token จาก prewarm (ตอน user focus input ก่อนหน้า) ถ้ามี
    // — ตัดเวลา captcha 2-2.5s ออกจาก critical path (เพราะ run ขนานกับ user typing)
    const captchaToken = await this._getCachedCaptchaToken();
    const _tAfterCaptcha = performance.now();
    const { data, error } = await this.client.auth.signInWithPassword({
      email, password,
      options: captchaToken ? { captchaToken } : undefined
    });
    if (error) throw error;
    const _tAfterAuth = performance.now();
    this.user = data.user;
    // เก็บไว้ให้ loadAll log รวมในตาราง phases
    window.__signInTimings = {
      captcha: Math.round(_tAfterCaptcha - _tSignIn0),
      auth_api: Math.round(_tAfterAuth - _tAfterCaptcha)
    };
    // PERF: parallel เหมือนใน init() — โหลด data ทันทีไม่รอ profile เสร็จ
    const profilePromise = this.loadProfile();
    await Promise.all([profilePromise, this.loadAll(profilePromise)]);
    this.subscribeRealtime();
    this.ready = true;
    return data.user;
  },

  async signOut() {
    // [Security H6+] ปิด impersonate audit ก่อน signOut — กัน audit gap
    // (ถ้า HR ปิด browser ขณะ "ดูเสมือนพนักงาน" → log_impersonate_toggle(false) ไม่ถูกเรียก
    //  → audit ขาด OFF event)
    if (this._asEmployee) {
      try {
        await this.client.rpc('log_impersonate_toggle', { p_enabled: false });
      } catch (e) { /* non-blocking — ปล่อยให้ signOut ดำเนินการต่อ */ }
    }
    await this.client.auth.signOut();
    this.user = null;
    this.profile = null;
    this.isAdmin = false;
    this._asEmployee = false;
    this._permCache = null;            // Phase 2: เคลียร์ permission cache กัน leak ข้าม user
    this._permLoadPromise = null;
    this._notifications = [];          // Phase A: clear in-memory (localStorage คง key ไว้ ถ้า user เดิม login ใหม่จะโหลดกลับ)
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
    // Phase 2: โหลด permission matrix แบบ parallel — fail silently → fallback ไป _legacyPermission
    this._loadPermissions();
    // Phase A: โหลด notifications ของ user นี้จาก localStorage
    this.loadNotifications();
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
    // [Security H6] เขียน server-side audit log (fire-and-forget — ไม่ block UI)
    // ถ้า RPC ยังไม่ deploy → fail silently (console.warn) เพื่อไม่ break UX
    this.client.rpc('log_impersonate_toggle', { p_enabled: enabled })
      .then(({ error }) => { if (error) console.warn('[impersonate-audit]', error.message); })
      .catch(ex => console.warn('[impersonate-audit]', ex?.message || ex));
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

  // ─── DYNAMIC PERMISSION SYSTEM (Phase 2) ───
  // hasPermission(key) — ใช้ matrix จาก DB ถ้าโหลดแล้ว, fallback ไปกฎเดิม
  // ⚠️ Phase 2 = "เพิ่ม API ใหม่" ห้ามแตะ call site เดิม — โค้ดเดิมยังใช้ isHR/isAdmin ปกติ
  // หลัง Phase 3 ค่อย refactor แต่ละหน้าให้เรียก hasPermission() แทน
  _permCache: null,             // Set<string> ของ permission keys ที่ user มี (null = ยังไม่ load)
  _permLoadPromise: null,
  _permLoadFailed: false,       // [M5] true = RPC fail (matrix migration ยังไม่รัน หรือ network)
  _permLoadErrorMsg: '',

  async _loadPermissions() {
    if (!this.user) return;
    // กัน race condition: ถ้ามี request วิ่งอยู่ ใช้ตัวเดิม
    if (this._permLoadPromise) return this._permLoadPromise;
    this._permLoadPromise = (async () => {
      try {
        const { data, error } = await this.client.rpc('user_permissions_list');
        if (error) throw error;
        this._permCache = new Set((data || []).map(r => r.permission_key));
        this._permLoadFailed = false;
        this._permLoadErrorMsg = '';
      } catch (ex) {
        // [M5] ก่อนหน้านี้ silent fallback → ตอนนี้ track failure เพื่อให้ UI เตือน
        // และ hasPermission() ยังคง fallback ไป _legacyPermission ได้
        // (ไม่ fail-closed เด็ดขาดเพราะ legacy rules ก็ถูกต้องโดย default)
        // แต่ถ้า RPC fail ระบบจะ:
        //   1. แสดง banner เตือนใน UI (ผ่าน _permLoadFailed flag)
        //   2. ใช้ legacy rules (ปลอดภัย — กฎ default เดิมที่ matrix override)
        this._permCache = null;
        this._permLoadFailed = true;
        this._permLoadErrorMsg = ex?.message || String(ex);
        console.warn('[perm] load failed — legacy fallback active. UI should warn admin.', this._permLoadErrorMsg);
      } finally {
        this._permLoadPromise = null;
      }
    })();
    return this._permLoadPromise;
  },

  // [M5] ให้ UI เช็ค flag → แสดง banner เตือนว่า matrix ยังไม่ load (admin จะรู้)
  isPermissionLoadFailed() {
    return !!this._permLoadFailed;
  },
  getPermissionLoadError() {
    return this._permLoadErrorMsg;
  },

  hasPermission(key) {
    if (!key) return false;
    // 1. ถ้า matrix โหลดแล้ว → ใช้ matrix (source of truth)
    if (this._permCache instanceof Set) {
      return this._permCache.has(key);
    }
    // [Security M-A1] 2. Fallback fail-closed:
    //   - critical safety locks เท่านั้นที่ผ่าน legacy (ป้องกัน lockout ของ self-service)
    //   - permission อื่น → return false จน matrix โหลดเสร็จ
    //   ป้องกัน: ถ้า RPC user_permissions_list ล้ม → ไม่ให้ broad HR/admin access
    //            ที่เคย hardcoded ใน _legacyPermission (ก่อน admin revoke key ในตอน Phase 1)
    const SAFETY_LOCKS = new Set([
      'leave.request_own',
      'leave.cancel_own',
      'holiday_swap.request_own',
      'leave_calendar.view'
    ]);
    if (SAFETY_LOCKS.has(key)) return this._legacyPermission(key);
    return false;
  },

  // ────────────────────────────────────────────────────────────
  // _legacyPermission — map 62 permission keys → isHR/isAdmin/role
  // ใช้เป็น safety net ก่อน Phase 1 migration รัน หรือถ้า RPC fail
  // ค่าตรงกับ default seed ใน supabase-migration-permissions-v1.sql
  // ────────────────────────────────────────────────────────────
  _legacyPermission(key) {
    const isAdmin = this.isAdmin;
    const isHR = this.isHR;                       // admin + hr
    const role = this.role || 'viewer';
    const isMgr = ['operation_manager', 'area_manager', 'branch_manager'].includes(role);
    const hasAnyRole = !!role;

    // safety locks — ทุก role ใช้ได้ (ตรงกับ is_critical=true ใน seed)
    if (key === 'leave.request_own')          return hasAnyRole;
    if (key === 'holiday_swap.request_own')   return hasAnyRole;
    if (key === 'user.view_accounts')         return isHR;       // critical แต่ default = HR+admin

    // admin-only (is_dangerous + admin protect)
    if (key === 'user.set_role_admin')        return isAdmin;
    if (key === 'system.edit_company')        return isAdmin;
    if (key === 'system.view_audit')          return isAdmin;
    if (key === 'system.full_backup')         return isAdmin;
    if (key === 'permission.edit_matrix')     return isAdmin;
    if (key === 'leave.manage_types')         return isAdmin;

    // HR+admin (สิทธิ์ admin/HR ทำได้เหมือนกัน)
    const hrKeys = new Set([
      'employee.view_pii', 'employee.view_salary',
      'employee.create', 'employee.edit', 'employee.delete', 'employee.terminate',
      'employee.bulk_import', 'employee.export_xlsx',
      'applicant.view', 'applicant.manage', 'blacklist.manage',
      'payroll.view_menu',
      'salary.adjust', 'salary.import', 'salary.view_history',
      'loan.view', 'loan.manage', 'advance.view', 'advance.manage',
      'allowance.view', 'allowance.manage', 'evaluation.view', 'evaluation.manage',
      'report.export_payroll',
      'leave.approve_all', 'leave.delete', 'leave.bypass_backdate',
      'holiday.manage', 'holiday_swap.auto_approve',
      'branch.manage', 'department.manage', 'position.manage',
      'user.create_account', 'user.bulk_create', 'user.reset_password', 'user.set_role',
      'announcement.manage',
      'employee.view_all_branches'
    ]);
    if (hrKeys.has(key)) return isHR;

    // view-only menus — เห็นได้ทุก manager + HR
    const viewKeys = new Set([
      'employee.view_list', 'branch.view', 'department.view', 'position.view'
    ]);
    if (viewKeys.has(key)) return isHR || isMgr;

    // leave.request_for_others / approve_own_branch / holiday_swap.request_for_others
    if (key === 'leave.request_for_others')        return isHR || isMgr;
    if (key === 'leave.approve_own_branch')        return isHR || isMgr;
    if (key === 'holiday_swap.request_for_others') return isHR || isMgr;

    // scope modifier
    if (key === 'employee.view_own_branch')        return isMgr;  // ผู้จัดการเห็นสาขาตัวเอง

    // default: deny
    return false;
  },

  // ────────────────────────────────────────────────────────────
  // Phase 4 — Permission Matrix data layer (admin UI)
  // ทุก method คืน null/[] ถ้า migration ยังไม่รัน (table not exist)
  // → caller render empty state แทนที่จะ throw
  // ────────────────────────────────────────────────────────────
  async getPermRoles() {
    try {
      const { data, error } = await this.client.from('roles').select('*').order('sort_order');
      if (error) throw error;
      return data || [];
    } catch (ex) {
      console.warn('[perm] getPermRoles failed:', ex?.message || ex);
      return null;  // signal: migration not run
    }
  },
  async getPermCatalog() {
    try {
      const { data, error } = await this.client.from('permissions').select('*').order('sort_order');
      if (error) throw error;
      return data || [];
    } catch (ex) {
      console.warn('[perm] getPermCatalog failed:', ex?.message || ex);
      return null;
    }
  },
  async getRolePermissions() {
    try {
      const { data, error } = await this.client.from('role_permissions').select('role_id, permission_key, granted');
      if (error) throw error;
      // คืนเป็น Map<roleId, Set<permKey>> เพื่อ lookup เร็ว
      const map = new Map();
      for (const row of data || []) {
        if (!row.granted) continue;
        if (!map.has(row.role_id)) map.set(row.role_id, new Set());
        map.get(row.role_id).add(row.permission_key);
      }
      return map;
    } catch (ex) {
      console.warn('[perm] getRolePermissions failed:', ex?.message || ex);
      return null;
    }
  },
  // ─── IN-APP NOTIFICATIONS (Phase A) ───
  // เก็บแจ้งเตือนของ user ปัจจุบันใน memory + persist ใน localStorage
  // trigger จาก realtime events (leave/swap status change ของตัวเอง) ใน app.js
  _notifications: [],
  _NOTIF_MAX: 50,
  _notifStorageKey() {
    return this.user ? `kb_notifs_${this.user.id}` : null;
  },
  loadNotifications() {
    const key = this._notifStorageKey();
    if (!key) { this._notifications = []; return; }
    try {
      const raw = localStorage.getItem(key);
      this._notifications = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(this._notifications)) this._notifications = [];
    } catch (e) { this._notifications = []; }
  },
  _persistNotifications() {
    const key = this._notifStorageKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(this._notifications.slice(0, this._NOTIF_MAX))); }
    catch (e) { /* quota exceeded ignored */ }
  },
  pushNotification(n) {
    if (!n || !n.id) return;
    // กัน duplicate (เช่น realtime ยิงซ้ำ)
    if (this._notifications.some(x => x.id === n.id)) return;
    const entry = {
      id: n.id,
      type: n.type || 'info',          // 'success' | 'danger' | 'warning' | 'info'
      title: n.title || '',
      body: n.body || '',
      link: n.link || null,             // router page name to open on click
      ts: n.ts || Date.now(),
      read: false
    };
    this._notifications.unshift(entry);
    if (this._notifications.length > this._NOTIF_MAX) this._notifications.length = this._NOTIF_MAX;
    this._persistNotifications();
    return entry;
  },
  markNotificationRead(id) {
    const n = this._notifications.find(x => x.id === id);
    if (!n || n.read) return false;
    n.read = true;
    this._persistNotifications();
    return true;
  },
  markAllNotificationsRead() {
    let changed = false;
    for (const n of this._notifications) {
      if (!n.read) { n.read = true; changed = true; }
    }
    if (changed) this._persistNotifications();
    return changed;
  },
  clearAllNotifications() {
    this._notifications = [];
    this._persistNotifications();
  },
  getNotifications() { return this._notifications.slice(); },
  getUnreadNotifCount() { return this._notifications.filter(n => !n.read).length; },

  async setRolePermissions(roleId, permKeys) {
    if (!roleId || !Array.isArray(permKeys)) throw new Error('roleId + permKeys[] required');
    const { data, error } = await this.client.rpc('set_role_permissions', {
      p_role_id: roleId,
      p_perm_keys: permKeys
    });
    if (error) throw error;
    // refresh cache ของ current user ทันที (กรณีแก้ role ตัวเอง)
    this._permCache = null;
    await this._loadPermissions();
    return data;
  },

  // ─── Role CRUD (Phase 4b) ───
  async createRole({ id, label_th, badge_class = '', description = '', clone_from = null } = {}) {
    if (!id || !label_th) throw new Error('id + label_th required');
    const { data, error } = await this.client.rpc('create_role', {
      p_id: id, p_label_th: label_th, p_badge_class: badge_class,
      p_description: description, p_clone_from: clone_from || null
    });
    if (error) throw error;
    return data;
  },
  async updateRole({ id, label_th, badge_class = '', description = '' } = {}) {
    if (!id || !label_th) throw new Error('id + label_th required');
    const { data, error } = await this.client.rpc('update_role', {
      p_id: id, p_label_th: label_th, p_badge_class: badge_class, p_description: description
    });
    if (error) throw error;
    return data;
  },
  async deleteRole(id, migrateToRole = null) {
    if (!id) throw new Error('id required');
    const { data, error } = await this.client.rpc('delete_role', {
      p_id: id, p_migrate_to_role: migrateToRole || null
    });
    if (error) throw error;
    return data;
  },
  // นับจำนวน user ที่ใช้ role แต่ละตัว — ใช้ตอนถามว่าจะลบ role ที่มี user หรือไม่
  async getRoleUserCounts() {
    try {
      const { data, error } = await this.client.from('user_profiles').select('role');
      if (error) throw error;
      const counts = {};
      for (const r of data || []) counts[r.role || 'viewer'] = (counts[r.role || 'viewer'] || 0) + 1;
      return counts;
    } catch (ex) {
      console.warn('[perm] getRoleUserCounts failed:', ex?.message || ex);
      return {};
    }
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
    // [PERF] Phase 1 ดึง minimal + financial cols (~28 cols)
    //        - Always need: id, name, branch, position, dates, status (dashboard/list/schedule)
    //        - Need for list table column "เงินเดือน": salary, allowance_*, bank, bank_account
    //          (DB mask อยู่แล้ว — non-HR เห็น NULL; HR เห็นค่าจริง)
    //        - Lazy (ดึงตอนเปิด form/detail): nationalId, passportNumber, work_permit, sso_*,
    //          email, phone, address, sub_district, district, province, postal_code,
    //          religion, nationality, education, termination_reason, termination_note
    //          → ผ่าน DB.ensureFullEmployee(id) ใน app.js
    const SLIM_COLS = [
      // identity / display
      'id', 'first_name', 'last_name', 'title', 'nickname',
      'branch', 'department', 'position', 'position_title',
      // dates + status
      'hire_date', 'dob', 'termination_date', 'status',
      'gender', 'employee_type', 'photo_url', 'note',
      // financial (for list table "เงินเดือน" column + salary summary report)
      // DB CASE WHEN is_hr_or_admin() → non-HR ได้ NULL อยู่แล้ว → ปลอดภัย
      'salary',
      'allowance_position', 'allowance_travel', 'allowance_food',
      'allowance_per_diem', 'allowance_language', 'allowance_phone', 'allowance_other',
      'bank', 'bank_account',
      // sso dates — ใช้ filter ในหน้า "ประกันสังคม" (รอแจ้งเข้า / รอแจ้งออก)
      // ถ้าไม่มี → filter ทำงานผิด → list ผิด
      'sso_enrolled_date', 'sso_terminated_date'
    ].join(', ');
    const fetchEmployeesActive = async () => {
      const PAGE = 1000;
      const all = [];
      let from = 0;
      while (true) {
        // [Security M1] อ่านผ่าน employees_view ที่ mask sensitive cols (salary, ปชช, bank, ฯลฯ)
        // สำหรับ non-HR → DB คืน NULL, HR คืนค่าจริง (CASE ใน view)
        const { data, error } = await this.client.from('employees_view')
          .select(SLIM_COLS).order('id', { ascending: true })
          .or(`termination_date.is.null,termination_date.gte.${oneYearAgo}`)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        // mark slim เพื่อให้ ensureFullEmployee รู้ว่าต้อง fetch full ตอนเปิด form/detail
        for (const r of data) r._isSlim = true;
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

    // [PERF] enrich employee ของ user ที่ login ก่อน render dashboard
    // — Personal Dashboard เรียก ssoNo, nationalId, phone ฯลฯ ของตัวเอง (sync rendering)
    // — ราคา: เพิ่ม ~100ms ที่ Boot Phase 1 แต่ปลอดภัย (ไม่ flash ค่าผิด)
    // — เฉพาะ user ตัวเอง — 1 row × full cols, ไม่หนัก
    const myEmpId = this.profile?.employee_id;
    if (myEmpId) {
      try {
        await this.ensureFullEmployee(myEmpId);
      } catch (e) { /* non-blocking — dashboard fallback เป็น slim */ }
    }

    // [Org Chart] ดึง basic info ของพนักงานทุกคน (RPC SECURITY DEFINER)
    // ใช้สำหรับแสดงชื่อ BM/AM/HR/ผู้สร้างประกาศ/ฯลฯ
    // — staff/viewer มี RLS scope แค่ตัวเอง → ต้องใช้ org chart fallback
    // — HR/admin อ่าน employees ครบอยู่แล้ว — org chart ช่วย enrich เพิ่ม (no-op สำหรับ row ที่มี)
    try {
      const { data: orgRows } = await this.client.rpc('get_org_chart_employees');
      this._orgChartCache = new Map();
      for (const r of (orgRows || [])) {
        this._orgChartCache.set(r.id, {
          id: r.id,
          firstName: r.first_name || '',
          lastName: r.last_name || '',
          nickname: r.nickname || '',
          title: r.title || '',
          branch: r.branch || '',
          department: r.department || '',
          position: r.position_id || '',   // RPC ใช้ position_id (เพราะ "position" reserved)
          positionTitle: r.position_title || '',
          status: r.status || 'active',
          photoUrl: r.photo_url || '',
          hireDate: r.hire_date || '',
          terminationDate: r.termination_date || '',
          employeeType: r.employee_type || '',
          gender: r.gender || '',
          _isOrgOnly: true   // marker — ไม่มี salary, ปชช, phone, ฯลฯ
        });
      }
    } catch (e) {
      console.warn('[org-chart] RPC get_org_chart_employees failed:', e);
      this._orgChartCache = new Map();
    }

    // ─── PERF: log boot timings ทันทีหลัง Phase 1 เสร็จ (dashboard render ต่อ) ───
    // เปิด DevTools Console เห็นว่า query ไหนช้า / ส่ง screenshot/log มาบอกได้
    try {
      const t = window.__bootTimings;
      const s = window.__signInTimings;  // มีเฉพาะตอน signIn (login click), ไม่มีตอน boot ผ่าน session restore
      const slowest = Object.entries(t.queries).sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0))[0];
      console.log('%c⏱ Boot Phase 1 done in ' + t.phases.phase1_total + ' ms', 'color:#2e74ff;font-weight:bold');
      if (s) {
        const total = (s.captcha || 0) + (s.auth_api || 0) + t.phases.phase1_total;
        console.log(`%c   ↳ captcha: ${s.captcha} ms · auth API: ${s.auth_api} ms · data: ${t.phases.phase1_total} ms · subtotal: ${total} ms (ก่อน render)`, 'color:#56544c');
      }
      console.table(t.queries);
      if (slowest) console.log(`%c   slowest query: ${slowest[0]} (${slowest[1]} ms)`, 'color:#dc2626');
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
        // [PERF] slim columns เช่นกัน — archive view แสดงแค่ name + termination
        const { data, error } = await this.client.from('employees_view')
          .select(SLIM_COLS).order('id', { ascending: true })
          .not('termination_date', 'is', null)
          .lt('termination_date', oneYearAgo)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const r of data) r._isSlim = true;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return all;
    };

    const _p2T0 = performance.now();
    this._secondaryLoadPromise = Promise.all([
      // ─── จาก Phase 1 (เดิม block login) ย้ายมา Phase 2 — ไม่จำเป็นต่อ dashboard ───
      // หมายเหตุ: Supabase query builder เป็น "thenable" ไม่ใช่ Promise จริง — ใช้ .then(ok, err) แทน .catch
      timed('calendar_items',          this.client.from('calendar_items').select('*').order('date').then(r => r, () => ({ data: [] }))),
      timed('company_settings',        this.client.from('company_settings').select('*').eq('id', 1).maybeSingle().then(r => r, () => ({ data: null }))),
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
      // ─── Work Schedule (ตารางงาน) ───
      timed('shifts',                  this._fetchAllPages('shifts', 'sort_order', true).catch(() => [])),
      timed('schedule_weeks',          this._fetchAllPages('schedule_weeks', 'week_start', false).catch(() => [])),
      timed('schedule_entries',        this._fetchAllPages('schedule_entries', 'work_date', true).catch(() => [])),
      timed('borrow_requests',         this._fetchAllPages('cross_branch_borrow_requests', 'created_at', false).catch(() => [])),
      timed('employees_archive',       fetchEmployeesArchive().catch(() => []))
    ]).then(([cal, comp, leaves, lvTypes, swapReqs,
              loans, advs, allow, evals, sal, appls,
              uniItems, uniReqs, uniIssues, uniSched,
              shifts, schedWeeks, schedEntries, borrowReqs,
              oldEmps]) => {
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
      this.data.shifts = (shifts || []).map(this._shiftFromDB);
      this.data.scheduleWeeks = (schedWeeks || []).map(this._schedWeekFromDB);
      this.data.scheduleEntries = (schedEntries || []).map(this._schedEntryFromDB);
      this.data.borrowRequests = (borrowReqs || []).map(this._borrowFromDB);
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
      // Refresh sidebar badges ที่อาศัย table ของ Phase 2 (leave / swap / schedule)
      try {
        if (typeof updateLeaveBadge === 'function') updateLeaveBadge();
        if (typeof updateCalendarBadge === 'function') updateCalendarBadge();
        if (typeof updateScheduleBadge === 'function') updateScheduleBadge();
      } catch (e) { /* badges may not exist yet */ }
      // Re-render หน้าปัจจุบันถ้าผู้ใช้อยู่บนหน้าที่ใช้ secondary data
      // เพิ่ม: dashboard (personal), leave, calendar — ใช้ table ที่เพิ่ง defer
      if (typeof router !== 'undefined' && router.current) {
        const usesSecondary = ['loans', 'advances', 'allowance', 'evaluations', 'recruit', 'uniform', 'salary-adjust', 'employees',
                               'dashboard', 'leave', 'calendar', 'schedule'];
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
    // [F1] user_profiles — ถ้า role ของฉันถูกแก้ → refresh session ทันที
    // ป้องกัน user ต้อง logout/login เมื่อ admin เปลี่ยน role ของเขา
    if (table === 'user_profiles') {
      const ref = newRow || oldRow;
      if (ref?.user_id === this.user?.id) {
        if (eventType === 'UPDATE' && newRow) {
          this.profile = newRow;
          this.role = newRow.role || 'viewer';
          this.isAdmin = this.role === 'admin';
          this.isHR = this.role === 'admin' || this.role === 'hr';
          this._managedBranches = Array.isArray(newRow.managed_branches)
            ? newRow.managed_branches.filter(Boolean) : [];
          this._permCache = null;            // invalidate — load ใหม่ใน hasPermission()
          this._permLoadPromise = null;
          this._loadPermissions();           // pre-warm cache
          // broadcast ให้ UI re-evaluate role-dependent elements
          if (window.onProfileChange) {
            try { window.onProfileChange(this.profile); } catch (e) {}
          }
        } else if (eventType === 'DELETE') {
          // profile ของฉันถูกลบ — force logout
          this.signOut();
          if (window.location) window.location.reload();
        }
      }
      // refresh cache list ของ user_profiles (สำหรับหน้า "ผู้ใช้และสิทธิ์")
      if (this._userProfiles) this._userProfiles = null;   // lazy reload ครั้งถัดไป
      return;
    }
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
      company_announcements: { list: 'announcements', from: this._annFromDB },
      shifts: { list: 'shifts', from: this._shiftFromDB },
      schedule_weeks: { list: 'scheduleWeeks', from: this._schedWeekFromDB },
      schedule_entries: { list: 'scheduleEntries', from: this._schedEntryFromDB },
      cross_branch_borrow_requests: { list: 'borrowRequests', from: this._borrowFromDB }
    };
    const m = map[table];
    if (!m) return;
    const list = this.data[m.list];
    if (eventType === 'INSERT' && newRow) {
      if (!list.find(x => x.id === newRow.id)) list.unshift(m.from(newRow));
    } else if (eventType === 'UPDATE' && newRow) {
      const idx = list.findIndex(x => x.id === newRow.id);
      if (idx >= 0) {
        // เก็บค่าเดิม (mapped format) ใน payload เพื่อให้ event handler เปรียบเทียบได้
        payload._cachedOld = list[idx];
        list[idx] = m.from(newRow);
      } else list.unshift(m.from(newRow));
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
      allowancePhone:    hr ? Number(r.allowance_phone    || 0) : 0,
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
      status: r.status || 'active', note: r.note || '',
      // [PERF] slim flag — boot Phase 1 ดึงเฉพาะ minimal cols
      // → form/detail call DB.ensureFullEmployee(id) เพื่อ fetch full field ที่ขาด
      _isSlim: r._isSlim === true
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
    allowance_phone: Number(e.allowancePhone || 0),
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
    oldAllowancePhone:    r.old_allowance_phone    != null ? Number(r.old_allowance_phone)    : null,
    newAllowancePhone:    r.new_allowance_phone    != null ? Number(r.new_allowance_phone)    : null,
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
    old_allowance_phone:    s.oldAllowancePhone    != null ? Number(s.oldAllowancePhone)    : null,
    new_allowance_phone:    s.newAllowancePhone    != null ? Number(s.newAllowancePhone)    : null,
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
    // ─── Approval chain (3-step) ───
    bmStatus: r.bm_status || 'pending',
    bmBy: r.bm_by,
    bmAt: r.bm_at,
    bmNote: r.bm_note || '',
    amStatus: r.am_status || 'pending',
    amBy: r.am_by,
    amAt: r.am_at,
    amNote: r.am_note || '',
    finalApproverRole: r.final_approver_role || null,
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
  // [Feature] เช็คว่าคำขอ swap หมดสิทธิ์หรือยัง — pending + ผ่าน deadline
  // กฎ: วันหยุดเดือน ธ.ค. → ชดเชยถึง 31 มี.ค. ปีถัดไป
  //     เดือนอื่น           → ชดเชยถึง 31 ธ.ค. ปีเดียวกัน
  isSwapExpired(req) {
    if (!req || req.status !== 'pending') return false;
    const cal = (this.data.calendarItems || []).find(c => c.id === req.calendarItemId);
    if (!cal?.date) return false;
    const [hYearStr, hMonthStr] = cal.date.split('-');
    const hYear = parseInt(hYearStr, 10);
    const hMonth = parseInt(hMonthStr, 10);
    const deadline = hMonth === 12
      ? `${hYear + 1}-03-31`
      : `${hYear}-12-31`;
    const today = new Date().toISOString().slice(0, 10);
    return today > deadline;
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
    note: r.note || '',
    requestType: r.request_type || '',       // [Feat] ประเภทคำขอ
    requestReason: r.request_reason || ''    // [Feat] เหตุผล/รายละเอียดเพิ่ม
  }),
  _uniReqToDB: (r) => ({
    employee_id: r.employeeId || null,
    applicant_id: r.applicantId || null,
    requested_by: r.requestedBy || null,
    requested_date: r.requestedDate || null,
    needed_by: r.neededBy || null,
    status: r.status || 'pending',
    total_cost: Number(r.totalCost || 0),
    note: r.note || null,
    request_type: r.requestType || null,
    request_reason: r.requestReason || null
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
    // Scope filter — ใช้ resolution chain ของ _filterByPositionScope (position.scope → dept.scope)
    if (filter.scope) list = this._filterByPositionScope(list, filter.scope);
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
    // primary: employees data (มี full/slim cols ตาม RLS scope)
    // fallback: _orgChartCache (basic cols ทุกคน — สำหรับ org chart visibility)
    return this._empIndex.get(id) || this._orgChartCache?.get(id);
  },

  // [PERF] ดึง employee พร้อม field ครบ (ถ้า cache มีแค่ slim)
  // ใช้ใน app.js ก่อนเปิด form/detail/personal dashboard ที่ต้องการ salary/ปชช/bank/allowance/sso/ที่อยู่/พาสปอร์ต
  // คืน emp object เดียวกันใน cache (mutate in place) เพื่อให้ DB.getEmployee() ที่อื่นได้ค่าใหม่ด้วย
  async ensureFullEmployee(id) {
    const emp = this.getEmployee(id);
    if (!emp) return null;
    if (emp._isSlim !== true) return emp;  // already full

    try {
      const { data, error } = await this.client.from('employees_view')
        .select('*').eq('id', id).maybeSingle();
      if (error || !data) return emp;  // fallback — return slim
      const full = this._empFromDB(data);
      // mutate in place — keep reference เดียวกันใน cache
      Object.assign(emp, full);
      emp._isSlim = false;
      return emp;
    } catch (e) {
      console.warn('[ensureFullEmployee] fetch failed for', id, e);
      return emp;
    }
  },

  // [PERF] bulk version — ดึง full record ของหลาย employees ในครั้งเดียว
  // ใช้ก่อน export (CSV/XLSX) หรือ ก่อน backup ก่อน import override
  // bulk fetch ครั้งเดียวด้วย IN (...) — แทน fetch ทีละคน
  async ensureFullEmployees(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const need = [];
    for (const id of ids) {
      const e = this.getEmployee(id);
      if (e && e._isSlim === true) need.push(id);
    }
    if (need.length === 0) return;

    // chunk ทีละ 200 ids เพื่อไม่ให้ URL ยาวเกิน (Supabase IN จะ encode ใน query string)
    const CHUNK = 200;
    for (let i = 0; i < need.length; i += CHUNK) {
      const slice = need.slice(i, i + CHUNK);
      try {
        const { data, error } = await this.client.from('employees_view')
          .select('*').in('id', slice);
        if (error || !data) continue;
        for (const r of data) {
          const emp = this.getEmployee(r.id);
          if (!emp) continue;
          const full = this._empFromDB(r);
          Object.assign(emp, full);
          emp._isSlim = false;
        }
      } catch (e) {
        console.warn('[ensureFullEmployees] chunk fetch failed', e);
      }
    }
  },

  // เช็คว่ารหัสพนักงานนี้มีอยู่แล้วในระบบหรือยัง — เช็คทั้ง cache + DB
  // คืน employee row (รวม resigned) ถ้ามี, null ถ้าไม่มี
  async checkDuplicateEmployeeId(id) {
    if (!id) return null;
    const idStr = String(id).trim();
    if (!idStr) return null;
    // 1) cache check
    const cached = this.data.employees.find(e => String(e.id).trim() === idStr);
    if (cached) return cached;
    // 2) DB check (เผื่อ cache stale หรือ row ที่ HR ไม่มีสิทธิ์เห็นใน RLS)
    try {
      const { data, error } = await this.client
        .from('employees_view')
        .select('id, first_name, last_name, branch, status, termination_date')
        .eq('id', idStr)
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id,
        firstName: data.first_name,
        lastName: data.last_name,
        branch: data.branch,
        status: data.status,
        terminationDate: data.termination_date
      };
    } catch (e) { return null; }
  },

  // เช็คเลขประชาชนซ้ำ — คืน array ของ employee ที่ใช้เลขเดียวกัน
  // (แยก digit-only เพื่อ normalize "1-2345-67890-12-3" → "1234567890123")
  async checkDuplicateNationalId(nationalId, excludeId = null) {
    if (!nationalId) return [];
    const norm = String(nationalId).replace(/\D/g, '');
    if (norm.length < 5) return [];  // สั้นเกินไป → likely typo, skip
    // เช็คจาก cache (HR เห็นทั้ง active+resigned ผ่าน RLS แล้ว)
    return this.data.employees.filter(e => {
      const eNat = String(e.nationalId || '').replace(/\D/g, '');
      return eNat && eNat === norm && (!excludeId || String(e.id) !== String(excludeId));
    });
  },

  async saveEmployee(emp, opts = {}) {
    // [Anti-overwrite] ถ้า caller ระบุ isNew=true → เช็คซ้ำก่อน (กัน upsert เขียนทับ)
    if (opts.isNew === true) {
      const dup = await this.checkDuplicateEmployeeId(emp.id);
      if (dup) {
        const name = `${dup.firstName || ''} ${dup.lastName || ''}`.trim() || '(ไม่มีชื่อ)';
        const branchInfo = dup.branch ? ` · สาขา ${dup.branch}` : '';
        const statusInfo = dup.status === 'resigned' ? ' · พ้นสภาพแล้ว' : '';
        throw new Error(`รหัสพนักงาน "${emp.id}" มีอยู่แล้ว — ${name}${branchInfo}${statusInfo}`);
      }
    }
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
    // [Security M-A3] DoS protection — จำกัดขนาด bulk op
    if (Array.isArray(matches) && matches.length > 5000) {
      throw new Error('อัปโหลดได้สูงสุด 5,000 รูปต่อครั้ง (รับมาตอนนี้ ' + matches.length + ')');
    }
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

  // ─── DIFFERENTIAL IMPORT ───
  // map JS key → DB column name (สำหรับ partial UPDATE — patch เฉพาะ field ที่เปลี่ยน)
  _EMP_FIELD_TO_DB: {
    title: 'title', firstName: 'first_name', lastName: 'last_name', nickname: 'nickname',
    gender: 'gender', dob: 'dob', nationalId: 'national_id',
    passportNumber: 'passport_number', workPermitNumber: 'work_permit_number',
    nationality: 'nationality', religion: 'religion', education: 'education',
    phone: 'phone', email: 'email', address: 'address',
    subDistrict: 'sub_district', district: 'district',
    province: 'province', postalCode: 'postal_code',
    department: 'department', branch: 'branch',
    position: 'position', positionTitle: 'position_title',
    employeeType: 'employee_type', hireDate: 'hire_date',
    terminationDate: 'termination_date', terminationReason: 'termination_reason',
    terminationNote: 'termination_note',
    bank: 'bank', bankAccount: 'bank_account',
    salary: 'salary',
    allowancePosition: 'allowance_position', allowanceTravel: 'allowance_travel',
    allowanceFood: 'allowance_food', allowancePerDiem: 'allowance_per_diem',
    allowanceLanguage: 'allowance_language', allowancePhone: 'allowance_phone',
    allowanceOther: 'allowance_other',
    ssoNo: 'sso_no', ssoEnrolledDate: 'sso_enrolled_date',
    ssoTerminatedDate: 'sso_terminated_date', ssoHospital: 'sso_hospital',
    status: 'status', note: 'note'
  },

  // Bulk patch — เปลี่ยนเฉพาะ field ที่ระบุ ไม่กระทบ column อื่น
  // patches = [{ id, changedFields: [{ key, newValue }, ...] }, ...]
  // หลักการ: group ตาม "ชุดของ field ที่เปลี่ยน" (signature)
  //   - HR เปลี่ยน bank ของทุกคน → 1 signature = 1 batch upsert (เร็ว)
  //   - HR แก้คนละฟิลด์กัน → หลาย signature = หลาย batch (ยังเร็วกว่า per-row)
  // ใช้ upsert บน partial columns — PostgreSQL จะ UPDATE เฉพาะ column ที่อยู่ในชุด
  async bulkPatchEmployees(patches, onProgress) {
    // [Security M-A3] DoS protection
    if (Array.isArray(patches) && patches.length > 5000) {
      throw new Error('แก้ไขได้สูงสุด 5,000 row ต่อครั้ง (รับมาตอนนี้ ' + patches.length + ')');
    }
    if (!patches || patches.length === 0) {
      return { patched: 0, failed: 0, errors: [] };
    }
    // กำหนด field ที่เป็น number (ส่วนที่เหลือ = string/date)
    const NUMBER_FIELDS = new Set([
      'salary', 'allowancePosition', 'allowanceTravel', 'allowanceFood',
      'allowancePerDiem', 'allowanceLanguage', 'allowancePhone', 'allowanceOther'
    ]);
    const groups = new Map();   // signature → [{id, dbPatch}, ...]
    for (const p of patches) {
      const dbPatch = {};
      for (const c of p.changedFields) {
        const dbKey = this._EMP_FIELD_TO_DB[c.key];
        if (!dbKey) continue;   // skip field ที่ไม่ map (เช่น _role, _scope)
        if (NUMBER_FIELDS.has(c.key)) {
          dbPatch[dbKey] = Number(c.newValue || 0);
        } else if (c.newValue === '' || c.newValue == null) {
          dbPatch[dbKey] = null;   // ว่าง → NULL (ไม่ใช่ '')
        } else if (c.newValue instanceof Date) {
          dbPatch[dbKey] = c.newValue.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        } else {
          dbPatch[dbKey] = String(c.newValue);
        }
      }
      const sig = Object.keys(dbPatch).sort().join(',');
      if (!sig) continue;   // ไม่มี field ที่ map ได้ → skip
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push({ id: p.id, dbPatch });
    }
    const result = { patched: 0, failed: 0, errors: [] };
    let done = 0;
    const totalToDo = Array.from(groups.values()).reduce((sum, g) => sum + g.length, 0);
    for (const grp of groups.values()) {
      const CHUNK_SIZE = 100;
      for (let i = 0; i < grp.length; i += CHUNK_SIZE) {
        const chunk = grp.slice(i, i + CHUNK_SIZE).map(p => ({ id: p.id, ...p.dbPatch }));
        const { data, error } = await this.client
          .from('employees')
          .upsert(chunk, { onConflict: 'id' })
          .select();
        if (error) {
          result.failed += chunk.length;
          result.errors.push({ message: error.message, sample: chunk.slice(0, 3).map(c => c.id) });
        } else {
          result.patched += data.length;
          for (const row of data) {
            const mapped = this._empFromDB(row);
            const idx = this.data.employees.findIndex(e => e.id === mapped.id);
            if (idx >= 0) this.data.employees[idx] = mapped;
            else this.data.employees.push(mapped);
          }
          this._invalidateIndex('employees');
        }
        done += chunk.length;
        if (onProgress) onProgress(done, totalToDo);
        await new Promise(r => requestAnimationFrame(r));
      }
    }
    return result;
  },

  // ─── BULK IMPORT ───
  async bulkUpsertEmployees(rows, onProgress) {
    // [Security M-A3] DoS protection
    if (Array.isArray(rows) && rows.length > 5000) {
      throw new Error('Import ได้สูงสุด 5,000 row ต่อครั้ง (รับมาตอนนี้ ' + rows.length + ')');
    }
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
      oldAllowancePhone:    rec.newAllowancePhone    != null ? (rec.oldAllowancePhone    != null ? rec.oldAllowancePhone    : emp.allowancePhone)    : null,
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
    if (enriched.newAllowancePhone    != null) emp.allowancePhone    = Number(enriched.newAllowancePhone);
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
    // HR / admin override — ทุกกรณี (defensive: ใช้ this.isHR ถ้ามี)
    if (this.isHR || this.isAdmin) return records;
    if (this.role === 'admin' || this.role === 'hr' || this.role === 'operation_manager') return records;
    if (this.role === 'branch_staff' || this.role === 'viewer') {
      const myId = this.profile?.employee_id;
      return records.filter(r => getEmpId(r) === myId);
    }
    // branch_manager / area_manager — รองรับ records ที่ getEmpId คืน null (เช่น applicant)
    // → resolve ไป applicant.branch ถ้ามี r.applicantId
    const scoped = this.scopedBranches() || [];
    const scopedSet = new Set(scoped);
    const scopedEmpIds = new Set(this.data.employees.filter(e => scoped.includes(e.branch)).map(e => e.id));
    return records.filter(r => {
      const empId = getEmpId(r);
      if (empId && scopedEmpIds.has(empId)) return true;
      // fallback: ถ้า record มี applicantId + applicant อยู่ในสาขา scope
      if (!empId && r && r.applicantId) {
        const ap = (this.data.applicants || []).find(a => a.id === r.applicantId);
        if (ap && ap.branch && scopedSet.has(ap.branch)) return true;
      }
      return false;
    });
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
  // [Feat] Self-service: พนักงานยื่นคำขอชุดสำหรับตัวเอง
  // - auto employee_id = self
  // - status = 'pending' บังคับ
  // - requestedBy = ตัวเอง
  async requestUniformForSelf({ requestType, requestReason = '', note = '', neededBy = null } = {}) {
    if (!this.user || !this.profile?.employee_id) {
      throw new Error('ต้องผูกบัญชีกับพนักงานก่อน');
    }
    if (!requestType) throw new Error('ต้องเลือกประเภทคำขอ');
    const emp = this.getEmployee(this.profile.employee_id);
    const myName = emp ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() : (this.user.email || 'พนักงาน');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const row = {
      employee_id: this.profile.employee_id,
      applicant_id: null,
      requested_by: myName,
      requested_date: today,
      needed_by: neededBy || null,
      status: 'pending',           // บังคับ pending — รอ HR/BM อนุมัติ + จัดส่ง
      total_cost: 0,
      note: note || null,
      request_type: requestType,
      request_reason: requestReason || null
    };
    const { data, error } = await this.client.from('uniform_requests').insert(row).select().single();
    if (error) throw error;
    const mapped = this._uniReqFromDB(data);
    this.data.uniformRequests.unshift(mapped);
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
    // ─── 3) [C2] เคลียร์ force_password_change flag (no-op ถ้าไม่ได้ตั้งอยู่) ───
    try {
      await this.client.rpc('clear_force_password_change');
      if (this.profile) this.profile.force_password_change = false;
    } catch (ex) {
      // RPC ยังไม่ deploy → ไม่ block — แค่ log
      console.warn('[clear_force_password_change]', ex?.message || ex);
    }
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
  // [Security H-A1] random password ปลอดภัยกว่า NID (เพื่อนร่วมงานเดารู้)
  // 8 chars จาก 36-char alphabet → ~5.2 × 10^12 combinations
  // HR แจ้งให้พนักงานผ่านช่องทางส่วนตัว (Line, SMS, สลิป)
  // พนักงานต้องเปลี่ยนตอน first login (force_password_change=true)
  _computeInitialPassword(emp) {
    // ใช้ Web Crypto API — secure random
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz';  // ตัด O/0/I/l/1 กันสับสน
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let pwd = '';
    for (let i = 0; i < bytes.length; i++) {
      pwd += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return { password: pwd, source: 'random' };
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

    // [Security H-A3] ไม่ return plaintext password
    // ฝั่ง UI แสดง hint แทน (NID หรือ employee_id) — user ต้องเปลี่ยน password ตอน first login
    return {
      user_id: data?.user_id,
      email: data?.email || email,
      source,
      created: true,
      needs_change: data?.needs_change !== false,
      password_hint: data?.password_hint || (source === 'natid' ? 'เลขบัตรประชาชน (13 หลัก)' : 'รหัสพนักงาน'),
      message: data?.message || 'สร้างบัญชีสำเร็จ'
    };
  },

  async bulkCreateEmployeeAccounts() {
    if (!this.isHR) throw new Error('ต้องเป็น admin หรือ HR');
    // [Security H-A3] ไม่เก็บ password ใน result — กันรั่วผ่าน DOM/screenshot/Excel export
    // HR เห็นแค่ list ที่สร้างสำเร็จ + ใช้ default = เลขบัตรประชาชน 13 หลัก
    // (ตัว user ต้องเปลี่ยน password ตอน first login ผ่าน force_password_change modal)
    const profiles = await this.refetchUserProfiles();
    const linked = new Set((profiles || []).filter(p => p.employee_id).map(p => p.employee_id));
    const todo = this.data.employees.filter(e => this.empStatus(e) !== 'resigned' && !linked.has(e.id));
    // [Security M-A3] DoS protection — สร้างได้สูงสุด 5,000 บัญชี/ครั้ง
    if (todo.length > 5000) {
      throw new Error('สร้างบัญชีได้สูงสุด 5,000 ครั้งต่อรอบ (พบ ' + todo.length + ' พนักงานยังไม่มีบัญชี — ขอแบ่งทำหลายรอบ)');
    }
    const results = [];
    for (const emp of todo) {
      try {
        const res = await this.createEmployeeAccount(emp.id);
        results.push({
          employee_id: emp.id,
          email: res.email,
          source: res.source,
          created: !!res.created,
          needs_change: res.needs_change !== false,
          password_hint: res.password_hint || 'เลขบัตรประชาชน (13 หลัก)',
          message: res.message
        });
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
    // [F2] ถ้า admin/HR แก้ role ของ *ตัวเอง* → invalidate permission cache + refresh profile
    // เพื่อให้สิทธิ์ใหม่มีผลทันที (เช่น admin downgrade ตัวเองเป็น HR เพื่อทดสอบ)
    if (employeeId === this.profile?.employee_id) {
      this._permCache = null;
      this._permLoadPromise = null;
      try { await this.loadProfile(); } catch (e) { /* not fatal */ }
    }
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
    // ─── Approval chain (3-step) ───
    bmStatus: r.bm_status || 'pending',
    bmBy: r.bm_by,
    bmAt: r.bm_at,
    bmNote: r.bm_note || '',
    amStatus: r.am_status || 'pending',
    amBy: r.am_by,
    amAt: r.am_at,
    amNote: r.am_note || '',
    finalApproverRole: r.final_approver_role || null,
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

  // ─── APPROVAL CHAIN HELPERS (3-step BM → AM → AM/OM) ───

  // คำนวณช่วงวันต่อเนื่อง (รวม leave + holiday swap วันเดียวกัน) ที่ติดต่อกันจริง
  // (ไม่ข้ามเสาร์-อาทิตย์ — ส-อา = ไม่ติด)
  // คืน max length ของช่วงที่ครอบ leave นี้
  calcContinuousLeaveDays(empId, startDate, endDate, excludeId = null) {
    if (!empId || !startDate || !endDate) return 0;
    // รวบรวมวันที่ลา + swap ของพนักงานคนนี้ที่ยัง active
    const allDates = new Set();
    // วันลา (รวมตัวเอง)
    (this.data.leaveRequests || []).forEach(r => {
      if (r.id === excludeId) return;
      if (r.employeeId !== empId) return;
      if (r.status === 'rejected' || r.status === 'cancelled') return;
      let d = r.startDate;
      while (d && d <= r.endDate) {
        allDates.add(d);
        d = this._nextDayYMD(d);
      }
    });
    // เพิ่มช่วงปัจจุบันที่กำลังพิจารณา (กันลืม)
    let d = startDate;
    while (d && d <= endDate) {
      allDates.add(d);
      d = this._nextDayYMD(d);
    }
    // วัน swap (พนักงานคนนี้)
    (this.data.holidaySwapRequests || []).forEach(r => {
      if (r.id === excludeId) return;
      if (r.employeeId !== empId) return;
      if (r.status === 'rejected' || r.status === 'cancelled') return;
      if (r.swapToDate) allDates.add(r.swapToDate);
    });
    if (!allDates.size) return 0;
    // หาช่วงต่อเนื่องที่ครอบ startDate
    const sorted = [...allDates].sort();
    // ขยายจาก startDate ออกซ้าย-ขวา ทีละวัน (วันต่อวัน — ไม่ข้าม)
    let cur = startDate;
    let count = 1;
    // ขยายไปขวาจาก endDate
    let right = endDate;
    while (true) {
      const next = this._nextDayYMD(right);
      if (allDates.has(next)) { right = next; count++; }
      else break;
    }
    // ขยายไปซ้ายจาก startDate
    let left = startDate;
    while (true) {
      const prev = this._prevDayYMD(left);
      if (allDates.has(prev)) { left = prev; count++; }
      else break;
    }
    // นับจริงตามช่วง [left, right]
    let n = 0;
    let cursor = left;
    while (cursor && cursor <= right) { n++; cursor = this._nextDayYMD(cursor); }
    return n;
  },

  _nextDayYMD(ymd) {
    if (!ymd) return null;
    const m = String(ymd).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3] + 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  _prevDayYMD(ymd) {
    if (!ymd) return null;
    const m = String(ymd).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3] - 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  // ตัดสินใจว่า request นี้ต้องผ่าน OM หรือ AM อนุมัติ final
  // ≥3 วันต่อเนื่อง → 'om', ไม่งั้น → 'am'
  decideFinalApprover(empId, startDate, endDate, excludeId = null) {
    const n = this.calcContinuousLeaveDays(empId, startDate, endDate, excludeId);
    return n >= 3 ? 'om' : 'am';
  },

  // หา OM (operation_manager) สำหรับแสดง/อนุมัติ
  getOperationManager() {
    const profiles = this._userProfiles || [];
    const oms = profiles.filter(p => p.role === 'operation_manager' && p.employee_id)
      .sort((a, b) => (a.employee_id < b.employee_id ? -1 : 1));
    for (const p of oms) {
      const e = this.getEmployee(p.employee_id);
      if (e && this.empStatus(e) !== 'resigned') return e;
    }
    return null;
  },

  // สิทธิ์ตามขั้น chain
  canEndorseLeaveAsBM(empId) {
    if (this.isHR) return true;
    if (this.role !== 'branch_manager') return false;
    const emp = this.getEmployee(empId);
    if (!emp) return false;
    const myBranch = this._myBranch();
    const managed = (this._managedBranches && this._managedBranches.length)
      ? this._managedBranches
      : (myBranch ? [myBranch] : []);
    return managed.includes(emp.branch);
  },
  canEndorseLeaveAsAM(empId) {
    if (this.isHR) return true;
    if (this.role !== 'area_manager') return false;
    const emp = this.getEmployee(empId);
    if (!emp) return false;
    const myBranch = this._myBranch();
    const managed = (this._managedBranches && this._managedBranches.length)
      ? this._managedBranches
      : (myBranch ? [myBranch] : []);
    return managed.includes(emp.branch);
  },
  canFinalApproveLeave(req) {
    if (this.isHR) return true;
    if (!req) return false;
    // ต้องผ่าน chain BM+AM endorsed ก่อน
    if (req.bmStatus !== 'endorsed' || req.amStatus !== 'endorsed') return false;
    const role = req.finalApproverRole || 'am';
    if (role === 'om') {
      return this.role === 'operation_manager';
    }
    // 'am' — AM ที่ดูแลสาขา
    return this.canEndorseLeaveAsAM(req.employeeId);
  },

  // ─── ENDORSE methods (leave) ───
  async endorseLeaveByBM(id, decision /* 'endorsed' | 'declined' */, note = '') {
    const req = this.getLeaveRequest(id);
    if (!req) throw new Error('ไม่พบคำขอลา');
    if (!this.canEndorseLeaveAsBM(req.employeeId)) {
      throw new Error('เฉพาะผู้จัดการสาขา (หรือ HR/admin) ที่เห็นชอบขั้นแรกได้');
    }
    const patch = {
      bm_status: decision,
      bm_by: this.user?.id || null,
      bm_at: new Date().toISOString(),
      bm_note: note || null
    };
    if (decision === 'declined') {
      patch.status = 'rejected';
      patch.approver_note = note || null;
    }
    const { data, error } = await this.client.from('leave_requests')
      .update(patch).eq('id', id).select().single();
    if (error) throw error;
    return this._leaveFromDB(data);
  },

  async endorseLeaveByAM(id, decision, note = '') {
    const req = this.getLeaveRequest(id);
    if (!req) throw new Error('ไม่พบคำขอลา');
    if (!this.canEndorseLeaveAsAM(req.employeeId)) {
      throw new Error('เฉพาะ Area Manager (หรือ HR/admin) ที่เห็นชอบขั้นที่สองได้');
    }
    if (req.bmStatus !== 'endorsed' && !this.isHR) {
      throw new Error('ต้องให้ผู้จัดการสาขาเห็นชอบก่อน');
    }
    // ตัดสินใจ final approver role ตามจำนวนวันต่อเนื่อง
    const finalRole = this.decideFinalApprover(req.employeeId, req.startDate, req.endDate, id);
    const patch = {
      am_status: decision,
      am_by: this.user?.id || null,
      am_at: new Date().toISOString(),
      am_note: note || null,
      final_approver_role: finalRole
    };
    if (decision === 'declined') {
      patch.status = 'rejected';
      patch.approver_note = note || null;
    } else if (finalRole === 'am') {
      // AM endorse + final approver = AM → อนุมัติทันทีในขั้นเดียว
      patch.status = 'approved';
      patch.approved_by = this.user?.id || null;
      patch.approved_at = new Date().toISOString();
      patch.approver_note = note || null;
    }
    const { data, error } = await this.client.from('leave_requests')
      .update(patch).eq('id', id).select().single();
    if (error) throw error;
    return this._leaveFromDB(data);
  },

  async finalApproveLeaveByOM(id, decision /* 'approved' | 'rejected' */, note = '') {
    const req = this.getLeaveRequest(id);
    if (!req) throw new Error('ไม่พบคำขอลา');
    if (!this.canFinalApproveLeave(req)) {
      throw new Error('คุณไม่มีสิทธิ์อนุมัติขั้นสุดท้าย — ต้องเป็น OM/HR ตามที่กำหนด');
    }
    if (req.finalApproverRole !== 'om' && !this.isHR) {
      throw new Error('คำขอนี้ AM อนุมัติได้โดยตรง ไม่ต้องผ่าน OM');
    }
    const patch = {
      status: decision,
      approved_by: this.user?.id || null,
      approved_at: new Date().toISOString(),
      approver_note: note || null
    };
    const { data, error } = await this.client.from('leave_requests')
      .update(patch).eq('id', id).select().single();
    if (error) throw error;
    return this._leaveFromDB(data);
  },

  // ─── ENDORSE methods (holiday_swap) ───
  async endorseSwapByBM(id, decision, note = '') {
    const req = (this.data.holidaySwapRequests || []).find(r => r.id === id);
    if (!req) throw new Error('ไม่พบคำขอ swap');
    if (!this.canEndorseLeaveAsBM(req.employeeId)) {
      throw new Error('เฉพาะผู้จัดการสาขา (หรือ HR/admin) ที่เห็นชอบขั้นแรกได้');
    }
    const patch = {
      bm_status: decision,
      bm_by: this.user?.id || null,
      bm_at: new Date().toISOString(),
      bm_note: note || null
    };
    if (decision === 'declined') {
      patch.status = 'rejected';
      patch.approver_note = note || null;
    }
    const { data, error } = await this.client.from('holiday_swap_requests')
      .update(patch).eq('id', id).select().single();
    if (error) throw error;
    return this._swapReqFromDB(data);
  },

  async endorseSwapByAM(id, decision, note = '') {
    const req = (this.data.holidaySwapRequests || []).find(r => r.id === id);
    if (!req) throw new Error('ไม่พบคำขอ swap');
    if (!this.canEndorseLeaveAsAM(req.employeeId)) {
      throw new Error('เฉพาะ Area Manager (หรือ HR/admin) ที่เห็นชอบขั้นที่สองได้');
    }
    if (req.bmStatus !== 'endorsed' && !this.isHR) {
      throw new Error('ต้องให้ผู้จัดการสาขาเห็นชอบก่อน');
    }
    // swap = 1 วัน → final approver = AM เสมอ (ยกเว้นรวมกับลา ≥3 วันต่อเนื่อง)
    const finalRole = this.decideFinalApprover(req.employeeId, req.swapToDate, req.swapToDate, id);
    const patch = {
      am_status: decision,
      am_by: this.user?.id || null,
      am_at: new Date().toISOString(),
      am_note: note || null,
      final_approver_role: finalRole
    };
    if (decision === 'declined') {
      patch.status = 'rejected';
      patch.approver_note = note || null;
    } else if (finalRole === 'am') {
      patch.status = 'approved';
      patch.approved_by = this.user?.id || null;
      patch.approved_at = new Date().toISOString();
      patch.approver_note = note || null;
    }
    const { data, error } = await this.client.from('holiday_swap_requests')
      .update(patch).eq('id', id).select().single();
    if (error) throw error;
    return this._swapReqFromDB(data);
  },

  async finalApproveSwapByOM(id, decision, note = '') {
    const req = (this.data.holidaySwapRequests || []).find(r => r.id === id);
    if (!req) throw new Error('ไม่พบคำขอ swap');
    if (req.bmStatus !== 'endorsed' || req.amStatus !== 'endorsed') {
      throw new Error('ต้องผ่านขั้น ผจก. และ AM เห็นชอบก่อน');
    }
    if (!this.isHR && this.role !== 'operation_manager') {
      throw new Error('เฉพาะ OM (หรือ HR/admin) ที่อนุมัติขั้นสุดท้ายได้');
    }
    const patch = {
      status: decision,
      approved_by: this.user?.id || null,
      approved_at: new Date().toISOString(),
      approver_note: note || null
    };
    const { data, error } = await this.client.from('holiday_swap_requests')
      .update(patch).eq('id', id).select().single();
    if (error) throw error;
    return this._swapReqFromDB(data);
  },

  // ─── OVERLAP DETECTION (กันลาซ้ำ + ลาตรงวันชดเชย swap) ───
  // คืน array ของคำขอลาอื่นๆ ที่ทับซ้อนกับช่วง [startDate, endDate] ของพนักงานคนนี้
  // ข้าม rejected / cancelled (เพราะไม่มีผลแล้ว) + ข้าม excludeId (กรณี edit)
  findLeaveOverlap(empId, startDate, endDate, excludeId = null) {
    if (!empId || !startDate || !endDate) return [];
    return (this.data.leaveRequests || []).filter(r => {
      if (r.id === excludeId) return false;
      if (r.employeeId !== empId) return false;
      if (r.status === 'rejected' || r.status === 'cancelled') return false;
      if (!r.startDate || !r.endDate) return false;
      // overlap = startA <= endB AND startB <= endA
      return r.startDate <= endDate && startDate <= r.endDate;
    });
  },

  // คืน array ของ swap requests ที่ swapToDate ตรงกับช่วงวันลา
  // (พนักงานได้วันชดเชยวันนั้นอยู่แล้ว — ไม่ควรลา/swap ทับ)
  findSwapOnDate(empId, startDate, endDate, excludeId = null) {
    if (!empId || !startDate || !endDate) return [];
    return (this.data.holidaySwapRequests || []).filter(r => {
      if (r.id === excludeId) return false;
      if (r.employeeId !== empId) return false;
      if (r.status === 'rejected' || r.status === 'cancelled') return false;
      if (!r.swapToDate) return false;
      return r.swapToDate >= startDate && r.swapToDate <= endDate;
    });
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

  // กฎทางธุรกิจ: ต้องอนุมัติ "ก่อน" วันลาเริ่ม — ห้ามอนุมัติเมื่อวันลามาถึงแล้ว
  // ยกเว้น (1) ประเภทที่ allow_backdate (ลาป่วย / ลาคลอด / ลาคลอดช่วยภริยา)
  //       (2) admin / HR — override ได้ทุกกรณี
  // กระทบ branch_manager / area_manager เท่านั้น
  _ensureLeaveDateApprovable(req) {
    if (this.isHR) return; // admin + hr bypass ทุกกรณี
    const cfg = this.LEAVE_TYPES[req.leaveType];
    if (cfg?.allowBackdate) return;
    const today = this.todayBkk();
    if (req.startDate && req.startDate <= today) {
      const label = cfg?.label || req.leaveType;
      throw new Error(`ไม่สามารถอนุมัติได้ — วันลาเริ่มหรือผ่านไปแล้ว (เริ่ม ${req.startDate}) · ประเภท "${label}" ต้องอนุมัติก่อนถึงวันลา · กรุณาปฏิเสธหรือให้ HR override`);
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
    const emps = this._filterByPositionScope(this.getEmployees(), scope);
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

  // ─── LEAVE/SWAP STATS (ตามประเภท + เฉลี่ยต่อพนักงาน per branch/department) ───
  // ใช้ใน dashboard card "ภาพรวมการลา"
  getLeaveSwapStats({ scope = '', year = new Date().getFullYear() } = {}) {
    return this._cachedStats(`leaveSwapStats:${scope}:${year}:${this.role || ''}`,
      () => this._computeLeaveSwapStats({ scope, year }));
  },
  _computeLeaveSwapStats({ scope = '', year } = {}) {
    const emps = this._filterByPositionScope(this.getEmployees(), scope);
    const active = emps.filter(e => this.empStatus(e) !== 'resigned');
    const empIds = new Set(active.map(e => e.id));
    const headcount = active.length;
    // by leave type — รวมเฉพาะ approved ในปีที่เลือก
    const types = this.getLeaveTypesList();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const byType = types.map(t => {
      const matched = (this.data.leaveRequests || []).filter(r =>
        r.status === 'approved' && r.leaveType === t.id &&
        empIds.has(r.employeeId) &&
        r.startDate >= yearStart && r.startDate <= yearEnd
      );
      const totalDays = matched.reduce((s, r) => s + Number(r.days || 0), 0);
      const uniqueEmps = new Set(matched.map(r => r.employeeId)).size;
      return {
        id: t.id, label: t.label, badge: t.badge || 'badge-info',
        totalDays, requestCount: matched.length, uniqueEmps,
        avgPerEmp: headcount ? +(totalDays / headcount).toFixed(2) : 0
      };
    });
    // swap days (วันหยุดชดเชย — รวม approved ในปี)
    const swapMatched = (this.data.holidaySwapRequests || []).filter(r =>
      r.status === 'approved' &&
      empIds.has(r.employeeId) &&
      r.swapToDate >= yearStart && r.swapToDate <= yearEnd
    );
    const swapTotal = swapMatched.length;     // 1 swap = 1 วันชดเชย
    const swapUnique = new Set(swapMatched.map(r => r.employeeId)).size;
    // per branch breakdown
    const byBranch = new Map();
    for (const r of (this.data.leaveRequests || [])) {
      if (r.status !== 'approved') continue;
      if (!empIds.has(r.employeeId)) continue;
      if (r.startDate < yearStart || r.startDate > yearEnd) continue;
      const emp = this.getEmployee(r.employeeId);
      const b = emp?.branch || 'ไม่ระบุ';
      if (!byBranch.has(b)) byBranch.set(b, { branch: b, leaveDays: 0, swapDays: 0, empCount: 0 });
      byBranch.get(b).leaveDays += Number(r.days || 0);
    }
    for (const r of swapMatched) {
      const emp = this.getEmployee(r.employeeId);
      const b = emp?.branch || 'ไม่ระบุ';
      if (!byBranch.has(b)) byBranch.set(b, { branch: b, leaveDays: 0, swapDays: 0, empCount: 0 });
      byBranch.get(b).swapDays += 1;
    }
    // populate emp count per branch
    for (const e of active) {
      const b = e.branch || 'ไม่ระบุ';
      if (!byBranch.has(b)) byBranch.set(b, { branch: b, leaveDays: 0, swapDays: 0, empCount: 0 });
      byBranch.get(b).empCount += 1;
    }
    const branches = Array.from(byBranch.values())
      .map(x => ({ ...x, avgLeavePerEmp: x.empCount ? +(x.leaveDays / x.empCount).toFixed(2) : 0,
                          avgSwapPerEmp:  x.empCount ? +(x.swapDays / x.empCount).toFixed(2) : 0 }))
      .sort((a, b) => (b.leaveDays + b.swapDays) - (a.leaveDays + a.swapDays));
    // overall totals
    const totalLeaveDays = byType.reduce((s, t) => s + t.totalDays, 0);
    return {
      year, headcount,
      byType,
      swap: { totalDays: swapTotal, uniqueEmps: swapUnique, avgPerEmp: headcount ? +(swapTotal / headcount).toFixed(2) : 0 },
      branches,
      totals: {
        leaveDays: totalLeaveDays,
        swapDays: swapTotal,
        avgLeavePerEmp: headcount ? +(totalLeaveDays / headcount).toFixed(2) : 0
      }
    };
  },

  // ─── BRANCH STATS (จำนวนพนักงานต่อสาขา — เฉพาะที่ยังปฏิบัติงาน) ───
  // ─── Helper: กรอง employees ตาม scope (สายงาน) ───
  // ใช้ใน dashboard filters: scope = 'operation'/'office'/'scm'/... | '' = no filter
  // Resolution chain (ลำดับความสำคัญ):
  //   1. employee.position → positionLevels.scope  (ถ้าตำแหน่งระดับมี scope)
  //   2. fallback → employee.department → departments.scope  (ถ้าฝ่ายมี scope)
  // เหตุที่ต้อง fallback: หลายองค์กรไม่ได้กรอกระดับตำแหน่งให้พนักงานทุกคน
  // (ตำแหน่งใช้ positionTitle free-text แทน) — แต่ฝ่ายต้องมีเสมอ
  // [Fix] เปลี่ยนชื่อจาก _filterByScope → _filterByPositionScope
  //  เพราะชื่อ _filterByScope ชนกับ RBAC method ที่ line 2193 — JS object literal
  //  declaration อันหลังทับอันแรก → uniforms/loans/etc. ที่เรียกแบบ (records, getEmpId)
  //  จะ run method นี้ → return [] ว่างหมด
  _filterByPositionScope(emps, scope) {
    if (!scope) return emps;
    return emps.filter(e => {
      // priority 1: position.scope
      const pos = e.position ? this.getPosition(e.position) : null;
      if (pos?.scope) return pos.scope === scope;
      // priority 2: dept.scope (fallback)
      const dept = e.department ? this.getDepartment(e.department) : null;
      return dept?.scope === scope;
    });
  },

  getBranchStats({ scope = '' } = {}) {
    return this._cachedStats(`branchStats:${scope}`, () => this._computeBranchStats({ scope }));
  },
  _computeBranchStats({ scope = '' } = {}) {
    const counts = new Map();
    const list = this._filterByPositionScope(this.data.employees, scope);
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
  // Resolution chain (เหมือน _filterByScope):
  //   1. employee.position → positionLevels.scope (ถ้ามี)
  //   2. fallback → employee.department → departments.scope (ถ้าฝ่ายมี scope)
  // คนที่ทั้ง position+dept ไม่มี scope → จัดเป็น "ไม่ระบุสาย"
  getScopeStats() {
    return this._cachedStats('scopeStats', () => this._computeScopeStats());
  },
  _computeScopeStats() {
    const counts = new Map();
    for (const e of this.data.employees) {
      if (this.empStatus(e) === 'resigned') continue;
      // priority 1: position.scope
      const pos = e.position ? this.getPosition(e.position) : null;
      let scopeId = pos?.scope || null;
      // priority 2: dept.scope (fallback)
      if (!scopeId && e.department) {
        const dept = this.getDepartment(e.department);
        if (dept?.scope) scopeId = dept.scope;
      }
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
    for (const e of this._filterByPositionScope(this.data.employees, scope)) {
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
    for (const e of this._filterByPositionScope(this.data.employees, scope)) {
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

    for (const e of this._filterByPositionScope(this.data.employees, scope)) {
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
      Number(e.allowancePhone || 0) +
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
    const emps = this._filterByPositionScope(this.getEmployees(), scope);
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
  },

  // ═══════════════════════════════════════════════════════════
  // WORK SCHEDULE (ตารางงานพนักงาน) — กะ + ตารางรายสัปดาห์ + อนุมัติ
  // ═══════════════════════════════════════════════════════════

  _shiftFromDB: (r) => ({
    id: r.id,
    code: r.code || '',
    name: r.name || '',
    startTime: r.start_time || '',     // 'HH:MM:SS' จาก Postgres TIME — UI ตัดเป็น HH:MM เอง
    endTime: r.end_time || '',
    breakMinutes: Number(r.break_minutes || 0),
    color: r.color || '#2563eb',
    isOffDay: r.is_off_day === true,
    employeeTypes: Array.isArray(r.employee_types) ? r.employee_types : [],
    branchId: r.branch_id || '',
    active: r.active !== false,
    sortOrder: Number(r.sort_order || 100),
    note: r.note || ''
  }),
  _shiftToDB: (s) => ({
    code: String(s.code || '').trim().toUpperCase(),
    name: s.name || '',
    start_time: s.startTime || null,
    end_time: s.endTime || null,
    break_minutes: Number(s.breakMinutes || 0),
    color: s.color || '#2563eb',
    is_off_day: s.isOffDay === true,
    employee_types: Array.isArray(s.employeeTypes) ? s.employeeTypes : [],
    branch_id: s.branchId || null,
    active: s.active !== false,
    sort_order: Number(s.sortOrder || 100),
    note: s.note || null
  }),

  _schedWeekFromDB: (r) => ({
    id: r.id,
    branchId: r.branch_id,
    weekStart: r.week_start,
    status: r.status || 'draft',
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    approverNote: r.approver_note || '',
    rejectedAt: r.rejected_at,
    rejectReason: r.reject_reason || '',
    notes: r.notes || '',
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }),
  _schedWeekToDB: (w) => ({
    branch_id: w.branchId,
    week_start: w.weekStart,
    status: w.status || 'draft',
    notes: w.notes || null
  }),

  _schedEntryFromDB: (r) => ({
    id: r.id,
    scheduleWeekId: r.schedule_week_id,
    employeeId: r.employee_id,
    workDate: r.work_date,
    shiftId: r.shift_id || null,
    branchId: r.branch_id || '',
    isCrossBranch: r.is_cross_branch === true,
    note: r.note || '',
    // กะกำหนดเอง — สำหรับ PT ที่ความยาวกะไม่ตายตัว
    customStartTime: r.custom_start_time || '',
    customEndTime: r.custom_end_time || '',
    customBreakMinutes: Number(r.custom_break_minutes || 0),
    customLabel: r.custom_label || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }),
  _schedEntryToDB: (e) => ({
    schedule_week_id: e.scheduleWeekId,
    employee_id: e.employeeId,
    work_date: e.workDate,
    shift_id: e.shiftId || null,
    branch_id: e.branchId || null,
    is_cross_branch: e.isCrossBranch === true,
    note: e.note || null,
    custom_start_time: e.customStartTime || null,
    custom_end_time: e.customEndTime || null,
    custom_break_minutes: Number(e.customBreakMinutes || 0),
    custom_label: e.customLabel || null
  }),

  // ─── SHIFT MASTER (HR CRUD) ───
  getShifts({ branchId = null, activeOnly = false, employeeType = null } = {}) {
    let list = (this.data.shifts || []).slice();
    if (activeOnly) list = list.filter(s => s.active);
    if (branchId) list = list.filter(s => !s.branchId || s.branchId === branchId);
    if (employeeType) list = list.filter(s =>
      !s.employeeTypes?.length || s.employeeTypes.includes(employeeType)
    );
    return list.sort((a, b) => (a.sortOrder - b.sortOrder) || a.code.localeCompare(b.code));
  },
  getShift(id) { return (this.data.shifts || []).find(s => s.id === id); },
  getShiftByCode(code) {
    if (!code) return null;
    const up = String(code).toUpperCase();
    return (this.data.shifts || []).find(s => s.code === up);
  },

  async saveShift(shift) {
    if (!this.isHR) throw new Error('ต้องเป็น HR หรือ admin เท่านั้นที่จัดการกะได้');
    const row = this._shiftToDB(shift);
    if (shift.id) row.id = shift.id;
    if (!row.code) throw new Error('ระบุรหัสกะ (Shift Code)');
    if (!row.name) throw new Error('ระบุชื่อกะ');
    if (!row.is_off_day && (!row.start_time || !row.end_time)) {
      throw new Error('กะที่ไม่ใช่วันหยุดต้องมีเวลาเริ่ม-สิ้นสุด');
    }
    const { data, error } = await this.client.from('shifts').upsert(row, { onConflict: 'code' }).select().single();
    if (error) throw error;
    const mapped = this._shiftFromDB(data);
    const idx = this.data.shifts.findIndex(s => s.id === mapped.id);
    if (idx >= 0) this.data.shifts[idx] = mapped;
    else this.data.shifts.push(mapped);
    return mapped;
  },

  async deleteShift(id) {
    if (!this.isHR) throw new Error('ต้องเป็น HR หรือ admin');
    // ตรวจว่ามี entry อ้างถึงไหม — กันลบกะที่ใช้ในตารางอยู่
    const used = (this.data.scheduleEntries || []).some(e => e.shiftId === id);
    if (used) {
      throw new Error('กะนี้ถูกใช้ในตารางงานอยู่ — ตั้ง "ปิดใช้งาน" แทนการลบเพื่อรักษาประวัติ');
    }
    const { error } = await this.client.from('shifts').delete().eq('id', id);
    if (error) throw error;
    this.data.shifts = this.data.shifts.filter(s => s.id !== id);
  },

  // ─── SCHEDULE WEEK ───
  // หา week ของสาขา/สัปดาห์นั้น — สร้าง draft ใหม่ถ้ายังไม่มี (lazy create)
  getScheduleWeek(branchId, weekStart) {
    if (!branchId || !weekStart) return null;
    return (this.data.scheduleWeeks || []).find(w => w.branchId === branchId && w.weekStart === weekStart) || null;
  },

  getScheduleWeeks({ branchId = null, status = null, _noScope = false } = {}) {
    let list = (this.data.scheduleWeeks || []).slice();
    if (branchId) list = list.filter(w => w.branchId === branchId);
    if (status) list = list.filter(w => w.status === status);
    if (!_noScope && this.role) {
      if (this.role === 'branch_manager' || this.role === 'area_manager') {
        const scoped = this.scopedBranches() || [];
        list = list.filter(w => scoped.includes(w.branchId));
      } else if (this.role === 'branch_staff' || this.role === 'viewer') {
        const myBranch = this._myBranch();
        list = myBranch ? list.filter(w => w.branchId === myBranch) : [];
      }
    }
    return list.sort((a, b) => (b.weekStart || '').localeCompare(a.weekStart || ''));
  },

  // สร้าง draft week ถ้ายังไม่มี — เรียกเมื่อ user เปิดสัปดาห์ใหม่ที่ยังไม่เคยมี
  async ensureScheduleWeek(branchId, weekStart) {
    if (!branchId || !weekStart) throw new Error('ต้องระบุสาขาและสัปดาห์');
    const existing = this.getScheduleWeek(branchId, weekStart);
    if (existing) return existing;
    // ตรวจสิทธิ์ — HR override ได้, manager เฉพาะสาขาตัวเอง
    if (!this.isHR && !this._canEditScheduleForBranch(branchId)) {
      throw new Error('คุณไม่มีสิทธิ์สร้างตารางของสาขานี้');
    }
    const row = this._schedWeekToDB({ branchId, weekStart, status: 'draft' });
    if (this.user?.id) row.created_by = this.user.id;
    const { data, error } = await this.client.from('schedule_weeks').upsert(row, { onConflict: 'branch_id,week_start' }).select().single();
    if (error) throw error;
    const mapped = this._schedWeekFromDB(data);
    const idx = this.data.scheduleWeeks.findIndex(w => w.id === mapped.id);
    if (idx >= 0) this.data.scheduleWeeks[idx] = mapped;
    else this.data.scheduleWeeks.unshift(mapped);
    return mapped;
  },

  // เดิม: branch_manager + area_manager + HR + op_manager แก้ได้
  // ใหม่: เฉพาะ "ตำแหน่งสูงสุดของสาขา" (= branch top emp) + HR/admin/op override
  // → ใช้สำหรับ saveScheduleEntry, submit, ensureScheduleWeek
  _canEditScheduleForBranch(branchId) {
    return this.canCreateScheduleForBranch(branchId);
  },

  // ผู้สร้าง/ส่งตาราง: user_profile.role='branch_manager' ที่ดูแลสาขานี้
  // - managed_branches override (admin ตั้ง) → ใช้ตามนั้น
  // - ไม่มี override → ใช้ emp.branch ของตัวเอง
  // - HR/admin/op_manager override ได้
  canCreateScheduleForBranch(branchId) {
    if (this.isHR) return true;
    if (this.role === 'operation_manager') return true;
    if (this.role !== 'branch_manager') return false;
    if (!branchId) return false;
    const managed = (this._managedBranches && this._managedBranches.length)
      ? this._managedBranches
      : (this._myBranch() ? [this._myBranch()] : []);
    return managed.includes(branchId);
  },

  // โหลดรายชื่อพนักงานทุกสาขา (ผ่าน RPC SECURITY DEFINER — bypass RLS scope)
  // ใช้สำหรับ feature "เพิ่มพนักงานข้ามสาขา" — ผู้จัดการสาขาเห็นได้
  // เฉพาะข้อมูล non-sensitive (id/ชื่อ/สาขา/ตำแหน่ง)
  async fetchCrossBranchRoster() {
    if (this._crossBranchRoster) return this._crossBranchRoster;
    const { data, error } = await this.client.rpc('list_employees_for_cross_branch');
    if (error) {
      console.warn('list_employees_for_cross_branch failed:', error);
      // fallback ใช้ cache เดิม (จะได้แค่สาขาตัวเอง)
      return (this.data.employees || []).filter(e => this.empStatus(e) !== 'resigned');
    }
    this._crossBranchRoster = (data || []).map(r => ({
      id: r.id,
      firstName: r.first_name || '',
      lastName: r.last_name || '',
      nickname: r.nickname || '',
      branch: r.branch || '',
      department: r.department || '',
      position: r.position_id || '',  // RPC คืนเป็น position_id (เพราะ "position" reserved word ใน RETURNS TABLE)
      positionTitle: r.position_title || '',
      employeeType: r.employee_type || '',
      hireDate: r.hire_date || ''
    }));
    return this._crossBranchRoster;
  },

  // คืน list ของพนักงานที่มีสิทธิ์จัดตารางของสาขา (สำหรับแสดงใน UI)
  getScheduleCreators(branchId) {
    if (!branchId) return [];
    const profiles = this._userProfiles || [];
    const matched = profiles.filter(p => {
      if (p.role !== 'branch_manager' || !p.employee_id) return false;
      const e = this.getEmployee(p.employee_id);
      if (!e || this.empStatus(e) === 'resigned') return false;
      // managed_branches override → ใช้ตามนั้น; ไม่งั้น emp.branch
      if (Array.isArray(p.managed_branches) && p.managed_branches.length) {
        return p.managed_branches.includes(branchId);
      }
      return e.branch === branchId;
    });
    return matched.map(p => this.getEmployee(p.employee_id)).filter(Boolean);
  },

  // ผู้อนุมัติตาราง: AM (area_manager) ที่ดูแลสาขานั้น
  canApproveScheduleForBranch(branchId) {
    if (this.isHR) return true;
    if (!branchId) return false;
    if (this.role !== 'area_manager') return false;
    // managed_branches override → ใช้ตามนั้น; ถ้าไม่มี → สาขาของตัวเอง
    const myBranch = this._myBranch();
    const managed = (this._managedBranches && this._managedBranches.length)
      ? this._managedBranches
      : (myBranch ? [myBranch] : []);
    return managed.includes(branchId);
  },

  // หา AM ที่ดูแลสาขา (สำหรับแสดงในหน้า "ผู้อนุมัติ")
  getScheduleApprover(branchId) {
    if (!branchId) return null;
    const profiles = this._userProfiles || [];
    const ams = profiles.filter(p =>
      p.role === 'area_manager' && p.employee_id &&
      Array.isArray(p.managed_branches) && p.managed_branches.includes(branchId)
    ).sort((a, b) => (a.employee_id < b.employee_id ? -1 : 1));
    for (const am of ams) {
      const e = this.getEmployee(am.employee_id);
      if (e && this.empStatus(e) !== 'resigned') return e;
    }
    // fallback: HR คนแรก
    const hrs = profiles.filter(p => p.role === 'hr' && p.employee_id)
      .sort((a, b) => (a.employee_id < b.employee_id ? -1 : 1));
    for (const h of hrs) {
      const e = this.getEmployee(h.employee_id);
      if (e && this.empStatus(e) !== 'resigned') return e;
    }
    return null;
  },

  // ─── SCHEDULE ENTRIES ───
  getScheduleEntries({ weekId = null, employeeId = null, dateFrom = null, dateTo = null } = {}) {
    let list = (this.data.scheduleEntries || []).slice();
    if (weekId) list = list.filter(e => e.scheduleWeekId === weekId);
    if (employeeId) list = list.filter(e => e.employeeId === employeeId);
    if (dateFrom) list = list.filter(e => e.workDate >= dateFrom);
    if (dateTo) list = list.filter(e => e.workDate <= dateTo);
    return list;
  },

  // [Echo suppression] ติดตาม schedule change ที่ user คนนี้เพิ่งเขียนเอง
  // ใช้เพื่อให้ realtime handler ไม่แจ้งซ้ำ (echo) ของเปลี่ยนแปลงที่ user ทำเอง
  _recentSelfSchedWrites: new Map(),  // key: "weekId|empId|date" → timestamp ms
  isRecentSelfSchedWrite(weekId, empId, workDate) {
    const k = `${weekId}|${empId}|${workDate}`;
    const ts = this._recentSelfSchedWrites.get(k);
    if (!ts) return false;
    // ผ่านมา < 5 วินาที = ยังถือว่า echo
    return (Date.now() - ts) < 5000;
  },
  _markSelfSchedWrite(weekId, empId, workDate) {
    const k = `${weekId}|${empId}|${workDate}`;
    this._recentSelfSchedWrites.set(k, Date.now());
    // cleanup entries เก่ากว่า 30s — กันโตเรื่อยๆ
    if (this._recentSelfSchedWrites.size > 100) {
      const cutoff = Date.now() - 30000;
      for (const [key, t] of this._recentSelfSchedWrites) {
        if (t < cutoff) this._recentSelfSchedWrites.delete(key);
      }
    }
  },

  async saveScheduleEntry(entry) {
    const week = (this.data.scheduleWeeks || []).find(w => w.id === entry.scheduleWeekId);
    if (!week) throw new Error('ไม่พบสัปดาห์ — กรุณารีโหลด');
    if (!this._canEditScheduleForBranch(week.branchId)) {
      throw new Error('คุณไม่มีสิทธิ์แก้ไขตารางของสาขานี้');
    }
    if (week.status === 'approved' && !this.isHR) {
      throw new Error('ตารางอนุมัติแล้ว — ต้องให้ AM ที่ดูแลสาขา (หรือ HR/admin) "เปิดให้แก้ไข" ก่อน');
    }
    // ห้ามจัด/แก้กะวันที่ผ่านมาแล้ว — HR/admin override ได้
    if (entry.workDate && entry.workDate < this.todayBkk() && !this.isHR) {
      throw new Error('ห้ามจัดหรือแก้กะวันที่ผ่านมาแล้ว · HR/admin เท่านั้นที่ override ได้');
    }
    const row = this._schedEntryToDB(entry);
    if (entry.id) row.id = entry.id;
    // [Echo suppression] mark ก่อนยิง upsert — กัน realtime echo
    this._markSelfSchedWrite(entry.scheduleWeekId, entry.employeeId, entry.workDate);
    const { data, error } = await this.client.from('schedule_entries')
      .upsert(row, { onConflict: 'schedule_week_id,employee_id,work_date' })
      .select().single();
    if (error) throw error;
    const mapped = this._schedEntryFromDB(data);
    const idx = this.data.scheduleEntries.findIndex(e => e.id === mapped.id);
    if (idx >= 0) this.data.scheduleEntries[idx] = mapped;
    else this.data.scheduleEntries.push(mapped);
    // ถ้า week เป็น approved/submitted → bump กลับ draft (เพราะมีการแก้ไข) — เฉพาะ HR เท่านั้น
    if (this.isHR && (week.status === 'approved' || week.status === 'rejected')) {
      await this._setScheduleWeekStatus(week.id, 'draft', { note: 'HR แก้ไขหลังอนุมัติ' });
    }
    return mapped;
  },

  async deleteScheduleEntry(id) {
    const entry = (this.data.scheduleEntries || []).find(e => e.id === id);
    if (!entry) return;
    const week = (this.data.scheduleWeeks || []).find(w => w.id === entry.scheduleWeekId);
    if (week && !this._canEditScheduleForBranch(week.branchId)) {
      throw new Error('คุณไม่มีสิทธิ์แก้ไขตารางของสาขานี้');
    }
    if (week && week.status === 'approved' && !this.isHR) {
      throw new Error('ตารางอนุมัติแล้ว — ต้องให้ AM ที่ดูแลสาขา (หรือ HR/admin) "เปิดให้แก้ไข" ก่อน');
    }
    if (entry.workDate && entry.workDate < this.todayBkk() && !this.isHR) {
      throw new Error('ห้ามลบกะวันที่ผ่านมาแล้ว · HR/admin เท่านั้นที่ override ได้');
    }
    const { error } = await this.client.from('schedule_entries').delete().eq('id', id);
    if (error) throw error;
    this.data.scheduleEntries = this.data.scheduleEntries.filter(e => e.id !== id);
  },

  // ─── WORKFLOW (submit / approve / reject / reopen) ───
  async _setScheduleWeekStatus(weekId, status, extra = {}) {
    const patch = { status, ...extra };
    const { data, error } = await this.client.from('schedule_weeks').update(patch).eq('id', weekId).select().single();
    if (error) throw error;
    const mapped = this._schedWeekFromDB(data);
    const idx = this.data.scheduleWeeks.findIndex(w => w.id === weekId);
    if (idx >= 0) this.data.scheduleWeeks[idx] = mapped;
    return mapped;
  },

  // ─── CROSS-BRANCH BORROW REQUESTS (Phase 3 Level 3 workflow) ───
  _borrowFromDB(r) {
    return {
      id: r.id,
      employeeId: r.employee_id,
      sourceBranchId: r.source_branch_id,
      destinationBranchId: r.destination_branch_id,
      workDates: Array.isArray(r.work_dates) ? r.work_dates : [],
      reason: r.reason || '',
      status: r.status,
      autoApproved: r.auto_approved === true,
      requestedBy: r.requested_by,
      requestedAt: r.requested_at,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      approverNote: r.approver_note || '',
      rejectReason: r.reject_reason || '',
      cancelledAt: r.cancelled_at,
      cancelReason: r.cancel_reason || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  },

  async loadBorrowRequests() {
    const { data, error } = await this.client
      .from('cross_branch_borrow_requests')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('loadBorrowRequests failed:', error);
      this.data.borrowRequests = [];
      return [];
    }
    this.data.borrowRequests = (data || []).map(this._borrowFromDB);
    return this.data.borrowRequests;
  },

  // คืนคำขอที่เกี่ยวข้องกับ user ปัจจุบัน (filtered by RLS แล้ว)
  getBorrowRequests({ status = null, sourceBranch = null, destBranch = null, employeeId = null } = {}) {
    let list = this.data.borrowRequests || [];
    if (status) list = list.filter(r => r.status === status);
    if (sourceBranch) list = list.filter(r => r.sourceBranchId === sourceBranch);
    if (destBranch) list = list.filter(r => r.destinationBranchId === destBranch);
    if (employeeId) list = list.filter(r => r.employeeId === employeeId);
    return list;
  },

  // เช็คว่ามี approved borrow request ที่ครอบคลุม emp + date + branch ไหม
  hasApprovedBorrowFor(employeeId, destinationBranchId, workDate) {
    return (this.data.borrowRequests || []).some(r =>
      r.status === 'approved' &&
      r.employeeId === employeeId &&
      r.destinationBranchId === destinationBranchId &&
      r.workDates.includes(workDate)
    );
  },

  async createBorrowRequest({ employeeId, destinationBranchId, workDates, reason }) {
    if (!employeeId || !destinationBranchId || !Array.isArray(workDates) || !workDates.length) {
      throw new Error('ข้อมูลคำขอไม่ครบ — ต้องมี employee_id, destination_branch_id, work_dates');
    }
    const { data, error } = await this.client.rpc('create_borrow_request', {
      p_employee_id: employeeId,
      p_destination_branch_id: destinationBranchId,
      p_work_dates: workDates,
      p_reason: reason || null
    });
    if (error) throw error;
    // reload list (RLS อาจให้เห็นคำขอนี้ทันที + auto-approved status)
    await this.loadBorrowRequests();
    return data;   // { id, status, auto_approved, message }
  },

  async reviewBorrowRequest(requestId, decision, note = '') {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error('decision ต้องเป็น approved หรือ rejected');
    }
    const { data, error } = await this.client.rpc('review_borrow_request', {
      p_request_id: requestId,
      p_decision: decision,
      p_note: note || null
    });
    if (error) throw error;
    // update local cache
    const idx = (this.data.borrowRequests || []).findIndex(r => r.id === requestId);
    if (idx >= 0) {
      this.data.borrowRequests[idx].status = decision;
      this.data.borrowRequests[idx].reviewedAt = new Date().toISOString();
      this.data.borrowRequests[idx].reviewedBy = this.user?.id || null;
      if (decision === 'approved') this.data.borrowRequests[idx].approverNote = note;
      else this.data.borrowRequests[idx].rejectReason = note;
    }
    return data;
  },

  async cancelBorrowRequest(requestId, reason = '') {
    const { data, error } = await this.client.rpc('cancel_borrow_request', {
      p_request_id: requestId,
      p_reason: reason || null
    });
    if (error) throw error;
    const idx = (this.data.borrowRequests || []).findIndex(r => r.id === requestId);
    if (idx >= 0) {
      this.data.borrowRequests[idx].status = 'cancelled';
      this.data.borrowRequests[idx].cancelledAt = new Date().toISOString();
      this.data.borrowRequests[idx].cancelReason = reason;
    }
    return data;
  },

  async submitScheduleWeek(weekId) {
    const week = (this.data.scheduleWeeks || []).find(w => w.id === weekId);
    if (!week) throw new Error('ไม่พบสัปดาห์');
    if (!this.canCreateScheduleForBranch(week.branchId)) {
      throw new Error('เฉพาะตำแหน่งสูงสุดของสาขา (หรือ HR/admin) เท่านั้นที่ส่งขออนุมัติได้');
    }
    const entries = (this.data.scheduleEntries || []).filter(e => e.scheduleWeekId === weekId);
    if (!entries.length) throw new Error('ยังไม่ได้กรอกตารางใดๆ — กรอกกะอย่างน้อย 1 ช่องก่อนส่ง');
    return this._setScheduleWeekStatus(weekId, 'submitted', {
      submitted_by: this.user?.id || null,
      submitted_at: new Date().toISOString(),
      rejected_at: null,
      reject_reason: null
    });
  },

  async approveScheduleWeek(weekId, note = '') {
    const week = (this.data.scheduleWeeks || []).find(w => w.id === weekId);
    if (!week) throw new Error('ไม่พบสัปดาห์');
    if (!this.canApproveScheduleForBranch(week.branchId)) {
      throw new Error('เฉพาะ Area Manager ที่ดูแลสาขานี้ (หรือ HR/admin) ที่อนุมัติได้');
    }
    return this._setScheduleWeekStatus(weekId, 'approved', {
      approved_by: this.user?.id || null,
      approved_at: new Date().toISOString(),
      approver_note: note || null,
      rejected_at: null,
      reject_reason: null
    });
  },

  async rejectScheduleWeek(weekId, reason = '') {
    const week = (this.data.scheduleWeeks || []).find(w => w.id === weekId);
    if (!week) throw new Error('ไม่พบสัปดาห์');
    if (!this.canApproveScheduleForBranch(week.branchId)) {
      throw new Error('เฉพาะ Area Manager ที่ดูแลสาขานี้ (หรือ HR/admin) ที่ปฏิเสธได้');
    }
    return this._setScheduleWeekStatus(weekId, 'rejected', {
      rejected_at: new Date().toISOString(),
      reject_reason: reason || null,
      approved_by: null,
      approved_at: null
    });
  },

  // เปิดให้แก้ไขตารางที่อนุมัติแล้ว → bump กลับเป็น draft
  // AM ที่ดูแลสาขานั้น หรือ HR/admin เปิดได้
  async reopenScheduleWeek(weekId) {
    const week = (this.data.scheduleWeeks || []).find(w => w.id === weekId);
    if (!week) throw new Error('ไม่พบสัปดาห์');
    if (!this.canApproveScheduleForBranch(week.branchId)) {
      throw new Error('เฉพาะ Area Manager ที่ดูแลสาขานี้ (หรือ HR/admin) ที่เปิดให้แก้ไขได้');
    }
    return this._setScheduleWeekStatus(weekId, 'draft', {
      approved_by: null, approved_at: null, approver_note: null,
      submitted_by: null, submitted_at: null,
      rejected_at: null, reject_reason: null
    });
  },

  // ─── HELPERS — เอาไว้ render grid ───
  // คืน leave + วันหยุดประเพณีในช่วงสัปดาห์ → UI overlay บน cell
  getLeavesInRange(employeeIds, dateFrom, dateTo) {
    const ids = new Set(employeeIds || []);
    return (this.data.leaveRequests || []).filter(r =>
      ids.has(r.employeeId)
      && r.status === 'approved'
      && r.startDate <= dateTo
      && r.endDate >= dateFrom
    );
  },

  getHolidaysInRange(dateFrom, dateTo) {
    return (this.data.calendar || []).filter(c => c.date >= dateFrom && c.date <= dateTo);
  },

  // คำนวณชั่วโมงทำงานของพนักงานในสัปดาห์ — สำหรับสรุปท้ายตาราง
  // รองรับทั้ง shift master + custom shift (PT เวลาไม่ตายตัว)
  calcScheduleHours(weekId, employeeId) {
    const entries = (this.data.scheduleEntries || []).filter(e =>
      e.scheduleWeekId === weekId && e.employeeId === employeeId
    );
    let totalMins = 0;
    let offDays = 0;
    let shiftCount = 0;
    for (const e of entries) {
      // กะกำหนดเอง (custom) — ไม่มี shift_id แต่มี customStartTime
      if (!e.shiftId && e.customStartTime && e.customEndTime) {
        const [sh1, sm1] = e.customStartTime.split(':').map(Number);
        const [sh2, sm2] = e.customEndTime.split(':').map(Number);
        let mins = (sh2 * 60 + sm2) - (sh1 * 60 + sm1);
        if (mins < 0) mins += 24 * 60;
        mins -= Number(e.customBreakMinutes || 0);
        if (mins > 0) totalMins += mins;
        shiftCount++;
        continue;
      }
      if (!e.shiftId) continue;
      const sh = this.getShift(e.shiftId);
      if (!sh) continue;
      shiftCount++;
      if (sh.isOffDay) { offDays++; continue; }
      if (!sh.startTime || !sh.endTime) continue;
      const [sh1, sm1] = sh.startTime.split(':').map(Number);
      const [sh2, sm2] = sh.endTime.split(':').map(Number);
      let mins = (sh2 * 60 + sm2) - (sh1 * 60 + sm1);
      if (mins < 0) mins += 24 * 60;
      mins -= Number(sh.breakMinutes || 0);
      if (mins > 0) totalMins += mins;
    }
    return { hours: +(totalMins / 60).toFixed(2), offDays, shiftCount };
  },

  // [Feature] สรุปตารางงานรายเดือน — ใช้ที่หน้า "รายงานเดือน"
  // นับ entries ทุก week ที่ overlap กับเดือนนั้น
  // คืน: { hours, shiftCount, offDays, leaveDays, holidayDays }
  calcScheduleMonthSummary(branchId, year, month, employeeId) {
    // เดือน range: 1 ถึงสิ้นเดือน
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate(); // last day of month
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    // 1) Filter entries: ของ employee + อยู่ในเดือน + branchId ตรง (หรือไม่มี branchId แต่ week branch ตรง)
    const weekIdsOfBranch = new Set(
      (this.data.scheduleWeeks || [])
        .filter(w => w.branchId === branchId)
        .map(w => w.id)
    );
    const entries = (this.data.scheduleEntries || []).filter(e =>
      e.employeeId === employeeId &&
      e.workDate >= monthStart && e.workDate <= monthEnd &&
      (e.branchId === branchId || (!e.branchId && weekIdsOfBranch.has(e.scheduleWeekId)))
    );

    // 2) คำนวณ hours/shifts/off — reuse logic เดียวกับ calcScheduleHours
    let totalMins = 0;
    let offDays = 0;
    let shiftCount = 0;
    for (const e of entries) {
      if (!e.shiftId && e.customStartTime && e.customEndTime) {
        const [sh1, sm1] = e.customStartTime.split(':').map(Number);
        const [sh2, sm2] = e.customEndTime.split(':').map(Number);
        let mins = (sh2 * 60 + sm2) - (sh1 * 60 + sm1);
        if (mins < 0) mins += 24 * 60;
        mins -= Number(e.customBreakMinutes || 0);
        if (mins > 0) totalMins += mins;
        shiftCount++;
        continue;
      }
      if (!e.shiftId) continue;
      const sh = this.getShift(e.shiftId);
      if (!sh) continue;
      shiftCount++;
      if (sh.isOffDay) { offDays++; continue; }
      if (!sh.startTime || !sh.endTime) continue;
      const [sh1, sm1] = sh.startTime.split(':').map(Number);
      const [sh2, sm2] = sh.endTime.split(':').map(Number);
      let mins = (sh2 * 60 + sm2) - (sh1 * 60 + sm1);
      if (mins < 0) mins += 24 * 60;
      mins -= Number(sh.breakMinutes || 0);
      if (mins > 0) totalMins += mins;
    }

    // 3) นับวันลาในเดือน (status=approved + overlap เดือน)
    let leaveDays = 0;
    for (const lv of (this.data.leaveRequests || [])) {
      if (lv.employeeId !== employeeId || lv.status !== 'approved') continue;
      const s = lv.startDate > monthStart ? lv.startDate : monthStart;
      const ed = lv.endDate < monthEnd ? lv.endDate : monthEnd;
      if (s > ed) continue;
      const ms = new Date(s).getTime();
      const me = new Date(ed).getTime();
      leaveDays += Math.round((me - ms) / 86400000) + 1;
    }

    // 4) นับวันหยุดประเพณีในเดือน (info — ไม่ลบจาก hours)
    const holidayDays = (this.data.calendarItems || []).filter(c =>
      c.type === 'holiday' && c.date >= monthStart && c.date <= monthEnd
    ).length;

    return {
      hours: +(totalMins / 60).toFixed(2),
      shiftCount,
      offDays,
      leaveDays,
      holidayDays,
      monthStart,
      monthEnd
    };
  }
};
