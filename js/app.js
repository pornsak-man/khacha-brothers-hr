/* ═══════════════════════════════════════════════════════════
   KACHA BROTHERS HR — APP LOGIC (Supabase + Realtime)
   ═══════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ─── Performance helpers ───
// debounce — รวม event ติดๆ กันให้ run แค่ครั้งสุดท้าย (เช่น พิมพ์เร็วใน search)
// trailing-edge: รอจน user หยุดพิมพ์ ms มิลลิวินาทีก่อน fire
function debounce(fn, ms = 150) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
// runWhenIdle — ทำงานเมื่อเบราว์เซอร์ว่าง (ไม่ block main thread)
// fallback: setTimeout 1 เมื่อไม่มี requestIdleCallback (Safari < 17.4)
const runWhenIdle = (fn, timeout = 1000) =>
  (window.requestIdleCallback || ((cb) => setTimeout(cb, 1)))(fn, { timeout });

// ─── Number count-up animation — ใช้กับ KPI cards บน dashboard ───
// อ่านเลขปลายทางจาก element textContent → animate จาก 0 → target ใน 600ms
// ใช้ requestAnimationFrame + easeOutQuart ให้ดู smooth premium
// รักษา formatting เดิม (comma separator, decimal places) ผ่าน parseFloat + format
// respect prefers-reduced-motion → ตั้งค่า target ตรงเลย
function animateCountUp(el, duration = 600) {
  if (!el) return;
  const raw = el.textContent.trim();
  const m = raw.match(/^([\-+]?[\d,]+(?:\.\d+)?)(.*)$/);
  if (!m) return;
  const target = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(target)) return;
  const suffix = m[2] || '';
  const decimals = (m[1].split('.')[1] || '').length;
  // Respect user preference
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = target.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
    return;
  }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);  // easeOutQuart
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const v = target * ease(p);
    el.textContent = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  // เริ่มที่ 0 ทันที (กัน flash เลขเต็ม)
  el.textContent = (0).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
  requestAnimationFrame(step);
}
// animate ทุก .sw-stat-value ที่อยู่ใน .sw-stats-grid (KPI cards เท่านั้น)
function animateKPICounters() {
  document.querySelectorAll('.sw-stats-grid .sw-stat-value').forEach(el => animateCountUp(el));
}

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

// ─── [PERF] Lazy XLSX loader (เดิม eager ใน index.html ~500KB) ─────────────
// XLSX ใช้แค่หน้า import/export — โหลดเมื่อ user เรียกครั้งแรก, cache promise
// ระหว่างโหลด exportEmployeesXLSX/downloadEmployeeTemplate/import จะ await ก่อน
let _xlsxLoadPromise = null;
function loadXLSX() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (_xlsxLoadPromise) return _xlsxLoadPromise;
  _xlsxLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.integrity = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { _xlsxLoadPromise = null; reject(new Error('โหลด XLSX library ไม่สำเร็จ — เช็คสัญญาณเน็ต')); };
    document.head.appendChild(s);
  });
  return _xlsxLoadPromise;
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

// CSV Injection guard — ถ้าค่าขึ้นต้นด้วยอักขระสูตร Excel จะรันสูตร (อาจเป็นมัลแวร์)
// เช่น =1+cmd|'/c calc'!A1 → Excel เปิดเครื่องคิดเลข; @SUM(A:A) → คำนวณ
// แก้โดย prefix อะพอสทรอฟี ' (Excel แสดงค่าเป็น text)
function csvSafe(v) {
  if (v == null || v === '') return v;
  if (typeof v !== 'string') return v;
  // อักขระอันตราย: = + - @ และ \t (tab) \r (CR)
  if (/^[=+\-@\t\r]/.test(v)) return "'" + v;
  return v;
}

// Excel file size limit (MB) — ป้องกัน user upload ไฟล์ใหญ่ทำ browser ค้าง
const EXCEL_MAX_MB = 25;

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

// ─── REUSABLE EMPLOYEE PICKER (searchable input + datalist) ───
// ใช้แทน <select> ที่มีพนักงานเยอะ — พิมพ์ ชื่อ/นามสกุล/ชื่อเล่น/รหัส กรองได้
// คืน HTML string. Call wireEmployeePickers() หลัง render เพื่อ attach listeners
let _empPickerSeq = 0;
function employeePicker({ name, emps, selected = '', required = false, placeholder = 'พิมพ์ค้นหา ชื่อ / นามสกุล / ชื่อเล่น / รหัส', containerClass = '' }) {
  const id = 'emp_pk_' + (++_empPickerSeq);
  const dlId = id + '_dl';
  const empFormat = (e) => `${e.id} — ${(e.title || '') + (e.firstName || '')} ${e.lastName || ''}${e.nickname ? ' (' + e.nickname + ')' : ''}`;
  const selectedEmp = selected ? emps.find(e => e.id === selected) : null;
  const displayVal = selectedEmp ? empFormat(selectedEmp) : '';
  return `
    <input type="text"
           id="${id}_search"
           class="emp-picker-search ${containerClass}"
           data-picker="${id}"
           list="${dlId}"
           autocomplete="off"
           ${required ? 'required' : ''}
           placeholder="${escapeHtml(placeholder)}"
           value="${escapeHtml(displayVal)}"/>
    <input type="hidden" name="${name}" id="${id}" value="${escapeHtml(selected)}"/>
    <datalist id="${dlId}">
      ${emps.map(e => `<option value="${escapeHtml(empFormat(e))}"></option>`).join('')}
    </datalist>
    <small class="muted-2" id="${id}_hint" style="font-size:11px"></small>
  `;
}

// Wire all employee pickers in a container (default: document)
// Optional onPick(emp, hiddenInput) callback fires when selection valid
function wireEmployeePickers(rootSelector, onPick) {
  const root = rootSelector ? document.querySelector(rootSelector) : document;
  if (!root) return;
  root.querySelectorAll('.emp-picker-search').forEach(input => {
    if (input.dataset.wired) return; // กัน wire ซ้ำ
    input.dataset.wired = '1';
    const pickerId = input.dataset.picker;
    const hidden = document.getElementById(pickerId);
    const hint = document.getElementById(pickerId + '_hint');
    const update = () => {
      const v = (input.value || '').trim();
      let emp = null;
      if (v) {
        // exact ID
        emp = DB.getEmployee(v);
        // "ID — name" format
        if (!emp && v.includes('—')) {
          const id = v.split(/\s*—\s*/)[0].trim();
          emp = DB.getEmployee(id);
        }
      }
      if (emp) {
        hidden.value = emp.id;
        if (hint) hint.innerHTML = `<span style="color:var(--success)">✓ ${escapeHtml(emp.firstName + ' ' + (emp.lastName || ''))}</span>`;
        if (onPick) onPick(emp, hidden);
      } else {
        hidden.value = '';
        if (hint) hint.innerHTML = v ? '<span style="color:var(--danger)">ไม่พบพนักงาน</span>' : '';
      }
    };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
  });
}

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
// SVG icons สำหรับ toast แต่ละ type — รวมใน toast() เพื่อ premium feel
const _toastIcons = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};
const toast = (msg, type = 'info') => {
  const root = $('#toastRoot');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast toast-v3 ' + type;
  el.innerHTML = `
    <span class="toast-icon">${_toastIcons[type] || _toastIcons.info}</span>
    <span class="toast-msg"></span>
    <button class="toast-close" aria-label="ปิด" type="button">&times;</button>`;
  el.querySelector('.toast-msg').textContent = msg;
  root.appendChild(el);
  const dismiss = () => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 280);
  };
  el.querySelector('.toast-close').addEventListener('click', dismiss);
  setTimeout(dismiss, 3200);
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
  },
  // คืน string ที่กรอก หรือ null ถ้ายกเลิก
  prompt(title, message, defaultValue = '') {
    return new Promise((resolve) => {
      this.open(title, `<p>${escapeHtml(message)}</p><textarea id="kbPromptInput" rows="3" style="width:100%;margin-top:8px" placeholder="พิมพ์ที่นี่...">${escapeHtml(defaultValue)}</textarea>`, {
        footer: `<button class="btn btn-secondary" data-cancel>ยกเลิก</button><button class="btn btn-primary" data-ok>ตกลง</button>`
      });
      const root = $('#modalRoot');
      const input = root.querySelector('#kbPromptInput');
      setTimeout(() => input?.focus(), 30);
      root.querySelector('[data-ok]').addEventListener('click', () => { const v = input?.value || ''; this.close(); resolve(v); });
      root.querySelector('[data-cancel]').addEventListener('click', () => { this.close(); resolve(null); });
    });
  }
};

// ─────────────── AUTH ───────────────
const auth = {
  init() {
    // ─── [PERF] Pre-warm hCaptcha ตอน user focus input ครั้งแรก ───
    // hCaptcha invisible execute ใช้ ~2-2.5 วินาที — แทนที่จะรอตอนกด login,
    // เริ่ม execute ตอน user เริ่มกรอกฟอร์ม → token พร้อมก่อนกดปุ่ม
    // (run ขนานกับ user typing → critical path ไม่เห็นเวลา 2.4s นี้แล้ว)
    let _prewarmed = false;
    const triggerPrewarm = () => {
      if (_prewarmed) return;
      _prewarmed = true;
      try { DB.prewarmCaptcha?.(); } catch (e) {}
    };
    $('#loginEmail')?.addEventListener('focus', triggerPrewarm, { once: true });
    $('#loginPass')?.addEventListener('focus', triggerPrewarm, { once: true });
    $('#loginEmail')?.addEventListener('input', triggerPrewarm, { once: true });
    $('#loginPass')?.addEventListener('input', triggerPrewarm, { once: true });

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = $('#loginEmail').value.trim();
      // ถ้า user กรอกรหัสพนักงาน (ไม่มี @) → แปลงเป็น email pattern ของระบบ
      // ถ้ามี @ อยู่แล้ว → ใช้ตรงๆ (เผื่อ admin บัญชีพิเศษ)
      const email = raw.includes('@') ? raw.toLowerCase() : `${raw.toLowerCase()}@kacha.local`;
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
        // ตรวจสถานะพ้นสภาพ — ถ้า resigned → block
        const blocked = await this.checkTerminationAndBlock();
        if (blocked) {
          err.textContent = blocked;
          return;
        }
        this.showApp();
      } catch (ex) {
        err.textContent = ex.message === 'Invalid login credentials'
          ? 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง'
          : (ex.message || 'เข้าสู่ระบบไม่สำเร็จ');
      } finally {
        btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ';
      }
    });
    $('#logoutBtn').addEventListener('click', () => this.logout());
    $('#impersonateBtn').addEventListener('click', () => this.toggleImpersonate());
    $('#changePwdBtn').addEventListener('click', () => openChangePasswordModal());
  },

  toggleImpersonate() {
    const newVal = !DB.isViewingAsEmployee();
    if (newVal && (!DB.isHR || !DB.profile?.employee_id)) {
      toast('โหมดนี้สำหรับ HR/admin ที่ผูก employee_id เท่านั้น', 'error');
      return;
    }
    DB.setEmployeeView(newVal);
    this.refreshImpersonateUI();
    if (typeof updateAnnouncementBadge === 'function') updateAnnouncementBadge();
    // re-render หน้าปัจจุบันให้สะท้อนมุมมองใหม่ (Personal Dashboard, banner ฯลฯ)
    router.go(router.current || 'dashboard');
    toast(newVal ? '👤 สลับเป็นมุมมองพนักงานแล้ว' : '↩ กลับมาเป็นมุมมอง HR แล้ว', 'success');
  },

  // อัปเดต UI ที่เกี่ยวข้องกับ impersonate mode (ปุ่ม + ป้าย role + banner)
  refreshImpersonateUI() {
    const canImpersonate = DB.isHR && !!DB.profile?.employee_id;
    const btn = $('#impersonateBtn');
    if (btn) {
      btn.style.display = canImpersonate ? '' : 'none';
      if (DB.isViewingAsEmployee()) {
        btn.title = 'กลับเป็นมุมมอง HR';
        btn.style.color = 'var(--warning)';
      } else {
        btn.title = 'ดูเสมือนพนักงาน';
        btn.style.color = '';
      }
    }
    // อัปเดต role label บน sidebar — บอกชัดเจนว่ากำลัง impersonate
    const roleEl = $('.user-role');
    if (roleEl && canImpersonate && DB.isViewingAsEmployee()) {
      const empId = DB.profile.employee_id;
      const emp = DB.getEmployee(empId);
      const empName = emp ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() : empId;
      roleEl.innerHTML = `<span style="color:var(--warning);font-weight:600">👤 มุมมองพนักงาน</span><div style="font-size:11px;color:var(--text-3);margin-top:2px">${escapeHtml(empName)}</div>`;
    }
  },
  async logout() {
    await DB.signOut();
    // ─── Reset client-side state (กัน state leak ระหว่างผู้ใช้บนเครื่องเดียวกัน) ───
    // ทุก global filter/UI state กลับสู่ค่าเริ่มต้น
    try {
      if (typeof empState === 'object') Object.assign(empState, { search: '', branch: '', department: '', position: '', status: 'active', sortBy: '', sortDir: 'asc', page: 1 });
      if (typeof recruitState === 'object') Object.assign(recruitState, { search: '', status: '', year: '', page: 1 });
      if (typeof _swapReqUI === 'object') Object.assign(_swapReqUI, { tab: 'pending', search: '', branch: '', status: '', page: 0 });
      if (typeof _calendarState === 'object') _calendarState.filterYear = new Date().getFullYear();
      if (typeof _empAccFilter === 'object') Object.assign(_empAccFilter, { search: '', branch: '', role: '', accStatus: '' });
      if (typeof _leaveState === 'object') Object.assign(_leaveState, { tab: 'pending', filterYear: new Date().getFullYear() });
      if (typeof _leaveFilters === 'object') Object.assign(_leaveFilters, { search: '', leaveType: '', status: '', branch: '', from: '', to: '' });
      if (typeof _auditState === 'object') Object.assign(_auditState, { page: 0, filterTable: '', filterAction: '', filterSearch: '', rows: [], total: 0, hasLoaded: false });
    } catch (e) { /* state may not exist yet */ }
    this.showLogin();
  },

  // ─── TERMINATION ENFORCEMENT ───
  // ตรวจว่า user คนที่ login อยู่ พ้นสภาพแล้วหรือไม่ (termination_date <= today)
  // ถ้าพ้นสภาพ → signOut + return error message
  // คืน null = ผ่าน, string = error message (พ้นสภาพ)
  async checkTerminationAndBlock() {
    const empId = DB.profile?.employee_id;
    if (!empId) return null; // admin/HR ที่ไม่ผูก employee_id → ปล่อยผ่าน
    const emp = DB.getEmployee(empId);
    if (!emp) return null; // ไม่มี record → ปล่อยผ่าน
    const status = DB.empStatus(emp);
    if (status === 'resigned') {
      const dateStr = emp.terminationDate ? fmt.date(emp.terminationDate) : '';
      await DB.signOut();
      this.showLogin();
      return `บัญชีนี้พ้นสภาพแล้ว${dateStr ? ' (วันที่ ' + dateStr + ')' : ''} — ไม่สามารถเข้าใช้งานระบบได้ · ติดต่อ HR หากเป็นข้อผิดพลาด`;
    }
    return null;
  },
  showLogin() {
    $('#loginScreen').style.display = 'flex';
    $('#app').style.display = 'none';
  },
  showApp() {
    // ─── PERF: วัดเวลา showApp (DOM swap + nav setup + dashboard render + first paint) ───
    const _tShowApp0 = performance.now();
    $('#loginScreen').style.display = 'none';
    $('#app').style.display = 'grid';
    const displayName = DB.profile?.name || DB.user?.email?.split('@')[0] || 'User';
    $('#userName').textContent = displayName;
    $('#userAvatar').textContent = displayName.charAt(0).toUpperCase();
    // แสดง role ตามจริงเพื่อให้ user รู้สิทธิ์ของตนเอง
    const roleLabel = DB.isAdmin ? 'ผู้ดูแลระบบ'
      : DB.role === 'hr' ? 'เจ้าหน้าที่บุคคล'
      : DB.role === 'area_manager' ? 'ผู้จัดการเขต'
      : DB.role === 'branch_manager' ? 'ผู้จัดการสาขา'
      : DB.role === 'operation_manager' ? 'ผู้จัดการฝ่ายปฏิบัติการ'
      : DB.role === 'branch_staff' ? 'พนักงานสาขา'
      : 'ผู้ใช้งานทั่วไป';
    $('.user-role').textContent = roleLabel;
    if (typeof updateUniformBadge === 'function') updateUniformBadge();
    if (typeof updateLeaveBadge === 'function') updateLeaveBadge();
    if (typeof updateCalendarBadge === 'function') updateCalendarBadge();
    if (typeof updateSSOBadge === 'function') updateSSOBadge();
    if (typeof updateAnnouncementBadge === 'function') updateAnnouncementBadge();
    this.refreshImpersonateUI();
    // ซ่อนเมนูตาม role:
    //   .nav-admin-only  → เฉพาะ admin (ตั้งค่าระบบ)
    //   .nav-hr-only     → admin + hr (ปรับค่าจ้าง, กู้, audit log)
    //   .nav-staff-hide  → ซ่อนสำหรับ branch_staff / viewer (เมนูที่ไม่จำเป็นต่อพนักงานสาขา)
    $$('.nav-admin-only').forEach(el => { el.style.display = DB.isAdmin ? '' : 'none'; });
    $$('.nav-hr-only').forEach(el => { el.style.display = DB.isHR ? '' : 'none'; });
    const isStaffOnly = (DB.role === 'branch_staff' || DB.role === 'viewer');
    // ใช้ ternary 2 ทางเพื่อ reset display ตอน login ใหม่เป็น role ที่ต่างจากเดิม
    // (ก่อนหน้านี้ใช้ if-only — ทำให้ inline display:none ค้างเมื่อ login จาก staff → admin)
    $$('.nav-staff-hide').forEach(el => { el.style.display = isStaffOnly ? 'none' : ''; });
    router.go('dashboard');
    // ─── PERF log: showApp render + first paint + grand total ───
    const _tAfterRender = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const _tFirstPaint = performance.now();
      try {
        const s = window.__signInTimings || {};
        const t = window.__bootTimings || { phases: {}, queries: {} };
        const renderMs = Math.round(_tAfterRender - _tShowApp0);
        const paintMs  = Math.round(_tFirstPaint - _tShowApp0);
        const grandTotal = (s.captcha || 0) + (s.auth_api || 0) + (t.phases.phase1_total || 0) + paintMs;
        console.log('%c⏱ showApp: render+nav ' + renderMs + ' ms · paint ready at ' + paintMs + ' ms', 'color:#b87a08;font-weight:bold');
        if (s.captcha != null) {
          console.log('%c⏱ TOTAL หลังกดเข้าระบบ ≈ ' + grandTotal + ' ms', 'color:#166534;font-weight:bold;font-size:13px');
          console.table({
            '1. captcha': s.captcha + ' ms',
            '2. auth API': s.auth_api + ' ms',
            '3. Phase 1 data': t.phases.phase1_total + ' ms',
            '4. render + first paint': paintMs + ' ms',
            'รวม': grandTotal + ' ms'
          });
        }
      } catch (e) {}
    }));
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

// admin + hr — สำหรับ action ที่ HR ทำได้ (เพิ่ม/แก้พนักงาน, loans, advances, allowance ฯลฯ)
function requireHR() {
  if (!DB.isHR) {
    toast('คุณไม่มีสิทธิ์ทำรายการนี้ (เฉพาะ HR/Admin)', 'error');
    return false;
  }
  return true;
}

// ─────────────── CHANGE PASSWORD (ทุกคน) ───────────────
function openChangePasswordModal() {
  if (!DB.user) { toast('กรุณา login ก่อน', 'error'); return; }
  modal.open('🔑 เปลี่ยนรหัสผ่าน', `
    <form id="changePwdForm">
      <div class="form-group">
        <label>รหัสผ่านปัจจุบัน *</label>
        <input type="password" name="oldPwd" required autocomplete="current-password" autofocus />
      </div>
      <div class="form-group">
        <label>รหัสผ่านใหม่ * <span class="muted-2" style="font-weight:normal;font-size:11px">(อย่างน้อย 8 ตัว)</span></label>
        <input type="password" name="newPwd" required minlength="8" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label>ยืนยันรหัสผ่านใหม่ *</label>
        <input type="password" name="confirmPwd" required minlength="8" autocomplete="new-password" />
      </div>
      <div id="changePwdHint" style="font-size:12px;color:var(--text-3);padding:10px 12px;background:var(--surface-2);border-radius:8px;margin:8px 0">
        💡 รหัสผ่านที่ดี: ผสม a-z, A-Z, 0-9 อย่างน้อย 8 ตัว · ไม่ใช้รหัสเดียวกับ email หรือเลขประชาชน
      </div>
      <div id="changePwdError" class="login-error" style="color:var(--danger);font-size:13px;margin:8px 0;display:none"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary" id="changePwdSubmit">เปลี่ยนรหัสผ่าน</button>
      </div>
    </form>
  `, { size: 'sm' });

  const errEl = document.getElementById('changePwdError');
  const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = ''; };

  document.getElementById('changePwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    const fd = new FormData(e.target);
    const oldPwd = fd.get('oldPwd') || '';
    const newPwd = fd.get('newPwd') || '';
    const confirmPwd = fd.get('confirmPwd') || '';
    if (newPwd !== confirmPwd) { showErr('รหัสผ่านใหม่ทั้ง 2 ช่องไม่ตรงกัน'); return; }
    if (newPwd === oldPwd)    { showErr('รหัสผ่านใหม่ต้องต่างจากรหัสเดิม'); return; }
    if (newPwd.length < 8)    { showErr('รหัสผ่านใหม่ต้องอย่างน้อย 8 ตัว'); return; }
    const btn = document.getElementById('changePwdSubmit');
    btn.disabled = true; btn.textContent = 'กำลังเปลี่ยน...';
    try {
      await DB.changePassword(oldPwd, newPwd);
      modal.close();
      toast('✓ เปลี่ยนรหัสผ่านสำเร็จ — login ครั้งต่อไปใช้รหัสใหม่', 'success');
    } catch (ex) {
      showErr(ex.message || String(ex));
      btn.disabled = false; btn.textContent = 'เปลี่ยนรหัสผ่าน';
    }
  });
}

// ─────────────── ROUTER ───────────────
const router = {
  current: 'dashboard',
  pages: {},
  register(name, fn) { this.pages[name] = fn; },
  go(name) {
    const isNavigation = this.current !== name;
    // ใช้ View Transitions API (Chrome 111+, Edge, Safari 18+) เพื่อ smooth animate
    // ตอน re-render หน้า (filter/realtime) — ลด flicker เห็นชัด
    // Fallback: เบราว์เซอร์เก่าจะ render ทันทีเหมือนเดิม (graceful degradation)
    if (document.startViewTransition && !isNavigation) {
      return document.startViewTransition(() => this._doRender(name, isNavigation));
    }
    return this._doRender(name, isNavigation);
  },
  _doRender(name, isNavigation) {
    this.current = name;
    // destroy charts ก่อนเปลี่ยนหน้า — canvas เก่าจะถูกทิ้ง, ป้องกัน memory leak + ghost tooltips
    if (typeof destroyAllCharts === 'function') destroyAllCharts();
    $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === name));
    const titles = {
      dashboard: 'แดชบอร์ด',
      employees: 'ทะเบียนพนักงาน',
      departments: 'ฝ่าย',
      positions: 'ระดับตำแหน่ง',
      branches: 'สาขา',
      recruit: 'รับสมัครงาน',
      uniform: 'จัดชุดพนักงาน',
      audit: 'ประวัติการแก้ไข',
      blacklist: 'รายชื่อห้ามจ้าง',
      leave: 'การลางาน',
      'salary-adjust': 'ปรับค่าจ้าง / ตำแหน่ง / สาขา',
      loans: 'การกู้เงินบริษัท',
      advances: 'เบิกเงินล่วงหน้า',
      allowance: 'เบี้ยเลี้ยงรายเดือน',
      evaluations: 'ประเมินผลงาน',
      reports: 'รายงาน / Export',
      calendar: 'วันหยุดประเพณี',
      announcements: 'ประกาศ & คำสั่ง',
      sso: 'ประกันสังคม',
      'branch-managers': 'ผู้บังคับบัญชาสาขา',
      'user-roles': 'ผู้ใช้และสิทธิ์',
      settings: 'ตั้งค่าระบบ'
    };
    $('#pageTitle').textContent = titles[name] || name;
    const fn = this.pages[name];
    const content = $('#content');
    // ─── Banner "ดูเสมือนพนักงาน" — เตือนชัดเจนว่ากำลัง impersonate ───
    const impersonateBanner = DB.isViewingAsEmployee()
      ? `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;margin-bottom:14px;background:linear-gradient(90deg, rgba(217,119,6,0.12), rgba(217,119,6,0.04));border:1px solid var(--warning);border-radius:8px;font-size:13px">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <div style="flex:1"><strong style="color:var(--warning)">👤 มุมมองพนักงาน</strong> · กำลังดูระบบเสมือน HR เป็นพนักงานทั่วไป — สิทธิ์เขียน/แก้ยังเหมือนเดิม</div>
        <button class="btn btn-sm btn-secondary" onclick="auth.toggleImpersonate()">↩ กลับเป็น HR</button>
      </div>`
      : '';
    content.innerHTML = impersonateBanner + (fn ? fn() : '<p>ไม่พบหน้า</p>');
    // ใส่ animation class เฉพาะตอนเปลี่ยนหน้าจริงๆ (ไม่ใส่ตอน refresh จาก realtime)
    if (isNavigation) {
      content.classList.remove('sw-anim-enter');
      void content.offsetWidth; // force reflow → ให้ animation รันใหม่
      content.classList.add('sw-anim-enter');
    }
    if (window.afterRender) { window.afterRender(); window.afterRender = null; }
    if (name === 'employees') wireEmployeePage();
    if (name === 'positions') wirePositionsPage();
    if (name === 'departments') wireDepartmentsPage();
    if (name === 'blacklist') wireBlacklistPage();
    if (name === 'recruit') wireRecruitPage();
    if (name === 'settings' && typeof renderEmpAccounts === 'function') renderEmpAccounts();
    if (name === 'user-roles' && typeof renderEmpAccounts === 'function') renderEmpAccounts();
    $('#sidebar').classList.remove('open');
  },
  refresh() { this.go(this.current); }
};

// ─── REALTIME UPDATE — TARGETED REFRESH ───
// ตาราง → หน้าที่ขึ้นกับตารางนั้น (ถ้า user ไม่ได้อยู่หน้านี้ จะไม่ refresh)
const _RT_PAGE_DEPS = {
  employees: ['dashboard', 'employees', 'departments', 'positions', 'salary-adjust', 'loans', 'advances', 'allowance', 'evaluations', 'reports', 'recruit', 'uniform', 'branches', 'sso'],
  departments: ['dashboard', 'employees', 'departments', 'recruit'],
  position_levels: ['employees', 'positions', 'recruit'],
  salary_history: ['dashboard', 'salary-adjust'],
  loans: ['loans'],
  advances: ['advances'],
  allowances: ['allowance'],
  evaluations: ['evaluations'],
  calendar_items: ['dashboard', 'calendar'],
  company_settings: ['settings'],
  user_profiles: ['settings'],
  applicants: ['dashboard', 'recruit'],
  uniform_items: ['uniform'],
  uniform_requests: ['dashboard', 'uniform'],
  uniform_issues: ['uniform'],
  branches: ['dashboard', 'employees', 'branches', 'uniform'],
  audit_log: ['audit'],
  leave_requests: ['dashboard', 'leave'],
  leave_types: ['leave'],
  holiday_swap_requests: ['dashboard', 'calendar'],
  company_announcements: ['dashboard', 'announcements']
};

// อัปเดต badge แจ้งเตือนของ "จัดชุดพนักงาน" (รอจัด)
function updateUniformBadge() {
  // ใช้ getUniformRequests() เพื่อ auto-scope ตาม RBAC (branch_manager เห็นเฉพาะสาขาตัวเอง)
  const pending = (DB.getUniformRequests({ status: 'pending' }) || []).length;
  const badge = document.getElementById('navBadgeUniform');
  if (!badge) return;
  if (pending > 0) {
    badge.textContent = String(pending);
    badge.style.display = 'inline-block';
    badge.title = `${pending} คำขอจัดชุดรอดำเนินการ`;
  } else {
    badge.style.display = 'none';
  }
}

window.onRealtimeChange = (payload) => {
  if ($('#modalRoot').children.length > 0) return; // ไม่รบกวน modal ที่กำลังเปิด
  const table = payload?.table;

  // อัปเดต badge การลา — เสมอ (ไม่ขึ้นกับหน้าปัจจุบัน)
  if (table === 'leave_requests' && typeof updateLeaveBadge === 'function') updateLeaveBadge();

  // อัปเดต badge ปฏิทิน — เสมอ (ไม่ขึ้นกับหน้าปัจจุบัน)
  if (table === 'holiday_swap_requests' && typeof updateCalendarBadge === 'function') updateCalendarBadge();

  // อัปเดต badge ประกันสังคม เมื่อ employees เปลี่ยน — เสมอ (ไม่ขึ้นกับหน้าปัจจุบัน)
  if (table === 'employees' && typeof updateSSOBadge === 'function') updateSSOBadge();

  // อัปเดต badge ประกาศ — เมื่อมีประกาศใหม่ (เพิ่ม unread) หรือ ตัวเองอ่าน (ลด unread)
  if ((table === 'company_announcements' || table === 'announcement_reads')
      && typeof updateAnnouncementBadge === 'function') {
    updateAnnouncementBadge();
    // ถ้ากำลังอยู่หน้า announcements → re-render เพื่อให้ป้าย "ยังไม่อ่าน" อัปเดต
    if (router.current === 'announcements') router.go('announcements');
  }

  // ─── TERMINATION ENFORCEMENT (Realtime) ───
  // ถ้า employees update + เกี่ยวกับ "ตัวเอง" → ตรวจว่าพ้นสภาพแล้วหรือไม่
  // ถ้าใช่ → force logout ทันที (ไม่ต้องรอ user login ใหม่)
  if (table === 'employees' && payload?.new?.id && payload.new.id === DB.profile?.employee_id) {
    setTimeout(async () => {
      const blocked = await auth.checkTerminationAndBlock();
      if (blocked) {
        toast(blocked, 'error');
      }
    }, 100); // delay เล็กน้อยให้ data sync เสร็จก่อน
  }

  // อัปเดต badge เมื่อ uniform_requests เปลี่ยน — เสมอ (ไม่ขึ้นกับหน้าปัจจุบัน)
  if (table === 'uniform_requests') {
    updateUniformBadge();
    // แจ้งเตือน toast เมื่อมีคำขอใหม่ (INSERT)
    if (payload.eventType === 'INSERT' && payload.new) {
      const r = payload.new;
      let name = '';
      if (r.employee_id) {
        const e = DB.getEmployee(r.employee_id);
        if (e) name = `${e.firstName} ${e.lastName || ''}`;
      }
      if (!name && r.applicant_id) {
        const ap = DB.getApplicant(r.applicant_id);
        if (ap) name = `${ap.firstName} ${ap.lastName || ''} (ผู้สมัคร)`;
      }
      toast(`🚨 มีคำขอจัดชุดใหม่: ${name || 'พนักงาน'}`, 'warning');
    }
  }

  // ถ้าเปลี่ยน table ที่หน้านี้ไม่ได้ใช้ → skip
  const affected = _RT_PAGE_DEPS[table];
  if (affected && !affected.includes(router.current)) return;

  // FAST PATH: หน้าพนักงาน + employees table → re-render เฉพาะตาราง (ไม่รีเฟรชทั้งหน้า)
  if (router.current === 'employees' && table === 'employees' && typeof renderEmployeeList === 'function') {
    clearTimeout(window._rtTimer);
    window._rtTimer = setTimeout(() => renderEmployeeList(), 250);
    return;
  }

  // AUDIT LOG: เรียก loadAuditPage ตรงๆ เพราะ hasLoaded กัน router.refresh ไม่ให้ refetch
  if (router.current === 'audit' && table === 'audit_log' && typeof loadAuditPage === 'function') {
    clearTimeout(window._rtTimer);
    window._rtTimer = setTimeout(() => loadAuditPage(), 800);
    return;
  }

  // dashboard มี chart + KPI ซับซ้อน — throttle นาน + animation chart รบกวนน้อยลง
  const delay = router.current === 'dashboard' ? 1500 : 400;
  clearTimeout(window._rtTimer);
  window._rtTimer = setTimeout(() => router.refresh(), delay);
};

// ═══════════════════════════════════════════════════════
//  PAGE: DASHBOARD
// ═══════════════════════════════════════════════════════
// ─── PERSONAL DASHBOARD (Self-Service) ───
// แสดง dashboard ของ user ที่ login (branch_staff / viewer) — เห็นข้อมูลของตัวเอง
function renderPersonalDashboard() {
  const empId = DB.profile?.employee_id;
  const e = empId ? DB.getEmployee(empId) : null;
  if (!e) {
    return `<div class="empty-state" style="margin-top:60px">
      <div class="icon">${ICON.users}</div>
      <div class="title">ไม่พบข้อมูลพนักงาน</div>
      <div class="hint">บัญชีของคุณยังไม่ได้ผูกกับพนักงานในระบบ — กรุณาติดต่อ admin เพื่อผูกข้อมูล</div>
    </div>`;
  }
  const dept = DB.getDepartment(e.department) || {};
  const pos = DB.getPosition(e.position) || {};
  const today = tz.today();
  const year = new Date().getFullYear();
  const initials = (e.firstName || '?').charAt(0);

  // คำนวณ leave balance ทุก type
  const leaveTypes = (DB.getLeaveTypesList?.() || []).filter(t => t.active !== false);
  const balances = leaveTypes
    .map(lt => ({ type: lt, ...DB.calcLeaveBalance(e.id, lt.id, year) }))
    .filter(b => b.quota > 0); // แสดงเฉพาะ type ที่มี quota (กรณีเพศ/อายุงาน)

  // คำขอลาของฉัน
  const myLeaves = DB.getLeaveRequests({ employeeId: e.id });
  const pending = myLeaves.filter(l => l.status === 'pending');
  const recent = myLeaves.slice().sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '')).slice(0, 5);
  const totalUsedYear = myLeaves
    .filter(l => l.status === 'approved' && (l.startDate || '').startsWith(String(year)))
    .reduce((s, l) => s + Number(l.days || 0), 0);

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">หน้าหลักของฉัน</div>
        <div class="sw-page-subtitle">สวัสดี ${escapeHtml(e.firstName || '')} — ข้อมูลส่วนตัว · คำขอลา · ประกันสังคม</div>
      </div>
      <div class="sw-page-actions">
        <button class="btn btn-primary" onclick="openLeaveRequestForm()">+ ขอลา</button>
      </div>
    </div>

    <!-- Hero card — รูป + ข้อมูลสรุป -->
    <div class="emp-hero">
      <div class="emp-hero-avatar">
        ${e.photoUrl
          ? `<img src="${escapeHtml(e.photoUrl)}" alt="" loading="lazy"/>`
          : `<div class="emp-avatar-fallback">${escapeHtml(initials)}</div>`}
      </div>
      <div class="emp-hero-info">
        <div class="emp-hero-id">รหัส ${escapeHtml(e.id)}</div>
        <h2 class="emp-hero-name">${escapeHtml((e.title || '') + e.firstName + ' ' + (e.lastName || ''))}</h2>
        <div class="emp-hero-title">${escapeHtml(e.positionTitle || pos.name || '-')}${pos.level ? ' · ระดับ ' + pos.level : ''}</div>
        <div class="emp-hero-chips">
          ${dept.name ? `<span class="emp-chip">${escapeHtml(dept.name)}</span>` : ''}
          ${e.branch ? `<span class="emp-chip">📍 ${escapeHtml(e.branch)}</span>` : ''}
          ${e.employeeType ? `<span class="emp-chip">${escapeHtml(e.employeeType)}</span>` : ''}
        </div>
      </div>
    </div>

    <!-- Stats row -->
    <div class="sw-stats-grid" style="margin-top:18px">
      <div class="sw-stat-card sw-accent-primary">
        <div class="sw-stat-icon">${ICON.money}</div>
        <div class="sw-stat-label">รายได้รวม/เดือน</div>
        <div class="sw-stat-value">${fmt.money(totalIncome(e))}</div>
        <div class="sw-stat-change">เงินเดือน + ค่าตำแหน่ง + เบี้ยเลี้ยง</div>
      </div>
      <div class="sw-stat-card sw-accent-green">
        <div class="sw-stat-icon">${ICON.calendar}</div>
        <div class="sw-stat-label">อายุงาน</div>
        <div class="sw-stat-value">${e.hireDate ? fmt.serviceYears(e.hireDate, e.terminationDate) : '-'}</div>
        <div class="sw-stat-change">เริ่มงาน ${fmt.date(e.hireDate)}</div>
      </div>
      <div class="sw-stat-card sw-accent-amber">
        <div class="sw-stat-icon">${ICON.clipboard}</div>
        <div class="sw-stat-label">คำขอลารออนุมัติ</div>
        <div class="sw-stat-value" style="color:${pending.length ? 'var(--warning)' : 'var(--text)'}">${fmt.num(pending.length)}</div>
        <div class="sw-stat-change">ใช้ลาไปแล้วปีนี้: ${fmt.num(totalUsedYear)} วัน</div>
      </div>
      <div class="sw-stat-card sw-accent-red">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg></div>
        <div class="sw-stat-label">ประกันสังคม</div>
        <div class="sw-stat-value" style="font-size:18px">${e.ssoEnrolledDate ? '<span style="color:var(--success)">✓ แจ้งเข้าแล้ว</span>' : '<span style="color:var(--warning)">รอแจ้งเข้า</span>'}</div>
        <div class="sw-stat-change">${e.ssoNo ? 'เลข สปส.: ' + escapeHtml(e.ssoNo) : 'ยังไม่มีเลข สปส.'}</div>
      </div>
    </div>

    <!-- Leave balance table -->
    ${balances.length ? `
    <div class="sw-section-label" style="margin-top:24px">วันลาคงเหลือ — ปี ${year}</div>
    <div class="sw-chart-card">
      <div class="table-wrap"><table class="table table-compact">
        <thead><tr>
          <th>ประเภทการลา</th>
          <th class="num">โควต้า (วัน)</th>
          <th class="num">ใช้ไปแล้ว</th>
          <th class="num">คงเหลือ</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${balances.map(b => {
            const usedPct = b.quota > 0 ? Math.min(100, (b.used / b.quota) * 100) : 0;
            const pctColor = usedPct >= 80 ? 'var(--danger)' : usedPct >= 50 ? 'var(--warning)' : 'var(--success)';
            return `<tr>
              <td><span class="badge ${b.type.badge || 'badge-info'}">${escapeHtml(b.type.label || b.type.id)}</span></td>
              <td class="num">${b.quota}</td>
              <td class="num" style="color:${pctColor}">${b.used}</td>
              <td class="num"><strong>${b.remaining}</strong></td>
              <td style="width:140px">
                <div style="height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden">
                  <div style="height:100%;width:${usedPct}%;background:${pctColor};transition:width .3s"></div>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>
    ` : ''}

    <!-- Recent leave requests -->
    <div class="sw-section-label" style="margin-top:24px">คำขอลาของฉัน — 5 รายการล่าสุด</div>
    <div class="sw-chart-card">
      ${recent.length ? `
        <div class="table-wrap"><table class="table table-compact">
          <thead><tr>
            <th>ประเภท</th>
            <th>วันที่</th>
            <th class="num">จำนวนวัน</th>
            <th>เหตุผล</th>
            <th>สถานะ</th>
          </tr></thead>
          <tbody>
            ${recent.map(l => {
              const typeCfg = DB.LEAVE_TYPES[l.leaveType] || { label: l.leaveType, badge: 'badge-info' };
              const statusCfg = LEAVE_STATUS_BADGE[l.status] || { label: l.status, cls: 'badge' };
              return `<tr>
                <td><span class="badge ${typeCfg.badge}">${escapeHtml(typeCfg.label)}</span></td>
                <td>${fmt.date(l.startDate)}${l.endDate && l.endDate !== l.startDate ? ' – ' + fmt.date(l.endDate) : ''}</td>
                <td class="num">${l.days}</td>
                <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(l.reason || '')}">${escapeHtml(l.reason || '-')}</td>
                <td><span class="badge ${statusCfg.cls}">${statusCfg.label}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
        <div style="text-align:right;margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="router.go('leave')">ดูทั้งหมด →</button></div>
      ` : `
        <div class="empty-state" style="padding:30px">
          <div class="title">ยังไม่มีคำขอลา</div>
          <div class="hint">กดปุ่ม "+ ขอลา" ด้านบนเพื่อสร้างคำขอแรกของคุณ</div>
        </div>
      `}
    </div>
  `;
}

const dashState = { scope: '' };

router.register('dashboard', () => {
  // ─── PERSONAL DASHBOARD (Self-Service) สำหรับ branch_staff / viewer ───
  // หรือ HR/admin ที่กำลังใช้โหมด "ดูเสมือนพนักงาน"
  // ถ้าเป็นพนักงานปกติ (ไม่ใช่ admin/hr/manager) → แสดง dashboard ส่วนตัวแทน
  if (((DB.role === 'branch_staff' || DB.role === 'viewer') || DB.isViewingAsEmployee()) && DB.profile?.employee_id) {
    return renderPersonalDashboard();
  }

  // ─── Scope filter (เห็นเฉพาะ admin/HR) — กรอง KPI/charts ตามสายงาน ───
  const scope = dashState.scope || '';
  const opts = { scope };
  const activeScope = scope ? DB.getScope(scope) : null;

  const s = DB.getStats(opts);
  const kpi = DB.getDashboardKPI(opts);
  const yearly = DB.getYearlyHireExit(null, opts);
  const monthly = yearly.months;
  const trailing12 = DB.getMonthlyHireExit(12, opts);
  const branchStats = DB.getBranchStats(opts);
  // scope chart = breakdown ของทุกสาย → แสดงเสมอ (ไม่ filter)
  const scopeStats = DB.getScopeStats();
  const recentEmps = DB._filterByScope(DB.getEmployees(), scope)
    .filter(e => DB.empStatus(e) !== 'resigned')
    .sort((a, b) => (b.hireDate || '').localeCompare(a.hireDate || ''))
    .slice(0, 10);
  const reach90 = DB.getProbationDue(90);
  const reach119 = DB.getProbationDue(119);
  const probByBranch = DB.getProbationPassByBranch();
  const pendingUniform = DB.getUniformRequests({ status: 'pending' });

  window.afterRender = () => {
    // animate KPI counters ก่อน — เห็นทันทีหลัง render เลข fade จาก 0
    animateKPICounters();
    // render charts ตอน main thread ว่าง — กัน initial render กระตุก
    runWhenIdle(() => renderDashboardCharts(s, monthly, trailing12));
    const goDash = debounce(() => router.go('dashboard'), 80);
    document.getElementById('dashScope')?.addEventListener('change', (e) => {
      dashState.scope = e.target.value;
      goDash();
    });
  };

  const todayStr = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });
  const tvColor = kpi.turnoverAnnualized <= 5 ? 'var(--success)' : kpi.turnoverAnnualized <= 10 ? 'var(--warning)' : 'var(--danger)';
  const tvDot = kpi.turnoverAnnualized <= 5 ? 'green' : kpi.turnoverAnnualized <= 10 ? 'amber' : 'red';
  const tvLabel = kpi.turnoverAnnualized <= 5 ? 'ดีมาก' : kpi.turnoverAnnualized <= 10 ? 'ปานกลาง' : 'สูง';
  const maxBranch = branchStats[0]?.count || 1;

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ภาพรวมองค์กร${activeScope ? ` <span class="badge" style="background:${escapeHtml(activeScope.badgeBg)};color:${escapeHtml(activeScope.badgeColor)};font-size:12px;padding:4px 12px;margin-left:8px;vertical-align:middle">${escapeHtml(activeScope.label)}</span>` : ''}</div>
        <div class="sw-page-subtitle">บริษัท คชา บราเธอร์ส จำกัด — ข้อมูล ณ ${todayStr}${activeScope ? ' · กรองเฉพาะสาย ' + escapeHtml(activeScope.label) : ''}</div>
      </div>
      <div class="sw-page-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${DB.isHR ? `
        <select id="dashScope" class="sw-filter-select" title="กรองตามสายงาน" style="min-width:180px">
          <option value="">— ทุกสายงาน —</option>
          ${DB.getScopes().map(sc => `<option value="${escapeHtml(sc.id)}" ${scope === sc.id ? 'selected' : ''}>${escapeHtml(sc.label)}</option>`).join('')}
        </select>
        <button class="btn btn-primary" onclick="openEmployeeForm()">+ เพิ่มพนักงาน</button>` : ''}
      </div>
    </div>

    <div class="sw-stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
      <div class="sw-stat-card sw-accent-primary">
        <div class="sw-stat-icon">${ICON.users}</div>
        <div class="sw-stat-label">พนักงานปัจจุบัน</div>
        <div class="sw-stat-value">${fmt.num(kpi.headcount)}</div>
        <div class="sw-stat-change">ประจำ ${fmt.num(kpi.ftHeadcount)} คน · รวมระบบ ${fmt.num(kpi.total)}</div>
      </div>
      <div class="sw-stat-card sw-accent-green">
        <div class="sw-stat-icon">${ICON.trendUp}</div>
        <div class="sw-stat-label">เข้าใหม่ เดือนนี้</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(kpi.newThisMonth)}</div>
        <div class="sw-stat-change">รวมปี ${kpi.year}: ${fmt.num(kpi.hireYTD)} คน · 12 เดือนย้อนหลัง</div>
        <div class="sw-stat-spark"><canvas id="sparkHires"></canvas></div>
      </div>
      <div class="sw-stat-card sw-accent-red">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 7 12 12 17 7"/></svg></div>
        <div class="sw-stat-label">พ้นสภาพ เดือนนี้</div>
        <div class="sw-stat-value" style="color:var(--danger)">${fmt.num(kpi.exitThisMonth)}</div>
        <div class="sw-stat-change">รวมปี ${kpi.year}: ${fmt.num(kpi.exitYTD)} คน · 12 เดือนย้อนหลัง</div>
        <div class="sw-stat-spark"><canvas id="sparkExits"></canvas></div>
      </div>
      <div class="sw-stat-card" style="border-left:4px solid #1e88e5">
        <div class="sw-stat-icon" style="background:rgba(30,136,229,0.12);color:#1e88e5"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>
        <div class="sw-stat-label">พนักงานลางาน</div>
        <div class="sw-stat-value" style="color:#1e88e5">${fmt.num(kpi.onLeaveToday)}</div>
        <div class="sw-stat-change">${kpi.onLeaveToday > 0 ? 'ไม่อยู่วันนี้ · กำลังอนุมัติแล้ว' : 'พนักงานครบทุกคนวันนี้'}</div>
      </div>
      ${(() => {
        const pr = kpi.probationPassRate;
        const prColor = pr === null ? 'var(--text-3)' : pr >= 80 ? 'var(--success)' : pr >= 60 ? 'var(--warning)' : 'var(--danger)';
        const prLabel = pr === null ? '—' : pr >= 80 ? 'ดีมาก' : pr >= 60 ? 'ปานกลาง' : 'ต่ำ';
        return `<div class="sw-stat-card" style="border-left:4px solid ${prColor}">
        <div class="sw-stat-icon" style="background:rgba(196,165,116,0.14);color:var(--gold,#c4a574)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
        <div class="sw-stat-label">อัตราผ่านทดลองงาน</div>
        <div class="sw-stat-value" style="color:${prColor}">${pr === null ? '—' : pr.toFixed(1) + '%'}</div>
        <div class="sw-stat-change">${pr === null ? 'ยังไม่มี ปจ. ครบ 120 วัน' : `${prLabel} · เฉพาะ ปจ. · ${fmt.num(kpi.probationPassed)}/${fmt.num(kpi.probationCohortSize)} คน${kpi.inProbation ? ' · กำลังทดลอง ' + fmt.num(kpi.inProbation) : ''}`}</div>
      </div>`;
      })()}
      <div class="sw-stat-card sw-accent-amber" style="border-left:4px solid ${tvColor}">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg></div>
        <div class="sw-stat-label">Turnover Rate (คาดทั้งปี)</div>
        <div class="sw-stat-value" style="color:${tvColor}">${kpi.turnoverAnnualized.toFixed(2)}%</div>
        <div class="sw-stat-change"><span class="sw-dot ${tvDot}"></span>${tvLabel} · เฉพาะ ปจ. · YTD ${kpi.turnoverYTD.toFixed(2)}%</div>
      </div>
    </div>

    ${pendingUniform.length ? `
    <div class="sw-section-label">แจ้งเตือนด่วน</div>
    <div class="sw-chart-card" style="border-left:4px solid var(--danger);background:linear-gradient(90deg, rgba(220,38,38,0.04), transparent 60%)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
        <div class="sw-chart-title" style="display:flex;align-items:center;gap:10px">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/></svg>
          <span style="color:var(--danger)">มีคำขอจัดชุดรอดำเนินการ</span>
          <span class="badge badge-danger" style="font-size:12px;padding:4px 12px;font-weight:700">${pendingUniform.length} รายการ</span>
        </div>
        <button class="btn btn-primary btn-sm" onclick="router.go('uniform')">ไปจัดชุด →</button>
      </div>
      <div class="sw-chart-sub" style="margin-bottom:14px">Recruit แจ้งมาแล้ว — Benefit ต้องดำเนินการก่อนวันเริ่มงาน</div>
      <div style="max-height:240px;overflow-y:auto">
        ${pendingUniform.slice(0, 8).map(r => {
          let name = '-', branchInfo = '-', refBadge = '';
          if (r.employeeId) {
            const e = DB.getEmployee(r.employeeId) || {};
            name = `${e.firstName || ''} ${e.lastName || ''}`.trim();
            branchInfo = e.branch || '-';
            refBadge = '<span class="badge badge-success" style="font-size:10px">พนักงาน</span>';
          } else if (r.applicantId) {
            const ap = DB.getApplicant(r.applicantId) || {};
            name = `${ap.firstName || ''} ${ap.lastName || ''}`.trim();
            branchInfo = ap.branch || '-';
            refBadge = '<span class="badge badge-warning" style="font-size:10px">ผู้สมัคร</span>';
          }
          const daysLeft = r.neededBy ? Math.ceil((new Date(r.neededBy) - new Date()) / 86400000) : null;
          const urgentBadge = daysLeft != null && daysLeft <= 3
            ? `<span class="badge badge-danger" style="font-size:10.5px;margin-left:6px">⏰ เหลือ ${daysLeft} วัน</span>`
            : '';
          return `
          <div style="display:flex;align-items:center;gap:14px;padding:10px 8px;border-bottom:1px solid var(--border);cursor:pointer" onclick="router.go('uniform')">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13.5px">${escapeHtml(name)} ${refBadge}${urgentBadge}</div>
              <div class="muted-2" style="font-size:12px;margin-top:2px">สาขา ${escapeHtml(branchInfo)} · แจ้งโดย ${escapeHtml(r.requestedBy || '-')}${r.neededBy ? ' · ต้องการก่อน ' + fmt.date(r.neededBy) : ''}</div>
            </div>
          </div>`;
        }).join('')}
        ${pendingUniform.length > 8 ? `<div class="muted-2" style="text-align:center;padding:10px;font-size:12px">+ อีก ${pendingUniform.length - 8} รายการ</div>` : ''}
      </div>
    </div>
    ` : ''}

    ${(reach90.length || reach119.length) ? `
    <div class="sw-section-label">ทดลองงาน</div>
    <div class="sw-charts-grid">
      <div class="sw-chart-card" style="border-left:3px solid var(--warning)">
        <div class="sw-chart-title">ครบทดลองงาน 90 วัน — เดือนนี้
          <span class="badge badge-warning" style="margin-left:10px;font-size:11px">${reach90.length} คน</span>
        </div>
        <div class="sw-chart-sub">ครบกำหนดทดลองงาน — ควรประเมินผลก่อนตัดสินใจ</div>
        <div style="max-height:320px;overflow-y:auto">
          ${reach90.length ? reach90.map((e, i) => `
            <div class="sw-recent-item" onclick="viewEmployee('${escapeHtml(e.id)}')">
              <div class="probation-rank amber">${i + 1}</div>
              <div class="sw-recent-info">
                <div class="sw-recent-name">${escapeHtml((e.title || '') + e.firstName + ' ' + e.lastName)}</div>
                <div class="sw-recent-sub">${escapeHtml(e.positionTitle || '-')} · ${escapeHtml(e.branch || '-')}</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:11px;color:var(--text-3)">ครบกำหนด</div>
                <div style="font-size:13px;font-weight:600;color:var(--warning)">${fmt.date(e.reachDate)}</div>
              </div>
            </div>`).join('') : '<div style="padding:30px;text-align:center;color:var(--text-3);font-size:13px">— ไม่มีพนักงานที่ครบ 90 วันในเดือนนี้ —</div>'}
        </div>
      </div>
      <div class="sw-chart-card" style="border-left:3px solid var(--danger)">
        <div class="sw-chart-title">ครบ 119 วัน (ก่อนครบ 120 วัน) — เดือนนี้
          <span class="badge badge-danger" style="margin-left:10px;font-size:11px">${reach119.length} คน</span>
        </div>
        <div class="sw-chart-sub">ต้องตัดสินใจก่อนครบ 120 วัน (เลิกจ้างต้องจ่ายค่าชดเชยตามกฎหมาย)</div>
        <div style="max-height:320px;overflow-y:auto">
          ${reach119.length ? reach119.map((e, i) => `
            <div class="sw-recent-item" onclick="viewEmployee('${escapeHtml(e.id)}')">
              <div class="probation-rank red">${i + 1}</div>
              <div class="sw-recent-info">
                <div class="sw-recent-name">${escapeHtml((e.title || '') + e.firstName + ' ' + e.lastName)}</div>
                <div class="sw-recent-sub">${escapeHtml(e.positionTitle || '-')} · ${escapeHtml(e.branch || '-')}</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:11px;color:var(--text-3)">ครบกำหนด</div>
                <div style="font-size:13px;font-weight:600;color:var(--danger)">${fmt.date(e.reachDate)}</div>
              </div>
            </div>`).join('') : '<div style="padding:30px;text-align:center;color:var(--text-3);font-size:13px">— ไม่มีพนักงานที่ครบ 119 วันในเดือนนี้ —</div>'}
        </div>
      </div>
    </div>` : ''}

    ${probByBranch.length ? (() => {
      const withCohort = probByBranch.filter(b => b.cohort > 0);
      const totalCohort = withCohort.reduce((s, b) => s + b.cohort, 0);
      const totalPassed = withCohort.reduce((s, b) => s + b.passed, 0);
      const overallRate = totalCohort > 0 ? (totalPassed / totalCohort * 100) : null;
      return `
    <div class="sw-section-label">อัตราผ่านทดลองงาน รายสาขา</div>
    <div class="sw-chart-card">
      <div class="sw-chart-title">อัตราผ่านทดลองงาน 120 วัน — แยกตามสาขา
        <span class="badge badge-success" style="margin-left:10px;font-size:11px">${withCohort.length} สาขามีข้อมูล</span>
        ${overallRate !== null ? `<span class="badge" style="margin-left:6px;font-size:11px;background:rgba(196,165,116,0.18);color:var(--gold,#6b4f23)">รวม ${overallRate.toFixed(1)}%</span>` : ''}
      </div>
      <div class="sw-chart-sub">เฉพาะพนักงานประจำ (Full-time) · จ้างใน 12 เดือนล่าสุด + ครบ 120 วันแล้ว (เกณฑ์เดียวกับ KPI ด้านบน)</div>
      <div style="max-height:540px;overflow-y:auto;padding-right:6px;margin-top:10px">
        ${probByBranch.map(b => {
          if (b.cohort === 0) {
            return `<div style="margin-bottom:14px;opacity:0.55">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;gap:10px;flex-wrap:wrap">
                <div style="font-size:13.5px;font-weight:600;color:var(--text)">${escapeHtml(b.branch)}</div>
                <div style="font-size:11.5px;color:var(--text-3)">— ยังไม่มี ปจ. ครบ 120 วันใน 12 เดือนล่าสุด${b.inProbation ? ` · กำลังทดลอง ${fmt.num(b.inProbation)} คน` : ''}</div>
              </div>
              <div class="sw-bar-bg"><div class="sw-bar-fill" style="width:0%"></div></div>
            </div>`;
          }
          const rate = b.rate;
          const color = rate >= 80 ? 'var(--success)' : rate >= 60 ? 'var(--warning)' : 'var(--danger)';
          const label = rate >= 80 ? 'ดีมาก' : rate >= 60 ? 'ปานกลาง' : 'ต่ำ';
          return `<div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;gap:10px;flex-wrap:wrap">
              <div style="font-size:13.5px;font-weight:600;color:var(--text)">${escapeHtml(b.branch)}
                <span style="font-size:11px;font-weight:500;color:${color};margin-left:6px">· ${label}</span>
              </div>
              <div style="font-size:12px;color:var(--text-3);text-align:right;font-variant-numeric:tabular-nums">
                <span style="font-size:15px;font-weight:700;color:${color}">${rate.toFixed(1)}%</span>
                <span style="font-size:11.5px;margin-left:6px">ผ่าน ${fmt.num(b.passed)}/${fmt.num(b.cohort)} คน${b.failed ? ` · ไม่ผ่าน ${fmt.num(b.failed)}` : ''}${b.inProbation ? ` · กำลังทดลอง ${fmt.num(b.inProbation)}` : ''}</span>
              </div>
            </div>
            <div class="sw-bar-bg"><div class="sw-bar-fill" style="width:${rate.toFixed(1)}%;background:${color}"></div></div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
    })() : ''}

    <div class="sw-section-label">ภาพรวมพนักงาน</div>
    <div class="sw-charts-grid">
      <div class="sw-chart-card">
        <div class="sw-chart-title">พนักงานที่เพิ่งเพิ่มเข้าระบบ</div>
        <div class="sw-chart-sub">10 รายล่าสุด · ที่ยังปฏิบัติงาน</div>
        <div>${recentEmps.map(e => `
          <div class="sw-recent-item" onclick="viewEmployee('${escapeHtml(e.id)}')">
            ${e.photoUrl ? `<img src="${escapeHtml(e.photoUrl)}" class="avatar-thumb" alt=""/>` : `<div class="avatar-thumb avatar-thumb-text">${escapeHtml((e.firstName || '?').charAt(0))}</div>`}
            <div class="sw-recent-info">
              <div class="sw-recent-name">${escapeHtml((e.title || '') + e.firstName + ' ' + e.lastName)}</div>
              <div class="sw-recent-sub">${escapeHtml(e.positionTitle || '-')} · ${escapeHtml(e.branch || '-')}</div>
            </div>
            <div class="sw-recent-date">${fmt.date(e.hireDate)}</div>
          </div>`).join('')}</div>
      </div>
      <div class="sw-chart-card">
        <div class="sw-chart-title">สาขาตามจำนวนพนักงาน</div>
        <div class="sw-chart-sub">${branchStats.length} สาขา · ${fmt.num(branchStats.reduce((s, b) => s + b.count, 0))} คน</div>
        <div style="max-height:540px;overflow-y:auto;padding-right:6px">
          ${branchStats.map(b => {
            const pct = (b.count / maxBranch * 100).toFixed(1);
            return `<div style="margin-bottom:14px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
                <div style="font-size:13.5px;font-weight:600;color:var(--text)">${escapeHtml(b.branch)}</div>
                <div style="font-size:13.5px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">${fmt.num(b.count)} <span style="font-size:11px;font-weight:500;color:var(--text-3)">คน</span></div>
              </div>
              <div class="sw-bar-bg"><div class="sw-bar-fill" style="width:${pct}%"></div></div>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>

    ${scopeStats.length ? (() => {
      const totalScopeEmps = scopeStats.reduce((sum, s) => sum + s.count, 0);
      const maxScope = scopeStats[0]?.count || 1;
      return `
    <div class="sw-chart-card" style="margin-top:18px">
      <div class="sw-chart-title">พนักงานตามสายงาน</div>
      <div class="sw-chart-sub">${scopeStats.length} สาย · ${fmt.num(totalScopeEmps)} คน · คำนวณจาก ตำแหน่ง → สาย</div>
      <div style="display:flex;flex-direction:column;gap:14px;margin-top:14px">
        ${scopeStats.map(s => {
          const pct = (s.count / maxScope * 100).toFixed(1);
          const pctOfTotal = totalScopeEmps ? (s.count / totalScopeEmps * 100).toFixed(1) : '0.0';
          return `<div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;gap:8px;flex-wrap:wrap">
              <span class="badge" style="background:${escapeHtml(s.badgeBg)};color:${escapeHtml(s.badgeColor)};font-size:11.5px;padding:3px 10px;font-weight:600">${escapeHtml(s.label)}</span>
              <div style="font-size:13.5px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">${fmt.num(s.count)} <span style="font-size:11px;font-weight:500;color:var(--text-3)">คน · ${pctOfTotal}%</span></div>
            </div>
            <div class="sw-bar-bg"><div class="sw-bar-fill" style="width:${pct}%;background:${escapeHtml(s.badgeColor)}"></div></div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
    })() : ''}

    <div class="sw-section-label">การวิเคราะห์</div>
    <div class="sw-chart-card">
      <div class="sw-chart-title">พนักงานเข้า / ออก ประจำปี ${yearly.year}</div>
      <div class="sw-chart-sub">เปรียบเทียบจำนวนเข้าใหม่ กับพ้นสภาพ แต่ละเดือน</div>
      <canvas id="chartMonthly" style="max-height:280px"></canvas>
    </div>

    <div class="chart-row">
      <div class="chart-box"><div class="sw-chart-title">พนักงานตามตำแหน่งงาน</div><div class="sw-chart-sub">${s.byPosition.length} ตำแหน่ง · เรียงจากจำนวนมาก → น้อย</div><canvas id="chartByPosition"></canvas></div>
      <div class="chart-box"><div class="sw-chart-title">สัดส่วนเพศ</div><div class="sw-chart-sub">${fmt.num(s.activeEmployees)} คนทำงานอยู่</div><canvas id="chartByGender"></canvas></div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-title">ช่วงอายุพนักงาน</div>
      <div class="sw-chart-sub">นับเฉพาะที่ยังปฏิบัติงาน · ${fmt.num(s.byAge.reduce((sum, b) => sum + b.count, 0))} คน</div>
      <canvas id="chartByAge" style="max-height:280px"></canvas>
    </div>

    <div class="sw-section-label">การลาออก</div>
    <div class="sw-chart-card">
      <div class="sw-chart-title">Turnover Rate ของทุกสาขา</div>
      <div class="sw-chart-sub">อัตราการลาออกของ <strong>พนักงานประจำ</strong> 12 เดือนล่าสุด · (จำนวนลาออก / จำนวนเฉลี่ย) × 100 · เรียงสูงสุด → ต่ำสุด · ${s.turnoverByBranch.length} สาขา</div>
      <canvas id="chartTurnoverByBranch" style="max-height:${Math.max(280, s.turnoverByBranch.length * 28)}px"></canvas>
    </div>
  `;
});

// ─── CHART MANAGER ───
// เก็บ Chart instance ตาม canvas — destroy ของเก่าก่อนสร้างใหม่ (เลี่ยง memory leak + flicker)
const _chartInstances = new Map();
function makeChart(canvasId, config) {
  const el = $(`#${canvasId}`);
  if (!el) return null;
  const old = _chartInstances.get(canvasId);
  if (old) old.destroy();
  const inst = new Chart(el, config);
  _chartInstances.set(canvasId, inst);
  return inst;
}
function destroyAllCharts() {
  for (const c of _chartInstances.values()) c.destroy();
  _chartInstances.clear();
}

// ─── Premium Chart Palette ─────────────────────────────────
// Cohesive editorial palette — navy + sage green accent + refined semantics
const CHART_PALETTE = {
  primary:   '#1e2a52',  primaryHover:   '#14213d',  primaryLight:   'rgba(30, 42, 82, 0.10)',
  emerald:   '#166534',  emeraldHover:   '#0e4d27',  emeraldLight:   'rgba(22, 101, 52, 0.10)',
  crimson:   '#c4243f',  crimsonHover:   '#9a1a30',  crimsonLight:   'rgba(196, 36, 63, 0.10)',
  amber:     '#b87a08',  amberHover:     '#945e06',  amberLight:     'rgba(184, 122, 8, 0.10)',
  gold:      '#c4a574',  goldHover:      '#a88652',  goldLight:      'rgba(196, 165, 116, 0.14)',
  // Backward-compat aliases (.sage → champagne gold)
  sage:      '#c4a574',  sageHover:      '#a88652',  sageLight:      'rgba(196, 165, 116, 0.14)',
  // Slate ramp — older = darker (intuitive for age)
  slateRamp: ['#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1e293b'],
  slateRampDark: ['#475569', '#64748b', '#94a3b8', '#cbd5e1', '#e2e8f0', '#f1f5f9'],
  slateMuted: '#e2e8f0'
};

// Build a vertical canvas gradient (Chart.js compatible)
function makeChartGradient(ctx, colorTop, colorBottom = 'rgba(255,255,255,0)') {
  const canvas = ctx.canvas;
  const height = canvas.height || 400;
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, colorTop);
  g.addColorStop(1, colorBottom);
  return g;
}

function renderDashboardCharts(s, monthly, trailing12) {
  if (typeof Chart === 'undefined') { setTimeout(() => renderDashboardCharts(s, monthly, trailing12), 200); return; }
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const P = CHART_PALETTE;
  Chart.defaults.color = isDark ? '#adada4' : '#5e5d57';
  Chart.defaults.font.family = 'Inter, "IBM Plex Sans Thai", system-ui, sans-serif';
  Chart.defaults.font.size = 12;
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(20,20,15,0.04)';
  const tooltipStyle = {
    backgroundColor: isDark ? 'rgba(20, 20, 24, 0.96)' : 'rgba(14, 14, 12, 0.96)',
    titleColor: '#fff',
    bodyColor: '#e8e8e0',
    borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    cornerRadius: 8,
    padding: 12,
    titleFont: { size: 12.5, weight: '600' },
    bodyFont: { size: 12.5 },
    boxPadding: 6,
    displayColors: true,
    usePointStyle: true,
    caretSize: 0
  };

  // ── Monthly hire/exit — premium line chart with gradient fills ──
  if ($('#chartMonthly') && monthly) {
    const labels = monthly.map(m => {
      const d = new Date(m.year, m.month - 1, 1);
      return d.toLocaleDateString('th-TH', { month: 'short' });
    });
    makeChart('chartMonthly', {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'เข้าใหม่',
            data: monthly.map(m => m.hires),
            borderColor: P.emerald,
            backgroundColor: (ctx) => {
              const c = ctx.chart.ctx;
              if (!c) return 'transparent';
              return makeChartGradient(c, 'rgba(21, 146, 63, 0.18)', 'rgba(21, 146, 63, 0)');
            },
            borderWidth: 2.5,
            tension: 0.38,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: '#fff',
            pointHoverBorderColor: P.emerald,
            pointHoverBorderWidth: 2.5,
            fill: true,
            cubicInterpolationMode: 'monotone'
          },
          {
            label: 'พ้นสภาพ',
            data: monthly.map(m => m.exits),
            borderColor: P.crimson,
            backgroundColor: (ctx) => {
              const c = ctx.chart.ctx;
              if (!c) return 'transparent';
              return makeChartGradient(c, 'rgba(215, 38, 38, 0.15)', 'rgba(215, 38, 38, 0)');
            },
            borderWidth: 2.5,
            tension: 0.38,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: '#fff',
            pointHoverBorderColor: P.crimson,
            pointHoverBorderWidth: 2.5,
            fill: true,
            cubicInterpolationMode: 'monotone'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top', align: 'end',
            labels: { usePointStyle: true, pointStyle: 'circle', padding: 18, boxWidth: 8, boxHeight: 8, font: { size: 12.5, weight: '500' } }
          },
          tooltip: tooltipStyle
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 12 } }, border: { display: false } },
          y: { beginAtZero: true, ticks: { stepSize: 2, precision: 0, font: { size: 12 } }, grid: { color: gridColor }, border: { display: false } }
        }
      }
    });
  }

  // ── พนักงานตามตำแหน่งงาน — navy gradient bars ──
  if ($('#chartByPosition') && s.byPosition?.length) {
    makeChart('chartByPosition', {
      type: 'bar',
      data: {
        labels: s.byPosition.map(p => p.name),
        datasets: [{
          label: 'จำนวน',
          data: s.byPosition.map(p => p.count),
          backgroundColor: (ctx) => {
            const c = ctx.chart.ctx;
            if (!c) return P.primary;
            return makeChartGradient(c, P.primary, 'rgba(29, 63, 143, 0.45)');
          },
          hoverBackgroundColor: (ctx) => {
            const c = ctx.chart.ctx;
            if (!c) return P.primaryHover;
            return makeChartGradient(c, P.primaryHover, 'rgba(22, 48, 115, 0.55)');
          },
          borderRadius: 5, borderSkipped: false, barPercentage: 0.62, categoryPercentage: 0.82
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltipStyle, callbacks: { label: (ctx) => `  ${ctx.parsed.y.toLocaleString('th-TH')} คน` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 45, minRotation: 30, autoSkip: false }, border: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: gridColor }, border: { display: false } }
        }
      }
    });
  }

  // ── เพศ — navy + champagne gold (editorial luxe) ──
  if ($('#chartByGender')) makeChart('chartByGender', {
    type: 'doughnut',
    data: {
      labels: ['ชาย', 'หญิง'],
      datasets: [{
        data: [s.byGender.male, s.byGender.female],
        backgroundColor: [P.primary, P.sage],
        hoverBackgroundColor: [P.primaryHover, P.sageHover],
        borderWidth: 0,
        hoverOffset: 8,
        spacing: 2
      }]
    },
    options: {
      responsive: true, cutout: '70%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, font: { size: 12.5, weight: '500' } } },
        tooltip: { ...tooltipStyle, callbacks: { label: (ctx) => `  ${ctx.label}: ${ctx.parsed.toLocaleString('th-TH')} คน` } }
      }
    }
  });

  // ── ช่วงอายุพนักงาน — slate ramp (intuitive: older = darker) ──
  if ($('#chartByAge') && s.byAge?.length) {
    const ramp = isDark ? P.slateRampDark : P.slateRamp;
    const undefinedColor = isDark ? '#334155' : P.slateMuted;
    const colors = s.byAge.map((b) => {
      if (b.label === 'ไม่ระบุวันเกิด') return undefinedColor;
      const idx = ['ต่ำกว่า 20 ปี','20-29 ปี','30-39 ปี','40-49 ปี','50-59 ปี','60 ปีขึ้นไป'].indexOf(b.label);
      return idx >= 0 ? ramp[idx] : (isDark ? '#94a3b8' : '#475569');
    });
    makeChart('chartByAge', {
      type: 'bar',
      data: {
        labels: s.byAge.map(b => b.label),
        datasets: [{
          label: 'จำนวน',
          data: s.byAge.map(b => b.count),
          backgroundColor: colors,
          hoverBackgroundColor: colors.map(c => c),
          borderRadius: 5, borderSkipped: false, barPercentage: 0.6, categoryPercentage: 0.78
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltipStyle, callbacks: { label: (ctx) => `  ${ctx.parsed.y.toLocaleString('th-TH')} คน` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 12 } }, border: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: gridColor }, border: { display: false } }
        }
      }
    });
  }

  // ── KPI Sparklines — gradient fills (premium minis) ──
  if (trailing12 && trailing12.length) {
    const sparkOpts = (rgbColor, lightRgba) => ({
      type: 'line',
      data: {
        labels: trailing12.map(m => m.ym),
        datasets: [{
          data: [],
          borderColor: rgbColor,
          borderWidth: 2,
          tension: 0.38,
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: true,
          backgroundColor: (ctx) => {
            const c = ctx.chart.ctx;
            if (!c) return lightRgba;
            return makeChartGradient(c, lightRgba, lightRgba.replace(/[\d.]+\)$/, '0)'));
          },
          cubicInterpolationMode: 'monotone'
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
        elements: { line: { borderJoinStyle: 'round' } }
      }
    });
    if ($('#sparkHires')) {
      const cfg = sparkOpts(P.emerald, 'rgba(21, 146, 63, 0.18)');
      cfg.data.datasets[0].data = trailing12.map(m => m.hires);
      makeChart('sparkHires', cfg);
    }
    if ($('#sparkExits')) {
      const cfg = sparkOpts(P.crimson, 'rgba(215, 38, 38, 0.15)');
      cfg.data.datasets[0].data = trailing12.map(m => m.exits);
      makeChart('sparkExits', cfg);
    }
  }

  // ── Turnover Rate ของทุกสาขา — horizontal bar, สีเปลี่ยนตามระดับ ──
  if ($('#chartTurnoverByBranch') && s.turnoverByBranch?.length) {
    const data = s.turnoverByBranch;
    // สีตามระดับ turnover: > 20% danger, 10-20% warning, < 10% success
    const colorFor = (rate) => {
      if (rate >= 20) return { bg: 'rgba(215,38,38,0.78)', hover: 'rgba(215,38,38,0.95)' };
      if (rate >= 10) return { bg: 'rgba(201,119,6,0.78)', hover: 'rgba(201,119,6,0.95)' };
      return { bg: 'rgba(21,146,63,0.78)', hover: 'rgba(21,146,63,0.95)' };
    };
    makeChart('chartTurnoverByBranch', {
      type: 'bar',
      data: {
        labels: data.map(d => d.branch),
        datasets: [{
          label: 'Turnover Rate (%)',
          data: data.map(d => d.turnover),
          backgroundColor: data.map(d => colorFor(d.turnover).bg),
          hoverBackgroundColor: data.map(d => colorFor(d.turnover).hover),
          borderRadius: 5, borderSkipped: false, barPercentage: 0.7, categoryPercentage: 0.85
        }]
      },
      options: {
        indexAxis: 'y',           // horizontal bar — รองรับสาขาเยอะ
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              label: (ctx) => {
                const d = data[ctx.dataIndex];
                return [
                  `  Turnover: ${d.turnover}%`,
                  `  ลาออก 12 เดือน: ${d.exits} คน`,
                  `  พนักงานปัจจุบัน: ${d.active} คน`,
                  `  เฉลี่ย: ${d.avgHeadcount} คน`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0, callback: (v) => v + '%' },
            grid: { color: gridColor },
            border: { display: false }
          },
          y: {
            grid: { display: false },
            ticks: { font: { size: 12 } },
            border: { display: false }
          }
        }
      }
    });
  }
}

// ═══════════════════════════════════════════════════════
//  PAGE: EMPLOYEES
// ═══════════════════════════════════════════════════════
const empState = { search: '', branch: '', department: '', position: '', status: 'active', sortBy: '', sortDir: 'asc', page: 1, pageSize: 50 };
let _empSearchTimer = null;

router.register('employees', () => {
  // 🔒 RBAC: viewer/branch_staff ดูทะเบียนพนักงานไม่ได้ — มี "หน้าหลักของฉัน" แยกต่างหาก
  if (DB.role === 'viewer' || DB.role === 'branch_staff') {
    return `<div class="sw-chart-card"><div class="empty-state" style="padding:80px 20px">
      <div style="font-size:48px;margin-bottom:14px;opacity:0.4">🔒</div>
      <div class="title" style="font-size:17px;font-weight:600">ไม่มีสิทธิ์ดูทะเบียนพนักงาน</div>
      <div class="hint" style="margin-top:6px">ใช้เมนู "หน้าหลักของฉัน" — admin / HR / Manager เท่านั้นที่ดูทะเบียนได้</div>
    </div></div>`;
  }
  const kpi = DB.getDashboardKPI();
  // ใช้ getEmployees() เพื่อ auto-scope ตาม RBAC — KPI cards/subtitle จะตรงกับสิ่งที่ user เห็นจริง
  const allEmps = DB.getEmployees();
  const active = allEmps.filter(e => DB.empStatus(e) === 'active');
  const pending = allEmps.filter(e => DB.empStatus(e) === 'pending');
  const resigned = allEmps.filter(e => DB.empStatus(e) === 'resigned');
  // อายุงานเฉลี่ย (เดือน) ของ active
  const avgMonths = active.length ? Math.round(active.reduce((s, e) => {
    if (!e.hireDate) return s;
    const m = String(e.hireDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return s;
    const hire = new Date(+m[1], +m[2] - 1, +m[3]);
    const months = (Date.now() - hire.getTime()) / (30.44 * 86400000);
    return s + months;
  }, 0) / active.length) : 0;
  const avgY = Math.floor(avgMonths / 12), avgM = avgMonths % 12;

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ทะเบียนพนักงาน</div>
        <div class="sw-page-subtitle">ข้อมูลพนักงานทั้งหมดในระบบ · ${fmt.num(allEmps.length)} คน</div>
      </div>
      <div class="sw-page-actions">
        <button class="btn btn-secondary" onclick="exportEmployeesXLSX()">${ICON.download}Export Excel</button>
        ${DB.isHR ? `<button class="btn btn-secondary" onclick="openImportEmployees()">${ICON.upload}นำเข้า Excel</button>
        <button class="btn btn-secondary" onclick="openBulkPhotoUpload()">${ICON.upload}อัปโหลดรูป</button>
        <button class="btn btn-primary" onclick="openEmployeeForm()">+ เพิ่มพนักงาน</button>` : ''}
      </div>
    </div>

    <div class="sw-stats-grid" style="margin-bottom:28px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,58,138,0.12);color:var(--primary)">${ICON.users}</div>
        <div class="sw-stat-label">พนักงานปัจจุบัน</div>
        <div class="sw-stat-value">${fmt.num(active.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">ที่ปฏิบัติงานอยู่</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(217,119,6,0.12);color:var(--warning)">⏳</div>
        <div class="sw-stat-label">นัดพ้นสภาพ</div>
        <div class="sw-stat-value" style="color:${pending.length > 0 ? 'var(--warning)' : 'var(--text)'}">${fmt.num(pending.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">มีกำหนดวันออก</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(22,163,74,0.12);color:var(--success)">${ICON.trendUp}</div>
        <div class="sw-stat-label">เข้าใหม่เดือนนี้</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(kpi.newThisMonth)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">รวมปี ${kpi.year}: ${fmt.num(kpi.hireYTD)} คน</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(124,58,237,0.12);color:#7c3aed">⏱️</div>
        <div class="sw-stat-label">อายุงานเฉลี่ย</div>
        <div class="sw-stat-value">${avgY}<span style="font-size:18px;color:var(--text-2);font-weight:500"> ปี </span>${avgM}<span style="font-size:18px;color:var(--text-2);font-weight:500"> เดือน</span></div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">เฉพาะที่ยังปฏิบัติงาน</div>
      </div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายชื่อพนักงาน</div>
          <div class="sw-chart-sub">ค้นหา กรอง และจัดเรียงได้ทุกคอลัมน์ · คลิก "ดู" เพื่อดูประวัติเงินเดือน/การกู้/ประเมิน</div>
        </div>
      </div>
      <div class="sw-filter-bar">
        <input id="empSearch" type="text" class="sw-filter-input" placeholder="🔍 ค้นชื่อ / รหัส / ชื่อเล่น / ตำแหน่ง / เลขประชาชน" value="${escapeHtml(empState.search)}" />
        <select class="sw-filter-select" id="empBranch">
          <option value="">— ทุกสาขา —</option>
          ${DB.getBranches().map(b => `<option value="${escapeHtml(b)}" ${empState.branch === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>
        <select class="sw-filter-select" id="empDepartment">
          <option value="">— ทุกฝ่าย —</option>
          ${DB.getDepartments().map(d => `<option value="${escapeHtml(d.id)}" ${empState.department === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
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
          return `<select class="sw-filter-select" id="empPosition">
            <option value="">— ทุกตำแหน่ง —</option>
            ${ops.length ? `<optgroup label="ฝ่ายปฏิบัติการ">${opt(ops)}</optgroup>` : ''}
            ${kitchen.length ? `<optgroup label="ฝ่ายครัว">${opt(kitchen)}</optgroup>` : ''}
            ${common.length ? `<optgroup label="อื่นๆ">${opt(common)}</optgroup>` : ''}
          </select>`;
        })()}
        <select class="sw-filter-select" id="empStatus">
          <option value="">— ทุกสถานะ —</option>
          <option value="active"   ${empState.status === 'active'   ? 'selected' : ''}>ปฏิบัติงาน</option>
          <option value="pending"  ${empState.status === 'pending'  ? 'selected' : ''}>นัดพ้นสภาพ</option>
          <option value="resigned" ${empState.status === 'resigned' ? 'selected' : ''}>พ้นสภาพแล้ว</option>
        </select>
        <button id="empClearFilter" class="btn btn-ghost btn-sm sw-filter-clear" onclick="clearEmpFilters()" style="${(empState.search || empState.branch || empState.department || empState.position || empState.status !== 'active') ? '' : 'display:none'}">✕ ล้างตัวกรอง</button>
      </div>
      <div id="empList"></div>
    </div>
  `;
});

// Toggle visibility ของปุ่ม "✕ ล้างตัวกรอง" ตามสถานะ filter ปัจจุบัน
function updateEmpClearButton() {
  const btn = document.getElementById('empClearFilter');
  if (!btn) return;
  const hasFilters = empState.search || empState.branch || empState.department || empState.position || (empState.status !== 'active');
  btn.style.display = hasFilters ? '' : 'none';
}

// ล้างตัวกรองทั้งหมดในหน้าทะเบียนพนักงาน (กลับไปค่าเริ่มต้น = ปฏิบัติงาน)
function clearEmpFilters() {
  empState.search = '';
  empState.branch = '';
  empState.department = '';
  empState.position = '';
  empState.status = 'active';
  empState.page = 1;
  // Reset DOM controls โดยตรง (ไม่ต้อง re-render ทั้งหน้า)
  const searchEl = document.getElementById('empSearch');
  const branchEl = document.getElementById('empBranch');
  const deptEl = document.getElementById('empDepartment');
  const positionEl = document.getElementById('empPosition');
  const statusEl = document.getElementById('empStatus');
  if (searchEl) searchEl.value = '';
  if (branchEl) branchEl.value = '';
  if (deptEl) deptEl.value = '';
  if (positionEl) positionEl.value = '';
  if (statusEl) statusEl.value = 'active';
  renderEmployeeList();
  updateEmpClearButton();
}

function wireEmployeePage() {
  renderEmployeeList();
  $('#empSearch')?.addEventListener('input', (e) => {
    // debounce 200ms — ไม่ filter ทุก keystroke
    clearTimeout(_empSearchTimer);
    _empSearchTimer = setTimeout(() => {
      empState.search = e.target.value;
      empState.page = 1;
      renderEmployeeList();
      updateEmpClearButton();
    }, 200);
  });
  $('#empBranch')?.addEventListener('change', (e) => { empState.branch = e.target.value; empState.page = 1; renderEmployeeList(); updateEmpClearButton(); });
  $('#empDepartment')?.addEventListener('change', (e) => { empState.department = e.target.value; empState.page = 1; renderEmployeeList(); updateEmpClearButton(); });
  $('#empPosition')?.addEventListener('change', (e) => { empState.position = e.target.value; empState.page = 1; renderEmployeeList(); updateEmpClearButton(); });
  $('#empStatus')?.addEventListener('change', (e) => { empState.status = e.target.value; empState.page = 1; renderEmployeeList(); updateEmpClearButton(); });

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
    container.innerHTML = `<div class="empty-state" style="padding:60px 20px">
      <div style="font-size:42px;margin-bottom:12px;opacity:0.35">👥</div>
      <div class="title" style="font-size:16px;font-weight:600">ไม่พบพนักงานที่ตรงกับเงื่อนไข</div>
      <div class="hint" style="margin-top:6px">ลองเปลี่ยนตัวกรอง หรือเพิ่มพนักงานใหม่</div>
    </div>`;
    return;
  }
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table table-compact sw-emp-table">
        <thead>
          <tr>
            <th class="num">#</th>
            <th class="sortable" data-sort="id">รหัส ${sortIcon('id')}</th>
            <th class="sortable" data-sort="firstName">พนักงาน ${sortIcon('firstName')}</th>
            <th class="sortable" data-sort="positionTitle">ตำแหน่ง ${sortIcon('positionTitle')}</th>
            <th class="sortable" data-sort="branch">สาขา ${sortIcon('branch')}</th>
            <th>ฝ่าย</th>
            <th class="sortable" data-sort="hireDate">เริ่มงาน ${sortIcon('hireDate')}</th>
            <th class="sortable" data-sort="serviceMonths">อายุงาน ${sortIcon('serviceMonths')}</th>
            <th class="num sortable" data-sort="age">อายุ ${sortIcon('age')}</th>
            <th class="num sortable" data-sort="salary">เงินเดือน ${sortIcon('salary')}</th>
            <th>สถานะ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${list.map((e, i) => {
            const g = DB.genderCode(e.gender);
            const genderMark = g ? `<span class="sw-gender ${g === 'M' ? 'sw-gender-m' : 'sw-gender-f'}">${g === 'M' ? '♂' : '♀'}</span>` : '';
            const fullName = ((e.title || '') + e.firstName + ' ' + (e.lastName || '')).trim();
            const nickname = e.nickname ? `<span class="muted-2"> · ${escapeHtml(e.nickname)}</span>` : '';
            const st = DB.empStatus(e);
            let statusCell;
            if (st === 'active') statusCell = '<span class="badge badge-success">ปฏิบัติงาน</span>';
            else if (st === 'pending') statusCell = `<span class="badge badge-warning" title="ยังปฏิบัติงาน — มีนัดพ้นสภาพ">นัด ${fmt.date(e.terminationDate)}</span>`;
            else statusCell = `<span class="badge badge-danger">พ้น ${fmt.date(e.terminationDate)}</span>`;
            return `<tr>
              <td class="num muted-2">${start + i + 1}</td>
              <td><code style="font-size:11.5px;font-weight:600">${escapeHtml(e.id)}</code></td>
              <td>
                <div class="sw-emp-cell">
                  <strong>${escapeHtml(fullName)} ${genderMark}</strong>${e.nickname ? `<span class="muted-2" style="margin-left:6px">· ${escapeHtml(e.nickname)}</span>` : ''}
                </div>
              </td>
              <td class="sw-cell-meta">${escapeHtml(e.positionTitle || '—')}</td>
              <td class="sw-cell-meta">${escapeHtml(e.branch || '—')}</td>
              <td class="sw-cell-meta">${escapeHtml((DB.getDepartment(e.department) || {}).name || '—')}</td>
              <td class="sw-cell-meta">${fmt.date(e.hireDate)}</td>
              <td class="sw-cell-meta">${fmt.serviceYears(e.hireDate, e.terminationDate)}</td>
              <td class="num">${e.dob ? fmt.age(e.dob).replace(' ปี', '') : '—'}</td>
              <td class="num"><strong>${maskMoney(e.salary, e.id)}</strong></td>
              <td>${statusCell}</td>
              <td class="actions">
                <button class="btn btn-ghost btn-sm" onclick="viewEmployee('${e.id}')">ดู</button>
                ${DB.canEdit() ? `<button class="btn btn-ghost btn-sm" onclick="openEmployeeForm('${e.id}')">แก้</button>` : ''}
                ${DB.canDelete() ? `<button class="btn btn-ghost btn-sm" onclick="deleteEmployee('${e.id}')">ลบ</button>` : ''}
              </td>
            </tr>`;
          }).join('')}
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
  terminationReasons: ['ลาออก', 'ครบสัญญาจ้าง', 'ถูกเลิกจ้าง', 'ไล่ออก (ผิดวินัย)', 'เกษียณอายุ', 'เสียชีวิต', 'พ้นทดลองงาน (ไม่ผ่าน)', 'ย้ายไปบริษัทในเครือ', 'อื่นๆ'],
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

// รายได้รวมต่อเดือน = เงินเดือน + ค่าตำแหน่ง + ค่าเดินทาง + ค่าอาหาร + ค่าเบี้ยเลี้ยง + ค่าภาษา + ค่าโทรศัพท์ + ค่าอื่นๆ
const totalIncome = (e) => Number(e.salary || 0) + Number(e.allowancePosition || 0) +
  Number(e.allowanceTravel || 0) + Number(e.allowanceFood || 0) +
  Number(e.allowancePerDiem || 0) + Number(e.allowanceLanguage || 0) +
  Number(e.allowancePhone || 0) + Number(e.allowanceOther || 0);

// ─── SALARY MASKING ───
// แสดง "•••" สำหรับ user ที่ไม่มีสิทธิ์ดูเงินเดือน (ใช้ใน table cells/labels)
// • canSeeSalary() = admin หรือ hr (กำหนดที่ data.js)
// • ยกเว้น: ดูเงินเดือนของตัวเองได้เสมอ (Branch Staff self-service ในอนาคต)
const maskMoney = (v, ownerEmpId = null) => {
  if (DB.canSeeSalary?.()) return fmt.money(v);
  if (ownerEmpId && DB.profile?.employee_id === ownerEmpId) return fmt.money(v);
  return '•••';
};

// ─── 👀 Preview HTML Builder — แสดงข้อมูลก่อนบันทึก ───
// คืน HTML string สำหรับใส่ใน #empPreviewPane
function buildEmployeePreview(data, isNew, currentEmp, pendingPhotoBlob, removePhoto) {
  const dept = DB.getDepartment(data.department) || {};
  const pos = DB.getPosition(data.position) || {};
  const fullName = `${data.title || ''}${data.firstName || ''} ${data.lastName || ''}`.trim();
  const nickname = data.nickname ? ` (${data.nickname})` : '';
  const age = data.dob ? fmt.age(data.dob) : '';

  // คำนวณรายได้รวม
  const num = (k) => Number(data[k] || 0);
  const totalIncome = num('salary') + num('allowancePosition') + num('allowanceTravel')
    + num('allowanceFood') + num('allowancePerDiem') + num('allowanceLanguage')
    + num('allowancePhone') + num('allowanceOther');

  // photo preview
  let photoHtml = '';
  if (pendingPhotoBlob) {
    photoHtml = '<div class="muted-2" style="font-size:12px;color:var(--success)">📸 มีรูปใหม่รอ upload</div>';
  } else if (removePhoto) {
    photoHtml = '<div class="muted-2" style="font-size:12px;color:var(--danger)">🗑️ จะลบรูปออก</div>';
  } else if (currentEmp.photoUrl) {
    photoHtml = '<div class="muted-2" style="font-size:12px">📷 ใช้รูปเดิม</div>';
  } else {
    photoHtml = '<div class="muted-2" style="font-size:12px">— ไม่มีรูป —</div>';
  }

  // diff สำหรับ edit mode — เก็บ field ที่เปลี่ยน
  let diffHtml = '';
  if (!isNew && currentEmp) {
    const watchFields = {
      firstName: 'ชื่อ', lastName: 'นามสกุล', nickname: 'ชื่อเล่น',
      phone: 'เบอร์โทร', email: 'อีเมล',
      department: 'ฝ่าย', branch: 'สาขา', position: 'ระดับตำแหน่ง', positionTitle: 'ตำแหน่ง',
      employeeType: 'ประเภทพนักงาน', hireDate: 'วันเริ่มงาน',
      salary: 'เงินเดือน',
      allowancePosition: 'ค่าตำแหน่ง', allowanceTravel: 'ค่าเดินทาง', allowanceFood: 'ค่าอาหาร',
      allowancePerDiem: 'ค่าเบี้ยเลี้ยง', allowanceLanguage: 'ค่าภาษา',
      allowancePhone: 'ค่าโทรศัพท์', allowanceOther: 'ค่าอื่นๆ',
      bank: 'ธนาคาร', bankAccount: 'เลขบัญชี',
      terminationDate: 'วันพ้นสภาพ', terminationReason: 'เหตุผลพ้นสภาพ'
    };
    const changes = [];
    // Lookup helpers — แสดงชื่อแทน ID สำหรับฟิลด์ที่เป็น reference
    const moneyKeys = new Set(['salary','allowancePosition','allowanceTravel','allowanceFood','allowancePerDiem','allowanceLanguage','allowancePhone','allowanceOther']);
    const lookupValue = (key, v) => {
      if (!v) return '—';
      if (key === 'department') return DB.data.departments.find(d => d.id === v)?.name || v;
      if (key === 'position')   return DB.getPosition(v)?.name || v;
      if (moneyKeys.has(key))   return fmt.money(Number(v || 0));
      return v;
    };
    for (const [key, label] of Object.entries(watchFields)) {
      const oldV = String(currentEmp[key] ?? '').trim();
      const newV = String(data[key] ?? '').trim();
      if (oldV !== newV) {
        changes.push(`<tr>
          <td style="padding:6px 12px;font-weight:600">${escapeHtml(label)}</td>
          <td style="padding:6px 12px;color:var(--text-3);text-decoration:line-through">${escapeHtml(lookupValue(key, oldV))}</td>
          <td style="padding:6px 12px;color:var(--success);font-weight:600">→ ${escapeHtml(lookupValue(key, newV))}</td>
        </tr>`);
      }
    }
    if (changes.length) {
      diffHtml = `
        <div class="form-section">
          <h3 style="color:var(--warning)">✏️ การเปลี่ยนแปลง (${changes.length} รายการ)</h3>
          <div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px">
            <table style="width:100%;border-collapse:collapse;font-size:13.5px">
              <thead><tr style="background:var(--surface-2);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-3)">
                <th style="padding:8px 12px;text-align:left">ฟิลด์</th>
                <th style="padding:8px 12px;text-align:left">เดิม</th>
                <th style="padding:8px 12px;text-align:left">ใหม่</th>
              </tr></thead>
              <tbody>${changes.join('')}</tbody>
            </table>
          </div>
        </div>`;
    } else {
      diffHtml = `<div class="form-section"><div class="muted-2" style="padding:16px;background:var(--surface-2);border-radius:8px;text-align:center">ℹ️ ไม่มีการเปลี่ยนแปลงข้อมูล</div></div>`;
    }
  }

  // "ผลที่จะเกิดขึ้น"
  let consequencesHtml = '';
  if (isNew) {
    const autoRole = DB.autoDetectRole({ position: data.position });
    const autoRoleLabel = ({
      admin: 'Admin', hr: 'HR', operation_manager: 'ผู้จัดการฝ่ายปฏิบัติการ',
      area_manager: 'ผู้จัดการเขต', branch_manager: 'ผู้จัดการสาขา',
      branch_staff: 'พนักงานสาขา', viewer: 'ผู้ใช้งานทั่วไป'
    })[autoRole] || autoRole;
    consequencesHtml = `
      <div class="form-section">
        <h3 style="color:var(--primary)">⚡ ผลที่จะเกิดขึ้นเมื่อบันทึก</h3>
        <ul style="margin:0;padding:0;list-style:none">
          <li style="padding:8px 12px;border-bottom:1px solid var(--border)">
            ✅ <strong>สร้างพนักงานใหม่</strong> รหัส <code style="background:var(--surface-2);padding:2px 8px;border-radius:4px;font-family:monospace">${escapeHtml(data.id || '?')}</code>
          </li>
          <li style="padding:8px 12px;border-bottom:1px solid var(--border)">
            🔑 <strong>สร้างบัญชี login อัตโนมัติ</strong>
            <div class="muted-2" style="font-size:12px;margin-top:4px;margin-left:24px">
              email: <code style="background:var(--surface-2);padding:2px 6px;border-radius:4px">${escapeHtml(data.id || '?')}@kacha.local</code>
              · password เริ่มต้น: เลขประชาชน
            </div>
          </li>
          <li style="padding:8px 12px">
            🎫 <strong>Auto-detect Role:</strong> <span class="badge badge-info">${escapeHtml(autoRoleLabel)}</span>
            <div class="muted-2" style="font-size:12px;margin-top:4px;margin-left:24px">จากตำแหน่งงาน "${escapeHtml(pos.name || '-')}" (Level ${pos.level || 0})</div>
          </li>
        </ul>
      </div>`;
  } else {
    consequencesHtml = `
      <div class="form-section">
        <h3 style="color:var(--primary)">⚡ ผลที่จะเกิดขึ้นเมื่อบันทึก</h3>
        <ul style="margin:0;padding:0;list-style:none">
          <li style="padding:8px 12px">
            💾 <strong>อัปเดตข้อมูลพนักงาน</strong> รหัส <code style="background:var(--surface-2);padding:2px 8px;border-radius:4px;font-family:monospace">${escapeHtml(data.id || '?')}</code>
            ${data.salary !== String(currentEmp.salary) ? '<div class="muted-2" style="font-size:12px;margin-top:4px;margin-left:24px;color:var(--warning)">⚠️ เงินเดือนเปลี่ยน — จะถูกบันทึกใน salary_history อัตโนมัติ</div>' : ''}
          </li>
        </ul>
      </div>`;
  }

  return `
    <div class="form-section">
      <h3>👀 ตรวจสอบข้อมูลก่อนบันทึก</h3>
      <div class="muted-2" style="font-size:13px;margin-top:-4px">กรุณาตรวจสอบข้อมูลด้านล่างให้ถูกต้องก่อนกด "ยืนยัน"</div>
    </div>

    <div class="form-section">
      <h3>ข้อมูลพื้นฐาน</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">ชื่อ-สกุล</div><div class="value"><strong>${escapeHtml(fullName)}</strong>${escapeHtml(nickname)}</div></div>
        <div class="emp-info-row"><div class="label">รหัสพนักงาน</div><div class="value mono">${escapeHtml(data.id || '-')}</div></div>
        <div class="emp-info-row"><div class="label">เพศ · อายุ</div><div class="value">${escapeHtml(data.gender || '-')}${age ? ' · ' + escapeHtml(age) : ''}</div></div>
        <div class="emp-info-row"><div class="label">เลขประชาชน</div><div class="value mono">${escapeHtml(data.nationalId || '-')}</div></div>
        ${data.passportNumber ? `<div class="emp-info-row"><div class="label">Passport</div><div class="value mono">${escapeHtml(data.passportNumber)}</div></div>` : ''}
        <div class="emp-info-row"><div class="label">เบอร์โทร</div><div class="value">${escapeHtml(data.phone || '-')}</div></div>
        <div class="emp-info-row"><div class="label">รูปพนักงาน</div><div class="value">${photoHtml}</div></div>
      </div>
    </div>

    <div class="form-section">
      <h3>การทำงาน</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">ฝ่าย</div><div class="value">${escapeHtml(dept.name || '-')}</div></div>
        <div class="emp-info-row"><div class="label">สาขา</div><div class="value">${escapeHtml(data.branch || '-')}</div></div>
        <div class="emp-info-row"><div class="label">ระดับตำแหน่ง</div><div class="value">${escapeHtml(pos.name || '-')}${pos.level ? ' <span class="badge badge-info" style="margin-left:6px">ระดับ ' + pos.level + '</span>' : ''}</div></div>
        <div class="emp-info-row"><div class="label">ตำแหน่ง</div><div class="value">${escapeHtml(data.positionTitle || '-')}</div></div>
        <div class="emp-info-row"><div class="label">ประเภท</div><div class="value">${escapeHtml(data.employeeType || '-')}</div></div>
        <div class="emp-info-row"><div class="label">วันเริ่มงาน</div><div class="value">${fmt.date(data.hireDate)}</div></div>
      </div>
    </div>

    <div class="form-section">
      <h3>เงินเดือนและสวัสดิการ</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">เงินเดือน</div><div class="value"><strong>${fmt.money(num('salary'))}</strong></div></div>
        ${num('allowancePosition') > 0 ? `<div class="emp-info-row"><div class="label">ค่าตำแหน่ง</div><div class="value">${fmt.money(num('allowancePosition'))}</div></div>` : ''}
        ${num('allowanceTravel') > 0 ? `<div class="emp-info-row"><div class="label">ค่าเดินทาง</div><div class="value">${fmt.money(num('allowanceTravel'))}</div></div>` : ''}
        ${num('allowanceFood') > 0 ? `<div class="emp-info-row"><div class="label">ค่าอาหาร</div><div class="value">${fmt.money(num('allowanceFood'))}</div></div>` : ''}
        ${num('allowancePerDiem') > 0 ? `<div class="emp-info-row"><div class="label">ค่าเบี้ยเลี้ยง</div><div class="value">${fmt.money(num('allowancePerDiem'))}</div></div>` : ''}
        ${num('allowanceLanguage') > 0 ? `<div class="emp-info-row"><div class="label">ค่าภาษา</div><div class="value">${fmt.money(num('allowanceLanguage'))}</div></div>` : ''}
        ${num('allowancePhone') > 0 ? `<div class="emp-info-row"><div class="label">ค่าโทรศัพท์</div><div class="value">${fmt.money(num('allowancePhone'))}</div></div>` : ''}
        ${num('allowanceOther') > 0 ? `<div class="emp-info-row"><div class="label">ค่าอื่นๆ</div><div class="value">${fmt.money(num('allowanceOther'))}</div></div>` : ''}
      </div>
      <div style="margin-top:14px;padding:14px 18px;background:var(--primary-soft);border-radius:8px;display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border)">
        <div style="font-size:13px;color:var(--text-2);font-weight:500">รวมรายได้ต่อเดือน</div>
        <div style="font-size:18px;font-weight:700;color:var(--primary)">${fmt.money(totalIncome)} บาท</div>
      </div>
    </div>

    ${data.bank || data.bankAccount ? `
    <div class="form-section">
      <h3>บัญชีธนาคาร</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">ธนาคาร</div><div class="value">${escapeHtml(data.bank || '-')}</div></div>
        <div class="emp-info-row"><div class="label">เลขบัญชี</div><div class="value mono">${escapeHtml(data.bankAccount || '-')}</div></div>
      </div>
    </div>` : ''}

    ${diffHtml}
    ${consequencesHtml}
  `;
}

function openEmployeeForm(id = null, init = null, onSaved = null) {
  if (!requireHR()) return;
  // init: pre-fill values (เช่นจาก applicant). ถ้า init.skipAutoId = true → ID ว่าง (user กรอกเอง)
  // onSaved(savedEmp): callback หลัง save สำเร็จ (เช่น update applicant status)
  const defaults = {
    id: init?.skipAutoId ? '' : DB.nextEmployeeId(),
    title: 'นาย', firstName: '', lastName: '', nickname: '',
    nationalId: '', dob: '', gender: 'ชาย',
    nationality: 'ไทย', religion: '', education: '',
    phone: '', email: '', address: '',
    subDistrict: '', district: '', province: '', postalCode: '',
    passportNumber: '', workPermitNumber: '',
    department: DB.getDepartments()[0]?.id || '', branch: '',
    position: DB.getPositions()[0]?.id || '', positionTitle: '',
    employeeType: 'พนักงานประจำ',
    hireDate: tz.today(),
    terminationDate: '', terminationReason: '', terminationNote: '',
    salary: 0,
    allowancePosition: 0, allowanceTravel: 0, allowanceFood: 0,
    allowancePerDiem: 0, allowanceLanguage: 0, allowancePhone: 0, allowanceOther: 0,
    bank: '', bankAccount: '',
    status: 'active', note: ''
  };
  const emp = id ? DB.getEmployee(id) : { ...defaults, ...(init || {}) };
  const depts = DB.getDepartments();
  const positions = DB.getPositions();

  // opt() — render <option> list, ถ้าค่า current ไม่อยู่ในรายการ → prepend option พิเศษ
  // (กันการสูญหายของค่าที่ import มาจาก source ที่ใช้รูปแบบต่าง เช่น "น.ส." ที่ไม่ได้อยู่ใน titles list)
  const opt = (values, current) => {
    const inList = current && values.includes(current);
    const extra = !inList && current ? `<option selected value="${escapeHtml(current)}">${escapeHtml(current)} (เดิม)</option>` : '';
    return extra + values.map(v => `<option ${v === current ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  };
  const dataListOpt = (values) => values.map(v => `<option value="${escapeHtml(v)}">`).join('');

  const formTitle = id ? 'แก้ไขข้อมูลพนักงาน' : (init?.fromApplicant ? 'รับเข้าทำงาน — กรอกข้อมูลพนักงาน' : 'เพิ่มพนักงานใหม่');
  modal.open(formTitle, `
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
          <div class="form-group"><label>ฝ่าย *</label><select name="department" id="empFormDept" required><option value="" ${!emp.department ? 'selected' : ''}>— เลือกฝ่าย —</option>${depts.map(d => `<option value="${d.id}" data-scope="${escapeHtml(d.scope || '')}" ${emp.department === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>สาขา</label><input name="branch" list="dl-emp-branches" value="${escapeHtml(emp.branch)}" placeholder="เช่น KMB, GE" autocomplete="off"/><datalist id="dl-emp-branches">${DB.getBranchMaster({ activeOnly: true }).map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name || b.id)}</option>`).join('')}</datalist></div>
          <div class="form-group"><label>ระดับตำแหน่งงาน *</label>${(() => {
            // filter ตาม scope ของฝ่าย (ถ้ามี): operation → ตำแหน่ง operation + ไม่ระบุ, office → office + ไม่ระบุ
            const filtered = DB.getPositionsForDepartment(emp.department || '');
            const byLevel = (a, b) => (b.level || 0) - (a.level || 0) || (a.name || '').localeCompare(b.name || '');
            const sorted = filtered.slice().sort(byLevel);
            // ถ้า scope = null (ไม่ filter) ใช้ heuristic grouping เดิม — ป้องกันรายการยาวมาก
            const dept = emp.department ? DB.getDepartment(emp.department) : null;
            const deptScope = dept?.scope || '';
            const opt = (arr) => arr.map(p => `<option value="${p.id}" ${emp.position === p.id ? 'selected' : ''}>${escapeHtml(p.name)}${p.level ? ' · ระดับ ' + p.level : ''}</option>`).join('');
            if (!deptScope) {
              // ไม่ filter — ใช้ heuristic แยก kitchen/ops/common เหมือนเดิม
              const kitchen = [], ops = [], common = [];
              for (const p of sorted) {
                const n = (p.name || '').toLowerCase();
                if (n.includes('chef') || n.includes('barista')) kitchen.push(p);
                else if (n.includes('part')) common.push(p);
                else ops.push(p);
              }
              return `<select name="position" id="empFormPos" required>
                ${ops.length ? `<optgroup label="ฝ่ายปฏิบัติการ">${opt(ops)}</optgroup>` : ''}
                ${kitchen.length ? `<optgroup label="ฝ่ายครัว">${opt(kitchen)}</optgroup>` : ''}
                ${common.length ? `<optgroup label="อื่นๆ">${opt(common)}</optgroup>` : ''}
              </select>`;
            }
            // มี scope — แสดงเฉพาะตำแหน่งที่ตรง (filter ใน getPositionsForDepartment แล้ว)
            const label = deptScope === 'operation' ? 'ตำแหน่งสายปฏิบัติการ (Operation)' : 'ตำแหน่งสายสำนักงาน (Office)';
            return `<select name="position" id="empFormPos" required>
              <optgroup label="${label}">${opt(sorted)}</optgroup>
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

      <div class="form-section" id="terminationSection" style="${emp.terminationDate ? '' : 'display:none'}">
        <h3>การพ้นสภาพ <span class="muted-2" style="font-weight:normal;font-size:12px">(แสดงเฉพาะเมื่อมีวันพ้นสภาพ)</span></h3>
        <div class="form-grid">
          <div class="form-group"><label>เหตุผลการพ้นสภาพ</label>
            <input name="terminationReason" list="dl-termination-reasons" value="${escapeHtml(emp.terminationReason)}" placeholder="เลือกหรือพิมพ์เอง"/>
          </div>
          <div class="form-group span-2"><label>รายละเอียดเพิ่มเติม</label>
            <textarea name="terminationNote" rows="2" placeholder="เช่น สาเหตุเฉพาะ, last working day, สถานะการรับกลับ, ฯลฯ">${escapeHtml(emp.terminationNote)}</textarea>
          </div>
        </div>
      </div>

      <div class="form-section">
        <h3>ประกันสังคม <span class="muted-2" style="font-weight:normal;font-size:12px">(สปส.1-03 แจ้งเข้า / สปส.6-09 แจ้งออก)</span></h3>
        <div class="form-grid">
          <div class="form-group"><label>เลขประกันสังคม</label>
            <input name="ssoNo" value="${escapeHtml(emp.ssoNo || '')}" maxlength="20" placeholder="โดยมากใช้เลขบัตร ปชช. 13 หลัก"/>
          </div>
          <div class="form-group"><label>สถานพยาบาลที่เลือก <span class="muted-2" style="font-weight:normal;font-size:11px">(ทางเลือก)</span></label>
            <input name="ssoHospital" value="${escapeHtml(emp.ssoHospital || '')}" placeholder="เช่น รพ.จุฬาภรณ์"/>
          </div>
          <div class="form-group"><label>วันที่แจ้งเข้า สปส. <span class="muted-2" style="font-weight:normal;font-size:11px">(ภายใน 30 วันนับจากวันเริ่มงาน)</span></label>
            <input name="ssoEnrolledDate" type="date" value="${emp.ssoEnrolledDate || ''}"/>
          </div>
          <div class="form-group"><label>วันที่แจ้งออก สปส. <span class="muted-2" style="font-weight:normal;font-size:11px">(ภายในวันที่ 15 ของเดือนถัดไป)</span></label>
            <input name="ssoTerminatedDate" type="date" value="${emp.ssoTerminatedDate || ''}"/>
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
          <div class="form-group"><label>ค่าโทรศัพท์</label><input name="allowancePhone" type="number" min="0" step="100" value="${emp.allowancePhone || 0}" class="income-input"/></div>
          <div class="form-group"><label>ค่าอื่นๆ</label><input name="allowanceOther" type="number" min="0" step="100" value="${emp.allowanceOther || 0}" class="income-input"/></div>
          <div class="form-group"><label>รวมรายได้ต่อเดือน</label><input id="incomeTotal" type="text" readonly style="font-weight:600;color:var(--primary)"/></div>
        </div>
      </div>

      ${id && DB.isHR ? `
      <div class="form-section" id="permSection">
        <h3>สิทธิ์ใช้งานระบบ <span class="muted-2" style="font-weight:normal;font-size:12px">(admin / HR แก้ได้ทุก role)</span></h3>
        <div id="permLoading" class="muted-2" style="padding:8px 0">กำลังโหลดข้อมูลสิทธิ์...</div>
        <div id="permBody" style="display:none"></div>
      </div>` : ''}

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
      <datalist id="dl-termination-reasons">${dataListOpt(EMP_OPTIONS.terminationReasons)}</datalist>

      <!-- 👀 Preview Pane (hidden by default) -->
      <div id="empPreviewPane" style="display:none"></div>

      <div class="form-actions" id="empFormActions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="button" class="btn btn-primary" id="empPreviewBtn">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          ตรวจสอบก่อนบันทึก
        </button>
      </div>

      <div class="form-actions" id="empPreviewActions" style="display:none">
        <button type="button" class="btn btn-secondary" id="empEditBtn">↩ กลับไปแก้ไข</button>
        <button type="submit" class="btn btn-primary" id="empSubmit">✓ ${id ? 'ยืนยันบันทึกการแก้ไข' : 'ยืนยันเพิ่มพนักงาน'}</button>
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
  // ─── ENHANCED VALIDATION: live progress + positive feedback ───
  // ปรับใหม่ — แสดง hint ขณะพิมพ์ ("พิมพ์ต่อ 8/13") + ✅ เขียวเมื่อถูก
  const setFieldFeedback = (inputSel, warnId, state, msg) => {
    // state: 'ok' | 'progress' | 'error' | ''
    const input = $(inputSel);
    const warn = $('#' + warnId);
    if (!input || !warn) return;
    input.classList.remove('invalid', 'valid', 'progress');
    if (state) input.classList.add(state === 'ok' ? 'valid' : state === 'error' ? 'invalid' : 'progress');
    warn.textContent = msg || '';
    warn.classList.toggle('show', !!msg);
    warn.classList.toggle('warn-ok', state === 'ok');
    warn.classList.toggle('warn-progress', state === 'progress');
  };
  const checkPhone = () => {
    const v = $('#empForm [name="phone"]')?.value || '';
    if (!v) return setFieldFeedback('#empForm [name="phone"]', 'phoneWarn', '', '');
    const r = validatePhone(v);
    if (r.ok) {
      const d = v.replace(/\D/g, '');
      const type = d.length === 10 ? 'มือถือ' : 'โทรศัพท์บ้าน';
      setFieldFeedback('#empForm [name="phone"]', 'phoneWarn', 'ok', `✓ เบอร์${type}ถูกต้อง`);
    } else {
      setFieldFeedback('#empForm [name="phone"]', 'phoneWarn', 'error', '✗ ' + r.msg);
    }
  };
  const checkNid = () => {
    const v = $('#empForm [name="nationalId"]')?.value || '';
    const nat = $('#empForm [name="nationality"]')?.value || '';
    if (!v) return setFieldFeedback('#empForm [name="nationalId"]', 'nidWarn', '', '');
    const isThai = !nat || String(nat).trim() === 'ไทย';
    const digits = v.replace(/\D/g, '');
    // ต่างชาติ → ไม่ตรวจเข้มงวด
    if (!isThai) {
      const r = validateNationalId(v, nat);
      return setFieldFeedback('#empForm [name="nationalId"]', 'nidWarn',
        r.ok ? 'ok' : 'error',
        r.ok ? '🌐 ผู้มีสัญชาติต่างชาติ — ไม่ตรวจ checksum' : '✗ ' + r.msg);
    }
    // ไทย — show progress ขณะพิมพ์
    if (digits.length < 13) {
      return setFieldFeedback('#empForm [name="nationalId"]', 'nidWarn',
        'progress', `⏳ พิมพ์ต่อ... (${digits.length}/13 หลัก)`);
    }
    const r = validateNationalId(v, nat);
    setFieldFeedback('#empForm [name="nationalId"]', 'nidWarn',
      r.ok ? 'ok' : 'error',
      r.ok ? '✓ เลขประจำตัวประชาชนถูกต้อง' : '✗ ' + r.msg);
  };
  $('#empForm [name="phone"]')?.addEventListener('input', checkPhone);
  $('#empForm [name="nationalId"]')?.addEventListener('input', checkNid);
  $('#empForm [name="nationality"]')?.addEventListener('input', checkNid);
  $('#empForm [name="nationality"]')?.addEventListener('change', checkNid);
  // ตรวจครั้งแรกเมื่อโหลดฟอร์ม
  checkPhone(); checkNid();

  // ─── BLACKLIST AUTO-CHECK ───
  // เมื่อกรอกเลขประชาชน 13 หลักครบ → ตรวจ blacklist (debounce 500ms กัน RPC ถี่)
  // ถ้า match → แสดง modal เตือนสีแดง พร้อม "continue anyway" / "cancel"
  // ทำงานเฉพาะตอน "เพิ่มใหม่" — แก้ไขพนักงานเดิม skip (เพราะอยู่ในระบบแล้ว)
  if (!id) {
    let _blacklistChecked = '';
    const checkBlacklist = debounce(async () => {
      const v = $('#empForm [name="nationalId"]')?.value || '';
      const digits = v.replace(/\D/g, '');
      if (digits.length !== 13) { _blacklistChecked = ''; return; }
      if (_blacklistChecked === digits) return;  // ตรวจซ้ำเลขเดิม → skip
      _blacklistChecked = digits;
      try {
        const matches = await DB.checkBlacklist(digits);
        if (matches.length === 0) return;
        // มี match → แสดง modal เตือน
        const top = matches[0];
        const severityLabel = {
          permanent: '⛔ ห้ามจ้างถาวร',
          temporary: '⏳ ห้ามจ้างชั่วคราว',
          review:    '⚠️ พิจารณาก่อนจ้าง'
        }[top.severity] || top.severity;
        const categoryLabel = {
          theft: 'ขโมย/ฉ้อโกง', fraud: 'ทุจริต',
          violence: 'ความรุนแรง', conduct: 'ฝ่าฝืนระเบียบ',
          performance: 'ผลงาน', attendance: 'ขาดงานบ่อย', other: 'อื่นๆ'
        }[top.category] || top.category;
        const reviewWarn = top.severity === 'review';
        const allowContinue = reviewWarn;  // severity=review ให้เลือก continue ได้, อื่นๆ force cancel
        modal.open(`${severityLabel} — พบในรายชื่อห้ามจ้าง`, `
          <div style="padding:8px 0">
            <div style="padding:14px;background:rgba(239,68,68,0.08);border:1px solid var(--danger);border-radius:8px;margin-bottom:12px">
              <div style="font-size:14px;font-weight:600;color:var(--danger);margin-bottom:8px">${escapeHtml(top.full_name)}${top.nickname ? ` <span class="muted-2">(${escapeHtml(top.nickname)})</span>` : ''}</div>
              <div style="font-size:13px;line-height:1.6">
                <div><strong>เลข ปชช.:</strong> ${escapeHtml(top.national_id)}</div>
                <div><strong>หมวด:</strong> ${escapeHtml(categoryLabel)}</div>
                <div><strong>เหตุผล:</strong> ${escapeHtml(top.reason)}</div>
                ${top.previous_emp_id ? `<div><strong>รหัสเดิม:</strong> ${escapeHtml(top.previous_emp_id)}</div>` : ''}
                ${top.review_date ? `<div><strong>ทบทวน:</strong> ${escapeHtml(top.review_date)}</div>` : ''}
                ${top.notes ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border)"><strong>หมายเหตุ:</strong> ${escapeHtml(top.notes)}</div>` : ''}
                <div style="margin-top:6px"><strong>บันทึกโดย:</strong> ${escapeHtml(top.created_by || '-')} · ${fmt.date(top.created_at)}</div>
              </div>
            </div>
            ${matches.length > 1 ? `<div class="muted-2" style="font-size:12px;margin-bottom:10px">+ มีอีก ${matches.length - 1} รายการในประวัติ — เปิดดูที่หน้า "Blacklist"</div>` : ''}
            <div style="font-size:13px;color:var(--text-2);line-height:1.5">
              ${allowContinue
                ? 'ระบบเตือนเพื่อให้พิจารณาเท่านั้น — สามารถเลือก "บันทึกต่อไป" ได้'
                : 'ไม่แนะนำให้จ้างบุคคลนี้ — หากต้องการดำเนินการจริงๆ กด "บันทึกต่อไป" และระบุเหตุผลในการอนุมัติ'}
            </div>
          </div>
          <div class="form-actions" style="margin-top:14px">
            <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
            <button type="button" class="btn ${allowContinue ? 'btn-warning' : 'btn-danger'}" id="blContinueBtn">บันทึกต่อไป (ยอมรับความเสี่ยง)</button>
          </div>
        `);
        $('#blContinueBtn')?.addEventListener('click', () => modal.close());
      } catch (ex) {
        console.warn('Blacklist check error:', ex);
      }
    }, 500);
    $('#empForm [name="nationalId"]')?.addEventListener('input', checkBlacklist);
  }

  // ─── AUTO: เพศ ← คำนำหน้าชื่อ (รองรับ neutral prefix อย่าง ดร./ผศ.) ───
  // ปัจจุบันถ้า prefix ไม่ตรง female → ตั้งเป็น "ชาย" ผิด เมื่อเป็น "ดร." ที่ไม่ระบุเพศ
  // แก้: prefix ที่ไม่ระบุเพศ → ไม่ override ค่าเดิม + แสดง hint ให้ user เลือกเอง
  const _femalePrefixes = ['นางสาว', 'นาง', 'เด็กหญิง', 'ด.ญ.'];
  const _malePrefixes = ['นาย', 'เด็กชาย', 'ด.ช.'];
  const _genderHint = document.createElement('small');
  _genderHint.className = 'form-warn';
  _genderHint.style.fontSize = '11px';
  _genderHint.style.color = 'var(--text-3)';
  $('#empForm [name="gender"]')?.parentNode.appendChild(_genderHint);
  $('#empForm [name="title"]')?.addEventListener('change', (ev) => {
    const t = (ev.target.value || '').trim();
    const genderSel = $('#empForm [name="gender"]');
    if (!genderSel) return;
    if (_femalePrefixes.includes(t)) {
      genderSel.value = 'หญิง';
      _genderHint.textContent = '✓ ตั้งเป็น "หญิง" อัตโนมัติจากคำนำหน้า';
      _genderHint.style.color = 'var(--success)';
    } else if (_malePrefixes.includes(t)) {
      genderSel.value = 'ชาย';
      _genderHint.textContent = '✓ ตั้งเป็น "ชาย" อัตโนมัติจากคำนำหน้า';
      _genderHint.style.color = 'var(--success)';
    } else if (t) {
      // neutral prefix (ดร./ผศ./รศ./ฯลฯ) → ไม่ override กรุณาเลือกเอง
      _genderHint.textContent = '⚠️ คำนำหน้านี้ไม่ระบุเพศ — กรุณาเลือกเอง';
      _genderHint.style.color = 'var(--warning)';
    } else {
      _genderHint.textContent = '';
    }
  });

  // ─── AUTO: ตำแหน่ง (positionTitle) ← ระดับตำแหน่งงาน (position) ───
  $('#empForm [name="position"]')?.addEventListener('change', (ev) => {
    const p = DB.getPosition(ev.target.value);
    const titleInput = $('#empForm [name="positionTitle"]');
    if (p && titleInput) titleInput.value = p.name;
  });

  // ─── AUTO: เมื่อเปลี่ยน "ฝ่าย" → rebuild dropdown ระดับตำแหน่งงานตาม scope ของฝ่ายใหม่ ───
  $('#empFormDept')?.addEventListener('change', (ev) => {
    const deptId = ev.target.value;
    const dept = deptId ? DB.getDepartment(deptId) : null;
    const deptScope = dept?.scope || '';
    const posSel = $('#empFormPos');
    if (!posSel) return;
    const prevVal = posSel.value;
    const filtered = DB.getPositionsForDepartment(deptId);
    const sorted = filtered.slice().sort((a, b) => (b.level || 0) - (a.level || 0) || (a.name || '').localeCompare(b.name || ''));
    const opt = (p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.level ? ' · ระดับ ' + p.level : ''}</option>`;
    if (!deptScope) {
      const kitchen = [], ops = [], common = [];
      for (const p of sorted) {
        const n = (p.name || '').toLowerCase();
        if (n.includes('chef') || n.includes('barista')) kitchen.push(p);
        else if (n.includes('part')) common.push(p);
        else ops.push(p);
      }
      posSel.innerHTML =
        (ops.length ? `<optgroup label="ฝ่ายปฏิบัติการ">${ops.map(opt).join('')}</optgroup>` : '') +
        (kitchen.length ? `<optgroup label="ฝ่ายครัว">${kitchen.map(opt).join('')}</optgroup>` : '') +
        (common.length ? `<optgroup label="อื่นๆ">${common.map(opt).join('')}</optgroup>` : '');
    } else {
      const label = deptScope === 'operation' ? 'ตำแหน่งสายปฏิบัติการ (Operation)' : 'ตำแหน่งสายสำนักงาน (Office)';
      posSel.innerHTML = `<optgroup label="${label}">${sorted.map(opt).join('')}</optgroup>`;
    }
    // คงค่าตำแหน่งเดิมถ้ายังอยู่ในรายการใหม่ ไม่งั้นเลือก option แรก
    const stillValid = sorted.some(p => p.id === prevVal);
    if (stillValid) posSel.value = prevVal;
    else {
      // trigger change ให้ field "ตำแหน่ง" (positionTitle) อัปเดตตาม
      posSel.dispatchEvent(new Event('change'));
    }
  });

  // ─── UPDATE STATUS DISPLAY + แสดง/ซ่อน section "การพ้นสภาพ" ตามการกรอกวันพ้นสภาพ ───
  const updateStatusDisplay = () => {
    const td = $('#empForm [name="terminationDate"]')?.value;
    const today = tz.today();
    let label = 'ปฏิบัติงาน';
    if (td) label = td > today ? 'นัดพ้นสภาพ (ยังปฏิบัติงาน)' : 'พ้นสภาพแล้ว';
    const el = $('#empStatusDisplay');
    if (el) el.value = label;
    // toggle termination section
    const termSec = $('#terminationSection');
    if (termSec) termSec.style.display = td ? '' : 'none';
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

  // ─── PERMISSION SECTION: lazy-load user_profile + render ───
  // ใช้ closure ตัวแปร currentProfile ที่ส่งให้ submit handler ใช้ตอนตรวจการเปลี่ยน role
  let currentProfile = null;
  if (id && DB.isHR) {
    (async () => {
      try {
        const profiles = await DB.getUserProfilesList();
        currentProfile = profiles.find(p => p.employee_id === id) || null;
        renderPermSection(currentProfile, emp);
      } catch (ex) {
        const loading = $('#permLoading');
        if (loading) loading.textContent = 'โหลดข้อมูลสิทธิ์ไม่สำเร็จ: ' + (ex.message || ex);
      }
    })();
  }

  function renderPermSection(profile, employee) {
    const loading = $('#permLoading');
    const body = $('#permBody');
    if (!loading || !body) return;
    loading.style.display = 'none';
    body.style.display = '';
    const hasAcc = !!profile;
    const roleKey = profile?.role || 'viewer';
    const currentBranches = Array.isArray(profile?.managed_branches) ? profile.managed_branches.filter(Boolean) : [];
    const autoRole = DB.autoDetectRole(employee);
    const allBranches = DB.getBranchMaster({ activeOnly: true }) || [];
    const email = `${employee.id.toLowerCase()}@kacha.local`;

    if (!hasAcc) {
      body.innerHTML = `
        <div class="form-grid">
          <div class="form-group span-2">
            <div style="padding:10px 12px;background:var(--warning-soft, rgba(184,122,8,0.10));border:1px solid var(--warning, #b87a08);border-radius:6px">
              <strong>⚠️ พนักงานคนนี้ยังไม่มีบัญชีใช้งานระบบ</strong>
              <div class="muted-2" style="margin-top:4px;font-size:12.5px">สร้างบัญชีให้พนักงานก่อนถึงจะกำหนด Role ได้ — ไปที่ "ตั้งค่าระบบ → บัญชีผู้ใช้" เพื่อสร้างบัญชี</div>
            </div>
          </div>
        </div>`;
      return;
    }
    body.innerHTML = `
      <div class="form-grid">
        <div class="form-group">
          <label>Email Login</label>
          <input type="text" value="${escapeHtml(email)}" readonly style="background:var(--surface-2);font-family:monospace;font-size:12.5px"/>
        </div>
        <div class="form-group">
          <label>Role</label>
          <select name="userRole" id="userRoleSel">
            ${Object.entries(ROLE_LABELS).map(([k, v]) => `<option value="${k}" ${roleKey === k ? 'selected' : ''}>${v.th}</option>`).join('')}
          </select>
          ${autoRole ? `<small class="muted-2" style="display:block;margin-top:4px">💡 Auto-detect: <strong>${ROLE_LABELS[autoRole]?.th || autoRole}</strong> <button type="button" class="btn btn-ghost btn-sm" style="padding:1px 8px;margin-left:6px" onclick="document.getElementById('userRoleSel').value='${autoRole}';document.getElementById('userRoleSel').dispatchEvent(new Event('change'))">ใช้ค่านี้</button></small>` : ''}
        </div>
        <div class="form-group span-2" id="userBranchesGroup" style="display:${['area_manager','operation_manager'].includes(roleKey) ? '' : 'none'}">
          <label>สาขาที่ดูแล <span class="muted-2" style="font-weight:normal;font-size:11px">(เฉพาะ Area / Operation Manager · ถ้าไม่เลือก = ใช้สาขาของตัวเอง)</span></label>
          <div style="max-height:160px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--surface-2)">
            ${allBranches.length ? allBranches.map(b => `
              <label style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;font-weight:normal;font-size:12.5px">
                <input type="checkbox" name="userBranches" value="${escapeHtml(b.id)}" ${currentBranches.includes(b.id) ? 'checked' : ''}/>
                <span>${escapeHtml(b.id)}${b.name && b.name !== b.id ? ' — ' + escapeHtml(b.name) : ''}</span>
              </label>
            `).join('') : '<div class="muted-2">ไม่มีข้อมูลสาขาในระบบ</div>'}
          </div>
        </div>
      </div>`;
    // Toggle "สาขาที่ดูแล" ตาม role
    $('#userRoleSel').addEventListener('change', (ev) => {
      const v = ev.target.value;
      const g = $('#userBranchesGroup');
      if (g) g.style.display = (v === 'area_manager' || v === 'operation_manager') ? '' : 'none';
    });
  }

  // ─── 👀 Preview System — ตรวจสอบก่อนบันทึก ───
  const showPreview = () => {
    const form = $('#empForm');
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const data = Object.fromEntries(new FormData(form).entries());
    const previewHtml = buildEmployeePreview(data, !id, emp, pendingPhotoBlob, removePhoto);
    $('#empPreviewPane').innerHTML = previewHtml;
    $('#empPreviewPane').style.display = '';
    $('#empFormActions').style.display = 'none';
    $('#empPreviewActions').style.display = '';
    // ซ่อน form sections เพื่อให้ preview เด่นชัด
    form.querySelectorAll(':scope > .form-section').forEach(el => el.style.display = 'none');
    // scroll ขึ้นบนสุด
    $('.modal-body')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const hidePreview = () => {
    $('#empPreviewPane').style.display = 'none';
    $('#empFormActions').style.display = '';
    $('#empPreviewActions').style.display = 'none';
    $('#empForm').querySelectorAll(':scope > .form-section').forEach(el => el.style.display = '');
  };

  $('#empPreviewBtn').addEventListener('click', showPreview);
  $('#empEditBtn').addEventListener('click', hidePreview);

  $('#empForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#empSubmit'); btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      // แยก permission fields ออกก่อนส่ง saveEmployee (ไม่ใช่ column ของ employees)
      const newRole = data.userRole;
      delete data.userRole;
      // เก็บ userBranches แบบ array — FormData ดึงได้ค่าเดียวด้วย .get() — ต้องใช้ .getAll()
      const newBranches = e.target.querySelectorAll('input[name="userBranches"]:checked');
      const newBranchesArr = Array.from(newBranches).map(i => i.value);
      delete data.userBranches;

      ['salary', 'allowancePosition', 'allowanceTravel', 'allowanceFood',
       'allowancePerDiem', 'allowanceLanguage', 'allowancePhone', 'allowanceOther'].forEach(k => data[k] = Number(data[k]));

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
      const saved = await DB.saveEmployee(data);

      // ── อัปเดต role/branches ถ้า admin เปลี่ยน + พนักงานมีบัญชีอยู่ ──
      if (id && DB.isHR && currentProfile && newRole) {
        const oldBranches = Array.isArray(currentProfile.managed_branches) ? currentProfile.managed_branches.filter(Boolean).sort() : [];
        const newBranchesSorted = [...newBranchesArr].sort();
        const roleChanged = currentProfile.role !== newRole;
        const branchesChanged = JSON.stringify(oldBranches) !== JSON.stringify(newBranchesSorted);
        if (roleChanged || branchesChanged) {
          btn.textContent = 'กำลังอัปเดตสิทธิ์...';
          const branchesToSend = ['area_manager', 'operation_manager'].includes(newRole) ? newBranchesArr : [];
          await DB.setEmployeeRole(id, newRole, branchesToSend);
        }
      }

      // ── Auto-create user account สำหรับพนักงานใหม่ (admin + HR) ──
      // email = {รหัส}@kacha.local · password = เลข ปชช (default) · role = auto-detect
      let newAccountInfo = null;
      if (!id && DB.isHR) {
        try {
          btn.textContent = 'กำลังสร้างบัญชี login...';
          newAccountInfo = await DB.createEmployeeAccount(saved.id);
          // Auto-detect + apply role (ไม่ใช่ viewer)
          const autoRole = DB.autoDetectRole(saved);
          if (autoRole && autoRole !== 'viewer') {
            try { await DB.setEmployeeRole(saved.id, autoRole, []); } catch (rEx) { console.warn('Auto-set role failed:', rEx); }
          }
        } catch (accEx) {
          console.warn('Auto-create account failed:', accEx);
          // ไม่ rollback employee data — แค่ warn ใน toast หลังปิด form
          newAccountInfo = { _error: accEx.message || String(accEx) };
        }
      }

      modal.close();
      // ถ้ามาจาก applicant (มี onSaved) → ให้ callback แสดง toast เอง ไม่แสดงซ้ำ
      if (onSaved) {
        await onSaved(saved);
      } else {
        toast(id ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มพนักงานใหม่แล้ว', 'success');
      }

      // ── แสดง credentials ของบัญชีที่เพิ่งสร้าง (ใหม่เท่านั้น) ──
      if (newAccountInfo && !newAccountInfo._error) {
        modal.open('🔑 สร้างบัญชี Login สำเร็จ',
          `<div style="font-size:14px;line-height:1.7">
             <p style="margin-bottom:14px">ระบบสร้างบัญชี login ให้พนักงานใหม่เรียบร้อย — กรุณาแจ้งข้อมูลด้านล่างให้พนักงาน <strong>และแนะนำให้เปลี่ยนรหัสครั้งแรกที่ login</strong></p>
             <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px">
               <div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
                 <div style="min-width:80px;color:var(--text-2);font-size:13px">รหัสพนักงาน</div>
                 <code style="font-size:14px;font-weight:600">${escapeHtml(saved.id)}</code>
               </div>
               <div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
                 <div style="min-width:80px;color:var(--text-2);font-size:13px">Email Login</div>
                 <code style="font-size:14px">${escapeHtml(newAccountInfo.email)}</code>
               </div>
               <div style="display:flex;gap:12px;align-items:center">
                 <div style="min-width:80px;color:var(--text-2);font-size:13px">Password</div>
                 <code style="font-size:14px;font-weight:600;color:var(--primary)">${escapeHtml(newAccountInfo.password)}</code>
                 <span class="muted-2" style="font-size:12px">(${escapeHtml(newAccountInfo.source)})</span>
               </div>
             </div>
             <p class="muted-2" style="font-size:12.5px">พนักงานสามารถ login ด้วย <strong>รหัสพนักงาน</strong> (ไม่ต้องพิมพ์ @kacha.local) + รหัสผ่านด้านบน</p>
           </div>`,
          { footer: '<button class="btn btn-primary" data-close>เข้าใจแล้ว</button>' }
        );
      } else if (newAccountInfo && newAccountInfo._error) {
        toast('บันทึกพนักงานสำเร็จ แต่สร้างบัญชี login ไม่สำเร็จ: ' + newAccountInfo._error + ' — กรุณาสร้างที่ Settings > บัญชีผู้ใช้', 'warning');
      }
      renderEmployeeList();
    } catch (ex) {
      toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error');
      btn.disabled = false; btn.textContent = id ? 'บันทึกการแก้ไข' : 'เพิ่มพนักงาน';
    }
  });
}

async function deleteEmployee(id) {
  if (!requireHR()) return;
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
  // 🔒 RBAC: out-of-scope ดูข้อมูลพนักงานคนนี้ไม่ได้
  if (!DB.isInScope(e)) {
    toast('คุณไม่มีสิทธิ์ดูข้อมูลพนักงานคนนี้', 'error');
    return;
  }
  // canSeePersonal = HR/Admin หรือดูข้อมูลตัวเอง — gate PII ที่อ่อนไหวที่สุด (nationalId, passport, bank, sso)
  const isOwn = e.id === DB.profile?.employee_id;
  const canSeePersonal = DB.isHR || isOwn;
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
        <div class="emp-stat-value">${maskMoney(totalIncome(e), e.id)}</div>
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
        <div class="emp-info-row"><div class="label">เลขประชาชน</div><div class="value mono">${canSeePersonal ? escapeHtml(e.nationalId || '-') : '<span class="muted-2">•••</span>'}</div></div>
        <div class="emp-info-row"><div class="label">สัญชาติ</div><div class="value">${escapeHtml(e.nationality || '-')}</div></div>
        ${e.passportNumber ? `<div class="emp-info-row"><div class="label">Passport</div><div class="value mono">${canSeePersonal ? escapeHtml(e.passportNumber) : '<span class="muted-2">•••</span>'}</div></div>` : ''}
        ${e.workPermitNumber ? `<div class="emp-info-row"><div class="label">Work Permit</div><div class="value mono">${canSeePersonal ? escapeHtml(e.workPermitNumber) : '<span class="muted-2">•••</span>'}</div></div>` : ''}
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
        ${e.terminationDate ? `
          <div class="emp-info-row"><div class="label">เหตุผลพ้นสภาพ</div><div class="value">${escapeHtml(e.terminationReason || '-')}</div></div>
          ${e.terminationNote ? `<div class="emp-info-row span-2"><div class="label">รายละเอียดเพิ่มเติม</div><div class="value" style="white-space:pre-wrap">${escapeHtml(e.terminationNote)}</div></div>` : ''}
        ` : ''}
      </div>
    </div>

    ${canSeePersonal ? `
    <div class="form-section">
      <h3>บัญชีธนาคาร</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">ธนาคาร</div><div class="value">${escapeHtml(e.bank || '-')}</div></div>
        <div class="emp-info-row"><div class="label">เลขบัญชี</div><div class="value">${escapeHtml(e.bankAccount || '-')}</div></div>
      </div>
    </div>

    <div class="form-section">
      <h3>ประกันสังคม</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">เลขประกันสังคม</div><div class="value mono">${escapeHtml(e.ssoNo || '-')}</div></div>
        <div class="emp-info-row"><div class="label">สถานพยาบาล</div><div class="value">${escapeHtml(e.ssoHospital || '-')}</div></div>
        <div class="emp-info-row"><div class="label">วันที่แจ้งเข้า สปส.</div><div class="value">${e.ssoEnrolledDate ? fmt.date(e.ssoEnrolledDate) + ' <span class="badge badge-success" style="margin-left:6px">แจ้งแล้ว</span>' : '<span class="badge badge-warning">ยังไม่แจ้ง</span>'}</div></div>
        <div class="emp-info-row"><div class="label">วันที่แจ้งออก สปส.</div><div class="value">${e.ssoTerminatedDate ? fmt.date(e.ssoTerminatedDate) + ' <span class="badge badge-success" style="margin-left:6px">แจ้งแล้ว</span>' : (e.terminationDate && DB.empStatus(e) === 'resigned' ? '<span class="badge badge-warning">ยังไม่แจ้ง</span>' : '-')}</div></div>
      </div>
    </div>
    ` : ''}

    ${(() => {
      const uniIssues = DB.getUniformIssues({ employeeId: id });
      const uniCost = DB.getUniformCostForEmployee(id);
      if (!uniIssues.length) return '';
      return `
        <div class="form-section">
          <h3>ชุดพนักงาน <span class="muted-2" style="font-weight:normal;font-size:12px">(${uniIssues.length} รายการ · ค่าชุดรวม ${fmt.money(uniCost)} บาท)</span></h3>
          <div class="table-wrap"><table class="table table-compact" style="font-size:13px">
            <thead><tr><th>วันที่</th><th>รายการ</th><th>ขนาด</th><th class="num">จำนวน</th><th class="num">รวม</th></tr></thead>
            <tbody>
              ${uniIssues.map(u => `<tr>
                <td>${fmt.date(u.issuedDate)}</td>
                <td>${escapeHtml(u.itemName)}</td>
                <td>${escapeHtml(u.size || '-')}</td>
                <td class="num">${u.qty}</td>
                <td class="num">${fmt.money(u.totalCost)}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          <div style="margin-top:12px;padding:10px 16px;background:var(--warning-soft);border-radius:var(--radius-sm);display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border)">
            <div style="font-size:13px;color:var(--warning-text);font-weight:500">ค่าชุดที่ต้องเก็บจากพนักงาน</div>
            <div style="font-size:16px;font-weight:700;color:var(--warning)">${fmt.money(uniCost)} บาท</div>
          </div>
        </div>
      `;
    })()}

    ${(DB.canSeeSalary?.() || DB.profile?.employee_id === e.id) ? `
    <div class="form-section">
      <h3>เงินเดือนและสวัสดิการ</h3>
      <div class="emp-info-grid">
        <div class="emp-info-row"><div class="label">เงินเดือน</div><div class="value">${fmt.money(e.salary)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าตำแหน่ง</div><div class="value">${fmt.money(e.allowancePosition)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าเดินทาง</div><div class="value">${fmt.money(e.allowanceTravel)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าอาหาร</div><div class="value">${fmt.money(e.allowanceFood)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าเบี้ยเลี้ยง</div><div class="value">${fmt.money(e.allowancePerDiem)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าภาษา</div><div class="value">${fmt.money(e.allowanceLanguage)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าโทรศัพท์</div><div class="value">${fmt.money(e.allowancePhone)}</div></div>
        <div class="emp-info-row"><div class="label">ค่าอื่นๆ</div><div class="value">${fmt.money(e.allowanceOther)}</div></div>
      </div>
      <div style="margin-top:14px;padding:14px 18px;background:var(--primary-soft);border-radius:var(--radius-sm);display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border)">
        <div style="font-size:13px;color:var(--text-2);font-weight:500">รวมรายได้ต่อเดือน</div>
        <div style="font-size:18px;font-weight:700;color:var(--primary)">${fmt.money(totalIncome(e))}</div>
      </div>
    </div>` : ''}

    ${e.note ? `
    <div class="form-section">
      <h3>หมายเหตุ</h3>
      <div style="padding:4px 0;color:var(--text-2)">${escapeHtml(e.note)}</div>
    </div>` : ''}

    ${(() => {
      // pre-fetch leaves สำหรับพนักงานคนนี้ (auto-scope ผ่าน RBAC — แต่ HR/Admin/Manager เห็นได้ตามสิทธิ์ของตัวเอง)
      const leaves = DB.getLeaveRequests({ employeeId: e.id });
      // 🔒 Tab ที่ sensitive — ประวัติเงินเดือน/กู้/เบิก/ประเมิน → HR หรือ self เท่านั้น
      const firstTab = canSeePersonal ? 'history' : 'leaves';
      return `
        <div class="tabs mt-4">
          ${canSeePersonal ? `<button class="tab ${firstTab === 'history' ? 'active' : ''}" data-tab="history">ประวัติเงินเดือน (${history.length})</button>
          <button class="tab" data-tab="loans">การกู้ (${loans.length})</button>
          <button class="tab" data-tab="advances">เบิกล่วงหน้า (${advances.length})</button>
          <button class="tab" data-tab="evals">ประเมิน (${evals.length})</button>` : ''}
          <button class="tab ${firstTab === 'leaves' ? 'active' : ''}" data-tab="leaves">การลา (${leaves.length})</button>
        </div>
        <div id="tabContent"></div>
      `;
    })()}
  `, {
    size: 'lg',
    footer: `<button class="btn btn-secondary" data-close>ปิด</button><button class="btn btn-primary" onclick="window.print()">พิมพ์</button>`
  });

  const leaves = DB.getLeaveRequests({ employeeId: e.id });

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
    } else if (tab === 'leaves') {
      // สรุปการลาตามประเภท + ตารางรายการ
      const year = new Date().getFullYear();
      const totalApprovedYear = leaves
        .filter(l => l.status === 'approved' && (l.startDate || '').startsWith(String(year)))
        .reduce((s, l) => s + Number(l.days || 0), 0);
      const pendingCount = leaves.filter(l => l.status === 'pending').length;
      c.innerHTML = leaves.length ? `
        <div style="display:flex;gap:14px;margin-bottom:14px;flex-wrap:wrap">
          <div class="badge badge-info" style="padding:8px 14px;font-size:13px">ใช้ลาไปแล้วปี ${year}: <strong>${totalApprovedYear}</strong> วัน</div>
          ${pendingCount ? `<div class="badge badge-warning" style="padding:8px 14px;font-size:13px">รออนุมัติ: <strong>${pendingCount}</strong> คำขอ</div>` : ''}
        </div>
        <div class="table-wrap"><table class="table">
          <thead><tr>
            <th>ประเภท</th>
            <th>วันที่</th>
            <th class="num">จำนวนวัน</th>
            <th>เหตุผล</th>
            <th>ผู้อนุมัติ</th>
            <th>สถานะ</th>
          </tr></thead>
          <tbody>
            ${leaves.map(l => {
              const typeCfg = DB.LEAVE_TYPES[l.leaveType] || { label: l.leaveType, badge: 'badge-info' };
              const statusCfg = LEAVE_STATUS_BADGE[l.status] || { label: l.status, cls: 'badge' };
              const approver = l.approvedBy ? '✓ อนุมัติแล้ว' : (l.status === 'pending' ? 'รอ' : '-');
              return `<tr>
                <td><span class="badge ${typeCfg.badge}">${escapeHtml(typeCfg.label)}</span></td>
                <td>${fmt.date(l.startDate)}${l.endDate && l.endDate !== l.startDate ? ' – ' + fmt.date(l.endDate) : ''}</td>
                <td class="num">${l.days}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(l.reason || '')}">${escapeHtml(l.reason || '-')}</td>
                <td class="muted-2" style="font-size:12px">${escapeHtml(approver)}</td>
                <td><span class="badge ${statusCfg.cls}">${statusCfg.label}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
      ` : '<div class="empty-state"><div class="hint">ยังไม่มีประวัติการลา</div></div>';
    }
  };
  // 🔒 เปิดแท็บแรกตามสิทธิ์ — non-HR/non-self จะเริ่มที่ "การลา" เพราะ sensitive tabs ถูกซ่อน
  renderTab(canSeePersonal ? 'history' : 'leaves');
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
  'สายงาน', 'รหัสฝ่าย', 'สาขา', 'รหัสระดับตำแหน่ง', 'ตำแหน่ง', 'ประเภทพนักงาน', 'วันเริ่มงาน',
  'วันพ้นสภาพ', 'เหตุผลพ้นสภาพ', 'รายละเอียดพ้นสภาพ',
  'ธนาคาร', 'เลขบัญชี',
  'เงินเดือน', 'ค่าตำแหน่ง', 'ค่าเดินทาง', 'ค่าอาหาร', 'ค่าเบี้ยเลี้ยง', 'ค่าภาษา', 'ค่าโทรศัพท์', 'ค่าอื่นๆ',
  'เลข สปส.', 'วันที่แจ้งเข้า สปส.', 'วันที่แจ้งออก สปส.', 'สถานพยาบาล สปส.',
  'สิทธิ์ใช้งานระบบ', 'สถานะ', 'หมายเหตุ'
];

// Role keys ที่ระบบรองรับ (ใช้ใน Excel import) — ตรงกับ user_profiles.role ใน DB
const ROLE_KEYS_FOR_IMPORT = ['admin', 'hr', 'operation_manager', 'area_manager', 'branch_manager', 'branch_staff', 'viewer'];

async function downloadEmployeeTemplate() {
  if (typeof XLSX === 'undefined') {
    toast('กำลังโหลด XLSX library...', 'info');
    try { await loadXLSX(); } catch (e) { toast(e.message, 'error'); return; }
  }
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
      'สายงาน': 'office',
      'รหัสฝ่าย': 'D001', 'สาขา': 'สำนักงานใหญ่',
      'รหัสระดับตำแหน่ง': 'P03', 'ตำแหน่ง': 'หัวหน้าทีม',
      'ประเภทพนักงาน': 'พนักงานประจำ', 'วันเริ่มงาน': '01/01/2024',
      'วันพ้นสภาพ': '', 'เหตุผลพ้นสภาพ': '', 'รายละเอียดพ้นสภาพ': '',
      'ธนาคาร': 'ธนาคารกสิกรไทย (KBANK)', 'เลขบัญชี': '123-4-56789-0',
      'เงินเดือน': 30000, 'ค่าตำแหน่ง': 3000, 'ค่าเดินทาง': 2000, 'ค่าอาหาร': 1500,
      'ค่าเบี้ยเลี้ยง': 0, 'ค่าภาษา': 0, 'ค่าโทรศัพท์': 0, 'ค่าอื่นๆ': 0,
      'เลข สปส.': '', 'วันที่แจ้งเข้า สปส.': '', 'วันที่แจ้งออก สปส.': '', 'สถานพยาบาล สปส.': '',
      'สิทธิ์ใช้งานระบบ': 'branch_staff',
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
    ['เหตุผลพ้นสภาพ (กรอกเมื่อมีวันพ้นสภาพ):'],
    ['• ลาออก / ครบสัญญาจ้าง / ถูกเลิกจ้าง / ไล่ออก (ผิดวินัย)'],
    ['• เกษียณอายุ / เสียชีวิต / พ้นทดลองงาน (ไม่ผ่าน) / ย้ายไปบริษัทในเครือ / อื่นๆ'],
    ['• รายละเอียดพ้นสภาพ: บันทึกเพิ่มเติม เช่น สาเหตุเฉพาะ, last working day, รับกลับได้/ไม่ได้'],
    [''],
    ['ประกันสังคม (สปส.):'],
    ['• เลข สปส. — มักเป็นเลขบัตร ปชช. 13 หลัก (เว้นว่างได้)'],
    ['• วันที่แจ้งเข้า สปส. — วันที่ยื่นแบบ สปส.1-03 (ภายใน 30 วันจากวันเริ่มงาน)'],
    ['• วันที่แจ้งออก สปส. — วันที่ยื่นแบบ สปส.6-09 (ภายในวันที่ 15 ของเดือนถัดจากเดือนพ้นสภาพ)'],
    ['• สถานพยาบาล สปส. — ชื่อ รพ. ที่พนักงานเลือก (เว้นว่างได้)'],
    [''],
    ['สิทธิ์ใช้งานระบบ (Role) — ใช้คีย์ภาษาอังกฤษด้านล่าง:'],
    ['• admin             — ผู้ดูแลระบบ (ทำได้ทุกอย่าง รวมจัดการ user + ตั้งค่า)'],
    ['• hr                — HR ฝ่ายบุคคล (จัดการพนักงาน + เงินเดือน ทุกสาขา)'],
    ['• operation_manager — ผู้จัดการฝ่ายปฏิบัติการ (ดูทุกสาขา)'],
    ['• area_manager      — ผู้จัดการเขต (ดูเฉพาะสาขาที่ดูแล — กำหนดในระบบทีหลัง)'],
    ['• branch_manager    — ผู้จัดการสาขา (ดูเฉพาะสาขาตัวเอง)'],
    ['• branch_staff      — พนักงานสาขา (default — เห็นแค่ตัวเอง)'],
    ['• viewer            — ผู้ใช้ทั่วไป (อ่านได้อย่างเดียว)'],
    ['• เว้นว่าง = ระบบจะ auto-detect จากตำแหน่ง (positionTitle) ตอนสร้างบัญชี login'],
    ['• Admin import: ระบบจะ auto-create บัญชี login + ตั้ง role ให้ตามที่ระบุ (password = เลข ปชช)'],
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
  // Normalize คำนำหน้า: "น.ส." (ย่อ) → "นางสาว" (รูปเต็ม ตรงกับ EMP_OPTIONS.titles)
  // ถ้าใช้ค่าย่อ form dropdown จะ fallback ไป option แรก ("นาย") → กลายเป็น overwrite ข้อมูลเดิม
  const normalizeTitle = (t) => {
    const v = (t || '').trim();
    if (v === 'น.ส.' || v === 'นส.' || v === 'น.ส') return 'นางสาว';
    return v || 'นาย';
  };
  return {
    id: get('รหัสพนักงาน'),
    title: normalizeTitle(get('คำนำหน้า')),
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
    // _scope: ถ้า dept ไม่มีในระบบ จะ auto-create ตอน import พร้อม scope นี้
    // ค่าที่ยอมรับ: 'operation' / 'office' / scope id ใดๆ ที่ตั้งไว้
    _scope: (get('สายงาน') || '').toLowerCase().trim(),
    branch: get('สาขา'),
    position: get('รหัสระดับตำแหน่ง'),
    positionTitle: get('ตำแหน่ง'),
    employeeType: get('ประเภทพนักงาน') || 'พนักงานประจำ',
    hireDate: parseDate('วันเริ่มงาน') || tz.today(),
    terminationDate: parseDate('วันพ้นสภาพ') || '',
    terminationReason: get('เหตุผลพ้นสภาพ'),
    terminationNote: get('รายละเอียดพ้นสภาพ'),
    bank: get('ธนาคาร'),
    bankAccount: get('เลขบัญชี'),
    salary: num('เงินเดือน'),
    allowancePosition: num('ค่าตำแหน่ง'),
    allowanceTravel: num('ค่าเดินทาง'),
    allowanceFood: num('ค่าอาหาร'),
    allowancePerDiem: num('ค่าเบี้ยเลี้ยง'),
    allowanceLanguage: num('ค่าภาษา'),
    allowancePhone: num('ค่าโทรศัพท์'),
    allowanceOther: num('ค่าอื่นๆ'),
    ssoNo: get('เลข สปส.'),
    ssoEnrolledDate: parseDate('วันที่แจ้งเข้า สปส.') || '',
    ssoTerminatedDate: parseDate('วันที่แจ้งออก สปส.') || '',
    ssoHospital: get('สถานพยาบาล สปส.'),
    // _role: เก็บแบบ underscore prefix → ไม่ใช่ column ของ employees table — จะถูก extract ใน processImportRows
    _role: (() => {
      const v = get('สิทธิ์ใช้งานระบบ').toLowerCase().trim();
      return ROLE_KEYS_FOR_IMPORT.includes(v) ? v : '';
    })(),
    // sync status — priority: terminationDate ก่อน, ถ้าไม่มีถึงดู Excel "สถานะ"
    // เคารพ status='resigned' จาก Excel (ใช้กับ legacy data ที่ลืมกรอกวันพ้นสภาพ)
    status: (() => {
      const td = parseDate('วันพ้นสภาพ');
      if (td) return td <= tz.today() ? 'resigned' : 'active';
      // ไม่มีวันพ้นสภาพ → ใช้ค่าจาก Excel column "สถานะ"
      return get('สถานะ') === 'resigned' ? 'resigned' : 'active';
    })(),
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
    // ฝ่ายไม่มีในระบบ → error เฉพาะถ้า _scope ก็ไม่ระบุ (ถ้ามี scope → จะ auto-create ตอน import)
    if (r.department && !deptIds.has(r.department) && !r._scope)
      errors.push({ row: rowNum, msg: `รหัสฝ่ายไม่มีในระบบ: ${r.department} — เพิ่มคอลัมน์ "สายงาน" (operation/office) ในไฟล์เพื่อให้ระบบสร้างฝ่ายอัตโนมัติ` });
    if (r.position && !posIds.has(r.position))
      errors.push({ row: rowNum, msg: `รหัสระดับตำแหน่งไม่มีในระบบ: ${r.position}` });
  });
  return errors;
}

async function readExcelFile(file) {
  // ตรวจขนาดไฟล์ก่อนอ่าน (กัน browser freeze)
  if (file.size > EXCEL_MAX_MB * 1024 * 1024) {
    throw new Error(`ไฟล์ใหญ่เกิน ${EXCEL_MAX_MB} MB — กรุณาแบ่งไฟล์เป็นหลายไฟล์ย่อย`);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        // [PERF] XLSX lazy-load — โหลดสคริปต์ครั้งแรกที่ import (อาจ 200-500ms)
        if (typeof XLSX === 'undefined') await loadXLSX();
        // yield ให้ UI render "กำลังอ่าน..." ก่อน parse สูตร XLSX (sync, อาจ block 1-2 sec)
        await new Promise(r => setTimeout(r, 0));
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        // หา sheet "พนักงาน" หรือ sheet แรก
        const sheetName = wb.SheetNames.find(n => n.includes('พนักงาน')) || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        await new Promise(r => setTimeout(r, 0));
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        resolve(rows.map(parseImportRow));
      } catch (ex) { reject(ex); }
    };
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsArrayBuffer(file);
  });
}

function openImportEmployees() {
  if (!requireHR()) return;
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

    // ─── Auto-create departments ที่ยังไม่มีในระบบ (ตามคอลัมน์ "สายงาน") ───
    // เก็บ uniq dept+scope จากทุกแถวที่ระบุทั้ง 2 ค่า + ยังไม่มีในระบบ
    const existingDeptIds = new Set(DB.getDepartments().map(d => d.id));
    const deptsToCreate = new Map();  // id → { name, scope }
    for (const r of parsedRows) {
      if (r.department && r._scope && !existingDeptIds.has(r.department) && !deptsToCreate.has(r.department)) {
        deptsToCreate.set(r.department, { name: r.department, scope: r._scope });
      }
    }
    let deptCreated = 0;
    const deptErrors = [];
    if (deptsToCreate.size > 0) {
      $('#importBody').innerHTML = `<div class="card mt-4"><div>กำลังสร้างฝ่าย <strong>${deptsToCreate.size}</strong> ฝ่ายที่ยังไม่มีในระบบ...</div></div>`;
      for (const [id, info] of deptsToCreate) {
        try {
          await DB.saveDepartment({ id, name: info.name, manager: '', note: '', scope: info.scope });
          deptCreated++;
          existingDeptIds.add(id);
        } catch (ex) {
          deptErrors.push({ id, message: ex.message || String(ex) });
        }
      }
      $('#importBody').innerHTML = `
        <div class="card mt-4">
          <div style="color:var(--success);margin-bottom:6px">✓ สร้างฝ่ายอัตโนมัติ ${deptCreated} ฝ่าย${deptErrors.length ? ` (ผิดพลาด ${deptErrors.length})` : ''}</div>
          <div style="margin-bottom:10px">กำลังนำเข้าพนักงาน <strong id="progressText">0</strong> / <strong>${parsedRows.length.toLocaleString()}</strong></div>
          <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
        </div>
      `;
    }

    const result = await DB.bulkUpsertEmployees(parsedRows, (done, total) => {
      const pct = (done / total) * 100;
      const fill = $('#progressFill');
      const text = $('#progressText');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = done.toLocaleString();
    });
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);

    // ── หลัง upsert พนักงานสำเร็จ → สร้างบัญชี + ตั้ง role (admin เท่านั้น) ──
    // เกณฑ์: row ที่มี _role specified (หรือ auto-detect ถ้าไม่ระบุ) → create account
    let accSuccess = 0, accSkip = 0, accFail = 0;
    const accErrors = [];
    if (DB.isHR) {
      // โหลด profile list มาดูว่ามี user_account อยู่แล้วของใครบ้าง
      let existingProfiles = [];
      try { existingProfiles = await DB.getUserProfilesList(); } catch {}
      const existingEmpIds = new Set(existingProfiles.filter(p => p.employee_id).map(p => p.employee_id));

      $('#importBody').innerHTML = `
        <div class="card mt-4">
          <div style="margin-bottom:10px">กำลังสร้างบัญชี login + ตั้งสิทธิ์ <strong id="accProgress">0</strong> / <strong>${parsedRows.length.toLocaleString()}</strong></div>
          <div class="progress-bar"><div class="progress-fill" id="accFill" style="width:0%"></div></div>
        </div>
      `;
      for (let i = 0; i < parsedRows.length; i++) {
        const r = parsedRows[i];
        try {
          // สร้างบัญชีถ้ายังไม่มี
          if (!existingEmpIds.has(r.id)) {
            await DB.createEmployeeAccount(r.id);
            accSuccess++;
          } else {
            accSkip++;
          }
          // ตั้ง role — ถ้าระบุใน Excel ใช้ค่านั้น, ถ้าไม่ระบุ ใช้ auto-detect
          const emp = DB.getEmployee(r.id);
          const targetRole = r._role || DB.autoDetectRole(emp);
          if (targetRole && targetRole !== 'viewer') {
            await DB.setEmployeeRole(r.id, targetRole, []);
          }
        } catch (ex) {
          accFail++;
          accErrors.push({ id: r.id, message: ex.message || String(ex) });
        }
        const fill = $('#accFill');
        const text = $('#accProgress');
        if (fill) fill.style.width = (((i + 1) / parsedRows.length) * 100) + '%';
        if (text) text.textContent = (i + 1).toLocaleString();
      }
    }

    $('#importBody').innerHTML = `
      <div class="card mt-4">
        <div style="font-size:16px;font-weight:600;color:var(--success);margin-bottom:8px">✓ นำเข้าสำเร็จ</div>
        <div style="font-size:14px;line-height:1.8">
          ${deptCreated ? `• สร้างฝ่ายอัตโนมัติ: <strong style="color:var(--success)">${deptCreated.toLocaleString()}</strong> ฝ่าย<br>` : ''}
          ${deptErrors.length ? `• สร้างฝ่ายไม่สำเร็จ: <strong style="color:var(--danger)">${deptErrors.length.toLocaleString()}</strong> ฝ่าย<br>` : ''}
          • นำเข้าพนักงาน: <strong>${result.inserted.toLocaleString()}</strong> คน<br>
          ${result.failed ? `• ผิดพลาด (พนักงาน): <strong style="color:var(--danger)">${result.failed.toLocaleString()}</strong> คน<br>` : ''}
          ${DB.isHR ? `
            • สร้างบัญชี login ใหม่: <strong style="color:var(--success)">${accSuccess.toLocaleString()}</strong> คน<br>
            ${accSkip ? `• ข้าม (มีบัญชีอยู่แล้ว): <strong>${accSkip.toLocaleString()}</strong> คน<br>` : ''}
            ${accFail ? `• สร้างบัญชีไม่สำเร็จ: <strong style="color:var(--danger)">${accFail.toLocaleString()}</strong> คน<br>` : ''}
          ` : '• <span class="muted-2">บัญชี login: ต้องเป็น admin จึงจะสร้างให้อัตโนมัติ → ไปที่ "ตั้งค่าระบบ → บัญชีผู้ใช้"</span><br>'}
          • ใช้เวลา: <strong>${elapsed}</strong> วินาที
        </div>
        ${result.errors.length ? `
          <details class="mt-2" style="font-size:13px">
            <summary style="cursor:pointer;color:var(--danger)">ดูข้อผิดพลาด ${result.errors.length} batch</summary>
            <ul style="margin-top:6px;padding-left:20px">${result.errors.map(e => `<li>Batch ${e.chunk}: ${escapeHtml(e.message)}</li>`).join('')}</ul>
          </details>
        ` : ''}
        ${accErrors.length ? `
          <details class="mt-2" style="font-size:13px">
            <summary style="cursor:pointer;color:var(--warning)">ดูข้อผิดพลาดบัญชี ${accErrors.length} รายการ</summary>
            <ul style="margin-top:6px;padding-left:20px">${accErrors.slice(0, 20).map(e => `<li>${escapeHtml(e.id)}: ${escapeHtml(e.message)}</li>`).join('')}${accErrors.length > 20 ? `<li>... อีก ${accErrors.length - 20} รายการ</li>` : ''}</ul>
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
  if (!requireHR()) return;
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

async function exportEmployeesXLSX() {
  if (!requireHR()) return; // 🔒 เฉพาะ admin/HR — มีข้อมูลส่วนตัว + เงินเดือน
  if (typeof XLSX === 'undefined') {
    toast('กำลังโหลด XLSX library...', 'info');
    try { await loadXLSX(); } catch (e) { toast(e.message, 'error'); return; }
  }
  // text fields ผ่าน csvSafe() เพื่อกัน CSV-injection (ชื่อขึ้นต้น = + - @ จะถูก prefix ด้วย ')
  const cs = csvSafe;
  const rows = DB.getEmployees().map(e => ({
    'รหัส': excelNum(e.id), 'คำนำหน้า': cs(e.title), 'ชื่อ': cs(e.firstName), 'นามสกุล': cs(e.lastName),
    'ชื่อเล่น': cs(e.nickname),
    'เลขประชาชน': excelNum(e.nationalId), 'Passport': cs(e.passportNumber), 'Work Permit': cs(e.workPermitNumber), 'วันเกิด': excelDate(e.dob), 'เพศ': cs(e.gender),
    'สัญชาติ': cs(e.nationality), 'ศาสนา': cs(e.religion), 'วุฒิการศึกษา': cs(e.education),
    'เบอร์โทร': cs(e.phone), 'อีเมล': cs(e.email),
    'ที่อยู่': cs(e.address), 'แขวง/ตำบล': cs(e.subDistrict), 'เขต/อำเภอ': cs(e.district),
    'จังหวัด': cs(e.province), 'รหัสไปรษณีย์': cs(e.postalCode),
    'ฝ่าย': cs((DB.getDepartment(e.department) || {}).name || ''),
    'สาขา': cs(e.branch),
    'ระดับตำแหน่งงาน': cs((DB.getPosition(e.position) || {}).name || ''),
    'ตำแหน่ง': cs(e.positionTitle),
    'ประเภทพนักงาน': cs(e.employeeType),
    'วันเริ่มงาน': excelDate(e.hireDate),
    'วันพ้นสภาพ': excelDate(e.terminationDate),
    'เหตุผลพ้นสภาพ': cs(e.terminationReason),
    'รายละเอียดพ้นสภาพ': cs(e.terminationNote),
    'ธนาคาร': cs(e.bank), 'เลขบัญชี': cs(e.bankAccount),
    'เงินเดือน': Number(e.salary || 0),
    'ค่าตำแหน่ง': Number(e.allowancePosition || 0),
    'ค่าเดินทาง': Number(e.allowanceTravel || 0),
    'ค่าอาหาร': Number(e.allowanceFood || 0),
    'ค่าเบี้ยเลี้ยง': Number(e.allowancePerDiem || 0),
    'ค่าภาษา': Number(e.allowanceLanguage || 0),
    'ค่าโทรศัพท์': Number(e.allowancePhone || 0),
    'ค่าอื่นๆ': Number(e.allowanceOther || 0),
    'รวมรายได้': totalIncome(e),
    'เลข สปส.': cs(e.ssoNo),
    'วันที่แจ้งเข้า สปส.': excelDate(e.ssoEnrolledDate),
    'วันที่แจ้งออก สปส.': excelDate(e.ssoTerminatedDate),
    'สถานพยาบาล สปส.': cs(e.ssoHospital),
    'สถานะ': e.status === 'active' ? 'ปฏิบัติงาน' : 'ลาออก',
    'หมายเหตุ': cs(e.note)
  }));
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  const headerKeys = Object.keys(rows[0] || {});

  // เลขประชาชน → ฟอร์แมต '0' กันไม่ให้ Excel แสดงเป็น scientific notation (1.23E+12)
  const nidIdx = headerKeys.indexOf('เลขประชาชน');
  if (nidIdx >= 0) setColumnFormat(ws, nidIdx, '0');

  // รหัสพนักงาน → ฟอร์แมต '0' (number ไม่มีจุดทศนิยม)
  const idIdx = headerKeys.indexOf('รหัส');
  if (idIdx >= 0) setColumnFormat(ws, idIdx, '0');

  // ทุกคอลัมน์เงินเดือน/ค่าต่างๆ → '#,##0' (มี comma คั่นพัน, ไม่มีทศนิยม)
  const moneyCols = ['เงินเดือน', 'ค่าตำแหน่ง', 'ค่าเดินทาง', 'ค่าอาหาร', 'ค่าเบี้ยเลี้ยง', 'ค่าภาษา', 'ค่าโทรศัพท์', 'ค่าอื่นๆ', 'รวมรายได้'];
  for (const col of moneyCols) {
    const idx = headerKeys.indexOf(col);
    if (idx >= 0) setColumnFormat(ws, idx, '#,##0');
  }

  // กำหนดความกว้างคอลัมน์ — เลขประชาชน 16 ตัวอักษรเพื่อให้เห็น 13 หลักเต็ม
  ws['!cols'] = headerKeys.map(k => {
    if (k === 'เลขประชาชน' || k === 'เลข สปส.') return { wch: 16 };
    if (k === 'วันเกิด' || k === 'วันเริ่มงาน' || k === 'วันพ้นสภาพ' || k === 'วันที่แจ้งเข้า สปส.' || k === 'วันที่แจ้งออก สปส.') return { wch: 14 };
    if (k === 'รหัส') return { wch: 8 };
    if (k === 'ชื่อ' || k === 'นามสกุล') return { wch: 14 };
    if (k === 'ตำแหน่ง' || k === 'ฝ่าย') return { wch: 22 };
    if (k === 'ที่อยู่') return { wch: 30 };
    if (moneyCols.includes(k)) return { wch: 12 };
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
// ═══════════════════════════════════════════════════════
//  PAGE: BRANCHES (สาขา — master list)
// ═══════════════════════════════════════════════════════
const _branchPageState = { showClosed: false };
function toggleShowClosedBranches() { _branchPageState.showClosed = !_branchPageState.showClosed; router.go('branches'); }

// ═══════════════════════════════════════════════════════
//  PAGE: BRANCH MANAGERS (ผู้บังคับบัญชาสาขา — ทุกคนเห็นได้)
// ═══════════════════════════════════════════════════════
router.register('branch-managers', () => {
  // ใช้ getBranchMaster แบบไม่ scope — แสดงสาขาทั้งหมดที่ active
  const allBranches = (DB.getBranchMaster({ activeOnly: true }) || []);
  const myEmp = DB.profile?.employee_id ? DB.getEmployee(DB.profile.employee_id) : null;
  const myBranch = myEmp?.branch || '';
  const myDept = myEmp?.department || '';

  // ─── สำนักงาน: ดึงฝ่ายทั้งหมด แล้วหาหัวหน้าฝ่าย (จาก dept.manager หรือ auto-detect ระดับสูงสุด) ───
  // ถ้ามี scope=office ให้กรองเฉพาะออฟฟิศ; ถ้าไม่มี department ที่ตั้ง scope ไว้เลย → แสดงทุกฝ่าย (fallback)
  const allDepts = (DB.getDepartments?.() || []);
  const hasOfficeScope = allDepts.some(d => (d.scope || '').toLowerCase() === 'office');
  const officeDepts = hasOfficeScope
    ? allDepts.filter(d => (d.scope || '').toLowerCase() === 'office')
    : allDepts;

  // หัวหน้าฝ่าย: ถ้ามี dept.manager ระบุไว้ → ใช้ค่านั้น (กรณี active); ถ้าไม่ → auto-detect ระดับสูงสุดในฝ่าย
  const getDeptHead = (dept) => {
    if (dept.manager) {
      const m = DB.getEmployee?.(dept.manager);
      if (m && DB.empStatus(m) !== 'resigned') return m;
    }
    const emps = (DB.data.employees || []).filter(e =>
      e.department === dept.id && DB.empStatus(e) !== 'resigned'
    );
    if (!emps.length) return null;
    let best = null, bestLevel = -1;
    for (const e of emps) {
      const pos = DB.getPosition?.(e.position);
      const lvl = Number(pos?.level || 0);
      if (lvl > bestLevel) { bestLevel = lvl; best = e; }
    }
    return best;
  };

  const renderBranchRow = (b) => {
    const mgr = DB.getBranchManager(b.id);
    const pos = mgr ? (DB.getPosition(mgr.position) || {}) : {};
    const mgrName = mgr ? `${(mgr.title || '') + mgr.firstName} ${mgr.lastName || ''}`.trim() : '';
    const mgrPos = mgr ? (mgr.positionTitle || pos.name || '') : '';
    const levelBadge = pos.level ? ` <span class="badge badge-info" style="font-size:10px;margin-left:4px">ระดับ ${pos.level}</span>` : '';
    const isMine = b.id === myBranch;
    return `<tr ${isMine ? 'style="background:rgba(78,112,176,0.06)"' : ''}>
      <td>
        <code style="font-size:12px;font-weight:700">${escapeHtml(b.id)}</code>
        ${isMine ? '<span class="badge badge-success" style="font-size:10px;margin-left:6px">สาขาของฉัน</span>' : ''}
      </td>
      <td>${mgr
        ? `<strong>${escapeHtml(mgrName)}</strong>${mgr.nickname ? `<span class="muted-2" style="margin-left:6px">· ${escapeHtml(mgr.nickname)}</span>` : ''}`
        : '<span class="muted-2">—</span>'}</td>
      <td class="sw-cell-meta">${escapeHtml(mgrPos)}${levelBadge}</td>
      <td>${mgr?.phone ? `<a href="tel:${escapeHtml(mgr.phone)}" style="color:var(--primary);text-decoration:none">${escapeHtml(mgr.phone)}</a>` : '<span class="muted-2">—</span>'}</td>
      <td>${b.phone ? `<a href="tel:${escapeHtml(b.phone)}" style="color:var(--primary);text-decoration:none">${escapeHtml(b.phone)}</a>` : '<span class="muted-2">—</span>'}</td>
      <td>${b.email ? `<a href="mailto:${escapeHtml(b.email)}" style="color:var(--primary);text-decoration:none">${escapeHtml(b.email)}</a>` : '<span class="muted-2">—</span>'}</td>
    </tr>`;
  };

  const renderDeptRow = (d) => {
    const mgr = getDeptHead(d);
    const pos = mgr ? (DB.getPosition(mgr.position) || {}) : {};
    const mgrName = mgr ? `${(mgr.title || '') + mgr.firstName} ${mgr.lastName || ''}`.trim() : '';
    const mgrPos = mgr ? (mgr.positionTitle || pos.name || '') : '';
    const levelBadge = pos.level ? ` <span class="badge badge-info" style="font-size:10px;margin-left:4px">ระดับ ${pos.level}</span>` : '';
    const isMine = d.id === myDept;
    const explicit = !!d.manager;
    return `<tr ${isMine ? 'style="background:rgba(196,165,116,0.08)"' : ''}>
      <td>
        <code style="font-size:12px;font-weight:700">${escapeHtml(d.id)}</code>
        ${isMine ? '<span class="badge badge-gold" style="font-size:10px;margin-left:6px">ฝ่ายของฉัน</span>' : ''}
      </td>
      <td><strong>${escapeHtml(d.name || '—')}</strong></td>
      <td>${mgr
        ? `<strong>${escapeHtml(mgrName)}</strong>${mgr.nickname ? `<span class="muted-2" style="margin-left:6px">· ${escapeHtml(mgr.nickname)}</span>` : ''}${!explicit ? '<span class="muted-2" style="font-size:11px;margin-left:6px">(auto-detect)</span>' : ''}`
        : '<span class="muted-2">— ยังไม่ได้กำหนด —</span>'}</td>
      <td class="sw-cell-meta">${escapeHtml(mgrPos)}${levelBadge}</td>
      <td>${mgr?.phone ? `<a href="tel:${escapeHtml(mgr.phone)}" style="color:var(--primary);text-decoration:none">${escapeHtml(mgr.phone)}</a>` : '<span class="muted-2">—</span>'}</td>
      <td>${mgr?.email ? `<a href="mailto:${escapeHtml(mgr.email)}" style="color:var(--primary);text-decoration:none">${escapeHtml(mgr.email)}</a>` : '<span class="muted-2">—</span>'}</td>
    </tr>`;
  };

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ผู้บังคับบัญชา &amp; ติดต่อ</div>
        <div class="sw-page-subtitle">ติดต่อหัวหน้าสาขาและฝ่ายสำนักงาน — สำหรับเรื่องที่เกี่ยวข้อง</div>
      </div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">ผู้บังคับบัญชาสาขา <span class="sw-chart-count">${fmt.num(allBranches.length)}</span></div>
          <div class="sw-chart-sub">หัวหน้าและสำนักงานของแต่ละสาขา · อิงตามระดับตำแหน่งสูงสุด (auto-detect)</div>
        </div>
      </div>
      ${allBranches.length ? `
        <div class="table-wrap"><table class="table table-compact">
          <thead><tr>
            <th style="width:80px">รหัสสาขา</th>
            <th>ผู้บังคับบัญชา</th>
            <th>ตำแหน่ง</th>
            <th>เบอร์มือถือ</th>
            <th>เบอร์สาขา</th>
            <th>Email สาขา</th>
          </tr></thead>
          <tbody>${allBranches.map(renderBranchRow).join('')}</tbody>
        </table></div>
      ` : `<div class="empty-state" style="padding:40px 20px">
        <div style="font-size:36px;margin-bottom:10px;opacity:0.35">🏢</div>
        <div class="title">ไม่มีข้อมูลสาขา</div>
      </div>`}
    </div>

    <div class="sw-chart-card" style="margin-top:24px">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">ผู้บังคับบัญชาฝ่ายสำนักงาน <span class="sw-chart-count">${fmt.num(officeDepts.length)}</span></div>
          <div class="sw-chart-sub">${hasOfficeScope ? 'หัวหน้าของแต่ละฝ่ายสายสำนักงาน' : 'หัวหน้าของแต่ละฝ่าย'} · หัวหน้าที่กำหนดเองมาก่อน, ไม่ได้กำหนด → ใช้ตำแหน่งสูงสุดในฝ่าย (auto-detect)${DB.isHR ? ' · ตั้งหัวหน้าได้ที่เมนู "ฝ่าย"' : ''}</div>
        </div>
      </div>
      ${officeDepts.length ? `
        <div class="table-wrap"><table class="table table-compact">
          <thead><tr>
            <th style="width:80px">รหัสฝ่าย</th>
            <th>ชื่อฝ่าย</th>
            <th>หัวหน้าฝ่าย</th>
            <th>ตำแหน่ง</th>
            <th>เบอร์มือถือ</th>
            <th>Email</th>
          </tr></thead>
          <tbody>${officeDepts.map(renderDeptRow).join('')}</tbody>
        </table></div>
      ` : `<div class="empty-state" style="padding:40px 20px">
        <div style="font-size:36px;margin-bottom:10px;opacity:0.35">🗂</div>
        <div class="title">ยังไม่มีฝ่ายสำนักงาน</div>
        ${DB.isHR ? '<div class="hint" style="margin-top:6px">เพิ่มฝ่ายและตั้ง scope = office ที่เมนู "ฝ่าย"</div>' : ''}
      </div>`}
    </div>
  `;
});

router.register('branches', () => {
  const allBranches = DB.getBranchMaster();
  const closedCount = allBranches.filter(b => !b.active).length;
  const list = _branchPageState.showClosed ? allBranches : allBranches.filter(b => b.active);
  const totalEmps = list.reduce((s, b) => s + DB.getBranchEmployeeCount(b.id), 0);
  const avgPerBranch = list.length ? Math.round(totalEmps / list.length) : 0;
  const topBranch = list.map(b => ({ ...b, count: DB.getBranchEmployeeCount(b.id) })).sort((a, b) => b.count - a.count)[0];
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">สาขา</div>
        <div class="sw-page-subtitle">โครงสร้างสาขาและพนักงานต่อสาขา${_branchPageState.showClosed ? '' : (closedCount > 0 ? ` · ซ่อน ${closedCount} ที่ปิดอยู่` : '')}</div>
      </div>
      <div class="sw-page-actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        ${closedCount > 0 ? `<label style="font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-2)">
          <input type="checkbox" ${_branchPageState.showClosed ? 'checked' : ''} onchange="toggleShowClosedBranches()"/>
          แสดงสาขาที่ปิด (${closedCount})
        </label>` : ''}
        ${DB.isHR ? `<button class="btn btn-primary" onclick="openBranchForm()">+ เพิ่มสาขา</button>` : ''}
      </div>
    </div>
    <div class="sw-stats-grid" style="margin-bottom:28px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,58,138,0.12);color:var(--primary)">🏢</div>
        <div class="sw-stat-label">สาขาที่ใช้งาน</div>
        <div class="sw-stat-value">${fmt.num(list.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">${closedCount > 0 ? `ซ่อน ${closedCount} ที่ปิด` : 'ใช้งานทั้งหมด'}</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(22,163,74,0.12);color:var(--success)">${ICON.users}</div>
        <div class="sw-stat-label">พนักงานรวม</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(totalEmps)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">คน · กระจายในสาขา</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(124,58,237,0.12);color:#7c3aed">📊</div>
        <div class="sw-stat-label">เฉลี่ย/สาขา</div>
        <div class="sw-stat-value">${fmt.num(avgPerBranch)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">คน · ค่าเฉลี่ย</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(217,119,6,0.12);color:var(--warning)">🏆</div>
        <div class="sw-stat-label">สาขายอดสูงสุด</div>
        <div class="sw-stat-value" style="font-size:20px">${topBranch ? escapeHtml(topBranch.id) : '—'}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">${topBranch ? topBranch.count + ' คน · ' + escapeHtml(topBranch.name || '') : ''}</div>
      </div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายการสาขา <span class="sw-chart-count">${fmt.num(list.length)}</span></div>
          <div class="sw-chart-sub">เรียงตามรหัสสาขา · คลิก "แก้" เพื่อเปิด/ปิดสาขา</div>
        </div>
      </div>
      ${list.length ? `
      <div class="table-wrap"><table class="table table-compact sw-emp-table">
        <thead><tr>
          <th class="num" style="width:50px">#</th>
          <th>รหัสสาขา</th>
          <th>ชื่อเต็ม</th>
          <th class="num">พนักงาน</th>
          <th>สถานะ</th>
          <th>หมายเหตุ</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${list.map((b, i) => {
            const count = DB.getBranchEmployeeCount(b.id);
            return `<tr style="${b.active ? '' : 'opacity:0.6'}">
              <td class="num muted-2">${i + 1}</td>
              <td><code style="font-size:12px;font-weight:700">${escapeHtml(b.id)}</code></td>
              <td><strong>${escapeHtml(b.name || '—')}</strong></td>
              <td class="num"><strong>${fmt.num(count)}</strong><span class="muted-2" style="font-size:11px"> คน</span></td>
              <td>${b.active ? '<span class="badge badge-success">✓ ใช้งาน</span>' : '<span class="badge">ปิด</span>'}</td>
              <td class="sw-reason-cell">${escapeHtml(b.note || '—')}</td>
              <td class="actions">
                ${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openBranchForm('${escapeHtml(b.id)}')">แก้</button>
                <button class="btn btn-ghost btn-sm" onclick="deleteBranch('${escapeHtml(b.id)}')">ลบ</button>` : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state" style="padding:60px 20px">
        <div style="font-size:42px;margin-bottom:12px;opacity:0.35">🏢</div>
        <div class="title" style="font-size:16px;font-weight:600">ยังไม่มีสาขา</div>
        <div class="hint" style="margin-top:6px">กด + เพิ่มสาขา เพื่อเริ่มต้น</div>
      </div>`}
    </div>
  `;
});

function openBranchForm(id = null) {
  if (!requireHR()) return;
  const b = id ? DB.getBranch(id) : { id: '', name: '', active: true, note: '', phone: '', email: '' };
  if (id && !b) { toast('ไม่พบสาขา', 'error'); return; }
  modal.open(id ? `แก้ไขสาขา "${id}"` : 'เพิ่มสาขาใหม่', `
    <form id="branchForm">
      <div class="form-grid">
        <div class="form-group"><label>รหัสสาขา *</label>
          <input name="id" value="${escapeHtml(b.id)}" required maxlength="20" ${id ? 'readonly' : ''} placeholder="เช่น KMB, GE, JM" style="${id ? 'background:var(--surface-2)' : ''}"/>
          ${id ? '<small class="muted-2" style="font-size:11px">รหัสสาขาเปลี่ยนไม่ได้หลังสร้าง (กระทบข้อมูลพนักงานที่อ้างอิงอยู่)</small>' : '<small class="muted-2" style="font-size:11px">ใส่ตัวอักษร/ตัวเลข ห้ามซ้ำกับสาขาที่มี</small>'}
        </div>
        <div class="form-group"><label>ชื่อเต็ม (optional)</label><input name="name" value="${escapeHtml(b.name)}" placeholder="ชื่อเต็มของสาขา"/></div>
        <div class="form-group"><label>เบอร์โทรสาขา</label><input name="phone" value="${escapeHtml(b.phone || '')}" placeholder="02-xxx-xxxx หรือ 08x-xxx-xxxx"/></div>
        <div class="form-group"><label>Email สาขา</label><input name="email" type="email" value="${escapeHtml(b.email || '')}" placeholder="branch@kachabros.com"/></div>
        <div class="form-group"><label>สถานะ</label>
          <select name="active">
            <option value="true" ${b.active ? 'selected' : ''}>ใช้งาน</option>
            <option value="false" ${!b.active ? 'selected' : ''}>ปิดใช้งาน</option>
          </select>
        </div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="2" placeholder="ที่อยู่ หรือข้อมูลเพิ่มเติม">${escapeHtml(b.note)}</textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>
  `);
  $('#branchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.id = (data.id || '').trim().toUpperCase();
      data.active = data.active === 'true';
      if (!id && DB.getBranch(data.id)) { toast(`รหัสสาขา "${data.id}" มีอยู่แล้ว`, 'error'); return; }
      await DB.saveBranch(data);
      modal.close();
      toast(id ? 'บันทึกแล้ว' : 'เพิ่มสาขาแล้ว', 'success');
      router.go('branches');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteBranch(id) {
  if (!requireHR()) return;
  const b = DB.getBranch(id);
  if (!b) return;
  const count = DB.getBranchEmployeeCount(id);
  if (count > 0) {
    toast(`ลบไม่ได้ — มีพนักงาน ${count} คนใช้สาขานี้ (ย้ายสาขาก่อน หรือเปลี่ยนเป็น "ปิดใช้งาน")`, 'error');
    return;
  }
  if (!await modal.confirm('ลบสาขา', `ลบสาขา "${id}" ใช่หรือไม่?`)) return;
  try {
    const result = await DB.deleteBranch(id);
    if (!result.ok) { toast(result.reason || 'ลบไม่ได้', 'error'); return; }
    toast('ลบแล้ว', 'success');
    router.go('branches');
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// state การเรียงของหน้า "ฝ่าย" — คงอยู่ตลอด session (รีเฟรชแล้ว reset)
let _deptSort = { by: 'name', dir: 'asc' };
function setDeptSort(by) {
  if (_deptSort.by === by) _deptSort.dir = _deptSort.dir === 'asc' ? 'desc' : 'asc';
  else { _deptSort.by = by; _deptSort.dir = 'asc'; }
  if (router.current === 'departments') router.go('departments');
}

const deptState = { search: '', scope: '', hasEmps: '' };
let _deptSearchTimer;

router.register('departments', () => {
  const allDepts = DB.getDepartments();
  const emps = DB.getEmployees({ status: 'active' });
  // นับพนักงานต่อฝ่ายล่วงหน้า — เร็วกว่า filter ใน loop
  const countByDept = new Map();
  for (const e of emps) countByDept.set(e.department, (countByDept.get(e.department) || 0) + 1);

  // ── apply filter ──
  const sLc = (deptState.search || '').toLowerCase().trim();
  const depts = allDepts.filter(d => {
    if (deptState.scope && d.scope !== deptState.scope) return false;
    if (deptState.hasEmps === 'with'    && (countByDept.get(d.id) || 0) === 0) return false;
    if (deptState.hasEmps === 'without' && (countByDept.get(d.id) || 0)  >  0) return false;
    if (sLc) {
      const hay = (d.id + ' ' + (d.name || '')).toLowerCase();
      if (!hay.includes(sLc)) return false;
    }
    return true;
  });

  // จัดเรียงตาม state (default = ชื่อฝ่าย asc — เหมือนเดิม)
  const sortedDepts = depts.slice().sort((a, b) => {
    let cmp = 0;
    if (_deptSort.by === 'id') cmp = (a.id || '').localeCompare(b.id || '');
    else if (_deptSort.by === 'name') cmp = (a.name || '').localeCompare(b.name || '', 'th');
    else if (_deptSort.by === 'count') cmp = (countByDept.get(a.id) || 0) - (countByDept.get(b.id) || 0);
    else if (_deptSort.by === 'manager') {
      const ma = a.manager ? (DB.getEmployee(a.manager)?.firstName || '') : '';
      const mb = b.manager ? (DB.getEmployee(b.manager)?.firstName || '') : '';
      cmp = ma.localeCompare(mb, 'th');
    }
    return _deptSort.dir === 'asc' ? cmp : -cmp;
  });
  // helper สำหรับสร้างหัวคอลัมน์ที่กดได้
  const arrow = (key) => _deptSort.by === key ? `<span style="color:var(--primary);margin-left:4px">${_deptSort.dir === 'asc' ? '▲' : '▼'}</span>` : '<span style="opacity:0.25;margin-left:4px">↕</span>';
  const sortHead = (key, label, cls = '') => `<th class="${cls}" style="cursor:pointer;user-select:none;white-space:nowrap" onclick="setDeptSort('${key}')" title="คลิกเพื่อเรียงตาม${label}">${label}${arrow(key)}</th>`;

  const filtered = deptState.search || deptState.scope || deptState.hasEmps;
  const countLabel = filtered
    ? `<span class="sw-chart-count">${fmt.num(depts.length)} / ${fmt.num(allDepts.length)}</span>`
    : `<span class="sw-chart-count">${fmt.num(allDepts.length)}</span>`;

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ฝ่ายงาน</div>
        <div class="sw-page-subtitle">โครงสร้างฝ่ายภายในบริษัท · ${fmt.num(allDepts.length)} ฝ่าย · พนักงานปัจจุบัน ${fmt.num(emps.length)} คน</div>
      </div>
      <div class="sw-page-actions">${DB.isHR ? '<button class="btn btn-primary" onclick="openDeptForm()">+ เพิ่มฝ่าย</button>' : ''}</div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายการฝ่าย ${countLabel}</div>
          <div class="sw-chart-sub">คลิกหัวคอลัมน์เพื่อจัดเรียง · คลิกซ้ำเพื่อสลับน้อย→มาก / มาก→น้อย</div>
        </div>
      </div>
      <div class="sw-filter-bar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border)">
        <input id="deptSearch" class="sw-filter-input" type="search" placeholder="🔍 ค้นชื่อ / รหัส" value="${escapeHtml(deptState.search)}" style="flex:1;min-width:200px"/>
        <select class="sw-filter-select" id="deptScope">
          <option value="">— ทุกสาย —</option>
          ${DB.getScopes().map(s => `<option value="${escapeHtml(s.id)}" ${deptState.scope === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
        </select>
        <select class="sw-filter-select" id="deptHasEmps">
          <option value="">— ทุกฝ่าย —</option>
          <option value="with"    ${deptState.hasEmps === 'with'    ? 'selected' : ''}>มีพนักงาน</option>
          <option value="without" ${deptState.hasEmps === 'without' ? 'selected' : ''}>ไม่มีพนักงาน</option>
        </select>
        <button id="deptClearFilter" class="btn btn-ghost btn-sm sw-filter-clear" onclick="clearDeptFilters()" style="${filtered ? '' : 'display:none'}">✕ ล้างตัวกรอง</button>
      </div>
      ${depts.length ? `
      <div class="table-wrap"><table class="table table-compact sw-emp-table">
        <thead><tr>
          ${sortHead('id', 'รหัส')}
          ${sortHead('name', 'ชื่อฝ่าย')}
          <th>สาย</th>
          ${sortHead('manager', 'หัวหน้าฝ่าย')}
          ${sortHead('count', 'จำนวนพนักงาน', 'num')}
          <th>หมายเหตุ</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${sortedDepts.map(d => {
            const mgr = d.manager ? DB.getEmployee(d.manager) : null;
            const count = countByDept.get(d.id) || 0;
            const sc = d.scope ? DB.getScope(d.scope) : null;
            const scopeBadge = sc
              ? `<span class="badge" style="background:${escapeHtml(sc.badgeBg)};color:${escapeHtml(sc.badgeColor)};font-size:10.5px">${escapeHtml(sc.label)}</span>`
              : '<span class="muted-2" style="font-size:11px">—</span>';
            return `<tr>
              <td><code style="font-size:11.5px;font-weight:600">${escapeHtml(d.id)}</code></td>
              <td><strong>${escapeHtml(d.name)}</strong></td>
              <td>${scopeBadge}</td>
              <td class="sw-cell-meta">${mgr ? escapeHtml(mgr.firstName + ' ' + mgr.lastName) : '<span class="muted-2">—</span>'}</td>
              <td class="num"><strong>${fmt.num(count)}</strong><span class="muted-2" style="font-size:11px"> คน</span></td>
              <td class="sw-reason-cell">${escapeHtml(d.note || '—')}</td>
              <td class="actions">${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openDeptForm('${d.id}')">แก้</button><button class="btn btn-ghost btn-sm" onclick="deleteDept('${d.id}')">ลบ</button>` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state" style="padding:40px 20px">
        <div style="font-size:32px;margin-bottom:8px;opacity:0.3">${filtered ? '🔍' : '🗂️'}</div>
        <div class="title" style="font-size:14px;font-weight:600">${filtered ? 'ไม่พบฝ่ายที่ตรงกับตัวกรอง' : 'ยังไม่มีฝ่าย'}</div>
        <div class="hint" style="margin-top:4px">${filtered ? 'ลองล้างตัวกรองเพื่อดูทั้งหมด' : 'กดปุ่ม + เพิ่มฝ่าย เพื่อเริ่ม'}</div>
      </div>`}
    </div>`;
});

function wireDepartmentsPage() {
  const goDept = debounce(() => router.go('departments'), 80);
  $('#deptSearch')?.addEventListener('input', (e) => {
    clearTimeout(_deptSearchTimer);
    _deptSearchTimer = setTimeout(() => {
      deptState.search = e.target.value;
      router.go('departments');
    }, 200);
  });
  $('#deptScope')?.addEventListener('change', (e)   => { deptState.scope   = e.target.value; goDept(); });
  $('#deptHasEmps')?.addEventListener('change', (e) => { deptState.hasEmps = e.target.value; goDept(); });
}

function clearDeptFilters() {
  deptState.search = '';
  deptState.scope = '';
  deptState.hasEmps = '';
  router.go('departments');
}

function openDeptForm(id = null) {
  if (!requireHR()) return;
  const d = id ? DB.getDepartment(id) : { id: '', name: '', manager: '', note: '' };
  const emps = DB.getEmployees({ status: 'active' });
  const nextId = !id ? DB.nextDepartmentId() : '';
  // นับพนักงาน + ผู้สมัครที่ใช้ฝ่ายนี้ — ใช้ใน confirm ตอน rename
  const affectedCount = id
    ? (DB.data.employees || []).filter(e => e.department === id).length
      + (DB.data.applicants || []).filter(a => a.department === id).length
    : 0;
  modal.open(id ? 'แก้ไขฝ่าย' : 'เพิ่มฝ่าย', `
    <form id="deptForm">
      <div class="form-grid">
        <div class="form-group">
          <label>รหัส * <span class="muted-2" style="font-weight:normal;font-size:11px">${id ? '(เปลี่ยนได้ — ระบบจะอัปเดต FK ในตารางพนักงาน/ผู้สมัครให้)' : '(ตั้งเองได้ — เช่น KITCHEN, OPS, D012)'}</span></label>
          <input name="id" id="deptIdInput" value="${escapeHtml(d.id)}" required maxlength="20" pattern="[A-Za-z0-9_-]+" title="ใช้ A-Z, 0-9, _ หรือ - เท่านั้น" ${id ? '' : `placeholder="เช่น ${escapeHtml(nextId)} หรือ KITCHEN"`} />
          ${!id ? `<div style="margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-ghost btn-sm" style="padding:4px 10px;font-size:11.5px" onclick="document.getElementById('deptIdInput').value='${escapeHtml(nextId)}';document.getElementById('deptIdInput').focus()">↻ ใช้รหัสถัดไป (${escapeHtml(nextId)})</button>
            <span class="muted-2" style="font-size:11px">ใช้ A-Z, 0-9, _ หรือ -</span>
          </div>` : `<div style="margin-top:6px"><span class="muted-2" style="font-size:11px">ใช้ A-Z, 0-9, _ หรือ -${affectedCount ? ` · มีพนักงาน/ผู้สมัคร ${affectedCount} คนผูกอยู่กับรหัสนี้` : ''}</span></div>`}
        </div>
        <div class="form-group"><label>ชื่อฝ่าย *</label><input name="name" value="${escapeHtml(d.name)}" required/></div>
        <div class="form-group span-2"><label>สาย <span class="muted-2" style="font-weight:normal;font-size:11px">(เลือกเพื่อให้ dropdown ตำแหน่งใน "เพิ่มพนักงาน" แสดงเฉพาะตำแหน่งที่ตรงกับสายนี้)</span></label>
          <select name="scope">
            <option value="" ${!d.scope ? 'selected' : ''}>— ไม่ระบุ (ใช้ตำแหน่งทุกแบบ) —</option>
            ${DB.getScopes().map(s => `<option value="${escapeHtml(s.id)}" ${d.scope === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group span-2"><label>หัวหน้าฝ่าย <span class="muted-2" style="font-weight:normal;font-size:11px">(ไม่บังคับ — เคลียร์ช่องเพื่อไม่ระบุ)</span></label>${employeePicker({ name: 'manager', emps, selected: d.manager, placeholder: 'พิมพ์ชื่อหรือเคลียร์เพื่อไม่ระบุ' })}</div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="2">${escapeHtml(d.note)}</textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>`);
  wireEmployeePickers('#deptForm');
  $('#deptForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.id = (data.id || '').trim();
      // กันรหัสซ้ำตอนเพิ่มใหม่ (UPSERT จะ overwrite ฝ่ายเดิม → อันตราย)
      if (!id && DB.getDepartment(data.id)) {
        toast(`รหัส "${data.id}" มีอยู่แล้ว — เปลี่ยนเป็นรหัสอื่น`, 'error');
        return;
      }
      // เปลี่ยนรหัสฝ่าย (rename) — ยืนยันก่อนเพราะกระทบพนักงาน/ผู้สมัครหลายคน
      const isRename = id && data.id !== id;
      if (isRename) {
        if (DB.getDepartment(data.id)) {
          toast(`รหัส "${data.id}" ถูกใช้กับฝ่ายอื่นแล้ว — เลือกรหัสอื่น`, 'error');
          return;
        }
        const ok = await modal.confirm(
          'ยืนยันการเปลี่ยนรหัสฝ่าย',
          `เปลี่ยนรหัสจาก "${id}" → "${data.id}"?\n\n` +
          `ระบบจะอัปเดต FK ของพนักงาน${affectedCount ? ` ${affectedCount} คน` : ''} + ผู้สมัครที่ผูกอยู่กับรหัสนี้ให้อัตโนมัติ (atomic) — ดำเนินการต่อ?`
        );
        if (!ok) return;
      }
      await DB.saveDepartment(data, id);
      modal.close();
      toast(isRename ? 'เปลี่ยนรหัสฝ่ายแล้ว' : 'บันทึกข้อมูลฝ่ายแล้ว', 'success');
      router.go('departments');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteDept(id) {
  if (!requireHR()) return;
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
const posState = { search: '', scope: '', hasEmps: '' };
let _posSearchTimer;

router.register('positions', () => {
  // เรียงตาม level desc แล้ว name asc — ระดับสูงอยู่บน
  const allPs = DB.getPositions().slice().sort((a, b) => (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name));
  const emps = DB.getEmployees({ status: 'active' });
  // นับพนักงานต่อตำแหน่ง — ใช้ทั้งใน filter (hasEmps) และแสดงในตาราง
  const empCount = new Map();
  for (const e of emps) empCount.set(e.position, (empCount.get(e.position) || 0) + 1);

  // ── apply filter ──
  const sLc = (posState.search || '').toLowerCase().trim();
  const ps = allPs.filter(p => {
    if (posState.scope && p.scope !== posState.scope) return false;
    if (posState.hasEmps === 'with'    && (empCount.get(p.id) || 0) === 0) return false;
    if (posState.hasEmps === 'without' && (empCount.get(p.id) || 0)  >  0) return false;
    if (sLc) {
      const hay = (p.id + ' ' + (p.name || '')).toLowerCase();
      if (!hay.includes(sLc)) return false;
    }
    return true;
  });

  const filtered = posState.search || posState.scope || posState.hasEmps;
  const countLabel = filtered
    ? `<span class="sw-chart-count">${fmt.num(ps.length)} / ${fmt.num(allPs.length)}</span>`
    : `<span class="sw-chart-count">${fmt.num(allPs.length)}</span>`;

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ระดับตำแหน่ง</div>
        <div class="sw-page-subtitle">โครงสร้างตำแหน่งและช่วงเงินเดือน · เรียงจากระดับสูงสุดลงต่ำสุด · ${fmt.num(allPs.length)} ตำแหน่ง</div>
      </div>
      <div class="sw-page-actions">${DB.isHR ? '<button class="btn btn-ghost" onclick="openScopeManager()" title="จัดการสายงาน (Operation, Office, SCM ...)">⚙️ จัดการสาย</button> <button class="btn btn-primary" onclick="openPositionForm()">+ เพิ่มตำแหน่ง</button>' : ''}</div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายการตำแหน่ง ${countLabel}</div>
          <div class="sw-chart-sub">ใช้ระดับเพื่อคำนวณ "ผู้อนุมัติการลา" ของแต่ละสาขา — ระดับสูงสุดในสาขา = หัวหน้าสาขา</div>
        </div>
      </div>
      <div class="sw-filter-bar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border)">
        <input id="posSearch" class="sw-filter-input" type="search" placeholder="🔍 ค้นชื่อ / รหัส" value="${escapeHtml(posState.search)}" style="flex:1;min-width:200px"/>
        <select class="sw-filter-select" id="posScope">
          <option value="">— ทุกสาย —</option>
          ${DB.getScopes().map(s => `<option value="${escapeHtml(s.id)}" ${posState.scope === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
        </select>
        <select class="sw-filter-select" id="posHasEmps">
          <option value="">— ทุกตำแหน่ง —</option>
          <option value="with"    ${posState.hasEmps === 'with'    ? 'selected' : ''}>มีพนักงาน</option>
          <option value="without" ${posState.hasEmps === 'without' ? 'selected' : ''}>ไม่มีพนักงาน</option>
        </select>
        <button id="posClearFilter" class="btn btn-ghost btn-sm sw-filter-clear" onclick="clearPosFilters()" style="${filtered ? '' : 'display:none'}">✕ ล้างตัวกรอง</button>
      </div>
      ${ps.length ? `
      <div class="table-wrap"><table class="table table-compact sw-emp-table">
        <thead><tr><th>รหัส</th><th>ชื่อตำแหน่ง</th><th>สาย</th><th class="num">ระดับ</th><th class="num">เงินเดือนต่ำสุด</th><th class="num">เงินเดือนสูงสุด</th><th class="num">พนักงาน</th><th></th></tr></thead>
        <tbody>
          ${ps.map(p => {
            const count = empCount.get(p.id) || 0;
            const lvBadge = p.level >= 7 ? 'badge-success' : p.level >= 4 ? 'badge-info' : 'badge';
            const sc = p.scope ? DB.getScope(p.scope) : null;
            const scopeBadge = sc
              ? `<span class="badge" style="background:${escapeHtml(sc.badgeBg)};color:${escapeHtml(sc.badgeColor)};font-size:10.5px">${escapeHtml(sc.label)}</span>`
              : '<span class="muted-2" style="font-size:11px">—</span>';
            return `<tr>
              <td><code style="font-size:11.5px;font-weight:600">${escapeHtml(p.id)}</code></td>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td>${scopeBadge}</td>
              <td class="num"><span class="badge ${lvBadge}" style="min-width:32px;font-weight:700">${p.level || '—'}</span></td>
              <td class="num">${p.minSalary ? fmt.money(p.minSalary) : '<span class="muted-2">—</span>'}</td>
              <td class="num">${p.maxSalary ? fmt.money(p.maxSalary) : '<span class="muted-2">—</span>'}</td>
              <td class="num"><strong>${fmt.num(count)}</strong><span class="muted-2" style="font-size:11px"> คน</span></td>
              <td class="actions">${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openPositionForm('${p.id}')">แก้</button><button class="btn btn-ghost btn-sm" onclick="deletePosition('${p.id}')">ลบ</button>` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state" style="padding:40px 20px">
        <div style="font-size:32px;margin-bottom:8px;opacity:0.3">${filtered ? '🔍' : '🎖️'}</div>
        <div class="title" style="font-size:14px;font-weight:600">${filtered ? 'ไม่พบตำแหน่งที่ตรงกับตัวกรอง' : 'ยังไม่มีระดับตำแหน่ง'}</div>
        <div class="hint" style="margin-top:4px">${filtered ? 'ลองล้างตัวกรองเพื่อดูทั้งหมด' : 'กดปุ่ม + เพิ่มตำแหน่ง เพื่อเริ่ม'}</div>
      </div>`}
    </div>`;
});

function wirePositionsPage() {
  // debounce route — รวม dropdown change ติดๆ กันให้ render ครั้งเดียว
  const goPos = debounce(() => router.go('positions'), 80);
  $('#posSearch')?.addEventListener('input', (e) => {
    clearTimeout(_posSearchTimer);
    _posSearchTimer = setTimeout(() => {
      posState.search = e.target.value;
      router.go('positions');
    }, 200);
  });
  $('#posScope')?.addEventListener('change', (e)   => { posState.scope = e.target.value;   goPos(); });
  $('#posHasEmps')?.addEventListener('change', (e) => { posState.hasEmps = e.target.value; goPos(); });
}

function clearPosFilters() {
  posState.search = '';
  posState.scope = '';
  posState.hasEmps = '';
  router.go('positions');
}

// ─── จัดการสายงาน (Position Scopes) — admin/HR เพิ่ม/แก้/ลบเองได้ ───
function openScopeManager() {
  if (!requireHR()) return;
  const scopes = DB.getScopes(true); // include inactive
  // นับว่าแต่ละสายมีตำแหน่ง/ฝ่ายใช้กี่รายการ
  const posCount = new Map();
  const deptCount = new Map();
  for (const p of (DB.data.positionLevels || [])) if (p.scope) posCount.set(p.scope, (posCount.get(p.scope) || 0) + 1);
  for (const d of (DB.data.departments || []))    if (d.scope) deptCount.set(d.scope, (deptCount.get(d.scope) || 0) + 1);

  const rowsHtml = scopes.length ? scopes.map(s => {
    const pc = posCount.get(s.id) || 0;
    const dc = deptCount.get(s.id) || 0;
    const hasRefs = pc + dc > 0;
    return `<tr>
      <td><code style="font-size:11.5px;font-weight:600">${escapeHtml(s.id)}</code></td>
      <td><span class="badge" style="background:${escapeHtml(s.badgeBg)};color:${escapeHtml(s.badgeColor)};font-size:10.5px">${escapeHtml(s.label)}</span></td>
      <td class="num">${fmt.num(pc)}</td>
      <td class="num">${fmt.num(dc)}</td>
      <td>${s.active ? '<span class="badge badge-success" style="font-size:10.5px">ใช้งาน</span>' : '<span class="badge" style="font-size:10.5px">ปิด</span>'}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-sm" onclick="openScopeForm('${escapeHtml(s.id)}')">แก้</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteScope('${escapeHtml(s.id)}')" ${hasRefs ? 'disabled title="มีตำแหน่ง/ฝ่ายใช้อยู่ — ปิด active แทน"' : ''}>ลบ</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="muted-2" style="text-align:center;padding:24px">ยังไม่มีสายงาน — กด "+ เพิ่มสาย" เพื่อสร้าง</td></tr>`;

  modal.open('จัดการสายงาน (Position Scopes)', `
    <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <div class="muted-2" style="font-size:12.5px">ใช้แบ่งกลุ่มตำแหน่งและฝ่าย เพื่อให้ dropdown ในฟอร์มกรองได้ตามสาย เช่น Operation / Office / SCM</div>
      <button class="btn btn-primary btn-sm" onclick="openScopeForm()">+ เพิ่มสาย</button>
    </div>
    <div class="table-wrap"><table class="table table-compact">
      <thead><tr><th>รหัส</th><th>ชื่อ</th><th class="num">ตำแหน่ง</th><th class="num">ฝ่าย</th><th>สถานะ</th><th></th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>
    <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ปิด</button></div>
  `);
}

function openScopeForm(id = null) {
  if (!requireHR()) return;
  const s = id ? DB.getScope(id) : { id: '', label: '', badgeBg: 'rgba(148,163,184,0.15)', badgeColor: '#475569', sortOrder: 100, active: true, note: '' };
  if (id && !s) return toast('ไม่พบสายงาน', 'error');
  // preset สีให้เลือก
  const presets = [
    { name: 'ส้ม (Operation)',  bg: 'rgba(245,158,11,0.15)', color: '#b45309' },
    { name: 'น้ำเงิน (Office)', bg: 'rgba(30,136,229,0.15)', color: '#1565c0' },
    { name: 'ม่วง (SCM)',       bg: 'rgba(124,58,237,0.15)', color: '#6d28d9' },
    { name: 'เขียว',             bg: 'rgba(16,185,129,0.15)', color: '#047857' },
    { name: 'แดง',               bg: 'rgba(239,68,68,0.15)',  color: '#b91c1c' },
    { name: 'ชมพู',              bg: 'rgba(236,72,153,0.15)', color: '#be185d' },
    { name: 'ฟ้าคราม',           bg: 'rgba(14,165,233,0.15)', color: '#0369a1' },
    { name: 'เทา',               bg: 'rgba(148,163,184,0.15)', color: '#475569' }
  ];
  const presetHtml = presets.map(p =>
    `<button type="button" class="btn btn-ghost btn-sm" style="padding:4px 10px" onclick="document.getElementById('scopeBadgeBg').value='${p.bg}';document.getElementById('scopeBadgeColor').value='${p.color}';document.getElementById('scopePreview').style.background='${p.bg}';document.getElementById('scopePreview').style.color='${p.color}'">${escapeHtml(p.name)}</button>`
  ).join(' ');

  modal.open(id ? 'แก้ไขสายงาน' : 'เพิ่มสายงาน', `
    <form id="scopeForm">
      <div class="form-grid">
        <div class="form-group"><label>รหัส * <span class="muted-2" style="font-weight:normal;font-size:11px">(a-z, 0-9, _, -)</span></label>
          <input name="id" value="${escapeHtml(s.id)}" required pattern="[a-z0-9_-]+" maxlength="20" ${id ? 'readonly' : 'placeholder="เช่น scm, marketing, it"'}/></div>
        <div class="form-group"><label>ชื่อแสดง *</label>
          <input name="label" id="scopeLabel" value="${escapeHtml(s.label)}" required placeholder="เช่น Supply Chain (SCM)"/></div>
        <div class="form-group span-2"><label>ตัวอย่าง badge</label>
          <div><span id="scopePreview" class="badge" style="background:${escapeHtml(s.badgeBg)};color:${escapeHtml(s.badgeColor)};font-size:10.5px;padding:4px 10px">${escapeHtml(s.label || 'ตัวอย่าง')}</span></div>
        </div>
        <div class="form-group span-2"><label>สี preset</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${presetHtml}</div>
        </div>
        <div class="form-group"><label>Badge background</label>
          <input name="badgeBg" id="scopeBadgeBg" value="${escapeHtml(s.badgeBg)}"/></div>
        <div class="form-group"><label>Badge color</label>
          <input name="badgeColor" id="scopeBadgeColor" value="${escapeHtml(s.badgeColor)}"/></div>
        <div class="form-group"><label>ลำดับการแสดง</label>
          <input name="sortOrder" type="number" min="0" value="${s.sortOrder}"/></div>
        <div class="form-group"><label><input type="checkbox" name="active" ${s.active ? 'checked' : ''}/> ใช้งาน (active)</label>
          <div class="muted-2" style="font-size:11.5px;margin-top:4px">ปิด active = ซ่อนจาก dropdown แต่ยังเก็บ data เดิม</div>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>`);
  // live preview เมื่อพิมพ์ label
  $('#scopeLabel')?.addEventListener('input', (e) => {
    const prev = $('#scopePreview');
    if (prev) prev.textContent = e.target.value || 'ตัวอย่าง';
  });
  $('#scopeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.active = data.active === 'on';
      data.sortOrder = Number(data.sortOrder);
      await DB.saveScope(data);
      modal.close();
      toast('บันทึกแล้ว', 'success');
      openScopeManager(); // เปิด list ใหม่
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteScope(id) {
  if (!requireHR()) return;
  const s = DB.getScope(id);
  if (!s) return;
  if (!await modal.confirm('ลบสายงาน', `ต้องการลบสาย "${s.label}" ใช่หรือไม่?`)) return;
  try {
    await DB.deleteScope(id);
    toast('ลบแล้ว', 'success');
    openScopeManager(); // เปิด list ใหม่
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

function openPositionForm(id = null) {
  if (!requireHR()) return;
  const p = id ? DB.getPosition(id) : { id: DB.nextPositionId(), name: '', level: 1, minSalary: 0, maxSalary: 0, scope: '' };
  modal.open(id ? 'แก้ไขตำแหน่ง' : 'เพิ่มตำแหน่ง', `
    <form id="posForm">
      <div class="form-grid">
        <div class="form-group"><label>รหัส *</label><input name="id" value="${escapeHtml(p.id)}" required ${id ? 'readonly' : ''}/></div>
        <div class="form-group"><label>ชื่อตำแหน่ง *</label><input name="name" value="${escapeHtml(p.name)}" required placeholder="เช่น Senior Head Chef"/></div>
        <div class="form-group span-2"><label>สาย <span class="muted-2" style="font-weight:normal;font-size:11px">(ใช้กับฝ่ายแบบไหน — จะ filter dropdown ในฟอร์มเพิ่มพนักงาน) · <a href="#" onclick="event.preventDefault();modal.close();openScopeManager()">⚙️ จัดการสาย</a></span></label>
          <select name="scope">
            <option value="" ${!p.scope ? 'selected' : ''}>— ไม่ระบุ (ใช้ได้ทุกฝ่าย) —</option>
            ${DB.getScopes().map(s => `<option value="${escapeHtml(s.id)}" ${p.scope === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
          </select>
        </div>
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
      const saved = await DB.savePosition(data);
      modal.close();
      // ถ้า rename แล้ว cascade sync — แจ้งจำนวนพนักงานที่ตามมาด้วย
      const synced = saved?._syncedCount || 0;
      toast(synced ? `บันทึกแล้ว · ซิงค์ตำแหน่งของพนักงาน ${synced} คนให้ตรงกับชื่อใหม่` : 'บันทึกแล้ว', 'success');
      router.go('positions');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}


async function deletePosition(id) {
  if (!requireHR()) return;
  const p = DB.getPosition(id);
  if (!await modal.confirm('ลบระดับ', `ต้องการลบระดับ "${p.name}" ใช่หรือไม่?`)) return;
  try {
    const result = await DB.deletePosition(id);
    if (!result) toast('ลบไม่ได้ เพราะยังมีพนักงานใช้ระดับนี้', 'error');
    else { toast('ลบแล้ว', 'success'); router.go('positions'); }
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: RECRUIT (รับสมัครงาน)
// ═══════════════════════════════════════════════════════
const APPL_STATUS = {
  new:         { label: 'สมัครใหม่',         badge: 'badge-info',     dot: 'amber' },
  screening:   { label: 'นัดสัมภาษณ์',        badge: 'badge-warning',  dot: 'amber' },
  interviewed: { label: 'สัมภาษณ์แล้ว',       badge: 'badge-info',     dot: 'amber' },
  passed:      { label: 'ผ่านการคัดเลือก',    badge: 'badge-success',  dot: 'green' },
  rejected:    { label: 'ไม่ผ่าน',            badge: 'badge-danger',   dot: 'red'   },
  hired:       { label: 'รับเข้าทำงาน',       badge: 'badge-success',  dot: 'green' }
};
const APPL_SOURCES = ['Walk-in', 'JobsDB', 'LINE', 'Facebook', 'แนะนำ', 'อื่นๆ'];

const recruitState = { search: '', status: '', year: '', page: 1, pageSize: 50 };

router.register('recruit', () => {
  const stats = DB.getApplicantStats();
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">รับสมัครงาน</div>
        <div class="sw-page-subtitle">จัดการผู้สมัคร · ติดตามสถานะ · รับเข้าทำงาน</div>
      </div>
      <div class="sw-page-actions">
        ${DB.isHR ? `
          <button class="btn btn-secondary" onclick="openImportApplicants()">${ICON.upload}นำเข้า Excel</button>
          <button class="btn btn-secondary" onclick="exportApplicantsXLSX()">${ICON.download}ส่งออก Excel</button>
          <button class="btn btn-primary" onclick="openApplicantForm()">+ เพิ่มผู้สมัคร</button>
        ` : ''}
      </div>
    </div>

    <div class="sw-stats-grid">
      <div class="sw-stat-card sw-accent-primary">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></div>
        <div class="sw-stat-label">ผู้สมัครเดือนนี้</div>
        <div class="sw-stat-value">${fmt.num(stats.newThisMonth)}</div>
        <div class="sw-stat-change">ทั้งหมดในระบบ ${fmt.num(stats.total)} คน</div>
      </div>
      <div class="sw-stat-card sw-accent-amber">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
        <div class="sw-stat-label">รอสัมภาษณ์</div>
        <div class="sw-stat-value" style="color:var(--warning)">${fmt.num(stats.pendingInterview)}</div>
        <div class="sw-stat-change">สัมภาษณ์แล้ว ${fmt.num(stats.interviewed)} · ผ่าน ${fmt.num(stats.passed)}</div>
      </div>
      <div class="sw-stat-card sw-accent-green">
        <div class="sw-stat-icon">${ICON.trendUp}</div>
        <div class="sw-stat-label">รับเข้าทำงานปีนี้</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(stats.hiredYTD)}</div>
        <div class="sw-stat-change">ไม่ผ่าน ${fmt.num(stats.rejected)} คน</div>
      </div>
      <div class="sw-stat-card sw-accent-red">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg></div>
        <div class="sw-stat-label">Conversion Rate</div>
        <div class="sw-stat-value">${stats.total ? ((stats.hiredYTD / stats.total) * 100).toFixed(1) : '0.0'}%</div>
        <div class="sw-stat-change">รับเข้า / ผู้สมัครทั้งหมด</div>
      </div>
    </div>

    <div class="sw-chart-card" style="margin-top:24px">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายชื่อผู้สมัคร</div>
          <div class="sw-chart-sub">ค้นหา · กรองตามสถานะ · คลิก "ดู" เพื่อดูใบสมัครเต็ม</div>
        </div>
      </div>
      <div class="sw-filter-bar">
        <input id="applSearch" type="text" class="sw-filter-input" placeholder="🔍 ค้นชื่อ / เบอร์โทร / อีเมล / ตำแหน่ง" value="${escapeHtml(recruitState.search)}"/>
        <select id="applStatus" class="sw-filter-select">
          <option value="">— ทุกสถานะ —</option>
          ${Object.entries(APPL_STATUS).map(([k, v]) => `<option value="${k}" ${recruitState.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <select id="applYear" class="sw-filter-select">
          ${(() => {
            const todayYear = new Date().getFullYear();
            const yearsWithData = new Set((DB.data.applicants || []).map(a => String(a.appliedDate || '').slice(0, 4)).filter(Boolean));
            for (let y = todayYear - 3; y <= todayYear + 1; y++) yearsWithData.add(String(y));
            const years = Array.from(yearsWithData).filter(Boolean).sort((a, b) => Number(b) - Number(a));
            return `<option value="">— ทุกปี —</option>` +
              years.map(y => `<option value="${y}" ${recruitState.year === y ? 'selected' : ''}>ปี ${Number(y) + 543}${Number(y) === todayYear ? ' (ปัจจุบัน)' : ''}</option>`).join('');
          })()}
        </select>
        <button id="applClearFilter" class="btn btn-ghost btn-sm sw-filter-clear" onclick="clearRecruitFilters()" style="${(recruitState.search || recruitState.status || recruitState.year) ? '' : 'display:none'}">✕ ล้างตัวกรอง</button>
      </div>
      <div id="applList"></div>
    </div>
  `;
});

// Toggle visibility ของปุ่ม clear filter ในหน้ารับสมัคร
function updateRecruitClearButton() {
  const btn = document.getElementById('applClearFilter');
  if (!btn) return;
  const hasFilters = recruitState.search || recruitState.status || recruitState.year;
  btn.style.display = hasFilters ? '' : 'none';
}

// ล้างตัวกรองหน้ารับสมัครงาน
function clearRecruitFilters() {
  recruitState.search = '';
  recruitState.status = '';
  recruitState.year = '';
  recruitState.page = 1;
  const searchEl = document.getElementById('applSearch');
  const statusEl = document.getElementById('applStatus');
  const yearEl = document.getElementById('applYear');
  if (searchEl) searchEl.value = '';
  if (statusEl) statusEl.value = '';
  if (yearEl) yearEl.value = '';
  renderApplicantList();
  updateRecruitClearButton();
}

function wireRecruitPage() {
  renderApplicantList();
  $('#applSearch')?.addEventListener('input', (e) => {
    clearTimeout(window._applSearchTimer);
    window._applSearchTimer = setTimeout(() => {
      recruitState.search = e.target.value;
      recruitState.page = 1;
      renderApplicantList();
      updateRecruitClearButton();
    }, 200);
  });
  $('#applStatus')?.addEventListener('change', (e) => {
    recruitState.status = e.target.value;
    recruitState.page = 1;
    renderApplicantList();
    updateRecruitClearButton();
  });
  $('#applYear')?.addEventListener('change', (e) => {
    recruitState.year = e.target.value;
    recruitState.page = 1;
    renderApplicantList();
    updateRecruitClearButton();
  });
}

function renderApplicantList() {
  const list = DB.getApplicants(recruitState);
  const container = $('#applList');
  if (!container) return;
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><div class="icon">${ICON.users}</div><div class="title">ไม่พบผู้สมัคร</div><div class="hint">ลองเปลี่ยนตัวกรอง หรือเพิ่มผู้สมัครใหม่</div></div>`;
    return;
  }
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table table-compact">
        <thead>
          <tr>
            <th>ชื่อ-สกุล</th>
            <th>ติดต่อ</th>
            <th>ตำแหน่ง / สาขา</th>
            <th class="num">เงินเดือนที่ขอ</th>
            <th>ช่องทาง</th>
            <th>วันสมัคร</th>
            <th>สถานะ</th>
            <th>จัดชุด</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${list.map(a => {
            const s = APPL_STATUS[a.status] || APPL_STATUS.new;
            const pos = a.positionTitle || (DB.getPosition(a.position)?.name || '-');
            const uniReq = DB.getUniformRequestByApplicant(a.id);
            const uniStatus = uniReq ? (UNIFORM_STATUS[uniReq.status] || UNIFORM_STATUS.pending) : null;
            const uniCell = uniReq
              ? `<button class="btn btn-ghost btn-sm" style="padding:2px 8px" onclick="openUniformRequestForm('${uniReq.id}')" title="คลิกเพื่อดู/แก้ไขคำขอจัดชุด"><span class="badge ${uniStatus.cls}">${uniStatus.label}</span></button>`
              : `<span class="muted-2" style="font-size:12px">—</span>`;
            return `
              <tr>
                <td>
                  <div style="font-weight:600">${escapeHtml(a.firstName + ' ' + (a.lastName || ''))}</div>
                  ${a.nickname ? `<div class="muted-2" style="font-size:12px">(${escapeHtml(a.nickname)})</div>` : ''}
                </td>
                <td>
                  ${a.phone ? `<div style="font-size:13px">${escapeHtml(a.phone)}</div>` : ''}
                  ${a.email ? `<div class="muted-2" style="font-size:12px">${escapeHtml(a.email)}</div>` : ''}
                </td>
                <td>
                  <div>${escapeHtml(pos)}</div>
                  ${a.branch ? `<div class="muted-2" style="font-size:12px">${escapeHtml(a.branch)}</div>` : ''}
                </td>
                <td class="num">${a.expectedSalary ? fmt.money(a.expectedSalary) : '-'}</td>
                <td>${escapeHtml(a.source || '-')}</td>
                <td>${fmt.date(a.appliedDate)}</td>
                <td><span class="badge ${s.badge}">${s.label}</span></td>
                <td>${uniCell}</td>
                <td class="actions">
                  ${DB.isHR && a.status !== 'hired' ? `<button class="btn btn-primary btn-sm" onclick="hireApplicant('${a.id}')" title="สร้างเป็นพนักงาน">รับเข้า</button>` : ''}
                  ${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openApplicantForm('${a.id}')">แก้ไข</button>
                  <button class="btn btn-ghost btn-sm" onclick="deleteApplicant('${a.id}')">ลบ</button>` : ''}
                  ${a.hiredEmployeeId ? `<button class="btn btn-ghost btn-sm" onclick="viewEmployee('${a.hiredEmployeeId}')" title="ดูประวัติพนักงาน">ดูพนักงาน</button>` : ''}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function openApplicantForm(id = null) {
  if (!requireHR()) return;
  const a = id ? DB.getApplicant(id) : {
    firstName: '', lastName: '', nickname: '', phone: '', email: '',
    position: '', positionTitle: '', department: '', branch: '',
    expectedSalary: 0, source: 'Walk-in', status: 'new',
    appliedDate: tz.today(), interviewDate: '', decidedDate: '', note: ''
  };
  const positions = DB.getPositions();
  const depts = DB.getDepartments();
  // ดึงคำขอจัดชุดที่มีอยู่ (ถ้าเป็น edit + มี applicant_id)
  const existingUniReq = id ? DB.getUniformRequestByApplicant(id) : null;

  modal.open(id ? 'แก้ไขข้อมูลผู้สมัคร' : 'เพิ่มผู้สมัครใหม่', `
    <form id="applForm">
      <div class="form-section">
        <h3>ข้อมูลผู้สมัคร</h3>
        <div class="form-grid">
          <div class="form-group"><label>ชื่อ *</label><input name="firstName" value="${escapeHtml(a.firstName)}" required/></div>
          <div class="form-group"><label>นามสกุล</label><input name="lastName" value="${escapeHtml(a.lastName)}"/></div>
          <div class="form-group"><label>ชื่อเล่น</label><input name="nickname" value="${escapeHtml(a.nickname)}"/></div>
          <div class="form-group"><label>ช่องทาง</label><select name="source">${APPL_SOURCES.map(s => `<option ${s === a.source ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          <div class="form-group"><label>เบอร์โทร</label><input name="phone" value="${escapeHtml(a.phone)}" placeholder="08X-XXX-XXXX"/></div>
          <div class="form-group"><label>อีเมล</label><input name="email" type="email" value="${escapeHtml(a.email)}"/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>ตำแหน่งที่สมัคร</h3>
        <div class="form-grid">
          <div class="form-group"><label>ระดับตำแหน่ง</label>
            <select name="position"><option value="">— ไม่ระบุ —</option>${positions.map(p => `<option value="${p.id}" ${a.position === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>ชื่อตำแหน่ง</label><input name="positionTitle" value="${escapeHtml(a.positionTitle)}" placeholder="เช่น Service, Chef"/></div>
          <div class="form-group"><label>ฝ่าย</label>
            <select name="department"><option value="">— ไม่ระบุ —</option>${depts.map(d => `<option value="${d.id}" ${a.department === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>สาขา</label><input name="branch" value="${escapeHtml(a.branch)}"/></div>
          <div class="form-group"><label>เงินเดือนที่ขอ</label><input name="expectedSalary" type="number" min="0" step="500" value="${a.expectedSalary || 0}"/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>สถานะการคัดเลือก</h3>
        <div class="form-grid">
          <div class="form-group"><label>สถานะ</label>
            <select name="status">${Object.entries(APPL_STATUS).map(([k, v]) => `<option value="${k}" ${a.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>วันที่สมัคร *</label><input name="appliedDate" type="date" value="${a.appliedDate || ''}" required/></div>
          <div class="form-group"><label>วันสัมภาษณ์</label><input name="interviewDate" type="date" value="${a.interviewDate || ''}"/></div>
          <div class="form-group"><label>วันตัดสินใจ</label><input name="decidedDate" type="date" value="${a.decidedDate || ''}"/></div>
          <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="3" placeholder="ข้อมูลการสัมภาษณ์, ทักษะ, ประวัติ ฯลฯ">${escapeHtml(a.note)}</textarea></div>
        </div>
      </div>

      ${(() => {
        // ─── สร้าง structured rows สำหรับการจัดชุด ───
        // ดึงประเภทชุดจาก uniform_items (active only); fallback list ถ้า master ยังว่าง
        const masterItems = DB.getUniformItems({ activeOnly: true });
        let typeNames = [...new Set(masterItems.map(i => i.name))];
        if (typeNames.length === 0) typeNames = ['เสื้อยูนิฟอร์ม', 'กางเกง', 'หมวก', 'รองเท้า', 'ผ้ากันเปื้อน'];
        const sizesByType = {};
        for (const it of masterItems) {
          if (!sizesByType[it.name]) sizesByType[it.name] = new Set();
          if (it.size) sizesByType[it.name].add(it.size);
        }
        const unitOf = (name) => {
          if (/หมวก/.test(name)) return 'ใบ';
          if (/รองเท้า/.test(name)) return 'คู่';
          if (/ผ้า/.test(name)) return 'ผืน';
          return 'ตัว';
        };
        // พยายาม parse note เดิม → preset structured rows + ส่วนเกินไป "หมายเหตุเพิ่มเติม"
        const presets = {};   // typeName → { size, qty }
        let extraNote = '';
        if (existingUniReq?.note) {
          const lines = existingUniReq.note.split('\n');
          const extraLines = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let matched = false;
            for (const tn of typeNames) {
              if (trimmed.startsWith(tn)) {
                const rest = trimmed.slice(tn.length).trim();
                // pattern: "<size> <qty>" or just "<qty>"
                const m = rest.match(/^(\S+)\s+(\d+)/) || rest.match(/^(\d+)/);
                if (m) {
                  if (m[2] != null) { presets[tn] = { size: m[1], qty: m[2] }; }
                  else { presets[tn] = { size: '', qty: m[1] }; }
                  matched = true;
                  break;
                }
              }
            }
            if (!matched) extraLines.push(trimmed);
          }
          extraNote = extraLines.join('\n');
        }

        const needChecked = existingUniReq || !id;
        return `
        <div class="form-section uni-premium">
          <div class="uni-section-head">
            <div class="uni-section-title">
              <span class="uni-section-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/></svg>
              </span>
              <div>
                <h3 style="margin:0">การจัดชุดพนักงาน</h3>
                <div class="uni-section-sub">ส่งให้ Benefit ดำเนินการจัดชุดก่อนวันเริ่มงาน</div>
              </div>
            </div>
            ${existingUniReq ? `
              <div class="uni-status-pill uni-status-${existingUniReq.status || 'pending'}">
                <span class="uni-status-dot"></span>
                ${UNIFORM_STATUS[existingUniReq.status]?.label || existingUniReq.status}
                ${existingUniReq.totalCost > 0 ? `<span class="uni-status-cost">· ${fmt.money(existingUniReq.totalCost)} บาท</span>` : ''}
              </div>
            ` : ''}
          </div>

          <label class="uni-toggle-card ${needChecked ? 'is-active' : ''}" for="needUniformChk">
            <input type="checkbox" name="needUniform" id="needUniformChk" ${needChecked ? 'checked' : ''}/>
            <span class="uni-toggle-switch"><span class="uni-toggle-thumb"></span></span>
            <div class="uni-toggle-text">
              <div class="uni-toggle-title">ต้องจัดชุดให้พนักงานใหม่</div>
              <div class="uni-toggle-desc">เปิดเพื่อระบุรายการชุด · ปิดถ้าไม่ต้องจัดให้</div>
            </div>
          </label>

          <div class="uni-collapse" id="uniCollapse" data-open="${needChecked ? '1' : '0'}">
            <div class="form-grid uni-meta-grid">
              <div class="form-group"><label>ต้องการก่อน <span class="muted-2" style="font-weight:normal;font-size:11px">(วันเริ่มงาน)</span></label><input name="uniformNeededBy" type="date" value="${existingUniReq?.neededBy || ''}"/></div>
              <div class="form-group"><label>HR ที่แจ้ง</label><input name="uniformRequestedBy" value="${escapeHtml(existingUniReq?.requestedBy || DB.profile?.name || DB.user?.email || '')}" placeholder="ชื่อ HR คนแจ้ง"/></div>
            </div>

            <div class="uni-items-block">
              <div class="uni-items-head">
                <div class="uni-items-label">รายการชุดที่ต้องจัด</div>
                <div class="uni-items-hint">กรอกจำนวนเฉพาะรายการที่ต้องการ</div>
              </div>
              <div class="uni-rows-card">
                <div class="uni-rows-header">
                  <div>ประเภทชุด</div><div>ขนาด</div><div style="text-align:center">จำนวน</div><div></div>
                </div>
                ${typeNames.map((tn, idx) => {
                  const sizes = [...(sizesByType[tn] || [])];
                  const preset = presets[tn] || {};
                  const hasQty = Number(preset.qty) > 0;
                  return `
                  <div class="uni-row ${hasQty ? 'uni-row-active' : ''}">
                    <div class="uni-row-name">${escapeHtml(tn)}</div>
                    <input type="text" class="uni-row-size" name="uniSize_${idx}" list="dl-unisize-${idx}" value="${escapeHtml(preset.size || '')}" placeholder="—" autocomplete="off"/>
                    <datalist id="dl-unisize-${idx}">${sizes.map(s => `<option value="${escapeHtml(s)}">`).join('')}</datalist>
                    <input type="number" class="uni-row-qty" name="uniQty_${idx}" min="0" value="${preset.qty || ''}" placeholder="0"/>
                    <div class="uni-row-unit">${unitOf(tn)}</div>
                  </div>`;
                }).join('')}
              </div>
            </div>

            <div class="form-grid" style="margin-top:16px">
              <div class="form-group span-2">
                <label>หมายเหตุเพิ่มเติม <span class="muted-2" style="font-weight:normal;font-size:11px">(เช่น แพ้ผ้าบางชนิด, สีพิเศษ ฯลฯ)</span></label>
                <textarea name="uniformExtraNote" rows="2" placeholder="ระบุข้อมูลพิเศษนอกเหนือจากรายการด้านบน">${escapeHtml(extraNote)}</textarea>
              </div>
            </div>
          </div>

          <style>
            /* ── PREMIUM UNIFORM SECTION ── */
            .uni-premium { padding-top: 8px; }
            .uni-section-head {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              gap: 16px;
              margin-bottom: 18px;
              padding-bottom: 16px;
              border-bottom: 1px solid var(--border);
            }
            .uni-section-title { display: flex; gap: 12px; align-items: center; }
            .uni-section-icon {
              width: 38px; height: 38px;
              display: flex; align-items: center; justify-content: center;
              background: linear-gradient(135deg, var(--primary-soft), var(--surface-2));
              color: var(--primary);
              border-radius: var(--radius);
              flex-shrink: 0;
            }
            .uni-section-icon svg { width: 20px; height: 20px; }
            .uni-premium h3 { font-size: 16px; letter-spacing: -0.01em; font-weight: 700; }
            .uni-section-sub { font-size: 12.5px; color: var(--text-3); margin-top: 2px; letter-spacing: 0.01em; }
            .uni-status-pill {
              display: inline-flex; align-items: center; gap: 8px;
              padding: 6px 14px;
              background: var(--surface-2);
              border: 1px solid var(--border);
              border-radius: var(--radius-full);
              font-size: 12px;
              font-weight: 600;
              color: var(--text-2);
              white-space: nowrap;
            }
            .uni-status-dot {
              width: 7px; height: 7px; border-radius: 50%;
              background: var(--text-3);
              box-shadow: 0 0 0 3px rgba(0,0,0,0.05);
            }
            .uni-status-pending .uni-status-dot { background: var(--warning); box-shadow: 0 0 0 3px var(--warning-soft); }
            .uni-status-preparing .uni-status-dot { background: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
            .uni-status-issued .uni-status-dot { background: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
            .uni-status-cancelled .uni-status-dot { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
            .uni-status-cost { color: var(--text-3); font-weight: 500; }

            /* ── TOGGLE CARD ── */
            .uni-toggle-card {
              display: flex; align-items: center; gap: 16px;
              padding: 16px 20px;
              background: var(--surface);
              border: 1.5px solid var(--border);
              border-radius: var(--radius-lg);
              cursor: pointer;
              transition: all 0.2s ease;
              user-select: none;
            }
            .uni-toggle-card:hover {
              border-color: var(--border-strong);
              background: var(--surface-2);
            }
            .uni-toggle-card.is-active {
              border-color: var(--primary);
              background: linear-gradient(135deg, var(--primary-soft) 0%, var(--surface) 60%);
              box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px -4px rgba(0,0,0,0.06);
            }
            .uni-toggle-card input[type="checkbox"] {
              position: absolute; opacity: 0; pointer-events: none;
            }
            .uni-toggle-switch {
              width: 44px; height: 26px;
              background: var(--border-strong);
              border-radius: var(--radius-full);
              position: relative;
              transition: background 0.25s ease;
              flex-shrink: 0;
            }
            .uni-toggle-thumb {
              position: absolute;
              top: 3px; left: 3px;
              width: 20px; height: 20px;
              background: #fff;
              border-radius: 50%;
              box-shadow: 0 2px 4px rgba(0,0,0,0.15);
              transition: transform 0.25s ease;
            }
            .uni-toggle-card.is-active .uni-toggle-switch { background: var(--primary); }
            .uni-toggle-card.is-active .uni-toggle-thumb { transform: translateX(18px); }
            .uni-toggle-title { font-weight: 600; font-size: 14.5px; color: var(--text); letter-spacing: -0.005em; }
            .uni-toggle-desc { font-size: 12px; color: var(--text-3); margin-top: 2px; }

            /* ── COLLAPSE ── */
            .uni-collapse {
              max-height: 0;
              overflow: hidden;
              opacity: 0;
              transition: max-height 0.35s ease, opacity 0.25s ease, margin-top 0.25s ease;
              margin-top: 0;
            }
            .uni-collapse[data-open="1"] {
              max-height: 2000px;
              opacity: 1;
              margin-top: 20px;
            }

            .uni-meta-grid { margin-bottom: 18px; }

            .uni-items-block { margin-top: 4px; }
            .uni-items-head {
              display: flex; justify-content: space-between; align-items: baseline;
              margin-bottom: 10px;
            }
            .uni-items-label {
              font-size: 11px; font-weight: 700;
              color: var(--text-3);
              text-transform: uppercase;
              letter-spacing: 0.14em;
            }
            .uni-items-hint { font-size: 11.5px; color: var(--text-3); }

            /* ── ITEMS TABLE ── */
            .uni-rows-card {
              background: var(--surface);
              border: 1px solid var(--border);
              border-radius: var(--radius-lg);
              overflow: hidden;
              box-shadow: 0 1px 2px rgba(0,0,0,0.02);
            }
            .uni-rows-header {
              display: grid;
              grid-template-columns: 1.6fr 1fr 110px 70px;
              gap: 16px;
              padding: 12px 20px;
              background: var(--surface-2);
              border-bottom: 1px solid var(--border);
              font-size: 10.5px;
              font-weight: 700;
              color: var(--text-3);
              text-transform: uppercase;
              letter-spacing: 0.12em;
            }
            .uni-row {
              display: grid;
              grid-template-columns: 1.6fr 1fr 110px 70px;
              gap: 16px;
              align-items: center;
              padding: 14px 20px;
              border-bottom: 1px solid var(--border);
              transition: background 0.15s ease, border-left-color 0.15s ease;
              border-left: 3px solid transparent;
            }
            .uni-row:last-child { border-bottom: none; }
            .uni-row:hover { background: var(--surface-2); }
            .uni-row-active {
              background: linear-gradient(90deg, rgba(21, 146, 63, 0.05), transparent 60%);
              border-left-color: var(--success);
            }
            .uni-row-active:hover { background: linear-gradient(90deg, rgba(21, 146, 63, 0.09), transparent 60%); }
            .uni-row-name {
              font-weight: 600;
              color: var(--text);
              font-size: 14px;
              letter-spacing: -0.005em;
            }
            .uni-row-size, .uni-row-qty {
              background: var(--surface);
              border: 1px solid var(--border);
              border-radius: var(--radius-sm);
              padding: 8px 12px;
              font-size: 13.5px;
              font-family: inherit;
              color: var(--text);
              transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
            }
            .uni-row-size { width: 100%; }
            .uni-row-qty { width: 100%; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
            .uni-row-size:focus, .uni-row-qty:focus {
              border-color: var(--primary);
              outline: none;
              background: var(--surface);
              box-shadow: 0 0 0 3px var(--primary-soft);
            }
            .uni-row-active .uni-row-qty {
              border-color: var(--success);
              color: var(--success);
              background: var(--success-soft);
            }
            .uni-row-unit {
              font-size: 12.5px;
              color: var(--text-3);
              letter-spacing: 0.02em;
            }

            /* Responsive — narrow screens */
            @media (max-width: 720px) {
              .uni-section-head { flex-direction: column; align-items: stretch; }
              .uni-rows-header, .uni-row {
                grid-template-columns: 1fr 80px 60px 50px;
                gap: 10px;
                padding: 12px 14px;
              }
              .uni-row-name { font-size: 13px; }
            }
          </style>
        </div>`;
      })()}

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>
  `, { size: 'lg' });

  // Real-time visual feedback — toggle active class เมื่อกรอกจำนวน
  document.querySelectorAll('#applForm .uni-row-qty').forEach(inp => {
    inp.addEventListener('input', () => {
      const row = inp.closest('.uni-row');
      if (row) row.classList.toggle('uni-row-active', Number(inp.value) > 0);
    });
  });

  // Premium toggle — expand/collapse uniform section
  const uniChk = document.getElementById('needUniformChk');
  const uniCard = uniChk?.closest('.uni-toggle-card');
  const uniCollapse = document.getElementById('uniCollapse');
  if (uniChk && uniCard && uniCollapse) {
    uniChk.addEventListener('change', () => {
      const on = uniChk.checked;
      uniCard.classList.toggle('is-active', on);
      uniCollapse.dataset.open = on ? '1' : '0';
    });
  }

  $('#applForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      const needUniform = data.needUniform === 'on';
      const uniformNeededBy = data.uniformNeededBy || '';
      const uniformRequestedBy = data.uniformRequestedBy || '';
      // รวบ structured rows → formatted note
      const masterItems = DB.getUniformItems({ activeOnly: true });
      let typeNames = [...new Set(masterItems.map(i => i.name))];
      if (typeNames.length === 0) typeNames = ['เสื้อยูนิฟอร์ม', 'กางเกง', 'หมวก', 'รองเท้า', 'ผ้ากันเปื้อน'];
      const unitOf = (name) => /หมวก/.test(name) ? 'ใบ' : /รองเท้า/.test(name) ? 'คู่' : /ผ้า/.test(name) ? 'ผืน' : 'ตัว';
      const lines = [];
      for (let idx = 0; idx < typeNames.length; idx++) {
        const size = (data[`uniSize_${idx}`] || '').trim();
        const qty = Number(data[`uniQty_${idx}`] || 0);
        if (qty > 0) {
          lines.push(`${typeNames[idx]}${size ? ' ' + size : ''} ${qty} ${unitOf(typeNames[idx])}`);
        }
      }
      const extraNote = (data.uniformExtraNote || '').trim();
      const uniformNote = [lines.join('\n'), extraNote].filter(Boolean).join('\n');

      // ตัด field ที่ไม่ใช่ของ applicant ออก
      delete data.needUniform; delete data.uniformNeededBy; delete data.uniformRequestedBy; delete data.uniformExtraNote;
      for (let idx = 0; idx < typeNames.length; idx++) { delete data[`uniSize_${idx}`]; delete data[`uniQty_${idx}`]; }
      data.expectedSalary = Number(data.expectedSalary || 0);
      if (id) data.id = id;
      const saved = await DB.saveApplicant(data);

      // จัดการคำขอจัดชุด — สร้าง/อัปเดต/ลบตาม checkbox
      try {
        if (needUniform) {
          const reqData = {
            applicantId: saved.id,
            employeeId: existingUniReq?.employeeId || '',  // ถ้ามี link ไว้แล้ว ก็คงไว้
            requestedBy: uniformRequestedBy,
            requestedDate: existingUniReq?.requestedDate || tz.today(),
            neededBy: uniformNeededBy,
            status: existingUniReq?.status || 'pending',
            totalCost: existingUniReq?.totalCost || 0,
            note: uniformNote
          };
          if (existingUniReq) reqData.id = existingUniReq.id;
          await DB.saveUniformRequest(reqData);
        } else if (existingUniReq) {
          // ถ้า uncheck → ลบคำขอเดิม
          await DB.deleteUniformRequest(existingUniReq.id);
        }
      } catch (uniEx) {
        console.warn('Uniform request save failed:', uniEx);
        toast('บันทึกผู้สมัครแล้ว แต่บันทึกคำขอจัดชุดล้มเหลว: ' + (uniEx.message || uniEx), 'warning');
      }

      modal.close();
      toast(id ? 'บันทึกแล้ว' : 'เพิ่มผู้สมัครแล้ว — แจ้งทีม Benefit จัดชุดแล้ว', 'success');
      router.go('recruit');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteApplicant(id) {
  if (!requireHR()) return;
  const a = DB.getApplicant(id);
  if (!a) return;
  if (!await modal.confirm('ลบผู้สมัคร', `ลบ "${a.firstName} ${a.lastName || ''}" ใช่หรือไม่?`)) return;
  try {
    await DB.deleteApplicant(id);
    toast('ลบแล้ว', 'success');
    router.go('recruit');
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// รับเข้าทำงาน — เปิด form พนักงานพร้อม pre-fill จาก applicant
// ผู้ใช้ต้องกรอกรหัสพนักงานเอง (ไม่ auto) + ตรวจ/แก้ไขฟิลด์อื่น ก่อนบันทึก
function hireApplicant(applicantId) {
  if (!requireHR()) return;
  const a = DB.getApplicant(applicantId);
  if (!a) return;

  openEmployeeForm(
    null,
    {
      fromApplicant: true,
      skipAutoId: true,  // ID ว่าง — user กรอกเอง
      firstName: a.firstName,
      lastName: a.lastName || '',
      nickname: a.nickname || '',
      phone: a.phone || '',
      email: a.email || '',
      department: a.department || (DB.getDepartments()[0]?.id || ''),
      branch: a.branch || '',
      position: a.position || (DB.getPositions()[0]?.id || ''),
      positionTitle: a.positionTitle || '',
      employeeType: 'พนักงานทดลองงาน',
      salary: Number(a.expectedSalary) || 0,
      note: `จากผู้สมัคร · ช่องทาง ${a.source || '-'}\n${a.note || ''}`.trim()
    },
    async (saved) => {
      // หลังบันทึกพนักงานสำเร็จ → อัปเดตสถานะ applicant + link uniform_request
      try {
        await DB.setApplicantStatus(applicantId, 'hired', {
          hired_employee_id: saved.id,
          decided_date: tz.today()
        });
        // Link คำขอจัดชุดที่ recruit สร้างไว้ → ไปที่ employee_id ใหม่
        let uniLinked = false;
        try {
          const linked = await DB.linkUniformRequestToEmployee(applicantId, saved.id);
          uniLinked = !!linked;
        } catch (uniEx) { console.warn('Link uniform request failed:', uniEx); }

        toast(`รับเข้าทำงานแล้ว · รหัสพนักงาน ${saved.id}${uniLinked ? ' · เชื่อมคำขอจัดชุดให้แล้ว' : ''}`, 'success');
        if (router.current === 'recruit') router.go('recruit');
      } catch (ex) {
        toast('สร้างพนักงานแล้ว แต่อัปเดตสถานะใบสมัครไม่สำเร็จ: ' + (ex.message || ex), 'warning');
      }
    }
  );
}

// ─── RECRUIT EXCEL: import / export / template ───
const APPL_IMPORT_COLUMNS = [
  'ชื่อ', 'นามสกุล', 'ชื่อเล่น', 'เบอร์โทร', 'อีเมล',
  'รหัสระดับตำแหน่ง', 'ชื่อตำแหน่ง', 'รหัสฝ่าย', 'สาขา',
  'เงินเดือนที่ขอ', 'ช่องทาง', 'สถานะ',
  'วันที่สมัคร', 'วันสัมภาษณ์', 'วันตัดสินใจ', 'หมายเหตุ'
];

// Map ไทย ↔ EN status — ยอมรับหลายรูปแบบเพื่อความยืดหยุ่นในการ import
const APPL_STATUS_TO_EN = {
  'สมัครใหม่': 'new', 'ใหม่': 'new', 'new': 'new',
  'นัดสัมภาษณ์': 'screening', 'รอสัมภาษณ์': 'screening', 'screening': 'screening',
  'สัมภาษณ์แล้ว': 'interviewed', 'interviewed': 'interviewed',
  'ผ่าน': 'passed', 'ผ่านการคัดเลือก': 'passed', 'passed': 'passed',
  'ไม่ผ่าน': 'rejected', 'ตกสัมภาษณ์': 'rejected', 'rejected': 'rejected',
  'รับเข้าทำงาน': 'hired', 'รับเข้า': 'hired', 'hired': 'hired'
};

function downloadApplicantTemplate() {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(downloadApplicantTemplate, 800); return; }

  // ตัวอย่าง 2 แถว — ครอบคลุมหลายสถานะ
  const sample = [
    {
      'ชื่อ': 'สมชาย', 'นามสกุล': 'ใจดี', 'ชื่อเล่น': 'ชาย',
      'เบอร์โทร': '081-234-5678', 'อีเมล': 'somchai@example.com',
      'รหัสระดับตำแหน่ง': 'P03', 'ชื่อตำแหน่ง': 'Service',
      'รหัสฝ่าย': 'D001', 'สาขา': 'สาขาหลัก',
      'เงินเดือนที่ขอ': 15000, 'ช่องทาง': 'Walk-in', 'สถานะ': 'สมัครใหม่',
      'วันที่สมัคร': '15/05/2026', 'วันสัมภาษณ์': '', 'วันตัดสินใจ': '',
      'หมายเหตุ': 'มีประสบการณ์ร้านอาหาร 2 ปี'
    },
    {
      'ชื่อ': 'สุดา', 'นามสกุล': 'มีฝีมือ', 'ชื่อเล่น': 'ดา',
      'เบอร์โทร': '089-876-5432', 'อีเมล': 'suda@example.com',
      'รหัสระดับตำแหน่ง': 'P05', 'ชื่อตำแหน่ง': 'Chef',
      'รหัสฝ่าย': 'D002', 'สาขา': 'สาขาเซ็นทรัล',
      'เงินเดือนที่ขอ': 22000, 'ช่องทาง': 'JobsDB', 'สถานะ': 'นัดสัมภาษณ์',
      'วันที่สมัคร': '10/05/2026', 'วันสัมภาษณ์': '20/05/2026', 'วันตัดสินใจ': '',
      'หมายเหตุ': ''
    }
  ];
  const ws = XLSX.utils.json_to_sheet(sample, { header: APPL_IMPORT_COLUMNS });
  ws['!cols'] = APPL_IMPORT_COLUMNS.map(k => ({ wch: Math.max(k.length + 2, 14) }));

  // Sheet "คำแนะนำ" — ครอบคลุมรูปแบบและ valid values
  const depts = DB.getDepartments().map(d => `${d.id} = ${d.name}`).join('\n');
  const positions = DB.getPositions().map(p => `${p.id} = ${p.name}`).join('\n');
  const notes = [
    ['คำแนะนำการกรอกข้อมูลผู้สมัครงาน'],
    [''],
    ['ฟิลด์ที่จำเป็น:'],
    ['• ชื่อ — ต้องมีอย่างน้อย'],
    ['• วันที่สมัคร — ถ้าไม่ระบุ ระบบใส่วันนี้ให้อัตโนมัติ'],
    [''],
    ['รูปแบบวันที่:'],
    ['• DD/MM/YYYY  เช่น 15/05/2026  หรือ 15/05/2569 (พ.ศ.)'],
    ['• YYYY-MM-DD  เช่น 2026-05-15  (ISO standard)'],
    ['• Excel Date cell (ฟอร์แมตเป็นวันที่ใน Excel)'],
    ['• ปี พ.ศ. (>2400) → ระบบแปลงเป็น ค.ศ. อัตโนมัติ'],
    [''],
    ['สถานะที่รองรับ:'],
    ['• สมัครใหม่ — เพิ่งรับใบสมัคร (default)'],
    ['• นัดสัมภาษณ์ — กำหนดวันสัมภาษณ์แล้ว'],
    ['• สัมภาษณ์แล้ว — รอตัดสินใจ'],
    ['• ผ่าน — ผ่านการคัดเลือก รอเริ่มงาน'],
    ['• ไม่ผ่าน — ตกการคัดเลือก'],
    ['• รับเข้าทำงาน — เป็นพนักงานแล้ว'],
    [''],
    ['ช่องทางที่แนะนำ:'],
    ['• Walk-in, JobsDB, LINE, Facebook, แนะนำ, อื่นๆ'],
    ['• พิมพ์อื่นๆ ได้ (ระบบเก็บเป็น text)'],
    [''],
    ['รหัสฝ่ายที่มีในระบบ:'],
    ...depts.split('\n').map(s => ['• ' + s]),
    [''],
    ['รหัสระดับตำแหน่งที่มีในระบบ:'],
    ...positions.split('\n').map(s => ['• ' + s]),
    [''],
    ['การ Import:'],
    ['• ระบบจะ INSERT เป็น record ใหม่ทุกแถว — ไม่ overwrite ของเดิม'],
    ['• ถ้าผู้สมัครซ้ำ ค่อยลบในระบบทีหลัง'],
    ['• ห้ามใส่ข้อมูลใน sheet "คำแนะนำ" — กรอกแค่ sheet "ผู้สมัคร"']
  ];
  const wsNotes = XLSX.utils.aoa_to_sheet(notes);
  wsNotes['!cols'] = [{ wch: 80 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ผู้สมัคร');
  XLSX.utils.book_append_sheet(wb, wsNotes, 'คำแนะนำ');
  XLSX.writeFile(wb, 'template-คชา-นำเข้าผู้สมัคร.xlsx');
  toast('ดาวน์โหลด template แล้ว', 'success');
}

function exportApplicantsXLSX() {
  if (!requireHR()) return; // 🔒 ข้อมูลผู้สมัคร — ส่วนตัว + เงินเดือนที่ขอ
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportApplicantsXLSX, 800); return; }
  const list = DB.getApplicants();
  if (!list.length) { toast('ยังไม่มีข้อมูลผู้สมัคร', 'warning'); return; }
  const cs = csvSafe;
  const statusToTH = Object.fromEntries(Object.entries(APPL_STATUS).map(([k, v]) => [k, v.label]));

  // Cell types ออกแบบให้ Excel formula ทำงานได้ครบ:
  //   • text fields (ชื่อ/อีเมล/รหัสฝ่าย/รหัสตำแหน่ง) → string (cell type 's')
  //   • เงินเดือน → number (SUM/AVG/SUMIF ทำงานได้)
  //   • วันที่ → Date object + cellDates:true → Excel date (DATEDIF/MONTH/YEAR ใช้ได้)
  //   • รหัสพนักงาน → number (ตรง type กับ employee export → VLOOKUP ข้ามไฟล์ได้)
  //   • เบอร์โทร → string เสมอ (คงเลข 0 นำหน้า + รองรับขีด)
  const rows = list.map(a => ({
    'ชื่อ': cs(a.firstName), 'นามสกุล': cs(a.lastName), 'ชื่อเล่น': cs(a.nickname),
    'เบอร์โทร': cs(a.phone), 'อีเมล': cs(a.email),
    'รหัสระดับตำแหน่ง': cs(a.position), 'ชื่อตำแหน่ง': cs(a.positionTitle || (DB.getPosition(a.position)?.name || '')),
    'รหัสฝ่าย': cs(a.department), 'สาขา': cs(a.branch),
    'เงินเดือนที่ขอ': Number(a.expectedSalary || 0),
    'ช่องทาง': cs(a.source), 'สถานะ': statusToTH[a.status] || a.status,
    'วันที่สมัคร': excelDate(a.appliedDate),
    'วันสัมภาษณ์': excelDate(a.interviewDate),
    'วันตัดสินใจ': excelDate(a.decidedDate),
    'หมายเหตุ': cs(a.note),
    // ใช้ excelNum เพื่อ match employee export — VLOOKUP ระหว่าง 2 ไฟล์จะใช้งานได้
    'รหัสพนักงาน (ถ้ารับเข้าแล้ว)': excelNum(a.hiredEmployeeId)
  }));
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  const headerKeys = Object.keys(rows[0]);

  // Number formats: เงินเดือน = #,##0 ; รหัสพนักงาน = 0 (กัน scientific notation)
  const salaryIdx = headerKeys.indexOf('เงินเดือนที่ขอ');
  if (salaryIdx >= 0) setColumnFormat(ws, salaryIdx, '#,##0');
  const empIdIdx = headerKeys.indexOf('รหัสพนักงาน (ถ้ารับเข้าแล้ว)');
  if (empIdIdx >= 0) setColumnFormat(ws, empIdIdx, '0');

  ws['!cols'] = headerKeys.map(k => {
    if (k.includes('วัน')) return { wch: 13 };
    if (k === 'ชื่อ' || k === 'นามสกุล') return { wch: 14 };
    if (k === 'หมายเหตุ') return { wch: 30 };
    if (k === 'เงินเดือนที่ขอ') return { wch: 14 };
    if (k === 'รหัสพนักงาน (ถ้ารับเข้าแล้ว)') return { wch: 16 };
    return { wch: 14 };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ผู้สมัคร');
  XLSX.writeFile(wb, `คชา-ผู้สมัครงาน-${tz.today()}.xlsx`);
  toast('ส่งออกไฟล์ Excel แล้ว', 'success');
}

function parseImportApplicantRow(row) {
  const get = (k) => (row[k] == null ? '' : String(row[k])).trim();
  const num = (k) => Number(row[k]) || 0;
  const parseDate = (k) => {
    const v = row[k];
    if (!v) return '';
    if (v instanceof Date) return v.toLocaleDateString('en-CA', { timeZone: TZ });
    const s = String(v).trim();
    if (!s) return '';
    const yToCE = (y) => (y >= 2400 ? y - 543 : y);
    const pad = (n) => String(n).padStart(2, '0');
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
    if (m) return `${yToCE(+m[1])}-${pad(+m[2])}-${pad(+m[3])}`;
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
    if (m) return `${yToCE(+m[3])}-${pad(+m[2])}-${pad(+m[1])}`;
    return s;
  };
  const statusRaw = get('สถานะ').toLowerCase();
  const status = APPL_STATUS_TO_EN[get('สถานะ')] || APPL_STATUS_TO_EN[statusRaw] || 'new';
  return {
    firstName: get('ชื่อ'),
    lastName: get('นามสกุล'),
    nickname: get('ชื่อเล่น'),
    phone: get('เบอร์โทร'),
    email: get('อีเมล'),
    position: get('รหัสระดับตำแหน่ง'),
    positionTitle: get('ชื่อตำแหน่ง'),
    department: get('รหัสฝ่าย'),
    branch: get('สาขา'),
    expectedSalary: num('เงินเดือนที่ขอ'),
    source: get('ช่องทาง') || 'Walk-in',
    status,
    appliedDate: parseDate('วันที่สมัคร') || tz.today(),
    interviewDate: parseDate('วันสัมภาษณ์'),
    decidedDate: parseDate('วันตัดสินใจ'),
    note: get('หมายเหตุ')
  };
}

function validateImportApplicantRows(rows) {
  const errors = [];
  const deptIds = new Set(DB.getDepartments().map(d => d.id));
  const posIds = new Set(DB.getPositions().map(p => p.id));
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    if (!r.firstName) errors.push({ row: rowNum, msg: 'ชื่อว่าง' });
    if (r.department && !deptIds.has(r.department))
      errors.push({ row: rowNum, msg: `รหัสฝ่ายไม่มีในระบบ: ${r.department}` });
    if (r.position && !posIds.has(r.position))
      errors.push({ row: rowNum, msg: `รหัสตำแหน่งไม่มีในระบบ: ${r.position}` });
  });
  return errors;
}

async function readApplicantExcelFile(file) {
  if (file.size > EXCEL_MAX_MB * 1024 * 1024) {
    throw new Error(`ไฟล์ใหญ่เกิน ${EXCEL_MAX_MB} MB`);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        await new Promise(r => setTimeout(r, 0));
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        const sheetName = wb.SheetNames.find(n => n.includes('ผู้สมัคร')) || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        await new Promise(r => setTimeout(r, 0));
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        resolve(rows.map(parseImportApplicantRow));
      } catch (ex) { reject(ex); }
    };
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsArrayBuffer(file);
  });
}

function openImportApplicants() {
  if (!requireHR()) return;
  modal.open('นำเข้าผู้สมัครงาน (Excel)', `
    <div class="import-flow">
      <div class="import-step">
        <div class="import-step-num">1</div>
        <div class="import-step-body">
          <div class="import-step-title">ดาวน์โหลด Template</div>
          <div class="muted-2" style="font-size:13px;margin-bottom:8px">ใช้ template เพื่อให้ข้อมูลครบและถูกรูปแบบ มีคำแนะนำในไฟล์ด้วย</div>
          <button class="btn btn-secondary btn-sm" onclick="downloadApplicantTemplate()">${ICON.download}ดาวน์โหลด Template</button>
        </div>
      </div>
      <div class="import-step">
        <div class="import-step-num">2</div>
        <div class="import-step-body">
          <div class="import-step-title">เลือกไฟล์ Excel ที่กรอกแล้ว</div>
          <input type="file" accept=".xlsx,.xls,.csv" id="applImportFile" class="import-file">
        </div>
      </div>
      <div id="applImportBody"></div>
    </div>
  `, {
    size: 'lg',
    footer: `<button class="btn btn-secondary" data-close>ปิด</button><button class="btn btn-primary" id="applImportStartBtn" disabled>เริ่มนำเข้า</button>`
  });

  let parsedRows = null;
  let validationErrors = [];

  $('#applImportFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#applImportBody').innerHTML = '<div class="muted-2 mt-4">กำลังอ่านไฟล์...</div>';
    try {
      parsedRows = await readApplicantExcelFile(file);
      validationErrors = validateImportApplicantRows(parsedRows);
      $('#applImportBody').innerHTML = renderApplicantImportPreview(parsedRows, validationErrors);
      $('#applImportStartBtn').disabled = validationErrors.length > 0 || parsedRows.length === 0;
    } catch (ex) {
      $('#applImportBody').innerHTML = `<div class="card mt-4" style="border-color:var(--danger);color:var(--danger)">อ่านไฟล์ไม่สำเร็จ: ${escapeHtml(ex.message)}</div>`;
      $('#applImportStartBtn').disabled = true;
    }
  });

  $('#applImportStartBtn').addEventListener('click', async () => {
    if (!parsedRows || !parsedRows.length) return;
    $('#applImportStartBtn').disabled = true;
    $('#applImportBody').innerHTML = `
      <div class="card mt-4">
        <div style="margin-bottom:10px">กำลังนำเข้า <strong id="applProgressText">0</strong> / <strong>${parsedRows.length.toLocaleString()}</strong></div>
        <div class="progress-bar"><div class="progress-fill" id="applProgressFill" style="width:0%"></div></div>
      </div>
    `;
    const start = performance.now();
    const result = await DB.bulkInsertApplicants(parsedRows, (done, total) => {
      const pct = (done / total) * 100;
      const fill = $('#applProgressFill');
      const text = $('#applProgressText');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = done.toLocaleString();
    });
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);

    $('#applImportBody').innerHTML = `
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
    parsedRows = null;
    const finishBtn = $('#applImportStartBtn');
    finishBtn.textContent = 'เสร็จสิ้น';
    finishBtn.disabled = false;
    finishBtn.setAttribute('data-close', '');
    if (router.current === 'recruit') router.go('recruit');
  });
}

function renderApplicantImportPreview(rows, errors) {
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
          <strong style="color:var(--danger-text)">ข้อผิดพลาด:</strong>
          <ul style="margin-top:6px;padding-left:20px">
            ${errors.slice(0, 30).map(e => `<li>แถวที่ ${e.row}: ${escapeHtml(e.msg)}</li>`).join('')}
            ${errors.length > 30 ? `<li>... และอีก ${errors.length - 30} ข้อ</li>` : ''}
          </ul>
        </div>
      ` : ''}
      <div style="font-size:12.5px;margin-bottom:6px"><strong>ตัวอย่าง 5 แถวแรก:</strong></div>
      <div class="table-wrap">
        <table class="table" style="font-size:12.5px">
          <thead><tr><th>ชื่อ-สกุล</th><th>เบอร์</th><th>ตำแหน่ง</th><th>ช่องทาง</th><th>สถานะ</th><th>วันสมัคร</th></tr></thead>
          <tbody>
            ${sample.map(r => `<tr>
              <td>${escapeHtml((r.firstName || '') + ' ' + (r.lastName || ''))}</td>
              <td>${escapeHtml(r.phone || '-')}</td>
              <td>${escapeHtml(r.positionTitle || r.position || '-')}</td>
              <td>${escapeHtml(r.source || '-')}</td>
              <td>${escapeHtml(r.status)}</td>
              <td>${escapeHtml(r.appliedDate)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════
//  PAGE: SSO (ประกันสังคม — แจ้งเข้า / แจ้งออก)
// ═══════════════════════════════════════════════════════
const _ssoState = { tab: 'enroll' }; // 'enroll' | 'terminate'

// Cut-off date: วันเริ่มใช้ feature SSO — ระบบจะ list เฉพาะคนที่ hire_date / termination_date >= cutoff
// (เก็บใน localStorage per-browser; default = วันแรกที่เข้าหน้า SSO)
function ssoCutoff() {
  let v = localStorage.getItem('kb_sso_cutoff');
  if (!v) {
    v = tz.today();
    try { localStorage.setItem('kb_sso_cutoff', v); } catch(e) {}
  }
  return v;
}
function setSSOCutoff() {
  const current = ssoCutoff();
  modal.open('ตั้งค่าวันเริ่มใช้ระบบประกันสังคม',
    `<p style="margin-bottom:12px">ระบบจะแสดงเฉพาะพนักงานที่ <strong>วันเริ่มงาน</strong> (สำหรับแจ้งเข้า) หรือ <strong>วันพ้นสภาพ</strong> (สำหรับแจ้งออก) ตั้งแต่วันที่นี้เป็นต้นไป</p>
     <div class="form-group"><label>วันเริ่มใช้ (cut-off date) *</label>
       <input id="ssoCutoffInput" type="date" value="${current}" required/>
     </div>
     <p class="muted-2" style="font-size:12px;margin-top:10px">หมายเหตุ: ค่านี้เก็บในเครื่องนี้ (per browser) — ถ้าใช้หลายเครื่อง/หลาย user ต้องตั้งซ้ำในแต่ละที่</p>`,
    {
      footer: `<button class="btn btn-secondary" data-close>ยกเลิก</button><button class="btn btn-primary" id="ssoCutoffSave">บันทึก</button>`
    }
  );
  $('#ssoCutoffSave').addEventListener('click', () => {
    const v = $('#ssoCutoffInput').value;
    if (!v) { toast('กรุณาเลือกวันที่', 'error'); return; }
    try { localStorage.setItem('kb_sso_cutoff', v); } catch(e) {}
    modal.close();
    toast('บันทึกแล้ว', 'success');
    updateSSOBadge();
    if (router.current === 'sso') router.refresh();
  });
}

// Deadline ตามกฎหมาย:
//  enroll  = hire_date + 30 วัน (สปส.1-03)
//  terminate = วันที่ 15 ของเดือนถัดจากเดือน termination_date (สปส.6-09)
function _ssoDeadline(emp, tab) {
  if (tab === 'enroll') {
    if (!emp.hireDate) return '';
    const d = new Date(emp.hireDate); d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  }
  if (!emp.terminationDate) return '';
  const d = new Date(emp.terminationDate);
  d.setMonth(d.getMonth() + 1); d.setDate(15);
  return d.toISOString().slice(0, 10);
}

function _ssoPending(tab) {
  const today = tz.today();
  const cutoff = ssoCutoff();
  return DB.getEmployees().filter(e => {
    if (tab === 'enroll') {
      if (!e.hireDate || e.hireDate < cutoff || e.hireDate > today) return false;
      if (e.ssoEnrolledDate) return false;
      const st = DB.empStatus(e);
      return st === 'active' || st === 'pending';
    }
    if (!e.terminationDate || e.terminationDate < cutoff || e.terminationDate > today) return false;
    if (e.ssoTerminatedDate) return false;
    return DB.empStatus(e) === 'resigned';
  });
}

function _ssoOverdueCount() {
  const today = tz.today();
  const enrollOver = _ssoPending('enroll').filter(e => _ssoDeadline(e, 'enroll') < today).length;
  const terminateOver = _ssoPending('terminate').filter(e => _ssoDeadline(e, 'terminate') < today).length;
  return { enrollOver, terminateOver, total: enrollOver + terminateOver };
}

function updateSSOBadge() {
  const { total } = _ssoOverdueCount();
  const badge = document.getElementById('navBadgeSSO');
  if (!badge) return;
  if (total > 0) {
    badge.textContent = String(total);
    badge.style.display = 'inline-block';
    badge.title = `${total} คนเกินกำหนดแจ้ง สปส.`;
  } else {
    badge.style.display = 'none';
  }
}

router.register('sso', () => {
  const today = tz.today();
  const enrollList = _ssoPending('enroll');
  const terminateList = _ssoPending('terminate');
  const enrollOverdue = enrollList.filter(e => _ssoDeadline(e, 'enroll') < today).length;
  const terminateOverdue = terminateList.filter(e => _ssoDeadline(e, 'terminate') < today).length;
  const tab = _ssoState.tab;
  const list = tab === 'enroll' ? enrollList : terminateList;

  const cutoff = ssoCutoff();
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ประกันสังคม</div>
        <div class="sw-page-subtitle">แจ้งเข้า สปส.1-03 (ภายใน 30 วันจากวันเริ่มงาน) · แจ้งออก สปส.6-09 (ภายในวันที่ 15 ของเดือนถัดไป)</div>
        <div class="sw-page-subtitle" style="margin-top:6px">
          <span class="badge badge-info">เริ่มใช้ตั้งแต่ ${fmt.date(cutoff)}</span>
          ${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="setSSOCutoff()" style="margin-left:8px">เปลี่ยน</button>` : ''}
        </div>
      </div>
    </div>

    <div class="sw-stats-grid">
      <div class="sw-stat-card sw-accent-amber">
        <div class="sw-stat-icon">${ICON.users}</div>
        <div class="sw-stat-label">รอแจ้งเข้า</div>
        <div class="sw-stat-value">${fmt.num(enrollList.length)}</div>
        <div class="sw-stat-change">${enrollOverdue ? `<span style="color:var(--danger);font-weight:600">เกินกำหนด ${enrollOverdue} คน</span>` : 'ทันกำหนดทุกคน'}</div>
      </div>
      <div class="sw-stat-card sw-accent-red">
        <div class="sw-stat-icon">${ICON.clipboard}</div>
        <div class="sw-stat-label">รอแจ้งออก</div>
        <div class="sw-stat-value">${fmt.num(terminateList.length)}</div>
        <div class="sw-stat-change">${terminateOverdue ? `<span style="color:var(--danger);font-weight:600">เกินกำหนด ${terminateOverdue} คน</span>` : 'ทันกำหนดทุกคน'}</div>
      </div>
    </div>

    <div class="sw-chart-card" style="margin-top:24px">
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn btn-sm ${tab === 'enroll' ? 'btn-primary' : 'btn-secondary'}" onclick="setSSOTab('enroll')">แจ้งเข้า (${enrollList.length})</button>
        <button class="btn btn-sm ${tab === 'terminate' ? 'btn-primary' : 'btn-secondary'}" onclick="setSSOTab('terminate')">แจ้งออก (${terminateList.length})</button>
      </div>
      ${list.length ? `
        <div class="table-wrap" style="margin-top:14px">
          <table class="table table-compact">
            <thead>
              <tr>
                <th>รหัส</th>
                <th>ชื่อ-สกุล</th>
                <th>เลขประชาชน</th>
                <th>เลข สปส.</th>
                <th>${tab === 'enroll' ? 'วันเริ่มงาน' : 'วันพ้นสภาพ'}</th>
                <th>ครบกำหนด</th>
                <th>สถานะ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${list.map(e => {
                const dl = _ssoDeadline(e, tab);
                const overdue = dl && dl < today;
                const refDate = tab === 'enroll' ? e.hireDate : e.terminationDate;
                return `
                  <tr>
                    <td>${escapeHtml(e.id)}</td>
                    <td>
                      <div style="font-weight:600">${escapeHtml((e.title || '') + e.firstName + ' ' + (e.lastName || ''))}</div>
                      ${e.nickname ? `<div class="muted-2" style="font-size:12px">(${escapeHtml(e.nickname)})</div>` : ''}
                    </td>
                    <td class="mono">${escapeHtml(e.nationalId || '-')}</td>
                    <td class="mono">${escapeHtml(e.ssoNo || '-')}</td>
                    <td>${fmt.date(refDate)}</td>
                    <td>${fmt.date(dl)}</td>
                    <td>${overdue ? '<span class="badge badge-danger">เกินกำหนด</span>' : '<span class="badge badge-warning">รอแจ้ง</span>'}</td>
                    <td class="actions">
                      ${DB.isHR ? `<button class="btn btn-primary btn-sm" onclick="markSSO('${e.id}', '${tab}')">บันทึก${tab === 'enroll' ? 'แจ้งเข้า' : 'แจ้งออก'}แล้ว</button>` : ''}
                      <button class="btn btn-ghost btn-sm" onclick="viewEmployee('${e.id}')">ดู</button>
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="empty-state" style="margin-top:14px">
          <div class="icon">${ICON.users}</div>
          <div class="title">ไม่มีรายการ${tab === 'enroll' ? 'รอแจ้งเข้า' : 'รอแจ้งออก'}</div>
          <div class="hint">เมื่อมีพนักงาน${tab === 'enroll' ? 'เข้าใหม่ที่ยังไม่ได้แจ้งเข้า' : 'พ้นสภาพที่ยังไม่ได้แจ้งออก'} ระบบจะแสดงที่นี่อัตโนมัติ</div>
        </div>
      `}
    </div>
  `;
});

function setSSOTab(tab) {
  _ssoState.tab = tab;
  router.refresh();
}

async function markSSO(empId, tab) {
  if (!requireHR()) return;
  const emp = DB.getEmployee(empId);
  if (!emp) return;
  const isEnroll = tab === 'enroll';
  const today = tz.today();
  modal.open(
    isEnroll ? 'บันทึกการแจ้งเข้า สปส.' : 'บันทึกการแจ้งออก สปส.',
    `<form id="ssoMarkForm">
      <div style="margin-bottom:14px;font-size:14px">
        <strong>${escapeHtml((emp.title || '') + emp.firstName + ' ' + (emp.lastName || ''))}</strong>
        <span class="muted-2" style="margin-left:8px">รหัส ${escapeHtml(emp.id)}</span>
      </div>
      <div class="form-grid">
        <div class="form-group"><label>วันที่แจ้ง${isEnroll ? 'เข้า' : 'ออก'} *</label>
          <input name="date" type="date" value="${today}" required/>
        </div>
        ${isEnroll ? `
          <div class="form-group"><label>เลขประกันสังคม <span class="muted-2" style="font-weight:normal;font-size:11px">(ค่าเริ่มต้น: เลข ปชช.)</span></label>
            <input name="ssoNo" value="${escapeHtml(emp.ssoNo || emp.nationalId || '')}" maxlength="20"/>
          </div>
        ` : ''}
      </div>
    </form>`,
    {
      footer: `<button class="btn btn-secondary" data-close>ยกเลิก</button><button class="btn btn-primary" id="ssoMarkSubmit">บันทึก</button>`
    }
  );
  $('#ssoMarkSubmit').addEventListener('click', async () => {
    const form = $('#ssoMarkForm');
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.date) { toast('กรุณาเลือกวันที่', 'error'); return; }
    const btn = $('#ssoMarkSubmit'); btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
    try {
      const updates = { ...emp };
      if (isEnroll) {
        updates.ssoEnrolledDate = data.date;
        if (data.ssoNo) updates.ssoNo = data.ssoNo;
      } else {
        updates.ssoTerminatedDate = data.date;
      }
      await DB.saveEmployee(updates);
      modal.close();
      toast(`บันทึก${isEnroll ? 'แจ้งเข้า' : 'แจ้งออก'}เรียบร้อย`, 'success');
      updateSSOBadge();
      router.refresh();
    } catch (ex) {
      toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error');
      btn.disabled = false; btn.textContent = 'บันทึก';
    }
  });
}

// ═══════════════════════════════════════════════════════
//  PAGE: UNIFORM MANAGEMENT (จัดชุดพนักงาน)
// ═══════════════════════════════════════════════════════
const UNIFORM_STATUS = {
  pending:    { label: 'รอจัด',     cls: 'badge-warning' },
  preparing:  { label: 'กำลังเตรียม', cls: 'badge-info' },
  issued:     { label: 'จัดส่งแล้ว',  cls: 'badge-success' },
  cancelled:  { label: 'ยกเลิก',     cls: 'badge-danger' }
};
const _uniformState = { tab: 'requests', filter: '' };
const DAY_NAMES_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const DAY_NAMES_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

router.register('uniform', () => {
  const stats = DB.getUniformStats();
  const tab = _uniformState.tab;
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">จัดชุดพนักงาน</div>
        <div class="sw-page-subtitle">คำขอจัดชุด · บันทึกการจัดส่ง · stock & ราคา · ค่าชุดที่ต้องเก็บจากพนักงาน</div>
      </div>
      <div class="sw-page-actions">
        ${DB.isHR ? `
          <button class="btn btn-secondary" onclick="openUniformItemForm()">${ICON.plus}เพิ่มรายการชุด</button>
          <button class="btn btn-secondary" onclick="exportUniformIssuesXLSX()">${ICON.download}ส่งออกประวัติ</button>
          <button class="btn btn-primary" onclick="openUniformRequestForm()">+ คำขอใหม่</button>
        ` : ''}
      </div>
    </div>

    <div class="sw-stats-grid">
      <div class="sw-stat-card sw-accent-amber">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
        <div class="sw-stat-label">รอจัด</div>
        <div class="sw-stat-value" style="color:var(--warning)">${fmt.num(stats.pending)}</div>
        <div class="sw-stat-change">กำลังเตรียม ${fmt.num(stats.preparing)}</div>
      </div>
      <div class="sw-stat-card sw-accent-green">
        <div class="sw-stat-icon">${ICON.trendUp}</div>
        <div class="sw-stat-label">จัดส่งเดือนนี้</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(stats.issuedThisMonth)}</div>
        <div class="sw-stat-change">ครบทั้งหมดใน 1 เดือน</div>
      </div>
      <div class="sw-stat-card sw-accent-primary">
        <div class="sw-stat-icon">${ICON.money}</div>
        <div class="sw-stat-label">ค่าชุดรวม (สะสม)</div>
        <div class="sw-stat-value">${fmt.money(stats.totalUnpaid)}</div>
        <div class="sw-stat-change">บาท · นำไปคิดกับพนักงาน</div>
      </div>
      <div class="sw-stat-card sw-accent-red">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
        <div class="sw-stat-label">Stock ใกล้หมด</div>
        <div class="sw-stat-value" style="color:var(--danger)">${fmt.num(stats.lowStock)}</div>
        <div class="sw-stat-change">รายการที่เหลือ &lt; 5 ชิ้น</div>
      </div>
    </div>

    <div class="sw-tabs" role="tablist" style="margin-top:24px">
      <button class="sw-tab ${tab === 'requests' ? 'active' : ''}" onclick="switchUniformTab('requests')">คำขอจัดชุด</button>
      <button class="sw-tab ${tab === 'items'    ? 'active' : ''}" onclick="switchUniformTab('items')">รายการชุด · Stock</button>
      <button class="sw-tab ${tab === 'issues'   ? 'active' : ''}" onclick="switchUniformTab('issues')">ประวัติการจัดส่ง</button>
      <button class="sw-tab ${tab === 'schedule' ? 'active' : ''}" onclick="switchUniformTab('schedule')">รอบการจัดส่ง</button>
    </div>
    <div id="uniformContent">${renderUniformTab()}</div>
  `;
});

function switchUniformTab(tab) {
  _uniformState.tab = tab;
  // re-render ทั้งหน้า — update tab button states + content พร้อมกัน
  router.go('uniform');
}

function renderUniformTab() {
  const tab = _uniformState.tab;
  if (tab === 'items') return renderUniformItemsTable();
  if (tab === 'issues') return renderUniformIssuesTable();
  if (tab === 'schedule') return renderUniformScheduleTable();
  return renderUniformRequestsTable();
}

// ─── รอบการจัดส่ง — group by branch ───
function renderUniformScheduleTable() {
  const all = DB.getUniformSchedules();
  // group by branch
  const byBranch = new Map();
  for (const s of all) {
    if (!byBranch.has(s.branchCode)) byBranch.set(s.branchCode, []);
    byBranch.get(s.branchCode).push(s);
  }
  const branches = [...byBranch.keys()].sort();

  const addBtn = DB.isHR ? `<button class="btn btn-secondary btn-sm" onclick="openUniformScheduleForm()" style="margin-bottom:14px">${ICON.plus}เพิ่มรอบการจัดส่ง</button>` : '';

  if (!branches.length) {
    return `${addBtn}<div class="empty-state"><div class="title">ยังไม่มีรอบการจัดส่ง</div><div class="hint">กดปุ่ม "+ เพิ่มรอบการจัดส่ง" เพื่อกำหนดสาขา + วันส่ง</div></div>`;
  }

  return `
    ${addBtn}
    <div class="table-wrap"><table class="table table-compact">
      <thead><tr>
        <th>สาขา</th><th>วันส่ง</th><th>วันส่งถัดไป</th><th>สถานะ</th><th>หมายเหตุ</th><th></th>
      </tr></thead>
      <tbody>
        ${branches.map(branch => {
          const list = byBranch.get(branch).sort((a, b) => a.dayOfWeek - b.dayOfWeek);
          const next = DB.getNextDeliveryDate(branch);
          return list.map((s, i) => `
            <tr>
              ${i === 0 ? `<td rowspan="${list.length}" style="vertical-align:top"><strong>${escapeHtml(branch)}</strong></td>` : ''}
              <td><span class="badge badge-info">${DAY_NAMES_TH[s.dayOfWeek]}</span></td>
              ${i === 0 ? `<td rowspan="${list.length}" style="vertical-align:top">${next ? `<strong style="color:var(--success)">${fmt.date(next.date)}</strong> (${next.dayName})` : '<span class="muted-2">-</span>'}</td>` : ''}
              <td>${s.active ? '<span class="badge badge-success">ใช้งาน</span>' : '<span class="badge">ปิด</span>'}</td>
              <td>${escapeHtml(s.note || '-')}</td>
              <td class="actions">
                ${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openUniformScheduleForm('${s.id}')">แก้</button>
                <button class="btn btn-ghost btn-sm" onclick="deleteUniformSchedule('${s.id}')">ลบ</button>` : ''}
              </td>
            </tr>
          `).join('');
        }).join('')}
      </tbody>
    </table></div>
  `;
}

function openUniformScheduleForm(id = null) {
  if (!requireHR()) return;
  const s = id ? DB.getUniformSchedule(id) : { id: '', branchCode: '', dayOfWeek: 1, active: true, note: '' };
  const branches = DB.getBranches();
  modal.open(id ? 'แก้ไขรอบการจัดส่ง' : 'เพิ่มรอบการจัดส่ง', `
    <form id="uniSchedForm">
      <div class="form-grid">
        <div class="form-group"><label>สาขา *</label>
          <input name="branchCode" list="dl-branches-sched" value="${escapeHtml(s.branchCode)}" required placeholder="เช่น KMB, GE, JM" autocomplete="off"/>
          <datalist id="dl-branches-sched">${branches.map(b => `<option value="${escapeHtml(b)}">`).join('')}</datalist>
        </div>
        <div class="form-group"><label>วันส่ง *</label>
          <select name="dayOfWeek" required>
            ${DAY_NAMES_TH.map((d, i) => `<option value="${i}" ${Number(s.dayOfWeek) === i ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>สถานะ</label>
          <select name="active"><option value="true" ${s.active ? 'selected' : ''}>ใช้งาน</option><option value="false" ${!s.active ? 'selected' : ''}>ปิด</option></select>
        </div>
        <div class="form-group span-2"><label>หมายเหตุ</label><input name="note" value="${escapeHtml(s.note)}" placeholder="เช่น ส่งช่วงบ่าย, รับที่ออฟฟิศกลาง"/></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>
    <div class="muted-2" style="font-size:12px;margin-top:10px;padding:10px 14px;background:var(--surface-2);border-radius:8px">
      💡 ถ้าสาขาส่งหลายวัน เพิ่มทีละ row — ระบบจะ group ให้ในตาราง
    </div>
  `);
  $('#uniSchedForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.dayOfWeek = Number(data.dayOfWeek);
      data.active = data.active === 'true';
      if (id) data.id = id;
      await DB.saveUniformSchedule(data);
      modal.close();
      toast('บันทึกรอบการจัดส่งแล้ว', 'success');
      _uniformState.tab = 'schedule';
      router.go('uniform');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteUniformSchedule(id) {
  if (!requireHR()) return;
  const s = DB.getUniformSchedule(id);
  if (!s) return;
  if (!await modal.confirm('ลบรอบการจัดส่ง', `ลบ "${s.branchCode} · ${DAY_NAMES_TH[s.dayOfWeek]}" ใช่หรือไม่?`)) return;
  try { await DB.deleteUniformSchedule(id); toast('ลบแล้ว', 'success'); router.go('uniform'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

function renderUniformRequestsTable() {
  // แสดงเฉพาะคำขอที่ยังไม่จบ — จัดส่งแล้ว/ยกเลิก ไปดูที่ tab "ประวัติการจัดส่ง"
  const reqs = DB.getUniformRequests().filter(r => r.status !== 'issued' && r.status !== 'cancelled');
  if (!reqs.length) return `<div class="empty-state"><div class="icon">${ICON.clipboard}</div><div class="title">ไม่มีคำขอค้าง</div><div class="hint">ทุกคำขอจัดส่งครบแล้ว · ดูประวัติได้ที่ tab "ประวัติการจัดส่ง"</div></div>`;
  return `
    <div class="table-wrap"><table class="table table-compact uniform-req-table">
      <thead><tr>
        <th>วันที่แจ้ง</th><th>พนักงาน / ผู้สมัคร</th><th>สาขา</th><th>แจ้งโดย</th>
        <th>ต้องการก่อน</th><th>สถานะ</th><th class="num">ค่าชุดรวม</th><th>รายละเอียด</th><th></th>
      </tr></thead>
      <tbody>
        ${reqs.map(r => {
          const s = UNIFORM_STATUS[r.status] || UNIFORM_STATUS.pending;
          let name = '-', refBadge = '', branch = '-';
          if (r.employeeId) {
            const e = DB.getEmployee(r.employeeId) || {};
            name = (e.firstName || '') + ' ' + (e.lastName || '');
            refBadge = `<span class="badge badge-success" style="font-size:10.5px;margin-left:6px">พนักงาน ${escapeHtml(r.employeeId)}</span>`;
            branch = e.branch || '-';
          } else if (r.applicantId) {
            const ap = DB.getApplicant(r.applicantId) || {};
            name = (ap.firstName || '') + ' ' + (ap.lastName || '');
            refBadge = `<span class="badge badge-warning" style="font-size:10.5px;margin-left:6px">ผู้สมัคร</span>`;
            branch = ap.branch || '-';
          }
          return `<tr>
            <td>${fmt.date(r.requestedDate)}</td>
            <td><strong>${escapeHtml(name)}</strong>${refBadge}</td>
            <td>${escapeHtml(branch)}</td>
            <td>${escapeHtml(r.requestedBy || '-')}</td>
            <td>${r.neededBy ? fmt.date(r.neededBy) : '-'}</td>
            <td><span class="badge ${s.cls}">${s.label}</span></td>
            <td class="num"><strong>${fmt.money(r.totalCost)}</strong></td>
            <td class="note-cell">${
              (r.status === 'issued' || r.status === 'cancelled')
                ? '<div class="note-empty" style="color:var(--text-3);font-weight:normal">—</div>'
                : (r.note ? `<div class="note-clamp" title="${escapeHtml(r.note)}">${escapeHtml(r.note)}</div>` : '<div class="note-empty">⚠️ ยังไม่ระบุ</div>')
            }</td>
            <td class="actions">
              ${DB.isHR ? `<button class="btn btn-primary btn-sm" onclick="openIssueItemsForm('${r.id}')">จัดชุด</button>
              <button class="btn btn-ghost btn-sm" onclick="openUniformRequestForm('${r.id}')">แก้</button>
              <button class="btn btn-ghost btn-sm" onclick="deleteUniformRequest('${r.id}')">ลบ</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
    <style>
      .uniform-req-table { background: var(--surface); }
      .uniform-req-table tbody tr {
        background: var(--surface);
        height: 96px;  /* enforce minimum row height — most reliable across browsers */
      }
      .uniform-req-table tbody tr:hover { background: var(--surface-2); }
      .uniform-req-table td {
        vertical-align: top;
        line-height: 1.55;
        padding: 14px 12px;
        background: transparent;
      }
      .uniform-req-table td.note-cell {
        max-width: 260px;
        font-size: 12.5px;
        color: var(--text-2);
      }
      .uniform-req-table .note-clamp {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        white-space: pre-wrap;
        line-height: 1.5;
        height: calc(1.5em * 3);  /* ทุก row ความสูงเท่ากันเสมอ (fixed > min-height เพราะ -webkit-box มัก ignore min-height) */
      }
      .uniform-req-table .note-empty {
        display: flex;
        align-items: flex-start;
        height: calc(1.5em * 3);
        color: var(--warning);
        font-weight: 600;
      }
      .uniform-req-table td.actions {
        display: table-cell;  /* override global .table .actions { display: flex } เพื่อให้เส้น border-bottom ของ td render ครบทั้งแถว */
        white-space: nowrap;
        text-align: right;
      }
      .uniform-req-table td.actions .btn { vertical-align: top; }
      .uniform-req-table .badge { display: inline-block; vertical-align: baseline; }
    </style>
  `;
}

function renderUniformItemsTable() {
  const items = DB.getUniformItems();
  if (!items.length) return `<div class="empty-state"><div class="title">ยังไม่มีรายการชุด</div><div class="hint">กดปุ่ม "+ เพิ่มรายการชุด" ด้านบน</div></div>`;
  return `
    <div class="table-wrap"><table class="table table-compact">
      <thead><tr>
        <th>ชื่อชุด</th><th>ขนาด</th><th class="num">Stock</th><th class="num">ราคา/ชิ้น</th>
        <th class="num">มูลค่า Stock</th><th>สถานะ</th><th>หมายเหตุ</th><th></th>
      </tr></thead>
      <tbody>
        ${items.map(i => {
          const stockClass = Number(i.stockQty) < 5 ? 'style="color:var(--danger);font-weight:600"' : '';
          return `<tr>
            <td><strong>${escapeHtml(i.name)}</strong></td>
            <td>${escapeHtml(i.size || '-')}</td>
            <td class="num" ${stockClass}>${fmt.num(i.stockQty)}</td>
            <td class="num">${fmt.money(i.unitCost)}</td>
            <td class="num">${fmt.money(Number(i.stockQty) * Number(i.unitCost))}</td>
            <td>${i.active ? '<span class="badge badge-success">ใช้งาน</span>' : '<span class="badge">ปิด</span>'}</td>
            <td>${escapeHtml(i.note || '-')}</td>
            <td class="actions">
              ${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openUniformItemForm('${i.id}')">แก้ไข</button>
              <button class="btn btn-ghost btn-sm" onclick="deleteUniformItem('${i.id}')">ลบ</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
  `;
}

function renderUniformIssuesTable() {
  const list = DB.getUniformIssues();
  if (!list.length) return `<div class="empty-state"><div class="title">ยังไม่มีประวัติการจัดส่ง</div></div>`;
  return `
    <div class="table-wrap"><table class="table table-compact">
      <thead><tr>
        <th>วันที่จัดส่ง</th><th>พนักงาน</th><th>รายการ</th><th>ขนาด</th>
        <th class="num">จำนวน</th><th class="num">ราคา/ชิ้น</th><th class="num">รวม</th>
        <th>HR ผู้จัด</th><th>หมายเหตุ</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(i => {
          // หาเจ้าของ: ถ้ามี employeeId → ดึง employee, ถ้าไม่มี → ดึง applicant ผ่าน request
          let ownerCell = '<span class="muted-2">-</span>';
          if (i.employeeId) {
            const e = DB.getEmployee(i.employeeId);
            if (e) {
              ownerCell = `<strong>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</strong> <span class="muted-2" style="font-size:11.5px">(${escapeHtml(i.employeeId)})</span>`;
            } else {
              ownerCell = `<span class="muted-2">${escapeHtml(i.employeeId)}</span>`;
            }
          } else if (i.requestId) {
            const req = DB.getUniformRequest(i.requestId);
            if (req?.applicantId) {
              const ap = DB.getApplicant(req.applicantId);
              if (ap) {
                ownerCell = `<strong>${escapeHtml(ap.firstName + ' ' + (ap.lastName || ''))}</strong> <span class="badge badge-warning" style="font-size:10px;margin-left:6px">ผู้สมัคร</span>`;
              }
            }
          }
          return `<tr>
            <td>${fmt.date(i.issuedDate)}</td>
            <td>${ownerCell}</td>
            <td>${escapeHtml(i.itemName || '-')}</td>
            <td>${escapeHtml(i.size || '-')}</td>
            <td class="num">${fmt.num(i.qty)}</td>
            <td class="num">${fmt.money(i.unitCost)}</td>
            <td class="num"><strong>${fmt.money(i.totalCost)}</strong></td>
            <td>${escapeHtml(i.issuedBy || '-')}</td>
            <td>${escapeHtml(i.note || '-')}</td>
            <td class="actions">${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="deleteUniformIssue('${i.id}')">ลบ</button>` : ''}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
  `;
}

// ─── คำขอจัดชุด ───
function openUniformRequestForm(id = null) {
  if (!requireHR()) return;
  const r = id ? DB.getUniformRequest(id) : {
    id: '', employeeId: '', requestedBy: DB.profile?.name || DB.user?.email || '',
    requestedDate: tz.today(), neededBy: '', status: 'pending', note: ''
  };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไขคำขอจัดชุด' : 'คำขอจัดชุด (HR แจ้ง → ส่งต่อ HR จัดชุด)', `
    <form id="uniReqForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label>${employeePicker({ name: 'employeeId', emps, selected: r.employeeId, required: true })}</div>
        <div class="form-group span-2" id="uniSchedHint" style="display:none;padding:10px 14px;background:var(--success-soft);border-radius:8px;font-size:13px;color:var(--success-text);border:1px solid var(--border)"></div>
        <div class="form-group"><label>วันที่แจ้ง *</label><input name="requestedDate" type="date" value="${r.requestedDate || tz.today()}" required/></div>
        <div class="form-group"><label>ต้องการก่อน (วันเริ่มงาน) <span class="muted-2" style="font-weight:normal;font-size:11px" id="uniNeededHint"></span></label><input name="neededBy" id="uniNeededByInput" type="date" value="${r.neededBy || ''}"/></div>
        <div class="form-group"><label>แจ้งโดย</label><input name="requestedBy" value="${escapeHtml(r.requestedBy)}" placeholder="ชื่อ HR คนแจ้ง"/></div>
        <div class="form-group"><label>สถานะ</label>
          <select name="status">${Object.entries(UNIFORM_STATUS).map(([k, v]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        </div>
        <div class="form-group span-2"><label>หมายเหตุ / รายละเอียดที่ต้องการ</label><textarea name="note" rows="2" placeholder="เช่น ต้องการเสื้อ M กางเกง L หมวก 1 ใบ">${escapeHtml(r.note)}</textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>
  `);
  // เมื่อเลือกพนักงาน → แสดงข้อมูลรอบการจัดส่งของสาขานั้น + auto-suggest needed_by
  wireEmployeePickers('#uniReqForm', (emp) => {
    const hint = $('#uniSchedHint');
    const neededHint = $('#uniNeededHint');
    if (!emp.branch) {
      hint.style.display = 'none';
      if (neededHint) neededHint.textContent = '';
      return;
    }
    const schedules = DB.getUniformSchedules({ branchCode: emp.branch, activeOnly: true });
    const next = DB.getNextDeliveryDate(emp.branch);
    if (!schedules.length) {
      hint.style.display = 'block';
      hint.style.background = 'var(--warning-soft)';
      hint.style.color = 'var(--warning-text)';
      hint.innerHTML = `⚠️ สาขา <strong>${escapeHtml(emp.branch)}</strong> ยังไม่มีรอบการจัดส่ง — ตั้งค่าได้ที่แท็บ "รอบการจัดส่ง"`;
      if (neededHint) neededHint.textContent = '';
      return;
    }
    const days = schedules.map(s => DAY_NAMES_TH[s.dayOfWeek]).join(', ');
    hint.style.display = 'block';
    hint.style.background = 'var(--success-soft)';
    hint.style.color = 'var(--success-text)';
    hint.innerHTML = `🚚 สาขา <strong>${escapeHtml(emp.branch)}</strong> ส่งวัน <strong>${days}</strong>` +
      (next ? ` · รอบถัดไป <strong>${fmt.date(next.date)} (${next.dayName})</strong>` : '');
    if (neededHint && next) {
      neededHint.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" onclick="document.getElementById('uniNeededByInput').value='${next.date}'">ใส่ ${fmt.date(next.date)}</button>`;
    }
  });
  $('#uniReqForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (id) data.id = id;
      await DB.saveUniformRequest(data);
      modal.close();
      toast(id ? 'บันทึกแล้ว' : 'สร้างคำขอแล้ว — แจ้งทีมจัดชุด', 'success');
      router.go('uniform');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteUniformRequest(id) {
  if (!requireHR()) return;
  if (!await modal.confirm('ลบคำขอ', 'ลบคำขอนี้ + รายการชุดที่จัดทั้งหมด ใช่หรือไม่?')) return;
  try { await DB.deleteUniformRequest(id); toast('ลบแล้ว', 'success'); router.go('uniform'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// Mark request as issued without itemizing — สำหรับกรณีจัดส่งครบแล้วไม่ต้องลงรายการรายชิ้น
async function markUniformRequestIssued(id) {
  if (!requireHR()) return;
  const req = DB.getUniformRequest(id);
  if (!req) return;
  if (!await modal.confirm('ยืนยัน', 'ทำเครื่องหมายคำขอนี้ว่า "จัดส่งครบแล้ว" ใช่หรือไม่?\n\n— สถานะจะเปลี่ยนเป็น "จัดส่งแล้ว"\n— ถ้ายังไม่ได้ลงรายการรายชิ้น stock จะไม่ถูกตัด')) return;
  try {
    await DB.saveUniformRequest({ ...req, status: 'issued' });
    modal.close();
    toast('อัปเดตสถานะแล้ว · จัดส่งครบ', 'success');
    if (router.current === 'uniform') router.go('uniform');
  } catch (ex) { toast('อัปเดตไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ยืนยันการจัดส่ง — แสดง toast สรุปยอด + ปิด modal (ไม่แก้ข้อมูล)
function confirmIssueAndClose(requestId) {
  const req = DB.getUniformRequest(requestId);
  if (!req) { modal.close(); return; }
  let ownerName = 'พนักงาน';
  if (req.employeeId) {
    const e = DB.getEmployee(req.employeeId);
    if (e) ownerName = `${e.firstName} ${e.lastName || ''}`.trim();
  } else if (req.applicantId) {
    const ap = DB.getApplicant(req.applicantId);
    if (ap) ownerName = `${ap.firstName} ${ap.lastName || ''}`.trim();
  }
  const issues = DB.getUniformIssues({ requestId });
  toast(`✓ จัดส่งครบแล้ว · ${ownerName} · ${issues.length} รายการ · ${fmt.money(req.totalCost)} ฿`, 'success');
  modal.close();
}

// Parse บรรทัด recruit เช่น "กางเกง M 1 ตัว" → { name, size, qty, unit }
function parseUniformNoteToItems(note) {
  if (!note) return [];
  return note.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 3) return { raw: trimmed, parseable: false };
    const unit = tokens[tokens.length - 1];
    const qty = Number(tokens[tokens.length - 2]);
    if (!Number.isFinite(qty) || qty <= 0) return { raw: trimmed, parseable: false };
    let size = '';
    let nameEnd = tokens.length - 2;
    if (tokens.length >= 4) {
      size = tokens[tokens.length - 3];
      nameEnd = tokens.length - 3;
    }
    const name = tokens.slice(0, nameEnd).join(' ');
    return { raw: trimmed, name, size, qty, unit, parseable: true };
  }).filter(Boolean);
}

// match กับ stock master โดย exact name + size (case-insensitive)
function matchUniformItemFromStock(parsed, masterItems) {
  if (!parsed.parseable) return null;
  return masterItems.find(m =>
    m.active &&
    m.name === parsed.name &&
    (m.size || '').toLowerCase() === (parsed.size || '').toLowerCase()
  ) || null;
}

// กดทีเดียวสร้าง issue ทุกรายการตามที่ recruit แจ้ง
async function issueAllFromRecruit(requestId) {
  if (!requireHR()) return;
  const req = DB.getUniformRequest(requestId);
  if (!req) return;
  const parsed = parseUniformNoteToItems(req.note);
  const items = DB.getUniformItems({ activeOnly: true });
  const matched = parsed.map(p => ({ parsed: p, item: matchUniformItemFromStock(p, items) })).filter(m => m.item);
  if (matched.length === 0) {
    toast('ไม่พบรายการที่ match กับ stock — เพิ่ม master หรือลงรายการ manual แทน', 'warning');
    return;
  }

  const issuedBy = DB.profile?.name || DB.user?.email || '';
  const issuedDate = document.getElementById('recruitIssueDate')?.value || tz.today();
  let okCount = 0, failCount = 0;
  for (const m of matched) {
    try {
      await DB.saveUniformIssue({
        requestId,
        itemId: m.item.id,
        itemName: m.item.name,
        size: m.item.size || '',
        qty: m.parsed.qty,
        unitCost: m.item.unitCost,
        issuedDate,
        issuedBy,
        employeeId: req.employeeId || '',
        note: ''
      });
      okCount++;
    } catch (ex) {
      console.warn('Issue fail:', m.parsed.raw, ex);
      failCount++;
    }
  }
  if (failCount === 0) toast(`✓ บันทึก ${okCount} รายการสำเร็จ`, 'success');
  else toast(`บันทึก ${okCount}/${matched.length} (ล้มเหลว ${failCount})`, 'warning');
  openIssueItemsForm(requestId); // refresh modal
}

// ─── จัดชุด: เพิ่มรายการ issue ทีละหลายรายการพร้อมกัน ───
function openIssueItemsForm(requestId) {
  if (!requireHR()) return;
  const req = DB.getUniformRequest(requestId);
  if (!req) return;
  // หาเจ้าของคำขอ — รองรับทั้ง employee และ applicant
  let owner = null, ownerLabel = '', refLabel = '';
  if (req.employeeId) {
    const e = DB.getEmployee(req.employeeId);
    if (e) {
      owner = e;
      ownerLabel = `${e.firstName} ${e.lastName || ''} (${req.employeeId})`;
      refLabel = 'พนักงาน';
    }
  }
  if (!owner && req.applicantId) {
    const ap = DB.getApplicant(req.applicantId);
    if (ap) {
      owner = ap;
      ownerLabel = `${ap.firstName} ${ap.lastName || ''} (ผู้สมัคร · ยังไม่ออกรหัสพนักงาน)`;
      refLabel = 'ผู้สมัคร';
    }
  }
  if (!owner) { toast('ไม่พบเจ้าของคำขอ', 'error'); return; }

  const items = DB.getUniformItems({ activeOnly: true });
  const existing = DB.getUniformIssues({ requestId });
  const issuedBy = DB.profile?.name || DB.user?.email || '';

  const isFromApplicant = refLabel === 'ผู้สมัคร';
  const editLink = isFromApplicant && req.applicantId
    ? `<button type="button" class="btn btn-ghost btn-sm" onclick="modal.close(); openApplicantForm('${req.applicantId}')" style="margin-left:8px;font-size:11px">✏️ แก้ไขที่ recruit</button>`
    : (req.employeeId ? `<button type="button" class="btn btn-ghost btn-sm" onclick="modal.close(); openUniformRequestForm('${req.id}')" style="margin-left:8px;font-size:11px">✏️ แก้ไขคำขอ</button>` : '');

  modal.open(`บันทึกการจัดชุด — ${escapeHtml(owner.firstName + ' ' + (owner.lastName || ''))}`, `
    <div class="form-section">
      <h3>ข้อมูลคำขอ <span class="badge ${isFromApplicant ? 'badge-warning' : 'badge-success'}" style="margin-left:8px;font-size:11px">${refLabel}</span>${editLink}</h3>
      <div class="form-grid">
        <div class="form-group"><label>เจ้าของคำขอ</label><input type="text" readonly value="${escapeHtml(ownerLabel)}"/></div>
        <div class="form-group"><label>ต้องการก่อน</label><input type="text" readonly value="${req.neededBy ? fmt.date(req.neededBy) : '-'}"/></div>
        ${!req.note ? `<div class="form-group span-2">
          <label>รายละเอียดที่ recruit แจ้ง <span class="muted-2" style="font-weight:normal;font-size:11px">(size, ประเภท, จำนวน)</span></label>
          <div style="padding:14px 16px;background:var(--warning-soft);color:var(--warning-text);border-radius:8px;font-size:13px;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div>⚠️ <strong>ยังไม่ระบุรายละเอียดชุด</strong> — recruit ยังไม่ได้กรอก size/ประเภท/จำนวน${isFromApplicant ? ' ที่ตอนเพิ่มผู้สมัคร' : ''}</div>
            ${isFromApplicant && req.applicantId
              ? `<button type="button" class="btn btn-primary btn-sm" onclick="modal.close(); openApplicantForm('${req.applicantId}')">ไปแก้ไขที่ recruit</button>`
              : (req.employeeId ? `<button type="button" class="btn btn-primary btn-sm" onclick="modal.close(); openUniformRequestForm('${req.id}')">ไปกรอกรายละเอียด</button>` : '')}
          </div>
        </div>` : ''}
      </div>
    </div>

    ${(() => {
      // panel รายการที่ recruit แจ้ง — ซ่อนถ้าจัดส่งบางส่วนไปแล้ว
      if (existing.length > 0) return '';
      const parsed = parseUniformNoteToItems(req.note);
      if (parsed.length === 0) return '';
      const matched = parsed.map(p => ({ parsed: p, item: matchUniformItemFromStock(p, items) }));
      const matchedCount = matched.filter(m => m.item).length;
      const totalCost = matched.reduce((s, m) => s + (m.item ? m.item.unitCost * m.parsed.qty : 0), 0);
      return `
        <div class="form-section" style="background:var(--surface-2);padding:14px;border-radius:8px;border-left:3px solid var(--primary)">
          <h3 style="margin-top:0">📋 รายการที่ recruit แจ้ง <span class="muted-2" style="font-weight:normal;font-size:12px">(${parsed.length} รายการ · match ${matchedCount}/${parsed.length})</span></h3>
          <div class="table-wrap"><table class="table table-compact" style="font-size:13px;background:var(--surface)">
            <thead><tr><th>รายการ</th><th>size</th><th class="num">qty</th><th>สถานะ match</th><th class="num">ราคา/ชิ้น</th><th class="num">รวม</th></tr></thead>
            <tbody>
              ${matched.map(m => {
                if (!m.parsed.parseable) {
                  return `<tr><td colspan="6" class="muted-2">⚠️ แยกข้อมูลไม่ได้: ${escapeHtml(m.parsed.raw)}</td></tr>`;
                }
                const stockOk = m.item && Number(m.item.stockQty) >= m.parsed.qty;
                return `<tr>
                  <td><strong>${escapeHtml(m.parsed.name)}</strong></td>
                  <td>${escapeHtml(m.parsed.size || '-')}</td>
                  <td class="num">${m.parsed.qty}</td>
                  <td>${m.item
                    ? `<span class="badge ${stockOk ? 'badge-success' : 'badge-warning'}">${stockOk ? '✓ พร้อมส่ง' : `Stock เหลือ ${m.item.stockQty}`}</span>`
                    : '<span class="badge badge-danger">⚠️ ไม่พบใน stock</span>'}</td>
                  <td class="num">${m.item ? fmt.money(m.item.unitCost) : '-'}</td>
                  <td class="num"><strong>${m.item ? fmt.money(m.item.unitCost * m.parsed.qty) : '-'}</strong></td>
                </tr>`;
              }).join('')}
              ${matchedCount > 0 ? `<tr style="background:var(--surface-2);font-weight:600"><td colspan="5" style="text-align:right">รวมที่จะเก็บจากพนักงาน</td><td class="num" style="color:var(--success)">${fmt.money(totalCost)} ฿</td></tr>` : ''}
            </tbody>
          </table></div>
          <div class="form-actions" style="justify-content:flex-end;margin-top:12px;gap:10px;align-items:center;flex-wrap:wrap">
            ${matchedCount > 0
              ? `<label style="font-size:12.5px;color:var(--text-2);display:flex;align-items:center;gap:6px;margin:0">วันที่จัดส่ง:
                  <input type="date" id="recruitIssueDate" value="${tz.today()}" style="padding:6px 10px;font-size:13px;width:auto"/>
                 </label>
                 <button type="button" class="btn btn-primary" onclick="issueAllFromRecruit('${requestId}')">🚀 ส่งทั้งหมดตาม recruit (${matchedCount} รายการ)</button>`
              : `<span class="muted-2" style="font-size:12px;color:var(--warning)">⚠️ ไม่มีรายการที่ match กับ stock — เพิ่ม master ก่อน หรือลงรายการ manual ด้านล่าง</span>`}
          </div>
          ${matched.some(m => !m.item) ? `<div class="muted-2" style="font-size:11.5px;color:var(--warning);margin-top:8px;line-height:1.6">💡 รายการที่ match ไม่ได้จะถูกข้าม — ให้ลงรายการเพิ่มแบบ manual ในส่วน "เพิ่มรายการ" ด้านล่าง</div>` : ''}
        </div>
      `;
    })()}

    <div class="form-section">
      <h3>รายการที่จัดให้แล้ว <span class="muted-2" style="font-weight:normal;font-size:12px">(${existing.length} รายการ · รวม ${fmt.money(req.totalCost)} บาท)</span></h3>
      ${existing.length ? `<div class="table-wrap"><table class="table table-compact" style="font-size:13px">
        <thead><tr><th>วันที่</th><th>รายการ</th><th>ขนาด</th><th class="num">จำนวน</th><th class="num">ราคา</th><th class="num">รวม</th><th></th></tr></thead>
        <tbody>
          ${existing.map(i => `<tr>
            <td>${fmt.date(i.issuedDate)}</td>
            <td>${escapeHtml(i.itemName)}</td>
            <td>${escapeHtml(i.size || '-')}</td>
            <td class="num">${i.qty}</td>
            <td class="num">${fmt.money(i.unitCost)}</td>
            <td class="num">${fmt.money(i.totalCost)}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="(async () => { if (await modal.confirm('ลบรายการ','คืน stock + ลบรายการ?')) { await DB.deleteUniformIssue('${i.id}'); toast('ลบแล้ว','success'); openIssueItemsForm('${requestId}'); } })()">ลบ</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : '<div class="muted-2" style="padding:12px 0">— ยังไม่มี —</div>'}
    </div>

    <div class="form-section">
      <h3>เพิ่มรายการ</h3>
      <form id="issueForm">
        <div class="form-grid">
          <div class="form-group"><label>เลือกชุด *</label>
            <select name="itemId" id="issueItem" required>
              <option value="">— เลือกรายการ —</option>
              ${items.map(i => `<option value="${i.id}" data-name="${escapeHtml(i.name)}" data-size="${escapeHtml(i.size || '')}" data-cost="${i.unitCost}" data-stock="${i.stockQty}">${escapeHtml(i.name)} · ${escapeHtml(i.size || '-')} · เหลือ ${i.stockQty} ชิ้น · ${fmt.money(i.unitCost)} บาท</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>จำนวน *</label><input name="qty" id="issueQty" type="number" min="1" value="1" required/></div>
          <div class="form-group"><label>ราคา/ชิ้น</label><input name="unitCost" id="issueCost" type="number" min="0" step="0.01" readonly/></div>
          <div class="form-group"><label>วันที่จัดส่ง *</label><input name="issuedDate" type="date" value="${tz.today()}" required/></div>
          <div class="form-group"><label>HR ผู้จัด</label><input name="issuedBy" value="${escapeHtml(issuedBy)}"/></div>
          <div class="form-group"><label>รวม</label><input id="issueTotal" type="text" readonly style="font-weight:600;color:var(--success)"/></div>
          <div class="form-group span-2"><label>หมายเหตุ</label><input name="note" placeholder="เช่น ส่งให้พนักงานเรียบร้อย"/></div>
        </div>
        <div class="form-actions" style="justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-secondary" data-close>ปิด</button>
            ${req.status !== 'issued' && req.status !== 'cancelled' ? `
              <button type="button" class="btn btn-success" onclick="markUniformRequestIssued('${requestId}')" title="ทำเครื่องหมายว่าจัดส่งครบแล้ว (เปลี่ยนสถานะเป็น 'จัดส่งแล้ว')">
                ✓ จัดส่งครบแล้ว
              </button>
            ` : `<button type="button" class="btn btn-success" onclick="confirmIssueAndClose('${requestId}')" title="ยืนยันการจัดส่งเรียบร้อย + ปิดหน้านี้">
                ✓ ยืนยันการจัดส่ง · ปิด
              </button>`}
          </div>
          <button type="submit" class="btn btn-primary">+ เพิ่มรายการ${existing.length === 0 ? ' (พร้อมตัด stock)' : ''}</button>
        </div>
      </form>
    </div>
    <div class="muted-2" style="font-size:12px;padding:12px 14px;background:var(--surface-2);border-radius:8px;margin-top:14px;line-height:1.7">
      <strong style="color:var(--text)">📌 คำแนะนำ:</strong><br>
      • <strong>"+ เพิ่มรายการ"</strong> — บันทึกแต่ละชิ้นที่จัดให้ พร้อมตัด stock + คิดค่าชุดอัตโนมัติ<br>
      • <strong>"✓ จัดส่งครบแล้ว"</strong> — ทำเครื่องหมายว่าจบ (เปลี่ยนสถานะเป็น "จัดส่งแล้ว") เมื่อไม่ต้องการลงรายการรายชิ้น<br>
      • <strong>"ปิด"</strong> — ออกจากหน้านี้โดยไม่เปลี่ยนสถานะ
    </div>
  `, { size: 'lg' });

  const updateCost = () => {
    const sel = $('#issueItem');
    const opt = sel.options[sel.selectedIndex];
    const cost = opt ? Number(opt.dataset.cost || 0) : 0;
    const qty = Number($('#issueQty').value || 0);
    $('#issueCost').value = cost;
    $('#issueTotal').value = fmt.money(cost * qty);
  };
  $('#issueItem')?.addEventListener('change', updateCost);
  $('#issueQty')?.addEventListener('input', updateCost);

  $('#issueForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      const sel = $('#issueItem');
      const opt = sel.options[sel.selectedIndex];
      data.itemName = opt?.dataset.name || '';
      data.size = opt?.dataset.size || '';
      data.requestId = requestId;
      // employee_id อาจยังว่าง ถ้า applicant ยังไม่รับเข้า — issue จะ link ผ่าน request_id ก่อน
      data.employeeId = req.employeeId || '';
      data.qty = Number(data.qty);
      data.unitCost = Number(data.unitCost);
      const stock = Number(opt?.dataset.stock || 0);
      if (data.qty > stock) {
        if (!await modal.confirm('Stock ไม่พอ', `Stock เหลือ ${stock} ชิ้น แต่ต้องการ ${data.qty} ชิ้น — ดำเนินการต่อ?`)) return;
      }
      await DB.saveUniformIssue(data);
      toast('เพิ่มรายการแล้ว · stock ถูกตัดอัตโนมัติ', 'success');
      openIssueItemsForm(requestId); // refresh modal
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

// ─── รายการชุด (master) ───
function openUniformItemForm(id = null) {
  if (!requireHR()) return;
  const i = id ? DB.getUniformItem(id) : { id: '', name: '', size: '', stockQty: 0, unitCost: 0, active: true, note: '' };
  modal.open(id ? 'แก้ไขรายการชุด' : 'เพิ่มรายการชุด', `
    <form id="uniItemForm">
      <div class="form-grid">
        <div class="form-group"><label>ชื่อชุด *</label>
          <input name="name" list="dl-uni-names" value="${escapeHtml(i.name)}" required placeholder="เสื้อยูนิฟอร์ม, กางเกง, หมวก ฯลฯ"/>
          <datalist id="dl-uni-names">${['เสื้อยูนิฟอร์ม','กางเกง','หมวก','รองเท้า','ผ้ากันเปื้อน','เสื้อแขนยาว','เสื้อแขนสั้น','เนคไท'].map(v => `<option value="${v}">`).join('')}</datalist>
        </div>
        <div class="form-group"><label>ขนาด</label>
          <input name="size" list="dl-uni-sizes" value="${escapeHtml(i.size)}" placeholder="S, M, L, XL, 36 ฯลฯ"/>
          <datalist id="dl-uni-sizes">${['S','M','L','XL','XXL','ฟรีไซส์','36','38','40','42'].map(v => `<option value="${v}">`).join('')}</datalist>
        </div>
        <div class="form-group"><label>จำนวนใน Stock</label><input name="stockQty" type="number" min="0" value="${i.stockQty}"/></div>
        <div class="form-group"><label>ราคา/ชิ้น (บาท)</label><input name="unitCost" type="number" min="0" step="0.01" value="${i.unitCost}"/></div>
        <div class="form-group span-2"><label>สถานะ</label>
          <select name="active"><option value="true" ${i.active ? 'selected' : ''}>ใช้งาน</option><option value="false" ${!i.active ? 'selected' : ''}>ปิดใช้งาน</option></select>
        </div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="2">${escapeHtml(i.note)}</textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>
  `);
  $('#uniItemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.stockQty = Number(data.stockQty || 0);
      data.unitCost = Number(data.unitCost || 0);
      data.active = data.active === 'true';
      if (id) data.id = id;
      await DB.saveUniformItem(data);
      modal.close();
      toast(id ? 'บันทึกแล้ว' : 'เพิ่มรายการชุดแล้ว', 'success');
      _uniformState.tab = 'items';
      router.go('uniform');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteUniformItem(id) {
  if (!requireHR()) return;
  const i = DB.getUniformItem(id);
  if (!i) return;
  if (!await modal.confirm('ลบรายการ', `ลบ "${i.name} (${i.size})" ใช่หรือไม่?`)) return;
  try { await DB.deleteUniformItem(id); toast('ลบแล้ว', 'success'); router.go('uniform'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function deleteUniformIssue(id) {
  if (!requireHR()) return;
  if (!await modal.confirm('ลบรายการจัด', 'คืน stock + ลบประวัติ ใช่หรือไม่?')) return;
  try { await DB.deleteUniformIssue(id); toast('ลบแล้ว', 'success'); router.go('uniform'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ─── EXCEL: export ประวัติการจัดชุด ───
function exportUniformIssuesXLSX() {
  if (!requireHR()) return; // 🔒 ประวัติการจัดชุด — รายชื่อพนักงานทั้งบริษัท
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportUniformIssuesXLSX, 800); return; }
  const list = DB.getUniformIssues();
  if (!list.length) { toast('ยังไม่มีข้อมูล', 'warning'); return; }
  const cs = csvSafe;
  const rows = list.map(i => {
    const e = DB.getEmployee(i.employeeId) || {};
    return {
      'วันที่จัดส่ง': excelDate(i.issuedDate),
      'รหัสพนักงาน': excelNum(i.employeeId),
      'ชื่อ-นามสกุล': cs((e.firstName || '') + ' ' + (e.lastName || '')),
      'รายการชุด': cs(i.itemName),
      'ขนาด': cs(i.size),
      'จำนวน': Number(i.qty || 0),
      'ราคา/ชิ้น': Number(i.unitCost || 0),
      'รวม': Number(i.totalCost || 0),
      'HR ผู้จัด': cs(i.issuedBy),
      'หมายเหตุ': cs(i.note)
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  const headerKeys = Object.keys(rows[0] || {});
  const idIdx = headerKeys.indexOf('รหัสพนักงาน');
  if (idIdx >= 0) setColumnFormat(ws, idIdx, '0');
  for (const col of ['ราคา/ชิ้น', 'รวม']) {
    const idx = headerKeys.indexOf(col);
    if (idx >= 0) setColumnFormat(ws, idx, '#,##0');
  }
  ws['!cols'] = headerKeys.map(k => {
    if (k === 'วันที่จัดส่ง') return { wch: 13 };
    if (k === 'ชื่อ-นามสกุล' || k === 'รายการชุด') return { wch: 22 };
    if (k === 'หมายเหตุ') return { wch: 26 };
    return { wch: 12 };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'การจัดชุด');
  XLSX.writeFile(wb, `คชา-การจัดชุดพนักงาน-${tz.today()}.xlsx`);
  toast('ส่งออกแล้ว — นำไปคิดค่าชุดกับพนักงานใหม่ได้', 'success');
}

// ═══════════════════════════════════════════════════════
//  PAGE: SALARY ADJUSTMENT
// ═══════════════════════════════════════════════════════
const CHANGE_TYPE_BADGE = {
  salary:     { label: 'ปรับเงินเดือน',  cls: 'badge-info' },
  allowance:  { label: 'ปรับสวัสดิการ',   cls: 'badge-info' },
  position:   { label: 'ปรับตำแหน่ง',    cls: 'badge-success' },
  branch:     { label: 'ย้ายสาขา',       cls: 'badge-warning' },
  department: { label: 'ย้ายฝ่าย',        cls: 'badge-warning' },
  multiple:   { label: 'ปรับหลายอย่าง',  cls: 'badge-danger' }
};
// ฉลาก allowance สำหรับแสดงในประวัติ
const ALLOWANCE_LABELS = {
  AllowancePosition: 'ค่าตำแหน่ง',
  AllowanceTravel:   'ค่าเดินทาง',
  AllowanceFood:     'ค่าอาหาร',
  AllowancePerDiem:  'ค่าเบี้ยเลี้ยง',
  AllowanceLanguage: 'ค่าภาษา',
  AllowancePhone:    'ค่าโทรศัพท์',
  AllowanceOther:    'ค่าอื่นๆ'
};

router.register('salary-adjust', () => {
  const history = DB.getSalaryHistory();
  const fmtChange = (h) => {
    const parts = [];
    if (h.newSalary && Number(h.newSalary) !== Number(h.oldSalary)) {
      const diff = Number(h.newSalary) - Number(h.oldSalary);
      const sign = diff > 0 ? '+' : '';
      parts.push(`💰 ${fmt.money(h.oldSalary)} → <strong>${fmt.money(h.newSalary)}</strong> <span style="color:${diff > 0 ? 'var(--success)' : 'var(--danger)'}">(${sign}${fmt.money(diff)})</span>`);
    }
    if (h.newPosition && h.newPosition !== h.oldPosition) {
      const oldName = DB.getPosition(h.oldPosition)?.name || h.oldPositionTitle || '-';
      const newName = DB.getPosition(h.newPosition)?.name || h.newPositionTitle || '-';
      parts.push(`🎖️ ${escapeHtml(oldName)} → <strong>${escapeHtml(newName)}</strong>`);
    } else if (h.newPositionTitle && h.newPositionTitle !== h.oldPositionTitle) {
      parts.push(`🎖️ ${escapeHtml(h.oldPositionTitle || '-')} → <strong>${escapeHtml(h.newPositionTitle)}</strong>`);
    }
    if (h.newBranch && h.newBranch !== h.oldBranch) {
      parts.push(`🏢 ${escapeHtml(h.oldBranch || '-')} → <strong>${escapeHtml(h.newBranch)}</strong>`);
    }
    if (h.newDepartment && h.newDepartment !== h.oldDepartment) {
      const oldD = DB.getDepartment(h.oldDepartment)?.name || h.oldDepartment || '-';
      const newD = DB.getDepartment(h.newDepartment)?.name || h.newDepartment;
      parts.push(`📋 ${escapeHtml(oldD)} → <strong>${escapeHtml(newD)}</strong>`);
    }
    // Allowance changes (6 fields)
    for (const key of Object.keys(ALLOWANCE_LABELS)) {
      const oldVal = h['old' + key];
      const newVal = h['new' + key];
      if (newVal != null && Number(newVal) !== Number(oldVal || 0)) {
        const diff = Number(newVal) - Number(oldVal || 0);
        const sign = diff > 0 ? '+' : '';
        parts.push(`💵 ${ALLOWANCE_LABELS[key]} ${fmt.money(oldVal || 0)} → <strong>${fmt.money(newVal)}</strong> <span style="color:${diff > 0 ? 'var(--success)' : 'var(--danger)'}">(${sign}${fmt.money(diff)})</span>`);
      }
    }
    return parts.length ? parts.join('<br>') : '-';
  };

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ปรับค่าจ้าง / ตำแหน่ง / สาขา</div>
        <div class="sw-page-subtitle">บันทึกการเปลี่ยนแปลงพนักงาน · ระบบจะอัปเดตทะเบียนพนักงานอัตโนมัติ</div>
      </div>
      <div class="sw-page-actions">
        ${DB.isHR ? `
          <button class="btn btn-secondary" onclick="openImportEmployeeChanges()">${ICON.upload}นำเข้า Excel</button>
          <button class="btn btn-secondary" onclick="exportEmployeeChangesXLSX()">${ICON.download}ส่งออก Excel</button>
          <button class="btn btn-primary" onclick="openSalaryAdjustForm()">+ บันทึกการปรับ</button>
        ` : ''}
      </div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-title">ประวัติการปรับ · ${fmt.num(history.length)} รายการ</div>
      <div class="sw-chart-sub">รวมทั้ง การปรับเงินเดือน, ปรับตำแหน่ง, ย้ายสาขา, ย้ายฝ่าย</div>
      ${history.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>วันที่</th><th>พนักงาน</th><th>ประเภท</th><th>รายการเปลี่ยนแปลง</th><th>เหตุผล</th></tr></thead>
          <tbody>
            ${history.map(h => {
              const e = DB.getEmployee(h.employeeId) || {};
              const badge = CHANGE_TYPE_BADGE[h.changeType] || CHANGE_TYPE_BADGE.salary;
              return `<tr>
                <td style="white-space:nowrap">${fmt.date(h.date)}</td>
                <td>${escapeHtml((e.firstName || '') + ' ' + (e.lastName || ''))} <span class="muted-2" style="font-size:12px">(${escapeHtml(h.employeeId)})</span></td>
                <td><span class="badge ${badge.cls}">${badge.label}</span></td>
                <td style="line-height:1.7">${fmtChange(h)}</td>
                <td>${escapeHtml(h.reason || '-')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : `<div class="empty-state"><div class="icon">${ICON.money}</div><div class="title">ยังไม่มีประวัติการปรับ</div><div class="hint">กดปุ่ม "+ บันทึกการปรับ" เพื่อเริ่มต้น</div></div>`}
    </div>`;
});

function openSalaryAdjustForm() {
  if (!requireHR()) return;
  const emps = DB.getEmployees({ status: 'active' });
  const positions = DB.getPositions();
  const depts = DB.getDepartments();
  const branches = DB.getBranches();

  modal.open('บันทึกการปรับ — ค่าจ้าง / ตำแหน่ง / สาขา', `
    <form id="adjForm">
      <div class="form-section">
        <h3>เลือกพนักงาน</h3>
        <div class="form-grid">
          <div class="form-group span-2"><label>พนักงาน * <span class="muted-2" style="font-weight:normal;font-size:11px">— พิมพ์ ชื่อ / นามสกุล / ชื่อเล่น / รหัส (${fmt.num(emps.length)} คน)</span></label>
            <input type="text" id="adjEmpSearch" list="dl-adj-emps" autocomplete="off" required placeholder="พิมพ์เพื่อค้นหา หรือเลือกจากรายการ"/>
            <input type="hidden" name="employeeId" id="adjEmp"/>
            <datalist id="dl-adj-emps">
              ${emps.map(e => {
                const display = `${e.id} — ${(e.title || '') + e.firstName} ${e.lastName || ''}${e.nickname ? ' (' + e.nickname + ')' : ''}`;
                return `<option value="${escapeHtml(display)}"></option>`;
              }).join('')}
            </datalist>
            <small class="muted-2" id="adjEmpHint" style="font-size:11.5px;color:var(--text-3)"></small>
          </div>
          <div class="form-group"><label>วันที่มีผล *</label><input name="date" type="date" value="${tz.today()}" required/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>สถานะปัจจุบัน <span class="muted-2" style="font-weight:normal;font-size:12px">(read-only)</span></h3>
        <div class="form-grid">
          <div class="form-group"><label>เงินเดือนเก่า</label><input id="adjOldSalary" type="text" readonly/></div>
          <div class="form-group"><label>ตำแหน่งเก่า</label><input id="adjOldPosition" type="text" readonly/></div>
          <div class="form-group"><label>สาขาเก่า</label><input id="adjOldBranch" type="text" readonly/></div>
          <div class="form-group"><label>ฝ่ายเก่า</label><input id="adjOldDept" type="text" readonly/></div>
          <div class="form-group"><label>ค่าตำแหน่งเก่า</label><input id="adjOldAlPos" type="text" readonly/></div>
          <div class="form-group"><label>ค่าเดินทางเก่า</label><input id="adjOldAlTrv" type="text" readonly/></div>
          <div class="form-group"><label>ค่าอาหารเก่า</label><input id="adjOldAlFood" type="text" readonly/></div>
          <div class="form-group"><label>ค่าเบี้ยเลี้ยงเก่า</label><input id="adjOldAlPd" type="text" readonly/></div>
          <div class="form-group"><label>ค่าภาษาเก่า</label><input id="adjOldAlLang" type="text" readonly/></div>
          <div class="form-group"><label>ค่าโทรศัพท์เก่า</label><input id="adjOldAlPhone" type="text" readonly/></div>
          <div class="form-group"><label>ค่าอื่นๆ เก่า</label><input id="adjOldAlOther" type="text" readonly/></div>
          <div class="form-group span-2"><label>รายได้รวมเก่า</label><input id="adjOldTotal" type="text" readonly style="font-weight:600;color:var(--primary)"/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>ค่าใหม่ — เงินเดือน + สวัสดิการ <span class="muted-2" style="font-weight:normal;font-size:12px">(เปลี่ยนเฉพาะที่ต้องการ — ที่ไม่กรอกจะคงเดิม)</span></h3>
        <div class="form-grid">
          <div class="form-group"><label>เงินเดือนใหม่</label><input name="newSalary" type="number" min="0" step="100" placeholder="ไม่เปลี่ยน" class="adj-money"/></div>
          <div class="form-group"><label>ค่าตำแหน่งใหม่</label><input name="newAllowancePosition" type="number" min="0" step="100" placeholder="ไม่เปลี่ยน" class="adj-money"/></div>
          <div class="form-group"><label>ค่าเดินทางใหม่</label><input name="newAllowanceTravel" type="number" min="0" step="100" placeholder="ไม่เปลี่ยน" class="adj-money"/></div>
          <div class="form-group"><label>ค่าอาหารใหม่</label><input name="newAllowanceFood" type="number" min="0" step="100" placeholder="ไม่เปลี่ยน" class="adj-money"/></div>
          <div class="form-group"><label>ค่าเบี้ยเลี้ยงใหม่</label><input name="newAllowancePerDiem" type="number" min="0" step="100" placeholder="ไม่เปลี่ยน" class="adj-money"/></div>
          <div class="form-group"><label>ค่าภาษาใหม่</label><input name="newAllowanceLanguage" type="number" min="0" step="100" placeholder="ไม่เปลี่ยน" class="adj-money"/></div>
          <div class="form-group"><label>ค่าโทรศัพท์ใหม่</label><input name="newAllowancePhone" type="number" min="0" step="100" placeholder="ไม่เปลี่ยน" class="adj-money"/></div>
          <div class="form-group"><label>ค่าอื่นๆ ใหม่</label><input name="newAllowanceOther" type="number" min="0" step="100" placeholder="ไม่เปลี่ยน" class="adj-money"/></div>
          <div class="form-group"><label>รายได้รวมใหม่</label><input id="adjNewTotal" type="text" readonly style="font-weight:600;color:var(--success)"/></div>
        </div>
      </div>

      <div class="form-section">
        <h3>ค่าใหม่ — ตำแหน่ง / สังกัด</h3>
        <div class="form-grid">
          <div class="form-group"><label>ระดับตำแหน่งใหม่</label>
            <select name="newPosition"><option value="">— ไม่เปลี่ยน —</option>${positions.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>ชื่อตำแหน่งใหม่</label><input name="newPositionTitle" placeholder="ไม่เปลี่ยน"/></div>
          <div class="form-group"><label>สาขาใหม่</label>
            <input name="newBranch" list="dl-branches-adj" placeholder="ไม่ย้าย"/>
            <datalist id="dl-branches-adj">${branches.map(b => `<option value="${escapeHtml(b)}">`).join('')}</datalist>
          </div>
          <div class="form-group"><label>ฝ่ายใหม่</label>
            <select name="newDepartment"><option value="">— ไม่ย้าย —</option>${depts.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}</select>
          </div>
        </div>
      </div>

      <div class="form-section">
        <h3>เหตุผล</h3>
        <div class="form-grid">
          <div class="form-group span-2"><textarea name="reason" rows="2" placeholder="เช่น ปรับขึ้นประจำปี, โปรโมท, ย้ายฐานการทำงาน"></textarea></div>
        </div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>`, { size: 'lg' });

  // helper: ดึง employee ปัจจุบันจาก hidden input
  const currentEmp = () => DB.getEmployee($('#adjEmp').value);
  // parse ID จาก search input value — รูปแบบ "ID — ชื่อ นามสกุล (เล่น)"
  const parseEmpIdFromSearch = (val) => {
    if (!val) return '';
    // ลองดู exact ID ก่อน (ถ้า user พิมพ์รหัสล้วน)
    const direct = val.trim();
    if (DB.getEmployee(direct)) return direct;
    // ดึง token แรกก่อน " — "
    const m = val.split(/\s*—\s*/);
    const id = (m[0] || '').trim();
    return DB.getEmployee(id) ? id : '';
  };
  const numOr = (v, fallback) => {
    const s = (v ?? '').toString().trim();
    if (s === '') return Number(fallback) || 0;
    const n = Number(s);
    return isNaN(n) ? Number(fallback) || 0 : n;
  };
  const calcNewTotal = () => {
    const emp = currentEmp();
    if (!emp) { $('#adjNewTotal').value = ''; return; }
    const total =
      numOr($('#adjForm [name="newSalary"]')?.value, emp.salary) +
      numOr($('#adjForm [name="newAllowancePosition"]')?.value, emp.allowancePosition) +
      numOr($('#adjForm [name="newAllowanceTravel"]')?.value, emp.allowanceTravel) +
      numOr($('#adjForm [name="newAllowanceFood"]')?.value, emp.allowanceFood) +
      numOr($('#adjForm [name="newAllowancePerDiem"]')?.value, emp.allowancePerDiem) +
      numOr($('#adjForm [name="newAllowanceLanguage"]')?.value, emp.allowanceLanguage) +
      numOr($('#adjForm [name="newAllowancePhone"]')?.value, emp.allowancePhone) +
      numOr($('#adjForm [name="newAllowanceOther"]')?.value, emp.allowanceOther);
    $('#adjNewTotal').value = fmt.money(total) + ' บาท';
  };

  // เมื่อเปลี่ยนช่องค้นหา → parse ID, อัปเดต hidden input, เติม current state
  const onEmpPicked = () => {
    const id = parseEmpIdFromSearch($('#adjEmpSearch').value);
    $('#adjEmp').value = id;
    const emp = id ? DB.getEmployee(id) : null;
    const hint = $('#adjEmpHint');
    if (!emp) {
      ['#adjOldSalary','#adjOldPosition','#adjOldBranch','#adjOldDept',
       '#adjOldAlPos','#adjOldAlTrv','#adjOldAlFood','#adjOldAlPd','#adjOldAlLang','#adjOldAlPhone','#adjOldAlOther',
       '#adjOldTotal','#adjNewTotal'].forEach(s => { const el = $(s); if (el) el.value = ''; });
      if (hint) hint.innerHTML = $('#adjEmpSearch').value ? '<span style="color:var(--danger)">ไม่พบพนักงาน — เลือกจากรายการ</span>' : '';
      return;
    }
    if (hint) hint.innerHTML = `<span style="color:var(--success)">✓ ${escapeHtml(emp.id)} — ${escapeHtml(emp.firstName + ' ' + (emp.lastName || ''))}</span>`;
    $('#adjOldSalary').value = fmt.money(emp.salary) + ' บาท';
    $('#adjOldPosition').value = (DB.getPosition(emp.position)?.name || '') + (emp.positionTitle ? ' · ' + emp.positionTitle : '');
    $('#adjOldBranch').value = emp.branch || '';
    $('#adjOldDept').value = DB.getDepartment(emp.department)?.name || '';
    $('#adjOldAlPos').value   = fmt.money(emp.allowancePosition);
    $('#adjOldAlTrv').value   = fmt.money(emp.allowanceTravel);
    $('#adjOldAlFood').value  = fmt.money(emp.allowanceFood);
    $('#adjOldAlPd').value    = fmt.money(emp.allowancePerDiem);
    $('#adjOldAlLang').value  = fmt.money(emp.allowanceLanguage);
    $('#adjOldAlPhone').value = fmt.money(emp.allowancePhone);
    $('#adjOldAlOther').value = fmt.money(emp.allowanceOther);
    $('#adjOldTotal').value   = fmt.money(totalIncome(emp)) + ' บาท';
    calcNewTotal();
  };
  $('#adjEmpSearch').addEventListener('input', onEmpPicked);
  $('#adjEmpSearch').addEventListener('change', onEmpPicked);

  // recalculate รายได้รวมใหม่ทุกครั้งที่กรอก
  $$('#adjForm .adj-money').forEach(el => el.addEventListener('input', calcNewTotal));

  $('#adjForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      const emp = DB.getEmployee(data.employeeId);
      if (!emp) { toast('กรุณาเลือกพนักงาน', 'error'); return; }

      // ต้องเปลี่ยนอย่างน้อย 1 อย่าง
      const hasChange = data.newSalary !== '' || data.newPosition || data.newPositionTitle ||
        data.newBranch || data.newDepartment ||
        data.newAllowancePosition !== '' || data.newAllowanceTravel !== '' ||
        data.newAllowanceFood !== '' || data.newAllowancePerDiem !== '' ||
        data.newAllowanceLanguage !== '' || data.newAllowanceOther !== '';
      if (!hasChange) { toast('กรุณากรอกค่าใหม่อย่างน้อย 1 อย่าง', 'warning'); return; }

      const rec = {
        employeeId: data.employeeId,
        date: data.date,
        reason: data.reason || ''
      };
      if (data.newSalary !== '') rec.newSalary = Number(data.newSalary);
      if (data.newPosition) rec.newPosition = data.newPosition;
      if (data.newPositionTitle) rec.newPositionTitle = data.newPositionTitle;
      if (data.newBranch) rec.newBranch = data.newBranch;
      if (data.newDepartment) rec.newDepartment = data.newDepartment;
      if (data.newAllowancePosition !== '') rec.newAllowancePosition = Number(data.newAllowancePosition);
      if (data.newAllowanceTravel   !== '') rec.newAllowanceTravel   = Number(data.newAllowanceTravel);
      if (data.newAllowanceFood     !== '') rec.newAllowanceFood     = Number(data.newAllowanceFood);
      if (data.newAllowancePerDiem  !== '') rec.newAllowancePerDiem  = Number(data.newAllowancePerDiem);
      if (data.newAllowanceLanguage !== '') rec.newAllowanceLanguage = Number(data.newAllowanceLanguage);
      if (data.newAllowanceOther    !== '') rec.newAllowanceOther    = Number(data.newAllowanceOther);

      await DB.addSalaryAdjustment(rec);
      modal.close();
      toast('บันทึกแล้ว — ทะเบียนพนักงานอัปเดตอัตโนมัติ', 'success');
      router.go('salary-adjust');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

// ─── EMPLOYEE CHANGES: Excel import / export / template ───
const CHANGE_IMPORT_COLUMNS = [
  'รหัสพนักงาน', 'วันที่มีผล',
  'เงินเดือนใหม่',
  'ค่าตำแหน่งใหม่', 'ค่าเดินทางใหม่', 'ค่าอาหารใหม่',
  'ค่าเบี้ยเลี้ยงใหม่', 'ค่าภาษาใหม่', 'ค่าโทรศัพท์ใหม่', 'ค่าอื่นๆใหม่',
  'รหัสตำแหน่งใหม่', 'ชื่อตำแหน่งใหม่',
  'สาขาใหม่', 'รหัสฝ่ายใหม่', 'เหตุผล'
];

function downloadEmployeeChangesTemplate() {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(downloadEmployeeChangesTemplate, 800); return; }

  const sample = [
    {
      'รหัสพนักงาน': 1001, 'วันที่มีผล': '01/06/2026',
      'เงินเดือนใหม่': 35000,
      'ค่าตำแหน่งใหม่': '', 'ค่าเดินทางใหม่': '', 'ค่าอาหารใหม่': '',
      'ค่าเบี้ยเลี้ยงใหม่': '', 'ค่าภาษาใหม่': '', 'ค่าโทรศัพท์ใหม่': '', 'ค่าอื่นๆใหม่': '',
      'รหัสตำแหน่งใหม่': 'P04', 'ชื่อตำแหน่งใหม่': 'หัวหน้าฝ่ายอาวุโส',
      'สาขาใหม่': '', 'รหัสฝ่ายใหม่': '',
      'เหตุผล': 'โปรโมทประจำปี'
    },
    {
      'รหัสพนักงาน': 1002, 'วันที่มีผล': '01/06/2026',
      'เงินเดือนใหม่': '',
      'ค่าตำแหน่งใหม่': 2000, 'ค่าเดินทางใหม่': '', 'ค่าอาหารใหม่': '',
      'ค่าเบี้ยเลี้ยงใหม่': '', 'ค่าภาษาใหม่': '', 'ค่าโทรศัพท์ใหม่': '', 'ค่าอื่นๆใหม่': '',
      'รหัสตำแหน่งใหม่': '', 'ชื่อตำแหน่งใหม่': '',
      'สาขาใหม่': '', 'รหัสฝ่ายใหม่': '',
      'เหตุผล': 'เพิ่มค่าตำแหน่งเป็นหัวหน้าทีม'
    },
    {
      'รหัสพนักงาน': 1003, 'วันที่มีผล': '15/06/2026',
      'เงินเดือนใหม่': 20000,
      'ค่าตำแหน่งใหม่': '', 'ค่าเดินทางใหม่': 1500, 'ค่าอาหารใหม่': 1000,
      'ค่าเบี้ยเลี้ยงใหม่': '', 'ค่าภาษาใหม่': '', 'ค่าโทรศัพท์ใหม่': 500, 'ค่าอื่นๆใหม่': '',
      'รหัสตำแหน่งใหม่': '', 'ชื่อตำแหน่งใหม่': '',
      'สาขาใหม่': 'สาขาเซ็นทรัล', 'รหัสฝ่ายใหม่': '',
      'เหตุผล': 'ย้ายสาขา + ปรับเงิน + เพิ่มเบี้ยเลี้ยง'
    }
  ];
  const ws = XLSX.utils.json_to_sheet(sample, { header: CHANGE_IMPORT_COLUMNS });
  ws['!cols'] = CHANGE_IMPORT_COLUMNS.map(k => ({ wch: Math.max(k.length + 2, 16) }));

  const depts = DB.getDepartments().map(d => `${d.id} = ${d.name}`).join('\n');
  const positions = DB.getPositions().map(p => `${p.id} = ${p.name}`).join('\n');
  const notes = [
    ['คำแนะนำการกรอกข้อมูลการปรับ — ค่าจ้าง / ตำแหน่ง / สาขา / ฝ่าย'],
    [''],
    ['ฟิลด์ที่จำเป็น:'],
    ['• รหัสพนักงาน — ต้องมีในระบบแล้ว (ระบบจะ update ทะเบียนพนักงานเป็นค่าใหม่)'],
    ['• วันที่มีผล — ใส่ DD/MM/YYYY หรือ Excel Date'],
    [''],
    ['ฟิลด์ค่าใหม่ (กรอกอย่างน้อย 1 อย่าง — ที่ไม่กรอกระบบจะคงเดิม):'],
    ['• เงินเดือนใหม่ — ตัวเลข ไม่ใส่ comma'],
    ['• ค่าตำแหน่งใหม่ / ค่าเดินทางใหม่ / ค่าอาหารใหม่ / ค่าเบี้ยเลี้ยงใหม่ / ค่าภาษาใหม่ / ค่าโทรศัพท์ใหม่ / ค่าอื่นๆใหม่ — ตัวเลข'],
    ['• รหัสตำแหน่งใหม่ — เช่น P03, P04 (ดูรหัสด้านล่าง)'],
    ['• ชื่อตำแหน่งใหม่ — ข้อความ'],
    ['• สาขาใหม่ — ชื่อสาขาที่ต้องการย้ายไป'],
    ['• รหัสฝ่ายใหม่ — เช่น D001 (ดูรหัสด้านล่าง)'],
    [''],
    ['การทำงานของระบบ:'],
    ['• แต่ละแถวจะถูกบันทึกเป็น "ประวัติการปรับ" 1 รายการ'],
    ['• ทะเบียนพนักงานจะถูก update ตามค่าใหม่ทันที (snapshot ล่าสุด)'],
    ['• ค่าเก่า (old_*) ระบบจะดึงจาก state ปัจจุบันของพนักงานเอง — ไม่ต้องกรอก'],
    ['• change_type คำนวณอัตโนมัติจากฟิลด์ที่เปลี่ยน'],
    [''],
    ['รูปแบบวันที่:'],
    ['• DD/MM/YYYY  เช่น 01/06/2026  หรือ 01/06/2569 (พ.ศ.)'],
    ['• YYYY-MM-DD  เช่น 2026-06-01  (ISO)'],
    ['• Excel Date cell'],
    [''],
    ['รหัสฝ่ายที่มีในระบบ:'],
    ...depts.split('\n').map(s => ['• ' + s]),
    [''],
    ['รหัสตำแหน่งที่มีในระบบ:'],
    ...positions.split('\n').map(s => ['• ' + s])
  ];
  const wsNotes = XLSX.utils.aoa_to_sheet(notes);
  wsNotes['!cols'] = [{ wch: 80 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'การปรับ');
  XLSX.utils.book_append_sheet(wb, wsNotes, 'คำแนะนำ');
  XLSX.writeFile(wb, 'template-คชา-นำเข้าการปรับ.xlsx');
  toast('ดาวน์โหลด template แล้ว', 'success');
}

function exportEmployeeChangesXLSX() {
  if (!requireHR()) return; // 🔒 ประวัติการปรับเงินเดือน — sensitive สูง
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportEmployeeChangesXLSX, 800); return; }
  const list = DB.getSalaryHistory();
  if (!list.length) { toast('ยังไม่มีประวัติการปรับ', 'warning'); return; }
  const cs = csvSafe;
  const typeLabel = { salary: 'ปรับเงินเดือน', allowance: 'ปรับสวัสดิการ', position: 'ปรับตำแหน่ง', branch: 'ย้ายสาขา', department: 'ย้ายฝ่าย', multiple: 'ปรับหลายอย่าง' };
  const numOrEmpty = (v) => v != null ? Number(v) : '';
  const rows = list.map(h => {
    const e = DB.getEmployee(h.employeeId) || {};
    return {
      'วันที่': excelDate(h.date),
      'รหัสพนักงาน': excelNum(h.employeeId),
      'ชื่อ-นามสกุล': cs((e.firstName || '') + ' ' + (e.lastName || '')),
      'ประเภท': cs(typeLabel[h.changeType] || '-'),
      'เงินเดือนเก่า': Number(h.oldSalary || 0),
      'เงินเดือนใหม่': Number(h.newSalary || 0),
      'ส่วนต่างเงินเดือน': Number((h.newSalary || 0) - (h.oldSalary || 0)),
      'ค่าตำแหน่งเก่า': numOrEmpty(h.oldAllowancePosition),
      'ค่าตำแหน่งใหม่': numOrEmpty(h.newAllowancePosition),
      'ค่าเดินทางเก่า': numOrEmpty(h.oldAllowanceTravel),
      'ค่าเดินทางใหม่': numOrEmpty(h.newAllowanceTravel),
      'ค่าอาหารเก่า': numOrEmpty(h.oldAllowanceFood),
      'ค่าอาหารใหม่': numOrEmpty(h.newAllowanceFood),
      'ค่าเบี้ยเลี้ยงเก่า': numOrEmpty(h.oldAllowancePerDiem),
      'ค่าเบี้ยเลี้ยงใหม่': numOrEmpty(h.newAllowancePerDiem),
      'ค่าภาษาเก่า': numOrEmpty(h.oldAllowanceLanguage),
      'ค่าภาษาใหม่': numOrEmpty(h.newAllowanceLanguage),
      'ค่าโทรศัพท์เก่า': numOrEmpty(h.oldAllowancePhone),
      'ค่าโทรศัพท์ใหม่': numOrEmpty(h.newAllowancePhone),
      'ค่าอื่นๆเก่า': numOrEmpty(h.oldAllowanceOther),
      'ค่าอื่นๆใหม่': numOrEmpty(h.newAllowanceOther),
      'รหัสตำแหน่งเก่า': cs(h.oldPosition),
      'ชื่อตำแหน่งเก่า': cs(h.oldPositionTitle),
      'รหัสตำแหน่งใหม่': cs(h.newPosition),
      'ชื่อตำแหน่งใหม่': cs(h.newPositionTitle),
      'สาขาเก่า': cs(h.oldBranch),
      'สาขาใหม่': cs(h.newBranch),
      'รหัสฝ่ายเก่า': cs(h.oldDepartment),
      'รหัสฝ่ายใหม่': cs(h.newDepartment),
      'เหตุผล': cs(h.reason)
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  const headerKeys = Object.keys(rows[0] || {});
  const idIdx = headerKeys.indexOf('รหัสพนักงาน');
  if (idIdx >= 0) setColumnFormat(ws, idIdx, '0');
  // คอลัมน์เงินทุกตัว → format #,##0
  const moneyCols = ['เงินเดือนเก่า','เงินเดือนใหม่','ส่วนต่างเงินเดือน',
    'ค่าตำแหน่งเก่า','ค่าตำแหน่งใหม่','ค่าเดินทางเก่า','ค่าเดินทางใหม่',
    'ค่าอาหารเก่า','ค่าอาหารใหม่','ค่าเบี้ยเลี้ยงเก่า','ค่าเบี้ยเลี้ยงใหม่',
    'ค่าภาษาเก่า','ค่าภาษาใหม่','ค่าโทรศัพท์เก่า','ค่าโทรศัพท์ใหม่','ค่าอื่นๆเก่า','ค่าอื่นๆใหม่'];
  for (const col of moneyCols) {
    const idx = headerKeys.indexOf(col);
    if (idx >= 0) setColumnFormat(ws, idx, '#,##0');
  }
  ws['!cols'] = headerKeys.map(k => {
    if (k === 'วันที่') return { wch: 13 };
    if (k === 'รหัสพนักงาน') return { wch: 10 };
    if (k === 'ชื่อ-นามสกุล') return { wch: 22 };
    if (k === 'ประเภท' || k === 'เหตุผล') return { wch: 20 };
    return { wch: 14 };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ประวัติการปรับ');
  XLSX.writeFile(wb, `คชา-การปรับ-${tz.today()}.xlsx`);
  toast('ส่งออกไฟล์ Excel แล้ว', 'success');
}

function parseImportChangeRow(row) {
  const get = (k) => (row[k] == null ? '' : String(row[k])).trim();
  const num = (k) => {
    const v = row[k];
    if (v == null || v === '') return null;
    return Number(v);
  };
  const parseDate = (k) => {
    const v = row[k];
    if (!v) return '';
    if (v instanceof Date) return v.toLocaleDateString('en-CA', { timeZone: TZ });
    const s = String(v).trim();
    if (!s) return '';
    const yToCE = (y) => (y >= 2400 ? y - 543 : y);
    const pad = (n) => String(n).padStart(2, '0');
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
    if (m) return `${yToCE(+m[1])}-${pad(+m[2])}-${pad(+m[3])}`;
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
    if (m) return `${yToCE(+m[3])}-${pad(+m[2])}-${pad(+m[1])}`;
    return s;
  };
  return {
    employeeId: get('รหัสพนักงาน'),
    date: parseDate('วันที่มีผล') || tz.today(),
    newSalary: num('เงินเดือนใหม่'),
    newAllowancePosition: num('ค่าตำแหน่งใหม่'),
    newAllowanceTravel:   num('ค่าเดินทางใหม่'),
    newAllowanceFood:     num('ค่าอาหารใหม่'),
    newAllowancePerDiem:  num('ค่าเบี้ยเลี้ยงใหม่'),
    newAllowanceLanguage: num('ค่าภาษาใหม่'),
    newAllowancePhone:    num('ค่าโทรศัพท์ใหม่'),
    newAllowanceOther:    num('ค่าอื่นๆใหม่'),
    newPosition: get('รหัสตำแหน่งใหม่'),
    newPositionTitle: get('ชื่อตำแหน่งใหม่'),
    newBranch: get('สาขาใหม่'),
    newDepartment: get('รหัสฝ่ายใหม่'),
    reason: get('เหตุผล')
  };
}

function validateImportChangeRows(rows) {
  const errors = [];
  const empIds = new Set(DB.data.employees.map(e => String(e.id)));
  const deptIds = new Set(DB.getDepartments().map(d => d.id));
  const posIds = new Set(DB.getPositions().map(p => p.id));
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    if (!r.employeeId) { errors.push({ row: rowNum, msg: 'รหัสพนักงานว่าง' }); return; }
    if (!empIds.has(String(r.employeeId))) errors.push({ row: rowNum, msg: `ไม่พบรหัสพนักงาน: ${r.employeeId}` });
    if (r.newPosition && !posIds.has(r.newPosition)) errors.push({ row: rowNum, msg: `รหัสตำแหน่งไม่มีในระบบ: ${r.newPosition}` });
    if (r.newDepartment && !deptIds.has(r.newDepartment)) errors.push({ row: rowNum, msg: `รหัสฝ่ายไม่มีในระบบ: ${r.newDepartment}` });
    // ต้องมี new_* อย่างน้อย 1 อย่าง (รวม allowances)
    const hasChange = r.newSalary != null || r.newPosition || r.newPositionTitle || r.newBranch || r.newDepartment ||
      r.newAllowancePosition != null || r.newAllowanceTravel != null || r.newAllowanceFood != null ||
      r.newAllowancePerDiem != null || r.newAllowanceLanguage != null || r.newAllowanceOther != null;
    if (!hasChange) errors.push({ row: rowNum, msg: 'ไม่มีค่าใหม่อย่างน้อย 1 อย่าง' });
  });
  return errors;
}

async function readChangesExcelFile(file) {
  if (file.size > EXCEL_MAX_MB * 1024 * 1024) {
    throw new Error(`ไฟล์ใหญ่เกิน ${EXCEL_MAX_MB} MB`);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        await new Promise(r => setTimeout(r, 0));
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        const sheetName = wb.SheetNames.find(n => n.includes('การปรับ') || n.includes('ปรับ')) || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        await new Promise(r => setTimeout(r, 0));
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        resolve(rows.map(parseImportChangeRow));
      } catch (ex) { reject(ex); }
    };
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsArrayBuffer(file);
  });
}

function openImportEmployeeChanges() {
  if (!requireHR()) return;
  modal.open('นำเข้าการปรับ (Excel)', `
    <div class="import-flow">
      <div class="import-step">
        <div class="import-step-num">1</div>
        <div class="import-step-body">
          <div class="import-step-title">ดาวน์โหลด Template</div>
          <div class="muted-2" style="font-size:13px;margin-bottom:8px">มีตัวอย่าง 3 แถว — ปรับเงินเดือน, ย้ายสาขา, ปรับหลายอย่างพร้อมกัน</div>
          <button class="btn btn-secondary btn-sm" onclick="downloadEmployeeChangesTemplate()">${ICON.download}ดาวน์โหลด Template</button>
        </div>
      </div>
      <div class="import-step">
        <div class="import-step-num">2</div>
        <div class="import-step-body">
          <div class="import-step-title">เลือกไฟล์ Excel ที่กรอกแล้ว</div>
          <input type="file" accept=".xlsx,.xls,.csv" id="chgImportFile" class="import-file">
        </div>
      </div>
      <div id="chgImportBody"></div>
    </div>
  `, {
    size: 'lg',
    footer: `<button class="btn btn-secondary" data-close>ปิด</button><button class="btn btn-primary" id="chgImportStartBtn" disabled>เริ่มนำเข้า</button>`
  });

  let parsedRows = null;
  let validationErrors = [];

  $('#chgImportFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#chgImportBody').innerHTML = '<div class="muted-2 mt-4">กำลังอ่านไฟล์...</div>';
    try {
      parsedRows = await readChangesExcelFile(file);
      validationErrors = validateImportChangeRows(parsedRows);
      $('#chgImportBody').innerHTML = renderChangeImportPreview(parsedRows, validationErrors);
      $('#chgImportStartBtn').disabled = validationErrors.length > 0 || parsedRows.length === 0;
    } catch (ex) {
      $('#chgImportBody').innerHTML = `<div class="card mt-4" style="border-color:var(--danger);color:var(--danger)">อ่านไฟล์ไม่สำเร็จ: ${escapeHtml(ex.message)}</div>`;
      $('#chgImportStartBtn').disabled = true;
    }
  });

  $('#chgImportStartBtn').addEventListener('click', async () => {
    if (!parsedRows || !parsedRows.length) return;
    $('#chgImportStartBtn').disabled = true;
    $('#chgImportBody').innerHTML = `
      <div class="card mt-4">
        <div style="margin-bottom:10px">กำลังนำเข้า <strong id="chgProgressText">0</strong> / <strong>${parsedRows.length.toLocaleString()}</strong></div>
        <div class="progress-bar"><div class="progress-fill" id="chgProgressFill" style="width:0%"></div></div>
        <div class="muted-2 mt-2" style="font-size:12px">บันทึกประวัติ + อัปเดตทะเบียนพนักงานทีละแถว — ห้ามปิดหน้าต่างนี้</div>
      </div>
    `;
    const start = performance.now();
    const result = await DB.bulkAddSalaryAdjustments(parsedRows, (done, total) => {
      const pct = (done / total) * 100;
      const fill = $('#chgProgressFill');
      const text = $('#chgProgressText');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = done.toLocaleString();
    });
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);

    $('#chgImportBody').innerHTML = `
      <div class="card mt-4">
        <div style="font-size:16px;font-weight:600;color:var(--success);margin-bottom:8px">✓ นำเข้าสำเร็จ</div>
        <div style="font-size:14px;line-height:1.8">
          • สำเร็จ: <strong>${result.inserted.toLocaleString()}</strong> รายการ<br>
          ${result.failed ? `• ผิดพลาด: <strong style="color:var(--danger)">${result.failed.toLocaleString()}</strong> รายการ<br>` : ''}
          • ใช้เวลา: <strong>${elapsed}</strong> วินาที
        </div>
        ${result.errors.length ? `
          <details class="mt-2" style="font-size:13px">
            <summary style="cursor:pointer;color:var(--danger)">ดูข้อผิดพลาด (${result.errors.length})</summary>
            <ul style="margin-top:6px;padding-left:20px;max-height:200px;overflow-y:auto">${result.errors.slice(0, 50).map(e => `<li>แถวที่ ${e.row}: ${escapeHtml(e.message)}</li>`).join('')}</ul>
          </details>
        ` : ''}
      </div>
    `;
    parsedRows = null;
    const finishBtn = $('#chgImportStartBtn');
    finishBtn.textContent = 'เสร็จสิ้น';
    finishBtn.disabled = false;
    finishBtn.setAttribute('data-close', '');
    if (router.current === 'salary-adjust') router.go('salary-adjust');
  });
}

function renderChangeImportPreview(rows, errors) {
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
          <thead><tr><th>รหัส</th><th>วันที่</th><th class="num">เงินเดือน</th><th>ตำแหน่ง</th><th>สาขา</th><th>ฝ่าย</th></tr></thead>
          <tbody>
            ${sample.map(r => `<tr>
              <td>${escapeHtml(r.employeeId || '-')}</td>
              <td>${escapeHtml(r.date)}</td>
              <td class="num">${r.newSalary != null ? fmt.money(r.newSalary) : '-'}</td>
              <td>${escapeHtml(r.newPositionTitle || r.newPosition || '-')}</td>
              <td>${escapeHtml(r.newBranch || '-')}</td>
              <td>${escapeHtml(r.newDepartment || '-')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════
//  PAGE: LOANS
// ═══════════════════════════════════════════════════════
router.register('loans', () => {
  const loans = DB.getLoans();
  const active = loans.filter(l => l.status !== 'completed');
  const totalOut = loans.reduce((s, l) => s + Number(l.amount || 0), 0);
  const totalRem = active.reduce((s, l) => s + Number(l.remaining || 0), 0);
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">การกู้เงินบริษัท</div>
        <div class="sw-page-subtitle">บันทึกการให้กู้และติดตามยอดผ่อนต่อพนักงาน</div>
      </div>
      <div class="sw-page-actions">${DB.isHR ? '<button class="btn btn-primary" onclick="openLoanForm()">+ บันทึกการกู้</button>' : ''}</div>
    </div>
    <div class="sw-stats-grid" style="margin-bottom:28px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,58,138,0.12);color:var(--primary)">${ICON.bank}</div>
        <div class="sw-stat-label">รายการกู้ทั้งหมด</div>
        <div class="sw-stat-value">${fmt.num(loans.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">รวมทุกสถานะ</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(217,119,6,0.12);color:var(--warning)">⏳</div>
        <div class="sw-stat-label">กำลังผ่อน</div>
        <div class="sw-stat-value" style="color:var(--warning)">${fmt.num(active.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">ยังไม่ปิดยอด</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(124,58,237,0.12);color:#7c3aed">💰</div>
        <div class="sw-stat-label">ยอดให้กู้รวม</div>
        <div class="sw-stat-value">${fmt.money(totalOut)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">บาท · สะสมตลอด</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(220,38,38,0.12);color:var(--danger)">📌</div>
        <div class="sw-stat-label">ยอดคงเหลือ</div>
        <div class="sw-stat-value" style="color:var(--danger)">${fmt.money(totalRem)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">บาท · ที่ต้องเก็บ</div>
      </div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายการกู้ <span class="sw-chart-count">${fmt.num(loans.length)}</span></div>
          <div class="sw-chart-sub">เรียงจากใหม่สุด · ปิดยอด = ผ่อนหมดแล้ว</div>
        </div>
      </div>
      ${loans.length ? `
      <div class="table-wrap"><table class="table table-compact sw-emp-table">
        <thead><tr><th>วันที่</th><th>พนักงาน</th><th class="num">จำนวน</th><th class="num">ผ่อน/เดือน</th><th class="num">คงเหลือ</th><th>สถานะ</th><th>เหตุผล</th><th></th></tr></thead>
        <tbody>
          ${loans.map(l => { const e = DB.getEmployee(l.employeeId) || {}; return `<tr>
              <td class="sw-cell-meta">${fmt.date(l.date)}</td>
              <td>
                <div class="sw-emp-cell">
                  <strong>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</strong>
                  <span class="muted-2">${escapeHtml(l.employeeId || '—')}${e.branch ? ' · ' + escapeHtml(e.branch) : ''}</span>
                </div>
              </td>
              <td class="num"><strong>${fmt.money(l.amount)}</strong></td>
              <td class="num">${fmt.money(l.monthlyPayment)}</td>
              <td class="num" style="color:${Number(l.remaining) > 0 ? 'var(--danger)' : 'var(--text-2)'}">${fmt.money(l.remaining)}</td>
              <td>${l.status === 'completed' ? '<span class="badge badge-success">✓ ปิดยอด</span>' : '<span class="badge badge-warning">⏳ ผ่อนอยู่</span>'}</td>
              <td class="sw-reason-cell">${escapeHtml(l.reason || '—')}</td>
              <td class="actions">${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openLoanForm('${l.id}')">แก้</button><button class="btn btn-ghost btn-sm" onclick="deleteLoanRec('${l.id}')">ลบ</button>` : ''}</td>
            </tr>`; }).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state" style="padding:60px 20px">
        <div style="font-size:42px;margin-bottom:12px;opacity:0.35">🏦</div>
        <div class="title" style="font-size:16px;font-weight:600">ยังไม่มีรายการกู้</div>
        <div class="hint" style="margin-top:6px">กดปุ่ม + บันทึกการกู้ เพื่อเริ่ม</div>
      </div>`}
    </div>`;
});

function openLoanForm(id = null) {
  if (!requireHR()) return;
  const l = id ? DB.getLoans().find(x => x.id === id) : { id: '', employeeId: '', date: tz.today(), amount: 0, monthlyPayment: 0, remaining: 0, status: 'active', reason: '' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไขการกู้' : 'บันทึกการกู้', `
    <form id="loanForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label>${employeePicker({ name: 'employeeId', emps, selected: l.employeeId, required: true })}</div>
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${l.date}" required/></div>
        <div class="form-group"><label>จำนวนที่กู้ *</label><input name="amount" type="number" min="0" value="${l.amount}" required/></div>
        <div class="form-group"><label>ผ่อนต่อเดือน</label><input name="monthlyPayment" type="number" min="0" value="${l.monthlyPayment}"/></div>
        <div class="form-group"><label>ยอดคงเหลือ</label><input name="remaining" type="number" min="0" value="${l.remaining}"/></div>
        <div class="form-group span-2"><label>สถานะ</label><select name="status"><option value="active" ${l.status === 'active' ? 'selected' : ''}>ผ่อนอยู่</option><option value="completed" ${l.status === 'completed' ? 'selected' : ''}>ปิดยอด</option></select></div>
        <div class="form-group span-2"><label>เหตุผล</label><textarea name="reason" rows="2">${escapeHtml(l.reason)}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  wireEmployeePickers('#loanForm');
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
  if (!requireHR()) return;
  if (!await modal.confirm('ลบรายการกู้', 'ยืนยันการลบ?')) return;
  try { await DB.deleteLoan(id); toast('ลบแล้ว', 'success'); router.go('loans'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: ADVANCES
// ═══════════════════════════════════════════════════════
router.register('advances', () => {
  const list = DB.getAdvances();
  const pending = list.filter(a => a.status === 'pending');
  const paid = list.filter(a => a.status === 'paid');
  const totalPending = pending.reduce((s, a) => s + Number(a.amount || 0), 0);
  const thisMonth = (new Date()).toISOString().slice(0, 7);
  const monthList = list.filter(a => (a.date || '').startsWith(thisMonth));
  const totalMonth = monthList.reduce((s, a) => s + Number(a.amount || 0), 0);
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">เบิกเงินเดือนล่วงหน้า</div>
        <div class="sw-page-subtitle">รายการเบิกจ่ายเงินล่วงหน้าจากเงินเดือนของพนักงาน</div>
      </div>
      <div class="sw-page-actions">${DB.isHR ? '<button class="btn btn-primary" onclick="openAdvanceForm()">+ บันทึกการเบิก</button>' : ''}</div>
    </div>
    <div class="sw-stats-grid" style="margin-bottom:28px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,58,138,0.12);color:var(--primary)">${ICON.cash}</div>
        <div class="sw-stat-label">รายการทั้งหมด</div>
        <div class="sw-stat-value">${fmt.num(list.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">รวมทุกสถานะ</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(217,119,6,0.12);color:var(--warning)">⏳</div>
        <div class="sw-stat-label">รอจ่าย</div>
        <div class="sw-stat-value" style="color:${pending.length > 0 ? 'var(--warning)' : 'var(--text)'}">${fmt.num(pending.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">รวม ${fmt.money(totalPending)} บาท</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(22,163,74,0.12);color:var(--success)">✓</div>
        <div class="sw-stat-label">จ่ายแล้ว</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(paid.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">สะสมตลอด</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(124,58,237,0.12);color:#7c3aed">📅</div>
        <div class="sw-stat-label">เบิกเดือนนี้</div>
        <div class="sw-stat-value">${fmt.money(totalMonth)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">บาท · ${fmt.num(monthList.length)} รายการ</div>
      </div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายการเบิก <span class="sw-chart-count">${fmt.num(list.length)}</span></div>
          <div class="sw-chart-sub">เรียงจากใหม่สุด · เปลี่ยนสถานะเป็น "จ่ายแล้ว" หลังโอนเงินให้พนักงาน</div>
        </div>
      </div>
      ${list.length ? `
      <div class="table-wrap"><table class="table table-compact sw-emp-table">
        <thead><tr><th>วันที่</th><th>พนักงาน</th><th class="num">จำนวน</th><th>เหตุผล</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>
          ${list.map(a => { const e = DB.getEmployee(a.employeeId) || {}; return `<tr>
              <td class="sw-cell-meta">${fmt.date(a.date)}</td>
              <td>
                <div class="sw-emp-cell">
                  <strong>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</strong>
                  <span class="muted-2">${escapeHtml(a.employeeId || '—')}${e.branch ? ' · ' + escapeHtml(e.branch) : ''}</span>
                </div>
              </td>
              <td class="num"><strong>${fmt.money(a.amount)}</strong></td>
              <td class="sw-reason-cell">${escapeHtml(a.reason || '—')}</td>
              <td>${a.status === 'paid' ? '<span class="badge badge-success">✓ จ่ายแล้ว</span>' : '<span class="badge badge-warning">⏳ รอจ่าย</span>'}</td>
              <td class="actions">${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openAdvanceForm('${a.id}')">แก้</button><button class="btn btn-ghost btn-sm" onclick="deleteAdvRec('${a.id}')">ลบ</button>` : ''}</td>
            </tr>`; }).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state" style="padding:60px 20px">
        <div style="font-size:42px;margin-bottom:12px;opacity:0.35">💵</div>
        <div class="title" style="font-size:16px;font-weight:600">ยังไม่มีรายการเบิก</div>
        <div class="hint" style="margin-top:6px">กดปุ่ม + บันทึกการเบิก เพื่อเริ่ม</div>
      </div>`}
    </div>`;
});

function openAdvanceForm(id = null) {
  if (!requireHR()) return;
  const a = id ? DB.getAdvances().find(x => x.id === id) : { employeeId: '', date: tz.today(), amount: 0, reason: '', status: 'pending' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไข' : 'บันทึกการเบิกล่วงหน้า', `
    <form id="advForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label>${employeePicker({ name: 'employeeId', emps, selected: a.employeeId, required: true })}</div>
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${a.date}" required/></div>
        <div class="form-group"><label>จำนวน *</label><input name="amount" type="number" min="0" value="${a.amount}" required/></div>
        <div class="form-group span-2"><label>สถานะ</label><select name="status"><option value="pending" ${a.status === 'pending' ? 'selected' : ''}>รอจ่าย</option><option value="paid" ${a.status === 'paid' ? 'selected' : ''}>จ่ายแล้ว</option></select></div>
        <div class="form-group span-2"><label>เหตุผล</label><textarea name="reason" rows="2">${escapeHtml(a.reason)}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  wireEmployeePickers('#advForm');
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
  if (!requireHR()) return;
  if (!await modal.confirm('ลบ', 'ยืนยัน?')) return;
  try { await DB.deleteAdvance(id); toast('ลบแล้ว', 'success'); router.go('advances'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: ALLOWANCE
// ═══════════════════════════════════════════════════════
router.register('allowance', () => {
  const list = DB.getAllowances();
  const thisMonth = (new Date()).toISOString().slice(0, 7);
  const monthList = list.filter(a => a.month === thisMonth);
  const totalMonth = monthList.reduce((s, a) => s + Number(a.amount || 0), 0);
  const total = list.reduce((s, a) => s + Number(a.amount || 0), 0);
  // group by type
  const byType = {};
  for (const a of list) byType[a.type || 'อื่นๆ'] = (byType[a.type || 'อื่นๆ'] || 0) + Number(a.amount || 0);
  const topType = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">เบี้ยเลี้ยงรายเดือน</div>
        <div class="sw-page-subtitle">บันทึกเบี้ยเลี้ยงพิเศษ — ค่าเดินทาง · ค่าโทรศัพท์ · ค่าตำแหน่ง · ค่าครองชีพ ฯลฯ</div>
      </div>
      <div class="sw-page-actions">${DB.isHR ? '<button class="btn btn-primary" onclick="openAllowanceForm()">+ บันทึก</button>' : ''}</div>
    </div>
    <div class="sw-stats-grid" style="margin-bottom:28px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,58,138,0.12);color:var(--primary)">${ICON.clipboard}</div>
        <div class="sw-stat-label">รายการทั้งหมด</div>
        <div class="sw-stat-value">${fmt.num(list.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">สะสมทุกเดือน</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(22,163,74,0.12);color:var(--success)">📅</div>
        <div class="sw-stat-label">เดือนนี้</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(monthList.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">${fmt.money(totalMonth)} บาท</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(124,58,237,0.12);color:#7c3aed">💰</div>
        <div class="sw-stat-label">รวมทั้งหมด</div>
        <div class="sw-stat-value">${fmt.money(total)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">บาท · สะสม</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(217,119,6,0.12);color:var(--warning)">🏆</div>
        <div class="sw-stat-label">ประเภทยอดสูงสุด</div>
        <div class="sw-stat-value" style="font-size:20px">${topType ? escapeHtml(topType[0]) : '—'}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">${topType ? fmt.money(topType[1]) + ' บาท' : ''}</div>
      </div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายการเบี้ยเลี้ยง <span class="sw-chart-count">${fmt.num(list.length)}</span></div>
          <div class="sw-chart-sub">เรียงจากใหม่สุด · กลุ่มตามเดือนและประเภท</div>
        </div>
      </div>
      ${list.length ? `
      <div class="table-wrap"><table class="table table-compact sw-emp-table">
        <thead><tr><th>เดือน</th><th>พนักงาน</th><th>ประเภท</th><th class="num">จำนวน</th><th>หมายเหตุ</th><th></th></tr></thead>
        <tbody>
          ${list.map(a => { const e = DB.getEmployee(a.employeeId) || {}; return `<tr>
              <td class="sw-cell-meta">${escapeHtml(a.month || '—')}</td>
              <td>
                <div class="sw-emp-cell">
                  <strong>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</strong>
                  <span class="muted-2">${escapeHtml(a.employeeId || '—')}${e.branch ? ' · ' + escapeHtml(e.branch) : ''}</span>
                </div>
              </td>
              <td><span class="badge badge-info" style="font-size:11px">${escapeHtml(a.type || '—')}</span></td>
              <td class="num"><strong>${fmt.money(a.amount)}</strong></td>
              <td class="sw-reason-cell">${escapeHtml(a.note || '—')}</td>
              <td class="actions">${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openAllowanceForm('${a.id}')">แก้</button><button class="btn btn-ghost btn-sm" onclick="deleteAllowRec('${a.id}')">ลบ</button>` : ''}</td>
            </tr>`; }).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state" style="padding:60px 20px">
        <div style="font-size:42px;margin-bottom:12px;opacity:0.35">📋</div>
        <div class="title" style="font-size:16px;font-weight:600">ยังไม่มีรายการเบี้ยเลี้ยง</div>
        <div class="hint" style="margin-top:6px">กดปุ่ม + บันทึก เพื่อเริ่ม</div>
      </div>`}
    </div>`;
});

function openAllowanceForm(id = null) {
  if (!requireHR()) return;
  const a = id ? DB.getAllowances().find(x => x.id === id) : { employeeId: '', month: tz.thisMonth(), type: 'ค่าเดินทาง', amount: 0, note: '' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไข' : 'บันทึกเบี้ยเลี้ยง', `
    <form id="allowForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label>${employeePicker({ name: 'employeeId', emps, selected: a.employeeId, required: true })}</div>
        <div class="form-group"><label>เดือน *</label><input name="month" type="month" value="${a.month}" required/></div>
        <div class="form-group"><label>ประเภท</label><select name="type">${['ค่าเดินทาง', 'ค่าโทรศัพท์', 'ค่าตำแหน่ง', 'ค่าครองชีพ', 'อื่นๆ'].map(t => `<option ${a.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="form-group span-2"><label>จำนวน *</label><input name="amount" type="number" min="0" value="${a.amount}" required/></div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="2">${escapeHtml(a.note)}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  wireEmployeePickers('#allowForm');
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
  if (!requireHR()) return;
  if (!await modal.confirm('ลบ', 'ยืนยัน?')) return;
  try { await DB.deleteAllowance(id); toast('ลบแล้ว', 'success'); router.go('allowance'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: EVALUATIONS
// ═══════════════════════════════════════════════════════
router.register('evaluations', () => {
  const list = DB.getEvaluations();
  const avgScore = list.length ? Math.round(list.reduce((s, v) => s + Number(v.score || 0), 0) / list.length * 10) / 10 : 0;
  const aCount = list.filter(v => Number(v.score) >= 80).length;
  const fCount = list.filter(v => Number(v.score) < 50).length;
  const gradeColor = (s) => s >= 90 ? 'var(--success)' : s >= 70 ? 'var(--primary)' : s >= 50 ? 'var(--warning)' : 'var(--danger)';
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ประเมินผลงาน</div>
        <div class="sw-page-subtitle">บันทึกคะแนนและเกรดของพนักงานต่อรอบประเมิน</div>
      </div>
      <div class="sw-page-actions">${DB.isHR ? '<button class="btn btn-primary" onclick="openEvalForm()">+ บันทึกการประเมิน</button>' : ''}</div>
    </div>
    <div class="sw-stats-grid" style="margin-bottom:28px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,58,138,0.12);color:var(--primary)">${ICON.chart}</div>
        <div class="sw-stat-label">รายการประเมิน</div>
        <div class="sw-stat-value">${fmt.num(list.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">รวมทุกรอบ</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(124,58,237,0.12);color:#7c3aed">📊</div>
        <div class="sw-stat-label">คะแนนเฉลี่ย</div>
        <div class="sw-stat-value" style="color:${gradeColor(avgScore)}">${avgScore}<span style="font-size:18px;color:var(--text-2);font-weight:500"> /100</span></div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">ทุกการประเมิน</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(22,163,74,0.12);color:var(--success)">🏆</div>
        <div class="sw-stat-label">เกรดดี (B+ ขึ้น)</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(aCount)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">คะแนน 80+</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(220,38,38,0.12);color:var(--danger)">⚠️</div>
        <div class="sw-stat-label">เกรดต่ำ (D ลง)</div>
        <div class="sw-stat-value" style="color:${fCount > 0 ? 'var(--danger)' : 'var(--text)'}">${fmt.num(fCount)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">คะแนนต่ำกว่า 50</div>
      </div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">ประวัติการประเมิน <span class="sw-chart-count">${fmt.num(list.length)}</span></div>
          <div class="sw-chart-sub">เรียงจากใหม่สุด · เกรด: A 90+ · B+ 80+ · B 70+ · C 60+ · D 50+ · F < 50</div>
        </div>
      </div>
      ${list.length ? `
      <div class="table-wrap"><table class="table table-compact sw-emp-table">
        <thead><tr><th>วันที่</th><th>พนักงาน</th><th>รอบ</th><th class="num">คะแนน</th><th>เกรด</th><th>หมายเหตุ</th><th></th></tr></thead>
        <tbody>
          ${list.map(v => { const e = DB.getEmployee(v.employeeId) || {}; const sc = Number(v.score || 0); return `<tr>
              <td class="sw-cell-meta">${fmt.date(v.date)}</td>
              <td>
                <div class="sw-emp-cell">
                  <strong>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</strong>
                  <span class="muted-2">${escapeHtml(v.employeeId || '—')}${e.branch ? ' · ' + escapeHtml(e.branch) : ''}</span>
                </div>
              </td>
              <td class="sw-cell-meta">${escapeHtml(v.period || '—')}</td>
              <td class="num"><strong style="color:${gradeColor(sc)};font-size:14px">${v.score}</strong><span class="muted-2" style="font-size:11px">/100</span></td>
              <td><span class="badge ${sc >= 80 ? 'badge-success' : sc >= 50 ? 'badge-info' : 'badge-danger'}">${escapeHtml(v.grade || '—')}</span></td>
              <td class="sw-reason-cell">${escapeHtml(v.note || '—')}</td>
              <td class="actions">${DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="openEvalForm('${v.id}')">แก้</button><button class="btn btn-ghost btn-sm" onclick="deleteEvalRec('${v.id}')">ลบ</button>` : ''}</td>
            </tr>`; }).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state" style="padding:60px 20px">
        <div style="font-size:42px;margin-bottom:12px;opacity:0.35">⭐</div>
        <div class="title" style="font-size:16px;font-weight:600">ยังไม่มีการประเมิน</div>
        <div class="hint" style="margin-top:6px">กดปุ่ม + บันทึกการประเมิน เพื่อเริ่ม</div>
      </div>`}
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
  if (!requireHR()) return;
  const v = id ? DB.getEvaluations().find(x => x.id === id) : { employeeId: '', date: tz.today(), period: 'ครึ่งปี ' + tz.thisYear(), score: 0, grade: 'C', note: '' };
  const emps = DB.getEmployees({ status: 'active' });
  modal.open(id ? 'แก้ไข' : 'บันทึกการประเมิน', `
    <form id="evalForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label>${employeePicker({ name: 'employeeId', emps, selected: v.employeeId, required: true })}</div>
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${v.date}" required/></div>
        <div class="form-group"><label>รอบประเมิน</label><input name="period" value="${escapeHtml(v.period)}" placeholder="เช่น ครึ่งปี 2026"/></div>
        <div class="form-group"><label>คะแนน (0-100) *</label><input id="scoreInput" name="score" type="number" min="0" max="100" value="${v.score}" required/></div>
        <div class="form-group"><label>เกรด</label><input id="gradeInput" name="grade" value="${v.grade}" readonly/></div>
        <div class="form-group span-2"><label>หมายเหตุ</label><textarea name="note" rows="3">${escapeHtml(v.note)}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div>
    </form>`);
  wireEmployeePickers('#evalForm');
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
  if (!requireHR()) return;
  if (!await modal.confirm('ลบ', 'ยืนยัน?')) return;
  try { await DB.deleteEvaluation(id); toast('ลบแล้ว', 'success'); router.go('evaluations'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: REPORTS
// ═══════════════════════════════════════════════════════
router.register('reports', () => {
  // 🔒 RBAC Guard — admin + HR เท่านั้น (มีข้อมูล payroll/loan ที่อ่อนไหวระดับ company-wide)
  if (!DB.isHR) {
    return `<div class="sw-chart-card"><div class="empty-state" style="padding:80px 20px">
      <div style="font-size:48px;margin-bottom:14px;opacity:0.4">🔒</div>
      <div class="title" style="font-size:17px;font-weight:600">เฉพาะ Admin / HR เท่านั้น</div>
      <div class="hint" style="margin-top:6px">รายงานเงินเดือนและข้อมูลส่งออกเป็นข้อมูลภายในของ HR/การเงิน</div>
    </div></div>`;
  }
  const s = DB.getStats();
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">รายงาน · ส่งออกข้อมูล</div>
        <div class="sw-page-subtitle">สรุปยอดและส่งออกข้อมูลเป็นไฟล์ Excel/JSON</div>
      </div>
    </div>
    <div class="sw-stats-grid" style="margin-bottom:28px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,58,138,0.12);color:var(--primary)">${ICON.users}</div>
        <div class="sw-stat-label">พนักงานปฏิบัติงาน</div>
        <div class="sw-stat-value">${fmt.num(s.activeEmployees)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">คน · ปัจจุบัน</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(22,163,74,0.12);color:var(--success)">${ICON.money}</div>
        <div class="sw-stat-label">ค่าใช้จ่ายต่อเดือน</div>
        <div class="sw-stat-value" style="color:var(--success);font-size:24px">${fmt.money(s.totalMonthlySalary)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">บาท · เงินเดือนรวม</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(124,58,237,0.12);color:#7c3aed">${ICON.trendUp}</div>
        <div class="sw-stat-label">ค่าใช้จ่ายต่อปี</div>
        <div class="sw-stat-value" style="font-size:24px">${fmt.money(s.totalMonthlySalary * 12)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">บาท · คาดการณ์</div>
      </div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">ส่งออกข้อมูล (Export)</div>
          <div class="sw-chart-sub">ดาวน์โหลดไฟล์เพื่อเก็บสำรอง · นำไปทำต่อใน Excel · หรือนำเข้าระบบอื่น</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
        <button class="btn btn-primary" onclick="openMultiSheetExportModal()" style="justify-content:flex-start;padding:14px 16px">${ICON.download}<span style="margin-left:8px">📊 Multi-sheet (เลือกตัวกรอง)</span></button>
        <button class="btn btn-secondary" onclick="exportEmployeesXLSX()" style="justify-content:flex-start;padding:14px 16px">${ICON.download}<span style="margin-left:8px">พนักงาน (Excel)</span></button>
        <button class="btn btn-secondary" onclick="exportPayrollXLSX()" style="justify-content:flex-start;padding:14px 16px">${ICON.download}<span style="margin-left:8px">บัญชีเงินเดือน (Excel)</span></button>
        <button class="btn btn-secondary" onclick="exportLoansXLSX()" style="justify-content:flex-start;padding:14px 16px">${ICON.download}<span style="margin-left:8px">รายการกู้ (Excel)</span></button>
        <button class="btn btn-secondary" onclick="exportDataJSON()" style="justify-content:flex-start;padding:14px 16px">${ICON.download}<span style="margin-left:8px">สำรองข้อมูลทั้งหมด (JSON)</span></button>
      </div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">สรุปพนักงานตามฝ่าย</div>
          <div class="sw-chart-sub">เฉพาะที่ปฏิบัติงานอยู่ · คำนวณเงินเดือนเฉลี่ยและรวม</div>
        </div>
      </div>
      <div class="table-wrap"><table class="table table-compact sw-emp-table">
        <thead><tr><th>ฝ่าย</th><th class="num">จำนวน</th><th class="num">เงินเดือนรวม</th><th class="num">เฉลี่ย/คน</th></tr></thead>
        <tbody>
          ${DB.getDepartments().map(d => {
            const list = DB.getEmployees({ status: 'active' }).filter(e => e.department === d.id);
            const sum = list.reduce((s, e) => s + (e.salary || 0), 0);
            return `<tr>
              <td><strong>${escapeHtml(d.name)}</strong></td>
              <td class="num"><strong>${fmt.num(list.length)}</strong><span class="muted-2" style="font-size:11px"> คน</span></td>
              <td class="num"><strong>${fmt.money(sum)}</strong></td>
              <td class="num">${fmt.money(list.length ? sum / list.length : 0)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>`;
});

function exportPayrollXLSX() {
  if (!requireHR()) return; // 🔒 เฉพาะ admin/HR — บัญชีเงินเดือนทั้งบริษัท
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportPayrollXLSX, 800); return; }
  const cs = csvSafe;
  const month = tz.thisMonth();
  const rows = DB.getEmployees({ status: 'active' }).map(e => {
    const extraAllow = DB.getAllowances(e.id).filter(a => a.month === month).reduce((s, a) => s + (a.amount || 0), 0);
    const adv = DB.getAdvances(e.id).filter(a => a.status === 'paid' && (a.date || '').startsWith(month)).reduce((s, a) => s + (a.amount || 0), 0);
    const loanDed = DB.getLoans(e.id).filter(l => l.status === 'active').reduce((s, l) => s + (l.monthlyPayment || 0), 0);
    const gross = totalIncome(e) + extraAllow;
    const net = gross - adv - loanDed;
    return {
      'รหัส': excelNum(e.id),
      'ชื่อ-นามสกุล': cs((e.title || '') + e.firstName + ' ' + e.lastName),
      'ฝ่าย': cs((DB.getDepartment(e.department) || {}).name || ''),
      'ตำแหน่ง': cs(e.positionTitle),
      'เลขบัญชี': cs((e.bank ? e.bank + ' ' : '') + (e.bankAccount || '')),
      'เงินเดือน': Number(e.salary || 0),
      'ค่าตำแหน่ง': Number(e.allowancePosition || 0),
      'ค่าเดินทาง': Number(e.allowanceTravel || 0),
      'ค่าอาหาร': Number(e.allowanceFood || 0),
      'ค่าเบี้ยเลี้ยง': Number(e.allowancePerDiem || 0),
      'ค่าภาษา': Number(e.allowanceLanguage || 0),
      'ค่าโทรศัพท์': Number(e.allowancePhone || 0),
      'ค่าอื่นๆ': Number(e.allowanceOther || 0),
      'เบี้ยเลี้ยงพิเศษ': Number(extraAllow),
      'รวมรายได้': Number(gross),
      'หักเบิกล่วงหน้า': Number(adv),
      'หักผ่อนกู้': Number(loanDed),
      'รับสุทธิ': Number(net)
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  const headerKeys = Object.keys(rows[0] || {});
  // รหัส → '0' (เลขล้วน); เงิน → '#,##0' (มี comma)
  const idIdx = headerKeys.indexOf('รหัส');
  if (idIdx >= 0) setColumnFormat(ws, idIdx, '0');
  const moneyCols = ['เงินเดือน','ค่าตำแหน่ง','ค่าเดินทาง','ค่าอาหาร','ค่าเบี้ยเลี้ยง','ค่าภาษา','ค่าโทรศัพท์','ค่าอื่นๆ','เบี้ยเลี้ยงพิเศษ','รวมรายได้','หักเบิกล่วงหน้า','หักผ่อนกู้','รับสุทธิ'];
  for (const col of moneyCols) {
    const idx = headerKeys.indexOf(col);
    if (idx >= 0) setColumnFormat(ws, idx, '#,##0');
  }
  ws['!cols'] = headerKeys.map(k => {
    if (k === 'รหัส') return { wch: 8 };
    if (k === 'ชื่อ-นามสกุล') return { wch: 22 };
    if (k === 'ฝ่าย' || k === 'ตำแหน่ง') return { wch: 18 };
    if (k === 'เลขบัญชี') return { wch: 28 };
    return { wch: 12 };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'เงินเดือน ' + month);
  XLSX.writeFile(wb, `คชา-เงินเดือน-${month}.xlsx`);
  toast('ส่งออกบัญชีเงินเดือนแล้ว', 'success');
}

function exportLoansXLSX() {
  if (!requireHR()) return; // 🔒 เฉพาะ admin/HR — รายการกู้ทั้งบริษัท
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(exportLoansXLSX, 800); return; }
  const cs = csvSafe;
  const rows = DB.getLoans().map(l => {
    const e = DB.getEmployee(l.employeeId) || {};
    return {
      'วันที่': excelDate(l.date),
      'รหัสพนักงาน': excelNum(l.employeeId),
      'ชื่อ-นามสกุล': cs((e.firstName || '') + ' ' + (e.lastName || '')),
      'จำนวนกู้': Number(l.amount || 0),
      'ผ่อน/เดือน': Number(l.monthlyPayment || 0),
      'คงเหลือ': Number(l.remaining || 0),
      'สถานะ': l.status === 'completed' ? 'ปิดยอด' : 'ผ่อนอยู่',
      'เหตุผล': cs(l.reason || '')
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd mmm yyyy' });
  const headerKeys = Object.keys(rows[0] || {});
  const idIdx = headerKeys.indexOf('รหัสพนักงาน');
  if (idIdx >= 0) setColumnFormat(ws, idIdx, '0');
  for (const col of ['จำนวนกู้', 'ผ่อน/เดือน', 'คงเหลือ']) {
    const idx = headerKeys.indexOf(col);
    if (idx >= 0) setColumnFormat(ws, idx, '#,##0');
  }
  ws['!cols'] = headerKeys.map(k => {
    if (k === 'วันที่') return { wch: 13 };
    if (k === 'รหัสพนักงาน') return { wch: 10 };
    if (k === 'ชื่อ-นามสกุล') return { wch: 22 };
    if (k === 'เหตุผล') return { wch: 24 };
    return { wch: 12 };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'การกู้');
  XLSX.writeFile(wb, `คชา-รายการกู้-${tz.today()}.xlsx`);
  toast('ส่งออกแล้ว', 'success');
}

// ─── MULTI-SHEET EXPORT — เลือกตัวกรอง + สรุปข้อมูลใน 1 ไฟล์ Excel ─────
// User เลือก scope (สาขา/ฝ่าย/สายงาน/ช่วงเวลา/แสดงเงินเดือน) ก่อน → ไฟล์เดียวมี
// 5-7 sheet: พนักงาน + การลา + ประวัติเงินเดือน + master ที่เกี่ยวข้อง
function openMultiSheetExportModal() {
  if (!requireHR()) return;
  const branches = DB.getBranches();
  const depts = DB.getDepartments();
  const scopes = DB.getScopes();
  modal.open('📊 Export หลาย Sheet พร้อมตัวกรอง', `
    <form id="mseForm">
      <div class="form-grid">
        <div class="form-group"><label>สาขา</label><select name="branch">
          <option value="">— ทุกสาขา —</option>
          ${branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
        </select></div>
        <div class="form-group"><label>ฝ่าย</label><select name="department">
          <option value="">— ทุกฝ่าย —</option>
          ${depts.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
        </select></div>
        <div class="form-group"><label>สายงาน</label><select name="scope">
          <option value="">— ทุกสายงาน —</option>
          ${scopes.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('')}
        </select></div>
        <div class="form-group"><label>สถานะ</label><select name="status">
          <option value="active">เฉพาะปฏิบัติงาน (default)</option>
          <option value="all">ทั้งหมด (รวมพ้นสภาพ)</option>
          <option value="resigned">เฉพาะพ้นสภาพ</option>
        </select></div>
        <div class="form-group"><label>วันเริ่มงาน — ตั้งแต่</label><input name="hireFrom" type="date"/></div>
        <div class="form-group"><label>วันเริ่มงาน — ถึง</label><input name="hireTo" type="date"/></div>
        <div class="form-group span-2"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" name="includeSalary" checked/> รวมข้อมูลเงินเดือน + รายได้
        </label><div class="muted-2" style="font-size:11.5px;margin-top:4px">ถ้าไม่เลือก → คอลัมน์เงินเดือน/ค่าตอบแทนจะแสดง "***" (ใช้กรณี share ไฟล์กับคนอื่น)</div></div>
        <div class="form-group span-2"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" name="includeLeave" checked/> รวม sheet "การลาย้อนหลัง 12 เดือน"
        </label></div>
        <div class="form-group span-2"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" name="includeMaster" checked/> รวม sheet master (สาขา / ฝ่าย / ตำแหน่ง / สายงาน)
        </label></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">📥 Export</button>
      </div>
    </form>
  `);
  $('#mseForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    data.includeSalary = data.includeSalary === 'on';
    data.includeLeave = data.includeLeave === 'on';
    data.includeMaster = data.includeMaster === 'on';
    modal.close();
    runWhenIdle(() => doMultiSheetExport(data));
  });
}

function doMultiSheetExport(opts) {
  if (typeof XLSX === 'undefined') { toast('กำลังโหลด...', 'warning'); setTimeout(() => doMultiSheetExport(opts), 800); return; }
  const cs = csvSafe;
  // ── Apply filters to employees ──
  let emps = DB.getEmployees().slice();
  if (opts.branch)     emps = emps.filter(e => e.branch === opts.branch);
  if (opts.department) emps = emps.filter(e => e.department === opts.department);
  if (opts.scope)      emps = DB._filterByScope(emps, opts.scope);
  if (opts.status === 'active')   emps = emps.filter(e => DB.empStatus(e) !== 'resigned');
  else if (opts.status === 'resigned') emps = emps.filter(e => DB.empStatus(e) === 'resigned');
  if (opts.hireFrom)   emps = emps.filter(e => (e.hireDate || '') >= opts.hireFrom);
  if (opts.hireTo)     emps = emps.filter(e => (e.hireDate || '') <= opts.hireTo);

  if (emps.length === 0) { toast('ไม่พบพนักงานที่ตรงกับตัวกรอง', 'warning'); return; }

  const mask = (v) => opts.includeSalary ? Number(v || 0) : '***';
  const empSet = new Set(emps.map(e => e.id));
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: พนักงาน ──
  const empRows = emps.map(e => ({
    'รหัส': excelNum(e.id), 'คำนำหน้า': cs(e.title), 'ชื่อ': cs(e.firstName), 'นามสกุล': cs(e.lastName),
    'ชื่อเล่น': cs(e.nickname),
    'เลขประชาชน': excelNum(e.nationalId), 'วันเกิด': excelDate(e.dob), 'เพศ': cs(e.gender),
    'สัญชาติ': cs(e.nationality),
    'เบอร์โทร': cs(e.phone), 'อีเมล': cs(e.email),
    'ฝ่าย': cs((DB.getDepartment(e.department) || {}).name || ''),
    'สาขา': cs(e.branch),
    'ตำแหน่ง': cs(e.positionTitle),
    'สาย': cs((DB.getScope((DB.getPosition(e.position) || {}).scope) || {}).label || ''),
    'ประเภทพนักงาน': cs(e.employeeType),
    'วันเริ่มงาน': excelDate(e.hireDate),
    'วันพ้นสภาพ': excelDate(e.terminationDate),
    'เงินเดือน': mask(e.salary),
    'ค่าตำแหน่ง': mask(e.allowancePosition),
    'ค่าเดินทาง': mask(e.allowanceTravel),
    'ค่าอาหาร': mask(e.allowanceFood),
    'ค่าเบี้ยเลี้ยง': mask(e.allowancePerDiem),
    'ค่าภาษา': mask(e.allowanceLanguage),
    'ค่าโทรศัพท์': mask(e.allowancePhone),
    'ค่าอื่นๆ': mask(e.allowanceOther),
    'รวมรายได้': opts.includeSalary ? totalIncome(e) : '***',
    'สถานะ': DB.empStatus(e) === 'resigned' ? 'พ้นสภาพ' : 'ปฏิบัติงาน'
  }));
  const wsEmp = XLSX.utils.json_to_sheet(empRows);
  wsEmp['!cols'] = Object.keys(empRows[0] || {}).map(k => ({ wch: k === 'เลขประชาชน' ? 16 : k === 'ที่อยู่' ? 30 : 12 }));
  XLSX.utils.book_append_sheet(wb, wsEmp, 'พนักงาน');

  // ── Sheet 2: การลา 12 เดือนย้อนหลัง ──
  if (opts.includeLeave) {
    const today = tz.today();
    const oneYearAgo = (() => {
      const d = new Date(today); d.setFullYear(d.getFullYear() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const leaves = (DB.data.leaveRequests || [])
      .filter(r => empSet.has(r.employeeId) && (r.startDate || '') >= oneYearAgo)
      .sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
    const leaveRows = leaves.map(r => {
      const e = DB.getEmployee(r.employeeId) || {};
      const lt = DB.LEAVE_TYPES?.[r.leaveType];
      return {
        'รหัสพนักงาน': excelNum(r.employeeId),
        'ชื่อ-นามสกุล': cs(((e.firstName || '') + ' ' + (e.lastName || '')).trim()),
        'สาขา': cs(e.branch),
        'ประเภทการลา': cs(lt?.label || r.leaveType),
        'วันเริ่ม': excelDate(r.startDate),
        'วันสิ้นสุด': excelDate(r.endDate),
        'จำนวนวัน': Number(r.days || 0),
        'เหตุผล': cs(r.reason),
        'สถานะ': r.status === 'approved' ? 'อนุมัติ' : r.status === 'rejected' ? 'ปฏิเสธ' : r.status === 'cancelled' ? 'ยกเลิก' : 'รอ',
        'ผู้อนุมัติ': cs(r.approverNote)
      };
    });
    if (leaveRows.length) {
      const wsLeave = XLSX.utils.json_to_sheet(leaveRows);
      wsLeave['!cols'] = Object.keys(leaveRows[0]).map(() => ({ wch: 14 }));
      XLSX.utils.book_append_sheet(wb, wsLeave, 'การลา');
    }
  }

  // ── Sheet 3-6: Master tables ──
  if (opts.includeMaster) {
    const branchRows = DB.getBranches().map(b => ({ 'รหัสสาขา': b, 'จำนวนพนักงาน': emps.filter(e => e.branch === b).length }));
    if (branchRows.length) {
      const ws = XLSX.utils.json_to_sheet(branchRows);
      ws['!cols'] = [{ wch: 16 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws, 'สาขา');
    }
    const deptRows = DB.getDepartments().map(d => ({
      'รหัส': d.id, 'ชื่อฝ่าย': d.name,
      'สาย': (DB.getScope(d.scope) || {}).label || '',
      'จำนวนพนักงาน': emps.filter(e => e.department === d.id).length
    }));
    if (deptRows.length) {
      const ws = XLSX.utils.json_to_sheet(deptRows);
      ws['!cols'] = [{ wch: 10 }, { wch: 24 }, { wch: 20 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'ฝ่าย');
    }
    const posRows = DB.getPositions().sort((a, b) => (b.level || 0) - (a.level || 0)).map(p => ({
      'รหัส': p.id, 'ชื่อตำแหน่ง': p.name,
      'สาย': (DB.getScope(p.scope) || {}).label || '',
      'ระดับ': Number(p.level || 0),
      'เงินเดือนต่ำสุด': opts.includeSalary ? Number(p.minSalary || 0) : '***',
      'เงินเดือนสูงสุด': opts.includeSalary ? Number(p.maxSalary || 0) : '***',
      'จำนวนพนักงาน': emps.filter(e => e.position === p.id).length
    }));
    if (posRows.length) {
      const ws = XLSX.utils.json_to_sheet(posRows);
      ws['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 20 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'ตำแหน่ง');
    }
    const scopeRows = DB.getScopes().map(s => ({ 'รหัส': s.id, 'ชื่อสาย': s.label }));
    if (scopeRows.length) {
      const ws = XLSX.utils.json_to_sheet(scopeRows);
      ws['!cols'] = [{ wch: 12 }, { wch: 26 }];
      XLSX.utils.book_append_sheet(wb, ws, 'สายงาน');
    }
  }

  // ── Sheet สุดท้าย: Summary + filter ที่ใช้ ──
  const summary = [
    ['📊 Multi-sheet Export Summary'],
    [''],
    ['วันที่ส่งออก', new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })],
    ['ส่งออกโดย', DB.profile?.employee_id || DB.user?.email || '-'],
    [''],
    ['── ตัวกรอง ──'],
    ['สาขา', opts.branch || 'ทุกสาขา'],
    ['ฝ่าย', opts.department ? (DB.getDepartment(opts.department) || {}).name : 'ทุกฝ่าย'],
    ['สายงาน', opts.scope ? (DB.getScope(opts.scope) || {}).label : 'ทุกสายงาน'],
    ['สถานะ', { active: 'เฉพาะปฏิบัติงาน', all: 'ทั้งหมด', resigned: 'เฉพาะพ้นสภาพ' }[opts.status] || opts.status],
    ['วันเริ่มงานตั้งแต่', opts.hireFrom || '-'],
    ['วันเริ่มงานถึง', opts.hireTo || '-'],
    ['รวมเงินเดือน', opts.includeSalary ? '✓ ใช่' : '✗ ไม่ (แสดง ***)'],
    ['รวมการลา', opts.includeLeave ? '✓ ใช่' : '✗ ไม่'],
    ['รวม master', opts.includeMaster ? '✓ ใช่' : '✗ ไม่'],
    [''],
    ['── สรุป ──'],
    ['จำนวนพนักงานที่ export', emps.length]
  ];
  const wsSum = XLSX.utils.aoa_to_sheet(summary);
  wsSum['!cols'] = [{ wch: 24 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsSum, 'สรุป');

  XLSX.writeFile(wb, `คชา-multi-${tz.today()}.xlsx`);
  toast(`ส่งออกแล้ว · ${emps.length} คน · ${wb.SheetNames.length} sheet`, 'success');
}

function exportDataJSON() {
  // 🔒 Admin เท่านั้น — backup ทุกตารางในระบบ (สิทธิ์สูงสุด)
  if (!requireAdmin()) return;
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

// Emoji icons สำหรับวันหยุดประเภทต่างๆ — ค้นจากชื่อ
function holidayEmoji(title, date, type) {
  if (type === 'event') return '📌';
  if (type !== 'holiday') return '📍';
  const t = title || '';
  const md = (date || '').slice(5);
  if (t.includes('ปีใหม่') || t.includes('สิ้นปี') || md === '01-01' || md === '12-31') return '🎊';
  if (t.includes('สงกรานต์')) return '💦';
  if (t.includes('แรงงาน')) return '⚒️';
  if (t.includes('พระบรมราชสมภพ') || t.includes('พระเจ้าอยู่หัว') || t.includes('ร.๙') || t.includes('ร.๑๐') || t.includes('ราชินี')) return '👑';
  if (t.includes('รัฐธรรมนูญ')) return '📜';
  if (t.includes('วิสาขบูชา') || t.includes('อาสาฬหบูชา') || t.includes('เข้าพรรษา') || t.includes('มาฆบูชา')) return '🪷';
  if (t.includes('แม่')) return '🌸';
  if (t.includes('พ่อ')) return '🌟';
  if (t.includes('จักรี')) return '🏛️';
  if (t.includes('ฉัตรมงคล')) return '👑';
  return '🗓️';
}

// คำนวณวันที่เหลือจาก today ถึง dateStr (อาจติดลบถ้าผ่านแล้ว)
function daysUntil(dateStr, today) {
  const t = parseYMD(dateStr);
  const n = parseYMD(today);
  if (!t || !n) return 0;
  const ms = new Date(t[0], t[1] - 1, t[2]) - new Date(n[0], n[1] - 1, n[2]);
  return Math.round(ms / 86400000);
}

const _calendarState = {
  filterYear: new Date().getFullYear()
};
function setCalendarYear(y) {
  _calendarState.filterYear = Number(y);
  router.go('calendar');
}

// State + actions ของ section "คำขอเปลี่ยนวันหยุด" — filter + pagination (รองรับ 200+ คำขอ)
const _swapReqUI = {
  tab: 'pending',
  search: '',
  branch: '',
  status: '',     // เฉพาะ HR/admin granular filter
  page: 0,
  pageSize: 20
};
function swapReqSetTab(t) { _swapReqUI.tab = t; _swapReqUI.page = 0; router.go('calendar'); }
function swapReqSetFilter(k, v) {
  const newVal = (v ?? '').trim();
  if (_swapReqUI[k] === newVal) return;
  _swapReqUI[k] = newVal;
  _swapReqUI.page = 0;
  router.go('calendar');
}
function swapReqClearFilters() {
  _swapReqUI.search = '';
  _swapReqUI.branch = '';
  _swapReqUI.status = '';
  _swapReqUI.page = 0;
  router.go('calendar');
}
function swapReqGoPage(p) {
  _swapReqUI.page = Math.max(0, Number(p) || 0);
  router.go('calendar');
}

router.register('calendar', () => {
  const allCalendarItems = DB.getCalendar();
  const today = tz.today();
  const todayYmd = parseYMD(today);
  const todayYear = todayYmd ? todayYmd[0] : new Date().getFullYear();
  const filterYear = _calendarState.filterYear;
  const buddhistYear = filterYear + 543;
  // จำกัดเฉพาะปีที่เลือก
  const items = allCalendarItems.filter(c => {
    const y = parseYMD(c.date)?.[0];
    return y === filterYear;
  });
  const typeLabel = (t) => t === 'holiday' ? 'วันหยุด' : t === 'event' ? 'กิจกรรม' : 'อื่นๆ';
  const typeBadge = (t) => t === 'holiday' ? 'badge-danger' : t === 'event' ? 'badge-info' : 'badge';

  // ปีสำหรับ dropdown: รวมปีที่มีข้อมูล + ปีปัจจุบัน + 3 ปีย้อนหลัง + 1 ปีล่วงหน้า
  const yearsSet = new Set(allCalendarItems.map(c => parseYMD(c.date)?.[0]).filter(Boolean));
  for (let y = todayYear - 3; y <= todayYear + 1; y++) yearsSet.add(y);
  const yearOptions = Array.from(yearsSet).sort((a, b) => b - a);

  // ─── PER-USER SWAP STATE ──────────────────────────────────
  // วันหยุด = calendar_items (เหมือนกันทุกคน) + ทับด้วย swap ของ "ฉันเอง"
  const myEmpId = DB.profile?.employee_id || null;
  const mySwapsApproved = new Map();   // key: calendarItemId → swap request
  const mySwapsPending  = new Map();
  if (myEmpId) {
    for (const r of (DB.data.holidaySwapRequests || []).filter(r => r.employeeId === myEmpId)) {
      if (r.status === 'approved')      mySwapsApproved.set(r.calendarItemId, r);
      else if (r.status === 'pending')  mySwapsPending.set(r.calendarItemId, r);
    }
  }

  // สถิติ — per-user view
  const holidays = items.filter(c => c.type === 'holiday');
  const swappedHolidayIds = new Set(mySwapsApproved.keys());
  const myPendingCount = mySwapsPending.size;
  const upcomingItems = items.filter(c => c.date >= today);
  const pastItems = items.filter(c => c.date < today);

  // สร้าง virtual entries สำหรับวันหยุดชดเชย "ของฉัน" — ใช้แสดงใน upcoming
  const myCompensationEntries = [];
  for (const [calId, req] of mySwapsApproved.entries()) {
    const original = holidays.find(c => c.id === calId);
    if (!original) continue;
    myCompensationEntries.push({
      id: original.id + '__swap',
      date: req.swapToDate,
      title: `หยุดชดเชย — แทน ${original.title}`,
      type: 'holiday',
      _isSwapTarget: true,
      _originalId: original.id,
      _originalDate: original.date,
      _originalTitle: original.title,
      _swapReqId: req.id
    });
  }

  // รวมรายการทั้งหมด + เรียงตามวันที่
  const allItems = [...items, ...myCompensationEntries].sort((a, b) => a.date.localeCompare(b.date));
  const upcomingAll = allItems.filter(c => c.date >= today);
  const nextHoliday = upcomingAll[0] || null;
  const nextDays = nextHoliday ? daysUntil(nextHoliday.date, today) : null;

  // วันในสัปดาห์ ไทย — สำหรับคอลัมน์วัน
  const THAI_DOW = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const thaiDow = (dateStr) => {
    const ymd = parseYMD(dateStr);
    if (!ymd) return '';
    return THAI_DOW[new Date(ymd[0], ymd[1] - 1, ymd[2]).getDay()];
  };

  // Render แถวตารางของวันหยุด/กิจกรรมแต่ละรายการ (ไม่มี emoji column)
  const renderRow = (c) => {
    const isTarget = !!c._isSwapTarget;
    const isPast = c.date < today;
    const isNext = nextHoliday && c.date === nextHoliday.date && c.title === nextHoliday.title && !isPast;
    const mySwapApproved = !isTarget ? mySwapsApproved.get(c.id) : null;
    const myPendingReq   = !isTarget ? mySwapsPending.get(c.id) : null;
    const isMineSwapped  = !!mySwapApproved;
    // วันหยุดในปีนี้/อนาคต → ขอ swap ได้ แม้ผ่านมาแล้ว ตราบใดที่ยังเหลือวันในปีให้หยุดแทน
    const cYear = parseYMD(c.date)?.[0];
    const yearEndStr = cYear ? `${cYear}-12-31` : '';
    // คำนวณ "พรุ่งนี้" inline (เลี่ยง dependency กับ helper ในขอบเขตอื่น)
    const _tymd = parseYMD(today);
    const _tmw = _tymd ? new Date(_tymd[0], _tymd[1] - 1, _tymd[2] + 1) : null;
    const tomorrowStr = _tmw ? `${_tmw.getFullYear()}-${String(_tmw.getMonth() + 1).padStart(2, '0')}-${String(_tmw.getDate()).padStart(2, '0')}` : '';
    // ยังมี window ให้ swap: (today+1 หรือ holiday+1 อันที่ช้ากว่า) <= 31 ธ.ค. ของปีวันหยุด
    const minPossibleSwap = c.date > today ? c.date : tomorrowStr;        // ต้อง > วันหยุดเดิม และ > วันนี้
    const hasSwapWindow = yearEndStr && minPossibleSwap < yearEndStr && c.date < yearEndStr;
    const canRequestSwap = c.type === 'holiday' && !isTarget && hasSwapWindow && !isMineSwapped && !myPendingReq && !!myEmpId;
    const rowStyle = isPast ? 'opacity:0.55' : (isNext ? 'background:var(--primary-soft)' : (isTarget ? 'background:var(--success-soft)' : ''));
    const titleStyle = isMineSwapped ? 'text-decoration:line-through;color:var(--text-2)' : 'color:var(--text)';

    // คอลัมน์สถานะ (per-user)
    let statusCell = '';
    if (isTarget) {
      statusCell = `<span class="badge badge-success" style="font-size:10.5px">หยุดชดเชย</span><div class="muted-2" style="font-size:11px;margin-top:2px">แทน ${fmt.date(c._originalDate)}</div>`;
    } else if (isMineSwapped) {
      statusCell = `<span class="badge badge-warning" style="font-size:10.5px;cursor:pointer" onclick="openSwapRequestDetail('${mySwapApproved.id}')">มาทำงาน → ชดเชย ${fmt.date(mySwapApproved.swapToDate)}</span>`;
    } else if (myPendingReq) {
      statusCell = `<span class="badge badge-info" style="font-size:10.5px;cursor:pointer" onclick="openSwapRequestDetail('${myPendingReq.id}')">🕒 รออนุมัติ → ${fmt.date(myPendingReq.swapToDate)}</span>`;
    } else if (isNext) {
      statusCell = `<span style="font-size:10.5px;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:0.08em">วันถัดไป</span>`;
    } else if (isPast) {
      statusCell = `<span class="muted-2" style="font-size:11px">ผ่านแล้ว</span>`;
    }

    // ปุ่ม actions
    const actions = [];
    if (canRequestSwap) actions.push(`<button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="openSwapRequestForm('${c.id}')">⇄ เสนอเปลี่ยน</button>`);
    if (DB.isHR && !isTarget) {
      actions.push(`<button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="openCalForm('${c.id}')">แก้</button>`);
      actions.push(`<button class="btn btn-ghost btn-sm" style="font-size:11.5px;color:var(--danger)" onclick="deleteCalRec('${c.id}')">ลบ</button>`);
    }

    return `<tr style="${rowStyle}">
      <td style="white-space:nowrap;width:140px">
        <div style="font-weight:600;font-size:13.5px;font-variant-numeric:tabular-nums">${fmt.date(c.date)}</div>
        <div class="muted-2" style="font-size:11.5px">${thaiDow(c.date)}</div>
      </td>
      <td><strong style="${titleStyle};font-size:14px">${escapeHtml(c.title)}</strong></td>
      <td><span class="badge ${isTarget ? 'badge-success' : typeBadge(c.type)}" style="font-size:10.5px">${isTarget ? 'หยุดชดเชย' : typeLabel(c.type)}</span></td>
      <td>${statusCell}</td>
      <td style="text-align:right;white-space:nowrap">${actions.join(' ')}</td>
    </tr>`;
  };

  // Render section "คำขอเปลี่ยนวันหยุด" — premium + filterable + paginated (รองรับ 200+ คำขอ)
  const renderSwapRequestsSection = () => {
    // ─── Filter ตามปีที่เลือกข้างบน — สอดคล้องกับตาราง "ภาพรวมทั้งปี" ───
    // ใช้ปีของวันหยุดเดิม (calendar_item.date) เป็นเกณฑ์
    const calById = new Map(DB.getCalendar().map(c => [c.id, c]));
    const allReqs = DB.getHolidaySwapRequests().filter(r => {
      const holiday = calById.get(r.calendarItemId);
      if (!holiday) return false;
      return parseYMD(holiday.date)?.[0] === filterYear;
    });
    if (!allReqs.length) return '';

    // ─── User context — role + employee_id ───
    const role = DB.role;
    const myEmpId = DB.profile?.employee_id;
    const isStaffOrViewer = (role === 'branch_staff' || role === 'viewer');

    // ─── แยกคำขอ "ของฉัน" ออกจากคำขอที่ต้องอนุมัติ ───
    const myReqs = myEmpId ? allReqs.filter(r => r.employeeId === myEmpId) : [];
    const othersReqs = myEmpId ? allReqs.filter(r => r.employeeId !== myEmpId) : allReqs;
    const myPendingCount = myReqs.filter(r => r.status === 'pending').length;

    // ─── Stats ตามสถานะ — pending = เฉพาะที่ "ต้องอนุมัติ" (ไม่รวมของฉัน สำหรับ manager+) ───
    const counts = { all: allReqs.length, pending: 0, approved: 0, rejected: 0, cancelled: 0, mine: myReqs.length };
    for (const r of allReqs) counts[r.status] = (counts[r.status] || 0) + 1;
    const decidedCount = counts.approved + counts.rejected + counts.cancelled;
    // pending "ต้องอนุมัติ" = pending ทั้งหมด - pending ของฉัน (เพราะ self-approval ไม่ได้)
    const actionablePendingCount = counts.pending - myPendingCount;

    // ─── Filter by tab ───
    let filtered = allReqs;
    if (_swapReqUI.tab === 'pending') {
      // pending ที่ต้อง act on — สำหรับ manager+ ไม่รวมของตัวเอง (กัน self-approval, ลดความสับสน)
      filtered = isStaffOrViewer
        ? allReqs.filter(r => r.status === 'pending')
        : othersReqs.filter(r => r.status === 'pending');
    } else if (_swapReqUI.tab === 'decided') {
      filtered = othersReqs.filter(r => r.status !== 'pending');
    } else if (_swapReqUI.tab === 'mine') {
      filtered = myReqs;
    }

    // ─── Filter by search (ชื่อ/รหัสพนักงาน) ───
    const s = (_swapReqUI.search || '').trim().toLowerCase();
    if (s) {
      filtered = filtered.filter(r => {
        const emp = DB.getEmployee(r.employeeId);
        const name = ((emp?.firstName || '') + ' ' + (emp?.lastName || '')).toLowerCase();
        return name.includes(s) || String(r.employeeId).toLowerCase().includes(s);
      });
    }
    // ─── Filter by branch ───
    if (_swapReqUI.branch) {
      filtered = filtered.filter(r => {
        const emp = DB.getEmployee(r.employeeId);
        return emp?.branch === _swapReqUI.branch;
      });
    }
    // ─── Filter by status (granular - แยกอนุมัติ/ปฏิเสธ/ยกเลิก) ───
    if (_swapReqUI.status) {
      filtered = filtered.filter(r => r.status === _swapReqUI.status);
    }

    // ─── Pagination ───
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / _swapReqUI.pageSize));
    const page = Math.min(_swapReqUI.page, totalPages - 1);
    const slice = filtered.slice(page * _swapReqUI.pageSize, (page + 1) * _swapReqUI.pageSize);
    const startIdx = page * _swapReqUI.pageSize + 1;
    const endIdx = Math.min((page + 1) * _swapReqUI.pageSize, total);

    // ─── Branches dropdown — ใช้สาขาทั้งหมดที่ผู้ใช้เห็น (จาก employees auto-scope) ───
    // ไม่ใช่แค่สาขาที่มีคำขอ → HR/admin filter หาสาขาที่ยังไม่มีคำขอได้
    const branches = [...new Set(DB.getEmployees({ status: 'active' }).map(e => e.branch).filter(Boolean))].sort();

    const hasFilters = !!(s || _swapReqUI.branch || _swapReqUI.status);

    // ─── Row: พนักงาน + วันหยุด + วันชดเชย + สถานะ + วันยื่น + actions ───
    const renderRow = (r) => {
      const holiday = DB.getCalendar().find(c => c.id === r.calendarItemId);
      const requester = DB.getEmployee(r.employeeId);
      const STATUS = SWAP_STATUS_BADGE[r.status] || { label: r.status, cls: 'badge' };
      const canApprove = r.status === 'pending' && DB.canApproveHolidaySwapFor(r.employeeId);
      const isMine = r.employeeId === DB.profile?.employee_id;
      const fullName = (requester?.firstName || '') + ' ' + (requester?.lastName || '');
      const initials = ((requester?.firstName || '?').charAt(0) + (requester?.lastName || '').charAt(0)).toUpperCase();
      return `<tr style="${r.status === 'pending' ? '' : 'opacity:0.78'}">
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:34px;height:34px;border-radius:50%;background:var(--primary-soft);color:var(--primary-text);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;flex-shrink:0">${escapeHtml(initials)}</div>
            <div style="min-width:0">
              <div style="font-weight:600;font-size:13.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(fullName)}${isMine ? ' <span class="muted-2" style="font-size:10.5px;font-weight:500">(ฉัน)</span>' : ''}</div>
              <div class="muted-2" style="font-size:11px;font-variant-numeric:tabular-nums">${escapeHtml(r.employeeId)}${requester?.branch ? ' · ' + escapeHtml(requester.branch) : ''}</div>
            </div>
          </div>
        </td>
        <td>
          <div style="font-weight:600;font-size:13px">${escapeHtml(holiday?.title || '—')}</div>
          <div class="muted-2" style="font-size:11.5px;font-variant-numeric:tabular-nums">${fmt.date(holiday?.date)}</div>
        </td>
        <td style="font-variant-numeric:tabular-nums">
          <div style="font-weight:600;font-size:13px;color:var(--success-text)">${fmt.date(r.swapToDate)}</div>
        </td>
        <td><span class="badge ${STATUS.cls}" style="font-size:10.5px;white-space:nowrap">${STATUS.label}</span></td>
        <td style="font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums;white-space:nowrap">${r.requestedAt ? new Date(r.requestedAt).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short' }) : '-'}</td>
        <td style="text-align:right;white-space:nowrap">
          ${canApprove ? `<button class="btn btn-primary btn-sm" style="font-size:11.5px" onclick="approveSwapReq('${r.id}')">อนุมัติ</button>` : ''}
          <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="openSwapRequestDetail('${r.id}')">รายละเอียด</button>
        </td>
      </tr>`;
    };

    // ─── Pagination buttons ───
    const renderPagination = () => {
      if (totalPages <= 1) return '';
      const pageButtons = [];
      const maxButtons = 5;
      let start = Math.max(0, page - Math.floor(maxButtons / 2));
      let end = Math.min(totalPages, start + maxButtons);
      start = Math.max(0, end - maxButtons);
      for (let i = start; i < end; i++) {
        pageButtons.push(`<button class="btn btn-ghost btn-sm" style="min-width:32px;${i === page ? 'background:var(--primary);color:#fff;border-color:var(--primary)' : ''}" onclick="swapReqGoPage(${i})">${i + 1}</button>`);
      }
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 4px 4px;flex-wrap:wrap">
        <div class="muted-2" style="font-size:12px">แสดง ${fmt.num(startIdx)}–${fmt.num(endIdx)} จาก ${fmt.num(total)} รายการ</div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-ghost btn-sm" ${page === 0 ? 'disabled' : ''} onclick="swapReqGoPage(${page - 1})">‹ ก่อนหน้า</button>
          ${pageButtons.join('')}
          <button class="btn btn-ghost btn-sm" ${page >= totalPages - 1 ? 'disabled' : ''} onclick="swapReqGoPage(${page + 1})">ถัดไป ›</button>
        </div>
      </div>`;
    };

    // Subtitle ตาม role ของผู้ใช้ — บอกขอบเขตการเห็นข้อมูลให้ชัดเจน
    let scopeLabel = 'เห็นเฉพาะคำขอของฉัน';
    if (DB.isHR) scopeLabel = 'เห็นคำขอทั้งหมดของบริษัท';
    else if (role === 'operation_manager') scopeLabel = 'เห็นคำขอทั้งหมดของบริษัท';
    else if (role === 'area_manager') {
      const branches = (DB.scopedBranches && DB.scopedBranches()) || [];
      scopeLabel = `เห็นคำขอใน ${branches.length} สาขา ที่ดูแล`;
    } else if (role === 'branch_manager') {
      const myBranch = DB.getEmployee(DB.profile?.employee_id)?.branch;
      scopeLabel = myBranch ? `เห็นคำขอในสาขา ${myBranch}` : 'เห็นคำขอในสาขาที่ดูแล';
    }

    return `
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">คำขอเปลี่ยนวันหยุด · ปี ${buddhistYear}</div>
          <div class="sw-chart-sub">ใช้ chain อนุมัติเดียวกับการลา · ${escapeHtml(scopeLabel)} · เปลี่ยนปีที่ตัวกรองด้านบน</div>
        </div>
        ${(DB.isHR || role === 'branch_manager' || role === 'area_manager') ? '<button class="btn btn-primary btn-sm" onclick="openSwapRequestForm()">+ บันทึกให้พนักงาน</button>' : ''}
      </div>

      <!-- Tabs (filter pills) -->
      <div class="sw-tabs" style="margin-bottom:14px" role="tablist">
        <button class="sw-tab ${_swapReqUI.tab === 'pending' ? 'active' : ''}" onclick="swapReqSetTab('pending')" role="tab">
          <span>${isStaffOrViewer ? 'รออนุมัติ' : 'ต้องอนุมัติ'}</span>${(isStaffOrViewer ? counts.pending : actionablePendingCount) ? `<span class="sw-tab-pill" style="background:var(--warning-soft);color:var(--warning-text)">${fmt.num(isStaffOrViewer ? counts.pending : actionablePendingCount)}</span>` : ''}
        </button>
        ${(!isStaffOrViewer && myReqs.length) ? `<button class="sw-tab ${_swapReqUI.tab === 'mine' ? 'active' : ''}" onclick="swapReqSetTab('mine')" role="tab">
          <span>ของฉัน</span><span class="sw-tab-pill" style="background:var(--primary-soft);color:var(--primary-text)">${fmt.num(myReqs.length)}</span>
        </button>` : ''}
        <button class="sw-tab ${_swapReqUI.tab === 'decided' ? 'active' : ''}" onclick="swapReqSetTab('decided')" role="tab">
          <span>ตัดสินใจแล้ว</span>${decidedCount ? `<span class="sw-tab-pill">${fmt.num(decidedCount)}</span>` : ''}
        </button>
        <button class="sw-tab ${_swapReqUI.tab === 'all' ? 'active' : ''}" onclick="swapReqSetTab('all')" role="tab">
          <span>ทั้งหมด</span><span class="sw-tab-pill">${fmt.num(counts.all)}</span>
        </button>
      </div>

      <!-- Filter bar — แสดงเฉพาะ role ที่เห็นข้อมูลของหลายคน -->
      ${(role !== 'branch_staff' && role !== 'viewer') ? `
      <div class="sw-filter-bar">
        <input id="swapReqSearch" type="text" class="sw-filter-input" placeholder="🔍 ค้นชื่อ/รหัสพนักงาน"
          value="${escapeHtml(_swapReqUI.search)}"
          onkeydown="if(event.key==='Enter'){event.preventDefault();swapReqSetFilter('search', this.value);}"
          onblur="swapReqSetFilter('search', this.value)"/>
        ${branches.length > 1 ? `<select class="sw-filter-select" onchange="swapReqSetFilter('branch', this.value)">
          <option value="">— ทุกสาขา —</option>
          ${branches.map(b => `<option value="${escapeHtml(b)}" ${_swapReqUI.branch === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>` : ''}
        <select class="sw-filter-select" onchange="swapReqSetFilter('status', this.value)">
          <option value="">— ทุกสถานะ —</option>
          ${Object.entries(SWAP_STATUS_BADGE).map(([k, v]) => `<option value="${k}" ${_swapReqUI.status === k ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
        </select>
        ${hasFilters ? `<button class="btn btn-ghost btn-sm sw-filter-clear" onclick="swapReqClearFilters()">✕ ล้างตัวกรอง</button>` : ''}
      </div>` : ''}

      <!-- Table -->
      ${slice.length ? `
      <div class="table-wrap"><table class="table table-compact sw-swap-table">
        <thead><tr>
          <th style="min-width:200px">พนักงาน</th>
          <th style="min-width:160px">วันหยุดเดิม</th>
          <th style="min-width:110px">วันชดเชย</th>
          <th style="width:110px">สถานะ</th>
          <th style="width:80px">วันยื่น</th>
          <th style="width:1%;text-align:right">การกระทำ</th>
        </tr></thead>
        <tbody>${slice.map(renderRow).join('')}</tbody>
      </table></div>
      ${renderPagination()}
      ` : `<div class="empty-state" style="padding:48px 20px">
        <div style="font-size:36px;margin-bottom:8px;opacity:0.3">📭</div>
        <div class="title" style="font-size:14px;font-weight:600">${hasFilters ? 'ไม่พบคำขอที่ตรงกับตัวกรอง' : (_swapReqUI.tab === 'pending' ? 'ไม่มีคำขอที่รออนุมัติ' : 'ไม่มีคำขอ')}</div>
        ${hasFilters ? '<div class="hint" style="margin-top:4px">ลองล้างตัวกรองเพื่อดูทั้งหมด</div>' : ''}
      </div>`}
    </div>`;
  };


  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">วันหยุดประเพณี</div>
        <div class="sw-page-subtitle">วันหยุด · กิจกรรมบริษัท · ประจำปี ${buddhistYear}</div>
      </div>
      <div class="sw-page-actions">${DB.isHR ? '<button class="btn btn-primary" onclick="openCalForm()">+ เพิ่มกิจกรรม</button>' : ''}</div>
    </div>

    <!-- KPI Stats (per-user) -->
    <div class="sw-stats-grid sw-cal-stats">
      <div class="sw-stat-card sw-accent-primary">
        <div class="sw-stat-icon">${ICON.calendar}</div>
        <div class="sw-stat-label">วันหยุดทั้งหมด</div>
        <div class="sw-stat-value">${fmt.num(holidays.length)}</div>
        <div class="sw-stat-change">วันหยุดประเพณีที่บริษัทกำหนด</div>
      </div>
      <div class="sw-stat-card sw-accent-green">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
        <div class="sw-stat-label">จะมาถึง</div>
        <div class="sw-stat-value">${fmt.num(upcomingItems.length)}</div>
        <div class="sw-stat-change">${nextHoliday ? 'วันถัดไป: ' + fmt.date(nextHoliday.date) : 'ครบปีแล้ว'}</div>
      </div>
      <div class="sw-stat-card sw-accent-amber">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>
        <div class="sw-stat-label">ฉันเปลี่ยน / เลื่อน</div>
        <div class="sw-stat-value" style="color:${swappedHolidayIds.size ? 'var(--warning)' : 'var(--text)'}">${fmt.num(swappedHolidayIds.size)}</div>
        <div class="sw-stat-change">${myPendingCount ? `+ ${fmt.num(myPendingCount)} คำขอรออนุมัติ` : (swappedHolidayIds.size ? 'มีการเลื่อนเป็นวันอื่น' : 'ยังไม่มีคำขอเปลี่ยน')}</div>
      </div>
      <div class="sw-stat-card sw-accent-red">
        <div class="sw-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <div class="sw-stat-label">ผ่านมาแล้ว</div>
        <div class="sw-stat-value">${fmt.num(pastItems.length)}</div>
        <div class="sw-stat-change">รายการที่ผ่านไปในปีนี้</div>
      </div>
    </div>

    <!-- Featured Next Holiday — เฉพาะปีปัจจุบัน -->
    ${nextHoliday && filterYear === todayYear ? `
    <div class="sw-cal-featured">
      <div class="sw-cal-featured-icon">${nextHoliday._isSwapTarget ? '🔁' : holidayEmoji(nextHoliday._isSwapTarget ? nextHoliday._originalTitle : nextHoliday.title, nextHoliday.date, nextHoliday.type)}</div>
      <div>
        <div class="sw-cal-featured-label">${nextDays === 0 ? '— วันนี้ —' : 'วันหยุดถัดไป'}</div>
        <div class="sw-cal-featured-title">${escapeHtml(nextHoliday.title)}</div>
        <div class="sw-cal-featured-meta">${fmt.dateLong ? fmt.dateLong(nextHoliday.date) : fmt.date(nextHoliday.date)}${nextHoliday._isSwapTarget ? ' · หยุดชดเชยแทน ' + fmt.date(nextHoliday._originalDate) : ''}</div>
      </div>
      <div class="sw-cal-featured-countdown">
        <div class="num">${nextDays === 0 ? '0' : fmt.num(nextDays)}</div>
        <div class="lbl">${nextDays === 0 ? 'วันนี้' : 'วันข้างหน้า'}</div>
      </div>
    </div>` : ''}

    <!-- Year overview — table format with year selector -->
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">ภาพรวมปี ${buddhistYear} <span class="sw-chart-count">${fmt.num(allItems.length)}</span></div>
          <div class="sw-chart-sub">วันหยุด · กิจกรรม · รวมวันหยุดชดเชยของฉัน</div>
        </div>
        <select class="sw-inline-select" onchange="setCalendarYear(this.value)">
          ${yearOptions.map(y => `<option value="${y}" ${y === filterYear ? 'selected' : ''}>ปี ${y + 543}${y === todayYear ? ' (ปัจจุบัน)' : ''}</option>`).join('')}
        </select>
      </div>
      ${allItems.length ? `
      <div class="table-wrap"><table class="table table-compact sw-cal-table">
        <thead><tr>
          <th style="width:140px">วันที่</th>
          <th>หัวข้อ</th>
          <th style="width:90px">ประเภท</th>
          <th>สถานะ</th>
          <th style="width:1%;text-align:right">การกระทำ</th>
        </tr></thead>
        <tbody>
          ${allItems.map(renderRow).join('')}
        </tbody>
      </table></div>` : `
      <div class="empty-state" style="padding:60px 20px">
        <div style="font-size:42px;margin-bottom:12px;opacity:0.35">📅</div>
        <div class="title" style="font-size:16px;font-weight:600">ไม่มีกิจกรรมในปี ${buddhistYear}</div>
        <div class="hint" style="margin-top:6px">${DB.isHR ? (filterYear === todayYear ? 'กด + เพิ่มกิจกรรม เพื่อเริ่ม' : 'ลองเลือกปีอื่น หรือเพิ่มกิจกรรม') : 'ลองเลือกปีอื่น หรือรอ HR เพิ่ม'}</div>
      </div>`}
    </div>

    ${renderSwapRequestsSection()}`;
});

function openCalForm(id = null) {
  if (!requireHR()) return;
  const c = id ? DB.getCalendar().find(x => x.id === id) : { date: tz.today(), title: '', type: 'holiday' };
  // ดึงคำขอเปลี่ยนวันหยุดของ "ตัวเอง" สำหรับ holiday นี้ (ถ้ามี)
  const myEmpId = DB.profile?.employee_id;
  const swapReqs = (id && myEmpId)
    ? (DB.data.holidaySwapRequests || []).filter(r => r.calendarItemId === id && r.employeeId === myEmpId)
    : [];
  const myPendingReq = swapReqs.find(r => r.status === 'pending');
  const myApprovedReq = swapReqs.find(r => r.status === 'approved');
  // นับคำขอของพนักงานคนอื่นๆ (เฉพาะ HR/manager ที่เห็นใน scope)
  const otherReqsCount = id
    ? DB.getHolidaySwapRequests({ calendarItemId: id }).filter(r => r.employeeId !== myEmpId && r.status === 'pending').length
    : 0;
  const swapInfoHtml = c.type === 'holiday' && id ? `
    <div style="margin-top:12px;padding:14px 16px;background:var(--surface-2);border:1px solid var(--border);border-radius:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-weight:600;font-size:13px;margin-bottom:2px">สิทธิ์เปลี่ยนวันหยุดของฉัน</div>
          <div class="muted-2" style="font-size:11.5px">${
            myPendingReq  ? `🕒 ฉันยื่นคำขอแล้ว · รออนุมัติ — เลื่อนเป็น ${fmt.date(myPendingReq.swapToDate)}` :
            myApprovedReq ? `✓ ได้รับอนุมัติ — หยุดชดเชยวันที่ ${fmt.date(myApprovedReq.swapToDate)}` :
            'ฉันยังไม่ได้ขอเปลี่ยนวันหยุดนี้'
          }${otherReqsCount ? ` · มีคำขอ pending ของพนักงานอื่น ${otherReqsCount} รายการ` : ''}</div>
        </div>
        ${myEmpId ? `<button type="button" class="btn btn-secondary btn-sm" onclick="modal.close(); ${myPendingReq || myApprovedReq ? `openSwapRequestDetail('${(myPendingReq || myApprovedReq).id}')` : `openSwapRequestForm('${id}')`}">
          ${myPendingReq || myApprovedReq ? 'ดูคำขอของฉัน' : '+ เสนอเปลี่ยน'}
        </button>` : ''}
      </div>
    </div>` : '';
  modal.open(id ? 'แก้ไข' : 'เพิ่มกิจกรรม / วันหยุด', `
    <form id="calForm">
      <div class="form-grid">
        <div class="form-group"><label>วันที่ *</label><input name="date" type="date" value="${c.date}" required/></div>
        <div class="form-group"><label>ประเภท</label><select name="type"><option value="holiday" ${c.type === 'holiday' ? 'selected' : ''}>วันหยุด</option><option value="event" ${c.type === 'event' ? 'selected' : ''}>กิจกรรม</option><option value="other" ${c.type === 'other' ? 'selected' : ''}>อื่นๆ</option></select></div>
        <div class="form-group span-2"><label>หัวข้อ *</label><input name="title" value="${escapeHtml(c.title)}" required/></div>
      </div>
      ${swapInfoHtml}
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

// ═══════════════════════════════════════════════════════
//  HOLIDAY SWAP REQUEST — Form + Actions
// ═══════════════════════════════════════════════════════
// openSwapRequestForm(calendarItemId?) — ไม่มี arg = เปิดฟอร์มที่มี holiday dropdown ให้เลือก
//                                       มี arg = holiday ถูก lock ไว้แล้ว (จากการกดที่การ์ดวันหยุด)
function openSwapRequestForm(calendarItemId = null) {
  const holiday = calendarItemId ? DB.getCalendar().find(c => c.id === calendarItemId) : null;
  if (calendarItemId && !holiday) { toast('ไม่พบวันหยุด', 'error'); return; }
  if (holiday && holiday.type !== 'holiday') { toast('เปลี่ยนได้เฉพาะประเภทวันหยุด', 'warning'); return; }
  // ต้องมี profile + employee_id เพื่อใช้ chain อนุมัติ
  const myEmpId = DB.profile?.employee_id;
  const canAssignOthers = DB.isHR || DB.role === 'branch_manager' || DB.role === 'area_manager';
  if (!myEmpId && !canAssignOthers) { toast('โปรไฟล์ของคุณยังไม่ผูกกับพนักงาน — ติดต่อผู้ดูแลระบบ', 'error'); return; }

  // กันสร้างซ้ำ: ถ้ามาจากกด "เสนอเปลี่ยน" ที่การ์ด + เป็นพนักงาน → เช็คคำขอของตัวเองก่อน
  if (calendarItemId && myEmpId && !canAssignOthers) {
    const myExisting = (DB.data.holidaySwapRequests || []).find(r =>
      r.calendarItemId === calendarItemId &&
      r.employeeId === myEmpId &&
      (r.status === 'pending' || r.status === 'approved')
    );
    if (myExisting) { openSwapRequestDetail(myExisting.id); return; }
  }

  // คำนวณวันถัดไป (D+1)
  const dayAfter = (dateStr) => {
    const ymd = parseYMD(dateStr);
    if (!ymd) return dateStr;
    const d = new Date(ymd[0], ymd[1] - 1, ymd[2] + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const todayStr = tz.today();
  const dayAfterToday = dayAfter(todayStr);
  const todayYear = parseYMD(todayStr)?.[0];

  // รายชื่อวันหยุดสำหรับ dropdown (เฉพาะกรณีไม่มี calendarItemId)
  const allHolidays = DB.getCalendar()
    .filter(c => c.type === 'holiday')
    .filter(c => parseYMD(c.date)?.[0] === todayYear) // เฉพาะปีนี้ (กัน clutter)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Employee picker (เฉพาะ HR/manager)
  let empPickerHtml = '';
  if (canAssignOthers) {
    const empOptions = DB.getEmployees({ status: 'active' })
      .sort((a, b) => (a.firstName || '').localeCompare(b.firstName || ''))
      .map(e => `<option value="${escapeHtml(e.id)}" ${myEmpId === e.id ? 'selected' : ''}>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))} (${escapeHtml(e.id)})${e.branch ? ' · ' + escapeHtml(e.branch) : ''}</option>`).join('');
    empPickerHtml = `<div class="form-group">
      <label>พนักงาน *</label>
      <select name="employeeId" id="swapEmpId" required>
        <option value="">— เลือกพนักงาน —</option>
        ${empOptions}
      </select>
      <div id="swapApproverHint" class="muted-2" style="font-size:11.5px;margin-top:6px"></div>
    </div>`;
  }

  // Holiday picker (ถ้าไม่มี calendarItemId ส่งมา) หรือ display lock (ถ้ามี)
  let holidayPickerHtml = '';
  if (holiday) {
    holidayPickerHtml = `<div class="form-group">
      <label>วันหยุดประเพณี</label>
      <input type="text" value="${escapeHtml(holiday.title)} · ${fmt.date(holiday.date)}" readonly style="background:var(--surface-2);cursor:not-allowed"/>
      <input type="hidden" name="calendarItemId" value="${escapeHtml(calendarItemId)}"/>
    </div>`;
  } else {
    holidayPickerHtml = `<div class="form-group">
      <label>วันหยุดประเพณี *</label>
      <select name="calendarItemId" id="swapHolidayId" required>
        <option value="">— เลือกวันหยุด —</option>
        ${allHolidays.map(c => {
          const isPast = c.date < todayStr;
          return `<option value="${escapeHtml(c.id)}" data-date="${c.date}">${escapeHtml(c.title)} · ${fmt.date(c.date)}${isPast ? ' (ผ่านแล้ว)' : ''}</option>`;
        }).join('')}
      </select>
    </div>`;
  }

  modal.open(canAssignOthers ? 'บันทึกการเปลี่ยนวันหยุดให้พนักงาน' : 'ขอเปลี่ยนวันหยุด', `
    <form id="swapReqForm">
      ${empPickerHtml}
      ${holidayPickerHtml}
      <div class="form-group">
        <label>วันหยุดชดเชย *</label>
        <input name="swapToDate" id="swapToDateInput" type="date" required/>
        <div id="swapRangeHint" class="muted-2" style="font-size:11.5px;margin-top:4px"></div>
      </div>
      <div class="form-group">
        <label>เหตุผล *</label>
        <textarea name="reason" rows="2" required placeholder="เช่น มาทำงานตามคำสั่งหัวหน้า">${canAssignOthers ? 'บริษัทบันทึกการเปลี่ยนวันหยุดให้พนักงาน' : ''}</textarea>
      </div>
      ${canAssignOthers ? `<label style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--success-soft);border:1px solid var(--success);border-radius:8px;font-size:13px;cursor:pointer;margin-bottom:8px">
        <input type="checkbox" name="autoApprove" id="swapAutoApprove" ${DB.isHR ? 'checked' : ''}/>
        <span><strong style="color:var(--success-text)">บันทึกเป็น "อนุมัติแล้ว" ทันที</strong> — ไม่ต้องเข้า approval chain</span>
      </label>` : ''}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">${canAssignOthers ? 'บันทึก' : 'ส่งคำขอ'}</button>
      </div>
    </form>`);

  // ─── อัปเดต range (min/max) ของ swap date ตามวันหยุดที่เลือก ───
  const getSelectedHolidayDate = () => {
    if (holiday) return holiday.date;
    const sel = document.getElementById('swapHolidayId');
    return sel?.value ? DB.getCalendar().find(c => c.id === sel.value)?.date : null;
  };
  const updateDateRange = () => {
    const hDate = getSelectedHolidayDate();
    const dateInput = document.getElementById('swapToDateInput');
    const hint = document.getElementById('swapRangeHint');
    if (!dateInput) return;
    if (!hDate) {
      dateInput.value = ''; dateInput.min = ''; dateInput.max = '';
      if (hint) hint.textContent = 'เลือกวันหยุดประเพณีก่อน';
      return;
    }
    const dayAfterH = dayAfter(hDate);
    const minD = dayAfterH > dayAfterToday ? dayAfterH : dayAfterToday;
    const hYear = parseYMD(hDate)?.[0];
    const maxD = hYear ? `${hYear}-12-31` : '';
    dateInput.min = minD; dateInput.max = maxD;
    if (!dateInput.value || dateInput.value < minD || dateInput.value > maxD) dateInput.value = minD;
    if (hint) hint.textContent = `เลือกได้ ${fmt.date(minD)} – ${fmt.date(maxD)}`;
  };
  document.getElementById('swapHolidayId')?.addEventListener('change', updateDateRange);
  updateDateRange();

  // ─── อัปเดต hint ผู้อนุมัติเมื่อเลือกพนักงาน ───
  const updateApproverHint = () => {
    const hint = document.getElementById('swapApproverHint');
    if (!hint) return;
    const empId = document.getElementById('swapEmpId')?.value;
    if (!empId) { hint.innerHTML = ''; return; }
    const approver = DB.getHolidaySwapApprover(empId);
    const approverName = approver ? (approver.firstName + ' ' + (approver.lastName || '')).trim() : '';
    hint.innerHTML = approverName
      ? `ผู้อนุมัติ: <strong>${escapeHtml(approverName)}</strong>`
      : `<span style="color:var(--warning-text)">⚠ ไม่พบผู้อนุมัติ — ต้องติ๊ก "อนุมัติทันที"</span>`;
  };
  document.getElementById('swapEmpId')?.addEventListener('change', updateApproverHint);
  if (canAssignOthers) updateApproverHint();

  $('#swapReqForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      const calId = data.calendarItemId || calendarItemId;
      const targetEmpId = canAssignOthers ? (data.employeeId || myEmpId) : myEmpId;
      if (!calId) { toast('กรุณาเลือกวันหยุดประเพณี', 'warning'); return; }
      if (!targetEmpId) { toast('กรุณาเลือกพนักงาน', 'warning'); return; }
      const hDate = DB.getCalendar().find(c => c.id === calId)?.date;
      if (!hDate) { toast('ไม่พบวันหยุด', 'error'); return; }
      const hYear = parseYMD(hDate)?.[0];
      if (!data.swapToDate) { toast('กรุณาเลือกวันหยุดชดเชย', 'warning'); return; }
      if (data.swapToDate <= hDate) { toast('วันหยุดชดเชยต้องเป็นวันหลังวันหยุดประเพณี', 'warning'); return; }
      if (data.swapToDate < dayAfterToday) { toast('วันหยุดชดเชยต้องเป็นวันในอนาคต', 'warning'); return; }
      const swapYear = parseYMD(data.swapToDate)?.[0];
      if (swapYear !== hYear) { toast(`วันหยุดชดเชยต้องอยู่ในปีเดียวกับวันหยุดประเพณี (พ.ศ. ${hYear + 543})`, 'warning'); return; }
      // กันสร้างซ้ำ
      const existing = (DB.data.holidaySwapRequests || []).find(r =>
        r.calendarItemId === calId &&
        r.employeeId === targetEmpId &&
        (r.status === 'pending' || r.status === 'approved')
      );
      if (existing) {
        const emp = DB.getEmployee(targetEmpId);
        const status = existing.status === 'approved' ? 'อนุมัติแล้ว' : 'รออนุมัติ';
        toast(`${emp?.firstName || targetEmpId} มีคำขอ${status}อยู่แล้วสำหรับวันหยุดนี้`, 'warning');
        return;
      }
      const autoApprove = canAssignOthers && data.autoApprove === 'on';
      const saved = await DB.saveHolidaySwapRequest({
        calendarItemId: calId,
        employeeId: targetEmpId,
        swapToDate: data.swapToDate,
        reason: data.reason || null,
        status: 'pending'
      });
      // ─── Auto-approve: 2nd API call ที่อาจ fail ขณะ save สำเร็จแล้ว ───
      // ต้อง catch แยกเพื่อไม่ทำให้ user คิดว่า save fail ทั้งหมด
      if (autoApprove && saved?.id) {
        try {
          await DB.approveHolidaySwapRequest(saved.id, '✓ บันทึกและอนุมัติโดย ' + (DB.profile?.employee_id || 'HR'));
          modal.close();
          toast('✓ บันทึก + อนุมัติแล้ว', 'success');
        } catch (approveEx) {
          // save สำเร็จแล้ว แต่ approve ล้มเหลว → record ค้างเป็น pending
          modal.close();
          toast(`บันทึกแล้ว แต่อนุมัติอัตโนมัติไม่สำเร็จ — คำขออยู่ใน "รออนุมัติ" (${approveEx.message || approveEx})`, 'warning');
        }
      } else {
        modal.close();
        toast('ส่งคำขอแล้ว — รออนุมัติ', 'success');
      }
      router.go('calendar');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

function openSwapRequestDetail(requestId) {
  const req = DB.getHolidaySwapRequest(requestId);
  if (!req) { toast('ไม่พบคำขอ', 'error'); return; }
  const holiday = DB.getCalendar().find(c => c.id === req.calendarItemId);
  const requester = DB.getEmployee(req.employeeId);
  const isMine = req.employeeId === DB.profile?.employee_id;
  const canApprove = req.status === 'pending' && DB.canApproveHolidaySwapFor(req.employeeId);
  const canCancel = (req.status === 'pending') && (isMine || DB.isHR);
  const STATUS = SWAP_STATUS_BADGE[req.status] || { label: req.status, cls: 'badge' };

  modal.open('คำขอเปลี่ยนวันหยุด', `
    <div style="background:var(--surface-2);border-radius:10px;padding:14px 16px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:12px">
        <div>
          <div style="font-size:15px;font-weight:600">${escapeHtml(holiday?.title || '—')}</div>
          <div class="muted-2" style="font-size:12.5px;margin-top:2px">${fmt.date(holiday?.date)} → <strong style="color:var(--text)">${fmt.date(req.swapToDate)}</strong></div>
        </div>
        <span class="badge ${STATUS.cls}">${STATUS.label}</span>
      </div>
    </div>
    <div style="font-size:13px;line-height:1.7">
      <div><strong>ผู้ยื่น:</strong> ${escapeHtml((requester?.firstName || '') + ' ' + (requester?.lastName || ''))} (${escapeHtml(req.employeeId)})</div>
      <div><strong>เวลา:</strong> ${req.requestedAt ? new Date(req.requestedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '-'}</div>
      <div><strong>เหตุผล:</strong> ${escapeHtml(req.reason || '-')}</div>
      ${req.approvedAt ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)">
        <div><strong>${req.status === 'approved' ? '✓ อนุมัติเมื่อ' : '✗ ปฏิเสธเมื่อ'}:</strong> ${new Date(req.approvedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</div>
        ${req.approverNote ? `<div><strong>หมายเหตุ:</strong> ${escapeHtml(req.approverNote)}</div>` : ''}
      </div>` : ''}
      ${req.cancelledAt ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)">
        <div><strong>ยกเลิกเมื่อ:</strong> ${new Date(req.cancelledAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</div>
        ${req.cancelReason ? `<div><strong>เหตุผล:</strong> ${escapeHtml(req.cancelReason)}</div>` : ''}
      </div>` : ''}
    </div>
    <div class="form-actions" style="margin-top:18px">
      <button type="button" class="btn btn-secondary" data-close>ปิด</button>
      ${canCancel ? `<button type="button" class="btn btn-ghost" onclick="cancelSwapReq('${req.id}')">ยกเลิกคำขอ</button>` : ''}
      ${canApprove ? `
        <button type="button" class="btn btn-danger" onclick="rejectSwapReq('${req.id}')">ปฏิเสธ</button>
        <button type="button" class="btn btn-primary" onclick="approveSwapReq('${req.id}')">อนุมัติ</button>
      ` : ''}
    </div>`);
}

const SWAP_STATUS_BADGE = {
  pending:   { label: 'รออนุมัติ',   cls: 'badge-warning' },
  approved:  { label: 'อนุมัติแล้ว', cls: 'badge-success' },
  rejected:  { label: 'ปฏิเสธ',      cls: 'badge-danger' },
  cancelled: { label: 'ยกเลิก',      cls: 'badge' }
};

async function approveSwapReq(id) {
  const note = await modal.prompt('อนุมัติคำขอเปลี่ยนวันหยุด', 'หมายเหตุ (ไม่บังคับ):');
  if (note === null) return;
  try {
    await DB.approveHolidaySwapRequest(id, note || '');
    modal.close();
    toast('อนุมัติแล้ว — วันหยุดชดเชยใช้งานได้', 'success');
    router.go('calendar');
  } catch (ex) { toast('อนุมัติไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function rejectSwapReq(id) {
  const note = await modal.prompt('ปฏิเสธคำขอเปลี่ยนวันหยุด', 'เหตุผลที่ปฏิเสธ:');
  if (note === null) return;
  if (!note.trim()) { toast('กรุณาระบุเหตุผล', 'warning'); return; }
  try {
    await DB.rejectHolidaySwapRequest(id, note);
    modal.close();
    toast('ปฏิเสธคำขอแล้ว', 'success');
    router.go('calendar');
  } catch (ex) { toast('ปฏิเสธไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function cancelSwapReq(id) {
  const reason = await modal.prompt('ยกเลิกคำขอ', 'เหตุผลที่ยกเลิก:');
  if (reason === null) return;
  try {
    await DB.cancelHolidaySwapRequest(id, reason || '');
    modal.close();
    toast('ยกเลิกคำขอแล้ว', 'success');
    router.go('calendar');
  } catch (ex) { toast('ยกเลิกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function deleteCalRec(id) {
  if (!requireHR()) return;
  if (!await modal.confirm('ลบ', 'ยืนยัน?')) return;
  try { await DB.deleteCalendarItem(id); toast('ลบแล้ว', 'success'); router.go('calendar'); }
  catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: ANNOUNCEMENTS — ประกาศบริษัท + คำสั่งบริษัท
// ═══════════════════════════════════════════════════════
const _annState = { tab: 'all', search: '', year: '', docNumber: '', titleId: '', unreadOnly: false };
function setAnnFilter(k, v) {
  const newVal = (v ?? '').trim();
  if (_annState[k] === newVal) return;
  _annState[k] = newVal;
  // เปลี่ยน tab → reset docNumber/titleId เพราะรายการอาจไม่มีแล้ว
  if (k === 'tab') { _annState.docNumber = ''; _annState.titleId = ''; }
  router.go('announcements');
}
function toggleAnnUnreadOnly() {
  _annState.unreadOnly = !_annState.unreadOnly;
  router.go('announcements');
}
function clearAnnFilters() {
  _annState.tab = 'all';
  _annState.search = '';
  _annState.year = '';
  _annState.docNumber = '';
  _annState.titleId = '';
  _annState.unreadOnly = false;
  router.go('announcements');
}

const ANN_TYPE_LABEL = { announcement: 'ประกาศ', order: 'คำสั่ง' };
const ANN_TYPE_BADGE = { announcement: 'badge-info', order: 'badge-warning' };
const ANN_PRIORITY_LABEL = { urgent: 'ด่วนมาก', high: 'สำคัญ', normal: 'ปกติ' };
const ANN_PRIORITY_BADGE = { urgent: 'badge-danger', high: 'badge-warning', normal: '' };

router.register('announcements', () => {
  const all = DB.getAnnouncements();
  const todayYear = new Date().getFullYear();

  // ผู้ที่ไม่ใช่ admin/HR เท่านั้นที่นับเป็นผู้รับ + เห็นป้าย/ตัวกรอง "ยังไม่อ่าน"
  const showUnread = !DB.isHR && !!DB.profile?.employee_id;
  const unreadCount = showUnread ? all.filter(a => !DB.isAnnouncementRead(a.id)).length : 0;
  // ถ้าไม่มี read tracking → บังคับ unreadOnly กลับเป็น false (กัน state ค้าง)
  if (!showUnread && _annState.unreadOnly) _annState.unreadOnly = false;

  // ─── Filter (apply ทีละขั้น) ───
  let filtered = all;
  if (_annState.tab !== 'all') filtered = filtered.filter(a => a.type === _annState.tab);
  if (_annState.year) filtered = filtered.filter(a => String(a.createdAt || '').startsWith(_annState.year));
  if (_annState.docNumber) filtered = filtered.filter(a => (a.docNumber || '') === _annState.docNumber);
  if (_annState.titleId) filtered = filtered.filter(a => a.id === _annState.titleId);
  if (_annState.unreadOnly) filtered = filtered.filter(a => !DB.isAnnouncementRead(a.id));
  if (_annState.search) {
    const s = _annState.search.toLowerCase();
    filtered = filtered.filter(a => (a.title || '').toLowerCase().includes(s) || (a.body || '').toLowerCase().includes(s));
  }

  const counts = { all: all.length, announcement: all.filter(a => a.type === 'announcement').length, order: all.filter(a => a.type === 'order').length };
  const pinned = filtered.filter(a => a.pinned);
  const recent = filtered.filter(a => !a.pinned);

  // ปีสำหรับ dropdown (มีข้อมูล + ปัจจุบัน)
  const yearsSet = new Set(all.map(a => String(a.createdAt || '').slice(0, 4)).filter(Boolean));
  for (let y = todayYear - 2; y <= todayYear; y++) yearsSet.add(String(y));
  const yearOptions = Array.from(yearsSet).filter(Boolean).sort((a, b) => Number(b) - Number(a));

  // เลขที่ + หัวข้อ dropdown — ปรับตาม tab + ปี ที่เลือกอยู่ (filter ขั้นก่อนหน้า)
  const scopeForDropdowns = all.filter(a => {
    if (_annState.tab !== 'all' && a.type !== _annState.tab) return false;
    if (_annState.year && !String(a.createdAt || '').startsWith(_annState.year)) return false;
    return true;
  });
  const docNumberOptions = [...new Set(scopeForDropdowns.map(a => a.docNumber).filter(Boolean))]
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const titleOptions = scopeForDropdowns
    .filter(a => a.title)
    .map(a => ({ id: a.id, title: a.title, type: a.type, docNumber: a.docNumber || '' }))
    .sort((a, b) => a.title.localeCompare(b.title, 'th'));

  const hasFilters = !!(_annState.search || _annState.year || _annState.docNumber || _annState.titleId || _annState.tab !== 'all' || _annState.unreadOnly);

  const renderCard = (a) => {
    const TYPE = { label: ANN_TYPE_LABEL[a.type] || a.type, cls: ANN_TYPE_BADGE[a.type] || 'badge' };
    const PRI = a.priority !== 'normal' ? { label: ANN_PRIORITY_LABEL[a.priority], cls: ANN_PRIORITY_BADGE[a.priority] } : null;
    const dateStr = a.createdAt ? new Date(a.createdAt).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }) : '';
    const bodyPreview = (a.body || '').replace(/\s+/g, ' ').slice(0, 140);
    const isUnread = showUnread && !DB.isAnnouncementRead(a.id);
    const docLabel = a.docNumber ? `${a.type === 'order' ? 'คำสั่งที่' : 'ประกาศที่'} ${a.docNumber}` : '';
    const cardClasses = ['sw-ann-card', a.pinned ? 'is-pinned' : '', isUnread ? 'is-unread' : ''].filter(Boolean).join(' ');
    return `<div class="${cardClasses}" data-type="${a.type}" onclick="openAnnouncementDetail('${a.id}')">
      ${a.imageUrl ? `<div class="sw-ann-thumb" style="background-image:url('${escapeHtml(a.imageUrl)}')"></div>` : ''}
      <div class="sw-ann-body">
        <div class="sw-ann-meta">
          ${isUnread ? '<span class="sw-ann-unread">ยังไม่ได้อ่าน</span>' : ''}
          <span class="sw-ann-type sw-ann-type-${a.type}">${TYPE.label}</span>
          ${PRI ? `<span class="sw-ann-pri sw-ann-pri-${a.priority}">${PRI.label}</span>` : ''}
          ${a.pinned ? '<span class="sw-ann-pin"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.5 2.5l7 7-3.5 1.5-3.5 3.5-1 5-1.5-1.5-3.5 3.5-1-1 3.5-3.5L8 14.5l5-1 3.5-3.5L18 6.5l-3.5-4z"/></svg>ปักหมุด</span>' : ''}
          <span class="sw-ann-date">${dateStr}</span>
        </div>
        ${docLabel ? `<div class="sw-ann-doc">${escapeHtml(docLabel)}</div>` : ''}
        <div class="sw-ann-title">${escapeHtml(a.title)}</div>
        <div class="sw-ann-preview">${escapeHtml(bodyPreview)}${a.body.length > 140 ? '…' : ''}</div>
      </div>
    </div>`;
  };

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ประกาศ &amp; คำสั่งบริษัท</div>
        <div class="sw-page-subtitle">${DB.isHR ? 'สร้าง · แก้ไข · เผยแพร่ให้พนักงาน' : 'ติดตามข่าวสารและคำสั่งจากบริษัท'} · รวม ${fmt.num(all.length)} รายการ</div>
      </div>
      <div class="sw-page-actions">${DB.isHR ? '<button class="btn btn-primary" onclick="openAnnouncementForm()">+ สร้างใหม่</button>' : ''}</div>
    </div>

    <div class="sw-tabs" style="margin-bottom:14px">
      <button class="sw-tab ${_annState.tab === 'all' ? 'active' : ''}" onclick="setAnnFilter('tab', 'all')">
        <span>ทั้งหมด</span><span class="sw-tab-pill">${fmt.num(counts.all)}</span>
      </button>
      <button class="sw-tab ${_annState.tab === 'announcement' ? 'active' : ''}" onclick="setAnnFilter('tab', 'announcement')">
        <span>ประกาศ</span>${counts.announcement ? `<span class="sw-tab-pill">${fmt.num(counts.announcement)}</span>` : ''}
      </button>
      <button class="sw-tab ${_annState.tab === 'order' ? 'active' : ''}" onclick="setAnnFilter('tab', 'order')">
        <span>คำสั่ง</span>${counts.order ? `<span class="sw-tab-pill">${fmt.num(counts.order)}</span>` : ''}
      </button>
    </div>

    <div class="sw-filter-bar" style="margin-bottom:18px">
      <input type="text" class="sw-filter-input" placeholder="🔍 ค้นชื่อ/เนื้อหา" value="${escapeHtml(_annState.search)}"
        onkeydown="if(event.key==='Enter'){event.preventDefault();setAnnFilter('search', this.value);}"
        onblur="setAnnFilter('search', this.value)"/>
      <select class="sw-filter-select" onchange="setAnnFilter('year', this.value)">
        <option value="">— ทุกปี —</option>
        ${yearOptions.map(y => `<option value="${y}" ${_annState.year === y ? 'selected' : ''}>ปี ${Number(y) + 543}${Number(y) === todayYear ? ' (ปัจจุบัน)' : ''}</option>`).join('')}
      </select>
      <select class="sw-filter-select" onchange="setAnnFilter('docNumber', this.value)" title="กรองตามเลขที่เอกสาร">
        <option value="">${_annState.tab === 'order' ? '— ทุกเลขที่คำสั่ง —' : _annState.tab === 'announcement' ? '— ทุกเลขที่ประกาศ —' : '— ทุกเลขที่ —'}</option>
        ${docNumberOptions.map(n => `<option value="${escapeHtml(n)}" ${_annState.docNumber === n ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
      </select>
      <select class="sw-filter-select" onchange="setAnnFilter('titleId', this.value)" title="กรองตามหัวข้อ" style="max-width:280px">
        <option value="">${_annState.tab === 'order' ? '— ทุกหัวข้อคำสั่ง —' : _annState.tab === 'announcement' ? '— ทุกหัวข้อประกาศ —' : '— ทุกหัวข้อ —'}</option>
        ${titleOptions.map(o => {
          const typeLabel = o.type === 'order' ? '[คำสั่ง]' : '[ประกาศ]';
          const docPrefix = o.docNumber ? `${o.docNumber} · ` : '';
          const display = (o.title.length > 50 ? o.title.slice(0, 50) + '…' : o.title);
          const fullLabel = `${_annState.tab === 'all' ? typeLabel + ' ' : ''}${docPrefix}${display}`;
          return `<option value="${escapeHtml(o.id)}" ${_annState.titleId === o.id ? 'selected' : ''} title="${escapeHtml(o.title)}">${escapeHtml(fullLabel)}</option>`;
        }).join('')}
      </select>
      ${showUnread ? `<button class="sw-filter-unread ${_annState.unreadOnly ? 'is-active' : ''}" onclick="toggleAnnUnreadOnly()" title="${_annState.unreadOnly ? 'แสดงทั้งหมด' : 'กรองเฉพาะที่ยังไม่ได้อ่าน'}">
        <span class="sw-filter-unread-dot"></span>ยังไม่อ่าน${unreadCount ? `<span class="sw-filter-unread-count">${fmt.num(unreadCount)}</span>` : ''}
      </button>` : ''}
      ${hasFilters ? `<button class="btn btn-ghost btn-sm sw-filter-clear" onclick="clearAnnFilters()">✕ ล้างตัวกรอง</button>` : ''}
    </div>

    ${filtered.length ? `
      ${pinned.length ? `<div class="sw-section-label" style="margin-bottom:10px">📌 ปักหมุด</div>
      <div class="sw-ann-grid">${pinned.map(renderCard).join('')}</div>` : ''}
      ${recent.length ? `${pinned.length ? '<div class="sw-section-label" style="margin-top:24px;margin-bottom:10px">รายการล่าสุด</div>' : ''}
      <div class="sw-ann-grid">${recent.map(renderCard).join('')}</div>` : ''}
    ` : `
      <div class="sw-chart-card">
        <div class="empty-state" style="padding:60px 20px">
          <div style="font-size:42px;margin-bottom:12px;opacity:0.35">${_annState.unreadOnly && unreadCount === 0 ? '✓' : '📣'}</div>
          <div class="title" style="font-size:16px;font-weight:600">${
            _annState.unreadOnly && unreadCount === 0 ? 'อ่านครบทุกฉบับแล้ว'
            : hasFilters ? 'ไม่พบประกาศตามตัวกรอง'
            : 'ยังไม่มีประกาศหรือคำสั่ง'
          }</div>
          <div class="hint" style="margin-top:6px">${
            _annState.unreadOnly && unreadCount === 0 ? 'เยี่ยมมาก — ไม่มีข่าวสารที่ยังไม่ได้อ่าน'
            : hasFilters ? 'ลองล้างตัวกรองเพื่อดูทั้งหมด'
            : (DB.isHR ? 'กด + สร้างใหม่ เพื่อเริ่ม' : 'รอ HR ประกาศ')
          }</div>
        </div>
      </div>`}
  `;
});

function openAnnouncementDetail(id) {
  const a = DB.getAnnouncement(id);
  if (!a) { toast('ไม่พบประกาศ', 'error'); return; }
  const TYPE = { label: ANN_TYPE_LABEL[a.type] || a.type, cls: ANN_TYPE_BADGE[a.type] || 'badge' };
  const PRI = a.priority !== 'normal' ? { label: ANN_PRIORITY_LABEL[a.priority], cls: ANN_PRIORITY_BADGE[a.priority] } : null;
  const createdStr = a.createdAt ? new Date(a.createdAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const docLabel = a.docNumber ? `${a.type === 'order' ? 'คำสั่งที่' : 'ประกาศที่'} ${a.docNumber}` : '';
  modal.open(a.title, `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <span class="badge ${TYPE.cls}">${TYPE.label}</span>
      ${PRI ? `<span class="badge ${PRI.cls}">⚠ ${PRI.label}</span>` : ''}
      ${a.pinned ? '<span style="font-size:12px;color:var(--warning);font-weight:600">📌 ปักหมุด</span>' : ''}
      <span class="muted-2" style="font-size:12px;margin-left:auto">${createdStr}</span>
    </div>
    ${docLabel ? `<div style="font-size:14px;font-weight:700;color:var(--primary);margin-bottom:12px;font-variant-numeric:tabular-nums">${escapeHtml(docLabel)}</div>` : ''}
    ${a.imageUrl ? `<div style="margin-bottom:14px;border-radius:10px;overflow:hidden;border:1px solid var(--border)"><img src="${escapeHtml(a.imageUrl)}" style="width:100%;display:block;max-height:420px;object-fit:contain;background:var(--surface-2)"/></div>` : ''}
    ${(a.effectiveDate || a.expiresDate) ? `<div style="display:flex;gap:14px;font-size:12.5px;color:var(--text-2);padding:10px 14px;background:var(--surface-2);border-radius:8px;margin-bottom:14px">
      ${a.effectiveDate ? `<div><strong>มีผลตั้งแต่:</strong> ${fmt.date(a.effectiveDate)}</div>` : ''}
      ${a.expiresDate ? `<div><strong>สิ้นสุด:</strong> ${fmt.date(a.expiresDate)}</div>` : ''}
    </div>` : ''}
    <div style="font-size:14px;line-height:1.7;white-space:pre-wrap;color:var(--text)">${escapeHtml(a.body || '')}</div>
    ${DB.isHR ? `<div id="annReadersBox" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
      <div class="muted-2" style="font-size:12.5px">⏳ กำลังโหลดสถานะผู้อ่าน...</div>
    </div>` : ''}
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" data-close>ปิด</button>
      ${DB.isHR ? `<button type="button" class="btn btn-ghost" onclick="deleteAnnouncement('${a.id}')">ลบ</button>
      <button type="button" class="btn btn-primary" onclick="modal.close();openAnnouncementForm('${a.id}')">แก้ไข</button>` : ''}
    </div>
  `);
  // พนักงาน: บันทึกว่าอ่านแล้ว (fire-and-forget) · admin/HR: โหลดรายชื่อผู้อ่าน
  if (DB.isHR) {
    loadAnnouncementReaders(a.id);
  } else {
    const wasUnread = !DB.isAnnouncementRead(a.id);
    DB.markAnnouncementRead(a.id).then(() => {
      if (wasUnread) {
        updateAnnouncementBadge();
        // re-render หน้า list (ถ้าอยู่หน้านั้น) เพื่อลบป้าย "ยังไม่อ่าน" ออกจาก card
        if (router.current === 'announcements') router.go('announcements');
      }
    });
  }
}

async function loadAnnouncementReaders(id) {
  const box = document.getElementById('annReadersBox');
  if (!box) return;
  let res;
  try {
    res = await DB.getAnnouncementReaders(id);
  } catch (e) {
    box.innerHTML = `<div class="muted-2" style="font-size:12.5px;color:var(--danger)">โหลดรายชื่อผู้อ่านไม่สำเร็จ: ${escapeHtml(e.message || String(e))}</div>`;
    return;
  }
  const { readers, unread } = res;
  const total = readers.length + unread.length;
  const pct = total > 0 ? Math.round(readers.length / total * 100) : 0;
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const row = (e, extra = '') => `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px dashed var(--border);font-size:12.5px">
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;color:var(--text)">${escapeHtml(e.name)}</div>
      <div class="muted-2" style="font-size:11.5px">${escapeHtml(e.position || '-')} · ${escapeHtml(e.branch || '-')}</div>
    </div>
    ${extra}
  </div>`;
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <div style="font-size:13.5px;font-weight:600;color:var(--text)">📊 สถานะผู้อ่าน</div>
      <span class="badge badge-success" style="font-size:11px">อ่านแล้ว ${readers.length}</span>
      <span class="badge" style="font-size:11px;background:rgba(220,38,38,0.12);color:var(--danger)">ยังไม่อ่าน ${unread.length}</span>
      <span class="muted-2" style="font-size:11.5px;margin-left:auto">${pct}% ของพนักงานที่ปฏิบัติงาน</span>
    </div>
    <div class="sw-bar-bg" style="margin-bottom:14px"><div class="sw-bar-fill" style="width:${pct}%;background:var(--success)"></div></div>
    <details ${readers.length ? 'open' : ''} style="margin-bottom:10px">
      <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--success);padding:4px 0">✓ อ่านแล้ว (${readers.length})</summary>
      <div style="max-height:240px;overflow-y:auto;margin-top:6px">
        ${readers.length ? readers.map(e => row(e, `<div style="font-size:11px;color:var(--text-3);text-align:right;flex-shrink:0">${fmtTime(e.readAt)}</div>`)).join('') : '<div class="muted-2" style="font-size:12px;padding:8px 0">— ยังไม่มีพนักงานอ่าน —</div>'}
      </div>
    </details>
    <details style="margin-bottom:4px">
      <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--danger);padding:4px 0">✗ ยังไม่อ่าน (${unread.length})</summary>
      <div style="max-height:240px;overflow-y:auto;margin-top:6px">
        ${unread.length ? unread.map(e => row(e)).join('') : '<div class="muted-2" style="font-size:12px;padding:8px 0">— อ่านครบทุกคนแล้ว 🎉 —</div>'}
      </div>
    </details>
  `;
}

function openAnnouncementForm(id = null) {
  if (!requireHR()) return;
  const editing = id ? DB.getAnnouncement(id) : null;
  const a = editing || { type: 'announcement', docNumber: '', title: '', body: '', imageUrl: null, priority: 'normal', pinned: false, effectiveDate: '', expiresDate: '' };
  let pendingImageUrl = a.imageUrl;
  const suggestedDoc = !editing ? DB.suggestNextAnnouncementNumber(a.type) : '';
  modal.open(editing ? 'แก้ไขประกาศ' : 'สร้างประกาศใหม่', `
    <form id="annForm">
      <div class="form-grid">
        <div class="form-group"><label>ประเภท *</label>
          <select name="type" id="annTypeSelect" required>
            <option value="announcement" ${a.type === 'announcement' ? 'selected' : ''}>📣 ประกาศ</option>
            <option value="order" ${a.type === 'order' ? 'selected' : ''}>📋 คำสั่ง</option>
          </select>
        </div>
        <div class="form-group"><label>ความสำคัญ</label>
          <select name="priority">
            <option value="normal" ${a.priority === 'normal' ? 'selected' : ''}>ปกติ</option>
            <option value="high" ${a.priority === 'high' ? 'selected' : ''}>สำคัญ</option>
            <option value="urgent" ${a.priority === 'urgent' ? 'selected' : ''}>ด่วนมาก</option>
          </select>
        </div>
        <div class="form-group span-2">
          <label>เลขที่เอกสาร <span class="muted-2" style="font-weight:normal;font-size:11px">(เช่น 001/2569 — เว้นว่างได้)</span></label>
          <input name="docNumber" id="annDocNumberInput" value="${escapeHtml(a.docNumber || '')}" maxlength="40" placeholder="เช่น 001/2569"/>
          ${!editing ? `<div style="margin-top:6px"><button type="button" class="btn btn-ghost btn-sm" style="padding:4px 10px;font-size:11.5px" onclick="document.getElementById('annDocNumberInput').value=DB.suggestNextAnnouncementNumber(document.getElementById('annTypeSelect').value);document.getElementById('annDocNumberInput').focus()">↻ ใช้เลขถัดไป (<span id="annDocSuggested">${escapeHtml(suggestedDoc)}</span>)</button></div>` : ''}
        </div>
        <div class="form-group span-2"><label>หัวข้อ *</label>
          <input name="title" value="${escapeHtml(a.title)}" required maxlength="200" placeholder="เช่น ประกาศวันหยุดประจำปี 2569"/>
        </div>
        <div class="form-group span-2"><label>เนื้อหา *</label>
          <textarea name="body" rows="6" required placeholder="รายละเอียดประกาศ...">${escapeHtml(a.body)}</textarea>
        </div>
        <div class="form-group"><label>วันมีผล (optional)</label>
          <input name="effectiveDate" type="date" value="${a.effectiveDate || ''}"/>
        </div>
        <div class="form-group"><label>วันสิ้นสุด (optional)</label>
          <input name="expiresDate" type="date" value="${a.expiresDate || ''}"/>
        </div>
        <div class="form-group span-2">
          <label>รูปประกอบ (optional, max 5 MB)</label>
          <input type="file" id="annImageInput" accept="image/*" style="margin-bottom:8px"/>
          <div id="annImagePreview" style="${pendingImageUrl ? '' : 'display:none'};border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface-2);max-height:200px">
            ${pendingImageUrl ? `<img src="${escapeHtml(pendingImageUrl)}" style="width:100%;display:block;max-height:200px;object-fit:contain"/>` : ''}
          </div>
          ${pendingImageUrl ? `<button type="button" class="btn btn-ghost btn-sm" id="annImageRemove" style="margin-top:6px;color:var(--danger)">✕ ลบรูป</button>` : ''}
        </div>
        <label style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--surface-2);border-radius:8px;font-size:13px;cursor:pointer;grid-column:span 2">
          <input type="checkbox" name="pinned" ${a.pinned ? 'checked' : ''}/>
          <span>📌 <strong>ปักหมุด</strong> — แสดงไว้บนสุดของรายการ</span>
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">${editing ? 'บันทึก' : 'เผยแพร่'}</button>
      </div>
    </form>
  `, { size: 'lg' });

  // Image upload handling
  $('#annImageInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('ไฟล์ใหญ่เกิน 5 MB', 'warning'); e.target.value = ''; return; }
    const preview = $('#annImagePreview');
    preview.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-3)">⏳ กำลังอัปโหลด...</div>';
    preview.style.display = '';
    try {
      const url = await DB.uploadAnnouncementImage(file);
      pendingImageUrl = url;
      preview.innerHTML = `<img src="${escapeHtml(url)}" style="width:100%;display:block;max-height:200px;object-fit:contain"/>`;
    } catch (ex) {
      preview.style.display = 'none';
      toast('อัปโหลดไม่สำเร็จ: ' + (ex.message || ex), 'error');
      e.target.value = '';
    }
  });
  $('#annImageRemove')?.addEventListener('click', () => {
    pendingImageUrl = null;
    $('#annImagePreview').style.display = 'none';
    $('#annImagePreview').innerHTML = '';
    $('#annImageInput').value = '';
  });

  // ปุ่ม "ใช้เลขถัดไป" ใช้ DB.suggestNextAnnouncementNumber → ต้องอัปเดตเมื่อเปลี่ยนประเภท
  $('#annTypeSelect')?.addEventListener('change', (e) => {
    const span = document.getElementById('annDocSuggested');
    if (span) span.textContent = DB.suggestNextAnnouncementNumber(e.target.value);
  });

  $('#annForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      await DB.saveAnnouncement({
        id: editing?.id,
        type: data.type,
        docNumber: data.docNumber || '',
        title: data.title,
        body: data.body,
        imageUrl: pendingImageUrl || null,
        priority: data.priority,
        pinned: data.pinned === 'on',
        effectiveDate: data.effectiveDate || null,
        expiresDate: data.expiresDate || null
      });
      modal.close();
      toast(editing ? 'แก้ไขแล้ว' : 'เผยแพร่แล้ว', 'success');
      router.go('announcements');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteAnnouncement(id) {
  if (!requireHR()) return;
  if (!await modal.confirm('ลบประกาศ', 'แน่ใจหรือไม่? รูปประกอบจะถูกลบด้วย')) return;
  try {
    await DB.deleteAnnouncement(id);
    modal.close();
    toast('ลบแล้ว', 'success');
    router.go('announcements');
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ═══════════════════════════════════════════════════════
//  PAGE: SETTINGS
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
//  PAGE: AUDIT LOG (ประวัติการแก้ไข — admin only)
// ═══════════════════════════════════════════════════════
const _auditState = {
  page: 0, pageSize: 50,
  filterTable: '', filterAction: '', filterSearch: '',
  rows: [], total: 0, loading: false, hasLoaded: false
};
const AUDIT_TABLE_LABELS = {
  employees: 'พนักงาน',
  salary_history: 'ปรับค่าจ้าง/ตำแหน่ง/สาขา',
  applicants: 'ผู้สมัคร',
  loans: 'การกู้',
  advances: 'เบิกเงินล่วงหน้า',
  allowances: 'เบี้ยเลี้ยง',
  evaluations: 'ประเมินผลงาน',
  uniform_requests: 'คำขอจัดชุด',
  uniform_issues: 'การจัดชุด',
  uniform_items: 'รายการชุด',
  branches: 'สาขา',
  departments: 'ฝ่าย',
  position_levels: 'ระดับตำแหน่ง',
  user_profiles: 'โปรไฟล์ผู้ใช้',
  leave_requests: 'คำขอลา',
  leave_types: 'ตั้งค่าประเภทการลา',
  calendar_items: 'ปฏิทินวันหยุด',
  holiday_swap_requests: 'คำขอเปลี่ยนวันหยุด',
  company_announcements: 'ประกาศ & คำสั่ง'
};
// ═══════════════════════════════════════════════════════
//  PAGE: BLACKLIST (รายชื่อห้ามจ้าง)
// ═══════════════════════════════════════════════════════
const BL_CATEGORY = {
  theft:       { label: 'ขโมย/ฉ้อโกง',    badge: 'badge-danger' },
  fraud:       { label: 'ทุจริต',           badge: 'badge-danger' },
  violence:    { label: 'ความรุนแรง',     badge: 'badge-danger' },
  conduct:     { label: 'ฝ่าฝืนระเบียบ',  badge: 'badge-warning' },
  performance: { label: 'ผลงาน',           badge: 'badge-warning' },
  attendance:  { label: 'ขาดงานบ่อย',     badge: 'badge-warning' },
  other:       { label: 'อื่นๆ',             badge: 'badge-neutral' }
};
const BL_SEVERITY = {
  permanent: { label: '⛔ ห้ามถาวร',  badge: 'badge-danger' },
  temporary: { label: '⏳ ห้ามชั่วคราว', badge: 'badge-warning' },
  review:    { label: '⚠️ ทบทวน',       badge: 'badge-info' }
};
const blState = { list: [], loading: false, includeRemoved: false, search: '', category: '', severity: '' };
let _blSearchTimer;

async function loadBlacklist() {
  if (!DB.isHR) return;
  blState.loading = true;
  try {
    blState.list = await DB.getBlacklist({ includeRemoved: blState.includeRemoved });
  } catch (ex) {
    toast('โหลด blacklist ไม่สำเร็จ: ' + (ex.message || ex), 'error');
    blState.list = [];
  } finally {
    blState.loading = false;
    router.go('blacklist');
  }
}

router.register('blacklist', () => {
  if (!DB.canManageBlacklist()) {
    return `<div class="sw-chart-card"><div class="empty-state" style="padding:80px 20px"><div style="font-size:48px;margin-bottom:14px;opacity:0.4">🔒</div><div class="title" style="font-size:17px;font-weight:600">เฉพาะ admin / HR เท่านั้น</div></div></div>`;
  }
  // โหลดครั้งแรก
  if (!blState.list.length && !blState.loading && !blState._loaded) {
    blState._loaded = true;
    runWhenIdle(() => loadBlacklist());
  }
  const sLc = (blState.search || '').toLowerCase().trim();
  const filtered = blState.list.filter(b => {
    if (blState.category && b.category !== blState.category) return false;
    if (blState.severity && b.severity !== blState.severity) return false;
    if (sLc) {
      const hay = (b.national_id + ' ' + (b.full_name || '') + ' ' + (b.nickname || '') + ' ' + (b.previous_emp_id || '') + ' ' + (b.reason || '')).toLowerCase();
      if (!hay.includes(sLc)) return false;
    }
    return true;
  });

  const hasFilter = blState.search || blState.category || blState.severity || blState.includeRemoved;

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">🚫 รายชื่อห้ามจ้าง</div>
        <div class="sw-page-subtitle">บันทึกบุคคลที่ไม่ควรรับเข้าทำงาน · ระบบเช็คอัตโนมัติเมื่อกรอกเลข ปชช.</div>
      </div>
      <div class="sw-page-actions">
        <button class="btn btn-primary" onclick="openBlacklistForm()">+ เพิ่มรายชื่อ</button>
      </div>
    </div>
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายการ ${hasFilter ? `<span class="sw-chart-count">${fmt.num(filtered.length)} / ${fmt.num(blState.list.length)}</span>` : `<span class="sw-chart-count">${fmt.num(blState.list.length)}</span>`}</div>
          <div class="sw-chart-sub">⚠️ ข้อมูลละเอียดอ่อน (PDPA) — เก็บเฉพาะที่มีหลักฐานยืนยัน · ทบทวนทุก 6-12 เดือน</div>
        </div>
      </div>
      <div class="sw-filter-bar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border)">
        <input id="blSearch" class="sw-filter-input" type="search" placeholder="🔍 ค้นชื่อ / เลข ปชช. / เหตุผล" value="${escapeHtml(blState.search)}" style="flex:1;min-width:200px"/>
        <select class="sw-filter-select" id="blCategory">
          <option value="">— ทุกหมวด —</option>
          ${Object.entries(BL_CATEGORY).map(([k, v]) => `<option value="${k}" ${blState.category === k ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
        </select>
        <select class="sw-filter-select" id="blSeverity">
          <option value="">— ทุกระดับ —</option>
          ${Object.entries(BL_SEVERITY).map(([k, v]) => `<option value="${k}" ${blState.severity === k ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
        </select>
        <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-2);cursor:pointer">
          <input type="checkbox" id="blIncludeRemoved" ${blState.includeRemoved ? 'checked' : ''}/> แสดงที่ลบแล้ว
        </label>
        ${hasFilter ? `<button class="btn btn-ghost btn-sm" onclick="clearBlFilters()">✕ ล้างตัวกรอง</button>` : ''}
      </div>
      ${blState.loading ? `<div class="empty-state" style="padding:40px 20px"><div class="skeleton" style="height:14px;width:160px;margin:0 auto 8px"></div><div class="muted-2" style="font-size:12px">กำลังโหลด...</div></div>` :
        filtered.length === 0 ? `<div class="empty-state" style="padding:40px 20px">
          <div style="font-size:32px;margin-bottom:8px;opacity:0.3">${hasFilter ? '🔍' : '✓'}</div>
          <div class="title" style="font-size:14px;font-weight:600">${hasFilter ? 'ไม่พบรายการที่ตรงกับตัวกรอง' : 'ยังไม่มีรายชื่อห้ามจ้าง'}</div>
          <div class="hint" style="margin-top:4px">${hasFilter ? 'ลองล้างตัวกรอง' : 'กดปุ่ม + เพิ่มรายชื่อ เพื่อเริ่ม'}</div>
        </div>` : `<div class="table-wrap"><table class="table table-compact">
        <thead><tr>
          <th>เลข ปชช.</th><th>ชื่อ-นามสกุล</th><th>หมวด</th><th>ระดับ</th>
          <th>เหตุผล</th><th>รหัสเดิม</th><th>บันทึกโดย</th><th>วันที่</th><th>สถานะ</th><th></th>
        </tr></thead>
        <tbody>
          ${filtered.map(b => {
            const cat = BL_CATEGORY[b.category] || { label: b.category, badge: 'badge' };
            const sev = BL_SEVERITY[b.severity] || { label: b.severity, badge: 'badge' };
            const isRemoved = !!b.removed_at;
            return `<tr style="${isRemoved ? 'opacity:0.55' : ''}">
              <td><code style="font-size:11.5px;font-weight:600">${escapeHtml(b.national_id)}</code></td>
              <td><strong>${escapeHtml(b.full_name)}</strong>${b.nickname ? ` <span class="muted-2">(${escapeHtml(b.nickname)})</span>` : ''}</td>
              <td><span class="badge ${cat.badge}">${escapeHtml(cat.label)}</span></td>
              <td><span class="badge ${sev.badge}">${escapeHtml(sev.label)}</span>${b.review_date ? `<div class="muted-2" style="font-size:11px;margin-top:2px">ทบทวน ${fmt.date(b.review_date)}</div>` : ''}</td>
              <td class="sw-reason-cell">${escapeHtml(b.reason)}</td>
              <td class="sw-cell-meta">${b.previous_emp_id ? `<code style="font-size:11.5px">${escapeHtml(b.previous_emp_id)}</code>` : '—'}</td>
              <td class="sw-cell-meta">${escapeHtml(b.created_by || '-')}</td>
              <td class="sw-cell-meta">${fmt.date(b.created_at)}</td>
              <td>${isRemoved ? `<span class="badge badge-neutral">✓ ถอดแล้ว</span><div class="muted-2" style="font-size:10.5px;margin-top:2px">${fmt.date(b.removed_at)}</div>` : `<span class="badge badge-danger">active</span>`}</td>
              <td class="actions">
                ${isRemoved ? '' : `<button class="btn btn-ghost btn-sm" onclick="openBlacklistForm(${b.id})">แก้</button>
                  <button class="btn btn-ghost btn-sm" onclick="removeBlacklistEntry(${b.id})">ถอด</button>`}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`}
    </div>`;
});

function wireBlacklistPage() {
  $('#blSearch')?.addEventListener('input', (e) => {
    clearTimeout(_blSearchTimer);
    _blSearchTimer = setTimeout(() => { blState.search = e.target.value; router.go('blacklist'); }, 200);
  });
  $('#blCategory')?.addEventListener('change', (e) => { blState.category = e.target.value; router.go('blacklist'); });
  $('#blSeverity')?.addEventListener('change', (e) => { blState.severity = e.target.value; router.go('blacklist'); });
  $('#blIncludeRemoved')?.addEventListener('change', (e) => {
    blState.includeRemoved = e.target.checked;
    blState._loaded = false;
    loadBlacklist();
  });
}
function clearBlFilters() {
  blState.search = '';
  blState.category = '';
  blState.severity = '';
  blState.includeRemoved = false;
  blState._loaded = false;
  loadBlacklist();
}

function openBlacklistForm(id = null) {
  if (!DB.canManageBlacklist()) return;
  const b = id ? (blState.list.find(x => x.id === id) || {}) : {};
  const isEdit = !!id;
  modal.open(isEdit ? 'แก้ไขรายชื่อห้ามจ้าง' : 'เพิ่มรายชื่อห้ามจ้าง', `
    <form id="blForm">
      <div class="form-grid">
        <div class="form-group"><label>เลข ปชช. *</label><input name="nationalId" value="${escapeHtml(b.national_id || '')}" required maxlength="20" ${isEdit ? 'readonly' : ''} placeholder="13 หลัก"/></div>
        <div class="form-group"><label>ชื่อ-นามสกุล *</label><input name="fullName" value="${escapeHtml(b.full_name || '')}" required placeholder="เช่น นาย ก. นามสมมุติ"/></div>
        <div class="form-group"><label>ชื่อเล่น</label><input name="nickname" value="${escapeHtml(b.nickname || '')}"/></div>
        <div class="form-group"><label>เบอร์โทร</label><input name="phone" value="${escapeHtml(b.phone || '')}"/></div>
        <div class="form-group"><label>รหัสพนักงานเดิม</label><input name="previousEmpId" value="${escapeHtml(b.previous_emp_id || '')}" placeholder="ถ้าเคยทำงาน"/></div>
        <div class="form-group"><label>หมวด *</label><select name="category" required>
          ${Object.entries(BL_CATEGORY).map(([k, v]) => `<option value="${k}" ${b.category === k ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
        </select></div>
        <div class="form-group"><label>ระดับ *</label><select name="severity" id="blFormSeverity" required>
          ${Object.entries(BL_SEVERITY).map(([k, v]) => `<option value="${k}" ${(b.severity || 'permanent') === k ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
        </select></div>
        <div class="form-group" id="blFormReviewWrap"><label>วันที่ทบทวน <span class="muted-2" style="font-weight:normal;font-size:11px">(สำหรับ "ห้ามชั่วคราว")</span></label>
          <input name="reviewDate" type="date" value="${b.review_date || ''}"/>
        </div>
        <div class="form-group span-2"><label>เหตุผล *</label><input name="reason" value="${escapeHtml(b.reason || '')}" required maxlength="200" placeholder="สรุปสั้นๆ"/></div>
        <div class="form-group span-2"><label>รายละเอียดเพิ่ม + หลักฐาน</label><textarea name="notes" rows="3" placeholder="เช่น วันที่เกิดเหตุ ลักษณะ มูลค่า เอกสารอ้างอิง">${escapeHtml(b.notes || '')}</textarea></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>`);
  const toggleReview = () => {
    const sev = $('#blFormSeverity')?.value;
    const wrap = $('#blFormReviewWrap');
    if (wrap) wrap.style.display = sev === 'temporary' ? '' : 'none';
  };
  $('#blFormSeverity')?.addEventListener('change', toggleReview);
  toggleReview();
  $('#blForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target).entries());
      if (isEdit) data.id = id;
      await DB.saveBlacklistEntry(data);
      modal.close();
      toast(isEdit ? 'แก้ไขแล้ว' : 'เพิ่มแล้ว', 'success');
      blState._loaded = false;
      loadBlacklist();
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function removeBlacklistEntry(id) {
  if (!DB.canManageBlacklist()) return;
  const reason = await modal.prompt('ถอดจาก blacklist',
    'ระบุเหตุผลที่ถอด (เช่น "ทำงานครบ 2 ปี ไม่มีปัญหา", "ผ่านการทบทวน"):', '');
  if (reason === null) return;
  try {
    await DB.removeBlacklistEntry(id, reason);
    toast('ถอดออกแล้ว — เก็บไว้เป็น audit trail', 'success');
    blState._loaded = false;
    loadBlacklist();
  } catch (ex) { toast('ถอดไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

const AUDIT_ACTION_LABELS = { INSERT: 'เพิ่ม', UPDATE: 'แก้ไข', DELETE: 'ลบ' };
const AUDIT_ACTION_COLORS = { INSERT: 'badge-success', UPDATE: 'badge-info', DELETE: 'badge-danger' };

router.register('audit', () => {
  if (!DB.isAdmin) return `<div class="sw-chart-card"><div class="empty-state" style="padding:80px 20px"><div style="font-size:48px;margin-bottom:14px;opacity:0.4">🔒</div><div class="title" style="font-size:17px;font-weight:600">เฉพาะ admin เท่านั้น</div><div class="hint" style="margin-top:6px">คุณไม่มีสิทธิ์ดูประวัติการแก้ไข</div></div></div>`;
  if (!_auditState.hasLoaded && !_auditState.loading) {
    loadAuditPage();
  }
  // Stats — derived from loaded rows
  const totalPages = Math.max(1, Math.ceil(_auditState.total / _auditState.pageSize));
  const actionCounts = { INSERT: 0, UPDATE: 0, DELETE: 0 };
  for (const r of _auditState.rows) actionCounts[r.action] = (actionCounts[r.action] || 0) + 1;
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ประวัติการแก้ไข</div>
        <div class="sw-page-subtitle">บันทึกอัตโนมัติทุกการเพิ่ม/แก้ไข/ลบข้อมูล · จำกัดเฉพาะ admin · ใช้ตรวจสอบย้อนหลังได้</div>
      </div>
    </div>

    <div class="sw-stats-grid" style="margin-bottom:28px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,58,138,0.12);color:var(--primary)">📋</div>
        <div class="sw-stat-label">รายการทั้งหมด</div>
        <div class="sw-stat-value">${fmt.num(_auditState.total)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">รายการที่ตรงตัวกรอง</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(22,163,74,0.12);color:var(--success)">+</div>
        <div class="sw-stat-label">เพิ่มใหม่ (หน้านี้)</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(actionCounts.INSERT || 0)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">INSERT</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(2,132,199,0.12);color:var(--info)">✎</div>
        <div class="sw-stat-label">แก้ไข (หน้านี้)</div>
        <div class="sw-stat-value" style="color:var(--info)">${fmt.num(actionCounts.UPDATE || 0)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">UPDATE</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(220,38,38,0.12);color:var(--danger)">🗑️</div>
        <div class="sw-stat-label">ลบ (หน้านี้)</div>
        <div class="sw-stat-value" style="color:${actionCounts.DELETE > 0 ? 'var(--danger)' : 'var(--text)'}">${fmt.num(actionCounts.DELETE || 0)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">DELETE</div>
      </div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">รายการประวัติ <span class="sw-chart-count">${fmt.num(_auditState.total)}</span></div>
          <div class="sw-chart-sub">เรียงจากใหม่สุด · หน้า ${_auditState.page + 1}/${totalPages} · ${_auditState.pageSize} รายการ/หน้า</div>
        </div>
      </div>
      <div class="sw-filter-bar">
        <input id="auditSearch" type="text" class="sw-filter-input" placeholder="🔍 ค้นอีเมล / รหัส record" value="${escapeHtml(_auditState.filterSearch)}"/>
        <select id="auditTable" class="sw-filter-select">
          <option value="">— ทุกตาราง —</option>
          ${Object.entries(AUDIT_TABLE_LABELS).map(([k, v]) => `<option value="${k}" ${_auditState.filterTable === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <select id="auditAction" class="sw-filter-select">
          <option value="">— ทุกการกระทำ —</option>
          <option value="INSERT" ${_auditState.filterAction === 'INSERT' ? 'selected' : ''}>+ เพิ่ม</option>
          <option value="UPDATE" ${_auditState.filterAction === 'UPDATE' ? 'selected' : ''}>✎ แก้ไข</option>
          <option value="DELETE" ${_auditState.filterAction === 'DELETE' ? 'selected' : ''}>🗑 ลบ</option>
        </select>
        <button class="btn btn-primary btn-sm" onclick="applyAuditFilter()">ค้นหา</button>
      </div>
      <div id="auditList">${_auditState.loading ? '<div class="empty-state" style="padding:50px 20px"><div style="font-size:32px;opacity:0.3">⏳</div><div class="title" style="font-size:14px;margin-top:8px">กำลังโหลด...</div></div>' : renderAuditList()}</div>
    </div>
  `;
});

async function loadAuditPage() {
  _auditState.loading = true;
  try {
    const result = await DB.fetchAuditLog({
      limit: _auditState.pageSize,
      offset: _auditState.page * _auditState.pageSize,
      table: _auditState.filterTable || null,
      action: _auditState.filterAction || null,
      search: _auditState.filterSearch || null
    });
    _auditState.rows = result.rows;
    _auditState.total = result.total;
  } catch (ex) {
    toast('โหลดประวัติไม่สำเร็จ: ' + (ex.message || ex), 'error');
    _auditState.rows = [];
    _auditState.total = 0;
  }
  _auditState.hasLoaded = true;
  _auditState.loading = false;
  if (router.current === 'audit') router.go('audit');
}

function renderAuditList() {
  if (_auditState.rows.length === 0) {
    return `<div class="empty-state"><div class="title">ไม่พบรายการ</div><div class="hint">ลองเปลี่ยนตัวกรอง</div></div>`;
  }
  const totalPages = Math.max(1, Math.ceil(_auditState.total / _auditState.pageSize));
  return `
    <div class="table-wrap"><table class="table table-compact">
      <thead><tr>
        <th>เวลา</th><th>ผู้ใช้</th><th>การกระทำ</th><th>ตาราง</th><th>Record ID</th><th>สรุปการเปลี่ยนแปลง</th>
      </tr></thead>
      <tbody>
        ${_auditState.rows.map(r => {
          const action = AUDIT_ACTION_LABELS[r.action] || r.action;
          const cls = AUDIT_ACTION_COLORS[r.action] || 'badge-info';
          const tableLabel = AUDIT_TABLE_LABELS[r.table_name] || r.table_name;
          // สรุปการเปลี่ยน
          let summary = '-';
          if (r.action === 'INSERT' && r.new_data) {
            const keys = Object.keys(r.new_data).filter(k => r.new_data[k] != null && !['id','created_at','updated_at'].includes(k)).slice(0, 4);
            summary = keys.map(k => `<code style="font-size:11.5px">${escapeHtml(k)}=${escapeHtml(String(r.new_data[k]).slice(0, 30))}</code>`).join(' ');
          } else if (r.action === 'UPDATE' && r.old_data && r.new_data) {
            const changes = [];
            for (const k of Object.keys(r.new_data)) {
              if (['updated_at','created_at'].includes(k)) continue;
              const oldV = r.old_data[k];
              const newV = r.new_data[k];
              if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
                changes.push(`<code style="font-size:11.5px">${escapeHtml(k)}: ${escapeHtml(String(oldV ?? '∅').slice(0, 20))} → <strong>${escapeHtml(String(newV ?? '∅').slice(0, 20))}</strong></code>`);
              }
            }
            summary = changes.slice(0, 4).join('<br>') || '<span class="muted-2">ไม่มีการเปลี่ยน</span>';
            if (changes.length > 4) summary += `<br><span class="muted-2">+${changes.length - 4} ฟิลด์</span>`;
          } else if (r.action === 'DELETE' && r.old_data) {
            const keys = Object.keys(r.old_data).filter(k => r.old_data[k] != null && !['id','created_at','updated_at'].includes(k)).slice(0, 3);
            summary = keys.map(k => `<code style="font-size:11.5px">${escapeHtml(k)}=${escapeHtml(String(r.old_data[k]).slice(0, 30))}</code>`).join(' ');
          }
          const ts = new Date(r.ts);
          const tsStr = ts.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          return `<tr style="vertical-align:top">
            <td style="white-space:nowrap;font-size:12.5px">${tsStr}</td>
            <td style="font-size:12.5px">
              <div style="font-weight:600">${escapeHtml(r.user_email || '?')}</div>
              ${r.user_role ? `<div class="muted-2" style="font-size:11px">${escapeHtml(r.user_role)}</div>` : ''}
            </td>
            <td><span class="badge ${cls}">${action}</span></td>
            <td style="font-size:12.5px">${escapeHtml(tableLabel)}</td>
            <td><code style="font-size:11.5px">${escapeHtml(r.record_id || '-')}</code></td>
            <td style="font-size:12px;line-height:1.7;max-width:480px">${summary}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
    <div class="pagination" style="margin-top:14px;display:flex;justify-content:space-between;align-items:center">
      <div class="muted-2" style="font-size:12.5px">แสดง ${_auditState.page * _auditState.pageSize + 1}–${Math.min((_auditState.page + 1) * _auditState.pageSize, _auditState.total)} จาก ${fmt.num(_auditState.total)}</div>
      <div class="pagination-controls">
        <button class="btn-page" ${_auditState.page === 0 ? 'disabled' : ''} onclick="auditGoPage(${_auditState.page - 1})">‹ ก่อนหน้า</button>
        <span style="padding:0 12px;font-size:13px">หน้า ${_auditState.page + 1}/${totalPages}</span>
        <button class="btn-page" ${_auditState.page >= totalPages - 1 ? 'disabled' : ''} onclick="auditGoPage(${_auditState.page + 1})">ถัดไป ›</button>
      </div>
    </div>
  `;
}

function applyAuditFilter() {
  _auditState.filterSearch = $('#auditSearch')?.value || '';
  _auditState.filterTable = $('#auditTable')?.value || '';
  _auditState.filterAction = $('#auditAction')?.value || '';
  _auditState.page = 0;
  _auditState.rows = []; _auditState.total = 0;
  loadAuditPage();
}

function auditGoPage(p) {
  _auditState.page = p;
  _auditState.rows = [];
  loadAuditPage();
}

// ═══════════════════════════════════════════════════════
//  PAGE: LEAVE MANAGEMENT (การลางาน)
// ═══════════════════════════════════════════════════════
const _leaveState = { tab: 'pending', filterYear: new Date().getFullYear() };
const _leaveFilters = { search: '', leaveType: '', status: '', branch: '', from: '', to: '' };

function setLeaveFilter(field, value) {
  _leaveFilters[field] = value;
  // ถ้า field เป็น search → focus กลับหลัง render
  const wasFocused = field === 'search';
  router.go('leave');
  if (wasFocused) {
    const el = document.getElementById('leaveSearchInput');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
}
function clearLeaveFilters() {
  Object.keys(_leaveFilters).forEach(k => _leaveFilters[k] = '');
  router.go('leave');
}
function hasActiveLeaveFilters() {
  return Object.values(_leaveFilters).some(v => v && String(v).length);
}
function applyLeaveFilters(list) {
  const f = _leaveFilters;
  const search = f.search.trim().toLowerCase();
  return list.filter(r => {
    if (f.leaveType && r.leaveType !== f.leaveType) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.from && (r.startDate || '') < f.from) return false;
    if (f.to && (r.startDate || '') > f.to) return false;
    if (f.branch) {
      const e = DB.getEmployee(r.employeeId);
      if (!e || e.branch !== f.branch) return false;
    }
    if (search) {
      const e = DB.getEmployee(r.employeeId);
      const name = ((e?.firstName || '') + ' ' + (e?.lastName || '')).toLowerCase();
      if (!name.includes(search) && !String(r.employeeId).toLowerCase().includes(search)) return false;
    }
    return true;
  });
}

const LEAVE_STATUS_BADGE = {
  pending:   { label: 'รออนุมัติ', cls: 'badge-warning' },
  approved:  { label: 'อนุมัติแล้ว', cls: 'badge-success' },
  rejected:  { label: 'ปฏิเสธ',    cls: 'badge-danger' },
  cancelled: { label: 'ยกเลิก',    cls: 'badge' }
};

function switchLeaveTab(t) { _leaveState.tab = t; router.go('leave'); }

// แสดงสิทธิ์การลาของผู้ใช้ปัจจุบัน (ของฉัน) — แสดงทุกประเภทที่เปิดใช้งานและเข้าเงื่อนไขเพศ
function renderMyLeaveBalance() {
  const myEmpId = DB.profile?.employee_id;
  if (!myEmpId) return '';                       // user ไม่ได้ผูกกับพนักงาน → ซ่อน
  const emp = DB.getEmployee(myEmpId);
  if (!emp) return '';
  const year = new Date().getFullYear();
  const myGender = DB.genderCode(emp.gender);
  const types = DB.getLeaveTypesList()
    .filter(t => !t.gender || t.gender === myGender);
  // คำนวณ balance ต่อประเภท
  const balances = types.map(t => {
    const b = DB.calcLeaveBalance(myEmpId, t.id, year);
    return { type: t, ...b };
  }).filter(b => b.quota > 0);
  if (!balances.length) return '';
  // นับ pending ของตัวเอง (เพื่อแสดงเป็นข้อมูลเสริม)
  const myPending = (DB.data.leaveRequests || []).filter(r => r.employeeId === myEmpId && r.status === 'pending');
  const totalUsedAll = balances.reduce((s, b) => s + b.used, 0);
  const totalRemainAll = balances.reduce((s, b) => s + b.remaining, 0);
  return `
    <div class="sw-chart-card" style="margin-bottom:24px">
      <div class="sw-chart-header" style="align-items:flex-start;flex-wrap:wrap;gap:12px">
        <div>
          <div class="sw-chart-title">สิทธิ์การลาของฉัน · ปี ${year + 543}</div>
          <div class="sw-chart-sub">${escapeHtml(emp.firstName + ' ' + (emp.lastName || ''))} · ${escapeHtml(emp.id)}${emp.branch ? ' · ' + escapeHtml(emp.branch) : ''} — นับจากคำขอที่อนุมัติแล้วในปีนี้</div>
        </div>
        <div style="display:flex;gap:14px;align-items:center;font-size:12px;color:var(--text-2)">
          <div><strong style="color:var(--success);font-size:16px">${fmt.num(totalRemainAll)}</strong> วันคงเหลือรวม</div>
          <div><strong style="color:var(--warning);font-size:16px">${fmt.num(totalUsedAll)}</strong> วันที่ลาไปแล้ว</div>
          ${myPending.length ? `<div><strong style="color:var(--info);font-size:16px">${fmt.num(myPending.length)}</strong> คำขอรออนุมัติ</div>` : ''}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:14px">
        ${balances.map(b => {
          const usedPct = Math.min(100, (b.used / b.quota) * 100);
          const remainColor = b.remaining === 0 ? 'var(--danger)' : usedPct >= 70 ? 'var(--warning)' : 'var(--success)';
          const badgeCls = b.type.badge || 'badge-info';
          const isExhausted = b.remaining === 0;
          const titleHint = isExhausted ? 'สิทธิ์หมดแล้ว — คลิกเพื่อดู' : `คลิกเพื่อขอลา${b.type.label}`;
          return `<div class="sw-leave-bal-card" role="button" tabindex="0"
            title="${escapeHtml(titleHint)}"
            onclick="openLeaveRequestForm(null, '${escapeHtml(b.type.id)}')"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openLeaveRequestForm(null, '${escapeHtml(b.type.id)}')}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px">
              <span class="badge ${badgeCls}" style="font-size:10.5px">${escapeHtml(b.type.label)}</span>
              <span class="muted-2" style="font-size:10.5px;font-weight:600">ใช้ ${b.used} / ${b.quota}</span>
            </div>
            <div style="display:flex;align-items:baseline;gap:6px;margin-top:6px">
              <span style="font-size:28px;font-weight:600;color:${remainColor};line-height:1;letter-spacing:-0.02em">${fmt.num(b.remaining)}</span>
              <span style="font-size:12px;color:var(--text-3)">วันคงเหลือ</span>
            </div>
            <div style="height:6px;background:var(--surface);border-radius:3px;margin-top:10px;overflow:hidden">
              <div style="height:100%;width:${usedPct}%;background:${remainColor};transition:width .3s"></div>
            </div>
            <div class="sw-leave-bal-hint">+ ขอลา${escapeHtml(b.type.label)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

router.register('leave', () => {
  const today = tz.today();
  const thisMonth = today.slice(0, 7);
  // ใช้ getLeaveRequests() เพื่อ auto-scope ตาม RBAC (branch_staff เห็นเฉพาะของตัวเอง)
  const all = DB.getLeaveRequests();
  const pending = all.filter(r => r.status === 'pending');
  const approvedThisMonth = all.filter(r => r.status === 'approved' && (r.startDate || '').startsWith(thisMonth));
  const totalDaysThisMonth = approvedThisMonth.reduce((s, r) => s + Number(r.days || 0), 0);
  const onLeaveToday = all.filter(r => r.status === 'approved' && r.startDate <= today && r.endDate >= today);

  const tabs = [
    { id: 'pending', label: 'รออนุมัติ',     count: pending.length || null },
    { id: 'all',     label: 'ประวัติทั้งหมด',  count: null },
    { id: 'balance', label: 'ยอดวันลาคงเหลือ', count: null },
    ...(DB.isHR ? [{ id: 'types', label: 'ตั้งค่าประเภท', count: null }] : [])
  ];

  const todayStr = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });

  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">การลางาน</div>
        <div class="sw-page-subtitle">บริหารคำขอลาตามกฎหมายแรงงานไทย — ${todayStr}</div>
      </div>
      <div class="sw-page-actions">
        <button class="btn btn-primary" onclick="openLeaveRequestForm()">+ ส่งคำขอลา</button>
      </div>
    </div>

    <div class="sw-stats-grid" style="margin-bottom:32px">
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(217,119,6,0.12);color:var(--warning)">⏳</div>
        <div class="sw-stat-label">รออนุมัติ</div>
        <div class="sw-stat-value" style="color:${pending.length > 0 ? 'var(--warning)' : 'var(--text)'}">${fmt.num(pending.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">คำขอที่ต้องดำเนินการ</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(22,163,74,0.12);color:var(--success)">✓</div>
        <div class="sw-stat-label">อนุมัติแล้วเดือนนี้</div>
        <div class="sw-stat-value" style="color:var(--success)">${fmt.num(approvedThisMonth.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">รวม ${totalDaysThisMonth} วัน</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(30,136,229,0.12);color:#1e88e5">🏖️</div>
        <div class="sw-stat-label">กำลังลาวันนี้</div>
        <div class="sw-stat-value">${fmt.num(onLeaveToday.length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">${onLeaveToday.length ? 'พนักงานไม่อยู่' : 'พนักงานครบทุกคน'}</div>
      </div>
      <div class="sw-stat-card">
        <div class="sw-stat-icon" style="background:rgba(124,58,237,0.12);color:#7c3aed">📜</div>
        <div class="sw-stat-label">ประเภทการลา</div>
        <div class="sw-stat-value">${fmt.num(DB.getLeaveTypesList().length)}</div>
        <div class="sw-stat-change muted-2" style="font-size:12px;margin-top:6px">เปิดใช้งานในระบบ</div>
      </div>
    </div>

    ${renderMyLeaveBalance()}

    <div class="sw-tabs" role="tablist">
      ${tabs.map(t => `<button class="sw-tab ${_leaveState.tab === t.id ? 'active' : ''}" onclick="switchLeaveTab('${t.id}')" role="tab">
        <span>${escapeHtml(t.label)}</span>${t.count != null ? `<span class="sw-tab-pill">${fmt.num(t.count)}</span>` : ''}
      </button>`).join('')}
    </div>

    <div id="leaveContent">${renderLeaveTab()}</div>
  `;
});

function renderLeaveFilterBar(scope = 'requests') {
  // branch_staff/viewer เห็นเฉพาะของตัวเอง → ซ่อน search + branch (ไม่มีประโยชน์)
  // แต่ยังต้องการ status/type/date filter เพื่อกรองคำขอของตัวเอง
  const role = DB.role;
  const isSelfOnly = (role === 'branch_staff' || role === 'viewer');
  // Branches dropdown — auto-scope ตาม RBAC (branch_staff เห็นเฉพาะสาขาตัวเอง)
  const branches = [...new Set(DB.getEmployees({ status: 'active' }).map(e => e.branch).filter(Boolean))].sort();
  const types = DB.getLeaveTypesList();
  const showStatus = scope === 'requests' && _leaveState.tab === 'all';
  const showDates = scope === 'requests';
  const showType = scope === 'requests';
  const showSearch = !isSelfOnly;       // ค้นหา = หาคนอื่น → ซ่อนจาก staff
  const showBranch = !isSelfOnly && branches.length > 1;
  // ถ้าทุกอย่างซ่อนหมด → ไม่ render filter bar เลย
  if (!showSearch && !showType && !showStatus && !showBranch && !showDates) return '';
  return `<div class="sw-filter-bar">
    ${showSearch ? `<input id="leaveSearchInput" type="text" class="sw-filter-input"
      placeholder="🔍 ค้นชื่อ/รหัสพนักงาน"
      value="${escapeHtml(_leaveFilters.search)}"
      onchange="setLeaveFilter('search', this.value)"
      onkeydown="if(event.key==='Enter'){event.preventDefault();setLeaveFilter('search', this.value);}"/>` : ''}
    ${showType ? `<select class="sw-filter-select" onchange="setLeaveFilter('leaveType', this.value)">
      <option value="">— ทุกประเภทการลา —</option>
      ${types.map(t => `<option value="${t.id}" ${_leaveFilters.leaveType === t.id ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
    </select>` : ''}
    ${showStatus ? `<select class="sw-filter-select" onchange="setLeaveFilter('status', this.value)">
      <option value="">— ทุกสถานะ —</option>
      ${Object.entries(LEAVE_STATUS_BADGE).map(([k, v]) => `<option value="${k}" ${_leaveFilters.status === k ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
    </select>` : ''}
    ${showBranch ? `<select class="sw-filter-select" onchange="setLeaveFilter('branch', this.value)">
      <option value="">— ทุกสาขา —</option>
      ${branches.map(b => `<option value="${escapeHtml(b)}" ${_leaveFilters.branch === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
    </select>` : ''}
    ${showDates ? `<div class="sw-filter-date-group">
      <input type="date" class="sw-filter-input sw-filter-date" title="ตั้งแต่วันที่" value="${_leaveFilters.from || ''}" onchange="setLeaveFilter('from', this.value)"/>
      <span class="muted-2" style="font-size:12px">→</span>
      <input type="date" class="sw-filter-input sw-filter-date" title="ถึงวันที่" value="${_leaveFilters.to || ''}" onchange="setLeaveFilter('to', this.value)"/>
    </div>` : ''}
    ${hasActiveLeaveFilters() ? `<button class="btn btn-ghost btn-sm sw-filter-clear" onclick="clearLeaveFilters()" title="ล้างตัวกรอง">✕ ล้างตัวกรอง</button>` : ''}
  </div>`;
}

function renderLeaveTab() {
  if (_leaveState.tab === 'balance') return renderLeaveBalanceTable();
  if (_leaveState.tab === 'types') return renderLeaveTypesTable();
  const status = _leaveState.tab === 'pending' ? 'pending' : null;
  const rawList = DB.getLeaveRequests({ status, year: _leaveState.tab === 'all' ? _leaveState.filterYear : null });
  const list = applyLeaveFilters(rawList);

  const titleMap = { pending: 'คำขอที่รออนุมัติ', all: `ประวัติคำขอลา · ปี ${_leaveState.filterYear + 543}` };
  const subMap = {
    pending: 'รายการที่ต้องตัดสินใจ — admin หรือหัวสาขาเป็นผู้อนุมัติ',
    all: 'คำขอลาทั้งหมดในปีที่เลือก เรียงจากใหม่สุด'
  };

  const yearSelector = _leaveState.tab === 'all' ? `
    <select class="sw-inline-select" onchange="_leaveState.filterYear = Number(this.value); router.go('leave')">
      ${[0, 1, 2].map(off => { const y = new Date().getFullYear() - off; return `<option value="${y}" ${_leaveState.filterYear === y ? 'selected' : ''}>ปี ${y + 543}</option>`; }).join('')}
    </select>` : '';

  const filtered = hasActiveLeaveFilters();
  const countLabel = filtered
    ? `<span class="sw-chart-count">${fmt.num(list.length)} / ${fmt.num(rawList.length)}</span>`
    : `<span class="sw-chart-count">${fmt.num(rawList.length)}</span>`;

  if (!rawList.length) {
    return `<div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">${escapeHtml(titleMap[_leaveState.tab] || '')}</div>
          <div class="sw-chart-sub">${escapeHtml(subMap[_leaveState.tab] || '')}</div>
        </div>
        ${yearSelector}
      </div>
      <div class="empty-state" style="padding:60px 20px">
        <div style="font-size:42px;margin-bottom:12px;opacity:0.35">🌴</div>
        <div class="title" style="font-size:16px;font-weight:600">${_leaveState.tab === 'pending' ? 'ไม่มีคำขอรออนุมัติ' : 'ยังไม่มีคำขอลาในปีนี้'}</div>
        <div class="hint" style="margin-top:6px">${_leaveState.tab === 'pending' ? 'งานเคลียร์ทุกอย่างเรียบร้อย' : 'กดปุ่ม + ส่งคำขอลา เพื่อเริ่ม'}</div>
      </div>
    </div>`;
  }

  return `<div class="sw-chart-card">
    <div class="sw-chart-header">
      <div>
        <div class="sw-chart-title">${escapeHtml(titleMap[_leaveState.tab] || '')} ${countLabel}</div>
        <div class="sw-chart-sub">${escapeHtml(subMap[_leaveState.tab] || '')}</div>
      </div>
      ${yearSelector}
    </div>
    ${renderLeaveFilterBar('requests')}
    ${list.length === 0 ? `<div class="empty-state" style="padding:40px 20px">
      <div style="font-size:32px;margin-bottom:8px;opacity:0.3">🔍</div>
      <div class="title" style="font-size:14px;font-weight:600">ไม่พบรายการที่ตรงกับตัวกรอง</div>
      <div class="hint" style="margin-top:4px">ลองล้างตัวกรองเพื่อดูทั้งหมด</div>
    </div>` : `<div class="table-wrap"><table class="table table-compact sw-leave-table">
      <thead><tr>
        <th>วันที่ขอ</th><th>พนักงาน</th><th>ประเภทการลา</th><th>ช่วงวันที่ลา</th><th class="num">วัน</th>
        <th>เหตุผล</th><th>สถานะ</th><th>ผู้อนุมัติ (หัวสาขา)</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(r => {
          const e = DB.getEmployee(r.employeeId) || {};
          const typeCfg = DB.LEAVE_TYPES[r.leaveType] || { label: r.leaveType, badge: 'badge-info' };
          const stat = LEAVE_STATUS_BADGE[r.status] || { label: r.status, cls: 'badge' };
          const approver = DB.getLeaveApprover(r.employeeId);
          const canApprove = DB.canApproveLeaveFor(r.employeeId);
          // คำขอที่วันลาผ่านไปแล้วและไม่ใช่ประเภทที่ allowBackdate (ป่วย/คลอด) → ห้ามอนุมัติ
          // ยกเว้น admin/HR ที่ override ได้ทุกกรณี
          const isExpired = !DB.isHR && r.status === 'pending' && !typeCfg.allowBackdate && r.endDate && r.endDate < tz.today();
          const isSelfApprove = approver && approver.id === r.employeeId;
          let approverCell = '<span class="muted-2">—</span>';
          if (approver) {
            const approverPos = DB.getPosition(approver.position);
            approverCell = `<div class="sw-approver">
              <strong>${escapeHtml(approver.firstName + ' ' + (approver.lastName || ''))}</strong>
              <span class="muted-2">${approverPos ? escapeHtml(approverPos.name) : ''}${approver.branch ? ' · ' + escapeHtml(approver.branch) : ''}</span>
              ${isSelfApprove ? '<span class="badge badge-warning sw-approver-note">หัวสาขาเอง · admin override</span>' : ''}
            </div>`;
          }
          const range = r.startDate === r.endDate ? fmt.date(r.startDate) : `${fmt.date(r.startDate)}<span class="muted-2"> – </span>${fmt.date(r.endDate)}`;
          return `<tr>
            <td class="sw-cell-meta">${fmt.date(r.requestedAt)}</td>
            <td>
              <div class="sw-emp-cell">
                <strong>${escapeHtml((e.firstName || '?') + ' ' + (e.lastName || ''))}</strong>
                <span class="muted-2">${escapeHtml(r.employeeId)}${e.branch ? ' · ' + escapeHtml(e.branch) : ''}</span>
              </div>
            </td>
            <td><span class="badge ${typeCfg.badge || 'badge-info'} sw-leave-type">${escapeHtml(typeCfg.label)}</span></td>
            <td class="sw-cell-meta">${range}</td>
            <td class="num"><strong style="font-size:14px">${r.days}</strong><span class="muted-2" style="font-size:11px"> วัน</span></td>
            <td class="sw-reason-cell">${r.reason ? escapeHtml(r.reason) : '<span class="muted-2">—</span>'}</td>
            <td>
              <span class="badge ${stat.cls}">${stat.label}</span>
              ${r.approverNote ? `<div class="sw-status-note">"${escapeHtml(r.approverNote)}"</div>` : ''}
              ${r.cancelReason ? `<div class="sw-status-note">"${escapeHtml(r.cancelReason)}"</div>` : ''}
            </td>
            <td>${approverCell}</td>
            <td class="actions">
              ${isExpired ? `<span class="badge badge-danger" title="วันลาสิ้นสุด ${fmt.date(r.endDate)} ผ่านไปแล้ว — ประเภท ${escapeHtml(typeCfg.label)} ไม่อนุญาตให้อนุมัติย้อนหลัง" style="font-size:10.5px">⛔ เลยกำหนด — อนุมัติไม่ได้</span>` : ''}
              ${r.status === 'pending' && canApprove && !isExpired ? `<button class="btn btn-success btn-sm" onclick="approveLeave('${r.id}')">อนุมัติ</button>` : ''}
              ${r.status === 'pending' && canApprove ? `<button class="btn btn-danger btn-sm" onclick="rejectLeave('${r.id}')">ปฏิเสธ</button>` : ''}
              ${r.status === 'pending' && !canApprove ? `<span class="muted-2 sw-wait-note">รอหัวสาขา</span>` : ''}
              ${r.status === 'pending' ? `<button class="btn btn-ghost btn-sm" onclick="openLeaveRequestForm('${r.id}')">แก้</button>
                <button class="btn btn-ghost btn-sm" onclick="cancelLeave('${r.id}')">ยกเลิก</button>` : ''}
              ${r.status !== 'pending' && DB.isHR ? `<button class="btn btn-ghost btn-sm" onclick="deleteLeave('${r.id}')">ลบ</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`}
  </div>`;
}

function renderLeaveBalanceTable() {
  const year = _leaveState.filterYear;
  // ใช้ getEmployees() เพื่อ auto-scope ตาม RBAC:
  // - branch_staff/viewer → เห็นเฉพาะตัวเอง
  // - branch_manager/area_manager → เฉพาะสาขาที่ดูแล
  // - admin/hr/op_manager → ทุกคน
  const allEmps = DB.getEmployees({ status: 'active' });
  if (!allEmps.length) {
    return `<div class="sw-chart-card"><div class="empty-state"><div class="title">ไม่มีพนักงาน</div></div></div>`;
  }
  // apply filter (search by name/id + branch)
  const f = _leaveFilters;
  const search = (f.search || '').trim().toLowerCase();
  const emps = allEmps.filter(e => {
    if (f.branch && e.branch !== f.branch) return false;
    if (search) {
      const name = ((e.firstName || '') + ' ' + (e.lastName || '')).toLowerCase();
      if (!name.includes(search) && !String(e.id).toLowerCase().includes(search)) return false;
    }
    return true;
  });
  const types = Object.entries(DB.LEAVE_TYPES);
  const filtered = hasActiveLeaveFilters();
  const countLabel = filtered
    ? `<span class="sw-chart-count">${fmt.num(emps.length)} / ${fmt.num(allEmps.length)}</span>`
    : `<span class="sw-chart-count">${fmt.num(allEmps.length)}</span>`;
  return `<div class="sw-chart-card">
    <div class="sw-chart-header">
      <div>
        <div class="sw-chart-title">ยอดวันลาคงเหลือ · ปี ${year + 543} ${countLabel}</div>
        <div class="sw-chart-sub">แสดง "คงเหลือ / โควต้า" — นับจากคำขอที่อนุมัติแล้ว · เปลี่ยนปีเพื่อดูย้อนหลัง</div>
      </div>
      <select class="sw-inline-select" onchange="_leaveState.filterYear = Number(this.value); router.go('leave')">
        ${[0, 1, 2].map(off => { const y = new Date().getFullYear() - off; return `<option value="${y}" ${_leaveState.filterYear === y ? 'selected' : ''}>ปี ${y + 543}</option>`; }).join('')}
      </select>
    </div>
    ${renderLeaveFilterBar('balance')}
    ${emps.length === 0 ? `<div class="empty-state" style="padding:40px 20px">
      <div style="font-size:32px;margin-bottom:8px;opacity:0.3">🔍</div>
      <div class="title" style="font-size:14px;font-weight:600">ไม่พบพนักงานที่ตรงกับตัวกรอง</div>
      <div class="hint" style="margin-top:4px">ลองล้างตัวกรองเพื่อดูทั้งหมด</div>
    </div>` : `<div class="table-wrap"><table class="table table-compact sw-balance-table">
      <thead><tr>
        <th>พนักงาน</th>
        ${types.map(([k, v]) => `<th class="num" title="${escapeHtml(v.label)}">${escapeHtml(v.label)}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${emps.map(e => {
          const g = DB.genderCode(e.gender);
          const genderMark = g ? `<span class="sw-gender ${g === 'M' ? 'sw-gender-m' : 'sw-gender-f'}">${g === 'M' ? '♂' : '♀'}</span>` : '';
          return `<tr>
            <td>
              <div class="sw-emp-cell">
                <strong>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))} ${genderMark}</strong>
                <span class="muted-2">${escapeHtml(e.id)}${e.branch ? ' · ' + escapeHtml(e.branch) : ''}</span>
              </div>
            </td>
            ${types.map(([k]) => {
              const b = DB.calcLeaveBalance(e.id, k, year);
              if (b.quota === 0) return '<td class="num"><span class="muted-2">—</span></td>';
              const ratio = b.used / b.quota;
              const cls = ratio >= 1 ? 'sw-bal-low' : ratio >= 0.7 ? 'sw-bal-warn' : 'sw-bal-ok';
              return `<td class="num"><span class="sw-bal ${cls}"><strong>${b.remaining}</strong><span class="muted-2">/${b.quota}</span></span></td>`;
            }).join('')}
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`}
  </div>`;
}

// ─── Leave types config tab (admin + HR) ───
function renderLeaveTypesTable() {
  if (!DB.isHR) return '<div class="sw-chart-card"><div class="empty-state"><div class="title">เฉพาะ Admin / HR</div></div></div>';
  const list = DB.getLeaveTypesList(true);  // include inactive
  return `<div class="sw-chart-card">
    <div class="sw-chart-header">
      <div>
        <div class="sw-chart-title">ตั้งค่าประเภทการลา</div>
        <div class="sw-chart-sub">แก้ชื่อ จำนวนวันสูงสุด เพศที่ใช้ได้ และการลาย้อนหลัง · บันทึกแล้วใช้ทันทีทั่วระบบ · <strong>rule = ตามอายุงาน</strong> ใช้สูตรลาพักร้อน 6 วันเมื่อครบ 1 ปี +1/ปี สูงสุดตาม "จำนวนวันสูงสุด"</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openLeaveTypeForm()">+ เพิ่มประเภท</button>
    </div>
    <div class="table-wrap"><table class="table table-compact">
      <thead><tr>
        <th>ลำดับ</th><th>รหัส</th><th>ชื่อแสดง</th><th class="num">วันสูงสุด/ปี</th><th>สูตร</th><th>เพศที่ใช้ได้</th><th>ย้อนหลัง</th><th>สถานะ</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(t => `<tr style="${t.active ? '' : 'opacity:0.55'}">
          <td class="num">${t.sortOrder}</td>
          <td><code style="font-size:11.5px">${escapeHtml(t.id)}</code></td>
          <td><strong>${escapeHtml(t.label)}</strong>${t.note ? `<br><span class="muted-2" style="font-size:11px">${escapeHtml(t.note)}</span>` : ''}</td>
          <td class="num"><strong>${t.maxDays ?? '-'}</strong></td>
          <td>${t.rule === 'tenure' ? '<span class="badge badge-success" style="font-size:10.5px">ตามอายุงาน</span>' : '<span class="muted-2">ค่าคงที่</span>'}</td>
          <td>${t.gender === 'M' ? 'ชายเท่านั้น' : t.gender === 'F' ? 'หญิงเท่านั้น' : 'ทั้งหมด'}</td>
          <td>${t.allowBackdate ? '<span class="badge badge-warning" style="font-size:10.5px">✓ ย้อนหลังได้</span>' : '<span class="muted-2">ห้าม</span>'}</td>
          <td>${t.active ? '<span class="badge badge-success">ใช้งาน</span>' : '<span class="badge">ปิด</span>'}</td>
          <td class="actions">
            <button class="btn btn-ghost btn-sm" onclick="openLeaveTypeForm('${escapeHtml(t.id)}')">แก้</button>
            <button class="btn btn-ghost btn-sm" onclick="deleteLeaveType('${escapeHtml(t.id)}')">ลบ</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

function openLeaveTypeForm(id = null) {
  if (!requireHR()) return;
  const t = id ? DB.getLeaveType(id) : { id: '', label: '', maxDays: '', rule: null, gender: null, allowBackdate: false, badge: 'badge-info', sortOrder: 100, active: true, note: '' };
  modal.open(id ? `แก้ไขประเภทการลา — ${escapeHtml(t.label)}` : 'เพิ่มประเภทการลาใหม่', `
    <form id="leaveTypeForm">
      <div class="form-grid">
        <div class="form-group"><label>รหัส (อังกฤษ/ตัวเลข) *<span class="muted-2" style="font-size:11px"> ${id ? '(แก้ไม่ได้)' : ''}</span></label>
          <input name="id" value="${escapeHtml(t.id)}" required pattern="[a-z0-9_]+" placeholder="เช่น study_leave" ${id ? 'readonly' : ''}/>
        </div>
        <div class="form-group"><label>ชื่อแสดง *</label><input name="label" value="${escapeHtml(t.label)}" required placeholder="เช่น ลาศึกษาต่อ"/></div>
        <div class="form-group"><label>จำนวนวันสูงสุด/ปี *</label><input name="maxDays" type="number" min="0" step="0.5" value="${t.maxDays ?? ''}" required/></div>
        <div class="form-group"><label>สูตร</label>
          <select name="rule">
            <option value="" ${!t.rule ? 'selected' : ''}>ค่าคงที่ (ใช้จำนวนวันสูงสุดเลย)</option>
            <option value="tenure" ${t.rule === 'tenure' ? 'selected' : ''}>ตามอายุงาน (6 วันเมื่อครบ 1 ปี +1/ปี max ตามค่าด้านบน)</option>
          </select>
        </div>
        <div class="form-group"><label>เพศที่ใช้ได้</label>
          <select name="gender">
            <option value="" ${!t.gender ? 'selected' : ''}>ทั้งหมด</option>
            <option value="M" ${t.gender === 'M' ? 'selected' : ''}>ชายเท่านั้น</option>
            <option value="F" ${t.gender === 'F' ? 'selected' : ''}>หญิงเท่านั้น</option>
          </select>
        </div>
        <div class="form-group"><label>สี badge</label>
          <select name="badge">
            <option value="badge-info"    ${t.badge === 'badge-info' ? 'selected' : ''}>น้ำเงิน (info)</option>
            <option value="badge-success" ${t.badge === 'badge-success' ? 'selected' : ''}>เขียว (success)</option>
            <option value="badge-warning" ${t.badge === 'badge-warning' ? 'selected' : ''}>เหลือง (warning)</option>
            <option value="badge-danger"  ${t.badge === 'badge-danger' ? 'selected' : ''}>แดง (danger)</option>
          </select>
        </div>
        <div class="form-group"><label>ลำดับการแสดง</label><input name="sortOrder" type="number" min="0" step="10" value="${t.sortOrder}"/></div>
        <div class="form-group"><label><input type="checkbox" name="allowBackdate" ${t.allowBackdate ? 'checked' : ''}/> อนุญาตลาย้อนหลัง</label>
          <div class="muted-2" style="font-size:11.5px;margin-top:4px">เช่น ลาป่วย ลาคลอด — เริ่มก่อนแจ้ง HR ได้</div>
        </div>
        <div class="form-group"><label><input type="checkbox" name="active" ${t.active ? 'checked' : ''}/> เปิดใช้งาน</label>
          <div class="muted-2" style="font-size:11.5px;margin-top:4px">ปิดถ้าไม่อยากให้เลือกในฟอร์มขอลา (ข้อมูลเก่ายังอยู่)</div>
        </div>
        <div class="form-group span-2"><label>หมายเหตุ</label><input name="note" value="${escapeHtml(t.note || '')}" placeholder="เช่น ตามกฎหมายแรงงาน §41"/></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">บันทึก</button>
      </div>
    </form>
  `, { size: 'md' });

  $('#leaveTypeForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const data = {
      id: (fd.get('id') || '').toString().trim().toLowerCase(),
      label: (fd.get('label') || '').toString().trim(),
      maxDays: fd.get('maxDays') !== '' ? Number(fd.get('maxDays')) : null,
      rule: fd.get('rule') || null,
      gender: fd.get('gender') || null,
      allowBackdate: fd.get('allowBackdate') === 'on',
      badge: fd.get('badge') || 'badge-info',
      sortOrder: Number(fd.get('sortOrder') || 100),
      active: fd.get('active') === 'on',
      note: (fd.get('note') || '').toString().trim()
    };
    if (!/^[a-z0-9_]+$/.test(data.id)) return toast('รหัสต้องเป็น a-z, 0-9, _ เท่านั้น', 'error');
    try {
      await DB.saveLeaveType(data);
      toast('บันทึกแล้ว', 'success');
      modal.close();
      if (router.current === 'leave') router.go('leave');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

async function deleteLeaveType(id) {
  if (!requireHR()) return;
  if (!await modal.confirm('ลบประเภทการลา', `ลบ "${id}" ใช่หรือไม่? (ถ้ามีคำขอลาใช้อยู่จะลบไม่ได้ — ต้องปิด active แทน)`)) return;
  try {
    await DB.deleteLeaveType(id);
    toast('ลบแล้ว', 'success');
    router.go('leave');
  } catch (ex) { toast('ลบไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// ─── Leave request form ───
function openLeaveRequestForm(id = null, prefilledType = null) {
  const editing = id ? DB.getLeaveRequest(id) : null;
  // staff/manager: pre-select ตัวเอง (จาก user_profiles.employee_id), admin/HR: ให้เลือกได้ (ยื่นคำขอแทน)
  let defaultEmpId = editing?.employeeId || '';
  if (!defaultEmpId && !DB.isHR) defaultEmpId = DB.profile?.employee_id || '';
  const today = tz.today();
  // ประเภทที่ pre-select — editing ก่อน, ถัดไป prefilledType (เช่นจากกล่องคงเหลือ)
  const selectedType = editing?.leaveType || prefilledType || '';

  // ใช้ getEmployees() เพื่อ auto-scope: branch_staff เห็นเฉพาะตัวเอง, branch_mgr เห็นสาขา ฯลฯ
  const empOptions = DB.getEmployees({ status: 'active' })
    .sort((a, b) => (a.firstName || '').localeCompare(b.firstName || ''))
    .map(e => `<option value="${e.id}" ${defaultEmpId === e.id ? 'selected' : ''}>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))} (${escapeHtml(e.id)})</option>`).join('');

  modal.open(editing ? 'แก้ไขคำขอลา' : 'ส่งคำขอลา', `
    <form id="leaveForm">
      <div class="form-grid">
        <div class="form-group span-2"><label>พนักงาน *</label>
          <select name="employeeId" id="leaveEmp" required ${DB.isHR ? '' : 'disabled'}>
            <option value="">— เลือกพนักงาน —</option>
            ${empOptions}
          </select>
          <div id="leaveApproverHint" class="muted-2" style="font-size:12px;margin-top:6px"></div>
        </div>
        <div class="form-group span-2"><label>ประเภทการลา *</label>
          <select name="leaveType" id="leaveType" required>
            <option value="">— เลือกประเภท —</option>
            ${Object.entries(DB.LEAVE_TYPES).map(([k, v]) => `<option value="${k}" ${selectedType === k ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
          </select>
          <div id="leaveBalanceHint" class="muted-2" style="font-size:12px;margin-top:6px"></div>
        </div>
        <div class="form-group"><label>วันที่เริ่ม *</label><input name="startDate" id="leaveStart" type="date" required value="${editing?.startDate || today}"/>
          <div id="leaveBackdateHint" class="muted-2" style="font-size:11.5px;margin-top:4px"></div>
        </div>
        <div class="form-group"><label>วันที่สิ้นสุด *</label><input name="endDate" id="leaveEnd" type="date" required value="${editing?.endDate || today}"/></div>
        <div class="form-group"><label>จำนวนวัน *<span class="muted-2" style="font-size:11px">(แก้ได้ — รองรับครึ่งวัน)</span></label><input name="days" id="leaveDays" type="number" min="0.5" step="0.5" required value="${editing?.days || 1}"/></div>
        <div class="form-group span-2"><label>เหตุผล</label><textarea name="reason" rows="2" placeholder="ระบุเหตุผลโดยย่อ">${escapeHtml(editing?.reason || '')}</textarea></div>
      </div>
      ${(DB.isHR && !editing) ? `<label style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--success-soft);border:1px solid var(--success);border-radius:8px;font-size:13px;cursor:pointer;margin:8px 0">
        <input type="checkbox" name="autoApprove" id="leaveAutoApprove" checked/>
        <span><strong style="color:var(--success-text)">บันทึกเป็น "อนุมัติแล้ว" ทันที</strong> — ไม่ต้องเข้า approval chain (HR/admin override)</span>
      </label>` : ''}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">${editing ? 'บันทึก' : 'ส่งคำขอ'}</button>
      </div>
    </form>
  `, { size: 'md' });

  // auto-calc วัน + อัปเดตช่อง hint
  const recalc = () => {
    const s = $('#leaveStart').value, e = $('#leaveEnd').value;
    if (s && e && e >= s) {
      const days = Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
      if (days > 0) $('#leaveDays').value = days;
    }
  };
  const updateBackdate = () => {
    const start = $('#leaveStart').value;
    const type = $('#leaveType').value;
    const box = $('#leaveBackdateHint');
    if (!start || !type) { box.textContent = ''; return; }
    const isPast = start < today;
    if (!isPast) { box.innerHTML = ''; return; }
    const cfg = DB.LEAVE_TYPES[type];
    if (cfg?.allowBackdate) {
      box.innerHTML = `<span style="color:var(--warning)">ℹ️ ลาย้อนหลัง — ประเภท "${escapeHtml(cfg.label || type)}" อนุญาต</span>`;
    } else {
      box.innerHTML = `<span style="color:var(--danger)">⛔ ห้ามลาย้อนหลังสำหรับประเภทนี้</span>`;
    }
  };
  const updateApprover = () => {
    const empId = $('#leaveEmp').value;
    const box = $('#leaveApproverHint');
    if (!empId) { box.textContent = ''; return; }
    const approver = DB.getLeaveApprover(empId);
    if (!approver) { box.innerHTML = `<span style="color:var(--warning)">⚠️ ไม่พบผู้อนุมัติของสาขานี้ — admin จะเป็นผู้อนุมัติ</span>`; return; }
    const approverPos = DB.getPosition(approver.position);
    const isSelf = approver.id === empId;
    box.innerHTML = `👤 ผู้อนุมัติ: <strong>${escapeHtml(approver.firstName + ' ' + (approver.lastName || ''))}</strong> ${approverPos ? `(${escapeHtml(approverPos.name)})` : ''} · สาขา ${escapeHtml(approver.branch || '-')}${isSelf ? ' <span style="color:var(--warning)">⚠️ เป็นหัวสาขาเอง — admin จะ override</span>' : ''}`;
  };
  const updateHint = () => {
    const empId = $('#leaveEmp').value;
    const type = $('#leaveType').value;
    const hint = $('#leaveBalanceHint');
    if (!empId || !type) { hint.textContent = ''; return; }
    const b = DB.calcLeaveBalance(empId, type, new Date().getFullYear());
    if (b.quota === 0) {
      hint.innerHTML = `<span style="color:var(--danger)">⚠️ ไม่มีสิทธิ์ลาประเภทนี้ (อาจเพราะเพศ/อายุงานไม่ถึง)</span>`;
    } else {
      const days = Number($('#leaveDays').value || 0);
      const willExceed = days > b.remaining;
      hint.innerHTML = `โควต้า: <strong>${b.quota}</strong> วัน · ใช้ไป <strong>${b.used}</strong> · คงเหลือ <strong style="color:${willExceed ? 'var(--danger)' : 'var(--success)'}">${b.remaining}</strong> วัน${willExceed ? ` <span style="color:var(--danger)">⚠️ เกินโควต้า ${days - b.remaining} วัน</span>` : ''}`;
    }
  };
  $('#leaveStart').addEventListener('change', () => { recalc(); updateHint(); updateBackdate(); });
  $('#leaveEnd').addEventListener('change', () => { recalc(); updateHint(); });
  $('#leaveDays').addEventListener('input', updateHint);
  $('#leaveEmp').addEventListener('change', () => { updateHint(); updateApprover(); });
  $('#leaveType').addEventListener('change', () => { updateHint(); updateBackdate(); });
  updateHint();
  updateApprover();
  updateBackdate();

  $('#leaveForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target).entries());
    // viewer/staff/manager: select ถูก disable → FormData ไม่ส่งค่า employeeId มา → fallback เป็น employee_id ของตัวเอง
    // HR + admin: เลือก employee คนไหนก็ได้ (ทำคำขอแทนพนักงาน)
    if (!DB.isHR) {
      data.employeeId = DB.profile?.employee_id || '';
      if (!data.employeeId) return toast('โปรไฟล์ของคุณยังไม่ผูกกับรหัสพนักงาน — ติดต่อ admin', 'error');
    }
    if (!DB.isHR && data.employeeId !== (DB.profile?.employee_id || '')) {
      return toast('สามารถส่งคำขอของตัวเองเท่านั้น', 'error');
    }
    if (new Date(data.endDate) < new Date(data.startDate)) return toast('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม', 'error');
    // กฎ: ห้ามลาย้อนหลัง — เช็คจาก allowBackdate ของแต่ละประเภท (admin แก้ใน config tab ได้)
    if (data.startDate < today && !DB.LEAVE_TYPES[data.leaveType]?.allowBackdate) {
      return toast('ห้ามลาย้อนหลังสำหรับประเภทนี้ (ดู config ที่ tab "ตั้งค่าประเภท")', 'error');
    }
    try {
      const payload = { ...data, days: Number(data.days) };
      if (id) payload.id = id;
      const saved = await DB.saveLeaveRequest(payload);
      const autoApprove = DB.isHR && !id && data.autoApprove === 'on';
      // ─── Auto-approve (HR/admin override) — 2nd API call ที่ catch แยก ───
      if (autoApprove && saved?.id) {
        try {
          await DB.approveLeaveRequest(saved.id, '✓ บันทึกและอนุมัติโดย ' + (DB.profile?.employee_id || 'HR'));
          toast('✓ บันทึก + อนุมัติแล้ว', 'success');
          modal.close();
          if (router.current === 'leave') router.go('leave');
          return;
        } catch (approveEx) {
          // save สำเร็จแล้ว แต่ approve fail → record ค้างเป็น pending
          toast(`บันทึกแล้ว แต่อนุมัติอัตโนมัติไม่สำเร็จ — คำขออยู่ใน "รออนุมัติ" (${approveEx.message || approveEx})`, 'warning');
          modal.close();
          if (router.current === 'leave') router.go('leave');
          return;
        }
      }
      // บอกผู้ใช้ว่าคำขอจะส่งไปให้ใครอนุมัติจริง (ไม่ใช่ "admin" ลอยๆ)
      let msg;
      if (id) {
        msg = 'แก้ไขคำขอแล้ว';
      } else {
        const approver = DB.getLeaveApprover(payload.employeeId);
        if (approver) {
          const approverName = (approver.firstName + ' ' + (approver.lastName || '')).trim();
          const isSelf = approver.id === payload.employeeId;
          msg = isSelf
            ? 'ส่งคำขอแล้ว · คุณเป็นหัวสาขาเอง — รอ Area Manager/HR อนุมัติ'
            : `ส่งคำขอแล้ว · รอ ${approverName} อนุมัติ`;
        } else {
          msg = 'ส่งคำขอแล้ว · ไม่พบผู้อนุมัติของสาขา — admin จะเป็นผู้อนุมัติ';
        }
      }
      toast(msg, 'success');
      modal.close();
      if (router.current === 'leave') router.go('leave');
    } catch (ex) { toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
  });
}

// ตรวจสิทธิ์อนุมัติ: admin/HR → ทุกคำขอ, Manager → เฉพาะคำขอที่ตัวเองเป็น approver
// (ไม่ใช้ requireHR() เพราะจะบล็อก branch_manager/area_manager ที่เป็นผู้อนุมัติจริง)
function requireApprover(requestId) {
  const req = DB.getLeaveRequest(requestId);
  if (!req) { toast('ไม่พบคำขอลา', 'error'); return false; }
  if (!DB.canApproveLeaveFor(req.employeeId)) {
    toast('คุณไม่ใช่ผู้อนุมัติของคำขอนี้', 'error');
    return false;
  }
  return true;
}

async function approveLeave(id) {
  if (!requireApprover(id)) return;
  // กฎ: ห้ามอนุมัติคำขอที่วันลาผ่านไปแล้ว ยกเว้นประเภท allowBackdate (ป่วย/คลอด)
  // admin/HR override ได้ทุกกรณี (ทำได้ทุกอย่างไม่มีข้อยกเว้น) → skip check
  if (!DB.isHR) {
    const req = DB.getLeaveRequest(id);
    if (req) {
      const cfg = DB.LEAVE_TYPES[req.leaveType];
      const today = tz.today();
      if (!cfg?.allowBackdate && req.endDate && req.endDate < today) {
        toast(`ไม่สามารถอนุมัติได้ — วันลาผ่านไปแล้ว (สิ้นสุด ${fmt.date(req.endDate)}) · ประเภท "${cfg?.label || req.leaveType}" ไม่อนุญาตให้อนุมัติย้อนหลัง · กรุณาปฏิเสธหรือยกเลิก`, 'error');
        return;
      }
    }
  }
  const note = await modal.prompt('อนุมัติคำขอลา', 'หมายเหตุ (ถ้ามี):', '');
  if (note === null) return;
  try {
    await DB.approveLeaveRequest(id, note);
    toast('อนุมัติแล้ว', 'success');
    router.go('leave');
  } catch (ex) { toast('ไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function rejectLeave(id) {
  if (!requireApprover(id)) return;
  const note = await modal.prompt('ปฏิเสธคำขอลา', 'เหตุผลที่ปฏิเสธ:', '');
  if (note === null) return;
  try {
    await DB.rejectLeaveRequest(id, note);
    toast('ปฏิเสธแล้ว', 'success');
    router.go('leave');
  } catch (ex) { toast('ไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function cancelLeave(id) {
  const reason = await modal.prompt('ยกเลิกคำขอลา', 'เหตุผลที่ยกเลิก (ถ้ามี):', '');
  if (reason === null) return;
  try {
    await DB.cancelLeaveRequest(id, reason);
    toast('ยกเลิกแล้ว', 'success');
    router.go('leave');
  } catch (ex) { toast('ไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function deleteLeave(id) {
  if (!requireHR()) return;
  if (!await modal.confirm('ลบคำขอ', 'ลบรายการนี้ถาวร? ไม่สามารถกู้คืนได้')) return;
  try {
    await DB.deleteLeaveRequest(id);
    toast('ลบแล้ว', 'success');
    router.go('leave');
  } catch (ex) { toast('ไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

function updateLeaveBadge() {
  // ใช้ getLeaveRequests() เพื่อ auto-scope ตาม RBAC (branch_staff/viewer เห็นเฉพาะของตัวเอง,
  // branch/area manager เห็นเฉพาะสาขาที่ดูแล) — admin/HR เห็นทุกคำขอ ตรงกับ stat บนหน้าเลย
  const pendingScoped = (DB.getLeaveRequests({ status: 'pending' }) || []);
  // กรองให้เหลือเฉพาะคำขอที่ "ฉันอนุมัติได้จริง" → badge = งานที่ต้องลงมือทำ
  // (admin/HR = ทุกคำขอ, manager = เฉพาะที่ตัวเองเป็น approver, staff/viewer = 0)
  const actionable = pendingScoped.filter(r => DB.canApproveLeaveFor(r.employeeId));
  const pending = actionable.length;
  const badge = document.getElementById('navBadgeLeave');
  if (!badge) return;
  if (pending > 0) { badge.textContent = String(pending); badge.style.display = 'inline-block'; badge.title = `${pending} คำขอลารออนุมัติ`; }
  else { badge.style.display = 'none'; }
}

// Badge ประกาศ — นับประกาศ/คำสั่งที่พนักงานยังไม่ได้เปิดอ่าน
// admin/HR ไม่นับ (เพราะเป็นผู้สร้างประกาศ)
function updateAnnouncementBadge() {
  const badge = document.getElementById('navBadgeAnnouncement');
  if (!badge) return;
  const count = DB.getUnreadAnnouncementCount();
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = 'inline-block';
    badge.title = `${count} ประกาศ/คำสั่งที่ยังไม่ได้อ่าน`;
  } else {
    badge.style.display = 'none';
  }
}

// Badge ปฏิทิน HR — นับคำขอเปลี่ยนวันหยุดที่ user มีสิทธิ์อนุมัติ (logic เดียวกับ leave)
function updateCalendarBadge() {
  const pendingScoped = (DB.getHolidaySwapRequests({ status: 'pending' }) || []);
  const actionable = pendingScoped.filter(r => DB.canApproveHolidaySwapFor(r.employeeId));
  const pending = actionable.length;
  const badge = document.getElementById('navBadgeCalendar');
  if (!badge) return;
  if (pending > 0) { badge.textContent = String(pending); badge.style.display = 'inline-block'; badge.title = `${pending} คำขอเปลี่ยนวันหยุดรออนุมัติ`; }
  else { badge.style.display = 'none'; }
}

// ═══════════════════════════════════════════════════════
//  PAGE: USER ROLES (จัดการบัญชี + สิทธิ์ผู้ใช้) — admin + HR
// ═══════════════════════════════════════════════════════
router.register('user-roles', () => {
  const rows = DB.getRoleMatrix();
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ผู้ใช้และสิทธิ์</div>
        <div class="sw-page-subtitle">จัดการบัญชี login + Role ของพนักงาน — admin / HR เท่านั้น</div>
      </div>
    </div>

    <!-- Editable reference matrix -->
    <div class="sw-chart-card" style="margin-bottom:20px">
      <div class="sw-chart-header" style="align-items:flex-start">
        <div>
          <div class="sw-chart-title">ตารางสิทธิ์ตาม Role</div>
          <div class="sw-chart-sub">เอกสารอ้างอิง — admin/HR แก้ไข + เพิ่มแถวได้ <span class="badge badge-warning" style="font-size:10.5px;margin-left:6px">⚠️ ไม่กระทบ permission จริงในระบบ</span></div>
        </div>
        ${DB.isHR ? `<button class="btn btn-primary btn-sm" onclick="openRoleMatrixEditor()">${ICON.plus}แก้ไข / เพิ่มแถว</button>` : ''}
      </div>
      <div class="table-wrap"><table class="table table-compact">
        <thead><tr>
          <th>เมนู / สิทธิ์</th>
          <th class="num">Admin</th>
          <th class="num">HR</th>
          <th class="num">Op Mgr</th>
          <th class="num">Area Mgr</th>
          <th class="num">Branch Mgr</th>
          <th class="num">Branch Staff</th>
          <th>หมายเหตุ</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => {
            const cells = [r.admin, r.hr, r.opMgr, r.areaMgr, r.branchMgr, r.branchStaff];
            return `<tr>
              <td><strong>${escapeHtml(r.menuLabel)}</strong></td>
              ${cells.map(cell => `<td class="num" style="color:${(cell === '—' || cell === '— ซ่อน' || !cell) ? 'var(--text-3)' : 'var(--text)'}">${escapeHtml(cell || '—')}</td>`).join('')}
              <td class="sw-cell-meta">${escapeHtml(r.note || '')}</td>
            </tr>`;
          }).join('') : `<tr><td colspan="8" class="muted-2" style="text-align:center;padding:20px">ยังไม่มีข้อมูลในตาราง — กด "แก้ไข / เพิ่มแถว" เพื่อเริ่ม</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <!-- User accounts management — reuse renderEmpAccounts() -->
    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">บัญชีผู้ใช้และ Role</div>
          <div class="sw-chart-sub">สร้างบัญชี · รีเซ็ตรหัส · เปลี่ยน Role ของพนักงาน</div>
        </div>
      </div>
      <div id="empAccountsBox" style="margin-top:14px">
        <div class="muted-2" style="padding:20px;text-align:center">กำลังโหลด...</div>
      </div>
    </div>
  `;
});

// Modal แก้ไขตาราง role matrix (admin/HR) — premium UI
async function openRoleMatrixEditor() {
  if (!requireHR()) return;
  const rows = DB.getRoleMatrix();
  const draft = rows.map(r => ({ ...r }));

  // Role columns config — แต่ละ role มี accent สี subtle
  const COLS = [
    { k: 'menuLabel',  label: 'เมนู / สิทธิ์',   tone: 'label' },
    { k: 'admin',      label: 'Admin',          tone: 'admin' },
    { k: 'hr',         label: 'HR',             tone: 'hr' },
    { k: 'opMgr',      label: 'Op Mgr',         tone: 'mgr' },
    { k: 'areaMgr',    label: 'Area Mgr',       tone: 'mgr' },
    { k: 'branchMgr',  label: 'Branch Mgr',     tone: 'mgr' },
    { k: 'branchStaff',label: 'Branch Staff',   tone: 'staff' },
    { k: 'note',       label: 'หมายเหตุ',        tone: 'note' }
  ];

  const renderTable = () => {
    return `<div class="mtx-wrap"><table class="mtx-table" id="matrixEditTable">
      <thead><tr>
        ${COLS.map(c => `<th class="mtx-th mtx-th-${c.tone}">${escapeHtml(c.label)}</th>`).join('')}
        <th class="mtx-th mtx-th-action"></th>
      </tr></thead>
      <tbody>
        ${draft.map((r, i) => `<tr class="mtx-row" data-idx="${i}">
          ${COLS.map(c => `<td class="mtx-td mtx-td-${c.tone}"><div class="mtx-cell" contenteditable="true" data-k="${c.k}" data-idx="${i}" data-placeholder="${c.k === 'menuLabel' ? 'ชื่อเมนู…' : (c.k === 'note' ? '(ทางเลือก)' : '—')}">${escapeHtml(r[c.k] || '')}</div></td>`).join('')}
          <td class="mtx-td mtx-td-action"><button type="button" class="mtx-del" onclick="window._mtxDeleteRow(${i})" title="ลบแถวนี้" aria-label="ลบ"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  };

  modal.open('แก้ไขตารางสิทธิ์ตาม Role',
    `<style>
       /* Premium editable matrix */
       .mtx-wrap { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface); }
       .mtx-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
       .mtx-th {
         padding: 12px 14px; text-align: left; font-size: 10.5px; font-weight: 700;
         letter-spacing: 0.10em; text-transform: uppercase; color: var(--text-2);
         background: var(--surface-2); border-bottom: 1px solid var(--border);
         position: sticky; top: 0; z-index: 1;
       }
       .mtx-th-admin  { color: #1e3a8a; }
       .mtx-th-hr     { color: #166534; }
       .mtx-th-mgr    { color: #1d4ed8; }
       .mtx-th-staff  { color: #6b7280; }
       .mtx-th-action { width: 48px; }
       .mtx-td { padding: 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
       .mtx-row:last-child .mtx-td { border-bottom: 0; }
       .mtx-row { transition: background 0.12s; }
       .mtx-row:hover { background: rgba(78, 112, 176, 0.03); }
       .mtx-cell {
         padding: 12px 14px; min-height: 22px; line-height: 1.45;
         border-radius: 6px; cursor: text; transition: all 0.12s;
         outline: none; border: 1px solid transparent;
       }
       .mtx-td-label .mtx-cell { font-weight: 600; color: var(--text); }
       .mtx-td-note .mtx-cell { font-size: 12.5px; color: var(--text-2); font-style: italic; }
       .mtx-cell:hover { background: rgba(78, 112, 176, 0.06); }
       .mtx-cell:focus {
         background: var(--surface);
         border-color: var(--primary);
         box-shadow: 0 0 0 3px rgba(78, 112, 176, 0.15);
       }
       .mtx-cell:empty::before {
         content: attr(data-placeholder); color: var(--text-3); font-style: italic;
       }
       .mtx-td-action { text-align: center; padding-right: 8px; }
       .mtx-del {
         background: transparent; border: 0; padding: 6px;
         color: var(--text-3); cursor: pointer; border-radius: 6px;
         opacity: 0; transition: all 0.15s;
         display: inline-flex; align-items: center; justify-content: center;
       }
       .mtx-row:hover .mtx-del { opacity: 0.6; }
       .mtx-del:hover { opacity: 1; color: var(--danger); background: rgba(220, 38, 38, 0.08); }
       /* warning banner */
       .mtx-warning {
         display: flex; align-items: flex-start; gap: 12px;
         padding: 14px 16px; margin-bottom: 18px;
         background: linear-gradient(135deg, rgba(184, 122, 8, 0.10), rgba(184, 122, 8, 0.04));
         border: 1px solid rgba(184, 122, 8, 0.25); border-radius: 10px;
         font-size: 12.5px; line-height: 1.6; color: var(--text-2);
       }
       .mtx-warning-icon {
         flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%;
         background: var(--warning); color: #fff;
         display: inline-flex; align-items: center; justify-content: center;
         font-weight: 700; font-size: 13px;
       }
       .mtx-add-btn {
         margin-top: 12px;
         display: inline-flex; align-items: center; gap: 8px;
         padding: 10px 16px; background: transparent;
         border: 1.5px dashed var(--border-strong); border-radius: 10px;
         color: var(--text-2); font-size: 13px; font-weight: 500; cursor: pointer;
         transition: all 0.15s;
       }
       .mtx-add-btn:hover {
         border-color: var(--primary); color: var(--primary);
         background: rgba(78, 112, 176, 0.04);
       }
     </style>
     <div class="mtx-warning">
       <span class="mtx-warning-icon">!</span>
       <div><strong>เอกสารอ้างอิงเท่านั้น</strong> — การแก้ค่าในตารางนี้จะไม่ไปเปลี่ยนสิทธิ์จริงในระบบโดยอัตโนมัติ สิทธิ์การใช้งานจริงยังควบคุมโดย code และ RLS policy ใน database</div>
     </div>
     <div id="matrixEditBox">${renderTable()}</div>
     <button type="button" class="mtx-add-btn" onclick="window._mtxAddRow()">
       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
       เพิ่มแถวใหม่
     </button>`,
    {
      size: 'lg',
      footer: `<button class="btn btn-secondary" data-close>ยกเลิก</button><button class="btn btn-primary" id="mtxSave">บันทึก</button>`
    }
  );

  // Bind global helpers (modal scope)
  window._mtxAddRow = () => {
    const maxSort = draft.reduce((m, r) => Math.max(m, r.sortOrder || 0), 0);
    draft.push({ menuLabel: '', admin: '', hr: '', opMgr: '', areaMgr: '', branchMgr: '', branchStaff: '', sortOrder: maxSort + 10, note: '' });
    rebind();
  };
  window._mtxDeleteRow = (idx) => {
    // ถ้าเป็น row ที่มี id (จาก DB) — เก็บ id ใน _toDelete
    const row = draft[idx];
    if (row && row.id) {
      draft._toDelete = draft._toDelete || [];
      draft._toDelete.push(row.id);
    }
    draft.splice(idx, 1);
    rebind();
  };
  const collectFromInputs = () => {
    const rows = $$('#matrixEditTable tbody tr');
    rows.forEach((tr, i) => {
      const cells = $$('.mtx-cell', tr);
      cells.forEach(cell => {
        draft[i][cell.dataset.k] = (cell.textContent || '').trim();
      });
    });
  };
  const rebind = () => {
    collectFromInputs();
    const box = $('#matrixEditBox');
    if (box) box.innerHTML = renderTable();
  };

  $('#mtxSave').addEventListener('click', async () => {
    collectFromInputs();
    const btn = $('#mtxSave'); btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
    try {
      // ลบ rows ที่ user remove
      const toDelete = draft._toDelete || [];
      for (const id of toDelete) {
        try { await DB.deleteRoleMatrixRow(id); } catch (e) { console.warn('Delete failed', id, e); }
      }
      // Save remaining rows (sort_order = order ใน list)
      for (let i = 0; i < draft.length; i++) {
        const r = draft[i];
        if (!r.menuLabel || !r.menuLabel.trim()) continue; // ข้าม row ว่าง
        r.sortOrder = (i + 1) * 10;
        await DB.saveRoleMatrixRow(r);
      }
      // refresh data + router
      try {
        const { data: rm } = await DB.client.from('role_permission_matrix').select('*').order('sort_order');
        DB.data.roleMatrix = (rm || []).map(DB._matrixFromDB);
      } catch {}
      modal.close();
      toast('บันทึกตารางสิทธิ์แล้ว', 'success');
      router.refresh();
    } catch (ex) {
      toast('บันทึกไม่สำเร็จ: ' + (ex.message || ex), 'error');
      btn.disabled = false; btn.textContent = 'บันทึก';
    }
  });
}

router.register('settings', () => {
  const c = DB.data.company;
  return `
    <div class="sw-page-header">
      <div>
        <div class="sw-page-title">ตั้งค่าระบบ</div>
        <div class="sw-page-subtitle">ข้อมูลบริษัท · ข้อมูลสำรอง · ข้อมูลระบบ (admin only)</div>
      </div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">ข้อมูลบริษัท</div>
          <div class="sw-chart-sub">ชื่อ ที่อยู่ และรายละเอียดบริษัท · ใช้ในเอกสารและ Export</div>
        </div>
      </div>
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

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">เปลี่ยนรหัสผ่าน</div>
          <div class="sw-chart-sub">เปลี่ยนรหัสผ่านของบัญชีตัวเอง · ขั้นต่ำ 8 ตัวอักษร</div>
        </div>
      </div>
      <form id="pwForm">
        <div class="form-grid">
          <div class="form-group"><label>รหัสผ่านใหม่</label><input name="new" type="password" required minlength="8" autocomplete="new-password" placeholder="อย่างน้อย 8 ตัวอักษร"/></div>
          <div class="form-group"><label>ยืนยันรหัสผ่านใหม่</label><input name="confirm" type="password" required minlength="8" autocomplete="new-password" placeholder="ใส่ซ้ำเพื่อยืนยัน"/></div>
        </div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">เปลี่ยนรหัสผ่าน</button></div>
      </form>
    </div>

    <div class="sw-chart-card" style="border-left:3px solid var(--primary)">
      <div style="font-size:13px;color:var(--text-2);line-height:1.6">
        📋 <strong>จัดการบัญชีผู้ใช้และ Role</strong> ของพนักงาน — ย้ายไปที่เมนู <a href="#" onclick="router.go('user-roles');return false" style="color:var(--primary);font-weight:600">"ผู้ใช้และสิทธิ์"</a> (admin + HR เข้าได้)
      </div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">ข้อมูลและการสำรอง</div>
          <div class="sw-chart-sub">ดาวน์โหลด snapshot ข้อมูลทั้งระบบ · Supabase มี backup อัตโนมัติอยู่แล้ว · sน sn snapshot นี้สำรองเพิ่มเติม</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
        <button class="btn btn-secondary" onclick="exportDataJSON()" style="justify-content:flex-start;padding:14px 16px">${ICON.download}<span style="margin-left:8px">ดาวน์โหลดข้อมูลสำรอง (JSON)</span></button>
      </div>
    </div>

    <div class="sw-chart-card">
      <div class="sw-chart-header">
        <div>
          <div class="sw-chart-title">ข้อมูลระบบ</div>
          <div class="sw-chart-sub">ผู้ใช้ปัจจุบันและ backend ที่กำลังใช้งาน</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
        <div style="padding:14px 16px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border)">
          <div class="muted-2" style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;font-weight:600">ผู้ใช้ปัจจุบัน</div>
          <div style="margin-top:6px;font-weight:600;font-size:13.5px;word-break:break-all">${escapeHtml(DB.user?.email || '—')}</div>
        </div>
        <div style="padding:14px 16px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border)">
          <div class="muted-2" style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;font-weight:600">บทบาท</div>
          <div style="margin-top:6px">${DB.isAdmin ? '<span class="badge badge-success">Admin</span>' : (DB.role === 'hr' ? '<span class="badge badge-info">HR</span>' : `<span class="badge">${escapeHtml(DB.role || 'Viewer')}</span>`)}</div>
        </div>
        <div style="padding:14px 16px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border)">
          <div class="muted-2" style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;font-weight:600">Backend</div>
          <div style="margin-top:6px;font-weight:600;font-size:13.5px">Supabase · Cloud + Realtime</div>
        </div>
      </div>
    </div>
  `;
});

// ─── Employee Account Management (Settings page) ───
// Role labels + badge classes (ใช้ร่วมกัน)
const ROLE_LABELS = {
  admin:             { th: 'Admin',             badge: 'badge-primary' },
  hr:                { th: 'HR',                badge: 'badge-success' },
  operation_manager: { th: 'Operation Manager', badge: 'badge-info' },
  area_manager:      { th: 'Area Manager',      badge: 'badge-info' },
  branch_manager:    { th: 'ผู้จัดการสาขา',     badge: 'badge-warning' },
  branch_staff:      { th: 'พนักงานสาขา',       badge: '' },
  viewer:            { th: 'ผู้ใช้ทั่วไป',       badge: '' }
};

// State + actions ของ filter ในหน้า "ผู้ใช้และสิทธิ์" (รองรับพนักงานจำนวนมาก)
const _empAccFilter = { search: '', branch: '', role: '', accStatus: '' };
function setEmpAccFilter(k, v) {
  const newVal = (v ?? '').trim();
  if (_empAccFilter[k] === newVal) return;
  _empAccFilter[k] = newVal;
  renderEmpAccounts();
}
function clearEmpAccFilters() {
  _empAccFilter.search = '';
  _empAccFilter.branch = '';
  _empAccFilter.role = '';
  _empAccFilter.accStatus = '';
  renderEmpAccounts();
}

async function renderEmpAccounts() {
  const box = document.getElementById('empAccountsBox');
  if (!box || !DB.isHR) return;
  try {
    const profiles = await DB.getUserProfilesList();
    const byEmpId = new Map(profiles.filter(p => p.employee_id).map(p => [p.employee_id, p]));
    const active = DB.data.employees.filter(e => DB.empStatus(e) !== 'resigned');
    const withAcc = active.filter(e => byEmpId.has(e.id));
    const withoutAcc = active.filter(e => !byEmpId.has(e.id));
    const adminCount = Array.from(byEmpId.values()).filter(p => p.role === 'admin').length;

    // ─── Apply filters ───
    const f = _empAccFilter;
    const s = f.search.toLowerCase();
    const filtered = active.filter(e => {
      if (s) {
        const name = ((e.firstName || '') + ' ' + (e.lastName || '')).toLowerCase();
        const email = `${e.id.toLowerCase()}@kacha.local`;
        if (!name.includes(s) && !String(e.id).toLowerCase().includes(s) && !email.includes(s)) return false;
      }
      if (f.branch && e.branch !== f.branch) return false;
      const p = byEmpId.get(e.id);
      const hasAcc = !!p;
      if (f.role) {
        const roleKey = p?.role || 'viewer';
        if (f.role === 'no_account') { if (hasAcc) return false; }
        else if (roleKey !== f.role) return false;
      }
      if (f.accStatus === 'has' && !hasAcc) return false;
      if (f.accStatus === 'none' && hasAcc) return false;
      return true;
    });

    const branches = [...new Set(active.map(e => e.branch).filter(Boolean))].sort();
    const hasFilters = !!(f.search || f.branch || f.role || f.accStatus);
    const isFiltered = hasFilters;

    box.innerHTML = `
      <div class="sw-account-summary">
        <div class="sw-account-stat">
          <div class="sw-account-stat-label">มีบัญชี</div>
          <div class="sw-account-stat-value" style="color:var(--success)">${fmt.num(withAcc.length)}</div>
        </div>
        <div class="sw-account-stat">
          <div class="sw-account-stat-label">ยังไม่มี</div>
          <div class="sw-account-stat-value" style="color:${withoutAcc.length > 0 ? 'var(--warning)' : 'var(--text)'}">${fmt.num(withoutAcc.length)}</div>
        </div>
        <div class="sw-account-stat">
          <div class="sw-account-stat-label">Admin</div>
          <div class="sw-account-stat-value" style="color:var(--primary)">${fmt.num(adminCount)}</div>
        </div>
        <div class="sw-account-stat">
          <div class="sw-account-stat-label">รวม active</div>
          <div class="sw-account-stat-value">${fmt.num(active.length)}</div>
        </div>
        ${withoutAcc.length > 0 ? `<button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="bulkCreateAccounts()">🚀 สร้างบัญชีให้ ${withoutAcc.length} คนที่เหลือ</button>` : ''}
      </div>

      <!-- Filter bar -->
      <div class="sw-filter-bar" style="margin-top:14px">
        <input id="empAccSearch" type="text" class="sw-filter-input" placeholder="🔍 ค้นชื่อ / รหัส / email"
          value="${escapeHtml(f.search)}"
          onkeydown="if(event.key==='Enter'){event.preventDefault();setEmpAccFilter('search', this.value);}"
          onblur="setEmpAccFilter('search', this.value)"/>
        ${branches.length > 1 ? `<select class="sw-filter-select" onchange="setEmpAccFilter('branch', this.value)">
          <option value="">— ทุกสาขา —</option>
          ${branches.map(b => `<option value="${escapeHtml(b)}" ${f.branch === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>` : ''}
        <select class="sw-filter-select" onchange="setEmpAccFilter('role', this.value)">
          <option value="">— ทุก Role —</option>
          ${Object.entries(ROLE_LABELS).map(([k, v]) => `<option value="${k}" ${f.role === k ? 'selected' : ''}>${escapeHtml(v.th)}</option>`).join('')}
        </select>
        <select class="sw-filter-select" onchange="setEmpAccFilter('accStatus', this.value)">
          <option value="">— ทุกสถานะ —</option>
          <option value="has" ${f.accStatus === 'has' ? 'selected' : ''}>✓ มีบัญชี</option>
          <option value="none" ${f.accStatus === 'none' ? 'selected' : ''}>⚠ ยังไม่มี</option>
        </select>
        ${hasFilters ? `<button class="btn btn-ghost btn-sm sw-filter-clear" onclick="clearEmpAccFilters()">✕ ล้างตัวกรอง</button>` : ''}
        ${isFiltered ? `<div class="muted-2" style="margin-left:auto;font-size:12px;align-self:center">แสดง <strong>${fmt.num(filtered.length)}</strong> / ${fmt.num(active.length)} คน</div>` : ''}
      </div>

      ${filtered.length === 0 ? `<div class="empty-state" style="padding:40px 20px;margin-top:14px">
        <div style="font-size:32px;opacity:0.3">🔍</div>
        <div class="title" style="font-size:14px;font-weight:600;margin-top:8px">ไม่พบพนักงานตามตัวกรอง</div>
        <div class="hint" style="margin-top:4px">ลองล้างตัวกรองเพื่อดูทั้งหมด</div>
      </div>` : `
      <div class="table-wrap" style="max-height:520px;overflow:auto;margin-top:14px"><table class="table table-compact sw-emp-table">
        <thead><tr><th>รหัส</th><th>ชื่อพนักงาน</th><th>สาขา</th><th>Email Login</th><th>Role</th><th>สาขาที่ดูแล</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>
          ${filtered.map(e => {
            const p = byEmpId.get(e.id);
            const hasAcc = !!p;
            const email = `${e.id.toLowerCase()}@kacha.local`;
            const roleKey = p?.role || 'viewer';
            const roleInfo = ROLE_LABELS[roleKey] || ROLE_LABELS.viewer;
            const mgdBranches = Array.isArray(p?.managed_branches) ? p.managed_branches.filter(Boolean) : [];
            const showsBranches = (roleKey === 'area_manager' || roleKey === 'operation_manager');
            return `<tr>
              <td><code style="font-size:11.5px;font-weight:600">${escapeHtml(e.id)}</code></td>
              <td>
                <div class="sw-emp-cell">
                  <strong>${escapeHtml(e.firstName + ' ' + (e.lastName || ''))}</strong>
                </div>
              </td>
              <td class="sw-cell-meta">${escapeHtml(e.branch || '—')}</td>
              <td><code style="font-size:11.5px">${escapeHtml(email)}</code></td>
              <td>${hasAcc ? `<span class="badge ${roleInfo.badge}">${roleInfo.th}</span>` : '<span class="muted-2">—</span>'}</td>
              <td class="sw-cell-meta">${showsBranches ? (mgdBranches.length ? mgdBranches.map(b => `<span class="badge" style="margin-right:3px">${escapeHtml(b)}</span>`).join('') : '<span class="muted-2">(auto)</span>') : '<span class="muted-2">—</span>'}</td>
              <td>${hasAcc ? '<span class="badge badge-success">✓ มีบัญชี</span>' : '<span class="badge badge-warning">⚠️ ยังไม่มี</span>'}</td>
              <td class="actions">
                ${!hasAcc ? `<button class="btn btn-primary btn-sm" onclick="createOneAccount('${escapeHtml(e.id)}')">สร้าง</button>` : ''}
                ${hasAcc ? `<button class="btn btn-ghost btn-sm" onclick="resetEmpPassword('${escapeHtml(e.id)}')">รีเซ็ตรหัส</button>
                  <button class="btn btn-ghost btn-sm" onclick="openRoleEditor('${escapeHtml(e.id)}')">เปลี่ยน Role</button>` : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`}
    `;
  } catch (ex) {
    box.innerHTML = `<div class="empty-state" style="padding:30px 20px;color:var(--danger)">
      <div style="font-size:32px;opacity:0.5">⚠️</div>
      <div class="title" style="font-size:14px;margin-top:8px;color:var(--danger)">โหลดข้อมูลไม่สำเร็จ</div>
      <div class="hint" style="margin-top:6px">${escapeHtml(ex.message || String(ex))}</div>
    </div>`;
  }
}

// Modal เปลี่ยน role + เลือกสาขาที่ดูแล (สำหรับ Area Manager / Operation Manager)
async function openRoleEditor(empId) {
  if (!requireHR()) return;
  const emp = DB.getEmployee(empId);
  if (!emp) return;
  const profiles = await DB.getUserProfilesList();
  const profile = profiles.find(p => p.employee_id === empId);
  const currentRole = profile?.role || 'viewer';
  const currentBranches = Array.isArray(profile?.managed_branches) ? profile.managed_branches.filter(Boolean) : [];
  const autoRole = DB.autoDetectRole(emp);
  const allBranches = DB.getBranchMaster({ activeOnly: true }) || [];

  // HR ห้ามแก้ role ของ admin คนอื่น
  if (!DB.isAdmin && currentRole === 'admin') {
    toast('HR ไม่มีสิทธิ์แก้ role ของ admin (เฉพาะ admin)', 'error');
    return;
  }

  modal.open('เปลี่ยน Role + สิทธิ์การใช้งาน',
    `<form id="roleForm">
      <div style="margin-bottom:14px;font-size:14px">
        <strong>${escapeHtml((emp.title || '') + emp.firstName + ' ' + (emp.lastName || ''))}</strong>
        <span class="muted-2" style="margin-left:8px">รหัส ${escapeHtml(emp.id)} · ${escapeHtml(emp.positionTitle || '-')}${emp.branch ? ' · ' + escapeHtml(emp.branch) : ''}</span>
      </div>
      <div class="form-group">
        <label>Role</label>
        <select name="role" id="roleSelect" required>
          ${Object.entries(ROLE_LABELS)
            .filter(([k]) => DB.isAdmin || k !== 'admin')
            .map(([k, v]) => `<option value="${k}" ${currentRole === k ? 'selected' : ''}>${v.th}</option>`).join('')}
        </select>
        ${autoRole ? `<small class="muted-2" style="display:block;margin-top:4px">💡 Auto-detect จากตำแหน่งงาน: <strong>${ROLE_LABELS[autoRole]?.th || autoRole}</strong> <button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;margin-left:6px" onclick="document.getElementById('roleSelect').value='${autoRole}';document.getElementById('roleSelect').dispatchEvent(new Event('change'))">ใช้ค่านี้</button></small>` : ''}
        ${!DB.isAdmin ? `<small class="muted-2" style="display:block;margin-top:4px;color:var(--warning)">⚠️ HR ตั้ง role admin ไม่ได้ (เฉพาะ admin เท่านั้น)</small>` : ''}
      </div>
      <div class="form-group" id="branchesGroup" style="display:${['area_manager','operation_manager'].includes(currentRole) ? '' : 'none'}">
        <label>สาขาที่ดูแล <span class="muted-2" style="font-weight:normal;font-size:11px">(เฉพาะ Area / Operation Manager · ถ้าไม่เลือก = ใช้สาขาของตัวเอง)</span></label>
        <div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
          ${allBranches.length ? allBranches.map(b => `
            <label style="display:flex;align-items:center;gap:8px;padding:4px;font-weight:normal">
              <input type="checkbox" name="branches" value="${escapeHtml(b.id)}" ${currentBranches.includes(b.id) ? 'checked' : ''}/>
              <span>${escapeHtml(b.id)}${b.name && b.name !== b.id ? ' — ' + escapeHtml(b.name) : ''}</span>
            </label>
          `).join('') : '<div class="muted-2">ไม่มีข้อมูลสาขาในระบบ</div>'}
        </div>
      </div>
    </form>`,
    {
      footer: `<button class="btn btn-secondary" data-close>ยกเลิก</button><button class="btn btn-primary" id="roleSave">บันทึก</button>`
    }
  );
  // Toggle "สาขาที่ดูแล" ตาม role
  $('#roleSelect').addEventListener('change', (e) => {
    const v = e.target.value;
    $('#branchesGroup').style.display = (v === 'area_manager' || v === 'operation_manager') ? '' : 'none';
  });
  $('#roleSave').addEventListener('click', async () => {
    const role = $('#roleSelect').value;
    const branchInputs = $$('#roleForm input[name="branches"]:checked');
    const branches = branchInputs.map(i => i.value);
    const btn = $('#roleSave'); btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
    try {
      await DB.setEmployeeRole(empId, role, ['area_manager', 'operation_manager'].includes(role) ? branches : []);
      modal.close();
      toast(`✓ เปลี่ยน role เป็น ${ROLE_LABELS[role]?.th || role}`, 'success');
      renderEmpAccounts();
    } catch (ex) {
      toast('ไม่สำเร็จ: ' + (ex.message || ex), 'error');
      btn.disabled = false; btn.textContent = 'บันทึก';
    }
  });
}

async function createOneAccount(empId) {
  if (!requireHR()) return;
  try {
    const res = await DB.createEmployeeAccount(empId);
    toast(`✓ สำเร็จ · email: ${res.email} · รหัส: ${res.password} (${res.source})`, 'success');
    renderEmpAccounts();
  } catch (ex) { toast('สร้างไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function bulkCreateAccounts() {
  if (!requireHR()) return;
  if (!await modal.confirm('สร้างบัญชีทั้งหมด', 'สร้างบัญชีให้พนักงานทุกคนที่ยังไม่มีบัญชีในระบบ?\n\nemail = {รหัส}@kacha.local\nรหัสเริ่มต้น = เลข ปชช → passport → kacha+รหัส\nrole = viewer')) return;
  try {
    const results = await DB.bulkCreateEmployeeAccounts();
    const okCount = results.filter(r => r.created).length;
    const errCount = results.filter(r => String(r.message).startsWith('ERROR')).length;
    const skipCount = results.length - okCount - errCount;
    toast(`✓ สร้าง ${okCount} ใหม่ · ข้าม ${skipCount} · ผิดพลาด ${errCount}`, errCount > 0 ? 'warning' : 'success');

    // ถ้ามี error — แสดง modal สรุปข้อผิดพลาดให้ admin ดู
    if (errCount > 0) {
      const errs = results.filter(r => String(r.message).startsWith('ERROR')).slice(0, 10);
      await modal.confirm('รายละเอียดข้อผิดพลาด', `แสดง ${errs.length} แรก:\n\n${errs.map(r => `• ${r.employee_id}: ${r.message.replace('ERROR: ', '')}`).join('\n')}`);
    }
    renderEmpAccounts();
  } catch (ex) { toast('ไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

async function resetEmpPassword(empId) {
  if (!requireHR()) return;
  const newPwd = await modal.prompt('รีเซ็ตรหัสผ่าน', `รหัสผ่านใหม่สำหรับ "${empId}" (เว้นว่างเพื่อรีเซ็ตเป็นเลขประชาชน):`, '');
  if (newPwd === null) return;
  try {
    const res = await DB.resetEmployeePassword(empId, newPwd.trim() || null);
    toast(`✓ รีเซ็ตแล้ว · รหัสใหม่: ${res.password}`, 'success');
  } catch (ex) { toast('รีเซ็ตไม่สำเร็จ: ' + (ex.message || ex), 'error'); }
}

// toggleEmpRole() เก่า — ถูกแทนที่ด้วย openRoleEditor() (รองรับ 7 roles + managed_branches)

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
  // Sidebar toggle — hamburger ที่ topbar = toggle หลัก (แสดงตลอดทั้ง PC/mobile)
  //   PC:     toggle class 'sidebar-hidden' บน .app + จำสถานะใน localStorage
  //   Mobile: toggle class 'open' บน sidebar (off-canvas)
  const isMobileView = () => window.matchMedia('(max-width: 900px)').matches;
  const appEl = () => $('#app');
  const sideEl = () => $('#sidebar');
  $('#hamburger').addEventListener('click', () => {
    if (isMobileView()) {
      sideEl().classList.toggle('open');
    } else {
      const hidden = appEl().classList.toggle('sidebar-hidden');
      try { localStorage.setItem('kb_sidebar_hidden', hidden ? '1' : '0'); } catch(e) {}
    }
  });
  // ปุ่ม X ใน sidebar — ปิด sidebar (ทำงานเหมือนกันทั้ง PC/mobile)
  $('#sidebarClose').addEventListener('click', () => {
    if (isMobileView()) {
      sideEl().classList.remove('open');
    } else {
      appEl().classList.add('sidebar-hidden');
      try { localStorage.setItem('kb_sidebar_hidden', '1'); } catch(e) {}
    }
  });
  // โหลดสถานะซ่อนเมนูที่ผู้ใช้เคยตั้งไว้ (เฉพาะบน PC; mobile ใช้ off-canvas เสมอ)
  try {
    if (localStorage.getItem('kb_sidebar_hidden') === '1' && !isMobileView()) {
      appEl().classList.add('sidebar-hidden');
    }
  } catch(e) {}
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
      // ตรวจสถานะพ้นสภาพก่อนแสดง app (เผื่อ user ถูกพ้นสภาพระหว่าง session ก่อนหน้า)
      const blocked = await auth.checkTerminationAndBlock();
      if (!blocked) auth.showApp();
      // ถ้า blocked → checkTerminationAndBlock() จะ showLogin() ให้แล้ว
    } else {
      auth.showLogin();
    }
  } catch (ex) {
    console.error('Init error:', ex);
    auth.showLogin();
  } finally {
    // ซ่อน boot splash หลังจาก init เสร็จ (ไม่ว่า login หรือ app)
    const splash = $('#bootSplash');
    if (splash) {
      splash.style.transition = 'opacity .25s ease';
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 260);
    }
  }
});
