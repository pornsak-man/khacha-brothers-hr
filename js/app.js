/* ═══════════════════════════════════════════════════════════
   KHACHA BROTHERS HR — APP LOGIC (Supabase + Realtime)
   ═══════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmt = {
  money: (n) => 'บาท ' + (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
  num: (n) => (Number(n) || 0).toLocaleString('th-TH'),
  date: (d) => {
    if (!d) return '-';
    try { return new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d; }
  },
  dateLong: (d) => {
    if (!d) return '-';
    try { return new Date(d).toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (e) { return d; }
  },
  age: (dob) => {
    if (!dob) return '-';
    const today = new Date(), birth = new Date(dob);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age + ' ปี';
  },
  serviceYears: (hireDate) => {
    if (!hireDate) return '-';
    const today = new Date(), start = new Date(hireDate);
    let years = today.getFullYear() - start.getFullYear();
    let months = today.getMonth() - start.getMonth();
    if (months < 0) { years--; months += 12; }
    return years + ' ปี ' + months + ' เดือน';
  }
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─────────────── TOAST ───────────────
const toast = (msg, type = 'info') => {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(40px)'; el.style.transition = 'all .2s'; }, 2500);
  setTimeout(() => el.remove(), 2800);
};

// ─────────────── MODAL ───────────────
const modal = {
  open(title, bodyHtml, opts = {}) {
    const root = $('#modalRoot');
    const sizeCls = opts.size === 'lg' ? ' lg' : '';
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal${sizeCls}">
          <div class="modal-header">
            <div class="modal-title">${escapeHtml(title)}</div>
            <button class="modal-close" data-close>&times;</button>
          </div>
          <div class="modal-body">${bodyHtml}</div>
          ${opts.footer ? `<div class="modal-footer">${opts.footer}</div>` : ''}
        </div>
      </div>`;
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop') || e.target.dataset.close !== undefined) this.close();
    });
    return root.querySelector('.modal');
  },
  close() { $('#modalRoot').innerHTML = ''; },
  confirm(title, message) {
    return new Promise((resolve) => {
      this.open(title, `<p>${escapeHtml(message)}</p>`, {
        footer: `<button class="btn btn-secondary" data-cancel>ยกเลิก</button><button class="btn btn-danger" data-ok>ยืนยัน</button>`
      });
      const root = $('#modalRoot');
      root.querySelector('[data-ok]').addEventListener('click', () => { this.close(); resolve(true); });
      root.querySelector('[data-cancel]').addEventListener('click', () => { this.close(); resolve(false); });
    });
  }
};

// ─────────────── AUTH ───────────────
const auth = {
  init() {
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#loginEmail').value.trim();
      const password = $('#loginPass').value;
      const btn = $('#loginBtn');
      const err = $('#loginError');
      err.textContent = '';
      btn.disabled = true; btn.textContent = 'กำลังเข้าสู่ระบบ...';
      try {
        await DB.signIn(email, password);
        if (!DB.profile) {
          err.textContent = 'ไม่พบโปรไฟล์ผู้ใช้ในระบบ — ติดต่อผู้ดูแล';
          await DB.signOut();
          return;
        }
        this.showApp();
      } catch (ex) {
        err.textContent = ex.message === 'Invalid login credentials'
          ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
          : (ex.message || 'เข้าสู่ระบบไม่สำเร็จ');
      } finally {
        btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ';
      }
    });
    $('#logoutBtn').addEventListener('click', () => this.logout());
  },
  async logout() {
    await DB.signOut();
    this.showLogin();
  },
  showLogin() {
    $('#loginScreen').style.display = 'flex';
    $('#app').style.display = 'none';
  },
  showApp() {
    $('#loginScreen').style.display = 'none';
    $('#app').style.display = 'grid';
    const displayName = DB.profile?.name || DB.user?.email?.split('@')[0] || 'User';
    $('#userName').textContent = displayName;
    $('#userAvatar').textContent = displayName.charAt(0).toUpperCase();
    $('.user-role').textContent = DB.isAdmin ? 'ผู้ดูแลระบบ' : 'ผู้ใช้งานทั่วไป';
    router.go('dashboard');
  }
};

// ─────────────── ADMIN GUARD ───────────────
function requireAdmin() {
  if (!DB.isAdmin) {
    toast('คุณไม่มีสิทธิ์ทำรายการนี้ (admin เท่านั้น)', 'error');
    return false;
  }
  return true;
}

// ─────────────── ROUTER ───────────────
const router = {
  current: 'dashboard',
  pages: {},
  register(name, fn) { this.pages[name] = fn; },
  go(name) {
    this.current = name;
    $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === name));
    const titles = {
      dashboard: 'แดชบอร์ด',
      employees: 'ทะเบียนพนักงาน',
      departments: 'ฝ่าย / แผนก',
      positions: 'ระดับตำแหน่ง',
      'salary-adjust': 'ปรับเงินเดือน / ตำแหน่ง',
      loans: 'การกู้เงินบริษัท',
      advances: 'เบิกเงินล่วงหน้า',
      allowance: 'เบี้ยเลี้ยงรายเดือน',
      evaluations: 'ประเมินผลงาน',
      reports: 'รายงาน / Export',
      calendar: 'ปฏิทิน HR',
      settings: 'ตั้งค่าระบบ'
    };
    $('#pageTitle').textContent = titles[name] || name;
    const fn = this.pages[name];
    $('#content').innerHTML = fn ? fn() : '<p>ไม่พบหน้า</p>';
    if (window.afterRender) { window.afterRender(); window.afterRender = null; }
    if (name === 'employees') wireEmployeePage();
    $('#sidebar').classList.remove('open');
  },
  refresh() { this.go(this.current); }
};

// Realtime: เมื่อข้อมูลเปลี่ยนจากเครื่องอื่น ให้ refresh หน้าปัจจุบัน (ถ้าไม่ได้เปิด modal อยู่)
window.onRealtimeChange = () => {
  if ($('#modalRoot').children.length > 0) return; // ไม่รบกวน modal ที่กำลังเปิด
  // throttle: refresh ไม่เกิน 1 ครั้ง/วินาที
  clearTimeout(window._rtTimer);
  window._rtTimer = setTimeout(() => router.refresh(), 300);
};

// ═══════════════════════════════════════════════════════
//  PAGE: DASHBOARD
// ═══════════════════════════════════════════════════════
router.register('dashboard', () => {
  const s = DB.getStats();
  window.afterRender = () => renderDashboardCharts(s);
  return `
    <div class="page-header">
      <h2>ภาพรวมระบบ</h2>
      <div class="actions">
        ${DB.isAdmin ? '<button class="btn btn-primary" onclick="openEmployeeForm()">+ เพิ่มพนักงาน</button>' : ''}
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon bg-primary">👥</div><div><div class="stat-label">พนักงานทั้งหมด</div><div class="stat-value">${fmt.num(s.totalEmployees)}</div><div class="stat-trend up">ปฏิบัติงาน ${s.activeEmployees} คน</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-blue">🏢</div><div><div class="stat-label">จำนวนฝ่าย</div><div class="stat-value">${fmt.num(s.departments)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-green">💰</div><div><div class="stat-label">เงินเดือนรวมต่อเดือน</div><div class="stat-value">${fmt.money(s.totalMonthlySalary)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-orange">🏦</div><div><div class="stat-label">การกู้ที่ยังไม่ปิด</div><div class="stat-value">${fmt.num(s.activeLoans)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-purple">💵</div><div><div class="stat-label">เบิกล่วงหน้ารอจ่าย</div><div class="stat-value">${fmt.num(s.pendingAdvances)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-red">📅</div><div><div class="stat-label">วันหยุดในปฏิทิน</div><div class="stat-value">${fmt.num(DB.getCalendar().length)}</div></div></div>
    </div>

    <div class="chart-row">
      <div class="chart-box"><div class="card-header"><div class="card-title">พนักงานตามฝ่าย</div></div><canvas id="chartByDept"></canvas></div>
      <div class="chart-box"><div class="card-header"><div class="card-title">สัดส่วนเพศ</div></div><canvas id="chartByGender"></canvas></div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">พนักงานเข้างานล่าสุด</div></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>ตำแหน่ง</th><th>ฝ่าย</th><th>เริ่มงาน</th></tr></thead>
          <tbody>
            ${DB.getEmployees().sort((a, b) => (b.hireDate || '').localeCompare(a.hireDate || '')).slice(0, 5).map(e => `
              <tr>
                <td>${escapeHtml(e.id)}</td>
                <td>${escapeHtml((e.title || '') + e.firstName + ' ' + e.lastName)}</td>
                <td>${escapeHtml(e.positionTitle || '')}</td>
                <td>${escapeHtml((DB.getDepartment(e.department) || {}).name || '-')}</td>
                <td>${fmt.date(e.hireDate)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
});

function renderDashboardCharts(s) {
  if (typeof Chart === 'undefined') { setTimeout(() => renderDashboardCharts(s), 200); return; }
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  Chart.defaults.color = isDark ? '#c9cfd6' : '#4b5563';
  Chart.defaults.font.family = 'Prompt, sans-serif';

  const ctx1 = $('#chartByDept');
  if (ctx1) new Chart(ctx1, {
    type: 'bar',
    data: { labels: s.byDepartment.map(d => d.name), datasets: [{ label: 'จำนวน', data: s.byDepartment.map(d => d.count), backgroundColor: '#b8860b', borderRadius: 6 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });
  const ctx2 = $('#chartByGender');
  if (ctx2) new Chart(ctx2, {
    type: 'doughnut',
    data: { labels: ['ชาย', 'หญิง'], datasets: [{ data: [s.byGender.male, s.byGender.female], backgroundColor: ['#2563eb', '#ec4899'] }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });
}

// ═══════════════════════════════════════════════════════
//  PAGE: EMPLOYEES
// ═══════════════════════════════════════════════════════
const empState = { search: '', department: '', status: 'active' };

router.register('employees', () => {
  return `
    <div class="page-header">
      <h2>ทะเบียนพนักงาน</h2>
      <div class="actions">
        <button class="btn btn-secondary" onclick="exportEmployeesXLSX()">📥 Export Excel</button>
        ${DB.isAdmin ? '<button class="btn btn-primary" onclick="openEmployeeForm()">+ เพิ่มพนักงาน</button>' : ''}
      </div>
    </div>
    <div class="card">
      <div class="toolbar">
        <input class="search-input" id="empSearch" placeholder="ค้นหา ชื่อ / รหัส / ชื่อเล่น / ตำแหน่ง..." value="${escapeHtml(empState.search)}" />
        <select class="filter-select" id="empDept">
          <option value="">ทุกฝ่าย</option>
          ${DB.getDepartments().map(d => `<option value="${d.id}" ${empState.department === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
        </select>
        <select class="filter-select" id="empStatus">
          <option value="">ทุกสถานะ</option>
          <option value="active" ${empState.status === 'active' ? 'selected' : ''}>ปฏิบัติงาน</option>
          <option value="resigned" ${empState.status === 'resigned' ? 'selected' : ''}>ลาออก</option>
        </select>
      </div>
      <div id="empList"></div>
    </div>
  `;
});

function wireEmployeePage() {
  renderEmployeeList();
  $('#empSearch')?.addEventListener('input', (e) => { empState.search = e.target.value; renderEmployeeList(); });
  $('#empDept')?.addEventListener('change', (e) => { empState.department = e.target.value; renderEmployeeList(); });
  $('#empStatus')?.addEventListener('change', (e) => { empState.status = e.target.value; renderEmployeeList(); });
}

function renderEmployeeList() {
  const list = DB.getEmployees(empState);
  const container = $('#empList');
  if (!container) return;
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><div class="icon">👥</div><div class="title">ไม่พบพนักงาน</div><div class="hint">ลองเปลี่ยนตัวกรอง หรือเพิ่มพนักงานใหม่</div></div>`;
    return;
  }
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>ชื่อเล่น</th><th>ฝ่าย</th><th>ตำแหน่ง</th><th class="num">เงินเดือน</th><th>วันเริ่มงาน</th><th>สถานะ</th><th></th></tr>
        </thead>
        <tbody>
          ${list.map(e => `
            <tr>
              <td><strong>${escapeHtml(e.id)}</strong></td>
              <td>${escapeHtml((e.title || '') + e.firstName + ' ' + e.lastName)}</td>
              <td>${escapeHtml(e.nickname || '-')}</td>
              <td>${escapeHtml((DB.getDepartment(e.department) || {}).name || '-')}</td>
              <td>${escapeHtml(e.positionTitle || '')}</td>
              <td class="num">${fmt.money(e.salary)}</td>
              <td>${fmt.date(e.hireDate)}</td>
              <td>${e.status === 'active' ? '<span class="badge badge-success">ปฏิบัติงาน</span>' : '<span class="badge badge-neutral">ลาออก</span>'}</td>
              <td class="actions">
                <button class="btn btn-ghost btn-sm" onclick="viewEmployee('${e.id}')">ดู</button>
                ${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openEmployeeForm('${e.id}')">แก้ไข</button>
                <button class="btn btn-ghost btn-sm" onclick="deleteEmployee('${e.id}')">ลบ</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="muted-2 mt-2" style="font-size:12px">รวม ${list.length} คน</div>
  `;
}

function openEmployeeForm(id = null) {
  if (!requireAdmin()) return;
  const emp = id ? DB.getEmployee(id) : {
    id: DB.nextEmployeeId(), title: 'นาย', firstName: '', lastName: '', nickname: '',
    nationalId: '', dob: '', gender: 'ชาย', phone: '', email: '', address: '',
    department: DB.getDepartments()[0]?.id || '', position: DB.getPositions()[0]?.id || '',
    positionTitle: '', hireDate: new Date().toISOString().slice(0, 10),
    salary: 0, status: 'active', note: ''
  };
  const depts = DB.getDepartments();
  const positions = DB.getPositions();
  modal.open(id ? 'แก้ไขข้อมูลพนักงาน' : 'เพิ่มพนักงานใหม่', `
    <form id="empForm">
      <div class="form-grid">
        <div class="form-group"><label>รหัสพนักงาน *</label><input name="id" value="${escapeHtml(emp.id)}" required ${id ? 'readonly' : ''} /></div>
        <div class="form-group"><label>คำนำหน้า</label><select name="title">${['นาย', 'นาง', 'นางสาว', 'เด็กชาย', 'เด็กหญิง'].map(t => `<option ${emp.title === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label>ชื่อ *</label><input name="firstName" value="${escapeHtml(emp.firstName)}" required /></div>
        <div class="form-group"><label>นามสกุล *</label><input name="lastName" value="${escapeHtml(emp.lastName)}" required /></div>
        <div class="form-group"><label>ชื่อเล่น</label><input name="nickname" value="${escapeHtml(emp.nickname)}" /></div>
        <div class="form-group"><label>เลขบัตรประชาชน</label><input name="nationalId" value="${escapeHtml(emp.nationalId)}" maxlength="13" /></div>
        <div class="form-group"><label>วันเกิด</label><input name="dob" type="date" value="${emp.dob || ''}" /></div>
        <div class="form-group"><label>เพศ</label><select name="gender"><option ${emp.gender === 'ชาย' ? 'selected' : ''}>ชาย</option><option ${emp.gender === 'หญิง' ? 'selected' : ''}>หญิง</option></select></div>
        <div class="form-group"><label>เบอร์โทร</label><input name="phone" value="${escapeHtml(emp.phone)}" /></div>
        <div class="form-group"><label>อีเมล</label><input name="email" type="email" value="${escapeHtml(emp.email)}" /></div>
        <div class="form-group span-2"><label>ที่อยู่</label><textarea name="address" rows="2">${escapeHtml(emp.address)}</textarea></div>
        <div class="form-group"><label>ฝ่าย *</label><select name="department" required>${depts.map(d => `<option value="${d.id}" ${emp.department === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>ระดับตำแหน่ง *</label><select name="position" required>${positions.map(p => `<option value="${p.id}" ${emp.position === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>ชื่อตำแหน่ง</label><input name="positionTitle" value="${escapeHtml(emp.positionTitle)}" placeholder="เช่น ผู้จัดการฝ่ายบุคคล" /></div>
        <div class="form-group"><label>วันเริ่มงาน *</label><input name="hireDate" type="date" value="${emp.hireDate || ''}" required /></div>
        <div class="form-group"><label>เงินเดือน *</label><input name="salary" type="number" min="0" step="100" value="${emp.salary || 0}" required /></div>
        <div class="form-group"><label>สถานะ</label><select name="status"><option value="active" ${emp.status === 'active' ? 'selected' : ''}>ปฏิบัติงาน</option><option value="resigned" ${emp.status === 'resigned' ? 'selected' : ''}>ลาออก</option></select></div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="2">${escapeHtml(emp.note)}</textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary" id="empSubmit">${id ? 'บันทึกการแก้ไข' : 'เพิ่มพนักงาน'}</button>
      </div>
    </form>`, { size: 'lg' });
  $('#empForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#empSubmit'); btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.salary = Number(data.salary);
      await DB.saveEmployee(data);
      modal.close();
      toast(id ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มพนักงานใหม่แล้ว', 'success');
      renderEmployeeList();
    } catch (ex) {
      toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error');
      btn.disabled = false;
    }
  });
}

async function deleteEmployee(id) {
  if (!requireAdmin()) return;
  const emp = DB.getEmployee(id);
  if (!emp) return;
  if (!await modal.confirm('ลบพนักงาน', `ต้องการลบ ${emp.firstName} ${emp.lastName} ใช่หรือไม่?`)) return;
  try {
    await DB.deleteEmployee(id);
    toast('ลบพนักงานแล้ว', 'success');
    renderEmployeeList();
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

function viewEmployee(id) {
  const e = DB.getEmployee(id);
  if (!e) return;
  const dept = DB.getDepartment(e.department) || {};
  const pos = DB.getPosition(e.position) || {};
  const initials = (e.firstName || '?').charAt(0);
  const loans = DB.getLoans(id);
  const advances = DB.getAdvances(id);
  const evals = DB.getEvaluations(id);
  const history = DB.getSalaryHistory(id);

  modal.open('ข้อมูลพนักงาน', `
    <div class="emp-profile">
      <div>
        <div class="emp-avatar-lg">${escapeHtml(initials)}</div>
        <div class="text-center mt-4">
          <div style="font-size:13px;color:var(--text-2)">รหัสพนักงาน</div>
          <div style="font-size:18px;font-weight:600">${escapeHtml(e.id)}</div>
        </div>
      </div>
      <div>
        <h3 style="font-size:20px;margin-bottom:4px">${escapeHtml((e.title || '') + e.firstName + ' ' + e.lastName)}</h3>
        <div class="muted mb-2">${escapeHtml(e.positionTitle || pos.name || '')} • ${escapeHtml(dept.name || '')}</div>
        <div class="emp-info-grid mt-4">
          <div class="emp-info-row"><div class="label">ชื่อเล่น</div><div class="value">${escapeHtml(e.nickname || '-')}</div></div>
          <div class="emp-info-row"><div class="label">เพศ</div><div class="value">${escapeHtml(e.gender || '-')}</div></div>
          <div class="emp-info-row"><div class="label">วันเกิด</div><div class="value">${fmt.date(e.dob)} (${fmt.age(e.dob)})</div></div>
          <div class="emp-info-row"><div class="label">เลขบัตรประชาชน</div><div class="value">${escapeHtml(e.nationalId || '-')}</div></div>
          <div class="emp-info-row"><div class="label">เบอร์โทร</div><div class="value">${escapeHtml(e.phone || '-')}</div></div>
          <div class="emp-info-row"><div class="label">อีเมล</div><div class="value">${escapeHtml(e.email || '-')}</div></div>
          <div class="emp-info-row"><div class="label">วันเริ่มงาน</div><div class="value">${fmt.date(e.hireDate)} (${fmt.serviceYears(e.hireDate)})</div></div>
          <div class="emp-info-row"><div class="label">เงินเดือน</div><div class="value">${fmt.money(e.salary)}</div></div>
          <div class="emp-info-row span-2"><div class="label">ที่อยู่</div><div class="value">${escapeHtml(e.address || '-')}</div></div>
          <div class="emp-info-row span-2"><div class="label">หมายเหตุ</div><div class="value">${escapeHtml(e.note || '-')}</div></div>
        </div>
      </div>
    </div>

    <div class="tabs mt-4">
      <button class="tab active" data-tab="history">ประวัติเงินเดือน (${history.length})</button>
      <button class="tab" data-tab="loans">การกู้ (${loans.length})</button>
      <button class="tab" data-tab="advances">เบิกล่วงหน้า (${advances.length})</button>
      <button class="tab" data-tab="evals">ประเมิน (${evals.length})</button>
    </div>
    <div id="tabContent"></div>
  `, {
    size: 'lg',
    footer: `<button class="btn btn-secondary" data-close>ปิด</button><button class="btn btn-primary" onclick="window.print()">พิมพ์</button>`
  });

  const renderTab = (tab) => {
    const c = $('#tabContent');
    if (tab === 'history') {
      c.innerHTML = history.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>วันที่</th><th>เงินเดือนเก่า</th><th>เงินเดือนใหม่</th><th>ส่วนต่าง</th><th>เหตุผล</th></tr></thead><tbody>${history.map(h => `<tr><td>${fmt.date(h.date)}</td><td class="num">${fmt.money(h.oldSalary)}</td><td class="num">${fmt.money(h.newSalary)}</td><td class="num">${fmt.money(h.newSalary - h.oldSalary)}</td><td>${escapeHtml(h.reason || '-')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><div class="hint">ยังไม่มีประวัติการปรับเงินเดือน</div></div>';
    } else if (tab === 'loans') {
      c.innerHTML = loans.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>วันที่</th><th>จำนวน</th><th>ผ่อน/เดือน</th><th>คงเหลือ</th><th>สถานะ</th></tr></thead><tbody>${loans.map(l => `<tr><td>${fmt.date(l.date)}</td><td class="num">${fmt.money(l.amount)}</td><td class="num">${fmt.money(l.monthlyPayment)}</td><td class="num">${fmt.money(l.remaining)}</td><td>${l.status === 'completed' ? '<span class="badge badge-success">ปิดยอด</span>' : '<span class="badge badge-warning">ผ่อนอยู่</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><div class="hint">ยังไม่มีการกู้</div></div>';
    } else if (tab === 'advances') {
      c.innerHTML = advances.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>วันที่</th><th>จำนวน</th><th>เหตุผล</th><th>สถานะ</th></tr></thead><tbody>${advances.map(a => `<tr><td>${fmt.date(a.date)}</td><td class="num">${fmt.money(a.amount)}</td><td>${escapeHtml(a.reason || '-')}</td><td>${a.status === 'paid' ? '<span class="badge badge-success">จ่ายแล้ว</span>' : '<span class="badge badge-warning">รอจ่าย</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><div class="hint">ยังไม่มีการเบิกล่วงหน้า</div></div>';
    } else if (tab === 'evals') {
      c.innerHTML = evals.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>วันที่</th><th>คะแนน</th><th>เกรด</th><th>หมายเหตุ</th></tr></thead><tbody>${evals.map(v => `<tr><td>${fmt.date(v.date)}</td><td class="num">${v.score}/100</td><td><span class="badge badge-info">${escapeHtml(v.grade || '-')}</span></td><td>${escapeHtml(v.note || '-')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><div class="hint">ยังไม่มีการประเมิน</div></div>';
    }
  };
  renderTab('history');
  $$('#modalRoot .tab').forEach(t => t.addEventListener('click', () => {
    $$('#modalRoot .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    renderTab(t.dataset.tab);
  }));
}

function exportEmployeesXLSX() {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportEmployeesXLSX, 800); return; }
  const rows = DB.getEmployees().map(e => ({
    'รหัส': e.id, 'คำนำหน้า': e.title, 'ชื่อ': e.firstName, 'นามสกุล': e.lastName,
    'ชื่อเล่น': e.nickname, 'เลขบัตรประชาชน': e.nationalId, 'วันเกิด': e.dob, 'เพศ': e.gender,
    'เบอร์โทร': e.phone, 'อีเมล': e.email, 'ที่อยู่': e.address,
    'ฝ่าย': (DB.getDepartment(e.department) || {}).name || '',
    'ระดับตำแหน่ง': (DB.getPosition(e.position) || {}).name || '',
    'ตำแหน่ง': e.positionTitle, 'วันเริ่มงาน': e.hireDate, 'เงินเดือน': e.salary, 'สถานะ': e.status
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'พนักงาน');
  XLSX.writeFile(wb, `คชา-บราเธอร์ส-พนักงาน-${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast('ส่งออกไฟล์ Excel แล้ว', 'success');
}

// ═══════════════════════════════════════════════════════
//  PAGE: DEPARTMENTS
// ═══════════════════════════════════════════════════════
router.register('departments', () => {
  const depts = DB.getDepartments();
  const emps = DB.getEmployees({ status: 'active' });
  return `
    <div class="page-header">
      <h2>ฝ่าย / แผนก</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openDeptForm()">+ เพิ่มฝ่าย</button>' : ''}</div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>รหัส</th><th>ชื่อฝ่าย</th><th>หัวหน้าฝ่าย</th><th class="num">จำนวนพนักงาน</th><th>หมายเหตุ</th><th></th></tr></thead>
          <tbody>
            ${depts.map(d => {
              const mgr = d.manager ? DB.getEmployee(d.manager) : null;
              const count = emps.filter(e => e.department === d.id).length;
              return `<tr>
                <td><strong>${escapeHtml(d.id)}</strong></td>
                <td>${escapeHtml(d.name)}</td>
                <td>${mgr ? escapeHtml(mgr.firstName + ' ' + mgr.lastName) : '-'}</td>
                <td class="num">${count}</td>
                <td>${escapeHtml(d.note || '-')}</td>
                <td class="actions">${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openDeptForm('${d.id}')">แก้ไข</button><button class="btn btn-ghost btn-sm" onclick="deleteDept('${d.id}')">ลบ</button>` : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
});

function openDeptForm(id = null) {
  if (!requireAdmin()) return;
  const d = id ? DB.getDepartment(id) : { id: DB.nextDepartmentId(), name: '', manager: '', note: '' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไขฝ่าย' : 'เพิ่มฝ่าย', `
    <form id="deptForm">
      <div class="form-grid">
        <div class="form-group"><label>รหัส *</label><input name="id" value="${escapeHtml(d.id)}" required ${id ? 'readonly' : ''}/></div>
        <div class="form-group"><label>ชื่อฝ่าย *</label><input name="name" value="${escapeHtml(d.name)}" required/></div>
        <div class="form-group span-2"><label>หัวหน้าฝ่าย</label><select name="manager"><option value="">- ไม่ระบุ -</option>${emps.map(e => `<option value="${e.id}" ${d.manager === e.id ? 'selected' : ''}>${escapeHtml(e.id + ' — ' + e.firstName + ' ' + e.lastName)}</option>`).join('')}</select></div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="2">${escapeHtml(d.note)}</textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>`);
  $('#deptForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      await DB.saveDepartment(data);
      modal.close();
      toast('บันทึกข้อมูลฝ่ายแล้ว', 'success');
      router.go('departments');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteDept(id) {
  if (!requireAdmin()) return;
  const d = DB.getDepartment(id);
  if (!await modal.confirm('ลบฝ่าย', `ต้องการลบฝ่าย "${d.name}" ใช่หรือไม่?`)) return;
  try {
    const result = await DB.deleteDepartment(id);
    if (!result) toast('ลบไม่ได้ เพราะยังมีพนักงานในฝ่ายนี้', 'error');
    else { toast('ลบฝ่ายแล้ว', 'success'); router.go('departments'); }
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: POSITIONS
// ═══════════════════════════════════════════════════════
router.register('positions', () => {
  const ps = DB.getPositions();
  const emps = DB.getEmployees({ status: 'active' });
  return `
    <div class="page-header">
      <h2>ระดับตำแหน่ง</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openPositionForm()">+ เพิ่มระดับ</button>' : ''}</div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>รหัส</th><th>ระดับ</th><th class="num">เงินเดือนต่ำสุด</th><th class="num">เงินเดือนสูงสุด</th><th class="num">จำนวนพนักงาน</th><th></th></tr></thead>
          <tbody>
            ${ps.map(p => `<tr>
                <td><strong>${escapeHtml(p.id)}</strong></td>
                <td>${escapeHtml(p.name)}</td>
                <td class="num">${fmt.money(p.minSalary)}</td>
                <td class="num">${fmt.money(p.maxSalary)}</td>
                <td class="num">${emps.filter(e => e.position === p.id).length}</td>
                <td class="actions">${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openPositionForm('${p.id}')">แก้ไข</button><button class="btn btn-ghost btn-sm" onclick="deletePosition('${p.id}')">ลบ</button>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
});

function openPositionForm(id = null) {
  if (!requireAdmin()) return;
  const p = id ? DB.getPosition(id) : { id: DB.nextPositionId(), name: '', minSalary: 0, maxSalary: 0 };
  modal.open(id ? 'แก้ไขระดับตำแหน่ง' : 'เพิ่มระดับตำแหน่ง', `
    <form id="posForm">
      <div class="form-grid">
        <div class="form-group"><label>รหัส *</label><input name="id" value="${escapeHtml(p.id)}" required ${id ? 'readonly' : ''}/></div>
        <div class="form-group"><label>ชื่อระดับ *</label><input name="name" value="${escapeHtml(p.name)}" required/></div>
        <div class="form-group"><label>เงินเดือนต่ำสุด</label><input name="minSalary" type="number" min="0" value="${p.minSalary || 0}"/></div>
        <div class="form-group"><label>เงินเดือนสูงสุด</label><input name="maxSalary" type="number" min="0" value="${p.maxSalary || 0}"/></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>`);
  $('#posForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.minSalary = Number(data.minSalary); data.maxSalary = Number(data.maxSalary);
      await DB.savePosition(data);
      modal.close();
      toast('บันทึกแล้ว', 'success');
      router.go('positions');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deletePosition(id) {
  if (!requireAdmin()) return;
  const p = DB.getPosition(id);
  if (!await modal.confirm('ลบระดับ', `ต้องการลบระดับ "${p.name}" ใช่หรือไม่?`)) return;
  try {
    const result = await DB.deletePosition(id);
    if (!result) toast('ลบไม่ได้ เพราะยังมีพนักงานใช้ระดับนี้', 'error');
    else { toast('ลบแล้ว', 'success'); router.go('positions'); }
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: SALARY ADJUSTMENT
// ═══════════════════════════════════════════════════════
router.register('salary-adjust', () => {
  const history = DB.getSalaryHistory();
  return `
    <div class="page-header">
      <h2>ปรับเงินเดือน / ตำแหน่ง</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openSalaryAdjustForm()">+ บันทึกการปรับ</button>' : ''}</div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">ประวัติการปรับเงินเดือน</div></div>
      ${history.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>วันที่</th><th>พนักงาน</th><th class="num">เก่า</th><th class="num">ใหม่</th><th class="num">ส่วนต่าง</th><th>ตำแหน่งใหม่</th><th>เหตุผล</th></tr></thead>
          <tbody>
            ${history.map(h => { const e = DB.getEmployee(h.employeeId) || {}; return `<tr>
                <td>${fmt.date(h.date)}</td>
                <td>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))} <span class="muted-2">(${escapeHtml(h.employeeId)})</span></td>
                <td class="num">${fmt.money(h.oldSalary)}</td>
                <td class="num">${fmt.money(h.newSalary)}</td>
                <td class="num"><strong>${fmt.money(h.newSalary - h.oldSalary)}</strong></td>
                <td>${escapeHtml(h.newPositionTitle || '-')}</td>
                <td>${escapeHtml(h.reason || '-')}</td>
              </tr>`; }).join('')}
          </tbody>
        </table>
      </div>` : '<div class="empty-state"><div class="icon">💰</div><div class="title">ยังไม่มีการปรับเงินเดือน</div></div>'}
    </div>`;
});

function openSalaryAdjustForm() {
  if (!requireAdmin()) return;
  const emps = DB.getEmployees({ status: 'active' });
  const positions = DB.getPositions();
  modal.open('บันทึกการปรับเงินเดือน', `
    <form id="adjForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label><select name="employeeId" id="adjEmp" required><option value="">- เลือกพนักงาน -</option>${emps.map(e => `<option value="${e.id}">${escapeHtml(e.id + ' — ' + e.firstName + ' ' + e.lastName + ' (' + fmt.money(e.salary) + ')')}</option>`).join('')}</select></div>
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required/></div>
        <div class="form-group"><label>เงินเดือนเก่า</label><input id="adjOld" type="number" readonly /></div>
        <div class="form-group"><label>เงินเดือนใหม่ *</label><input name="newSalary" type="number" min="0" step="100" required/></div>
        <div class="form-group"><label>ระดับตำแหน่งใหม่</label><select name="newPosition"><option value="">- ไม่เปลี่ยน -</option>${positions.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select></div>
        <div class="form-group span-2"><label>ชื่อตำแหน่งใหม่</label><input name="newPositionTitle"/></div>
        <div class="form-group span-2"><label>เหตุผล</label><textarea name="reason" rows="2"></textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>`);
  $('#adjEmp').addEventListener('change', (e) => {
    const emp = DB.getEmployee(e.target.value);
    $('#adjOld').value = emp ? emp.salary : 0;
  });
  $('#adjForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      const emp = DB.getEmployee(data.employeeId);
      if (!emp) return;
      data.oldSalary = emp.salary;
      data.newSalary = Number(data.newSalary);
      await DB.addSalaryAdjustment(data);
      modal.close();
      toast('บันทึกการปรับเงินเดือนแล้ว', 'success');
      router.go('salary-adjust');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

// ═══════════════════════════════════════════════════════
//  PAGE: LOANS
// ═══════════════════════════════════════════════════════
router.register('loans', () => {
  const loans = DB.getLoans();
  return `
    <div class="page-header">
      <h2>การกู้เงินบริษัท</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openLoanForm()">+ บันทึกการกู้</button>' : ''}</div>
    </div>
    <div class="card">
      ${loans.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>วันที่</th><th>พนักงาน</th><th class="num">จำนวน</th><th class="num">ผ่อน/เดือน</th><th class="num">คงเหลือ</th><th>สถานะ</th><th>เหตุผล</th><th></th></tr></thead>
          <tbody>
            ${loans.map(l => { const e = DB.getEmployee(l.employeeId) || {}; return `<tr>
                <td>${fmt.date(l.date)}</td>
                <td>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</td>
                <td class="num">${fmt.money(l.amount)}</td>
                <td class="num">${fmt.money(l.monthlyPayment)}</td>
                <td class="num">${fmt.money(l.remaining)}</td>
                <td>${l.status === 'completed' ? '<span class="badge badge-success">ปิดยอด</span>' : '<span class="badge badge-warning">ผ่อนอยู่</span>'}</td>
                <td>${escapeHtml(l.reason || '-')}</td>
                <td class="actions">${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openLoanForm('${l.id}')">แก้ไข</button><button class="btn btn-ghost btn-sm" onclick="deleteLoanRec('${l.id}')">ลบ</button>` : ''}</td>
              </tr>`; }).join('')}
          </tbody>
        </table>
      </div>` : '<div class="empty-state"><div class="icon">🏦</div><div class="title">ยังไม่มีรายการกู้</div></div>'}
    </div>`;
});

function openLoanForm(id = null) {
  if (!requireAdmin()) return;
  const l = id ? DB.getLoans().find(x => x.id === id) : { id: '', employeeId: '', date: new Date().toISOString().slice(0, 10), amount: 0, monthlyPayment: 0, remaining: 0, status: 'active', reason: '' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไขการกู้' : 'บันทึกการกู้', `
    <form id="loanForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label><select name="employeeId" required><option value="">- เลือก -</option>${emps.map(e => `<option value="${e.id}" ${l.employeeId === e.id ? 'selected' : ''}>${escapeHtml(e.id + ' — ' + e.firstName + ' ' + e.lastName)}</option>`).join('')}</select></div>
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${l.date}" required/></div>
        <div class="form-group"><label>จำนวนที่กู้ *</label><input name="amount" type="number" min="0" value="${l.amount}" required/></div>
        <div class="form-group"><label>ผ่อนต่อเดือน</label><input name="monthlyPayment" type="number" min="0" value="${l.monthlyPayment}"/></div>
        <div class="form-group"><label>ยอดคงเหลือ</label><input name="remaining" type="number" min="0" value="${l.remaining}"/></div>
        <div class="form-group span-2"><label>สถานะ</label><select name="status"><option value="active" ${l.status === 'active' ? 'selected' : ''}>ผ่อนอยู่</option><option value="completed" ${l.status === 'completed' ? 'selected' : ''}>ปิดยอด</option></select></div>
        <div class="form-group span-2"><label>เหตุผล</label><textarea name="reason" rows="2">${escapeHtml(l.reason)}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  $('#loanForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.amount = Number(data.amount); data.monthlyPayment = Number(data.monthlyPayment); data.remaining = Number(data.remaining);
      if (id) data.id = id;
      await DB.saveLoan(data);
      modal.close();
      toast('บันทึกแล้ว', 'success');
      router.go('loans');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteLoanRec(id) {
  if (!requireAdmin()) return;
  if (!await modal.confirm('ลบรายการกู้', 'ยืนยันการลบ?')) return;
  try { await DB.deleteLoan(id); toast('ลบแล้ว', 'success'); router.go('loans'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: ADVANCES
// ═══════════════════════════════════════════════════════
router.register('advances', () => {
  const list = DB.getAdvances();
  return `
    <div class="page-header">
      <h2>เบิกเงินเดือนล่วงหน้า</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openAdvanceForm()">+ บันทึกการเบิก</button>' : ''}</div>
    </div>
    <div class="card">
      ${list.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>วันที่</th><th>พนักงาน</th><th class="num">จำนวน</th><th>เหตุผล</th><th>สถานะ</th><th></th></tr></thead>
          <tbody>
            ${list.map(a => { const e = DB.getEmployee(a.employeeId) || {}; return `<tr>
                <td>${fmt.date(a.date)}</td>
                <td>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</td>
                <td class="num">${fmt.money(a.amount)}</td>
                <td>${escapeHtml(a.reason || '-')}</td>
                <td>${a.status === 'paid' ? '<span class="badge badge-success">จ่ายแล้ว</span>' : '<span class="badge badge-warning">รอจ่าย</span>'}</td>
                <td class="actions">${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openAdvanceForm('${a.id}')">แก้ไข</button><button class="btn btn-ghost btn-sm" onclick="deleteAdvRec('${a.id}')">ลบ</button>` : ''}</td>
              </tr>`; }).join('')}
          </tbody>
        </table>
      </div>` : '<div class="empty-state"><div class="icon">💵</div><div class="title">ยังไม่มีรายการเบิก</div></div>'}
    </div>`;
});

function openAdvanceForm(id = null) {
  if (!requireAdmin()) return;
  const a = id ? DB.getAdvances().find(x => x.id === id) : { employeeId: '', date: new Date().toISOString().slice(0, 10), amount: 0, reason: '', status: 'pending' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไข' : 'บันทึกการเบิกล่วงหน้า', `
    <form id="advForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label><select name="employeeId" required><option value="">- เลือก -</option>${emps.map(e => `<option value="${e.id}" ${a.employeeId === e.id ? 'selected' : ''}>${escapeHtml(e.firstName + ' ' + e.lastName)}</option>`).join('')}</select></div>
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${a.date}" required/></div>
        <div class="form-group"><label>จำนวน *</label><input name="amount" type="number" min="0" value="${a.amount}" required/></div>
        <div class="form-group span-2"><label>สถานะ</label><select name="status"><option value="pending" ${a.status === 'pending' ? 'selected' : ''}>รอจ่าย</option><option value="paid" ${a.status === 'paid' ? 'selected' : ''}>จ่ายแล้ว</option></select></div>
        <div class="form-group span-2"><label>เหตุผล</label><textarea name="reason" rows="2">${escapeHtml(a.reason)}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  $('#advForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.amount = Number(data.amount);
      if (id) data.id = id;
      await DB.saveAdvance(data);
      modal.close();
      toast('บันทึกแล้ว', 'success');
      router.go('advances');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteAdvRec(id) {
  if (!requireAdmin()) return;
  if (!await modal.confirm('ลบ', 'ยืนยัน?')) return;
  try { await DB.deleteAdvance(id); toast('ลบแล้ว', 'success'); router.go('advances'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: ALLOWANCE
// ═══════════════════════════════════════════════════════
router.register('allowance', () => {
  const list = DB.getAllowances();
  return `
    <div class="page-header">
      <h2>เบี้ยเลี้ยงรายเดือน</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openAllowanceForm()">+ บันทึก</button>' : ''}</div>
    </div>
    <div class="card">
      ${list.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>เดือน</th><th>พนักงาน</th><th>ประเภท</th><th class="num">จำนวน</th><th>หมายเหตุ</th><th></th></tr></thead>
          <tbody>
            ${list.map(a => { const e = DB.getEmployee(a.employeeId) || {}; return `<tr>
                <td>${escapeHtml(a.month || '-')}</td>
                <td>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</td>
                <td>${escapeHtml(a.type || '-')}</td>
                <td class="num">${fmt.money(a.amount)}</td>
                <td>${escapeHtml(a.note || '-')}</td>
                <td class="actions">${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openAllowanceForm('${a.id}')">แก้ไข</button><button class="btn btn-ghost btn-sm" onclick="deleteAllowRec('${a.id}')">ลบ</button>` : ''}</td>
              </tr>`; }).join('')}
          </tbody>
        </table>
      </div>` : '<div class="empty-state"><div class="icon">📋</div><div class="title">ยังไม่มีรายการ</div></div>'}
    </div>`;
});

function openAllowanceForm(id = null) {
  if (!requireAdmin()) return;
  const a = id ? DB.getAllowances().find(x => x.id === id) : { employeeId: '', month: new Date().toISOString().slice(0, 7), type: 'ค่าเดินทาง', amount: 0, note: '' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไข' : 'บันทึกเบี้ยเลี้ยง', `
    <form id="allowForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label><select name="employeeId" required><option value="">- เลือก -</option>${emps.map(e => `<option value="${e.id}" ${a.employeeId === e.id ? 'selected' : ''}>${escapeHtml(e.firstName + ' ' + e.lastName)}</option>`).join('')}</select></div>
        <div class="form-group"><label>เดือน *</label><input name="month" type="month" value="${a.month}" required/></div>
        <div class="form-group"><label>ประเภท</label><select name="type">${['ค่าเดินทาง', 'ค่าโทรศัพท์', 'ค่าตำแหน่ง', 'ค่าครองชีพ', 'อื่นๆ'].map(t => `<option ${a.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="form-group span-2"><label>จำนวน *</label><input name="amount" type="number" min="0" value="${a.amount}" required/></div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="2">${escapeHtml(a.note)}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  $('#allowForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.amount = Number(data.amount);
      if (id) data.id = id;
      await DB.saveAllowance(data);
      modal.close();
      toast('บันทึกแล้ว', 'success');
      router.go('allowance');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteAllowRec(id) {
  if (!requireAdmin()) return;
  if (!await modal.confirm('ลบ', 'ยืนยัน?')) return;
  try { await DB.deleteAllowance(id); toast('ลบแล้ว', 'success'); router.go('allowance'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: EVALUATIONS
// ═══════════════════════════════════════════════════════
router.register('evaluations', () => {
  const list = DB.getEvaluations();
  return `
    <div class="page-header">
      <h2>ประเมินผลงาน</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openEvalForm()">+ บันทึกการประเมิน</button>' : ''}</div>
    </div>
    <div class="card">
      ${list.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>วันที่</th><th>พนักงาน</th><th>รอบ</th><th class="num">คะแนน</th><th>เกรด</th><th>หมายเหตุ</th><th></th></tr></thead>
          <tbody>
            ${list.map(v => { const e = DB.getEmployee(v.employeeId) || {}; return `<tr>
                <td>${fmt.date(v.date)}</td>
                <td>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</td>
                <td>${escapeHtml(v.period || '-')}</td>
                <td class="num">${v.score}/100</td>
                <td><span class="badge badge-info">${escapeHtml(v.grade || '-')}</span></td>
                <td>${escapeHtml(v.note || '-')}</td>
                <td class="actions">${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openEvalForm('${v.id}')">แก้ไข</button><button class="btn btn-ghost btn-sm" onclick="deleteEvalRec('${v.id}')">ลบ</button>` : ''}</td>
              </tr>`; }).join('')}
          </tbody>
        </table>
      </div>` : '<div class="empty-state"><div class="icon">📊</div><div class="title">ยังไม่มีการประเมิน</div></div>'}
    </div>`;
});

function scoreToGrade(s) {
  s = Number(s);
  if (s >= 90) return 'A';
  if (s >= 80) return 'B+';
  if (s >= 70) return 'B';
  if (s >= 60) return 'C';
  if (s >= 50) return 'D';
  return 'F';
}

function openEvalForm(id = null) {
  if (!requireAdmin()) return;
  const v = id ? DB.getEvaluations().find(x => x.id === id) : { employeeId: '', date: new Date().toISOString().slice(0, 10), period: 'ครึ่งปี ' + new Date().getFullYear(), score: 0, grade: 'C', note: '' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไข' : 'บันทึกการประเมิน', `
    <form id="evalForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label><select name="employeeId" required><option value="">- เลือก -</option>${emps.map(e => `<option value="${e.id}" ${v.employeeId === e.id ? 'selected' : ''}>${escapeHtml(e.firstName + ' ' + e.lastName)}</option>`).join('')}</select></div>
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${v.date}" required/></div>
        <div class="form-group"><label>รอบประเมิน</label><input name="period" value="${escapeHtml(v.period)}" placeholder="เช่น ครึ่งปี 2026"/></div>
        <div class="form-group"><label>คะแนน (0-100) *</label><input id="scoreInput" name="score" type="number" min="0" max="100" value="${v.score}" required/></div>
        <div class="form-group"><label>เกรด</label><input id="gradeInput" name="grade" value="${v.grade}" readonly/></div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="3">${escapeHtml(v.note)}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  $('#scoreInput').addEventListener('input', () => { $('#gradeInput').value = scoreToGrade($('#scoreInput').value); });
  $('#evalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.score = Number(data.score);
      if (id) data.id = id;
      await DB.saveEvaluation(data);
      modal.close();
      toast('บันทึกแล้ว', 'success');
      router.go('evaluations');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteEvalRec(id) {
  if (!requireAdmin()) return;
  if (!await modal.confirm('ลบ', 'ยืนยัน?')) return;
  try { await DB.deleteEvaluation(id); toast('ลบแล้ว', 'success'); router.go('evaluations'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: REPORTS
// ═══════════════════════════════════════════════════════
router.register('reports', () => {
  const s = DB.getStats();
  return `
    <div class="page-header"><h2>รายงาน / Export</h2></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon bg-primary">👥</div><div><div class="stat-label">พนักงานปฏิบัติงาน</div><div class="stat-value">${fmt.num(s.activeEmployees)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-green">💰</div><div><div class="stat-label">ค่าใช้จ่ายต่อเดือน</div><div class="stat-value">${fmt.money(s.totalMonthlySalary)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-blue">💰</div><div><div class="stat-label">ค่าใช้จ่ายต่อปี</div><div class="stat-value">${fmt.money(s.totalMonthlySalary * 12)}</div></div></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">ส่งออกข้อมูล</div></div>
      <div class="flex gap-2" style="flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="exportEmployeesXLSX()">📥 พนักงาน (Excel)</button>
        <button class="btn btn-secondary" onclick="exportPayrollXLSX()">📥 บัญชีเงินเดือน (Excel)</button>
        <button class="btn btn-secondary" onclick="exportLoansXLSX()">📥 รายการกู้ (Excel)</button>
        <button class="btn btn-secondary" onclick="exportDataJSON()">📥 สำรองข้อมูลทั้งหมด (JSON)</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">สรุปพนักงานตามฝ่าย</div></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>ฝ่าย</th><th class="num">จำนวน</th><th class="num">เงินเดือนรวม</th><th class="num">เฉลี่ย/คน</th></tr></thead>
          <tbody>
            ${DB.getDepartments().map(d => {
              const list = DB.getEmployees({ status: 'active' }).filter(e => e.department === d.id);
              const sum = list.reduce((s, e) => s + (e.salary || 0), 0);
              return `<tr><td>${escapeHtml(d.name)}</td><td class="num">${list.length}</td><td class="num">${fmt.money(sum)}</td><td class="num">${fmt.money(list.length ? sum / list.length : 0)}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
});

function exportPayrollXLSX() {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportPayrollXLSX, 800); return; }
  const month = new Date().toISOString().slice(0, 7);
  const rows = DB.getEmployees({ status: 'active' }).map(e => {
    const allow = DB.getAllowances(e.id).filter(a => a.month === month).reduce((s, a) => s + (a.amount || 0), 0);
    const adv = DB.getAdvances(e.id).filter(a => a.status === 'paid' && (a.date || '').startsWith(month)).reduce((s, a) => s + (a.amount || 0), 0);
    const loanDed = DB.getLoans(e.id).filter(l => l.status === 'active').reduce((s, l) => s + (l.monthlyPayment || 0), 0);
    const net = (e.salary || 0) + allow - adv - loanDed;
    return {
      'รหัส': e.id, 'ชื่อ-นามสกุล': (e.title || '') + e.firstName + ' ' + e.lastName,
      'ฝ่าย': (DB.getDepartment(e.department) || {}).name || '', 'ตำแหน่ง': e.positionTitle,
      'เงินเดือน': e.salary || 0, 'เบี้ยเลี้ยง': allow, 'หักเบิกล่วงหน้า': adv, 'หักผ่อนกู้': loanDed, 'รับสุทธิ': net
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'เงินเดือน ' + month);
  XLSX.writeFile(wb, `คชา-เงินเดือน-${month}.xlsx`);
  toast('ส่งออกบัญชีเงินเดือนแล้ว', 'success');
}

function exportLoansXLSX() {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportLoansXLSX, 800); return; }
  const rows = DB.getLoans().map(l => {
    const e = DB.getEmployee(l.employeeId) || {};
    return { 'วันที่': l.date, 'รหัสพนักงาน': l.employeeId, 'ชื่อ-นามสกุล': (e.firstName || '') + ' ' + (e.lastName || ''),
      'จำนวนกู้': l.amount, 'ผ่อน/เดือน': l.monthlyPayment, 'คงเหลือ': l.remaining,
      'สถานะ': l.status === 'completed' ? 'ปิดยอด' : 'ผ่อนอยู่', 'เหตุผล': l.reason };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'การกู้');
  XLSX.writeFile(wb, `คชา-รายการกู้-${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast('ส่งออกแล้ว', 'success');
}

function exportDataJSON() {
  const snapshot = { exportedAt: new Date().toISOString(), ...DB.data };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `คชา-ข้อมูลสำรอง-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('สำรองข้อมูลแล้ว', 'success');
}

// ═══════════════════════════════════════════════════════
//  PAGE: CALENDAR
// ═══════════════════════════════════════════════════════
router.register('calendar', () => {
  const items = DB.getCalendar();
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = items.filter(c => c.date >= today).slice(0, 5);
  return `
    <div class="page-header">
      <h2>ปฏิทิน HR</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openCalForm()">+ เพิ่มกิจกรรม</button>' : ''}</div>
    </div>
    ${upcoming.length ? `
    <div class="card">
      <div class="card-header"><div class="card-title">กิจกรรม / วันหยุดที่จะมาถึง</div></div>
      <div class="flex gap-3" style="flex-wrap:wrap">
        ${upcoming.map(c => `<div style="background:var(--surface-2);padding:12px 16px;border-radius:var(--radius);min-width:200px">
            <div class="muted-2" style="font-size:12px">${fmt.date(c.date)}</div>
            <div style="font-weight:500;margin-top:4px">${escapeHtml(c.title)}</div>
            <span class="badge badge-${c.type === 'holiday' ? 'danger' : c.type === 'event' ? 'info' : 'neutral'}" style="margin-top:6px;display:inline-block">${c.type === 'holiday' ? 'วันหยุด' : c.type === 'event' ? 'กิจกรรม' : 'อื่นๆ'}</span>
          </div>`).join('')}
      </div>
    </div>` : ''}
    <div class="card">
      <div class="card-header"><div class="card-title">ทั้งหมด</div></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>วันที่</th><th>หัวข้อ</th><th>ประเภท</th><th></th></tr></thead>
          <tbody>
            ${items.map(c => `<tr>
              <td>${fmt.date(c.date)}</td>
              <td>${escapeHtml(c.title)}</td>
              <td><span class="badge badge-${c.type === 'holiday' ? 'danger' : c.type === 'event' ? 'info' : 'neutral'}">${c.type === 'holiday' ? 'วันหยุด' : c.type === 'event' ? 'กิจกรรม' : 'อื่นๆ'}</span></td>
              <td class="actions">${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openCalForm('${c.id}')">แก้ไข</button><button class="btn btn-ghost btn-sm" onclick="deleteCalRec('${c.id}')">ลบ</button>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
});

function openCalForm(id = null) {
  if (!requireAdmin()) return;
  const c = id ? DB.getCalendar().find(x => x.id === id) : { date: new Date().toISOString().slice(0, 10), title: '', type: 'holiday' };
  modal.open(id ? 'แก้ไข' : 'เพิ่มกิจกรรม / วันหยุด', `
    <form id="calForm">
      <div class="form-grid">
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${c.date}" required/></div>
        <div class="form-group"><label>ประเภท</label><select name="type"><option value="holiday" ${c.type === 'holiday' ? 'selected' : ''}>วันหยุด</option><option value="event" ${c.type === 'event' ? 'selected' : ''}>กิจกรรม</option><option value="other" ${c.type === 'other' ? 'selected' : ''}>อื่นๆ</option></select></div>
        <div class="form-group span-2"><label>หัวข้อ *</label><input name="title" value="${escapeHtml(c.title)}" required/></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  $('#calForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (id) data.id = id;
      await DB.saveCalendarItem(data);
      modal.close();
      toast('บันทึกแล้ว', 'success');
      router.go('calendar');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteCalRec(id) {
  if (!requireAdmin()) return;
  if (!await modal.confirm('ลบ', 'ยืนยัน?')) return;
  try { await DB.deleteCalendarItem(id); toast('ลบแล้ว', 'success'); router.go('calendar'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: SETTINGS
// ═══════════════════════════════════════════════════════
router.register('settings', () => {
  const c = DB.data.company;
  return `
    <div class="page-header"><h2>ตั้งค่าระบบ</h2></div>

    <div class="card">
      <div class="card-header"><div class="card-title">ข้อมูลบริษัท</div></div>
      <form id="companyForm">
        <div class="form-grid">
          <div class="form-group span-2"><label>ชื่อบริษัท (ไทย)</label><input name="name" value="${escapeHtml(c.name)}" ${DB.isAdmin ? '' : 'disabled'}/></div>
          <div class="form-group span-2"><label>ชื่อบริษัท (อังกฤษ)</label><input name="nameEn" value="${escapeHtml(c.nameEn)}" ${DB.isAdmin ? '' : 'disabled'}/></div>
          <div class="form-group"><label>เลขทะเบียนภาษี</label><input name="taxId" value="${escapeHtml(c.taxId)}" ${DB.isAdmin ? '' : 'disabled'}/></div>
          <div class="form-group"><label>โทรศัพท์</label><input name="phone" value="${escapeHtml(c.phone)}" ${DB.isAdmin ? '' : 'disabled'}/></div>
          <div class="form-group span-2"><label>อีเมล</label><input name="email" value="${escapeHtml(c.email)}" ${DB.isAdmin ? '' : 'disabled'}/></div>
          <div class="form-group span-2"><label>ที่อยู่</label><textarea name="address" rows="2" ${DB.isAdmin ? '' : 'disabled'}>${escapeHtml(c.address)}</textarea></div>
        </div>
        ${DB.isAdmin ? '<div class="form-actions"><button type="submit" class="btn btn-primary">บันทึกข้อมูลบริษัท</button></div>' : ''}
      </form>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">เปลี่ยนรหัสผ่าน</div></div>
      <form id="pwForm">
        <div class="form-grid">
          <div class="form-group"><label>รหัสผ่านใหม่</label><input name="new" type="password" required minlength="8" autocomplete="new-password"/></div>
          <div class="form-group"><label>ยืนยันรหัสผ่านใหม่</label><input name="confirm" type="password" required minlength="8" autocomplete="new-password"/></div>
        </div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">เปลี่ยนรหัสผ่าน</button></div>
      </form>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">ข้อมูลและการสำรอง</div></div>
      <div class="flex gap-2" style="flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="exportDataJSON()">📥 ดาวน์โหลดข้อมูลสำรอง (snapshot)</button>
      </div>
      <div class="muted-2 mt-2" style="font-size:12px">ข้อมูลจริงเก็บใน Supabase (cloud) — มี backup อัตโนมัติของ Supabase + ดาวน์โหลด snapshot สำรองเพิ่มได้ที่นี่</div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">ข้อมูลระบบ</div></div>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">ผู้ใช้ปัจจุบัน</div><div class="value">${escapeHtml(DB.user?.email || '-')}</div></div>
        <div class="emp-info-row"><div class="label">บทบาท</div><div class="value">${DB.isAdmin ? '<span class="badge badge-success">Admin</span>' : '<span class="badge badge-neutral">Viewer</span>'}</div></div>
        <div class="emp-info-row"><div class="label">Backend</div><div class="value">Supabase (Cloud + Realtime)</div></div>
      </div>
    </div>
  `;
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'companyForm') {
    e.preventDefault();
    if (!requireAdmin()) return;
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      await DB.saveCompany(data);
      toast('บันทึกข้อมูลบริษัทแล้ว', 'success');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  } else if (e.target.id === 'pwForm') {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    if (data.new !== data.confirm) return toast('รหัสผ่านใหม่ไม่ตรงกัน', 'error');
    try {
      await DB.changePassword(data.new);
      toast('เปลี่ยนรหัสผ่านแล้ว', 'success');
      e.target.reset();
    } catch (ex) { toast('เปลี่ยนไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  }
});

// ═══════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // UI wiring (works without auth)
  $$('.nav-item').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); router.go(a.dataset.page); }));
  $('#hamburger').addEventListener('click', () => $('#sidebar').classList.add('open'));
  $('#sidebarClose').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#themeToggle').addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('kb_theme', isDark ? 'light' : 'dark');
    if (router.current === 'dashboard') router.go('dashboard');
  });
  $('#topbarDate').textContent = fmt.dateLong(new Date());

  auth.init();

  // Try to restore session from Supabase
  try {
    await DB.init();
    if (DB.user && DB.profile) {
      auth.showApp();
    } else {
      auth.showLogin();
    }
  } catch (ex) {
    console.error('Init error:', ex);
    auth.showLogin();
  }
});
