// Payroll simulator front end: a small hash-routed app over the JSON API.

const state = { ws: null, company: null, companies: [], user: null };
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const dollars = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const maskSsn = (ssn) => (ssn ? `***-**-${ssn.slice(-4)}` : '');
const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Biweekly', semimonthly: 'Semi-monthly', monthly: 'Monthly' };
const KIND_LABEL = { section125: 'Pre-tax (Sec 125)', retirement: 'Pre-tax (Retirement)', posttax: 'Post-tax', garnishment: 'Garnishment' };

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  if (res.status === 401 && !path.startsWith('/auth')) { showAuth(); throw new Error('Please sign in'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const wsApi = (path, options) => api(`/w/${state.ws}${path}`, options);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ---------- context (sandbox + company) ----------

async function loadWorkspaces() {
  let list = await api('/workspaces');
  if (!list.length) list = [await api('/workspaces', { method: 'POST', body: {} })];
  const saved = Number(localStorageGet('ws'));
  state.ws = list.some((w) => w.id === saved) ? saved : list[0].id;
  const trainer = state.user.role === 'trainer';
  $('#ws-select').innerHTML = list
    .map((w) => `<option value="${w.id}">${esc(w.name)}${trainer && w.owner && w.user_id !== state.user.id ? ` (${esc(w.owner)})` : ''}</option>`).join('');
  $('#ws-select').value = state.ws;
  await loadCompanies();
}

async function loadCompanies() {
  state.companies = await wsApi('/companies');
  const saved = Number(localStorageGet(`company-${state.ws}`));
  state.company = state.companies.find((c) => c.id === saved) || state.companies[0];
  $('#company-select').innerHTML = state.companies
    .map((c) => `<option value="${c.id}">${esc(c.name)} (${c.state}, ${FREQ_LABEL[c.pay_frequency]})</option>`).join('');
  if (state.company) $('#company-select').value = state.company.id;
}

function localStorageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function localStorageSet(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

$('#ws-select').addEventListener('change', async (e) => {
  state.ws = Number(e.target.value);
  localStorageSet('ws', state.ws);
  await loadCompanies();
  route();
});
$('#company-select').addEventListener('change', (e) => {
  state.company = state.companies.find((c) => c.id === Number(e.target.value));
  localStorageSet(`company-${state.ws}`, state.company.id);
  route();
});
$('#reset-btn').addEventListener('click', async () => {
  if (!confirm('Reset this sandbox? All employees, setup and payroll runs are replaced with fresh training data.')) return;
  await wsApi('/reset', { method: 'POST' });
  await loadCompanies();
  toast('Sandbox reset');
  location.hash = '#/dashboard';
  route();
});

// ---------- views ----------

const routes = {
  dashboard: renderDashboard,
  employees: renderEmployees,
  employee: renderEmployee,
  setup: renderSetup,
  payroll: renderPayroll,
  run: renderRun,
  reports: renderReports,
  paycheck: renderPaycheck,
  import: renderImport,
  assignments: renderAssignments,
  admin: renderAdmin,
};
const NO_COMPANY_NEEDED = new Set(['assignments', 'admin']);

async function route() {
  const [name = 'dashboard', ...params] = location.hash.replace(/^#\//, '').split('/');
  document.querySelectorAll('.sidenav a').forEach((a) => {
    const target = a.getAttribute('href').slice(2);
    a.classList.toggle('active', target === name || (name === 'employee' && target === 'employees') || (name === 'run' && target === 'payroll') || (name === 'paycheck' && target === 'reports'));
  });
  if (!state.user) return;
  if (!state.company && !NO_COMPANY_NEEDED.has(name)) { view.innerHTML = '<p>No company in this sandbox.</p>'; return; }
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await (routes[name] || renderDashboard)(...params);
  } catch (err) {
    view.innerHTML = `<div class="panel"><strong>Something went wrong.</strong><p>${esc(err.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);

async function renderDashboard() {
  const c = state.company;
  const [employees, runs] = await Promise.all([wsApi(`/companies/${c.id}/employees`), wsApi(`/companies/${c.id}/runs`)]);
  const active = employees.filter((e) => e.status === 'active');
  const last = runs.find((r) => r.status === 'finalized');
  view.innerHTML = `
    <h1>${esc(c.name)}</h1>
    <div class="cards">
      <div class="card"><div class="label">Active employees</div><div class="value">${active.length}</div></div>
      <div class="card"><div class="label">Full-time / Part-time</div><div class="value">${active.filter((e) => e.employment_type === 'FT').length} / ${active.filter((e) => e.employment_type === 'PT').length}</div></div>
      <div class="card"><div class="label">Pay frequency</div><div class="value">${FREQ_LABEL[c.pay_frequency]}</div></div>
      <div class="card"><div class="label">Last payroll net</div><div class="value">${last ? money(last.totals.net) : '—'}</div></div>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">Company</h2>
      <p>${esc(c.address.line1)}, ${esc(c.address.city)}, ${c.state} ${esc(c.address.zip)} · FEIN ${esc(c.fein)} · Simulating <strong>${esc(c.payroll_provider)}</strong></p>
      <div class="actions"><a class="btn" href="#/payroll">Start a payroll</a><a class="btn secondary" href="#/employees">View employees</a></div>
    </div>
    <h2>Recent payrolls</h2>
    ${runsTable(runs.slice(0, 5))}`;
}

function runsTable(runs) {
  if (!runs.length) return '<p class="muted">No payrolls yet.</p>';
  return `<div class="table-wrap"><table>
    <tr><th>Run</th><th>Type</th><th>Status</th><th>Period</th><th>Check date</th><th class="num">Checks</th><th class="num">Gross</th><th class="num">Net</th></tr>
    ${runs.map((r) => `<tr class="clickable" onclick="location.hash='#/run/${r.id}'">
      <td>#${r.id}</td><td><span class="badge ${r.run_type}">${r.run_type === 'mock' ? 'Mock' : 'Full'}</span></td>
      <td><span class="badge ${r.status}">${r.status}</span></td><td>${r.period_start} – ${r.period_end}</td><td>${r.check_date}</td>
      <td class="num">${r.totals.count ?? '—'}</td><td class="num">${r.totals.gross != null ? money(r.totals.gross) : '—'}</td>
      <td class="num">${r.totals.net != null ? money(r.totals.net) : '—'}</td></tr>`).join('')}
  </table></div>`;
}

async function renderEmployees() {
  const employees = await wsApi(`/companies/${state.company.id}/employees`);
  view.innerHTML = `
    <h1>Employees</h1>
    <div class="actions">
      <input id="emp-search" placeholder="Search name or ID">
      <button id="add-emp">Add employee</button>
    </div>
    <div class="table-wrap"><table id="emp-table">
      <tr><th>ID</th><th>Name</th><th>Status</th><th>Type</th><th>Pay</th><th>W-4</th><th>Email</th><th>Phone</th><th>SSN</th></tr>
      ${employees.map((e) => `<tr class="clickable" data-q="${esc(`${e.employee_number} ${e.first_name} ${e.last_name}`.toLowerCase())}" onclick="location.hash='#/employee/${e.id}'">
        <td>${esc(e.employee_number)}</td><td>${esc(e.last_name)}, ${esc(e.first_name)}</td><td>${e.status}</td><td>${e.employment_type}</td>
        <td>${e.pay_type === 'salary' ? `${dollars(e.pay_rate)}/yr` : `${dollars(e.pay_rate)}/hr`}</td><td>${esc(e.w4.filingStatus)}</td>
        <td>${esc(e.email)}</td><td>${esc(e.phone)}</td><td>${maskSsn(e.ssn)}</td></tr>`).join('')}
    </table></div>`;
  $('#emp-search').addEventListener('input', (ev) => {
    const q = ev.target.value.toLowerCase();
    view.querySelectorAll('#emp-table tr[data-q]').forEach((tr) => { tr.style.display = tr.dataset.q.includes(q) ? '' : 'none'; });
  });
  $('#add-emp').addEventListener('click', () => { location.hash = '#/employee/new'; });
}

function employeeForm(e) {
  const a = e.address || {};
  const w4 = e.w4 || {};
  const sw4 = e.state_w4 || {};
  const field = (label, name, value, type = 'text') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value ?? '')}"></label>`;
  const select = (label, name, value, options) => `<label>${label}<select name="${name}">${Object.entries(options)
    .map(([v, l]) => `<option value="${v}" ${String(value) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  return `
    <div class="panel"><h2 style="margin-top:0">Personal</h2><div class="form-grid">
      ${field('Employee ID', 'employee_number', e.employee_number)}
      ${field('First name', 'first_name', e.first_name)}${field('Last name', 'last_name', e.last_name)}
      ${field('SSN', 'ssn', e.ssn)}${field('Date of birth', 'birth_date', e.birth_date, 'date')}
      ${field('Email', 'email', e.email, 'email')}${field('Phone', 'phone', e.phone)}
      ${field('Street', 'address.line1', a.line1)}${field('City', 'address.city', a.city)}
      ${field('State', 'address.state', a.state)}${field('ZIP', 'address.zip', a.zip)}
    </div></div>
    <div class="panel"><h2 style="margin-top:0">Employment &amp; pay</h2><div class="form-grid">
      ${field('Hire date', 'hire_date', e.hire_date, 'date')}${field('Termination date', 'termination_date', e.termination_date, 'date')}
      ${select('Status', 'status', e.status || 'active', { active: 'Active', leave: 'Leave', terminated: 'Terminated' })}
      ${select('Employment type', 'employment_type', e.employment_type || 'FT', { FT: 'Full-time', PT: 'Part-time' })}
      ${select('Pay type', 'pay_type', e.pay_type || 'hourly', { hourly: 'Hourly', salary: 'Salary' })}
      ${field('Rate (hourly) or annual salary', 'pay_rate', e.pay_rate, 'number')}
      ${field('Standard weekly hours', 'standard_hours', e.standard_hours ?? 40, 'number')}
      ${select('Work state', 'work_state', e.work_state || state.company.state, { NY: 'New York', NJ: 'New Jersey', CA: 'California' })}
    </div></div>
    <div class="panel"><h2 style="margin-top:0">Federal W-4 (2020+)</h2><div class="form-grid">
      ${select('Filing status (Step 1c)', 'w4.filingStatus', w4.filingStatus || 'single', { single: 'Single or Married filing separately', married: 'Married filing jointly', head: 'Head of household' })}
      ${select('Multiple jobs (Step 2)', 'w4.step2Checked', String(!!w4.step2Checked), { false: 'Not checked', true: 'Checked' })}
      ${field('Dependents credit (Step 3) $', 'w4.dependentsCredit', w4.dependentsCredit || 0, 'number')}
      ${field('Other income (Step 4a) $', 'w4.otherIncome', w4.otherIncome || 0, 'number')}
      ${field('Deductions (Step 4b) $', 'w4.deductions', w4.deductions || 0, 'number')}
      ${field('Extra withholding (Step 4c) $', 'w4.extraWithholding', w4.extraWithholding || 0, 'number')}
    </div>
    <h2>State withholding</h2><div class="form-grid">
      ${select('State filing status', 'state_w4.filingStatus', sw4.filingStatus || 'single', { single: 'Single', married: 'Married' })}
      ${field('Allowances', 'state_w4.allowances', sw4.allowances ?? 0, 'number')}
      ${field('Extra state withholding $', 'state_w4.extraWithholding', sw4.extraWithholding || 0, 'number')}
    </div></div>`;
}

function readEmployeeForm(form) {
  const out = { address: {}, w4: {}, state_w4: {} };
  const numeric = new Set(['pay_rate', 'standard_hours', 'w4.dependentsCredit', 'w4.otherIncome', 'w4.deductions', 'w4.extraWithholding', 'state_w4.allowances', 'state_w4.extraWithholding']);
  for (const el of form.querySelectorAll('[name]')) {
    let value = el.value === '' ? null : el.value;
    if (numeric.has(el.name) && value != null) value = Number(value);
    if (el.name === 'w4.step2Checked') value = value === 'true';
    const [group, key] = el.name.split('.');
    if (key) out[group][key] = value; else out[group] = value;
  }
  return out;
}

async function renderEmployee(id, tab = 'profile') {
  const isNew = id === 'new';
  const employees = isNew ? [] : await wsApi(`/companies/${state.company.id}/employees`);
  const emp = isNew ? {} : employees.find((e) => e.id === Number(id));
  if (!isNew && !emp) throw new Error('Employee not found in this company');
  const tabs = isNew ? '' : `<div class="tabs">
      <a href="#/employee/${id}/profile" class="${tab === 'profile' ? 'active' : ''}">Profile</a>
      <a href="#/employee/${id}/deductions" class="${tab === 'deductions' ? 'active' : ''}">Deductions</a>
      <a href="#/employee/${id}/paychecks" class="${tab === 'paychecks' ? 'active' : ''}">Pay history</a></div>`;
  const title = isNew ? 'New employee' : `${esc(emp.first_name)} ${esc(emp.last_name)} <span class="muted">#${esc(emp.employee_number)}</span>`;

  if (tab === 'deductions') return renderEmployeeDeductions(emp, title, tabs);
  if (tab === 'paychecks') return renderEmployeePaychecks(emp, title, tabs);

  view.innerHTML = `<h1>${title}</h1>${tabs}<form id="emp-form">${employeeForm(emp)}
    <div class="actions"><button type="submit">${isNew ? 'Create employee' : 'Save changes'}</button><a href="#/employees">Cancel</a></div></form>`;
  $('#emp-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = readEmployeeForm(ev.target);
    if (isNew) {
      const created = await wsApi(`/companies/${state.company.id}/employees`, { method: 'POST', body });
      toast('Employee created');
      location.hash = `#/employee/${created.id}`;
    } else {
      await wsApi(`/employees/${id}`, { method: 'PATCH', body });
      toast('Saved');
    }
  });
}

async function renderEmployeeDeductions(emp, title, tabs) {
  const [codes, assigned] = await Promise.all([
    wsApi(`/companies/${state.company.id}/deduction-codes`),
    wsApi(`/employees/${emp.id}/deductions`),
  ]);
  const byCode = Object.fromEntries(assigned.map((d) => [d.deduction_code_id, d]));
  view.innerHTML = `<h1>${title}</h1>${tabs}
    <p class="muted">Amounts are per paycheck. Use a negative amount for a negative deduction (for example BPT). Percent applies to taxable gross.</p>
    <div class="table-wrap"><table>
      <tr><th>Code</th><th>Description</th><th>Tax treatment</th><th>Amount $</th><th>Percent %</th><th>Active</th><th></th></tr>
      ${codes.map((c) => {
        const d = byCode[c.id] || {};
        return `<tr data-code="${c.id}"><td><strong>${esc(c.code)}</strong></td><td>${esc(c.label)}</td><td>${KIND_LABEL[c.kind]}</td>
          <td><input class="small" name="amount" type="number" step="0.01" value="${d.amount ?? ''}"></td>
          <td><input class="small" name="percent" type="number" step="0.01" value="${d.percent ?? ''}"></td>
          <td><input name="active" type="checkbox" ${d.active ? 'checked' : ''}></td>
          <td><button class="secondary save-ded">Save</button></td></tr>`;
      }).join('')}
    </table></div>`;
  view.querySelectorAll('.save-ded').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    const amount = $('[name=amount]', tr).value;
    const percent = $('[name=percent]', tr).value;
    await wsApi(`/employees/${emp.id}/deductions/${tr.dataset.code}`, {
      method: 'PUT',
      body: { amount: amount === '' ? null : Number(amount), percent: percent === '' ? null : Number(percent), active: $('[name=active]', tr).checked },
    });
    toast('Deduction saved');
  }));
}

async function renderEmployeePaychecks(emp, title, tabs) {
  const runs = await wsApi(`/companies/${state.company.id}/runs`);
  const rows = [];
  for (const run of runs.filter((r) => r.status !== 'draft')) {
    const register = await wsApi(`/runs/${run.id}/register`);
    const mine = register.find((r) => r.employee_number === emp.employee_number);
    if (mine?.detail) rows.push({ run, check: mine });
  }
  view.innerHTML = `<h1>${title}</h1>${tabs}
    ${rows.length ? `<div class="table-wrap"><table><tr><th>Check date</th><th>Run</th><th>Check #</th><th class="num">Gross</th><th class="num">Taxes</th><th class="num">Net</th></tr>
      ${rows.map(({ run, check }) => `<tr class="clickable" onclick="location.hash='#/paycheck/${check.id}'"><td>${run.check_date}</td>
        <td><span class="badge ${run.run_type}">${run.run_type}</span> #${run.id}</td><td>${check.check_number ?? '—'}</td>
        <td class="num">${money(check.detail.grossPay)}</td><td class="num">${money(check.detail.totalTaxes)}</td><td class="num">${money(check.detail.netPay)}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">No paychecks yet.</p>'}`;
}

async function renderSetup(tab = 'earnings') {
  const c = state.company;
  const tabs = `<div class="tabs"><a href="#/setup/earnings" class="${tab === 'earnings' ? 'active' : ''}">Earnings</a>
    <a href="#/setup/deductions" class="${tab === 'deductions' ? 'active' : ''}">Deductions</a></div>`;
  if (tab === 'deductions') {
    const codes = await wsApi(`/companies/${c.id}/deduction-codes`);
    view.innerHTML = `<h1>Earnings &amp; Deductions</h1>${tabs}
      <div class="table-wrap"><table><tr><th>Code</th><th>Description</th><th>Tax treatment</th><th>Category</th></tr>
        ${codes.map((d) => `<tr><td><strong>${esc(d.code)}</strong></td><td>${esc(d.label)}</td><td>${KIND_LABEL[d.kind]}</td><td>${d.category}</td></tr>`).join('')}
      </table></div>
      <div class="panel" style="margin-top:16px"><h2 style="margin-top:0">Create deduction</h2>
        <form id="ded-form" class="form-grid">
          <label>Code<input name="code" required maxlength="10" placeholder="e.g. FGH"></label>
          <label>Description<input name="label" required placeholder="e.g. First Gen Health Plan"></label>
          <label>Medical Section 125?<select name="is125"><option value="yes">Yes, Section 125 medical</option><option value="no">No</option></select></label>
          <label>Tax treatment<select name="kind">
            <option value="section125">Pre-tax (exempt from federal, FICA, state*)</option>
            <option value="retirement">Pre-tax retirement (exempt from income tax only)</option>
            <option value="posttax">Post-tax</option><option value="garnishment">Garnishment</option></select></label>
          <label>Category<select name="category">${['medical', 'dental', 'vision', 'program', 'retirement', 'loan', 'garnishment', 'other'].map((x) => `<option>${x}</option>`).join('')}</select></label>
          <div style="align-self:end"><button type="submit">Create deduction</button></div>
        </form>
        <p class="muted">* New Jersey does not exempt Section 125 deductions from state income tax. The calculator applies that automatically for NJ employees.</p>
      </div>`;
    $('#ded-form [name=is125]').addEventListener('change', (ev) => {
      const yes = ev.target.value === 'yes';
      $('#ded-form [name=kind]').value = yes ? 'section125' : 'posttax';
      if (yes) $('#ded-form [name=category]').value = 'medical';
    });
    $('#ded-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      if (f.get('is125') === 'yes' && f.get('kind') !== 'section125') { toast('A Section 125 medical deduction must be pre-tax Section 125'); return; }
      await wsApi(`/companies/${c.id}/deduction-codes`, { method: 'POST', body: { code: f.get('code').toUpperCase(), label: f.get('label'), kind: f.get('kind'), category: f.get('category') } });
      toast('Deduction created');
      renderSetup('deductions');
    });
    return;
  }
  const codes = await wsApi(`/companies/${c.id}/earning-codes`);
  view.innerHTML = `<h1>Earnings &amp; Deductions</h1>${tabs}
    <div class="table-wrap"><table><tr><th>Code</th><th>Description</th><th>Category</th><th>Taxable</th></tr>
      ${codes.map((e) => `<tr><td><strong>${esc(e.code)}</strong></td><td>${esc(e.label)}</td><td>${e.category}</td><td>${e.taxable ? 'Taxable' : '<span class="badge">Non-taxable</span>'}</td></tr>`).join('')}
    </table></div>
    <div class="panel" style="margin-top:16px"><h2 style="margin-top:0">Create earning</h2>
      <form id="earn-form" class="form-grid">
        <label>Code<input name="code" required maxlength="10" placeholder="e.g. BPT"></label>
        <label>Description<input name="label" required placeholder="e.g. Benefits Payment"></label>
        <label>Category<select name="category">${['reimbursement', 'regular', 'overtime', 'bonus', 'commission', 'other'].map((x) => `<option>${x}</option>`).join('')}</select></label>
        <label>Taxability<select name="taxable"><option value="false">Non-taxable</option><option value="true">Taxable</option></select></label>
        <div style="align-self:end"><button type="submit">Create earning</button></div>
      </form></div>`;
  $('#earn-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    await wsApi(`/companies/${c.id}/earning-codes`, { method: 'POST', body: { code: f.get('code').toUpperCase(), label: f.get('label'), category: f.get('category'), taxable: f.get('taxable') === 'true' } });
    toast('Earning created');
    renderSetup('earnings');
  });
}

function nextPeriod(freq) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const days = { weekly: 6, biweekly: 13, semimonthly: 14, monthly: 29 }[freq];
  const start = new Date(today); start.setDate(today.getDate() - days - 3);
  const end = new Date(start); end.setDate(start.getDate() + days);
  const check = new Date(end); check.setDate(end.getDate() + 5);
  return { periodStart: iso(start), periodEnd: iso(end), checkDate: iso(check) };
}

async function renderPayroll() {
  const c = state.company;
  const runs = await wsApi(`/companies/${c.id}/runs`);
  const p = nextPeriod(c.pay_frequency);
  view.innerHTML = `<h1>Run Payroll</h1>
    <div class="panel"><h2 style="margin-top:0">Start a new payroll</h2>
      <form id="run-form" class="form-grid">
        <label>Run type<select name="runType"><option value="mock">Mock run (preview only, never affects YTD)</option><option value="full">Full run</option></select></label>
        <label>Period start<input name="periodStart" type="date" value="${p.periodStart}" required></label>
        <label>Period end<input name="periodEnd" type="date" value="${p.periodEnd}" required></label>
        <label>Check date<input name="checkDate" type="date" value="${p.checkDate}" required></label>
        <div style="align-self:end"><button type="submit">Create payroll</button></div>
      </form></div>
    <h2>Payroll history</h2>${runsTable(runs)}`;
  $('#run-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const run = await wsApi(`/companies/${c.id}/runs`, { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) });
    location.hash = `#/run/${run.id}`;
  });
}

async function renderRun(id) {
  const runs = await wsApi(`/companies/${state.company.id}/runs`);
  const run = runs.find((r) => r.id === Number(id));
  if (!run) throw new Error('Run not found for this company');
  const [register, earningCodes] = await Promise.all([wsApi(`/runs/${id}/register`), wsApi(`/companies/${state.company.id}/earning-codes`)]);
  const editable = run.status !== 'finalized';
  const extraCodes = earningCodes.filter((e) => !['REG', 'OT'].includes(e.code));
  const t = run.totals;
  view.innerHTML = `<h1>Payroll #${run.id} <span class="badge ${run.run_type}">${run.run_type === 'mock' ? 'Mock run' : 'Full run'}</span> <span class="badge ${run.status}">${run.status}</span></h1>
    <p class="muted">Period ${run.period_start} – ${run.period_end} · Check date ${run.check_date}</p>
    ${t.count ? `<div class="cards">
      <div class="card"><div class="label">Gross pay</div><div class="value">${money(t.gross)}</div></div>
      <div class="card"><div class="label">Pre-tax deductions</div><div class="value">${money(t.preTax)}</div></div>
      <div class="card"><div class="label">Employee taxes</div><div class="value">${money(t.taxes)}</div></div>
      <div class="card"><div class="label">Post-tax deductions</div><div class="value">${money(t.postTax)}</div></div>
      <div class="card"><div class="label">Net pay</div><div class="value">${money(t.net)}</div></div>
      <div class="card"><div class="label">Employer taxes</div><div class="value">${money(t.employerTaxes)}</div></div>
      <div class="card"><div class="label">Warnings</div><div class="value">${t.warnings ? `<span class="badge warn">${t.warnings}</span>` : '0'}</div></div>
    </div>` : ''}
    <div class="actions">
      ${editable ? '<button id="calc">Calculate</button>' : ''}
      ${editable && run.run_type === 'full' && run.status === 'calculated' ? '<button id="finalize" class="secondary">Finalize &amp; issue checks</button>' : ''}
      ${editable ? '<button id="delete" class="danger">Delete run</button>' : ''}
      <a class="btn secondary" href="#/reports/register/${run.id}">Check register</a>
      <a class="btn secondary" href="#/reports/summary/${run.id}">Payroll summary</a>
    </div>
    <div class="table-wrap"><table>
      <tr><th>Employee</th><th>Type</th><th>Hours</th><th>OT hours</th><th>Other earning</th><th>Amount</th><th class="num">Gross</th><th class="num">Net</th><th></th></tr>
      ${register.map((r) => {
        const extra = (r.inputs.extra || [])[0] || {};
        return `<tr data-id="${r.id}"><td>${esc(r.last_name)}, ${esc(r.first_name)} <span class="muted">#${esc(r.employee_number)}</span></td><td>${r.employment_type}</td>
        <td><input class="small" name="hours" type="number" step="0.01" value="${r.inputs.hours ?? ''}" placeholder="std" ${editable ? '' : 'disabled'}></td>
        <td><input class="small" name="overtimeHours" type="number" step="0.01" value="${r.inputs.overtimeHours ?? ''}" ${editable ? '' : 'disabled'}></td>
        <td><select name="extraCode" ${editable ? '' : 'disabled'}><option value="">—</option>${extraCodes.map((e) => `<option value="${e.code}" ${extra.code === e.code ? 'selected' : ''}>${esc(e.code)}</option>`).join('')}</select></td>
        <td><input class="small" name="extraAmount" type="number" step="0.01" value="${extra.amount ?? ''}" ${editable ? '' : 'disabled'}></td>
        <td class="num">${r.detail ? money(r.detail.grossPay) : '—'}</td><td class="num">${r.detail ? money(r.detail.netPay) : '—'}</td>
        <td>${r.detail ? `<a href="#/paycheck/${r.id}">Paycheck</a>` : ''} ${r.detail?.warnings.length ? `<span class="badge warn">${r.detail.warnings.join(', ')}</span>` : ''}</td></tr>`;
      }).join('')}
    </table></div>
    <p class="muted">Leave hours blank to use each employee's standard hours. Salaried employees ignore hours.</p>`;

  async function saveInputs() {
    for (const tr of view.querySelectorAll('tr[data-id]')) {
      const num = (name) => { const v = $(`[name=${name}]`, tr).value; return v === '' ? undefined : Number(v); };
      const code = $('[name=extraCode]', tr).value;
      const inputs = { hours: num('hours'), overtimeHours: num('overtimeHours'), extra: code && num('extraAmount') ? [{ code, amount: num('extraAmount') }] : [] };
      await wsApi(`/paychecks/${tr.dataset.id}/inputs`, { method: 'PUT', body: inputs });
    }
  }
  $('#calc')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    await saveInputs();
    await wsApi(`/runs/${id}/calculate`, { method: 'POST' });
    toast('Payroll calculated');
    renderRun(id);
  });
  $('#finalize')?.addEventListener('click', async () => {
    if (!confirm('Finalize this payroll? Checks are issued and YTD totals update. This cannot be undone.')) return;
    await wsApi(`/runs/${id}/finalize`, { method: 'POST' });
    toast('Payroll finalized');
    renderRun(id);
  });
  $('#delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this payroll run?')) return;
    await wsApi(`/runs/${id}`, { method: 'DELETE' });
    location.hash = '#/payroll';
  });
}

async function renderReports(kind, runId) {
  const runs = (await wsApi(`/companies/${state.company.id}/runs`)).filter((r) => r.status !== 'draft');
  const selected = runs.find((r) => r.id === Number(runId)) || runs[0];
  kind = kind || 'register';
  const picker = `<div class="tabs"><a href="#/reports/register/${selected?.id ?? ''}" class="${kind === 'register' ? 'active' : ''}">Check register</a>
    <a href="#/reports/summary/${selected?.id ?? ''}" class="${kind === 'summary' ? 'active' : ''}">Payroll summary</a></div>
    <div class="actions"><label>Payroll <select id="run-pick">${runs.map((r) => `<option value="${r.id}" ${r.id === selected?.id ? 'selected' : ''}>#${r.id} ${r.run_type} · ${r.check_date} · ${r.status}</option>`).join('')}</select></label>
    <button class="secondary" onclick="window.print()">Print</button></div>`;
  if (!selected) { view.innerHTML = '<h1>Reports</h1><p class="muted">Calculate a payroll first.</p>'; return; }
  const register = await wsApi(`/runs/${selected.id}/register`);
  const rows = register.filter((r) => r.detail);

  if (kind === 'summary') {
    const totals = {};
    const add = (group, line) => {
      totals[group] = totals[group] || {};
      const key = `${line.code}|${line.label}`;
      totals[group][key] = (totals[group][key] || 0) + line.amount;
    };
    for (const r of rows) {
      r.detail.earnings.forEach((l) => add('Earnings', l));
      r.detail.preTaxDeductions.forEach((l) => add('Pre-tax deductions', l));
      r.detail.taxes.forEach((l) => add('Employee taxes', l));
      r.detail.postTaxDeductions.forEach((l) => add('Post-tax deductions', l));
      r.detail.employerTaxes.forEach((l) => add('Employer taxes', l));
    }
    const t = selected.totals;
    view.innerHTML = `<h1>Payroll Summary</h1>${picker}
      <div class="panel"><strong>${esc(state.company.name)}</strong> · Payroll #${selected.id} (${selected.run_type}) · Check date ${selected.check_date} · ${rows.length} checks</div>
      ${Object.entries(totals).map(([group, lines]) => `<h2>${group}</h2><div class="table-wrap"><table><tr><th>Code</th><th>Description</th><th class="num">Amount</th></tr>
        ${Object.entries(lines).map(([key, amt]) => { const [code, label] = key.split('|'); return `<tr><td>${esc(code)}</td><td>${esc(label)}</td><td class="num">${money(amt)}</td></tr>`; }).join('')}
        <tr><th colspan="2">Total</th><th class="num">${money(Object.values(lines).reduce((a, b) => a + b, 0))}</th></tr></table></div>`).join('')}
      <h2>Cash requirement</h2><div class="table-wrap"><table>
        <tr><td>Net pay (direct deposit / checks)</td><td class="num">${money(t.net)}</td></tr>
        <tr><td>Employee taxes</td><td class="num">${money(t.taxes)}</td></tr>
        <tr><td>Employer taxes</td><td class="num">${money(t.employerTaxes)}</td></tr>
        <tr><th>Total employer cash required</th><th class="num">${money(t.net + t.taxes + t.employerTaxes)}</th></tr></table></div>`;
  } else {
    const taxCodes = [...new Set(rows.flatMap((r) => r.detail.taxes.map((x) => x.code)))];
    view.innerHTML = `<h1>Check Register</h1>${picker}
      <div class="table-wrap"><table>
        <tr><th>Check #</th><th>Employee</th><th class="num">Gross</th><th class="num">Pre-tax</th>${taxCodes.map((c) => `<th class="num">${c}</th>`).join('')}<th class="num">Post-tax</th><th class="num">Net</th></tr>
        ${rows.map((r) => {
          const d = r.detail;
          const tax = Object.fromEntries(d.taxes.map((x) => [x.code, x.amount]));
          return `<tr class="clickable" onclick="location.hash='#/paycheck/${r.id}'"><td>${r.check_number ?? (selected.run_type === 'mock' ? 'MOCK' : '—')}</td>
            <td>${esc(r.last_name)}, ${esc(r.first_name)}</td><td class="num">${money(d.grossPay)}</td>
            <td class="num">${money(d.preTaxDeductions.reduce((a, b) => a + b.amount, 0))}</td>
            ${taxCodes.map((c) => `<td class="num">${money(tax[c] || 0)}</td>`).join('')}
            <td class="num">${money(d.postTaxDeductions.reduce((a, b) => a + b.amount, 0))}</td><td class="num"><strong>${money(d.netPay)}</strong></td></tr>`;
        }).join('')}
        <tr><th></th><th>Totals</th><th class="num">${money(selected.totals.gross)}</th><th class="num">${money(selected.totals.preTax)}</th>
          ${taxCodes.map((c) => `<th class="num">${money(rows.reduce((a, r) => a + (r.detail.taxes.find((x) => x.code === c)?.amount || 0), 0))}</th>`).join('')}
          <th class="num">${money(selected.totals.postTax)}</th><th class="num">${money(selected.totals.net)}</th></tr>
      </table></div>`;
  }
  $('#run-pick').addEventListener('change', (ev) => { location.hash = `#/reports/${kind}/${ev.target.value}`; });
}

async function renderPaycheck(id) {
  const p = await wsApi(`/paychecks/${id}`);
  const d = p.detail;
  if (!d) throw new Error('This paycheck has not been calculated yet');
  const e = p.employee;
  const lines = (items, cols) => items.map((l) => `<tr>${cols(l)}</tr>`).join('');
  const total = (items) => items.reduce((a, b) => a + b.amount, 0);
  view.innerHTML = `
    <div class="actions"><button class="secondary" onclick="history.back()">Back</button><button onclick="window.print()">Print</button>
      ${p.run.run_type === 'mock' ? '<span class="badge mock">MOCK — not a real check</span>' : ''}</div>
    <div class="stub">
      <header><div><strong>${esc(p.company.name)}</strong><br>${esc(p.company.address.line1)}<br>${esc(p.company.address.city)}, ${p.company.state} ${esc(p.company.address.zip)}<br><span class="muted">FEIN ${esc(p.company.fein)}</span></div>
        <div style="text-align:right">Earnings Statement<br>Check # ${p.check_number ?? (p.run.run_type === 'mock' ? 'MOCK' : 'Pending')}<br>Period ${p.run.period_start} – ${p.run.period_end}<br>Pay date ${p.run.check_date}</div></header>
      <div class="grid2">
        <div><strong>${esc(e.first_name)} ${esc(e.last_name)}</strong><br>${esc(e.address.line1)}<br>${esc(e.address.city)}, ${esc(e.address.state)} ${esc(e.address.zip)}<br>
          <span class="muted">Employee ID ${esc(e.employee_number)} · SSN ${maskSsn(e.ssn)}</span></div>
        <div class="muted">Federal: ${esc(e.w4.filingStatus)}${e.w4.step2Checked ? ', Step 2 checked' : ''}${e.w4.dependentsCredit ? `, dependents ${dollars(e.w4.dependentsCredit)}` : ''}<br>
          ${e.work_state}: ${esc(e.state_w4.filingStatus)}, ${e.state_w4.allowances ?? 0} allowances<br>
          Taxable wages: Federal ${money(d.wageBases.federal)} · FICA ${money(d.wageBases.fica)} · State ${money(d.wageBases.state)}</div>
      </div>
      <div class="grid2" style="margin-top:14px">
        <div><table><tr><th>Earnings</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Current</th></tr>
          ${lines(d.earnings, (l) => `<td>${esc(l.label || l.code)}${l.taxable === false ? ' <span class="badge">non-taxable</span>' : ''}</td><td class="num">${l.hours ?? ''}</td><td class="num">${l.rate != null ? dollars(l.rate) : ''}</td><td class="num">${money(l.amount)}</td>`)}
          <tr><th colspan="3">Gross pay</th><th class="num">${money(d.grossPay)}</th></tr></table>
          <h2>Pre-tax deductions</h2><table>${lines(d.preTaxDeductions, (l) => `<td>${esc(l.code)} ${esc(l.label)}</td><td class="num">${money(l.amount)}</td>`) || '<tr><td class="muted">None</td></tr>'}</table>
        </div>
        <div><table><tr><th>Taxes</th><th class="num">Current</th></tr>
          ${lines(d.taxes, (l) => `<td>${esc(l.label)}</td><td class="num">${money(l.amount)}</td>`)}
          <tr><th>Total taxes</th><th class="num">${money(d.totalTaxes)}</th></tr></table>
          <h2>Post-tax deductions</h2><table>${lines(d.postTaxDeductions, (l) => `<td>${esc(l.code)} ${esc(l.label)}</td><td class="num">${money(l.amount)}</td>`) || '<tr><td class="muted">None</td></tr>'}
          ${d.postTaxDeductions.length ? `<tr><th>Total</th><th class="num">${money(total(d.postTaxDeductions))}</th></tr>` : ''}</table>
        </div>
      </div>
      <div class="net">Net pay ${money(d.netPay)}</div>
      ${d.warnings.length ? `<p><span class="badge warn">${d.warnings.join(', ')}</span></p>` : ''}
      <div class="check"><div>Pay to the order of<br><strong>${esc(e.first_name)} ${esc(e.last_name)}</strong></div><div style="text-align:right">${p.run.check_date}<br><strong>${money(d.netPay)}</strong><br><span class="muted">NON-NEGOTIABLE · TRAINING</span></div></div>
    </div>`;
}

async function renderImport() {
  const c = state.company;
  view.innerHTML = `<h1>Import / Census</h1>
    <div class="panel"><h2 style="margin-top:0">Generate fake employees</h2>
      <p class="muted">Creates realistic, fictitious ${c.state} employees.</p>
      <div class="actions"><input id="gen-count" class="small" type="number" value="10" min="1" max="200"><button id="gen">Generate &amp; add</button></div></div>
    <div class="panel"><h2 style="margin-top:0">Import a census CSV</h2>
      <p class="muted">Columns: employee_number, first_name, last_name, email, phone, ssn, birth_date, hire_date, address_line1, city, state, zip, employment_type (FT/PT), pay_type (hourly/salary), pay_rate, standard_hours, filing_status (single/married/head)</p>
      <div class="actions"><input id="csv-file" type="file" accept=".csv,text/csv"><button id="csv-import">Import</button>
        <a class="btn secondary" id="csv-template" download="census-template.csv">Download template</a></div>
      <div id="import-result"></div></div>`;
  const header = 'employee_number,first_name,last_name,email,phone,ssn,birth_date,hire_date,address_line1,city,state,zip,employment_type,pay_type,pay_rate,standard_hours,filing_status';
  $('#csv-template').href = `data:text/csv,${encodeURIComponent(`${header}\n2001,Jane,Sample,jane@example.com,(555) 010-0000,123-45-6789,1990-04-02,2024-01-08,1 Main St,Brooklyn,${c.state},11201,FT,hourly,22.50,40,single\n`)}`;
  $('#gen').addEventListener('click', async () => {
    const rows = await wsApi(`/companies/${c.id}/census/generate?count=${$('#gen-count').value}`);
    const existing = await wsApi(`/companies/${c.id}/employees`);
    let next = Math.max(1000, ...existing.map((e) => Number(e.employee_number) || 0)) + 1;
    for (const row of rows) await wsApi(`/companies/${c.id}/employees`, { method: 'POST', body: { ...row, employee_number: String(next++) } });
    toast(`${rows.length} employees added`);
  });
  $('#csv-import').addEventListener('click', async () => {
    const file = $('#csv-file').files[0];
    if (!file) return toast('Choose a CSV file first');
    const rows = parseCsv(await file.text());
    let ok = 0;
    const errors = [];
    for (const [i, r] of rows.entries()) {
      try {
        await wsApi(`/companies/${c.id}/employees`, { method: 'POST', body: {
          employee_number: r.employee_number, first_name: r.first_name, last_name: r.last_name, email: r.email, phone: r.phone, ssn: r.ssn,
          birth_date: r.birth_date || null, hire_date: r.hire_date || null,
          address: { line1: r.address_line1, city: r.city, state: r.state, zip: r.zip },
          employment_type: (r.employment_type || 'FT').toUpperCase(), pay_type: (r.pay_type || 'hourly').toLowerCase(),
          pay_rate: Number(r.pay_rate), standard_hours: Number(r.standard_hours || 40), work_state: c.state,
          w4: { filingStatus: r.filing_status || 'single' }, state_w4: { filingStatus: r.filing_status === 'married' ? 'married' : 'single' },
        } });
        ok++;
      } catch (err) { errors.push(`Row ${i + 2}: ${err.message}`); }
    }
    $('#import-result').innerHTML = `<p><strong>${ok}</strong> imported${errors.length ? `, ${errors.length} failed` : ''}.</p>${errors.map((e) => `<div class="muted">${esc(e)}</div>`).join('')}`;
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

// ---------- training ----------

async function openWorkspace(id, hash = '#/dashboard') {
  localStorageSet('ws', id);
  await loadWorkspaces();
  location.hash = hash;
  route();
}

async function renderAssignments() {
  const [assignments, scenarios] = await Promise.all([api('/training/assignments?mine=1'), api('/training/scenarios')]);
  const byKey = Object.fromEntries(scenarios.map((s) => [s.key, s]));
  view.innerHTML = `<h1>My Assignments</h1>
    ${assignments.length ? '' : '<p class="muted">Nothing assigned yet. Your trainer will assign scenarios here. You can practice freely in your Practice sandbox.</p>'}
    ${assignments.map((a) => {
      const sc = byKey[a.scenario_key];
      const last = a.last_attempt;
      return `<div class="panel" data-id="${a.id}">
        <h2 style="margin-top:0">${esc(sc?.title || a.scenario_key)} <span class="badge">${esc(sc?.skill || '')}</span>
          ${a.best_score != null ? `<span class="badge ${Number(a.best_score) === 100 ? 'finalized' : 'mock'}">Best ${a.best_score}%</span>` : ''}</h2>
        <p class="muted">${a.due_date ? `Due ${a.due_date} · ` : ''}${a.attempt_count} attempt${a.attempt_count === 1 ? '' : 's'} · ${a.status.replace('_', ' ')}</p>
        <div class="instructions">${sc?.instructions || ''}</div>
        <div class="actions">
          <button class="start">${a.workspace_id ? 'Open sandbox' : 'Start'}</button>
          ${a.workspace_id ? '<button class="secondary submit">Submit for grading</button>' : ''}
        </div>
        ${last ? `<div><span class="score">${last.score}%</span> <span class="muted">last attempt</span>
          <ul>${last.results.map((r) => `<li class="${r.passed ? 'check-pass' : 'check-fail'}">${r.passed ? '✓' : '✗'} ${esc(r.label)} (${r.points} pts)</li>`).join('')}</ul></div>` : ''}
      </div>`;
    }).join('')}`;
  view.querySelectorAll('.start').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.closest('[data-id]').dataset.id;
    const ws = await api(`/training/assignments/${id}/start`, { method: 'POST' });
    toast('Sandbox ready. The instructions stay on My Assignments.');
    openWorkspace(ws.id);
  }));
  view.querySelectorAll('.submit').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.closest('[data-id]').dataset.id;
    const attempt = await api(`/training/assignments/${id}/submit`, { method: 'POST' });
    toast(`Scored ${attempt.score}%`);
    renderAssignments();
  }));
}

async function renderAdmin(tab = 'gradebook') {
  const tabs = ['gradebook', 'assign', 'people', 'classes']
    .map((t) => `<a href="#/admin/${t}" class="${tab === t ? 'active' : ''}">${t[0].toUpperCase()}${t.slice(1)}</a>`).join('');
  const [users, classes, scenarios] = await Promise.all([api('/training/users'), api('/training/classes'), api('/training/scenarios')]);
  const trainees = users.filter((u) => u.role === 'trainee');
  let body = '';

  if (tab === 'gradebook') {
    const assignments = await api('/training/assignments');
    body = `<div class="actions"><label>Class <select id="gb-class"><option value="">All trainees</option>${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label></div>
      <div class="table-wrap"><table id="gb"><tr><th>Trainee</th>${scenarios.map((s) => `<th title="${esc(s.title)}">${esc(s.skill)}</th>`).join('')}<th class="num">Average</th></tr>
      ${trainees.map((u) => {
        const mine = assignments.filter((a) => a.user_id === u.id);
        const scores = mine.filter((a) => a.best_score != null).map((a) => Number(a.best_score));
        return `<tr data-classes="${u.classes.map((c) => c.id).join(',')}"><td>${esc(u.name)}</td>${scenarios.map((s) => {
          const a = mine.find((x) => x.scenario_key === s.key);
          if (!a) return '<td class="muted">—</td>';
          return `<td>${a.best_score != null ? `<strong>${a.best_score}%</strong>` : `<span class="muted">${a.status.replace('_', ' ')}</span>`}
            ${a.workspace_id ? ` <a href="#" data-ws="${a.workspace_id}" class="peek">view</a>` : ''}</td>`;
        }).join('')}<td class="num">${scores.length ? `${(scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(1)}%` : '—'}</td></tr>`;
      }).join('')}</table></div>
      <p class="muted">"view" opens the trainee's sandbox so you can review their work.</p>`;
  } else if (tab === 'assign') {
    body = `<form id="assign-form" class="panel">
        <div class="form-grid">
          <label>Scenario<select name="scenarioKey">${scenarios.map((s) => `<option value="${s.key}">${esc(s.title)} (${esc(s.skill)})</option>`).join('')}</select></label>
          <label>Whole class<select name="classId"><option value="">—</option>${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
          <label>Due date<input name="dueDate" type="date"></label>
        </div>
        <h2>Or pick trainees</h2>
        <div class="form-grid">${trainees.map((u) => `<label style="flex-direction:row;align-items:center;gap:6px;color:var(--ink)"><input type="checkbox" name="user" value="${u.id}"> ${esc(u.name)}</label>`).join('') || '<span class="muted">Add trainees under People first.</span>'}</div>
        <div class="actions"><button type="submit">Assign</button></div>
      </form>
      <h2>Scenarios</h2>${scenarios.map((s) => `<div class="panel"><strong>${esc(s.title)}</strong> <span class="badge">${esc(s.skill)}</span> <span class="muted">${s.checkCount} checks · ${s.points} pts</span><div class="instructions">${s.instructions}</div></div>`).join('')}`;
  } else if (tab === 'people') {
    body = `<form id="person-form" class="panel"><div class="form-grid">
        <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
        <label>Temporary password<input name="password" required minlength="8"></label>
        <label>Role<select name="role"><option value="trainee">Trainee</option><option value="trainer">Trainer</option></select></label>
        <div style="align-self:end"><button type="submit">Add person</button></div></div></form>
      <div class="table-wrap"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Classes</th><th></th></tr>
        ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td><td>${u.classes.map((c) => esc(c.name)).join(', ')}</td>
          <td><button class="secondary pw" data-id="${u.id}">Set password</button></td></tr>`).join('')}</table></div>`;
  } else {
    body = `<form id="class-form" class="panel"><div class="form-grid"><label>New class name<input name="name" required placeholder="e.g. November CS cohort"></label>
        <div style="align-self:end"><button type="submit">Create class</button></div></div></form>
      ${classes.map((c) => `<div class="panel" data-class="${c.id}"><h2 style="margin-top:0">${esc(c.name)}</h2>
        <div class="form-grid">${trainees.map((u) => `<label style="flex-direction:row;align-items:center;gap:6px;color:var(--ink)"><input type="checkbox" value="${u.id}" ${c.member_ids.includes(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div>
        <div class="actions"><button class="secondary save-members">Save members</button></div></div>`).join('')}`;
  }

  view.innerHTML = `<h1>Training Admin</h1><div class="tabs">${tabs}</div>${body}`;

  $('#gb-class')?.addEventListener('change', (ev) => {
    view.querySelectorAll('#gb tr[data-classes]').forEach((tr) => {
      tr.style.display = !ev.target.value || tr.dataset.classes.split(',').includes(ev.target.value) ? '' : 'none';
    });
  });
  view.querySelectorAll('.peek').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openWorkspace(Number(a.dataset.ws)); }));
  $('#assign-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const created = await api('/training/assignments', { method: 'POST', body: {
      scenarioKey: f.get('scenarioKey'), classId: f.get('classId') ? Number(f.get('classId')) : null,
      dueDate: f.get('dueDate') || null, userIds: f.getAll('user').map(Number),
    } });
    toast(`Assigned to ${created.length} trainee${created.length === 1 ? '' : 's'}`);
    ev.target.reset();
  });
  $('#person-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await api('/training/users', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) });
    toast('Person added. Share their email and temporary password with them.');
    renderAdmin('people');
  });
  view.querySelectorAll('.pw').forEach((btn) => btn.addEventListener('click', async () => {
    const password = prompt('New password (8+ characters)');
    if (!password) return;
    await api(`/training/users/${btn.dataset.id}/password`, { method: 'POST', body: { password } });
    toast('Password updated');
  }));
  $('#class-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await api('/training/classes', { method: 'POST', body: { name: new FormData(ev.target).get('name') } });
    renderAdmin('classes');
  });
  view.querySelectorAll('.save-members').forEach((btn) => btn.addEventListener('click', async () => {
    const panel = btn.closest('[data-class]');
    const userIds = [...panel.querySelectorAll('input[type=checkbox]:checked')].map((i) => Number(i.value));
    await api(`/training/classes/${panel.dataset.class}/members`, { method: 'PUT', body: { userIds } });
    toast('Class updated');
  }));
}

// ---------- sign-in ----------

function showAuth(needsSetup = false) {
  state.user = null;
  document.body.classList.add('signed-out');
  const screen = $('#auth-screen');
  screen.hidden = false;
  screen.innerHTML = needsSetup
    ? `<h1>Set up the simulator</h1><p class="muted">Create the first trainer account. You can add trainees after this.</p>
       <form id="auth-form"><label>Your name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
       <label>Password (8+ characters)<input name="password" type="password" minlength="8" required></label><button type="submit">Create trainer account</button></form>`
    : `<h1>Sign in</h1><form id="auth-form"><label>Email<input name="email" type="email" required autocomplete="username"></label>
       <label>Password<input name="password" type="password" required autocomplete="current-password"></label><button type="submit">Sign in</button></form>`;
  $('#auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const { user } = await api(needsSetup ? '/auth/setup' : '/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) });
      await start(user);
    } catch (err) { toast(err.message); }
  });
}

async function start(user) {
  state.user = user;
  document.body.classList.remove('signed-out');
  document.body.classList.toggle('trainer', user.role === 'trainer');
  $('#auth-screen').hidden = true;
  $('#who').textContent = `${user.name} (${user.role})`;
  await loadWorkspaces();
  route();
}

$('#logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  showAuth();
});

api('/auth/status')
  .then(({ user, needsSetup }) => (user ? start(user) : showAuth(needsSetup)))
  .catch((err) => { view.innerHTML = `<p>Could not load: ${esc(err.message)}</p>`; });
