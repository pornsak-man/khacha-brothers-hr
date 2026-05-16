/* ═══════════════════════════════════════════════════════════
   KHACHA BROTHERS HR — DATA LAYER
   เก็บข้อมูลใน localStorage (offline-first)
   ═══════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'kb_hr_data_v1';

const DEFAULT_DATA = {
  company: {
    name: 'บริษัท คชา บราเธอร์ส จำกัด',
    nameEn: 'Khacha Brothers Co., Ltd.',
    taxId: '',
    address: '',
    phone: '',
    email: ''
  },
  auth: {
    users: [
      { username: 'admin', password: 'admin123', name: 'ผู้ดูแลระบบ', role: 'admin' }
    ]
  },
  departments: [
    { id: 'D001', name: 'ฝ่ายบริหาร', manager: '', note: '' },
    { id: 'D002', name: 'ฝ่ายบุคคล', manager: '', note: '' },
    { id: 'D003', name: 'ฝ่ายบัญชี-การเงิน', manager: '', note: '' },
    { id: 'D004', name: 'ฝ่ายขาย-การตลาด', manager: '', note: '' },
    { id: 'D005', name: 'ฝ่ายปฏิบัติการ', manager: '', note: '' }
  ],
  positionLevels: [
    { id: 'P01', name: 'พนักงาน', minSalary: 12000, maxSalary: 20000 },
    { id: 'P02', name: 'พนักงานอาวุโส', minSalary: 18000, maxSalary: 28000 },
    { id: 'P03', name: 'หัวหน้าทีม', minSalary: 25000, maxSalary: 40000 },
    { id: 'P04', name: 'ผู้จัดการ', minSalary: 35000, maxSalary: 60000 },
    { id: 'P05', name: 'ผู้อำนวยการ', minSalary: 55000, maxSalary: 120000 }
  ],
  employees: [
    {
      id: 'KB0001',
      title: 'นาย', firstName: 'สมชาย', lastName: 'ใจดี', nickname: 'ชาย',
      nationalId: '1234567890123', dob: '1990-05-15', gender: 'ชาย',
      phone: '081-234-5678', email: 'somchai@khacha.co.th',
      address: '123 ถ.สุขุมวิท กรุงเทพฯ 10110',
      department: 'D001', position: 'P05', positionTitle: 'ประธานเจ้าหน้าที่บริหาร',
      hireDate: '2020-01-15', salary: 80000,
      status: 'active', note: ''
    },
    {
      id: 'KB0002',
      title: 'นางสาว', firstName: 'สุดา', lastName: 'รักงาน', nickname: 'ดา',
      nationalId: '1234567890124', dob: '1992-08-22', gender: 'หญิง',
      phone: '082-345-6789', email: 'suda@khacha.co.th',
      address: '456 ถ.พระราม 9 กรุงเทพฯ 10310',
      department: 'D002', position: 'P04', positionTitle: 'ผู้จัดการฝ่ายบุคคล',
      hireDate: '2021-03-01', salary: 45000,
      status: 'active', note: ''
    },
    {
      id: 'KB0003',
      title: 'นาย', firstName: 'วิชัย', lastName: 'มั่นคง', nickname: 'ชัย',
      nationalId: '1234567890125', dob: '1988-11-10', gender: 'ชาย',
      phone: '083-456-7890', email: 'wichai@khacha.co.th',
      address: '789 ถ.รัชดาภิเษก กรุงเทพฯ 10400',
      department: 'D003', position: 'P04', positionTitle: 'ผู้จัดการฝ่ายบัญชี',
      hireDate: '2020-06-15', salary: 48000,
      status: 'active', note: ''
    },
    {
      id: 'KB0004',
      title: 'นางสาว', firstName: 'พิมพ์ใจ', lastName: 'อ่อนหวาน', nickname: 'พิม',
      nationalId: '1234567890126', dob: '1995-02-18', gender: 'หญิง',
      phone: '084-567-8901', email: 'pim@khacha.co.th',
      address: '321 ถ.ลาดพร้าว กรุงเทพฯ 10230',
      department: 'D004', position: 'P03', positionTitle: 'หัวหน้าทีมการตลาด',
      hireDate: '2022-04-10', salary: 32000,
      status: 'active', note: ''
    },
    {
      id: 'KB0005',
      title: 'นาย', firstName: 'ประยุทธ', lastName: 'ขยัน', nickname: 'ยุทธ',
      nationalId: '1234567890127', dob: '1993-07-05', gender: 'ชาย',
      phone: '085-678-9012', email: 'prayut@khacha.co.th',
      address: '654 ถ.พหลโยธิน กรุงเทพฯ 10900',
      department: 'D005', position: 'P02', positionTitle: 'ช่างเทคนิคอาวุโส',
      hireDate: '2021-09-20', salary: 25000,
      status: 'active', note: ''
    },
    {
      id: 'KB0006',
      title: 'นางสาว', firstName: 'มาลี', lastName: 'สดใส', nickname: 'มา',
      nationalId: '1234567890128', dob: '1997-12-30', gender: 'หญิง',
      phone: '086-789-0123', email: 'malee@khacha.co.th',
      address: '987 ถ.วิภาวดี กรุงเทพฯ 10900',
      department: 'D002', position: 'P01', positionTitle: 'เจ้าหน้าที่บุคคล',
      hireDate: '2023-06-01', salary: 18000,
      status: 'active', note: ''
    },
    {
      id: 'KB0007',
      title: 'นาย', firstName: 'อนุชา', lastName: 'สู้ชีวิต', nickname: 'อนุ',
      nationalId: '1234567890129', dob: '1991-04-12', gender: 'ชาย',
      phone: '087-890-1234', email: 'anucha@khacha.co.th',
      address: '147 ถ.รามคำแหง กรุงเทพฯ 10240',
      department: 'D004', position: 'P02', positionTitle: 'พนักงานขายอาวุโส',
      hireDate: '2022-01-15', salary: 24000,
      status: 'active', note: ''
    },
    {
      id: 'KB0008',
      title: 'นางสาว', firstName: 'รัตนา', lastName: 'งดงาม', nickname: 'รัตน์',
      nationalId: '1234567890130', dob: '1996-09-25', gender: 'หญิง',
      phone: '088-901-2345', email: 'rattana@khacha.co.th',
      address: '258 ถ.บางนา กรุงเทพฯ 10260',
      department: 'D003', position: 'P01', positionTitle: 'เจ้าหน้าที่บัญชี',
      hireDate: '2023-10-01', salary: 17500,
      status: 'active', note: ''
    }
  ],
  salaryHistory: [],
  loans: [],
  advances: [],
  allowances: [],
  evaluations: [],
  calendar: [
    { id: 'C1', date: '2026-01-01', title: 'วันขึ้นปีใหม่', type: 'holiday' },
    { id: 'C2', date: '2026-04-13', title: 'วันสงกรานต์', type: 'holiday' },
    { id: 'C3', date: '2026-04-14', title: 'วันสงกรานต์', type: 'holiday' },
    { id: 'C4', date: '2026-04-15', title: 'วันสงกรานต์', type: 'holiday' },
    { id: 'C5', date: '2026-05-01', title: 'วันแรงงานแห่งชาติ', type: 'holiday' },
    { id: 'C6', date: '2026-12-05', title: 'วันคล้ายวันพระบรมราชสมภพ ร.๙', type: 'holiday' },
    { id: 'C7', date: '2026-12-10', title: 'วันรัฐธรรมนูญ', type: 'holiday' },
    { id: 'C8', date: '2026-12-31', title: 'วันสิ้นปี', type: 'holiday' }
  ],
  settings: {
    theme: 'light',
    employeeIdPrefix: 'KB',
    employeeIdStart: 1
  }
};

const DB = {
  data: null,
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.data = JSON.parse(raw);
        // Merge with defaults to ensure all keys exist
        for (const key of Object.keys(DEFAULT_DATA)) {
          if (!(key in this.data)) this.data[key] = DEFAULT_DATA[key];
        }
      } else {
        this.data = JSON.parse(JSON.stringify(DEFAULT_DATA));
        this.save();
      }
    } catch (e) {
      console.error('Failed to load data:', e);
      this.data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
  },
  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
  },
  reset() {
    this.data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    this.save();
  },
  export() {
    return JSON.stringify(this.data, null, 2);
  },
  import(json) {
    const parsed = JSON.parse(json);
    this.data = parsed;
    this.save();
  },

  // ─── Employees ───
  getEmployees(filter = {}) {
    let list = this.data.employees.slice();
    if (filter.search) {
      const s = filter.search.toLowerCase();
      list = list.filter(e =>
        (e.firstName + ' ' + e.lastName).toLowerCase().includes(s) ||
        e.id.toLowerCase().includes(s) ||
        (e.nickname || '').toLowerCase().includes(s) ||
        (e.positionTitle || '').toLowerCase().includes(s)
      );
    }
    if (filter.department) list = list.filter(e => e.department === filter.department);
    if (filter.status) list = list.filter(e => e.status === filter.status);
    return list;
  },
  getEmployee(id) {
    return this.data.employees.find(e => e.id === id);
  },
  saveEmployee(emp) {
    const idx = this.data.employees.findIndex(e => e.id === emp.id);
    if (idx >= 0) this.data.employees[idx] = emp;
    else this.data.employees.push(emp);
    this.save();
  },
  deleteEmployee(id) {
    this.data.employees = this.data.employees.filter(e => e.id !== id);
    this.save();
  },
  nextEmployeeId() {
    const prefix = this.data.settings.employeeIdPrefix || 'KB';
    const nums = this.data.employees
      .map(e => parseInt(String(e.id).replace(/[^\d]/g, ''), 10))
      .filter(n => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : (this.data.settings.employeeIdStart || 1) - 1;
    return prefix + String(max + 1).padStart(4, '0');
  },

  // ─── Departments ───
  getDepartments() { return this.data.departments.slice(); },
  getDepartment(id) { return this.data.departments.find(d => d.id === id); },
  saveDepartment(dept) {
    const idx = this.data.departments.findIndex(d => d.id === dept.id);
    if (idx >= 0) this.data.departments[idx] = dept;
    else this.data.departments.push(dept);
    this.save();
  },
  deleteDepartment(id) {
    if (this.data.employees.some(e => e.department === id)) return false;
    this.data.departments = this.data.departments.filter(d => d.id !== id);
    this.save();
    return true;
  },
  nextDepartmentId() {
    const nums = this.data.departments.map(d => parseInt(String(d.id).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return 'D' + String(max + 1).padStart(3, '0');
  },

  // ─── Position Levels ───
  getPositions() { return this.data.positionLevels.slice(); },
  getPosition(id) { return this.data.positionLevels.find(p => p.id === id); },
  savePosition(pos) {
    const idx = this.data.positionLevels.findIndex(p => p.id === pos.id);
    if (idx >= 0) this.data.positionLevels[idx] = pos;
    else this.data.positionLevels.push(pos);
    this.save();
  },
  deletePosition(id) {
    if (this.data.employees.some(e => e.position === id)) return false;
    this.data.positionLevels = this.data.positionLevels.filter(p => p.id !== id);
    this.save();
    return true;
  },
  nextPositionId() {
    const nums = this.data.positionLevels.map(p => parseInt(String(p.id).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return 'P' + String(max + 1).padStart(2, '0');
  },

  // ─── Salary History ───
  addSalaryAdjustment(rec) {
    rec.id = rec.id || ('SA' + Date.now());
    this.data.salaryHistory.push(rec);
    const emp = this.getEmployee(rec.employeeId);
    if (emp) {
      emp.salary = rec.newSalary;
      if (rec.newPosition) emp.position = rec.newPosition;
      if (rec.newPositionTitle) emp.positionTitle = rec.newPositionTitle;
      this.saveEmployee(emp);
    }
    this.save();
  },
  getSalaryHistory(employeeId = null) {
    let list = this.data.salaryHistory.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (employeeId) list = list.filter(s => s.employeeId === employeeId);
    return list;
  },

  // ─── Loans ───
  getLoans(employeeId = null) {
    let list = this.data.loans.slice();
    if (employeeId) list = list.filter(l => l.employeeId === employeeId);
    return list;
  },
  saveLoan(loan) {
    loan.id = loan.id || ('L' + Date.now());
    const idx = this.data.loans.findIndex(l => l.id === loan.id);
    if (idx >= 0) this.data.loans[idx] = loan;
    else this.data.loans.push(loan);
    this.save();
  },
  deleteLoan(id) {
    this.data.loans = this.data.loans.filter(l => l.id !== id);
    this.save();
  },

  // ─── Advances ───
  getAdvances(employeeId = null) {
    let list = this.data.advances.slice();
    if (employeeId) list = list.filter(a => a.employeeId === employeeId);
    return list;
  },
  saveAdvance(adv) {
    adv.id = adv.id || ('AD' + Date.now());
    const idx = this.data.advances.findIndex(a => a.id === adv.id);
    if (idx >= 0) this.data.advances[idx] = adv;
    else this.data.advances.push(adv);
    this.save();
  },
  deleteAdvance(id) {
    this.data.advances = this.data.advances.filter(a => a.id !== id);
    this.save();
  },

  // ─── Allowances ───
  getAllowances(employeeId = null) {
    let list = this.data.allowances.slice();
    if (employeeId) list = list.filter(a => a.employeeId === employeeId);
    return list;
  },
  saveAllowance(rec) {
    rec.id = rec.id || ('AL' + Date.now());
    const idx = this.data.allowances.findIndex(a => a.id === rec.id);
    if (idx >= 0) this.data.allowances[idx] = rec;
    else this.data.allowances.push(rec);
    this.save();
  },
  deleteAllowance(id) {
    this.data.allowances = this.data.allowances.filter(a => a.id !== id);
    this.save();
  },

  // ─── Evaluations ───
  getEvaluations(employeeId = null) {
    let list = this.data.evaluations.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (employeeId) list = list.filter(e => e.employeeId === employeeId);
    return list;
  },
  saveEvaluation(ev) {
    ev.id = ev.id || ('EV' + Date.now());
    const idx = this.data.evaluations.findIndex(e => e.id === ev.id);
    if (idx >= 0) this.data.evaluations[idx] = ev;
    else this.data.evaluations.push(ev);
    this.save();
  },
  deleteEvaluation(id) {
    this.data.evaluations = this.data.evaluations.filter(e => e.id !== id);
    this.save();
  },

  // ─── Calendar ───
  getCalendar() { return this.data.calendar.slice().sort((a, b) => a.date.localeCompare(b.date)); },
  saveCalendarItem(item) {
    item.id = item.id || ('C' + Date.now());
    const idx = this.data.calendar.findIndex(c => c.id === item.id);
    if (idx >= 0) this.data.calendar[idx] = item;
    else this.data.calendar.push(item);
    this.save();
  },
  deleteCalendarItem(id) {
    this.data.calendar = this.data.calendar.filter(c => c.id !== id);
    this.save();
  },

  // ─── Stats ───
  getStats() {
    const emps = this.data.employees;
    const active = emps.filter(e => e.status === 'active');
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

// Initialize on load
DB.load();
