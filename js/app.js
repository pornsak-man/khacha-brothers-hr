/* ═══════════════════════════════════════════════════════════
   KHACHA BROTHERS HR — APP LOGIC (Supabase + Realtime)
   ═══════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ─── TIMEZONE: บังคับใช้เวลาประเทศไทย (Asia/Bangkok) ───
// ทุก default/computed date ใช้เวลาไทย ไม่ขึ้นกับ browser/server TZ
const TZ = 'Asia/Bangkok';
const tz = {
  // วันนี้ในรูปแบบ YYYY-MM-DD ตามเวลาไทย
  today: () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }),
  // เดือนนี้ YYYY-MM ตามเวลาไทย
  thisMonth: () => tz.today().slice(0, 7),
  // ปีปัจจุบัน ค.ศ. ตามเวลาไทย
  thisYear: () => parseInt(tz.today().slice(0, 4), 10)
};

// parse "YYYY-MM-DD" → [year, month(1-12), day] — ไม่ผ่าน Date object เพื่อเลี่ยง TZ issues
function parseYMD(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// แปลง "YYYY-MM-DD" → Excel Date — ทำให้สูตรวันที่ใน Excel ทำงานได้ตรงๆ
function excelDate(s) {
  const ymd = parseYMD(s);
  if (!ymd) return s || '';
  // ใช้ local-time midnight — XLSX ใช้ local TZ คำนวณ Excel serial = วันที่ถูกต้องไม่มีเศษเวลา
  return new Date(ymd[0], ymd[1] - 1, ymd[2]);
}

// Helper: ใส่ format code ให้ทุก cell ในคอลัมน์ (สำหรับ เลขประชาชน "0", หรืออื่นๆ)
function setColumnFormat(ws, colIndex, formatCode) {
  if (!ws['!ref']) return;
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: colIndex });
    if (ws[ref]) ws[ref].z = formatCode;
  }
}

// แปลง string ตัวเลขล้วน → number — ทำให้ Excel เก็บเป็น number cell (รองรับ SUM, VLOOKUP เลข)
function excelNum(s) {
  if (s == null || s === '') return '';
  if (typeof s === 'number') return s;
  const str = String(s).trim();
  if (/^\d+$/.test(str)) return Number(str);
  return str;
}

const fmt = {
  money: (n) => (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
  num: (n) => (Number(n) || 0).toLocaleString('th-TH'),
  date: (d) => {
    if (!d) return '-';
    const ymd = parseYMD(d);
    if (ymd) {
      // สร้าง Date จาก components — แสดงตามเวลาไทยเสมอ
      return new Date(ymd[0], ymd[1] - 1, ymd[2]).toLocaleDateString('th-TH', {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    }
    try { return new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric', timeZone: TZ }); }
    catch (e) { return d; }
  },
  dateLong: (d) => {
    if (!d) return '-';
    try {
      return new Date(d).toLocaleDateString('th-TH', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: TZ
      });
    } catch (e) { return d; }
  },
  age: (dob) => {
    const b = parseYMD(dob);
    if (!b) return '-';
    const t = parseYMD(tz.today());
    let age = t[0] - b[0];
    if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) age--;
    if (age < 0) return '-';
    return age + ' ปี';
  },
  serviceYears: (hireDate, endDate = null) => {
    const s = parseYMD(hireDate);
    if (!s) return '-';
    const e = parseYMD(endDate) || parseYMD(tz.today());
    let years = e[0] - s[0];
    let months = e[1] - s[1];
    if (e[2] < s[2]) months--;
    if (months < 0) { years--; months += 12; }
    if (years < 0) return '-';
    return years + ' ปี ' + months + ' เดือน';
  }
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── SVG ICONS (Lucide-style stroke icons) ───
const ICON = {
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 8h3"/><path d="M14 12h3"/><path d="M14 16h3"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12"/><path d="M15 9.5C15 8.12 13.66 7 12 7s-3 1.12-3 2.5S10.34 12 12 12s3 1.12 3 2.5-1.34 2.5-3 2.5-3-1.12-3-2.5"/></svg>',
  trendUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
  bank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01"/><path d="M18 12h.01"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  upload: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
};

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
  _historyPushed: false,
  open(title, bodyHtml, opts = {}) {
    const root = $('#modalRoot');
    const sizeCls = opts.size === 'lg' ? ' lg' : '';
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal${sizeCls}">
          <div class="modal-header">
            <div class="modal-title">${escapeHtml(title)}</div>
            <button class="modal-close" data-close title="ปิด (ESC)" aria-label="ปิด">&times;</button>
          </div>
          <div class="modal-body">${bodyHtml}</div>
          ${opts.footer ? `<div class="modal-footer">${opts.footer}</div>` : ''}
        </div>
      </div>`;
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop') || e.target.dataset.close !== undefined) this.close();
    });
    // Push history state — browser back button จะปิด modal แทนการออกจากเว็บ
    if (!this._historyPushed) {
      history.pushState({ kbModal: true }, '');
      this._historyPushed = true;
    }
    return root.querySelector('.modal');
  },
  close(skipHistory = false) {
    const root = $('#modalRoot');
    if (!root.children.length) return;
    root.innerHTML = '';
    if (this._historyPushed && !skipHistory && history.state?.kbModal) {
      this._historyPushed = false;
      history.back();
    } else {
      this._historyPushed = false;
    }
  },
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
      departments: 'ฝ่าย',
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
  const yearly = DB.getYearlyHireExit();
  const monthly = yearly.months;
  const branchStats = DB.getBranchStats();
  window.afterRender = () => renderDashboardCharts(s, monthly, branchStats);

  const totalEmps = s.totalEmployees;
  const activeEmps = s.activeEmployees;
  const resignedEmps = totalEmps - activeEmps;
  const branchCount = DB.getBranches().length;
  const thisMonth = monthly[monthly.length - 1] || { hires: 0, exits: 0 };
  const pendingTerm = DB.data.employees.filter(e => DB.empStatus(e) === 'pending').length;

  return `
    <div class="dashboard-hero">
      <div class="hero-content">
        <div class="hero-label">พนักงานทั้งหมดในระบบ</div>
        <div class="hero-value">${fmt.num(totalEmps)}</div>
        <div class="hero-stats">
          <div class="hero-stat-item"><span class="dot dot-green"></span>ปฏิบัติงาน <strong>${fmt.num(activeEmps)}</strong></div>
          ${pendingTerm ? `<div class="hero-stat-item"><span class="dot dot-yellow"></span>นัดพ้นสภาพ <strong>${fmt.num(pendingTerm)}</strong></div>` : ''}
          <div class="hero-stat-item"><span class="dot dot-red"></span>พ้นสภาพ <strong>${fmt.num(resignedEmps)}</strong></div>
          <div class="hero-stat-item">ฝ่าย <strong>${fmt.num(s.departments)}</strong></div>
          <div class="hero-stat-item">สาขา <strong>${fmt.num(branchCount)}</strong></div>
        </div>
      </div>
      <div class="hero-mini">
        <div class="hero-mini-label">เดือนนี้</div>
        <div class="hero-mini-row">
          <div class="hero-mini-stat green">
            <div class="hero-mini-num">+${fmt.num(thisMonth.hires)}</div>
            <div class="hero-mini-cap">เข้างาน</div>
          </div>
          <div class="hero-mini-stat red">
            <div class="hero-mini-num">−${fmt.num(thisMonth.exits)}</div>
            <div class="hero-mini-cap">พ้นสภาพ</div>
          </div>
        </div>
      </div>
      ${DB.isAdmin ? `<button class="btn btn-primary hero-cta" onclick="openEmployeeForm()">+ เพิ่มพนักงาน</button>` : ''}
    </div>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon bg-green">${ICON.money}</div><div class="stat-content"><div class="stat-label">เงินเดือนรวม / เดือน</div><div class="stat-value">${fmt.money(s.totalMonthlySalary)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-orange">${ICON.bank}</div><div class="stat-content"><div class="stat-label">การกู้ที่ยังไม่ปิด</div><div class="stat-value">${fmt.num(s.activeLoans)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-purple">${ICON.cash}</div><div class="stat-content"><div class="stat-label">เบิกล่วงหน้ารอจ่าย</div><div class="stat-value">${fmt.num(s.pendingAdvances)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-red">${ICON.calendar}</div><div class="stat-content"><div class="stat-label">วันหยุดในปฏิทิน</div><div class="stat-value">${fmt.num(DB.getCalendar().length)}</div></div></div>
    </div>

    <div class="card">
      <div class="card-header" style="flex-direction:column;align-items:flex-start;gap:4px;margin-bottom:20px">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.02em;color:var(--text)">พนักงานเข้า / ออก ประจำปี ${yearly.year}</div>
        <div class="muted-2" style="font-size:13px">เปรียบเทียบจำนวนเข้าใหม่ (เขียว) กับพ้นสภาพ (แดง) แต่ละเดือน</div>
      </div>
      <canvas id="chartMonthly" style="max-height:280px"></canvas>
    </div>

    <div class="card">
      <div class="card-header" style="flex-direction:column;align-items:flex-start;gap:4px;margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;width:100%;gap:16px;flex-wrap:wrap">
          <div>
            <div style="font-size:18px;font-weight:700;letter-spacing:-0.02em;color:var(--text)">พนักงานตามสาขา</div>
            <div class="muted-2" style="font-size:13px;margin-top:4px">เรียงจำนวนพนักงานจากมาก → น้อย</div>
          </div>
          <div class="muted-2" style="font-size:12.5px">รวม <strong style="color:var(--text)">${branchStats.length}</strong> สาขา · <strong style="color:var(--text)">${fmt.num(branchStats.reduce((sum, b) => sum + b.count, 0))}</strong> คน</div>
        </div>
      </div>
      ${(() => {
        if (!branchStats.length) return '<div class="muted-2 text-center" style="padding:24px">ไม่มีข้อมูลสาขา</div>';
        const maxCount = Math.max(...branchStats.map(b => b.count));
        return `<div class="branch-list">${branchStats.map((b, i) => `
          <div class="branch-row">
            <div class="branch-rank">${i + 1}</div>
            <div class="branch-code">${escapeHtml(b.branch)}</div>
            <div class="branch-bar"><div class="branch-bar-fill" style="width:${(b.count / maxCount * 100).toFixed(1)}%"></div></div>
            <div class="branch-count">${fmt.num(b.count)}</div>
          </div>`).join('')}</div>`;
      })()}
    </div>

    <div class="chart-row">
      <div class="chart-box"><div class="card-header"><div class="card-title">พนักงานตามฝ่าย</div></div><canvas id="chartByDept"></canvas></div>
      <div class="chart-box"><div class="card-header"><div class="card-title">สัดส่วนเพศ</div></div><canvas id="chartByGender"></canvas></div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">พนักงานเข้างานล่าสุด</div></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>ตำแหน่ง</th><th>สาขา</th><th>วันเริ่มงาน</th></tr></thead>
          <tbody>
            ${DB.getEmployees().sort((a, b) => (b.hireDate || '').localeCompare(a.hireDate || '')).slice(0, 8).map(e => `
              <tr>
                <td><strong>${escapeHtml(e.id)}</strong></td>
                <td>${escapeHtml((e.title || '') + e.firstName + ' ' + e.lastName)}</td>
                <td>${escapeHtml(e.positionTitle || '-')}</td>
                <td>${escapeHtml(e.branch || '-')}</td>
                <td>${fmt.date(e.hireDate)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
});

function renderDashboardCharts(s, monthly, branchStats) {
  if (typeof Chart === 'undefined') { setTimeout(() => renderDashboardCharts(s, monthly, branchStats), 200); return; }
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  Chart.defaults.color = isDark ? '#c9cfd6' : '#525249';
  Chart.defaults.font.family = 'Prompt, sans-serif';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';

  // ── Monthly hire/exit chart — outline-style bars (Jan-Dec ของปีปัจจุบัน) ──
  const ctxM = $('#chartMonthly');
  if (ctxM && monthly) {
    const labels = monthly.map(m => {
      const d = new Date(m.year, m.month - 1, 1);
      return d.toLocaleDateString('th-TH', { month: 'short' });
    });
    new Chart(ctxM, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'เข้าใหม่',
            data: monthly.map(m => m.hires),
            backgroundColor: 'rgba(22, 163, 74, 0.12)',
            borderColor: '#16a34a',
            borderWidth: 2,
            borderRadius: 8,
            borderSkipped: false,
            barPercentage: 0.55,
            categoryPercentage: 0.7
          },
          {
            label: 'พ้นสภาพ',
            data: monthly.map(m => m.exits),
            backgroundColor: 'rgba(220, 38, 38, 0.12)',
            borderColor: '#dc2626',
            borderWidth: 2,
            borderRadius: 8,
            borderSkipped: false,
            barPercentage: 0.55,
            categoryPercentage: 0.7
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top', align: 'center',
            labels: { usePointStyle: true, pointStyle: 'rectRounded', padding: 18, boxWidth: 14, boxHeight: 14, font: { size: 13 } }
          },
          tooltip: { mode: 'index', intersect: false }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 12 } } },
          y: { beginAtZero: true, ticks: { stepSize: 2, precision: 0, font: { size: 12 } }, grid: { color: gridColor } }
        }
      }
    });
  }

  // (Branch distribution ใช้ HTML list — ไม่ใช้ Chart.js แล้ว)

  const ctx1 = $('#chartByDept');
  if (ctx1) new Chart(ctx1, {
    type: 'bar',
    data: { labels: s.byDepartment.map(d => d.name), datasets: [{ label: 'จำนวน', data: s.byDepartment.map(d => d.count), backgroundColor: '#1e3a8a', borderRadius: 8, borderSkipped: false }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: gridColor } } } }
  });
  const ctx2 = $('#chartByGender');
  if (ctx2) new Chart(ctx2, {
    type: 'doughnut',
    data: { labels: ['ชาย', 'หญิง'], datasets: [{ data: [s.byGender.male, s.byGender.female], backgroundColor: ['#3b82f6', '#f472b6'], borderWidth: 0, hoverOffset: 8 }] },
    options: { responsive: true, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle' } } } }
  });
}

// ═══════════════════════════════════════════════════════
//  PAGE: EMPLOYEES
// ═══════════════════════════════════════════════════════
const empState = { search: '', branch: '', position: '', status: 'active', sortBy: '', sortDir: 'asc', page: 1, pageSize: 50 };
let _empSearchTimer = null;

router.register('employees', () => {
  return `
    <div class="page-header">
      <h2>ทะเบียนพนักงาน</h2>
      <div class="actions">
        <button class="btn btn-secondary" onclick="exportEmployeesXLSX()">${ICON.download}Export Excel</button>
        ${DB.isAdmin ? `<button class="btn btn-secondary" onclick="openImportEmployees()">${ICON.upload}นำเข้า Excel</button>
        <button class="btn btn-secondary" onclick="openBulkPhotoUpload()">${ICON.upload}อัปโหลดรูปหลายรูป</button>
        <button class="btn btn-primary" onclick="openEmployeeForm()">+ เพิ่มพนักงาน</button>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="toolbar">
        <input class="search-input" id="empSearch" placeholder="ค้นหา ชื่อ / รหัส / ชื่อเล่น / ตำแหน่ง / เลขประชาชน..." value="${escapeHtml(empState.search)}" />
        <select class="filter-select" id="empBranch">
          <option value="">ทุกสาขา</option>
          ${DB.getBranches().map(b => `<option value="${escapeHtml(b)}" ${empState.branch === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>
        ${(() => {
          const ps = DB.getPositions();
          const kitchen = [], ops = [], common = [];
          for (const p of ps) {
            const n = (p.name || '').toLowerCase();
            if (n.includes('chef') || n.includes('barista')) kitchen.push(p);
            else if (n.includes('part')) common.push(p);
            else ops.push(p);
          }
          const byLv = (a, b) => (b.level || 0) - (a.level || 0) || (a.name || '').localeCompare(b.name || '');
          ops.sort(byLv); kitchen.sort(byLv); common.sort(byLv);
          const opt = (arr) => arr.map(p => `<option value="${p.id}" ${empState.position === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
          return `<select class="filter-select" id="empPosition">
            <option value="">ทุกตำแหน่ง</option>
            ${ops.length ? `<optgroup label="ฝ่ายปฏิบัติการ">${opt(ops)}</optgroup>` : ''}
            ${kitchen.length ? `<optgroup label="ฝ่ายครัว">${opt(kitchen)}</optgroup>` : ''}
            ${common.length ? `<optgroup label="อื่นๆ">${opt(common)}</optgroup>` : ''}
          </select>`;
        })()}
        <select class="filter-select" id="empStatus">
          <option value="">ทุกสถานะ</option>
          <option value="active" ${empState.status === 'active' ? 'selected' : ''}>ปฏิบัติงาน</option>
          <option value="pending" ${empState.status === 'pending' ? 'selected' : ''}>นัดพ้นสภาพ</option>
          <option value="resigned" ${empState.status === 'resigned' ? 'selected' : ''}>พ้นสภาพแล้ว</option>
        </select>
      </div>
      <div id="empList"></div>
    </div>
  `;
});

function wireEmployeePage() {
  renderEmployeeList();
  $('#empSearch')?.addEventListener('input', (e) => {
    // debounce 200ms — ไม่ filter ทุก keystroke
    clearTimeout(_empSearchTimer);
    _empSearchTimer = setTimeout(() => {
      empState.search = e.target.value;
      empState.page = 1;
      renderEmployeeList();
    }, 200);
  });
  $('#empBranch')?.addEventListener('change', (e) => { empState.branch = e.target.value; empState.page = 1; renderEmployeeList(); });
  $('#empPosition')?.addEventListener('change', (e) => { empState.position = e.target.value; empState.page = 1; renderEmployeeList(); });
  $('#empStatus')?.addEventListener('change', (e) => { empState.status = e.target.value; empState.page = 1; renderEmployeeList(); });

  // คลิกหัวคอลัมน์ที่มี class .sortable → toggle sort
  $('#empList')?.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const field = th.dataset.sort;
    if (empState.sortBy === field) {
      empState.sortDir = empState.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      empState.sortBy = field;
      empState.sortDir = 'asc';
    }
    empState.page = 1;
    renderEmployeeList();
  });
}

// Helper: sort indicator HTML for table headers
function sortIcon(field) {
  if (empState.sortBy !== field) return '<span class="sort-icon">↕</span>';
  return empState.sortDir === 'asc'
    ? '<span class="sort-icon active">↑</span>'
    : '<span class="sort-icon active">↓</span>';
}

// Helper: apply sort to employee list based on empState.sortBy/sortDir
function applyEmpSort(list) {
  const field = empState.sortBy;
  if (!field) return list;
  const dir = empState.sortDir === 'desc' ? -1 : 1;
  const todayYMD = parseYMD(tz.today());
  const numeric = (s) => parseInt(String(s || '').replace(/\D/g, ''), 10) || 0;
  const cmpStr = (a, b) => String(a || '').localeCompare(String(b || ''));
  const cmpNum = (a, b) => a - b;
  const monthsBetween = (d) => {
    if (!d) return -1;
    const ymd = parseYMD(d);
    if (!ymd || !todayYMD) return -1;
    return (todayYMD[0] - ymd[0]) * 12 + (todayYMD[1] - ymd[1]);
  };
  const ageYears = (d) => {
    if (!d) return -1;
    const ymd = parseYMD(d);
    if (!ymd || !todayYMD) return -1;
    return todayYMD[0] - ymd[0];
  };
  return list.slice().sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'id': cmp = cmpNum(numeric(a.id), numeric(b.id)); break;
      case 'firstName': cmp = cmpStr(a.firstName, b.firstName); break;
      case 'lastName': cmp = cmpStr(a.lastName, b.lastName); break;
      case 'positionTitle': cmp = cmpStr(a.positionTitle, b.positionTitle); break;
      case 'branch': cmp = cmpStr(a.branch, b.branch); break;
      case 'hireDate': cmp = cmpStr(a.hireDate, b.hireDate); break;
      case 'serviceMonths': cmp = cmpNum(monthsBetween(a.hireDate), monthsBetween(b.hireDate)); break;
      case 'age': cmp = cmpNum(ageYears(a.dob), ageYears(b.dob)); break;
      case 'salary': cmp = cmpNum(Number(a.salary || 0), Number(b.salary || 0)); break;
      case 'terminationDate': cmp = cmpStr(a.terminationDate || '', b.terminationDate || ''); break;
      default: return 0;
    }
    return cmp * dir;
  });
}

function avatarThumb(e) {
  if (e.photoUrl) return `<img src="${escapeHtml(e.photoUrl)}" class="avatar-thumb" alt="" loading="lazy">`;
  const initial = escapeHtml((e.firstName || '?').charAt(0));
  return `<div class="avatar-thumb avatar-thumb-text">${initial}</div>`;
}

function renderEmployeeList() {
  const filtered = DB.getEmployees(empState);
  const allList = applyEmpSort(filtered);
  const total = allList.length;
  const pageSize = empState.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (empState.page > totalPages) empState.page = totalPages;
  const start = (empState.page - 1) * pageSize;
  const list = allList.slice(start, start + pageSize);

  const container = $('#empList');
  if (!container) return;
  if (!total) {
    container.innerHTML = `<div class="empty-state"><div class="icon">${ICON.users}</div><div class="title">ไม่พบพนักงาน</div><div class="hint">ลองเปลี่ยนตัวกรอง หรือเพิ่มพนักงานใหม่</div></div>`;
    return;
  }
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table table-compact">
        <thead>
          <tr>
            <th class="num">ลำดับ</th>
            <th class="sortable" data-sort="id">รหัสพนักงาน ${sortIcon('id')}</th>
            <th class="sortable" data-sort="firstName">ชื่อ ${sortIcon('firstName')}</th>
            <th class="sortable" data-sort="lastName">สกุล ${sortIcon('lastName')}</th>
            <th>ชื่อเล่น</th>
            <th class="sortable" data-sort="positionTitle">ตำแหน่ง ${sortIcon('positionTitle')}</th>
            <th class="sortable" data-sort="branch">สาขา ${sortIcon('branch')}</th>
            <th>ฝ่าย</th>
            <th class="sortable" data-sort="hireDate">วันเริ่มงาน ${sortIcon('hireDate')}</th>
            <th class="sortable" data-sort="serviceMonths">อายุงาน ${sortIcon('serviceMonths')}</th>
            <th class="num sortable" data-sort="age">อายุ ${sortIcon('age')}</th>
            <th class="num sortable" data-sort="salary">เงินเดือน ${sortIcon('salary')}</th>
            <th class="sortable" data-sort="terminationDate">วันพ้นสภาพ ${sortIcon('terminationDate')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${list.map((e, i) => `
            <tr>
              <td class="num muted-2">${start + i + 1}</td>
              <td><strong>${escapeHtml(e.id)}</strong></td>
              <td>${escapeHtml((e.title || '') + e.firstName)}</td>
              <td>${escapeHtml(e.lastName)}</td>
              <td>${escapeHtml(e.nickname || '-')}</td>
              <td>${escapeHtml(e.positionTitle || '-')}</td>
              <td>${escapeHtml(e.branch || '-')}</td>
              <td>${escapeHtml((DB.getDepartment(e.department) || {}).name || '-')}</td>
              <td>${fmt.date(e.hireDate)}</td>
              <td>${fmt.serviceYears(e.hireDate, e.terminationDate)}</td>
              <td class="num">${e.dob ? fmt.age(e.dob).replace(' ปี', '') : '-'}</td>
              <td class="num">${fmt.money(e.salary)}</td>
              <td>${(() => {
                const st = DB.empStatus(e);
                if (st === 'active') return '<span class="badge badge-success">ปฏิบัติงาน</span>';
                if (st === 'pending') return `<span class="badge badge-warning" title="ยังปฏิบัติงาน — มีนัดพ้นสภาพ">นัด ${fmt.date(e.terminationDate)}</span>`;
                return `<span class="badge badge-danger">${fmt.date(e.terminationDate)}</span>`;
              })()}</td>
              <td class="actions">
                <button class="btn btn-ghost btn-sm" onclick="viewEmployee('${e.id}')">ดู</button>
                ${DB.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openEmployeeForm('${e.id}')">แก้</button>
                <button class="btn btn-ghost btn-sm" onclick="deleteEmployee('${e.id}')">ลบ</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${renderPagination(total, empState.page, pageSize)}
  `;
}

function renderPagination(total, current, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (current - 1) * pageSize + 1;
  const end = Math.min(current * pageSize, total);
  // คำนวณหน้าที่จะแสดง (compact pagination)
  const pages = [];
  pages.push(1);
  if (current - 2 > 2) pages.push('…');
  for (let p = Math.max(2, current - 1); p <= Math.min(totalPages - 1, current + 1); p++) pages.push(p);
  if (current + 2 < totalPages - 1) pages.push('…');
  if (totalPages > 1) pages.push(totalPages);
  const unique = [...new Set(pages)];

  return `
    <div class="pagination">
      <div class="pagination-info">แสดง ${start.toLocaleString()}–${end.toLocaleString()} จาก ${total.toLocaleString()} คน</div>
      <div class="pagination-controls">
        <button class="btn-page" ${current === 1 ? 'disabled' : ''} onclick="gotoEmpPage(${current - 1})" aria-label="หน้าก่อนหน้า">‹</button>
        ${unique.map(p => p === '…'
          ? '<span class="page-ellipsis">…</span>'
          : `<button class="btn-page ${p === current ? 'active' : ''}" onclick="gotoEmpPage(${p})">${p}</button>`).join('')}
        <button class="btn-page" ${current === totalPages ? 'disabled' : ''} onclick="gotoEmpPage(${current + 1})" aria-label="หน้าถัดไป">›</button>
      </div>
    </div>
  `;
}

function gotoEmpPage(p) {
  empState.page = p;
  renderEmployeeList();
  // เลื่อนไปบนสุดของ table อย่างนุ่มนวล
  $('.content')?.scrollTo({ top: 0, behavior: 'smooth' });
}

// ดรอปดาวน์ / datalist สำหรับฟอร์มพนักงาน
const EMP_OPTIONS = {
  titles: ['นาย', 'นาง', 'นางสาว', 'เด็กชาย', 'เด็กหญิง', 'ดร.', 'นพ.', 'พญ.'],
  genders: ['ชาย', 'หญิง'],
  empTypes: ['พนักงานประจำ', 'พนักงานรายวัน', 'พนักงานสัญญาจ้าง', 'พนักงานทดลองงาน', 'ฝึกงาน', 'พาร์ทไทม์'],
  educations: ['ประถมศึกษา', 'มัธยมศึกษาตอนต้น (ม.3)', 'มัธยมศึกษาตอนปลาย (ม.6)', 'ปวช.', 'ปวส. / อนุปริญญา', 'ปริญญาตรี', 'ปริญญาโท', 'ปริญญาเอก', 'อื่นๆ'],
  religions: ['พุทธ', 'คริสต์', 'อิสลาม', 'ฮินดู', 'ซิกข์', 'ไม่ระบุ', 'อื่นๆ'],
  nationalities: [
    'ไทย',
    // เอเชียตะวันออกเฉียงใต้
    'พม่า (เมียนมา)', 'ลาว', 'กัมพูชา', 'เวียดนาม',
    'มาเลเซีย', 'สิงคโปร์', 'อินโดนีเซีย', 'ฟิลิปปินส์', 'บรูไน',
    // เอเชียตะวันออก
    'จีน', 'ฮ่องกง', 'ไต้หวัน', 'ญี่ปุ่น', 'เกาหลีใต้',
    // เอเชียใต้
    'อินเดีย', 'ปากีสถาน', 'บังกลาเทศ', 'เนปาล', 'ศรีลังกา',
    // ตะวันตก / ยุโรป
    'อเมริกัน', 'แคนาดา',
    'อังกฤษ', 'ฝรั่งเศส', 'เยอรมัน', 'อิตาลี', 'สเปน', 'เนเธอร์แลนด์', 'สวิตเซอร์แลนด์',
    'รัสเซีย', 'ยูเครน',
    // ตะวันออกกลาง / แอฟริกา
    'อิสราเอล', 'ตุรกี',
    // โอเชียเนีย
    'ออสเตรเลีย', 'นิวซีแลนด์',
    'อื่นๆ'
  ],
  banks: ['ธนาคารกสิกรไทย (KBANK)', 'ธนาคารกรุงเทพ (BBL)', 'ธนาคารไทยพาณิชย์ (SCB)', 'ธนาคารกรุงไทย (KTB)', 'ธนาคารกรุงศรีอยุธยา (BAY)', 'ธนาคารทหารไทยธนชาต (TTB)', 'ธนาคารออมสิน (GSB)', 'ธนาคารอาคารสงเคราะห์ (GHB)', 'ธ.ก.ส. (BAAC)', 'ธนาคารซีไอเอ็มบีไทย (CIMB)', 'ธนาคารยูโอบี (UOB)', 'ธนาคารเกียรตินาคินภัทร (KKP)', 'ธนาคารทิสโก้ (TISCO)', 'อื่นๆ'],
  provinces: ['กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี', 'ฉะเชิงเทรา', 'ชลบุรี', 'ชัยนาท', 'ชัยภูมิ', 'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด', 'ตาก', 'นครนายก', 'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช', 'นครสวรรค์', 'นนทบุรี', 'นราธิวาส', 'น่าน', 'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี', 'พระนครศรีอยุธยา', 'พะเยา', 'พังงา', 'พัทลุง', 'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่', 'ภูเก็ต', 'มหาสารคาม', 'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง', 'ระยอง', 'ราชบุรี', 'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ', 'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ', 'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย', 'สุพรรณบุรี', 'สุราษฎร์ธานี', 'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ', 'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี', 'อุบลราชธานี']
};

// ─── VALIDATION HELPERS ───
// เบอร์โทรไทย — 9-10 หลัก ขึ้นต้น 0
function validatePhone(s) {
  if (!s) return { ok: true };
  const d = String(s).replace(/\D/g, '');
  if (d.length < 9 || d.length > 10) return { ok: false, msg: 'เบอร์โทรต้อง 9-10 หลัก' };
  if (!d.startsWith('0')) return { ok: false, msg: 'เบอร์โทรต้องขึ้นต้นด้วย 0' };
  return { ok: true };
}
// เลขประชาชนไทย 13 หลัก + checksum (สูตรราชการ)
// ถ้าสัญชาติ ≠ ไทย ไม่ตรวจ (อาจเป็น passport, work permit)
function validateNationalId(s, nationality) {
  if (!s) return { ok: true };
  const d = String(s).replace(/\D/g, '');
  if (nationality && String(nationality).trim() !== 'ไทย') {
    if (d.length < 5 || d.length > 20) return { ok: false, msg: 'เลขประจำตัวต่างชาติยาวผิดปกติ' };
    return { ok: true };
  }
  if (d.length !== 13) return { ok: false, msg: 'เลขประชาชนไทยต้อง 13 หลัก' };
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(d[i], 10) * (13 - i);
  const cs = (11 - (sum % 11)) % 10;
  if (cs !== parseInt(d[12], 10)) return { ok: false, msg: 'เลขประชาชนไม่ถูกต้อง (checksum ไม่ตรง)' };
  return { ok: true };
}

// รายได้รวมต่อเดือน = เงินเดือน + ค่าตำแหน่ง + ค่าเดินทาง + ค่าอาหาร + ค่าเบี้ยเลี้ยง + ค่าภาษา + ค่าอื่นๆ
const totalIncome = (e) => Number(e.salary || 0) + Number(e.allowancePosition || 0) +
  Number(e.allowanceTravel || 0) + Number(e.allowanceFood || 0) +
  Number(e.allowancePerDiem || 0) + Number(e.allowanceLanguage || 0) +
  Number(e.allowanceOther || 0);

function openEmployeeForm(id = null) {
  if (!requireAdmin()) return;
  const emp = id ? DB.getEmployee(id) : {
    id: DB.nextEmployeeId(), title: 'นาย', firstName: '', lastName: '', nickname: '',
    nationalId: '', dob: '', gender: 'ชาย',
    nationality: 'ไทย', religion: '', education: '',
    phone: '', email: '', address: '',
    subDistrict: '', district: '', province: '', postalCode: '',
    passportNumber: '', workPermitNumber: '',
    department: DB.getDepartments()[0]?.id || '', branch: '',
    position: DB.getPositions()[0]?.id || '', positionTitle: '',
    employeeType: 'พนักงานประจำ',
    hireDate: tz.today(),
    terminationDate: '',
    salary: 0,
    allowancePosition: 0, allowanceTravel: 0, allowanceFood: 0,
    allowancePerDiem: 0, allowanceLanguage: 0, allowanceOther: 0,
    bank: '', bankAccount: '',
    status: 'active', note: ''
  };
  const depts = DB.getDepartments();
  const positions = DB.getPositions();

  const opt = (values, current) => values.map(v => `<option ${v === current ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  const dataListOpt = (values) => values.map(v => `<option value="${escapeHtml(v)}">`).join('');

  modal.open(id ? 'แก้ไขข้อมูลพนักงาน' : 'เพิ่มพนักงานใหม่', `
    <form id="empForm">

      <div class="form-section">
        <h3>รูปพนักงาน</h3>
        <div class="photo-upload-row">
          <div class="photo-preview-lg" id="photoPreview">
            ${emp.photoUrl ? `<img src="${escapeHtml(emp.photoUrl)}" alt=""/>` : `<div class="photo-placeholder">${escapeHtml((emp.firstName || '?').charAt(0))}</div>`}
          </div>
          <div style="flex:1">
            <input type="file" accept="image/*" id="photoFile" hidden>
            <div class="flex gap-2" style="flex-wrap:wrap">
              <button type="button" class="btn btn-secondary btn-sm" id="photoChoose">เลือกรูป</button>
              <button type="button" class="btn btn-ghost btn-sm" id="photoRemove" ${emp.photoUrl ? '' : 'style="display:none"'}>ลบรูป</button>
            </div>
            <div class="muted-2 mt-2" style="font-size:12px;line-height:1.5">รองรับ JPG, PNG, GIF — ระบบย่อขนาดอัตโนมัติให้ไม่เกิน 800px</div>
          </div>
        </div>
      </div>

      <div class="form-section">
        <h3>ข้อมูลพื้นฐาน</h3>
        <div class="form-grid">
          <div class="form-group"><label>รหัสพนักงาน *</label><input name="id" value="${escapeHtml(emp.id)}" required ${id ? 'readonly' : ''}/></div>
          <div class="form-group"><label>คำนำหน้า</label><select name="title">${opt(EMP_OPTIONS.titles, emp.title)}</select></div>
          <div class="form-group"><label>ชื่อ *</label><input name="firstName" value="${escapeHtml(emp.firstName)}" required/></div>
          <div class="form-group"><label>นามสกุล</label><input name="lastName" value="${escapeHtml(emp.lastName)}"/></div>
          <div class="form-group"><label>ชื่อเล่น</label><input name="nickname" value="${escapeHtml(emp.nickname)}"/></div>
          <div class="form-group"><label>เพศ</label><select name="gender">${opt(EMP_OPTIONS.genders, emp.gender)}</select></div>
          <div class="form-group"><label>วันเกิด</label><input name="dob" type="date" value="${emp.dob || ''}"/></div>
          <div class="form-group"><label>เลขประชาชน</label><input name="nationalId" value="${escapeHtml(emp.nationalId)}" maxlength="20" placeholder="13 หลัก (ไม่มีขีด)"/><small class="form-warn" id="nidWarn"></small></div>
          <div class="form-group"><label>สัญชาติ</label><input name="nationality" list="dl-nationalities" value="${escapeHtml(emp.nationality)}"/></div>
          <div class="form-group foreign-only" id="passportField"><label>Passport <span class="muted-2" style="font-weight:normal;font-size:11px">(หนังสือเดินทาง)</span></label><input name="passportNumber" value="${escapeHtml(emp.passportNumber)}" placeholder="เช่น A1234567"/></div>
          <div class="form-group foreign-only" id="wpField"><label>Work Permit <span class="muted-2" style="font-weight:normal;font-size:11px">(ใบอนุญาตทำงาน)</span></label><input name="workPermitNumber" value="${escapeHtml(emp.workPermitNumber)}" placeholder="เช่น WP-2026-12345"/></div>
          <div class="form-group"><label>ศาสนา</label><input name="religion" list="dl-religions" value="${escapeHtml(emp.religion)}"/></div>
          <div class="form-group"><label>วุฒิการศึกษา</label><input name="education" list="dl-educations" value="${escapeHtml(emp.education)}"/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>การติดต่อ</h3>
        <div class="form-grid">
          <div class="form-group"><label>เบอร์โทร</label><input name="phone" value="${escapeHtml(emp.phone)}" placeholder="0XX-XXX-XXXX"/><small class="form-warn" id="phoneWarn"></small></div>
          <div class="form-group"><label>อีเมล</label><input name="email" type="email" value="${escapeHtml(emp.email)}"/></div>
          <div class="form-group span-2"><label>ที่อยู่ (เลขที่ หมู่ ซอย ถนน)</label><textarea name="address" rows="2" placeholder="เช่น 123 หมู่ 4 ซอยสุขุมวิท 21 ถนนสุขุมวิท">${escapeHtml(emp.address)}</textarea></div>
          <div class="form-group"><label>แขวง / ตำบล</label><input name="subDistrict" value="${escapeHtml(emp.subDistrict)}" placeholder="เช่น คลองเตยเหนือ"/></div>
          <div class="form-group"><label>เขต / อำเภอ</label><input name="district" value="${escapeHtml(emp.district)}" placeholder="เช่น วัฒนา"/></div>
          <div class="form-group"><label>จังหวัด</label><input name="province" list="dl-provinces" value="${escapeHtml(emp.province)}" placeholder="เลือกหรือพิมพ์"/></div>
          <div class="form-group"><label>รหัสไปรษณีย์</label><input name="postalCode" value="${escapeHtml(emp.postalCode)}" maxlength="5" placeholder="10110"/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>การทำงาน</h3>
        <div class="form-grid">
          <div class="form-group"><label>ฝ่าย *</label><select name="department" required>${depts.map(d => `<option value="${d.id}" ${emp.department === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>สาขา</label><input name="branch" value="${escapeHtml(emp.branch)}" placeholder="เช่น สำนักงานใหญ่"/></div>
          <div class="form-group"><label>ระดับตำแหน่งงาน *</label>${(() => {
            // จัดกลุ่มตาม track: ฝ่ายปฏิบัติการ / ฝ่ายครัว / อื่นๆ
            const kitchen = [], ops = [], common = [];
            for (const p of positions) {
              const n = (p.name || '').toLowerCase();
              if (n.includes('chef') || n.includes('barista')) kitchen.push(p);
              else if (n.includes('part')) common.push(p);
              else ops.push(p);
            }
            const byLevel = (a, b) => (b.level || 0) - (a.level || 0) || (a.name || '').localeCompare(b.name || '');
            ops.sort(byLevel); kitchen.sort(byLevel); common.sort(byLevel);
            const opt = (arr) => arr.map(p => `<option value="${p.id}" ${emp.position === p.id ? 'selected' : ''}>${escapeHtml(p.name)}${p.level ? ' · ระดับ ' + p.level : ''}</option>`).join('');
            return `<select name="position" required>
              ${ops.length ? `<optgroup label="ฝ่ายปฏิบัติการ">${opt(ops)}</optgroup>` : ''}
              ${kitchen.length ? `<optgroup label="ฝ่ายครัว">${opt(kitchen)}</optgroup>` : ''}
              ${common.length ? `<optgroup label="อื่นๆ">${opt(common)}</optgroup>` : ''}
            </select>`;
          })()}</div>
          <div class="form-group"><label>ตำแหน่ง</label><input name="positionTitle" value="${escapeHtml(emp.positionTitle)}" placeholder="เช่น ผู้จัดการฝ่ายบุคคล"/></div>
          <div class="form-group"><label>ประเภทพนักงาน</label><select name="employeeType">${opt(EMP_OPTIONS.empTypes, emp.employeeType)}</select></div>
          <div class="form-group"><label>วันเริ่มงาน *</label><input name="hireDate" type="date" value="${emp.hireDate || ''}" required/></div>
          <div class="form-group"><label>วันพ้นสภาพ <span class="muted-2" style="font-weight:normal;font-size:11px">(วันที่ลาออก/พ้นสภาพ — ใส่ล่วงหน้าได้)</span></label><input name="terminationDate" type="date" value="${emp.terminationDate || ''}"/></div>
          <div class="form-group"><label>สถานะ <span class="muted-2" style="font-weight:normal;font-size:11px">(คำนวณจากวันพ้นสภาพอัตโนมัติ)</span></label>
            <input type="text" id="empStatusDisplay" readonly value="${(() => { const st = DB.empStatus(emp); return st === 'active' ? 'ปฏิบัติงาน' : st === 'pending' ? 'นัดพ้นสภาพ (ยังปฏิบัติงาน)' : 'พ้นสภาพแล้ว'; })()}"/>
            <input type="hidden" name="status" value="${emp.status || 'active'}"/>
          </div>
        </div>
      </div>

      <div class="form-section">
        <h3>บัญชีธนาคาร</h3>
        <div class="form-grid">
          <div class="form-group"><label>ธนาคาร</label><input name="bank" list="dl-banks" value="${escapeHtml(emp.bank)}"/></div>
          <div class="form-group"><label>เลขบัญชี</label><input name="bankAccount" value="${escapeHtml(emp.bankAccount)}" placeholder="000-0-00000-0"/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>เงินเดือนและสวัสดิการ</h3>
        <div class="form-grid">
          <div class="form-group"><label>เงินเดือน *</label><input name="salary" type="number" min="0" step="100" value="${emp.salary || 0}" required class="income-input"/></div>
          <div class="form-group"><label>ค่าตำแหน่ง</label><input name="allowancePosition" type="number" min="0" step="100" value="${emp.allowancePosition || 0}" class="income-input"/></div>
          <div class="form-group"><label>ค่าเดินทาง</label><input name="allowanceTravel" type="number" min="0" step="100" value="${emp.allowanceTravel || 0}" class="income-input"/></div>
          <div class="form-group"><label>ค่าอาหาร</label><input name="allowanceFood" type="number" min="0" step="100" value="${emp.allowanceFood || 0}" class="income-input"/></div>
          <div class="form-group"><label>ค่าเบี้ยเลี้ยง</label><input name="allowancePerDiem" type="number" min="0" step="100" value="${emp.allowancePerDiem || 0}" class="income-input"/></div>
          <div class="form-group"><label>ค่าภาษา</label><input name="allowanceLanguage" type="number" min="0" step="100" value="${emp.allowanceLanguage || 0}" class="income-input"/></div>
          <div class="form-group"><label>ค่าอื่นๆ</label><input name="allowanceOther" type="number" min="0" step="100" value="${emp.allowanceOther || 0}" class="income-input"/></div>
          <div class="form-group"><label>รวมรายได้ต่อเดือน</label><input id="incomeTotal" type="text" readonly style="font-weight:600;color:var(--primary)"/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>หมายเหตุ</h3>
        <div class="form-grid">
          <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="2">${escapeHtml(emp.note)}</textarea></div>
        </div>
      </div>

      <datalist id="dl-nationalities">${dataListOpt(EMP_OPTIONS.nationalities)}</datalist>
      <datalist id="dl-religions">${dataListOpt(EMP_OPTIONS.religions)}</datalist>
      <datalist id="dl-educations">${dataListOpt(EMP_OPTIONS.educations)}</datalist>
      <datalist id="dl-banks">${dataListOpt(EMP_OPTIONS.banks)}</datalist>
      <datalist id="dl-provinces">${dataListOpt(EMP_OPTIONS.provinces)}</datalist>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary" id="empSubmit">${id ? 'บันทึกการแก้ไข' : 'เพิ่มพนักงาน'}</button>
      </div>
    </form>`, { size: 'lg' });

  // คำนวณรวมรายได้แบบ realtime
  const updateTotal = () => {
    const inputs = $$('.income-input', $('#empForm'));
    const sum = inputs.reduce((s, i) => s + (Number(i.value) || 0), 0);
    $('#incomeTotal').value = fmt.money(sum);
  };
  $$('.income-input').forEach(i => i.addEventListener('input', updateTotal));
  updateTotal();

  // ─── TOGGLE: Passport + Work Permit แสดงเฉพาะเมื่อสัญชาติ ≠ ไทย ───
  const toggleForeignFields = () => {
    const nat = ($('#empForm [name="nationality"]')?.value || '').trim();
    const isThai = !nat || nat === 'ไทย';
    $$('.foreign-only', $('#empForm')).forEach(el => el.style.display = isThai ? 'none' : '');
    // update nationalId placeholder ให้บอกว่ารับเลขเอกสารต่างชาติได้
    const nid = $('#empForm [name="nationalId"]');
    if (nid) nid.placeholder = isThai ? '13 หลัก (ไม่มีขีด)' : 'เลขประชาชนของประเทศต้นทาง — หรือเว้นว่างถ้าไม่มี';
    const nidLabel = nid?.closest('.form-group')?.querySelector('label');
    if (nidLabel) nidLabel.textContent = isThai ? 'เลขประชาชน' : 'เลขประชาชน (ประเทศต้นทาง)';
  };
  $('#empForm [name="nationality"]')?.addEventListener('input', toggleForeignFields);
  $('#empForm [name="nationality"]')?.addEventListener('change', toggleForeignFields);
  toggleForeignFields(); // run once on form open

  // ─── VALIDATION: เบอร์โทร + เลขประชาชน ───
  const setFieldWarn = (inputSel, warnId, msg) => {
    const input = $(inputSel);
    const warn = $('#' + warnId);
    if (!input || !warn) return;
    input.classList.toggle('invalid', !!msg);
    warn.textContent = msg || '';
    warn.classList.toggle('show', !!msg);
  };
  const checkPhone = () => {
    const v = $('#empForm [name="phone"]')?.value || '';
    const r = validatePhone(v);
    setFieldWarn('#empForm [name="phone"]', 'phoneWarn', r.ok ? '' : r.msg);
  };
  const checkNid = () => {
    const v = $('#empForm [name="nationalId"]')?.value || '';
    const nat = $('#empForm [name="nationality"]')?.value || '';
    const r = validateNationalId(v, nat);
    setFieldWarn('#empForm [name="nationalId"]', 'nidWarn', r.ok ? '' : r.msg);
  };
  $('#empForm [name="phone"]')?.addEventListener('input', checkPhone);
  $('#empForm [name="nationalId"]')?.addEventListener('input', checkNid);
  $('#empForm [name="nationality"]')?.addEventListener('input', checkNid);
  $('#empForm [name="nationality"]')?.addEventListener('change', checkNid);
  // ตรวจครั้งแรกเมื่อโหลดฟอร์ม (ถ้ามีค่าเดิมที่ผิด — เตือนทันที)
  checkPhone(); checkNid();

  // ─── AUTO: เพศ ← คำนำหน้าชื่อ ───
  $('#empForm [name="title"]')?.addEventListener('change', (ev) => {
    const t = ev.target.value;
    const female = ['นางสาว', 'นาง', 'เด็กหญิง'].includes(t);
    const genderSel = $('#empForm [name="gender"]');
    if (genderSel) genderSel.value = female ? 'หญิง' : 'ชาย';
  });

  // ─── AUTO: ตำแหน่ง (positionTitle) ← ระดับตำแหน่งงาน (position) ───
  $('#empForm [name="position"]')?.addEventListener('change', (ev) => {
    const p = DB.getPosition(ev.target.value);
    const titleInput = $('#empForm [name="positionTitle"]');
    if (p && titleInput) titleInput.value = p.name;
  });

  // ─── UPDATE STATUS DISPLAY เมื่อเปลี่ยนวันพ้นสภาพ ───
  const updateStatusDisplay = () => {
    const td = $('#empForm [name="terminationDate"]')?.value;
    const today = tz.today();
    let label = 'ปฏิบัติงาน';
    if (td) label = td > today ? 'นัดพ้นสภาพ (ยังปฏิบัติงาน)' : 'พ้นสภาพแล้ว';
    const el = $('#empStatusDisplay');
    if (el) el.value = label;
  };
  $('#empForm [name="terminationDate"]')?.addEventListener('change', updateStatusDisplay);
  $('#empForm [name="terminationDate"]')?.addEventListener('input', updateStatusDisplay);

  // ─── PHOTO HANDLING ───
  let pendingPhotoBlob = null;
  let removePhoto = false;
  $('#photoChoose').addEventListener('click', () => $('#photoFile').click());
  $('#photoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast('ไฟล์ใหญ่เกิน 10MB', 'error'); return; }
    try {
      pendingPhotoBlob = await DB.compressImage(file);
      removePhoto = false;
      const url = URL.createObjectURL(pendingPhotoBlob);
      $('#photoPreview').innerHTML = `<img src="${url}" alt=""/>`;
      $('#photoRemove').style.display = '';
    } catch (ex) { toast('ไฟล์รูปไม่ถูกต้อง: ' + ex.message, 'error'); }
  });
  $('#photoRemove').addEventListener('click', () => {
    pendingPhotoBlob = null;
    removePhoto = true;
    $('#photoPreview').innerHTML = `<div class="photo-placeholder">${escapeHtml((emp.firstName || '?').charAt(0))}</div>`;
    $('#photoRemove').style.display = 'none';
    $('#photoFile').value = '';
  });

  $('#empForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#empSubmit'); btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      ['salary', 'allowancePosition', 'allowanceTravel', 'allowanceFood',
       'allowancePerDiem', 'allowanceLanguage', 'allowanceOther'].forEach(k => data[k] = Number(data[k]));

      // upload photo if changed
      if (pendingPhotoBlob) {
        btn.textContent = 'กำลังอัปโหลดรูป...';
        data.photoUrl = await DB.uploadEmployeePhoto(pendingPhotoBlob, data.id);
      } else if (removePhoto) {
        data.photoUrl = '';
      } else {
        data.photoUrl = emp.photoUrl;
      }

      btn.textContent = 'กำลังบันทึก...';
      await DB.saveEmployee(data);
      modal.close();
      toast(id ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มพนักงานใหม่แล้ว', 'success');
      renderEmployeeList();
    } catch (ex) {
      toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error');
      btn.disabled = false; btn.textContent = id ? 'บันทึกการแก้ไข' : 'เพิ่มพนักงาน';
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

  // Quick stats values
  const statusInfo = (() => {
    const st = DB.empStatus(e);
    if (st === 'active') return { label: 'ปฏิบัติงาน', cls: 'badge-success' };
    if (st === 'pending') return { label: 'นัดพ้นสภาพ', cls: 'badge-warning' };
    return { label: 'พ้นสภาพแล้ว', cls: 'badge-danger' };
  })();
  const levelTxt = pos.level ? ` · ระดับ ${pos.level}` : '';

  modal.open('ข้อมูลพนักงาน', `
    <div class="emp-hero">
      <div class="emp-hero-avatar">
        ${e.photoUrl
          ? `<img src="${escapeHtml(e.photoUrl)}" alt="" loading="lazy"/>`
          : `<div class="emp-avatar-fallback">${escapeHtml(initials)}</div>`}
      </div>
      <div class="emp-hero-info">
        <div class="emp-hero-id">รหัส ${escapeHtml(e.id)}</div>
        <h2 class="emp-hero-name">${escapeHtml((e.title || '') + e.firstName + ' ' + e.lastName)}</h2>
        <div class="emp-hero-title">${escapeHtml(e.positionTitle || pos.name || '-')}${levelTxt}</div>
        <div class="emp-hero-chips">
          ${dept.name ? `<span class="emp-chip">${escapeHtml(dept.name)}</span>` : ''}
          ${e.branch ? `<span class="emp-chip">📍 ${escapeHtml(e.branch)}</span>` : ''}
          ${e.employeeType ? `<span class="emp-chip">${escapeHtml(e.employeeType)}</span>` : ''}
          ${e.nickname ? `<span class="emp-chip muted">${escapeHtml(e.nickname)}</span>` : ''}
          <span class="badge ${statusInfo.cls}" style="font-size:11.5px">${statusInfo.label}</span>
        </div>
      </div>
    </div>

    <div class="emp-stats-row">
      <div class="emp-stat-card">
        <div class="emp-stat-label">รายได้รวม/เดือน</div>
        <div class="emp-stat-value">${fmt.money(totalIncome(e))}</div>
      </div>
      <div class="emp-stat-card">
        <div class="emp-stat-label">อายุงาน</div>
        <div class="emp-stat-value">${e.hireDate ? fmt.serviceYears(e.hireDate, e.terminationDate) : '-'}</div>
      </div>
      <div class="emp-stat-card">
        <div class="emp-stat-label">อายุพนักงาน</div>
        <div class="emp-stat-value">${e.dob ? fmt.age(e.dob) : '-'}</div>
      </div>
    </div>

    <div class="form-section">
      <h3>ข้อมูลส่วนตัว</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">เพศ</div><div class="value">${escapeHtml(e.gender || '-')}</div></div>
        <div class="emp-info-row"><div class="label">วันเกิด</div><div class="value">${fmt.date(e.dob)}${e.dob ? ' <span class="muted-2" style="font-size:12px">(' + fmt.age(e.dob) + ')</span>' : ''}</div></div>
        <div class="emp-info-row"><div class="label">เลขประชาชน</div><div class="value mono">${escapeHtml(e.nationalId || '-')}</div></div>
        <div class="emp-info-row"><div class="label">สัญชาติ</div><div class="value">${escapeHtml(e.nationality || '-')}</div></div>
        ${e.passportNumber ? `<div class="emp-info-row"><div class="label">Passport</div><div class="value mono">${escapeHtml(e.passportNumber)}</div></div>` : ''}
        ${e.workPermitNumber ? `<div class="emp-info-row"><div class="label">Work Permit</div><div class="value mono">${escapeHtml(e.workPermitNumber)}</div></div>` : ''}
        <div class="emp-info-row"><div class="label">ศาสนา</div><div class="value">${escapeHtml(e.religion || '-')}</div></div>
        <div class="emp-info-row"><div class="label">วุฒิการศึกษา</div><div class="value">${escapeHtml(e.education || '-')}</div></div>
      </div>
    </div>

    <div class="form-section">
      <h3>การติดต่อ</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">เบอร์โทร</div><div class="value">${escapeHtml(e.phone || '-')}</div></div>
        <div class="emp-info-row"><div class="label">อีเมล</div><div class="value">${escapeHtml(e.email || '-')}</div></div>
        <div class="emp-info-row span-2"><div class="label">ที่อยู่</div><div class="value">${escapeHtml(e.address || '-')}</div></div>
        <div class="emp-info-row"><div class="label">แขวง / ตำบล</div><div class="value">${escapeHtml(e.subDistrict || '-')}</div></div>
        <div class="emp-info-row"><div class="label">เขต / อำเภอ</div><div class="value">${escapeHtml(e.district || '-')}</div></div>
        <div class="emp-info-row"><div class="label">จังหวัด</div><div class="value">${escapeHtml(e.province || '-')}</div></div>
        <div class="emp-info-row"><div class="label">รหัสไปรษณีย์</div><div class="value">${escapeHtml(e.postalCode || '-')}</div></div>
      </div>
    </div>

    <div class="form-section">
      <h3>การทำงาน</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">ฝ่าย</div><div class="value">${escapeHtml(dept.name || '-')}</div></div>
        <div class="emp-info-row"><div class="label">สาขา</div><div class="value">${escapeHtml(e.branch || '-')}</div></div>
        <div class="emp-info-row"><div class="label">ระดับตำแหน่งงาน</div><div class="value">${pos.name ? escapeHtml(pos.name) + (pos.level ? ` <span class="badge badge-info" style="margin-left:6px">ระดับ ${pos.level}</span>` : '') : '-'}</div></div>
        <div class="emp-info-row"><div class="label">ตำแหน่ง</div><div class="value">${escapeHtml(e.positionTitle || '-')}</div></div>
        <div class="emp-info-row"><div class="label">ประเภทพนักงาน</div><div class="value">${escapeHtml(e.employeeType || '-')}</div></div>
        <div class="emp-info-row"><div class="label">วันเริ่มงาน</div><div class="value">${fmt.date(e.hireDate)}</div></div>
        <div class="emp-info-row"><div class="label">อายุงาน</div><div class="value">${e.hireDate ? fmt.serviceYears(e.hireDate, e.terminationDate) : '-'}</div></div>
        <div class="emp-info-row"><div class="label">วันพ้นสภาพ</div><div class="value">${(() => {
          const st = DB.empStatus(e);
          if (st === 'active') return '<span class="badge badge-success">ยังปฏิบัติงาน</span>';
          if (st === 'pending') return fmt.date(e.terminationDate) + ' <span class="badge badge-warning" style="margin-left:6px">นัดพ้นสภาพ — ยังปฏิบัติงาน</span>';
          return fmt.date(e.terminationDate) + ' <span class="badge badge-danger" style="margin-left:6px">พ้นสภาพแล้ว</span>';
        })()}</div></div>
      </div>
    </div>

    <div class="form-section">
      <h3>บัญชีธนาคาร</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">ธนาคาร</div><div class="value">${escapeHtml(e.bank || '-')}</div></div>
        <div class="emp-info-row"><div class="label">เลขบัญชี</div><div class="value">${escapeHtml(e.bankAccount || '-')}</div></div>
      </div>
    </div>

    <div class="form-section">
      <h3>เงินเดือนและสวัสดิการ</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">เงินเดือน</div><div class="value">${fmt.money(e.salary)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าตำแหน่ง</div><div class="value">${fmt.money(e.allowancePosition)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าเดินทาง</div><div class="value">${fmt.money(e.allowanceTravel)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าอาหาร</div><div class="value">${fmt.money(e.allowanceFood)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าเบี้ยเลี้ยง</div><div class="value">${fmt.money(e.allowancePerDiem)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าภาษา</div><div class="value">${fmt.money(e.allowanceLanguage)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าอื่นๆ</div><div class="value">${fmt.money(e.allowanceOther)}</div></div>
      </div>
      <div style="margin-top:14px;padding:14px 18px;background:var(--primary-soft);border-radius:var(--radius-sm);display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border)">
        <div style="font-size:13px;color:var(--text-2);font-weight:500">รวมรายได้ต่อเดือน</div>
        <div style="font-size:18px;font-weight:700;color:var(--primary)">${fmt.money(totalIncome(e))}</div>
      </div>
    </div>

    ${e.note ? `
    <div class="form-section">
      <h3>หมายเหตุ</h3>
      <div style="padding:4px 0;color:var(--text-2)">${escapeHtml(e.note)}</div>
    </div>` : ''}

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

// ─── EXCEL IMPORT ───
const IMPORT_COLUMNS = [
  'รหัสพนักงาน', 'คำนำหน้า', 'ชื่อ', 'นามสกุล', 'ชื่อเล่น', 'เพศ',
  'วันเกิด', 'เลขประชาชน', 'Passport', 'Work Permit', 'สัญชาติ', 'ศาสนา', 'วุฒิการศึกษา',
  'เบอร์โทร', 'อีเมล',
  'ที่อยู่', 'แขวง/ตำบล', 'เขต/อำเภอ', 'จังหวัด', 'รหัสไปรษณีย์',
  'รหัสฝ่าย', 'สาขา', 'รหัสระดับตำแหน่ง', 'ตำแหน่ง', 'ประเภทพนักงาน', 'วันเริ่มงาน', 'วันพ้นสภาพ',
  'ธนาคาร', 'เลขบัญชี',
  'เงินเดือน', 'ค่าตำแหน่ง', 'ค่าเดินทาง', 'ค่าอาหาร', 'ค่าเบี้ยเลี้ยง', 'ค่าภาษา', 'ค่าอื่นๆ',
  'สถานะ', 'หมายเหตุ'
];

function downloadEmployeeTemplate() {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(downloadEmployeeTemplate, 800); return; }
  const sample = [
    {
      'รหัสพนักงาน': 1001, 'คำนำหน้า': 'นาย', 'ชื่อ': 'ตัวอย่าง', 'นามสกุล': 'นามสกุลตัวอย่าง',
      'ชื่อเล่น': 'ตย.', 'เพศ': 'ชาย', 'วันเกิด': '15/01/1990', 'เลขประชาชน': 1234567890123,
      'Passport': '', 'Work Permit': '',
      'สัญชาติ': 'ไทย', 'ศาสนา': 'พุทธ', 'วุฒิการศึกษา': 'ปริญญาตรี',
      'เบอร์โทร': '081-234-5678', 'อีเมล': 'sample@khacha.co.th',
      'ที่อยู่': '123 หมู่ 4 ซอยสุขุมวิท 21 ถ.สุขุมวิท',
      'แขวง/ตำบล': 'คลองเตยเหนือ', 'เขต/อำเภอ': 'วัฒนา',
      'จังหวัด': 'กรุงเทพมหานคร', 'รหัสไปรษณีย์': '10110',
      'รหัสฝ่าย': 'D001', 'สาขา': 'สำนักงานใหญ่',
      'รหัสระดับตำแหน่ง': 'P03', 'ตำแหน่ง': 'หัวหน้าทีม',
      'ประเภทพนักงาน': 'พนักงานประจำ', 'วันเริ่มงาน': '01/01/2024', 'วันพ้นสภาพ': '',
      'ธนาคาร': 'ธนาคารกสิกรไทย (KBANK)', 'เลขบัญชี': '123-4-56789-0',
      'เงินเดือน': 30000, 'ค่าตำแหน่ง': 3000, 'ค่าเดินทาง': 2000, 'ค่าอาหาร': 1500,
      'ค่าเบี้ยเลี้ยง': 0, 'ค่าภาษา': 0, 'ค่าอื่นๆ': 0,
      'สถานะ': 'active', 'หมายเหตุ': ''
    }
  ];
  const ws = XLSX.utils.json_to_sheet(sample, { header: IMPORT_COLUMNS });
  ws['!cols'] = IMPORT_COLUMNS.map(k => ({ wch: Math.max(k.length + 2, 14) }));

  const depts = DB.getDepartments().map(d => `${d.id} = ${d.name}`).join('\n');
  const positions = DB.getPositions().map(p => `${p.id} = ${p.name}`).join('\n');
  const notes = [
    ['คำแนะนำการกรอกข้อมูลพนักงาน'],
    [''],
    ['ฟิลด์ที่จำเป็น (ต้องกรอก):'],
    ['• รหัสพนักงาน — ห้ามซ้ำกับที่มีอยู่ในระบบ (ถ้าซ้ำจะอัปเดตข้อมูล)'],
    ['• ชื่อ'],
    ['• นามสกุล'],
    [''],
    ['รูปแบบวันที่ที่รองรับ (ใส่แบบไหนก็ได้):'],
    ['• DD/MM/YYYY  เช่น 15/01/1990  หรือ 15/01/2533 (พ.ศ.)'],
    ['• DD-MM-YYYY  เช่น 15-01-1990'],
    ['• YYYY-MM-DD  เช่น 1990-01-15  (ISO standard)'],
    ['• Excel Date cell (ฟอร์แมตเป็นวันที่ใน Excel) — ใส่ยังไงก็ได้'],
    ['• ระบบแปลงปี พ.ศ. (>2400) เป็น ค.ศ. อัตโนมัติ'],
    [''],
    ['รูปแบบข้อมูลอื่นๆ:'],
    ['• เลขประชาชน: 13 หลัก ไม่มีขีด'],
    ['• เลขบัญชี: ใส่ขีดได้ เช่น 123-4-56789-0 (เก็บเป็นข้อความ)'],
    ['• เงินเดือน/ค่าต่างๆ: ตัวเลขเท่านั้น (ไม่ใส่ , หรือ บาท)'],
    ['• สถานะ: active = ปฏิบัติงาน, resigned = ลาออก'],
    [''],
    ['รหัสฝ่ายที่มีในระบบ:'],
    ...depts.split('\n').map(s => ['• ' + s]),
    [''],
    ['รหัสระดับตำแหน่งที่มีในระบบ:'],
    ...positions.split('\n').map(s => ['• ' + s]),
    [''],
    ['การ Import:'],
    ['• รหัสซ้ำกับที่มีอยู่ → อัปเดตข้อมูล (overwrite)'],
    ['• รหัสใหม่ → สร้างพนักงานใหม่'],
    ['• Import ทีเดียว 1000+ คนได้ — ใช้เวลา ~5-10 วินาที'],
    ['• ไม่ใส่ข้อมูลใน sheet "คำแนะนำ" — กรอกแค่ sheet "พนักงาน"']
  ];
  const wsNotes = XLSX.utils.aoa_to_sheet(notes);
  wsNotes['!cols'] = [{ wch: 80 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'พนักงาน');
  XLSX.utils.book_append_sheet(wb, wsNotes, 'คำแนะนำ');
  XLSX.writeFile(wb, 'template-คชา-นำเข้าพนักงาน.xlsx');
  toast('ดาวน์โหลด template แล้ว', 'success');
}

function parseImportRow(row) {
  const get = (k) => (row[k] == null ? '' : String(row[k])).trim();
  const num = (k) => Number(row[k]) || 0;
  // รองรับวันที่ทั้ง Date object (Excel) และ string หลายรูปแบบ:
  // - Excel Date cell
  // - YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD (ISO)
  // - DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (ไทย/ยุโรป)
  // - ปีพ.ศ. (>2400) → แปลงเป็นค.ศ. อัตโนมัติ (ลบ 543)
  const parseDate = (k) => {
    const v = row[k];
    if (!v) return null;
    if (v instanceof Date) return v.toLocaleDateString('en-CA', { timeZone: TZ });
    const s = String(v).trim();
    if (!s) return null;
    const yToCE = (y) => (y >= 2400 ? y - 543 : y);
    const pad = (n) => String(n).padStart(2, '0');
    // YYYY-MM-DD (ISO format)
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
    if (m) {
      const y = yToCE(+m[1]);
      return `${y}-${pad(+m[2])}-${pad(+m[3])}`;
    }
    // DD/MM/YYYY (Thai/European format)
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
    if (m) {
      const y = yToCE(+m[3]);
      return `${y}-${pad(+m[2])}-${pad(+m[1])}`;
    }
    return s;
  };
  return {
    id: get('รหัสพนักงาน'),
    title: get('คำนำหน้า') || 'นาย',
    firstName: get('ชื่อ'),
    lastName: get('นามสกุล'),
    nickname: get('ชื่อเล่น'),
    gender: get('เพศ') || 'ชาย',
    dob: parseDate('วันเกิด'),
    nationalId: get('เลขประชาชน'),
    passportNumber: get('Passport'),
    workPermitNumber: get('Work Permit'),
    nationality: get('สัญชาติ') || 'ไทย',
    religion: get('ศาสนา'),
    education: get('วุฒิการศึกษา'),
    phone: get('เบอร์โทร'),
    email: get('อีเมล'),
    address: get('ที่อยู่'),
    subDistrict: get('แขวง/ตำบล'),
    district: get('เขต/อำเภอ'),
    province: get('จังหวัด'),
    postalCode: get('รหัสไปรษณีย์'),
    department: get('รหัสฝ่าย'),
    branch: get('สาขา'),
    position: get('รหัสระดับตำแหน่ง'),
    positionTitle: get('ตำแหน่ง'),
    employeeType: get('ประเภทพนักงาน') || 'พนักงานประจำ',
    hireDate: parseDate('วันเริ่มงาน') || tz.today(),
    terminationDate: parseDate('วันพ้นสภาพ') || '',
    bank: get('ธนาคาร'),
    bankAccount: get('เลขบัญชี'),
    salary: num('เงินเดือน'),
    allowancePosition: num('ค่าตำแหน่ง'),
    allowanceTravel: num('ค่าเดินทาง'),
    allowanceFood: num('ค่าอาหาร'),
    allowancePerDiem: num('ค่าเบี้ยเลี้ยง'),
    allowanceLanguage: num('ค่าภาษา'),
    allowanceOther: num('ค่าอื่นๆ'),
    status: get('สถานะ') === 'resigned' ? 'resigned' : 'active',
    note: get('หมายเหตุ'),
    photoUrl: ''
  };
}

function validateImportRows(rows) {
  const errors = [];
  const idsSeen = new Set();
  const deptIds = new Set(DB.getDepartments().map(d => d.id));
  const posIds = new Set(DB.getPositions().map(p => p.id));
  rows.forEach((r, i) => {
    const rowNum = i + 2; // header at row 1
    if (!r.id) { errors.push({ row: rowNum, msg: 'รหัสพนักงานว่าง' }); return; }
    if (idsSeen.has(r.id)) errors.push({ row: rowNum, msg: 'รหัสซ้ำในไฟล์: ' + r.id });
    idsSeen.add(r.id);
    if (!r.firstName) errors.push({ row: rowNum, msg: 'ชื่อว่าง' });
    // นามสกุลไม่บังคับ — บางกรณีพนักงานมีชื่อเดียว (เช่น แรงงานต่างด้าว)
    if (r.department && !deptIds.has(r.department))
      errors.push({ row: rowNum, msg: `รหัสฝ่ายไม่มีในระบบ: ${r.department}` });
    if (r.position && !posIds.has(r.position))
      errors.push({ row: rowNum, msg: `รหัสระดับตำแหน่งไม่มีในระบบ: ${r.position}` });
  });
  return errors;
}

async function readExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        // หา sheet "พนักงาน" หรือ sheet แรก
        const sheetName = wb.SheetNames.find(n => n.includes('พนักงาน')) || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        resolve(rows.map(parseImportRow));
      } catch (ex) { reject(ex); }
    };
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsArrayBuffer(file);
  });
}

function openImportEmployees() {
  if (!requireAdmin()) return;
  modal.open('นำเข้าทะเบียนพนักงาน (Excel)', `
    <div class="import-flow">
      <div class="import-step">
        <div class="import-step-num">1</div>
        <div class="import-step-body">
          <div class="import-step-title">ดาวน์โหลด Template</div>
          <div class="muted-2" style="font-size:13px;margin-bottom:8px">ใช้ template เพื่อให้ข้อมูลครบและถูกรูปแบบ มีคำแนะนำในไฟล์</div>
          <button class="btn btn-secondary btn-sm" onclick="downloadEmployeeTemplate()">${ICON.download}ดาวน์โหลด Template</button>
        </div>
      </div>
      <div class="import-step">
        <div class="import-step-num">2</div>
        <div class="import-step-body">
          <div class="import-step-title">เลือกไฟล์ Excel ที่กรอกแล้ว</div>
          <input type="file" accept=".xlsx,.xls,.csv" id="importFile" class="import-file">
        </div>
      </div>
      <div id="importBody"></div>
    </div>
  `, {
    size: 'lg',
    footer: `<button class="btn btn-secondary" data-close>ปิด</button><button class="btn btn-primary" id="importStartBtn" disabled>เริ่มนำเข้า</button>`
  });

  let parsedRows = null;
  let validationErrors = [];

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#importBody').innerHTML = '<div class="muted-2 mt-4">กำลังอ่านไฟล์...</div>';
    try {
      parsedRows = await readExcelFile(file);
      validationErrors = validateImportRows(parsedRows);
      $('#importBody').innerHTML = renderImportPreview(parsedRows, validationErrors);
      $('#importStartBtn').disabled = validationErrors.length > 0 || parsedRows.length === 0;
    } catch (ex) {
      $('#importBody').innerHTML = `<div class="card mt-4" style="border-color:var(--danger);color:var(--danger)">อ่านไฟล์ไม่สำเร็จ: ${escapeHtml(ex.message)}</div>`;
      $('#importStartBtn').disabled = true;
    }
  });

  $('#importStartBtn').addEventListener('click', async () => {
    if (!parsedRows || !parsedRows.length) return;
    $('#importStartBtn').disabled = true;
    $('#importBody').innerHTML = `
      <div class="card mt-4">
        <div style="margin-bottom:10px">กำลังนำเข้า <strong id="progressText">0</strong> / <strong>${parsedRows.length.toLocaleString()}</strong></div>
        <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
        <div class="muted-2 mt-2" style="font-size:12px">นำเข้าทีละ 100 รายการ — ห้ามปิดหน้าต่างนี้</div>
      </div>
    `;
    const start = performance.now();
    const result = await DB.bulkUpsertEmployees(parsedRows, (done, total) => {
      const pct = (done / total) * 100;
      const fill = $('#progressFill');
      const text = $('#progressText');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = done.toLocaleString();
    });
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);

    $('#importBody').innerHTML = `
      <div class="card mt-4">
        <div style="font-size:16px;font-weight:600;color:var(--success);margin-bottom:8px">✓ นำเข้าสำเร็จ</div>
        <div style="font-size:14px;line-height:1.8">
          • นำเข้าสำเร็จ: <strong>${result.inserted.toLocaleString()}</strong> คน<br>
          ${result.failed ? `• ผิดพลาด: <strong style="color:var(--danger)">${result.failed.toLocaleString()}</strong> คน<br>` : ''}
          • ใช้เวลา: <strong>${elapsed}</strong> วินาที
        </div>
        ${result.errors.length ? `
          <details class="mt-2" style="font-size:13px">
            <summary style="cursor:pointer;color:var(--danger)">ดูข้อผิดพลาด ${result.errors.length} batch</summary>
            <ul style="margin-top:6px;padding-left:20px">${result.errors.map(e => `<li>Batch ${e.chunk}: ${escapeHtml(e.message)}</li>`).join('')}</ul>
          </details>
        ` : ''}
      </div>
    `;
    // ตั้งให้ปุ่ม "เสร็จสิ้น" คลิกได้ + ปิด modal
    parsedRows = null;
    const finishBtn = $('#importStartBtn');
    finishBtn.textContent = 'เสร็จสิ้น';
    finishBtn.disabled = false;
    finishBtn.setAttribute('data-close', '');
    renderEmployeeList();
  });
}

function renderImportPreview(rows, errors) {
  const sample = rows.slice(0, 5);
  return `
    <div class="card mt-4">
      <div class="flex items-center gap-2" style="margin-bottom:10px;flex-wrap:wrap">
        <strong>พบ ${rows.length.toLocaleString()} แถว</strong>
        ${errors.length
          ? `<span class="badge badge-danger">${errors.length} ข้อผิดพลาด</span>`
          : '<span class="badge badge-success">พร้อมนำเข้า</span>'}
      </div>
      ${errors.length ? `
        <div style="background:var(--danger-soft);border-radius:8px;padding:12px;max-height:180px;overflow-y:auto;font-size:12.5px;margin-bottom:12px">
          <strong style="color:var(--danger-text)">ข้อผิดพลาดที่ต้องแก้ก่อน Import:</strong>
          <ul style="margin-top:6px;padding-left:20px">
            ${errors.slice(0, 30).map(e => `<li>แถวที่ ${e.row}: ${escapeHtml(e.msg)}</li>`).join('')}
            ${errors.length > 30 ? `<li>... และอีก ${errors.length - 30} ข้อ</li>` : ''}
          </ul>
        </div>
      ` : ''}
      <div style="font-size:12.5px;margin-bottom:6px"><strong>ตัวอย่าง 5 แถวแรก:</strong></div>
      <div class="table-wrap">
        <table class="table" style="font-size:12.5px">
          <thead><tr><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>ฝ่าย</th><th>ตำแหน่ง</th><th class="num">เงินเดือน</th></tr></thead>
          <tbody>
            ${sample.map(r => `<tr>
              <td>${escapeHtml(r.id || '-')}</td>
              <td>${escapeHtml(r.firstName + ' ' + r.lastName)}</td>
              <td>${escapeHtml(r.department || '-')}</td>
              <td>${escapeHtml(r.positionTitle || '-')}</td>
              <td class="num">${fmt.money(r.salary)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ─── BULK PHOTO UPLOAD ───
// แมตช์ชื่อไฟล์กับ employee ID — รองรับทั้ง "KB0001.jpg", "1.jpg", "0001.jpg" (เทียบจากตัวเลขล้วน)
function matchPhotoToEmployee(filename, empByDigits) {
  const baseName = filename.replace(/\.[^.]+$/, '');
  // 1) Exact match
  const exact = DB.getEmployee(baseName);
  if (exact) return exact;
  // 2) Match digits-only (ตัด leading zero ออก)
  const digits = baseName.replace(/[^\d]/g, '').replace(/^0+/, '') || '0';
  return empByDigits.get(digits) || null;
}

function buildEmpDigitsIndex() {
  // สร้าง Map: digits → employee — เร็วกว่า scan ทุกครั้ง
  const map = new Map();
  for (const e of DB.data.employees) {
    const d = String(e.id).replace(/[^\d]/g, '').replace(/^0+/, '') || '0';
    if (!map.has(d)) map.set(d, e);
  }
  return map;
}

function openBulkPhotoUpload() {
  if (!requireAdmin()) return;
  modal.open('อัปโหลดรูปพนักงานจำนวนมาก', `
    <div class="import-flow">
      <div class="import-step">
        <div class="import-step-num">1</div>
        <div class="import-step-body">
          <div class="import-step-title">เตรียมไฟล์รูปพนักงาน</div>
          <div class="muted-2" style="font-size:13px;line-height:1.7">
            • ตั้งชื่อไฟล์ตามรหัสพนักงาน — รองรับ <code>KB0001.jpg</code>, <code>0001.jpg</code>, <code>1.jpg</code> (ระบบจับคู่อัตโนมัติจากตัวเลข)<br>
            • รองรับ JPG, PNG, GIF — ระบบย่อขนาดอัตโนมัติให้ไม่เกิน 800px<br>
            • อัปโหลดพร้อมกัน <strong>12 ไฟล์ต่อรอบ</strong> + อัปเดต database ทีเดียวจบ<br>
            • <strong>1000 รูปใช้เวลาประมาณ 2-3 นาที</strong>
          </div>
        </div>
      </div>
      <div class="import-step">
        <div class="import-step-num">2</div>
        <div class="import-step-body">
          <div class="import-step-title">เลือกแหล่งรูป</div>
          <div class="flex gap-2 mb-2" style="flex-wrap:wrap">
            <button type="button" class="btn btn-secondary btn-sm" id="pickFilesBtn">📄 เลือกไฟล์ (หลายไฟล์)</button>
            <button type="button" class="btn btn-secondary btn-sm" id="pickFolderBtn">📁 เลือกทั้งโฟลเดอ</button>
          </div>
          <input type="file" accept="image/*" multiple id="bulkPhotoFiles" hidden>
          <input type="file" accept="image/*" multiple webkitdirectory id="bulkPhotoFolder" hidden>
          <div class="muted-2" style="font-size:12px">
            <strong>เลือกไฟล์:</strong> เปิด file dialog แล้วกด Ctrl+A เลือกทั้งหมด<br>
            <strong>เลือกโฟลเดอ:</strong> ชี้ไปที่โฟลเดอที่เก็บรูป — ระบบดึงทุกไฟล์ในโฟลเดอ (รวม subfolder) ให้อัตโนมัติ
          </div>
        </div>
      </div>
      <div id="bulkPhotoBody"></div>
    </div>
  `, {
    size: 'lg',
    footer: `<button class="btn btn-secondary" data-close>ปิด</button><button class="btn btn-primary" id="bulkUploadStart" disabled>เริ่มอัปโหลด</button>`
  });

  let matches = [];
  let unmatched = [];

  const handleFiles = (rawFiles) => {
    // กรองเฉพาะไฟล์รูป
    const files = rawFiles.filter(f => f.type.startsWith('image/'));
    if (!files.length) {
      $('#bulkPhotoBody').innerHTML = `<div class="card mt-4" style="color:var(--warning-text);background:var(--warning-soft)">ไม่พบไฟล์รูปในที่เลือก</div>`;
      return;
    }
    $('#bulkPhotoBody').innerHTML = `<div class="muted-2 mt-4">กำลังจับคู่ ${files.length.toLocaleString()} ไฟล์...</div>`;
    // ทำ matching ใน rAF เพื่อไม่บล็อก UI
    requestAnimationFrame(() => {
      const empIdx = buildEmpDigitsIndex();
      matches = [];
      unmatched = [];
      for (const file of files) {
        const emp = matchPhotoToEmployee(file.name, empIdx);
        if (emp) matches.push({ file, employee: emp });
        else unmatched.push(file.name);
      }
      $('#bulkPhotoBody').innerHTML = renderBulkPhotoPreview(files.length, matches, unmatched);
      $('#bulkUploadStart').disabled = matches.length === 0;
    });
  };

  $('#pickFilesBtn').addEventListener('click', () => $('#bulkPhotoFiles').click());
  $('#pickFolderBtn').addEventListener('click', () => $('#bulkPhotoFolder').click());
  $('#bulkPhotoFiles').addEventListener('change', (e) => handleFiles(Array.from(e.target.files || [])));
  $('#bulkPhotoFolder').addEventListener('change', (e) => handleFiles(Array.from(e.target.files || [])));

  $('#bulkUploadStart').addEventListener('click', async () => {
    if (!matches.length) return;
    $('#bulkUploadStart').disabled = true;
    $('#bulkPhotoBody').innerHTML = `
      <div class="card mt-4">
        <div style="margin-bottom:10px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>กำลังอัปโหลด <strong id="bpDone">0</strong> / <strong>${matches.length.toLocaleString()}</strong> รูป</div>
          <div class="muted-2" style="font-size:12.5px">
            สำเร็จ <span id="bpOk" style="color:var(--success);font-weight:600">0</span>
            · ผิดพลาด <span id="bpFail" style="color:var(--danger);font-weight:600">0</span>
          </div>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="bpFill" style="width:0%"></div></div>
        <div class="muted-2 mt-2" style="font-size:12px">อัปโหลดพร้อมกัน 12 ไฟล์ — กรุณาอย่าปิดหน้าต่างนี้</div>
      </div>
    `;
    const start = performance.now();
    // ใช้ rAF throttle เพื่อให้ progress bar ไหลลื่นไม่กระตุก
    let pendingUpdate = null;
    const onProgress = (done, total, ok, fail) => {
      pendingUpdate = { done, total, ok, fail };
      if (pendingUpdate._scheduled) return;
      pendingUpdate._scheduled = true;
      requestAnimationFrame(() => {
        const u = pendingUpdate;
        pendingUpdate = null;
        const fill = $('#bpFill'), doneEl = $('#bpDone'), okEl = $('#bpOk'), failEl = $('#bpFail');
        if (fill) fill.style.width = (u.done / u.total * 100) + '%';
        if (doneEl) doneEl.textContent = u.done.toLocaleString();
        if (okEl) okEl.textContent = u.ok.toLocaleString();
        if (failEl) failEl.textContent = u.fail.toLocaleString();
      });
    };

    const result = await DB.bulkUploadEmployeePhotos(matches, { concurrency: 12, onProgress });
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);

    $('#bulkPhotoBody').innerHTML = `
      <div class="card mt-4">
        <div style="font-size:16px;font-weight:600;color:var(--success);margin-bottom:8px">✓ อัปโหลดเสร็จสิ้น</div>
        <div style="font-size:14px;line-height:1.8">
          • อัปโหลดสำเร็จ: <strong>${result.succeeded.toLocaleString()}</strong> รูป<br>
          ${result.failed.length ? `• ผิดพลาด: <strong style="color:var(--danger)">${result.failed.length.toLocaleString()}</strong> รูป<br>` : ''}
          • ใช้เวลา: <strong>${elapsed}</strong> วินาที
          ${result.succeeded > 0 ? ` (${(result.succeeded / Number(elapsed)).toFixed(1)} รูป/วินาที)` : ''}
        </div>
        ${result.failed.length ? `
          <details class="mt-2" style="font-size:12.5px">
            <summary style="cursor:pointer;color:var(--danger)">ดูข้อผิดพลาด (${result.failed.length})</summary>
            <ul style="margin-top:6px;padding-left:20px;max-height:160px;overflow-y:auto">
              ${result.failed.slice(0, 50).map(f => `<li>${escapeHtml(f.id || f.file || '?')}: ${escapeHtml(f.error || '')}</li>`).join('')}
              ${result.failed.length > 50 ? `<li>... และอีก ${result.failed.length - 50} ข้อผิดพลาด</li>` : ''}
            </ul>
          </details>
        ` : ''}
      </div>
    `;
    $('#bulkUploadStart').textContent = 'เสร็จสิ้น';
    renderEmployeeList();
  });
}

function renderBulkPhotoPreview(total, matches, unmatched) {
  return `
    <div class="card mt-4">
      <div class="flex items-center gap-2" style="margin-bottom:10px;flex-wrap:wrap">
        <strong>เลือกไฟล์ ${total.toLocaleString()} รูป</strong>
        <span class="badge badge-success">จับคู่ได้ ${matches.length.toLocaleString()}</span>
        ${unmatched.length ? `<span class="badge badge-warning">จับคู่ไม่ได้ ${unmatched.length.toLocaleString()}</span>` : ''}
      </div>
      ${unmatched.length ? `
        <details class="mt-2" style="font-size:13px">
          <summary style="cursor:pointer;color:var(--warning-text)">ดูชื่อไฟล์ที่จับคู่ไม่ได้ (${unmatched.length.toLocaleString()})</summary>
          <ul style="margin-top:6px;padding-left:20px;max-height:140px;overflow-y:auto;font-size:12px">
            ${unmatched.slice(0, 100).map(n => `<li>${escapeHtml(n)}</li>`).join('')}
            ${unmatched.length > 100 ? `<li>... และอีก ${unmatched.length - 100} ไฟล์</li>` : ''}
          </ul>
        </details>
      ` : ''}
      ${matches.length ? `
        <div class="muted-2 mt-2" style="font-size:12px">
          ตัวอย่างการจับคู่: ${matches.slice(0, 3).map(m => `<code>${escapeHtml(m.file.name)}</code> → ${escapeHtml(m.employee.id)}`).join(', ')}
        </div>
      ` : ''}
    </div>
  `;
}

function exportEmployeesXLSX() {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportEmployeesXLSX, 800); return; }
  const rows = DB.getEmployees().map(e => ({
    'รหัส': excelNum(e.id), 'คำนำหน้า': e.title, 'ชื่อ': e.firstName, 'นามสกุล': e.lastName,
    'ชื่อเล่น': e.nickname,
    'เลขประชาชน': excelNum(e.nationalId), 'Passport': e.passportNumber, 'Work Permit': e.workPermitNumber, 'วันเกิด': excelDate(e.dob), 'เพศ': e.gender,
    'สัญชาติ': e.nationality, 'ศาสนา': e.religion, 'วุฒิการศึกษา': e.education,
    'เบอร์โทร': e.phone, 'อีเมล': e.email,
    'ที่อยู่': e.address, 'แขวง/ตำบล': e.subDistrict, 'เขต/อำเภอ': e.district,
    'จังหวัด': e.province, 'รหัสไปรษณีย์': e.postalCode,
    'ฝ่าย': (DB.getDepartment(e.department) || {}).name || '',
    'สาขา': e.branch,
    'ระดับตำแหน่งงาน': (DB.getPosition(e.position) || {}).name || '',
    'ตำแหน่ง': e.positionTitle,
    'ประเภทพนักงาน': e.employeeType,
    'วันเริ่มงาน': excelDate(e.hireDate),
    'วันพ้นสภาพ': excelDate(e.terminationDate),
    'ธนาคาร': e.bank, 'เลขบัญชี': e.bankAccount,
    'เงินเดือน': Number(e.salary || 0),
    'ค่าตำแหน่ง': Number(e.allowancePosition || 0),
    'ค่าเดินทาง': Number(e.allowanceTravel || 0),
    'ค่าอาหาร': Number(e.allowanceFood || 0),
    'ค่าเบี้ยเลี้ยง': Number(e.allowancePerDiem || 0),
    'ค่าภาษา': Number(e.allowanceLanguage || 0),
    'ค่าอื่นๆ': Number(e.allowanceOther || 0),
    'รวมรายได้': totalIncome(e),
    'สถานะ': e.status === 'active' ? 'ปฏิบัติงาน' : 'ลาออก',
    'หมายเหตุ': e.note
  }));
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  // เลขประชาชน (column index 5 — ลำดับใน rows: รหัส,คำนำหน้า,ชื่อ,นามสกุล,ชื่อเล่น,เลขประชาชน,...)
  const headerKeys = Object.keys(rows[0] || {});
  const nidIdx = headerKeys.indexOf('เลขประชาชน');
  if (nidIdx >= 0) setColumnFormat(ws, nidIdx, '0');
  // กำหนดความกว้างคอลัมน์ — เลขประชาชน 16 ตัวอักษรเพื่อให้เห็น 13 หลักเต็ม
  ws['!cols'] = headerKeys.map(k => {
    if (k === 'เลขประชาชน') return { wch: 16 };
    if (k === 'วันเกิด' || k === 'วันเริ่มงาน' || k === 'วันพ้นสภาพ') return { wch: 13 };
    if (k === 'รหัส') return { wch: 8 };
    if (k === 'ชื่อ' || k === 'นามสกุล') return { wch: 14 };
    if (k === 'ตำแหน่ง' || k === 'ฝ่าย') return { wch: 22 };
    if (k === 'ที่อยู่') return { wch: 30 };
    return { wch: 12 };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'พนักงาน');
  XLSX.writeFile(wb, `คชา-บราเธอร์ส-พนักงาน-${tz.today()}.xlsx`);
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
      <h2>ฝ่าย</h2>
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
  // เรียงตาม level desc แล้ว name asc — ระดับสูงอยู่บน
  const ps = DB.getPositions().slice().sort((a, b) => (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name));
  const emps = DB.getEmployees({ status: 'active' });
  return `
    <div class="page-header">
      <h2>ระดับตำแหน่ง</h2>
      <div class="actions">${DB.isAdmin ? '<button class="btn btn-primary" onclick="openPositionForm()">+ เพิ่มตำแหน่ง</button>' : ''}</div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>รหัส</th><th>ตำแหน่ง</th><th class="num">ระดับ</th><th class="num">เงินเดือนต่ำสุด</th><th class="num">เงินเดือนสูงสุด</th><th class="num">จำนวนพนักงาน</th><th></th></tr></thead>
          <tbody>
            ${ps.map(p => `<tr>
                <td><strong>${escapeHtml(p.id)}</strong></td>
                <td>${escapeHtml(p.name)}</td>
                <td class="num"><span class="badge badge-info">${p.level || '-'}</span></td>
                <td class="num">${p.minSalary ? fmt.money(p.minSalary) : '-'}</td>
                <td class="num">${p.maxSalary ? fmt.money(p.maxSalary) : '-'}</td>
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
  const p = id ? DB.getPosition(id) : { id: DB.nextPositionId(), name: '', level: 1, minSalary: 0, maxSalary: 0 };
  modal.open(id ? 'แก้ไขตำแหน่ง' : 'เพิ่มตำแหน่ง', `
    <form id="posForm">
      <div class="form-grid">
        <div class="form-group"><label>รหัส *</label><input name="id" value="${escapeHtml(p.id)}" required ${id ? 'readonly' : ''}/></div>
        <div class="form-group"><label>ชื่อตำแหน่ง *</label><input name="name" value="${escapeHtml(p.name)}" required placeholder="เช่น Senior Head Chef"/></div>
        <div class="form-group"><label>ระดับ (1-8) *</label><input name="level" type="number" min="1" max="20" value="${p.level || 1}" required/></div>
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
      data.level = Number(data.level); data.minSalary = Number(data.minSalary); data.maxSalary = Number(data.maxSalary);
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
      </div>` : `<div class="empty-state"><div class="icon">${ICON.money}</div><div class="title">ยังไม่มีการปรับเงินเดือน</div></div>`}
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
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${tz.today()}" required/></div>
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
      </div>` : `<div class="empty-state"><div class="icon">${ICON.bank}</div><div class="title">ยังไม่มีรายการกู้</div></div>`}
    </div>`;
});

function openLoanForm(id = null) {
  if (!requireAdmin()) return;
  const l = id ? DB.getLoans().find(x => x.id === id) : { id: '', employeeId: '', date: tz.today(), amount: 0, monthlyPayment: 0, remaining: 0, status: 'active', reason: '' };
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
      </div>` : `<div class="empty-state"><div class="icon">${ICON.cash}</div><div class="title">ยังไม่มีรายการเบิก</div></div>`}
    </div>`;
});

function openAdvanceForm(id = null) {
  if (!requireAdmin()) return;
  const a = id ? DB.getAdvances().find(x => x.id === id) : { employeeId: '', date: tz.today(), amount: 0, reason: '', status: 'pending' };
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
      </div>` : `<div class="empty-state"><div class="icon">${ICON.clipboard}</div><div class="title">ยังไม่มีรายการ</div></div>`}
    </div>`;
});

function openAllowanceForm(id = null) {
  if (!requireAdmin()) return;
  const a = id ? DB.getAllowances().find(x => x.id === id) : { employeeId: '', month: tz.thisMonth(), type: 'ค่าเดินทาง', amount: 0, note: '' };
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
      </div>` : `<div class="empty-state"><div class="icon">${ICON.chart}</div><div class="title">ยังไม่มีการประเมิน</div></div>`}
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
  const v = id ? DB.getEvaluations().find(x => x.id === id) : { employeeId: '', date: tz.today(), period: 'ครึ่งปี ' + tz.thisYear(), score: 0, grade: 'C', note: '' };
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
      <div class="stat-card"><div class="stat-icon bg-primary">${ICON.users}</div><div class="stat-content"><div class="stat-label">พนักงานปฏิบัติงาน</div><div class="stat-value">${fmt.num(s.activeEmployees)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-green">${ICON.money}</div><div class="stat-content"><div class="stat-label">ค่าใช้จ่ายต่อเดือน</div><div class="stat-value">${fmt.money(s.totalMonthlySalary)}</div></div></div>
      <div class="stat-card"><div class="stat-icon bg-blue">${ICON.trendUp}</div><div class="stat-content"><div class="stat-label">ค่าใช้จ่ายต่อปี</div><div class="stat-value">${fmt.money(s.totalMonthlySalary * 12)}</div></div></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">ส่งออกข้อมูล</div></div>
      <div class="flex gap-2" style="flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="exportEmployeesXLSX()">${ICON.download}พนักงาน (Excel)</button>
        <button class="btn btn-secondary" onclick="exportPayrollXLSX()">${ICON.download}บัญชีเงินเดือน (Excel)</button>
        <button class="btn btn-secondary" onclick="exportLoansXLSX()">${ICON.download}รายการกู้ (Excel)</button>
        <button class="btn btn-secondary" onclick="exportDataJSON()">${ICON.download}สำรองข้อมูลทั้งหมด (JSON)</button>
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
  const month = tz.thisMonth();
  const rows = DB.getEmployees({ status: 'active' }).map(e => {
    const extraAllow = DB.getAllowances(e.id).filter(a => a.month === month).reduce((s, a) => s + (a.amount || 0), 0);
    const adv = DB.getAdvances(e.id).filter(a => a.status === 'paid' && (a.date || '').startsWith(month)).reduce((s, a) => s + (a.amount || 0), 0);
    const loanDed = DB.getLoans(e.id).filter(l => l.status === 'active').reduce((s, l) => s + (l.monthlyPayment || 0), 0);
    const gross = totalIncome(e) + extraAllow;
    const net = gross - adv - loanDed;
    return {
      'รหัส': excelNum(e.id),
      'ชื่อ-นามสกุล': (e.title || '') + e.firstName + ' ' + e.lastName,
      'ฝ่าย': (DB.getDepartment(e.department) || {}).name || '',
      'ตำแหน่ง': e.positionTitle,
      'เลขบัญชี': (e.bank ? e.bank + ' ' : '') + (e.bankAccount || ''),
      'เงินเดือน': e.salary || 0,
      'ค่าตำแหน่ง': e.allowancePosition || 0,
      'ค่าเดินทาง': e.allowanceTravel || 0,
      'ค่าอาหาร': e.allowanceFood || 0,
      'ค่าเบี้ยเลี้ยง': e.allowancePerDiem || 0,
      'ค่าภาษา': e.allowanceLanguage || 0,
      'ค่าอื่นๆ': e.allowanceOther || 0,
      'เบี้ยเลี้ยงพิเศษ': extraAllow,
      'รวมรายได้': gross,
      'หักเบิกล่วงหน้า': adv,
      'หักผ่อนกู้': loanDed,
      'รับสุทธิ': net
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'เงินเดือน ' + month);
  XLSX.writeFile(wb, `คชา-เงินเดือน-${month}.xlsx`);
  toast('ส่งออกบัญชีเงินเดือนแล้ว', 'success');
}

function exportLoansXLSX() {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportLoansXLSX, 800); return; }
  const rows = DB.getLoans().map(l => {
    const e = DB.getEmployee(l.employeeId) || {};
    return { 'วันที่': excelDate(l.date), 'รหัสพนักงาน': excelNum(l.employeeId), 'ชื่อ-นามสกุล': (e.firstName || '') + ' ' + (e.lastName || ''),
      'จำนวนกู้': Number(l.amount || 0), 'ผ่อน/เดือน': Number(l.monthlyPayment || 0), 'คงเหลือ': Number(l.remaining || 0),
      'สถานะ': l.status === 'completed' ? 'ปิดยอด' : 'ผ่อนอยู่', 'เหตุผล': l.reason };
  });
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'การกู้');
  XLSX.writeFile(wb, `คชา-รายการกู้-${tz.today()}.xlsx`);
  toast('ส่งออกแล้ว', 'success');
}

function exportDataJSON() {
  const snapshot = { exportedAt: new Date().toISOString(), ...DB.data };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `คชา-ข้อมูลสำรอง-${tz.today()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('สำรองข้อมูลแล้ว', 'success');
}

// ═══════════════════════════════════════════════════════
//  PAGE: CALENDAR
// ═══════════════════════════════════════════════════════
router.register('calendar', () => {
  const items = DB.getCalendar();
  const today = tz.today();
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
  const c = id ? DB.getCalendar().find(x => x.id === id) : { date: tz.today(), title: '', type: 'holiday' };
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
        <button class="btn btn-secondary" onclick="exportDataJSON()">${ICON.download}ดาวน์โหลดข้อมูลสำรอง (snapshot)</button>
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
// ─── KEYBOARD + BROWSER BACK SUPPORT ───
// ESC = ปิด modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modalRoot').children.length) {
    e.preventDefault();
    modal.close();
  }
});
// Browser back button = ปิด modal (ถ้าเปิดอยู่) แทนออกจากเว็บ
window.addEventListener('popstate', () => {
  if ($('#modalRoot').children.length) {
    // modal เปิดอยู่ → ปิด (skipHistory เพราะ popstate ได้ pop ให้แล้ว)
    modal.close(true);
  }
});

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
