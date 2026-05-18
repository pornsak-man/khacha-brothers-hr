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
    leaveTypes: []
  },

  // ─── INDEX CACHES (O(1) lookup; rebuild lazily after data change) ───
  _empIndex: null,
  _deptIndex: null,
  _posIndex: null,
  _invalidateIndex(table) {
    if (table === 'employees' || !table) this._empIndex = null;
    if (table === 'departments' || !table) this._deptIndex = null;
    if (table === 'position_levels' || !table) this._posIndex = null;
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
      await this.loadProfile();
      await this.loadAll();
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

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
    await this.loadProfile();
    await this.loadAll();
    this.subscribeRealtime();
    this.ready = true;
    return data.user;
  },

  async signOut() {
    await this.client.auth.signOut();
    this.user = null;
    this.profile = null;
    this.isAdmin = false;
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
  // ใช้เมื่อ admin กดปุ่ม "auto-detect" ในหน้า User Management
  // คืน role ที่ derived; null ถ้าไม่ match (เรียกใช้แล้ว default เป็น branch_staff)
  autoDetectRole(employee) {
    if (!employee) return null;
    const title = (employee.positionTitle || '').toLowerCase();
    const dept  = (employee.department || '').toUpperCase();
    // HR: department = ฝ่ายบุคคล หรือ title มี HR/บุคคล/human resource
    if (dept === 'D002' || /hr|บุคคล|human\s*resource/i.test(title)) return 'hr';
    // Operation Manager
    if (/operation\s*(manager|มง|mng)?|ผู้จัดการ.*ปฏิบัติการ|om\b/i.test(title)) return 'operation_manager';
    // Area Manager
    if (/area\s*(manager|มง|mng)?|ผู้จัดการ.*เขต|am\b/i.test(title)) return 'area_manager';
    // Branch Manager
    if (/branch\s*(manager|มง|mng)?|store\s*manager|ผู้จัดการ(สาขา|ร้าน)|bm\b/i.test(title)) return 'branch_manager';
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

  async loadAll() {
    // ตารางเล็ก / คงที่ — single query พอ
    const [deps, pos, cal, comp] = await Promise.all([
      this.client.from('departments').select('*').order('id'),
      this.client.from('position_levels').select('*').order('id'),
      this.client.from('calendar_items').select('*').order('date'),
      this.client.from('company_settings').select('*').eq('id', 1).maybeSingle()
    ]);
    // ตารางที่อาจมีเกิน 1000 records — ดึงด้วย pagination
    const [emps, loans, advs, allow, evals, sal, appls, uniItems, uniReqs, uniIssues, uniSched, branchRows, leaves, lvTypes] = await Promise.all([
      this._fetchAllPages('employees', 'id', true),
      this._fetchAllPages('loans', 'date', false),
      this._fetchAllPages('advances', 'date', false),
      this._fetchAllPages('allowances', 'month', false),
      this._fetchAllPages('evaluations', 'date', false),
      this._fetchAllPages('salary_history', 'date', false),
      this._fetchAllPages('applicants', 'applied_date', false).catch(() => []),  // legacy DB อาจยังไม่มี
      this._fetchAllPages('uniform_items', 'name', true).catch(() => []),
      this._fetchAllPages('uniform_requests', 'requested_date', false).catch(() => []),
      this._fetchAllPages('uniform_issues', 'issued_date', false).catch(() => []),
      this._fetchAllPages('uniform_delivery_schedule', 'branch_code', true).catch(() => []),
      this._fetchAllPages('branches', 'id', true).catch(() => []),
      this._fetchAllPages('leave_requests', 'start_date', false).catch(() => []),
      this._fetchAllPages('leave_types', 'sort_order', true).catch(() => [])
    ]);
    this.data.departments = (deps.data || []).map(this._depFromDB);
    this.data.positionLevels = (pos.data || []).map(this._posFromDB);
    this.data.employees = emps.map(this._empFromDB);
    this.data.loans = loans.map(this._loanFromDB);
    this.data.advances = advs.map(this._advFromDB);
    this.data.allowances = allow.map(this._allowFromDB);
    this.data.evaluations = evals.map(this._evalFromDB);
    this.data.salaryHistory = sal.map(this._salFromDB);
    this.data.calendar = (cal.data || []).map(this._calFromDB);
    this.data.applicants = (appls || []).map(this._applFromDB);
    this.data.uniformItems = (uniItems || []).map(this._uniItemFromDB);
    this.data.uniformRequests = (uniReqs || []).map(this._uniReqFromDB);
    this.data.uniformIssues = (uniIssues || []).map(this._uniIssueFromDB);
    this.data.uniformSchedule = (uniSched || []).map(this._uniSchedFromDB);
    this.data.branches = (branchRows || []).map(this._branchFromDB);
    this.data.leaveRequests = (leaves || []).map(this._leaveFromDB);
    this.data.leaveTypes = (lvTypes || []).map(this._leaveTypeFromDB);
    if (comp.data) this.data.company = this._compFromDB(comp.data);
    this._invalidateIndex();
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
    const map = {
      employees: { list: 'employees', from: this._empFromDB },
      departments: { list: 'departments', from: this._depFromDB },
      position_levels: { list: 'positionLevels', from: this._posFromDB },
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
      leave_types: { list: 'leaveTypes', from: this._leaveTypeFromDB }
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
  _empFromDB: (r) => ({
    id: r.id, title: r.title || '', firstName: r.first_name, lastName: r.last_name,
    nickname: r.nickname || '', nationalId: r.national_id || '',
    dob: r.dob || '', gender: r.gender || '',
    nationality: r.nationality || 'ไทย', religion: r.religion || '',
    education: r.education || '',
    phone: r.phone || '', email: r.email || '', address: r.address || '',
    subDistrict: r.sub_district || '', district: r.district || '',
    province: r.province || '', postalCode: r.postal_code || '',
    department: r.department || '', branch: r.branch || '',
    position: r.position || '', positionTitle: r.position_title || '',
    employeeType: r.employee_type || '',
    hireDate: r.hire_date || '', salary: Number(r.salary || 0),
    allowancePosition: Number(r.allowance_position || 0),
    allowanceTravel: Number(r.allowance_travel || 0),
    allowanceFood: Number(r.allowance_food || 0),
    allowancePerDiem: Number(r.allowance_per_diem || 0),
    allowanceLanguage: Number(r.allowance_language || 0),
    allowanceOther: Number(r.allowance_other || 0),
    bank: r.bank || '', bankAccount: r.bank_account || '',
    passportNumber: r.passport_number || '',
    workPermitNumber: r.work_permit_number || '',
    photoUrl: r.photo_url || '',
    terminationDate: r.termination_date || '',
    terminationReason: r.termination_reason || '',
    terminationNote: r.termination_note || '',
    ssoNo: r.sso_no || '',
    ssoEnrolledDate: r.sso_enrolled_date || '',
    ssoTerminatedDate: r.sso_terminated_date || '',
    ssoHospital: r.sso_hospital || '',
    status: r.status || 'active', note: r.note || ''
  }),
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
  _depFromDB: (r) => ({ id: r.id, name: r.name, manager: r.manager_id || '', note: r.note || '' }),
  _depToDB: (d) => ({ id: d.id, name: d.name, manager_id: d.manager || null, note: d.note }),
  _posFromDB: (r) => ({ id: r.id, name: r.name, level: Number(r.level || 0), minSalary: Number(r.min_salary || 0), maxSalary: Number(r.max_salary || 0) }),
  _posToDB: (p) => ({ id: p.id, name: p.name, level: Number(p.level || 0), min_salary: Number(p.minSalary || 0), max_salary: Number(p.maxSalary || 0) }),
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
  _calFromDB: (r) => ({ id: r.id, date: r.date, title: r.title, type: r.type || 'holiday' }),
  _calToDB: (c) => ({ date: c.date, title: c.title, type: c.type }),
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
  empStatus(emp) {
    if (!emp.terminationDate) {
      // Fallback: ข้อมูล legacy ที่ import มามี status='resigned' แต่ลืมกรอกวันพ้นสภาพ
      // ถือว่าออกแล้ว (เคารพการตั้ง status ของ HR) — มิฉะนั้นจะนับเป็น active ผิด
      if (emp.status === 'resigned') return 'resigned';
      return 'active';
    }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    return emp.terminationDate > today ? 'pending' : 'resigned';
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
    if (filter.position) list = list.filter(e => e.position === filter.position);
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
    const path = `${employeeId}-${Date.now()}.jpg`;
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
  getDepartments() { return this.data.departments.slice(); },
  getDepartment(id) {
    if (!this._deptIndex) {
      this._deptIndex = new Map();
      for (const d of this.data.departments) this._deptIndex.set(d.id, d);
    }
    return this._deptIndex.get(id);
  },
  async saveDepartment(dept) {
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

  // ─── POSITIONS ───
  getPositions() { return this.data.positionLevels.slice(); },
  getPosition(id) {
    if (!this._posIndex) {
      this._posIndex = new Map();
      for (const p of this.data.positionLevels) this._posIndex.set(p.id, p);
    }
    return this._posIndex.get(id);
  },
  async savePosition(pos) {
    const { data, error } = await this.client.from('position_levels').upsert(this._posToDB(pos)).select().single();
    if (error) throw error;
    const mapped = this._posFromDB(data);
    const idx = this.data.positionLevels.findIndex(p => p.id === mapped.id);
    if (idx >= 0) this.data.positionLevels[idx] = mapped;
    else this.data.positionLevels.push(mapped);
    this._invalidateIndex('position_levels');
    return mapped;
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
  async changePassword(newPassword) {
    const { error } = await this.client.auth.updateUser({ password: newPassword });
    if (error) throw error;
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

  // คำนวณรหัสผ่านเริ่มต้นจากข้อมูลพนักงาน (hybrid logic)
  //  1) เลข ปชช (>= 6 หลัก, strip non-digit) → ใช้
  //  2) Passport number (>= 6 ตัว) → ใช้
  //  3) Fallback → "kacha{employee_id}"
  _computeInitialPassword(emp) {
    const nat = String(emp.nationalId || '').replace(/\D/g, '');
    if (nat.length >= 6) return { password: nat, source: 'เลขประชาชน' };
    const pp = String(emp.passportNumber || '').trim();
    if (pp.length >= 6) return { password: pp, source: 'passport' };
    return { password: `kacha${emp.id}`, source: 'kacha+รหัส' };
  },

  // สร้างบัญชี 1 คนด้วย Supabase signUp — เก็บ admin session ไว้ก่อน, signUp, แล้ว restore กลับ
  // handle_new_user trigger จะ auto-link employee_id จาก raw_user_meta_data
  async createEmployeeAccount(employeeId) {
    if (!this.isAdmin) throw new Error('ต้องเป็น admin');
    const emp = this.getEmployee(employeeId);
    if (!emp) throw new Error('ไม่พบพนักงาน ' + employeeId);

    const email = `${String(employeeId).toLowerCase()}@kacha.local`;
    const { password, source } = this._computeInitialPassword(emp);
    const fullName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();

    // เก็บ session admin ไว้ก่อน — เพราะ signUp จะ auto-login เป็น user ใหม่
    const { data: { session: adminSession } } = await this.client.auth.getSession();
    if (!adminSession) throw new Error('ไม่มี admin session');

    try {
      const { data, error } = await this.client.auth.signUp({
        email,
        password,
        options: {
          data: { employee_id: employeeId, name: fullName }
        }
      });
      if (error) throw error;

      // restore admin session ทันที (กัน UI สลับเป็น user ใหม่)
      await this.client.auth.setSession({
        access_token: adminSession.access_token,
        refresh_token: adminSession.refresh_token
      });

      return { user_id: data.user?.id, email, password, source, created: true, message: 'สร้างบัญชีสำเร็จ' };
    } catch (ex) {
      // ถ้าล้มเหลว — กู้ admin session กลับ
      try { await this.client.auth.setSession({ access_token: adminSession.access_token, refresh_token: adminSession.refresh_token }); } catch {}
      throw ex;
    }
  },

  async bulkCreateEmployeeAccounts() {
    if (!this.isAdmin) throw new Error('ต้องเป็น admin');
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
    if (!this.isAdmin) throw new Error('ต้องเป็น admin');
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
      const s = String(search).replace(/[,()]/g, ' ').trim();
      if (s) q = q.or(`user_email.ilike.%${s}%,record_id.ilike.%${s}%`);
    }
    q = q.order('ts', { ascending: false }).range(offset, offset + limit - 1);
    const { data, count, error } = await q;
    if (error) throw error;
    return { rows: data || [], total: count || 0 };
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

  // หาผู้อนุมัติของพนักงานคนนี้ = คนที่มี position_level สูงสุดในสาขาเดียวกัน
  // (ไม่นับคนลาออกแล้ว) — ถ้าเสมอกันใช้ id แรก
  getLeaveApprover(empId) {
    const emp = this.getEmployee(empId);
    if (!emp || !emp.branch) return null;
    const sameBranch = this.data.employees
      .filter(e => e.branch === emp.branch && this.empStatus(e) !== 'resigned');
    if (!sameBranch.length) return null;
    // เพิ่ม level จาก position_levels (default 0)
    const withLevel = sameBranch.map(e => {
      const pos = this.getPosition(e.position);
      return { emp: e, level: pos ? Number(pos.level || 0) : 0 };
    });
    withLevel.sort((a, b) => b.level - a.level || a.emp.id.localeCompare(b.emp.id));
    return withLevel[0].emp;
  },

  // current user สามารถอนุมัติของ empId นี้ได้ไหม
  canApproveLeaveFor(empId) {
    if (this.isAdmin) return true;
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

  async approveLeaveRequest(id, note = '') {
    if (!this.isAdmin) throw new Error('ต้องเป็น admin');
    const { data, error } = await this.client.from('leave_requests')
      .update({ status: 'approved', approved_by: this.user?.id || null, approved_at: new Date().toISOString(), approver_note: note || null })
      .eq('id', id).select().single();
    if (error) throw error;
    return this._leaveFromDB(data);
  },

  async rejectLeaveRequest(id, note = '') {
    if (!this.isAdmin) throw new Error('ต้องเป็น admin');
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
    if (!this.isAdmin) throw new Error('ต้องเป็น admin');
    const { error } = await this.client.from('leave_requests').delete().eq('id', id);
    if (error) throw error;
    this.data.leaveRequests = this.data.leaveRequests.filter(r => r.id !== id);
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
  getDashboardKPI() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const [ty, tm] = today.split('-').map(Number);
    const thisYM = `${ty}-${String(tm).padStart(2, '0')}`;
    const yearStart = `${ty}-01-01`;
    // ใช้ getEmployees() เพื่อ auto-scope ตาม RBAC (admin/hr เห็นทั้งหมด, manager เห็นเฉพาะสาขา)
    const emps = this.getEmployees();
    const active = emps.filter(e => this.empStatus(e) !== 'resigned');
    const newThisMonth = emps.filter(e => e.hireDate && String(e.hireDate).startsWith(thisYM)).length;
    const exitThisMonth = emps.filter(e => e.terminationDate && String(e.terminationDate).startsWith(thisYM)).length;
    const exitYTD = emps.filter(e => e.terminationDate && e.terminationDate >= yearStart && e.terminationDate <= today).length;
    const hireYTD = emps.filter(e => e.hireDate && e.hireDate >= yearStart && e.hireDate <= today).length;
    const headcount = active.length;
    const turnoverMonth = headcount ? (exitThisMonth / headcount * 100) : 0;
    const turnoverYTD = headcount ? (exitYTD / headcount * 100) : 0;
    const turnoverAnnualized = tm ? (turnoverYTD * 12 / tm) : 0;
    return {
      headcount, total: emps.length,
      newThisMonth, exitThisMonth, hireYTD, exitYTD,
      turnoverMonth, turnoverYTD, turnoverAnnualized,
      year: ty, monthsElapsed: tm
    };
  },

  // ─── BRANCH STATS (จำนวนพนักงานต่อสาขา — เฉพาะที่ยังปฏิบัติงาน) ───
  getBranchStats() {
    const counts = new Map();
    for (const e of this.data.employees) {
      if (this.empStatus(e) === 'resigned') continue;
      const b = (e.branch || 'ไม่ระบุ').trim() || 'ไม่ระบุ';
      counts.set(b, (counts.get(b) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([branch, count]) => ({ branch, count }))
      .sort((a, b) => b.count - a.count);
  },

  // ─── YEARLY HIRE / EXIT (ปฏิทินทั้งปี ม.ค.-ธ.ค.) ───
  getYearlyHireExit(year = null) {
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
    for (const e of this.data.employees) {
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
  getMonthlyHireExit(monthsBack = 12) {
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
    for (const e of this.data.employees) {
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
  getAgeDistribution() {
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

    for (const e of this.data.employees) {
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
  getStats() {
    // ใช้ getEmployees() เพื่อ auto-scope ตาม RBAC
    const emps = this.getEmployees();
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
      byAge: this.getAgeDistribution(),
      salaryByPosition: this.getSalaryByPosition(),
      byGender: {
        male: active.filter(e => e.gender === 'ชาย').length,
        female: active.filter(e => e.gender === 'หญิง').length
      }
    };
  }
};
