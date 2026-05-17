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
    calendar: []
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
    this.isAdmin = data?.role === 'admin';
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
    const [emps, loans, advs, allow, evals, sal] = await Promise.all([
      this._fetchAllPages('employees', 'id', true),
      this._fetchAllPages('loans', 'date', false),
      this._fetchAllPages('advances', 'date', false),
      this._fetchAllPages('allowances', 'month', false),
      this._fetchAllPages('evaluations', 'date', false),
      this._fetchAllPages('salary_history', 'date', false)
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
      calendar_items: { list: 'calendar', from: this._calFromDB }
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
  _salFromDB: (r) => ({ id: r.id, employeeId: r.employee_id, date: r.date, oldSalary: Number(r.old_salary), newSalary: Number(r.new_salary), newPosition: r.new_position || '', newPositionTitle: r.new_position_title || '', reason: r.reason || '' }),
  _salToDB: (s) => ({ employee_id: s.employeeId, date: s.date, old_salary: Number(s.oldSalary), new_salary: Number(s.newSalary), new_position: s.newPosition || null, new_position_title: s.newPositionTitle, reason: s.reason }),
  _calFromDB: (r) => ({ id: r.id, date: r.date, title: r.title, type: r.type || 'holiday' }),
  _calToDB: (c) => ({ date: c.date, title: c.title, type: c.type }),
  _compFromDB: (r) => ({ name: r.name || '', nameEn: r.name_en || '', taxId: r.tax_id || '', address: r.address || '', phone: r.phone || '', email: r.email || '' }),

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
    return list;
  },

  // ดึงรายชื่อสาขาทั้งหมด (unique, sorted) จากข้อมูลพนักงาน
  getBranches() {
    const set = new Set();
    for (const e of this.data.employees) {
      if (e.branch && e.branch.trim()) set.add(e.branch.trim());
    }
    return [...set].sort();
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

  // ─── SALARY HISTORY ───
  getSalaryHistory(employeeId = null) {
    let list = this.data.salaryHistory.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (employeeId) list = list.filter(s => s.employeeId === employeeId);
    return list;
  },
  async addSalaryAdjustment(rec) {
    const { data, error } = await this.client.from('salary_history').insert(this._salToDB(rec)).select().single();
    if (error) throw error;
    const mapped = this._salFromDB(data);
    this.data.salaryHistory.unshift(mapped);

    const emp = this.getEmployee(rec.employeeId);
    if (emp) {
      emp.salary = Number(rec.newSalary);
      if (rec.newPosition) emp.position = rec.newPosition;
      if (rec.newPositionTitle) emp.positionTitle = rec.newPositionTitle;
      await this.saveEmployee(emp);
    }
    return mapped;
  },

  // ─── LOANS ───
  getLoans(employeeId = null) {
    let list = this.data.loans.slice();
    if (employeeId) list = list.filter(l => l.employeeId === employeeId);
    return list;
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
    if (employeeId) list = list.filter(a => a.employeeId === employeeId);
    return list;
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
    if (employeeId) list = list.filter(a => a.employeeId === employeeId);
    return list;
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
    if (employeeId) list = list.filter(e => e.employeeId === employeeId);
    return list;
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
    const emps = this.data.employees;
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

  // ─── STATS ───
  getStats() {
    const emps = this.data.employees;
    // ใช้ effective status (ตามวันพ้นสภาพ — ไม่ใช่ field 'status' ที่อาจ stale)
    const active = emps.filter(e => this.empStatus(e) !== 'resigned');
    const totalSalary = active.reduce((s, e) => s + (e.salary || 0), 0);
    const activeLoans = this.data.loans.filter(l => l.status !== 'completed').length;
    const pendingAdvances = this.data.advances.filter(a => a.status !== 'paid').length;
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
      byPosition: this.data.positionLevels.map(p => ({
        name: p.name,
        count: active.filter(e => e.position === p.id).length
      })),
      byGender: {
        male: active.filter(e => e.gender === 'ชาย').length,
        female: active.filter(e => e.gender === 'หญิง').length
      }
    };
  }
};
