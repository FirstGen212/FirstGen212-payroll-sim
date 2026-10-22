// Payroll simulator front end: a small hash-routed app over the JSON API.

const state = { ws: null, company: null, companies: [], user: null };
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
// Two apps share this code: the payroll system at / and the employer portal at /portal.
const APP = document.body.dataset.app || 'payroll';
// The portal has two audiences, as in the real one: the CS team and a client (employer) user.
const portalAs = () => (APP === 'portal' ? localStorageGet(`portal-as-${state.ws}`) || 'cs' : null);
const asClient = () => portalAs() && portalAs() !== 'cs';
const HOME_OF = () => (APP !== 'portal' ? 'dashboard' : asClient() ? 'c-home' : 'home');
const CS_ROUTES = ['home', 'roster', 'clients', 'client', 'master-census', 'terminated-employees', 'team-tasks', 'task', 'queue', 'csm', 'job', 'calculator',
  'mock-payroll-run', 'activity', 'employee-status-roster', 'census', 'upload', 'monthly-review-block'];
const CLIENT_ROUTES = ['c-home', 'c-roster', 'c-census', 'c-upload'];
const PORTAL_ROUTES = new Set([...CS_ROUTES, ...CLIENT_ROUTES]);
const SHARED_ROUTES = new Set(['assignments', 'admin']);

/** Opens a page of the other app in its own tab, on the same sandbox (and company, for payroll). */
function openOtherApp(app, hash, companyId) {
  if (companyId) localStorageSet(`company-${state.ws}`, companyId);
  window.open(`${app === 'portal' ? '/portal' : '/'}${hash}`, `payrollsim-${app}`);
}
window.openOtherApp = openOtherApp;

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
  location.hash = `#/${HOME_OF()}`;
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
  clients: renderClients,
  client: renderClient,
  queue: renderQueue,
  csm: renderCsmQueue,
  job: renderJob,
  calculator: renderCalculator,
  census: renderCensusInbox,
  upload: renderCensusUpload,
  activity: renderActivity,
  home: renderOpsDashboard,
  roster: renderCsRoster,
  'master-census': renderMasterCensus,
  'terminated-employees': renderStatusChanges,
  'team-tasks': renderTeamTasks,
  task: renderTask,
  'mock-payroll-run': renderMockPage,
  'employee-status-roster': renderStatusRoster,
  'monthly-review-block': renderMonthlyReview,
  'c-home': renderClientHome,
  'c-roster': renderClientRoster,
  'c-census': renderClientCensus,
  'c-upload': renderClientUpload,
};
const NO_COMPANY_NEEDED = new Set(['assignments', 'admin', ...PORTAL_ROUTES]);
const NAV_PARENT = { employee: 'employees', run: 'payroll', paycheck: 'reports', client: 'clients', job: 'queue', calculator: 'csm', upload: 'census', task: 'team-tasks' };

async function route() {
  let [name = HOME_OF(), ...params] = location.hash.replace(/^#\//, '').split('?')[0].split('/').map(decodeURIComponent);
  // Each app only shows its own pages; the other app's links open in its own tab.
  // In the portal, the CS and client views each have their own pages too.
  const viewRoutes = APP !== 'portal' ? null : asClient() ? CLIENT_ROUTES : CS_ROUTES;
  const belongs = SHARED_ROUTES.has(name) || ((APP === 'portal') === PORTAL_ROUTES.has(name) && (!viewRoutes || viewRoutes.includes(name)));
  if (!routes[name] || !belongs) { name = HOME_OF(); params = []; }
  if (APP === 'portal') { document.body.classList.toggle('as-client', asClient()); syncPortalAs(); }
  document.querySelectorAll('.sidenav a').forEach((a) => {
    const target = a.getAttribute('href').slice(2);
    a.classList.toggle('active', target === name || NAV_PARENT[name] === target);
  });
  if (!state.user) return;
  if (!state.company && !NO_COMPANY_NEEDED.has(name)) { view.innerHTML = '<p>No company in this sandbox.</p>'; return; }
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await routes[name](...params);
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
    <div class="panel"><h2 style="margin-top:0">Census (employer portal)</h2><div class="form-grid">
      ${select('Gender', 'gender', e.gender || '', { '': '(missing)', M: 'M', F: 'F' })}
      ${field('Job title', 'job_title', e.job_title)}
      ${field('Location code', 'location_code', e.location_code ?? '1000')}
      ${field('Company code', 'company_code', e.company_code ?? state.company.state)}
      ${field('Go Live Date', 'go_live_date', e.go_live_date, 'date')}
      ${select('Census status', 'census_status', e.census_status || 'Active', Object.fromEntries(['Active', 'Active FT', 'Active PT', 'New hire', 'Ineligible', 'Unenrolled', 'Opted out', 'Terminated'].map((v) => [v, v])))}
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
  const emp = isNew ? {} : await wsApi(`/employees/${id}`);
  if (!isNew && emp.company_id !== state.company.id) {
    // Opened from another client's census: switch the company picker to match.
    state.company = state.companies.find((c) => c.id === emp.company_id) || state.company;
    $('#company-select').value = state.company.id;
  }
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
    <button class="secondary" onclick="window.print()">Print</button>
    ${selected && kind === 'register' ? `<a class="btn secondary" href="/api/w/${state.ws}/runs/${selected.id}/register.csv">Export register (CSV)</a>` : ''}</div>`;
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

// ---------- employer portal ----------

const portalApi = (path, options) => wsApi(`/portal${path}`, options);
const STATUS_ORDER = ['Welcome', 'Payroll Docs', 'Underwriting', 'Awaiting Payroll Confirmation', 'Awaiting CSM Verification', 'Proposal Ready', 'Eligibility Review', 'Engagement Letter', 'AOP Pending', 'Census', 'Completed'];
const PRODUCT_LABEL = { VIRTUAL: 'First Gen Health (virtual)', MEC: 'MEC', DENTAL: 'Dental', VISION: 'Vision' };
const ago = (ts) => { const d = Math.round((Date.now() - new Date(ts)) / 86400000); return d <= 0 ? 'today' : `${d}d ago`; };

async function act(fn, success) {
  try { const out = await fn(); if (success) toast(success); return out; } catch (err) { toast(err.message); throw err; }
}

async function renderClients() {
  const clients = await portalApi('/clients');
  view.innerHTML = `<h1>Companies</h1>
    <details class="panel" id="new-client-box"><summary><strong>+ New client</strong> <span class="muted">A prospect signs up and starts at Welcome</span></summary>
      <form id="new-client" class="form-grid" style="margin-top:12px">
        <label>Company name<input name="name" placeholder="Leave blank for a generated name"></label>
        <label>State<select name="state"><option>NY</option><option>NJ</option><option>CA</option></select></label>
        <label>Pay cycle<select name="payFrequency">${Object.entries(FREQ_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'biweekly' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Employees<input name="employees" type="number" min="5" max="200" value="25"></label>
        <label>Payroll system<select name="payrollProvider">${['ADP Workforce Now', 'ADP Run', 'Paychex Flex', 'Paylocity', 'Gusto', 'Viventium'].map((p) => `<option>${p}</option>`).join('')}</select></label>
        <div class="actions"><button type="submit">Create client</button></div>
      </form></details>
    <div class="actions"><label>Onboarding status <select id="ob-filter"><option value="">All</option>${STATUS_ORDER.map((s) => `<option>${s}</option>`).join('')}</select></label></div>
    <div class="table-wrap"><table id="client-table"><tr><th>Company</th><th>Status</th><th>Onboarding status</th><th>Step</th><th>Pay cycle</th><th class="num">Employees</th><th class="num">Census</th><th></th></tr>
    ${clients.map((c) => `<tr class="clickable" data-status="${esc(c.onboarding_status)}" onclick="location.hash='#/client/${c.id}'">
      <td><strong>${esc(c.name)}</strong> <span class="muted">${c.state}</span></td><td><span class="badge ${c.portal_status === 'Active' ? 'finalized' : 'mock'}">${c.portal_status}</span></td>
      <td>${esc(c.onboarding_status)}</td><td>${c.step} of 7</td><td>${FREQ_LABEL[c.pay_frequency]}</td><td class="num">${c.employee_count}</td>
      <td class="num">${c.census_pct}%</td><td><a href="#/client/${c.id}">Open</a></td></tr>`).join('')}
    </table></div>`;
  $('#new-client').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await act(() => portalApi('/clients', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }), 'Client created');
    await loadCompanies();
    location.hash = `#/client/${r.id}`;
  });
  $('#ob-filter').addEventListener('change', (ev) => {
    view.querySelectorAll('#client-table tr[data-status]').forEach((tr) => { tr.style.display = !ev.target.value || tr.dataset.status === ev.target.value ? '' : 'none'; });
  });
}

async function renderClient(id, tab = 'overview') {
  const d = await portalApi(`/clients/${id}`);
  const c = d.company;
  const m = c.milestones || {};
  const s = d.stepper;
  const tabs = ['overview', 'census', 'launch', 'recon', 'activity']
    .map((t) => `<a href="#/client/${id}/${t}" class="${tab === t ? 'active' : ''}">${{ overview: 'Overview', census: 'Master Census', launch: 'Pricing & Launch', recon: 'Monthly Recon', activity: 'Activity' }[t]}</a>`).join('');
  const header = `<h1>${esc(c.name)} <span class="badge ${c.portal_status === 'Active' ? 'finalized' : 'mock'}">${c.portal_status}</span></h1>
    <div class="panel"><strong>Onboarding Progress · Step ${s.step} of 7 · ${esc(s.name)}</strong> <span class="badge">${esc(c.onboarding_status)}</span>
      <div class="stepper">${Array.from({ length: 7 }, (_, i) => `<div class="${i < s.step ? 'done' : ''}"></div>`).join('')}</div>
      ${s.next ? (s.blocked ? `<div class="blocked">${esc(s.blocked)}</div>` : `<div class="ok-banner">Ready to move to <strong>${esc(s.next)}</strong>.</div>`) : '<div class="ok-banner">Onboarding complete.</div>'}
      <div class="actions">
        ${s.next ? `<button id="advance" ${s.blocked ? 'disabled' : ''}>Advance to ${esc(s.next)}</button>` : ''}
        ${c.onboarding_status === 'Eligibility Review' && !m.er_presented ? '<button class="secondary ms" data-ms="er_presented">Sales: present ER</button>' : ''}
        ${m.er_presented && !m.aop_sent ? '<button class="secondary ms" data-ms="aop_sent">Send AOP</button>' : ''}
        ${m.aop_sent && !m.aop_signed ? '<button class="secondary ms" data-ms="aop_signed">Client signs AOP (simulate)</button>' : ''}
        ${m.aop_sent && !m.census_link && !m.census_reconciled && c.onboarding_status !== 'Completed' ? '<button class="secondary ms" data-ms="census_link">Send census upload link</button>' : ''}
        ${m.aop_signed && !m.payroll_access_requested ? '<button class="secondary ms" data-ms="payroll_access_requested">Request payroll access</button>' : ''}
      </div></div>
    <div class="tabs">${tabs}</div>`;

  let body = '';
  if (tab === 'overview') {
    const contract = c.contract_products || [];
    const docsStage = ['Welcome', 'Payroll Docs', 'Underwriting', 'Awaiting Payroll Confirmation'].includes(c.onboarding_status);
    body = `${docsStage ? `<form id="docs" class="panel client-side"><h2 style="margin-top:0">Payroll documents <span class="badge">Client view</span></h2>
      ${d.job ? `<div class="ok-banner">Payroll register received ${ago(d.job.created_at)} · ${esc(d.job.status)} ·
        <a href="#/job/${d.job.id}">${d.job.queue === 'review' ? 'Open the review in the Onboarding Queue' : d.job.queue === 'csm' ? 'Open it in Proposal Requested' : 'View the job'} →</a></div>` : ''}
      <p class="muted">${d.job ? 'Need a newer register? Upload again to replace the one waiting for review.' : ''} Play the client: run a payroll for <strong>${esc(c.name)}</strong> in the payroll system, export its register (Reports → Check register → Export register), then upload it here. The document reader extracts it into the Onboarding Queue for review.</p>
      <div class="actions"><input type="file" name="file" accept=".csv,text/csv" required><button type="submit">Upload payroll register</button>
        <a href="#" onclick="openOtherApp('payroll', '#/reports', ${c.id}); return false">Open the payroll system ↗</a></div>
      <p class="muted" style="margin-bottom:0">Short on time? <button type="button" class="secondary" id="docs-sim">Client sends their latest register (simulate)</button></p></form>` : ''}
    <div class="two-col">
      <form id="settings" class="panel"><h2 style="margin-top:0">Account Settings</h2><div class="form-grid">
        <label>Company name<input name="name" value="${esc(c.name)}"></label>
        <label>Reflect group number<input name="reflect_group" value="${esc(c.reflect_group || '')}" placeholder="e.g. 1G012"></label>
        <label>Company code<input name="company_code" value="${esc(c.company_code || '')}"></label>
        <label>Go Live Date<input name="go_live_date" type="date" value="${c.go_live_date || ''}"></label>
        <label>Pipedrive Deal ID<input name="pipedrive_deal_id" value="${esc(c.pipedrive_deal_id || '')}"></label>
      </div>
      <p class="muted">Payroll system: ${esc(c.payroll_provider)} · ${FREQ_LABEL[c.pay_frequency]} · Contact: ${esc(c.contact?.name || '—')} ${c.contact?.title ? `(${esc(c.contact.title)})` : ''}</p>
      <div class="actions"><button type="submit">Save settings</button></div></form>
      <div class="panel"><h2 style="margin-top:0">Products</h2>
        <p class="muted">Signed contract (AOP) lists: ${contract.length ? contract.map((p) => `${PRODUCT_LABEL[p.code] || p.code} $${p.price}`).join(', ') : 'nothing yet'}</p>
        <table id="prod-table"><tr><th>Product</th><th>Monthly price</th><th></th></tr>
          ${(c.products || []).map((p, i) => `<tr><td>${PRODUCT_LABEL[p.code] || p.code}</td><td>$${p.price}</td><td><button class="secondary del-prod" data-i="${i}">Delete</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No products tagged.</td></tr>'}
        </table>
        <form id="add-prod" class="actions"><select name="code">${Object.entries(PRODUCT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <input name="price" type="number" step="1" class="small" placeholder="$/mo" required><button type="submit" class="secondary">Add product</button></form>
      </div></div>`;
  } else if (tab === 'census') {
    body = `<p class="muted">Census ${d.census.pct}% complete (${d.census.complete} of ${d.census.total} people have every required field).</p>
      <div class="actions"><button id="run-audit">Data audit</button></div><div id="audit-out"></div>
      <div class="table-wrap"><table><tr><th>Employee ID</th><th>Name</th><th>Status</th><th>Type</th><th>Pay cycle</th><th>Gender</th><th>DOB</th><th>SSN</th><th>ZIP</th><th>Location</th><th>Go Live</th><th>Products</th><th>Eligibility</th></tr>
      ${d.employees.map((e) => `<tr class="clickable" onclick="openOtherApp('payroll', '#/employee/${e.id}', ${c.id})"><td>${esc(e.employee_number)}</td><td>${esc(e.last_name)}, ${esc(e.first_name)}</td><td>${esc(e.census_status || '')}</td>
        <td>${e.employment_type}</td><td>${FREQ_LABEL[c.pay_frequency]}</td><td class="${e.gender ? '' : 'cell-missing'}">${esc(e.gender || '')}</td><td class="${e.birth_date ? '' : 'cell-missing'}">${e.birth_date || ''}</td>
        <td>${maskSsn(e.ssn)}</td><td>${esc(e.address?.zip || '')}</td><td>${esc(e.location_code || '')}</td><td>${e.go_live_date || ''}</td>
        <td>${Object.entries(e.products || {}).map(([k, v]) => `${k} $${v}`).join(', ')}</td><td>${esc(e.eligibility || '')}</td></tr>`).join('')}
      </table></div><p class="muted">Click a person to edit them in the payroll system. Census edits there show up here.</p>`;
  } else if (tab === 'launch') {
    const step = (done, label, button) => `<li>${done ? '✅' : '⬜'} ${label} ${button || ''}</li>`;
    body = `<div class="panel"><h2 style="margin-top:0">Pricing & launch checklist</h2><ol class="checklist">
      ${step((c.products || []).length, 'Check the contract and tag the products (Overview tab)')}
      ${step(m.priced, 'Price the group', `<button class="secondary" id="price">Run Pricing</button>`)}
      ${step(false, 'Pull 2-3 payrolls and run the mock payroll diagnosis', `<button class="secondary" id="diag">Run mock diagnosis</button>`)}
      ${step(m.emails_sent, 'Send the email trigger (ActiveCampaign)', m.emails_sent ? '' : '<button class="secondary ms" data-ms="emails_sent">Send emails</button>')}
      ${step(m.education_done, 'Run employee education', m.education_done ? '' : '<button class="secondary ms" data-ms="education_done">Mark education complete</button>')}
      ${step(m.audit_passed, 'Data audit clean (no red issues, census at least 90%), then mark good to launch', m.audit_passed ? '' : '<button class="secondary" id="audit2">Data audit</button> <button class="secondary" id="gtl">Mark good to launch</button>')}
      ${step(m.files_uploaded, 'Build the implementation files and upload them to payroll', `<label>BPT as <select id="bpt-mode"><option value="negativeDeduction">negative deduction</option><option value="reimbursement">reimbursement earning</option></select></label> <button class="secondary" id="files">Build files</button>`)}
      ${step(false, 'Run a mock payroll in the payroll system and confirm no negative taxes or net pay drops', `<a href="#" onclick="openOtherApp('payroll', '#/payroll', ${c.id}); return false">Open Run Payroll in the payroll system ↗</a>`)}
    </ol></div><div id="launch-out"></div>`;
  } else if (tab === 'recon') {
    const r = await portalApi(`/clients/${id}/recon`);
    if (c.onboarding_status !== 'Completed') body = '<p class="muted">Monthly recon starts once the client is live.</p>';
    else if (!r.opened) body = `<div class="panel"><p>Upload this month's payroll to start the recon.</p><div class="actions"><input id="recon-month" type="month" value="${new Date().toISOString().slice(0, 7)}"><button id="recon-open">Upload payroll month (simulated)</button></div></div>`;
    else {
      body = `<h2>Monthly recon · ${esc(r.month)}</h2>
      <div class="panel"><h2 style="margin-top:0">1. Fix details · ${r.payChanges.length} to do</h2>
        ${r.payChanges.map((p) => `<div>#${esc(p.employee.employee_number)} ${esc(p.employee.first_name)} ${esc(p.employee.last_name)}: census annual pay ${dollars(p.annualCensus)}, payroll shows ${dollars(p.annualPayroll)}
          <button class="secondary rc" data-a="update_pay" data-e="${esc(p.employee.employee_number)}">Update</button></div>`).join('') || '<p class="muted">Nothing to fix.</p>'}</div>
      <div class="panel"><h2 style="margin-top:0">2. Check active people · ${r.missing.length} to do</h2>
        ${r.missing.map((e) => `<div>#${esc(e.employee_number)} ${esc(e.first_name)} ${esc(e.last_name)} (${esc(e.census_status)}) is not in this month's payroll.
          <input type="date" class="term-date" value="${new Date().toISOString().slice(0, 10)}"> <button class="secondary rc" data-a="terminate" data-e="${esc(e.employee_number)}">Terminate</button></div>`).join('') || '<p class="muted">Everyone active was paid.</p>'}</div>
      <div class="panel"><h2 style="margin-top:0">3. Price & approve · ${r.newHires.length} to do</h2>
        ${r.newHires.map((p) => `<div>#${esc(p.emp_id)} ${esc(p.first_name)} ${esc(p.last_name)} is in payroll but not the census (${dollars(p.gross)} this check).
          <button class="secondary rc" data-a="add_new_hire" data-e="${esc(p.emp_id)}">Add to census</button> <button class="secondary rc" data-a="price_new_hire" data-e="${esc(p.emp_id)}">Price & approve</button></div>`).join('') || '<p class="muted">No new people.</p>'}</div>
      <div class="actions"><button class="rc" data-a="finish">4. Finish recon</button></div>`;
    }
  } else {
    body = activityTable(d.activity);
  }
  view.innerHTML = header + body;

  const reload = () => renderClient(id, tab);
  $('#advance')?.addEventListener('click', () => act(() => portalApi(`/clients/${id}/advance`, { method: 'POST' }), 'Advanced').then(reload));
  view.querySelectorAll('.ms').forEach((b) => b.addEventListener('click', () => act(() => portalApi(`/clients/${id}/milestones/${b.dataset.ms}`, { method: 'POST' }), 'Done').then(reload)));
  $('#docs')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const file = ev.target.file.files[0];
    const r = await act(async () => portalApi(`/clients/${id}/payroll-docs`, { method: 'POST', body: { csv: await file.text(), fileName: file.name } }));
    toast(`Register uploaded: ${r.employees} employees extracted. Review it in the Onboarding Queue.`);
    reload();
  });
  $('#docs-sim')?.addEventListener('click', async () => {
    const r = await act(() => portalApi(`/clients/${id}/payroll-docs`, { method: 'POST', body: { simulate: true } }));
    toast(`Register received: ${r.employees} employees extracted. Review it in the Onboarding Queue.`);
    reload();
  });
  $('#settings')?.addEventListener('submit', (ev) => { ev.preventDefault(); act(() => portalApi(`/clients/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(ev.target)) }), 'Saved').then(reload); });
  $('#add-prod')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const products = [...(c.products || []).filter((p) => p.code !== f.get('code')), { code: f.get('code'), price: Number(f.get('price')) }];
    act(() => portalApi(`/clients/${id}`, { method: 'PATCH', body: { products } }), 'Product applied').then(reload);
  });
  view.querySelectorAll('.del-prod').forEach((b) => b.addEventListener('click', () => {
    const products = c.products.filter((_, i) => i !== Number(b.dataset.i));
    act(() => portalApi(`/clients/${id}`, { method: 'PATCH', body: { products } }), 'Product removed').then(reload);
  }));
  const showAudit = async (target) => {
    const a = await portalApi(`/clients/${id}/audit`);
    target.innerHTML = `<div class="panel"><strong>${a.issues.length} issues found · ${a.peopleAffected} of ${a.people} people affected.</strong> This only checks. Nothing is changed.
      <p><span class="issue red">${a.red} to fix before sending</span> · <span class="issue amber">${a.amber} to fix</span></p>
      <table><tr><th>Employee</th><th>Category</th><th>Field</th><th>Fix</th></tr>${a.issues.map((i) => `<tr class="issue ${i.severity}"><td>${i.employeeNumber ? `#${esc(i.employeeNumber)} ${esc(i.name)}` : 'Company'}</td><td>${esc(i.category)}</td><td>${esc(i.field)}</td><td>${esc(i.message)}</td></tr>`).join('')}</table></div>`;
  };
  $('#run-audit')?.addEventListener('click', () => showAudit($('#audit-out')));
  $('#audit2')?.addEventListener('click', () => showAudit($('#launch-out')));
  $('#gtl')?.addEventListener('click', () => act(() => portalApi(`/clients/${id}/good-to-launch`, { method: 'POST' }), 'Marked good to launch').then(reload));
  $('#price')?.addEventListener('click', () => act(() => portalApi(`/clients/${id}/price`, { method: 'POST' })).then((r) => { toast(`Priced: ${r.eligible} eligible`); reload(); }));
  $('#diag')?.addEventListener('click', async () => {
    const r = await act(() => portalApi(`/clients/${id}/mock-diagnosis`));
    $('#launch-out').innerHTML = `<div class="panel"><h2 style="margin-top:0">Mock Payroll Diagnosis</h2><p class="muted">Worst-case net change per paycheck across 3 pay periods. REMOVE when ≤ $${r.thresholds.remove}; BUFFER when $0 to $${r.thresholds.buffer}.</p>
      <table><tr><th>Employee</th><th class="num">Worst net change</th><th>Result</th><th>Break-even</th><th></th></tr>${r.results.map((x) => `<tr><td>#${esc(x.employeeNumber)} ${esc(x.name)}</td><td class="num">${dollars(x.worstDelta)}</td>
        <td><span class="badge ${x.status === 'OK' ? 'finalized' : x.status === 'BUFFER' ? 'mock' : 'warn'}">${x.status}</span></td><td>${x.breakEven ? `Drop ${x.breakEven.drop.join(', ')}` : ''}</td>
        <td>${x.breakEven ? `<button class="secondary dx" data-n="${esc(x.employeeNumber)}" data-keep="${x.breakEven.keep.join(',')}">Drop ${x.breakEven.drop.join(', ')}</button>` : ''}
          ${x.status === 'REMOVE' || (x.status === 'ADJUST' && !x.breakEven) ? `<button class="secondary dx" data-n="${esc(x.employeeNumber)}" data-keep="" data-remove="1">Remove from program</button>` : ''}</td></tr>`).join('')}</table></div>`;
    $('#launch-out').querySelectorAll('.dx').forEach((b) => b.addEventListener('click', () => {
      const keep = b.dataset.keep ? b.dataset.keep.split(',') : [];
      act(() => portalApi(`/clients/${id}/employees/${b.dataset.n}/products`, { method: 'POST', body: { keep, remove: !!b.dataset.remove } }),
        b.dataset.remove ? 'Removed from the program' : 'Products adjusted').then(() => $('#diag').click());
    }));
  });
  $('#files')?.addEventListener('click', async () => {
    const mode = $('#bpt-mode').value;
    const r = await act(() => portalApi(`/clients/${id}/launch-files?bptMode=${mode}`));
    const csv = (rows) => ['employee_id,last_name,first_name,code,amount', ...rows.map((l) => [l.employee_id, l.last_name, l.first_name, l.code, l.amount].join(','))].join('\n');
    const link = (name, rows) => `<a class="btn secondary" download="${name}.csv" href="data:text/csv,${encodeURIComponent(csv(rows))}">${name}.csv (${rows.length})</a>`;
    $('#launch-out').innerHTML = `<div class="panel"><h2 style="margin-top:0">Implementation files</h2>
      <p>${FREQ_LABEL[r.payFrequency]} payroll: upload in <strong>week ${r.implementationWeek}</strong> of the month.</p>
      <div class="actions">${link('FGH_plan', r.files.plan)}${link('BPT_benefits_payment', r.files.benefitsPayment)}${link('RWP_reward_plan', r.files.reward)}</div>
      <table><tr><th>Employee</th><th>Plan</th><th class="num">Amount</th><th>BPT</th><th class="num">Amount</th><th>RWP</th><th class="num">Amount</th></tr>
      ${r.files.plan.map((l, i) => `<tr><td>#${esc(l.employee_id)} ${esc(l.first_name)} ${esc(l.last_name)}</td><td>${l.code}</td><td class="num">${dollars(l.amount)}</td><td>${r.files.benefitsPayment[i].code}</td><td class="num">${dollars(r.files.benefitsPayment[i].amount)}</td><td>${r.files.reward[i].code}</td><td class="num">${dollars(r.files.reward[i].amount)}</td></tr>`).join('')}</table>
      <div class="actions"><button id="apply-files">Upload files into payroll</button></div></div>`;
    $('#apply-files').addEventListener('click', () => act(() => portalApi(`/clients/${id}/launch-files/apply`, { method: 'POST', body: { bptMode: mode } }), 'Files uploaded to payroll. Run a mock payroll next.').then(reload));
  });
  $('#recon-open')?.addEventListener('click', () => act(() => portalApi(`/clients/${id}/recon/open`, { method: 'POST', body: { month: $('#recon-month').value } }), 'Payroll month uploaded').then(reload));
  view.querySelectorAll('.rc').forEach((b) => b.addEventListener('click', () => {
    const date = b.parentElement.querySelector('.term-date')?.value;
    act(() => portalApi(`/clients/${id}/recon/action`, { method: 'POST', body: { action: b.dataset.a, employeeNumber: b.dataset.e, date } }), 'Saved').then(reload);
  }));
}

function activityTable(rows) {
  return `<div class="table-wrap"><table><tr><th>When</th><th>Company</th><th>Action</th><th>By</th><th>Details</th></tr>
    ${rows.map((a) => `<tr><td>${new Date(a.at).toLocaleString()}</td><td>${esc(a.company || '')}</td><td>${esc(a.action)}</td><td>${esc(a.actor || '')}</td>
      <td class="muted">${esc(Object.entries(a.detail || {}).filter(([k]) => k !== 'payroll' && k !== 'expected').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing yet.</td></tr>'}
  </table></div>`;
}

async function renderActivity() {
  const rows = await portalApi('/activity');
  const uniq = (k) => [...new Set(rows.map((a) => a[k]).filter(Boolean))].sort();
  view.innerHTML = `<h1>Activity Log</h1>
    <div class="actions"><label>From <input type="date" id="al-from"></label><label>To <input type="date" id="al-to"></label>
      <label>Company <select id="al-company"><option value="">All</option>${uniq('company').map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>
      <label>Actor <select id="al-actor"><option value="">All</option>${uniq('actor').map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>
      <label>Action <select id="al-action"><option value="">All</option>${uniq('action').map((v) => `<option>${esc(v)}</option>`).join('')}</select></label></div>
    <div id="al-out"></div>`;
  const draw = () => {
    const from = $('#al-from').value, to = $('#al-to').value, co = $('#al-company').value, actor = $('#al-actor').value, action = $('#al-action').value;
    $('#al-out').innerHTML = activityTable(rows.filter((a) => {
      const day = new Date(a.at).toISOString().slice(0, 10);
      return (!from || day >= from) && (!to || day <= to) && (!co || a.company === co) && (!actor || a.actor === actor) && (!action || a.action === action);
    }));
  };
  view.querySelectorAll('.actions input, .actions select').forEach((el) => el.addEventListener('change', draw));
  draw();
}

function jobsTable(jobs, kind) {
  if (!jobs.length) return '<p class="muted">All caught up.</p>';
  return `<div class="table-wrap"><table><tr><th>Company</th><th class="num">Employees</th>${kind === 'review' ? '<th>Flags</th>' : ''}<th>Status</th><th>Queued</th><th></th></tr>
    ${jobs.map((j) => `<tr><td><strong>${esc(j.company)}</strong></td><td class="num">${j.employees}</td>${kind === 'review' ? `<td>${j.flags ? `<span class="badge warn">${j.flags} to verify</span>` : '—'}</td>` : ''}
      <td>${esc(j.status)}</td><td>${ago(j.created_at)}</td>
      <td>${kind === 'review' ? `<a class="btn" href="#/job/${j.id}">Open review</a>` : `<a class="btn" href="#/calculator/${j.id}">Open calculator</a>`}</td></tr>
      ${j.notes.length ? `<tr><td colspan="6" class="muted">${j.notes.map((n) => `${esc(n.author)}: ${esc(n.text)}`).join('<br>')}</td></tr>` : ''}`).join('')}
  </table></div>`;
}

async function renderQueue() {
  view.innerHTML = `<h1>Onboarding Queue</h1><p class="muted">Payroll jobs awaiting human review. Open one to verify the extracted data against the source document, then confirm and send.</p>${jobsTable(await portalApi('/queues/review'), 'review')}`;
}

async function renderCsmQueue() {
  view.innerHTML = `<h1>Proposal Requested Queue</h1><p class="muted">Finalized payroll jobs awaiting CSM follow-up. Open the calculator, build the proposal, send it to Pipedrive, then mark the job complete.</p>${jobsTable(await portalApi('/queues/csm'), 'csm')}`;
}

const JOB_COLS = [['gross', 'Gross'], ['avg_hrs', 'Avg hrs'], ['rate', 'Rate'], ['fed_filing', 'Fed filing'], ['dependents', 'Deps'], ['state_filing', 'State filing'], ['fed_tax', 'Fed tax'], ['ss', 'SS'], ['medicare', 'Medicare'], ['state_tax', 'State tax'], ['net_pay', 'Net pay']];

async function renderJob(id) {
  const job = await portalApi(`/jobs/${id}`);
  const verified = job.rows.filter((r) => r.verified).length;
  view.innerHTML = `<h1>Payroll Review · ${esc(job.company)}</h1>
    <p class="muted">${verified}/${job.rows.length} verified · Status: ${esc(job.status)}. Amber cells are low-confidence extractions. Compare each flagged row with the source register, correct anything wrong, then verify it.</p>
    <div class="actions"><button id="confirm">Confirm &amp; send to CSM queue</button><label><input type="checkbox" id="flagged-only" checked> Flagged only</label>
      <button class="secondary" id="show-source">View source document</button></div>
    <div id="source" hidden></div>
    <div class="table-wrap"><table id="job-grid"><tr><th>#</th><th>Employee</th>${JOB_COLS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Notes</th><th></th></tr>
      ${job.rows.map((r, i) => {
        const flagged = new Set(r.flags.map((f) => f.field));
        return `<tr data-i="${i}" data-flagged="${r.flags.length ? 1 : 0}" ${r.flags.length ? '' : 'style="display:none"'}><td>${i + 1}</td><td>${esc(r.first_name)} ${esc(r.last_name)} <span class="muted">#${esc(r.emp_id)}</span></td>
          ${JOB_COLS.map(([f]) => `<td class="${flagged.has(f) ? 'cell-flag' : ''}"><input class="grid-input" name="${f}" value="${esc(r[f] ?? '')}" size="${Math.max(5, String(r[f] ?? '').length + 1)}" ${job.queue !== 'review' ? 'disabled' : ''}></td>`).join('')}
          <td class="muted">${r.flags.map((f) => esc(f.note)).join('; ')}</td>
          <td>${r.verified ? '<span class="badge finalized">Verified</span>' : `<button class="secondary verify">Verify</button>`}</td></tr>`;
      }).join('')}
    </table></div>
    <div class="panel"><h2 style="margin-top:0">Notes for the CSM / payroll team</h2>${job.notes.map((n) => `<div class="muted">${esc(n.author)}: ${esc(n.text)}</div>`).join('')}
      <form id="note" class="actions"><input name="text" placeholder="Add a note…" style="flex:1"><button class="secondary">Post</button></form></div>`;
  $('#flagged-only').addEventListener('change', (ev) => view.querySelectorAll('#job-grid tr[data-i]').forEach((tr) => { tr.style.display = ev.target.checked && tr.dataset.flagged === '0' ? 'none' : ''; }));
  $('#show-source').addEventListener('click', () => {
    const el = $('#source');
    el.hidden = !el.hidden;
    el.innerHTML = `<div class="panel"><h2 style="margin-top:0">Payroll Register (source document)</h2><div class="table-wrap"><table><tr><th>Employee</th>${JOB_COLS.map(([, l]) => `<th>${l}</th>`).join('')}</tr>
      ${job.source.map((r) => `<tr><td>${esc(r.first_name)} ${esc(r.last_name)} #${esc(r.emp_id)}</td>${JOB_COLS.map(([f]) => `<td>${esc(r[f] ?? '')}</td>`).join('')}</tr>`).join('')}</table></div></div>`;
  });
  view.querySelectorAll('.verify').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const body = { verified: true };
    tr.querySelectorAll('.grid-input').forEach((inp) => {
      const v = inp.value.trim();
      body[inp.name] = v === '' ? null : ['fed_filing', 'state_filing'].includes(inp.name) ? v : Number(v);
    });
    await act(() => portalApi(`/jobs/${id}/rows/${tr.dataset.i}`, { method: 'PATCH', body }), 'Row verified');
    renderJob(id);
  }));
  $('#confirm').addEventListener('click', () => act(() => portalApi(`/jobs/${id}/confirm`, { method: 'POST' }), 'Sent to the CSM queue').then(() => { location.hash = '#/csm'; }));
  $('#note').addEventListener('submit', (ev) => { ev.preventDefault(); act(() => portalApi(`/jobs/${id}/notes`, { method: 'POST', body: { text: new FormData(ev.target).get('text') } })).then(() => renderJob(id)); });
}

async function renderCalculator(id, price = '149') {
  const job = await portalApi(`/jobs/${id}`);
  const r = await portalApi(`/jobs/${id}/calculator?price=${price}`);
  const s = r.summary;
  view.innerHTML = `<h1>Calculator · ${esc(job.company)} <span class="muted">Payroll — ${s.employees} employees</span></h1>
    <div class="cards">
      <div class="card"><div class="label">Eligibility</div><div class="value">${s.eligible}/${s.employees} (${s.eligiblePct}%)</div></div>
      <div class="card"><div class="label">Monthly savings</div><div class="value">${dollars(s.monthlySavings)}</div><div class="muted">${dollars(s.avgSavingsPerEe)} per EE · ${dollars(s.annualSavings)}/yr</div></div>
      <div class="card"><div class="label">Valuation increase</div><div class="value">${dollars(s.valuationIncrease)}</div><div class="muted">at 3.8x EBITDA</div></div>
      <div class="card"><div class="label">Allotment distribution</div><div class="value" style="font-size:14px">&lt;$139: ${s.allotmentDistribution.under139} · $139–149: ${s.allotmentDistribution.from139to149} · $149+: ${s.allotmentDistribution.over149}</div></div>
    </div>
    <div class="panel"><h2 style="margin-top:0">Margin Strategy Analyzer</h2><table><tr><th>Program</th><th class="num">Eligible</th><th class="num">Margin %</th><th class="num">12-month revenue</th><th></th></tr>
      ${r.tiers.map((t) => `<tr class="clickable" onclick="location.hash='#/calculator/${id}/${t.price}'"><td>$${t.price} ${t.current ? '<span class="badge">Current</span>' : ''} ${t.best ? '<span class="badge finalized">Best</span>' : ''}</td>
        <td class="num">${t.eligible}</td><td class="num">${t.marginPct}%</td><td class="num">${dollars(t.twelveMonthProfit)}</td><td></td></tr>`).join('')}</table>
      <div class="actions">${job.proposal ? `<span class="badge finalized">Proposal sent to Pipedrive at $${job.proposal.programPrice}</span>` : `<button id="proposal">Create proposal at $${price} &amp; send to Pipedrive</button>`}
        <button class="secondary" id="complete">Mark complete</button><button class="secondary" id="pushback">Push back to payroll queue</button></div></div>
    <div class="table-wrap"><table><tr><th>Name</th><th>State</th><th class="num">Gross (annual)</th><th class="num">First Gen /check</th><th class="num">Tax pre-FG</th><th class="num">Tax with FG</th><th class="num">Mo. allotment</th><th>Eligibility</th></tr>
      ${r.rows.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.workState}</td><td class="num">${dollars(x.annualGross)}</td><td class="num">${dollars(x.firstGenPerPeriod)}</td>
        <td class="num">${dollars(x.taxPreFirstGen)}</td><td class="num">${dollars(x.taxPerPeriod)}</td><td class="num">${dollars(x.monthlyAllotment)}</td>
        <td>${x.eligible ? '<span class="badge finalized">Eligible</span>' : `<span class="badge warn">${esc(x.label)}</span>`}</td></tr>`).join('')}</table></div>
    <p class="muted">Monthly allotment = (annual tax saved by the FGH pre-tax deduction ÷ 12) × 75%. Rules run top to bottom; the first match wins.</p>`;
  $('#proposal')?.addEventListener('click', () => act(() => portalApi(`/jobs/${id}/proposal`, { method: 'POST', body: { programPrice: Number(price) } }), 'Proposal sent to Pipedrive').then(() => renderCalculator(id, price)));
  $('#complete').addEventListener('click', () => act(() => portalApi(`/jobs/${id}/complete`, { method: 'POST' }), 'Marked complete').then(() => { location.hash = '#/csm'; }));
  $('#pushback').addEventListener('click', () => {
    const reason = prompt('Why are you pushing this back?');
    if (reason) act(() => portalApi(`/jobs/${id}/push-back`, { method: 'POST', body: { reason } }), 'Pushed back').then(() => { location.hash = '#/csm'; });
  });
}

async function renderCensusInbox() {
  const uploads = await portalApi('/census-uploads');
  view.innerHTML = `<h1>Census Review</h1><p class="muted">Review uploads and confirm employee updates.</p>
    ${uploads.length ? `<div class="table-wrap"><table><tr><th>Company</th><th>File</th><th class="num">Employees</th><th>Status</th><th>Uploaded</th><th></th></tr>
      ${uploads.map((u) => `<tr><td><strong>${esc(u.company)}</strong></td><td>Census.xlsx</td><td class="num">${u.employees}</td><td>${esc(u.status)}</td><td>${ago(u.created_at)}</td><td><a class="btn" href="#/upload/${u.id}">View</a></td></tr>`).join('')}
    </table></div>` : '<p class="muted">No census uploads. Send a census link from a client page once the AOP is out.</p>'}`;
}

const CENSUS_COLS = [['employee_number', 'Employee ID'], ['first_name', 'First'], ['last_name', 'Last'], ['birth_date', 'DOB'], ['gender', 'Gender'], ['ssn', 'SSN'], ['email', 'Email'], ['phone', 'Phone'], ['address.zip', 'ZIP'], ['hire_date', 'Start date'], ['filing_status', 'Filing'], ['dependents', 'Deps'], ['gross_annual', 'Gross annual'], ['avg_hours', 'Avg hrs/wk'], ['employment_type', 'FT/PT']];
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

async function renderCensusUpload(id) {
  const u = await portalApi(`/census-uploads/${id}`);
  view.innerHTML = `<h1>Census · ${esc(u.company)}</h1>
    <p><strong>${u.pct}% complete</strong> · ${u.rows.length} employees · ${esc(u.status)}. Red cells are missing. Use "Ask client" to request missing info; fix anything wrong; delete duplicate rows.</p>
    <div class="actions"><button id="save">Save</button><button class="secondary" id="send">Save &amp; send to CSM</button></div>
    <div class="table-wrap"><table id="census-grid"><tr>${CENSUS_COLS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr>
      ${u.rows.map((r, i) => `<tr data-i="${i}">${CENSUS_COLS.map(([f]) => {
        const v = getPath(r, f);
        const invalid = (f === 'ssn' && v && String(v).replace(/\D/g, '').length !== 9) || (f === 'address.zip' && v && !/^\d{5}$/.test(v));
        const missing = v == null || v === '' || invalid;
        return `<td class="${missing ? 'cell-missing' : ''}"><input class="grid-input" name="${f}" value="${esc(v ?? '')}" size="${Math.max(6, String(v ?? '').length + 1)}">${missing ? `<a href="#" class="ask" data-f="${f}">Ask client</a>` : ''}</td>`;
      }).join('')}<td><button class="secondary del-row">Delete</button></td></tr>`).join('')}
    </table></div>`;
  const collect = () => [...view.querySelectorAll('#census-grid tr[data-i]')].map((tr) => {
    const row = structuredClone(u.rows[Number(tr.dataset.i)]);
    tr.querySelectorAll('.grid-input').forEach((inp) => {
      const v = inp.value.trim() === '' ? null : inp.value.trim();
      if (inp.name === 'address.zip') row.address = { ...(row.address || {}), zip: v };
      else row[inp.name] = ['dependents', 'gross_annual', 'avg_hours'].includes(inp.name) && v != null ? Number(v) : v;
    });
    return row;
  });
  view.querySelectorAll('.ask').forEach((a) => a.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const tr = a.closest('tr');
    const r = await portalApi(`/census-uploads/${id}/ask`, { method: 'POST', body: { employeeNumber: $('[name=employee_number]', tr).value, field: a.dataset.f } });
    toast(r.message);
  }));
  view.querySelectorAll('.del-row').forEach((b) => b.addEventListener('click', () => b.closest('tr').remove()));
  $('#save').addEventListener('click', () => act(() => portalApi(`/census-uploads/${id}/rows`, { method: 'PUT', body: { rows: collect() } }), 'Saved').then(() => renderCensusUpload(id)));
  $('#send').addEventListener('click', async () => {
    await act(() => portalApi(`/census-uploads/${id}/rows`, { method: 'PUT', body: { rows: collect() } }));
    const r = await act(() => portalApi(`/census-uploads/${id}/send`, { method: 'POST' }));
    toast(`Census reconciled: ${r.updated} updated, ${r.added} added`);
    renderCensusUpload(id);
  });
}

// ---------- training ----------

async function openWorkspace(id, scenarioKey) {
  localStorageSet('ws', id);
  await loadWorkspaces();
  // Portal scenarios start in the portal; payroll ones in the payroll system.
  const app = scenarioKey?.startsWith('portal-') ? 'portal' : 'payroll';
  if (app !== APP) { openOtherApp(app, ''); return; }
  location.hash = `#/${HOME_OF()}`;
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
    openWorkspace(ws.id, assignments.find((a) => String(a.id) === id)?.scenario_key);
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

// ---------- portal: CS operations and the client view (from the Softr map) ----------

const STATUS_CHIPS = ['Active', 'New hire', 'Underwriting', 'Unenrolled', 'Terminated', 'Opted out', 'On leave', 'Ineligible', 'Not in payroll', 'Inactive', 'DNU', 'No status'];
const TASK_FLOWS = ['Census Confirmation', 'Eligibility Rerun Request', 'New Hire', 'Product Change', 'Terminate', 'Unenroll', 'On leave', 'Opt out'];
const statusBadge = (s) => `<span class="badge ${/^Active/.test(s || '') ? 'finalized' : ['Terminated', 'Unenrolled', 'Opted out', 'Ineligible'].includes(s) ? 'warn' : 'mock'}">${esc(s || 'No status')}</span>`;
const companyOptions = (selected, all = true) => `${all ? '<option value="">All companies</option>' : ''}${state.companies.map((c) => `<option value="${c.id}" ${String(c.id) === String(selected) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
const todayIso = () => new Date().toISOString().slice(0, 10);
const csv = (rows) => rows.map((r) => r.map((v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\n');
const csvLink = (name, rows, label = 'Export CSV') => `<a class="btn secondary" download="${name}.csv" href="data:text/csv,${encodeURIComponent(csv(rows))}">${label}</a>`;

/** The "Viewing as" picker: the CS team, or one client company's HR user. */
function syncPortalAs() {
  const sel = $('#as-select');
  if (!sel) return;
  const current = portalAs();
  sel.innerHTML = `<option value="cs">First Gen CS team</option>${state.companies.map((c) => `<option value="${c.id}">Client: ${esc(c.name)}</option>`).join('')}`;
  sel.value = state.companies.some((c) => String(c.id) === current) ? current : 'cs';
}
$('#as-select')?.addEventListener('change', (ev) => {
  localStorageSet(`portal-as-${state.ws}`, ev.target.value);
  location.hash = `#/${HOME_OF()}`;
  route();
});
const clientCompany = () => state.companies.find((c) => String(c.id) === portalAs());

// ----- CS: Dashboard -----

function taskCard(t) {
  return `<div class="task-card"><div><span class="badge">${esc(t.company)}</span> <span class="badge mock">${esc(t.task_flow)}</span>
      ${t.first_name ? `<strong>${esc(t.first_name)} ${esc(t.last_name)}</strong> <span class="muted">#${esc(t.employee_number)}</span>` : ''}
      <div class="muted">${t.triggered_by ? `From ${esc(t.triggered_by)} · ` : ''}${ago(t.created_at)}${t.company_go_live ? ` · Go live ${t.company_go_live}` : ''}</div></div>
    <a class="btn" href="#/task/${t.id}">${esc(t.action || 'Review')}</a></div>`;
}

async function renderOpsDashboard() {
  const d = await portalApi('/dashboard');
  const k = d.kpis;
  view.innerHTML = `<h1>Dashboard</h1>
    <div class="cards">
      <div class="card"><div class="label">Active Companies</div><div class="value">${k.active_companies}</div></div>
      <div class="card"><div class="label">Active Employees</div><div class="value">${k.active_employees}</div></div>
      <div class="card"><div class="label">Pending Tasks</div><div class="value">${k.pending_tasks}</div></div>
      <div class="card"><div class="label">Companies onboarding</div><div class="value">${k.onboarding_companies}</div></div>
    </div>
    <div class="two-col">
      <div class="panel"><h2 style="margin-top:0">Pending Tasks</h2>${d.tasks.map(taskCard).join('') || '<p class="muted">No open tasks.</p>'}
        <div class="actions"><a href="#/team-tasks">All team tasks →</a></div></div>
      <div class="panel"><h2 style="margin-top:0">Monthly payroll uploads</h2>
        ${d.uploads.length ? `<table><tr><th>Company</th><th>Month</th><th>Status</th></tr>${d.uploads.map((u) => `<tr><td>${esc(u.company)}</td><td>${u.month}</td><td>${esc(u.status)}</td></tr>`).join('')}</table>` : '<p class="muted">No uploads yet.</p>'}
        <div class="actions"><a href="#/monthly-review-block">Monthly Review →</a></div></div>
    </div>`;
}

// ----- CS: Team Tasks and one task -----

async function renderTeamTasks(tab = 'Open') {
  const status = tab === 'Resolved' ? 'Resolved' : 'Open';
  const tasks = await portalApi(`/tasks?status=${status}`);
  view.innerHTML = `<h1>Team Tasks</h1>
    <div class="tabs"><a href="#/team-tasks/Open" class="${status === 'Open' ? 'active' : ''}">Open</a><a href="#/team-tasks/Resolved" class="${status === 'Resolved' ? 'active' : ''}">Resolved</a></div>
    <div class="actions"><label>Company <select id="tt-company">${companyOptions('')}</select></label>
      <label>Workflow <select id="tt-flow"><option value="">All workflows</option>${TASK_FLOWS.map((f) => `<option>${f}</option>`).join('')}</select></label>
      ${csvLink('team-tasks', [['Company', 'Employee', 'Workflow', 'Status', 'Decision'], ...tasks.map((t) => [t.company, `${t.first_name || ''} ${t.last_name || ''}`, t.task_flow, t.status, t.decision || ''])], 'Export')}</div>
    <div class="table-wrap"><table id="tt"><tr><th>Company</th><th>Employee</th><th>Workflow</th><th>Status</th><th>${status === 'Open' ? 'Action' : 'Decision'}</th></tr>
      ${tasks.map((t) => `<tr data-company="${t.company_id}" data-flow="${esc(t.task_flow)}"><td>${esc(t.company)}</td><td>${t.first_name ? `${esc(t.first_name)} ${esc(t.last_name)} <span class="muted">#${esc(t.employee_number)}</span>` : '—'}</td>
        <td>${esc(t.task_flow)}</td><td>${esc(t.status)}</td>
        <td>${status === 'Open' ? `<a class="btn" href="#/task/${t.id}">${esc(t.action)}</a>` : `${esc(t.decision || '')} <span class="muted">${esc(t.decided_by || '')}</span>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing here.</td></tr>'}
    </table></div>`;
  const filter = () => {
    const c = $('#tt-company').value, f = $('#tt-flow').value;
    view.querySelectorAll('#tt tr[data-company]').forEach((tr) => { tr.style.display = (!c || tr.dataset.company === c) && (!f || tr.dataset.flow === f) ? '' : 'none'; });
  };
  $('#tt-company').addEventListener('change', filter);
  $('#tt-flow').addEventListener('change', filter);
}

function previewBlock(p) {
  return `<div><strong>${p.eligible ? 'Eligible' : esc(p.label)}</strong> · allotment ${dollars(p.monthlyAllotment)}/mo · status ${esc(p.status)}<br>
    <span class="muted">Products: ${Object.entries(p.products).map(([k, v]) => `${k} $${v}`).join(', ') || 'none'}</span></div>`;
}

async function renderTask(id) {
  const { task: t, employee: e, company: c, preview } = await portalApi(`/tasks/${id}`);
  const p = t.payload || {};
  const rows = [];
  if (e) rows.push(['Employee', `${esc(e.first_name)} ${esc(e.last_name)} #${esc(e.employee_number)} · ${statusBadge(e.census_status)}${e.pending_status_change ? ` → pending ${esc(e.pending_status_change)}` : ''}`]);
  if (p.effectiveDate) rows.push(['Effective date', esc(p.effectiveDate)]);
  if (p.reason) rows.push(['Reason', esc(p.reason)]);
  if (p.drop) rows.push(['Drop products', esc(p.drop.join(', '))]);
  if (e) rows.push(['Current products', esc(Object.entries(e.products || {}).map(([k, v]) => `${k} $${v}`).join(', ') || 'none')]);
  let body = '';
  if (t.task_flow === 'Eligibility Rerun Request' && preview) {
    const v = p.newValues || {};
    const gross = e.pay_type === 'salary' ? Number(e.pay_rate) : Math.round(Number(e.pay_rate) * Number(e.standard_hours) * 52);
    body = `<table><tr><th>Field</th><th>Current</th><th>Requested</th></tr>
      <tr><td>Gross annual</td><td>${dollars(gross)}</td><td>${v.gross_annual ? dollars(v.gross_annual) : '—'}</td></tr>
      <tr><td>Avg hours / week</td><td>${e.standard_hours}</td><td>${v.avg_hours_per_week ?? '—'}</td></tr>
      <tr><td>Filing status</td><td>${esc(e.w4.filingStatus)}</td><td>${esc(v.filing_status || '—')}</td></tr>
      <tr><td>Dependents</td><td>${Math.round((e.w4.dependentsCredit || 0) / 2200)}</td><td>${v.dependents ?? '—'}</td></tr></table>
      <div class="two-col" style="margin-top:12px"><div class="panel"><h3 style="margin-top:0">Before</h3>${previewBlock(preview.before)}</div><div class="panel"><h3 style="margin-top:0">After the rerun</h3>${previewBlock(preview.after)}</div></div>`;
  } else if (t.task_flow === 'New Hire' && preview) {
    const gross = e.pay_type === 'salary' ? Number(e.pay_rate) : Math.round(Number(e.pay_rate) * Number(e.standard_hours) * 52);
    body = `<p>Start date ${e.hire_date || '—'} · ${e.employment_type} · ${dollars(gross)}/yr · ${e.standard_hours} hrs/wk · filing ${esc(e.w4.filingStatus)}</p>
      <div class="panel"><h3 style="margin-top:0">Pricing preview</h3>${previewBlock(preview)}
      ${(c.products || []).length ? '' : '<div class="blocked">This client has no products tagged yet.</div>'}</div>`;
  } else if (t.task_flow === 'Census Confirmation') {
    body = `<p>Confirm once the census upload is reconciled in <a href="#/census">Census Review</a>.</p>`;
  }
  const approveLabel = { 'Review & Price': 'Price & activate', 'Review & Decide': 'Approve', 'Review & Apply': 'Apply' }[t.action] || 'Approve';
  view.innerHTML = `<div class="actions"><a href="#/team-tasks">← Team Tasks</a></div>
    <h1>${esc(t.task_flow)} <span class="badge">${esc(t.status)}</span></h1>
    <div class="panel"><p><strong><a href="#/client/${c.id}">${esc(c.name)}</a></strong> · ${FREQ_LABEL[c.pay_frequency]} · requested by ${esc(t.triggered_by || '—')} ${ago(t.created_at)}</p>
      <table>${rows.map(([k, v]) => `<tr><th style="width:180px">${k}</th><td>${v}</td></tr>`).join('')}</table>
      ${body}
      ${t.status === 'Open' ? `<label style="margin-top:12px">Note (optional)<input id="task-note" placeholder="e.g. client emailed"></label>
        <div class="actions"><button id="approve">${approveLabel}</button><button class="secondary" id="reject">Reject</button></div>`
        : `<div class="ok-banner">${esc(t.decision || '')} · ${esc(t.decided_by || '')}${t.notes ? ` · ${esc(t.notes)}` : ''}</div>`}</div>`;
  const decide = (decision) => act(() => portalApi(`/tasks/${id}/decide`, { method: 'POST', body: { decision, note: $('#task-note').value } }))
    .then((r) => { toast(r.summary); renderTask(id); });
  $('#approve')?.addEventListener('click', () => decide('approve'));
  $('#reject')?.addEventListener('click', () => decide('reject'));
}

// ----- CS: rosters and status reports -----

async function renderMasterCensus() {
  const rows = await portalApi('/master-census');
  view.innerHTML = `<h1>Master Census</h1>
    <div class="actions"><label>Company <select id="mc-company">${companyOptions('')}</select></label>
      <label>Status <select id="mc-status"><option value="">All statuses</option>${STATUS_CHIPS.map((s) => `<option>${s}</option>`).join('')}</select></label>
      <input id="mc-search" placeholder="Search name or ID">
      ${csvLink('master-census', [['Company', 'Employee ID', 'First', 'Last', 'Status', 'FT/PT', 'Products', 'Go live'], ...rows.map((r) => [r.company, r.employee_number, r.first_name, r.last_name, r.census_status, r.employment_type, Object.keys(r.products || {}).join(' '), r.go_live_date])])}</div>
    <div class="table-wrap"><table id="mc"><tr><th>Company</th><th>Employee ID</th><th>Name</th><th>Status</th><th>FT/PT</th><th>Location</th><th>Products</th><th>Go live</th><th>Eligibility</th></tr>
      ${rows.map((r) => `<tr class="clickable" data-company="${r.company_id}" data-status="${esc(/^Active/.test(r.census_status || '') ? 'Active' : r.census_status || 'No status')}" data-text="${esc(`${r.first_name} ${r.last_name} ${r.employee_number}`.toLowerCase())}"
        onclick="openOtherApp('payroll', '#/employee/${r.id}', ${r.company_id})"><td>${esc(r.company)}</td><td>${esc(r.employee_number)}</td><td>${esc(r.last_name)}, ${esc(r.first_name)}</td>
        <td>${statusBadge(r.census_status)}${r.pending_status_change ? ` <span class="muted">→ ${esc(r.pending_status_change)}</span>` : ''}</td><td>${r.employment_type}</td><td>${esc(r.location_code || '')}</td>
        <td>${Object.entries(r.products || {}).map(([k, v]) => `${k} $${v}`).join(', ')}</td><td>${r.go_live_date || ''}</td><td class="muted">${esc(r.eligibility || '')}</td></tr>`).join('')}
    </table></div>`;
  const filter = () => {
    const c = $('#mc-company').value, st = $('#mc-status').value, q = $('#mc-search').value.toLowerCase();
    view.querySelectorAll('#mc tr[data-company]').forEach((tr) => {
      tr.style.display = (!c || tr.dataset.company === c) && (!st || tr.dataset.status === st) && (!q || tr.dataset.text.includes(q)) ? '' : 'none';
    });
  };
  ['#mc-company', '#mc-status'].forEach((s) => $(s).addEventListener('change', filter));
  $('#mc-search').addEventListener('input', filter);
}

async function renderStatusRoster() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const asOf = params.get('asOf') || todayIso();
  const company = params.get('company') || '';
  const rows = await portalApi(`/status-roster?asOf=${asOf}${company ? `&company=${company}` : ''}`);
  const counts = Object.fromEntries(STATUS_CHIPS.map((s) => [s, rows.filter((r) => r.status === s).length]));
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  view.innerHTML = `<h1>Employee Status Change</h1><p class="muted">Roster as of a date, built from the status change log.</p>
    <div class="actions"><label>As of <input type="date" id="sr-date" value="${asOf}"></label>
      <button class="secondary sr-quick" data-d="${todayIso()}">Today</button><button class="secondary sr-quick" data-d="${daysAgo(7)}">7d</button><button class="secondary sr-quick" data-d="${daysAgo(30)}">30d</button>
      <label>Company <select id="sr-company">${companyOptions(company)}</select></label><input id="sr-search" placeholder="Search name">
      ${csvLink(`status-roster-${asOf}`, [['Employee', 'Company', 'Status'], ...rows.map((r) => [`${r.first_name} ${r.last_name}`, r.company, r.status])])}</div>
    <div class="chips">${STATUS_CHIPS.map((s) => `<button class="chip" data-s="${s}">${s} <strong>${counts[s]}</strong></button>`).join('')}</div>
    <div class="table-wrap"><table id="sr"><tr><th>Employee</th><th>Company</th><th>Status</th></tr>
      ${rows.map((r) => `<tr data-s="${esc(r.status)}" data-text="${esc(`${r.first_name} ${r.last_name}`.toLowerCase())}"><td>${esc(r.first_name)} ${esc(r.last_name)} <span class="muted">#${esc(r.employee_number)}</span></td><td>${esc(r.company)}</td><td>${statusBadge(r.status)}</td></tr>`).join('')}
    </table></div>`;
  const go = (d, c) => { location.hash = `#/employee-status-roster?asOf=${d}${c ? `&company=${c}` : ''}`; };
  $('#sr-date').addEventListener('change', (ev) => go(ev.target.value, $('#sr-company').value));
  $('#sr-company').addEventListener('change', (ev) => go($('#sr-date').value, ev.target.value));
  view.querySelectorAll('.sr-quick').forEach((b) => b.addEventListener('click', () => go(b.dataset.d, $('#sr-company').value)));
  let chip = '';
  const filter = () => {
    const q = $('#sr-search').value.toLowerCase();
    view.querySelectorAll('#sr tr[data-s]').forEach((tr) => { tr.style.display = (!chip || tr.dataset.s === chip) && (!q || tr.dataset.text.includes(q)) ? '' : 'none'; });
    view.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.s === chip));
  };
  view.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { chip = chip === b.dataset.s ? '' : b.dataset.s; filter(); }));
  $('#sr-search').addEventListener('input', filter);
}

async function renderStatusChanges() {
  const rows = await portalApi('/status-changes');
  view.innerHTML = `<h1>Terminated Employees</h1><p class="muted">Status &amp; product changes: every change from the status log, newest first.</p>
    <div class="actions"><label>Company <select id="sc-company">${companyOptions('')}</select></label>
      <label>Status <select id="sc-status"><option value="">All</option>${STATUS_CHIPS.map((s) => `<option>${s}</option>`).join('')}</select></label>
      ${csvLink('status-changes', [['Employee ID', 'Location', 'Name', 'Company', 'From', 'To', 'Effective', 'Reason', 'By'], ...rows.map((r) => [r.employee_number, r.location_code, `${r.first_name} ${r.last_name}`, r.company, r.from_status, r.to_status, r.effective_date, r.reason, r.actor])])}</div>
    <div class="table-wrap"><table id="sc"><tr><th>Employee ID</th><th>Location</th><th>Name</th><th>Company</th><th>Status</th><th>Status date</th><th>Products after</th><th>Notes</th><th>By</th></tr>
      ${rows.map((r) => `<tr data-company="${esc(r.company)}" data-s="${esc(/^Active/.test(r.to_status) ? 'Active' : r.to_status)}"><td>${esc(r.employee_number)}</td><td>${esc(r.location_code || '')}</td><td>${esc(r.first_name)} ${esc(r.last_name)}</td><td>${esc(r.company)}</td>
        <td>${r.from_status ? `${esc(r.from_status)} → ` : ''}${statusBadge(r.to_status)}</td><td>${r.effective_date}</td>
        <td>${r.products ? esc(Object.keys(r.products).join(', ') || 'none') : '<span class="muted">unchanged</span>'}</td><td class="muted">${esc(r.reason || '')}</td><td>${esc(r.actor || '')}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No changes yet.</td></tr>'}
    </table></div>`;
  const filter = () => {
    const c = $('#sc-company').selectedOptions[0]?.textContent, cv = $('#sc-company').value, st = $('#sc-status').value;
    view.querySelectorAll('#sc tr[data-s]').forEach((tr) => { tr.style.display = (!cv || tr.dataset.company === c) && (!st || tr.dataset.s === st) ? '' : 'none'; });
  };
  $('#sc-company').addEventListener('change', filter);
  $('#sc-status').addEventListener('change', filter);
}

/** Employee roster with the Deductions & Reimbursements table; shared by the CS and client views. */
async function rosterView(companyId, { client }) {
  const [detail, ded] = await Promise.all([portalApi(`/clients/${companyId}`), portalApi(`/clients/${companyId}/deductions`)]);
  const c = detail.company;
  const byId = Object.fromEntries(ded.map((d) => [d.employeeId, d]));
  const leaver = (e) => ['Terminated', 'Unenrolled', 'Opted out'].includes(e.census_status);
  const actions = (e) => (leaver(e) || e.pending_status_change ? '' : `<select class="req" data-id="${e.id}"><option value="">Status change…</option>
      <option>Terminate</option><option>Unenroll</option><option>On leave</option><option value="Eligibility Rerun Request">Eligibility rerun</option>${Object.keys(e.products || {}).length ? '<option>Product Change</option>' : ''}</select>`);
  const live = detail.employees.filter((e) => !leaver(e));
  return { c, html: `
    <div class="panel"><h2 style="margin-top:0">Your Team <span class="muted">${live.length} people</span></h2>
      <div class="actions">${client ? '<button id="add-hire">Add New Employee</button>' : ''}
        ${csvLink(`roster-${c.company_code || c.id}`, [['Status', 'Pay Cycle', 'First Name', 'Last Name', 'Email', 'City', 'State', 'Phone', 'SSN', 'Job Title', 'Hire Date', 'Go Live Date'], ...detail.employees.map((e) => [e.census_status, FREQ_LABEL[c.pay_frequency], e.first_name, e.last_name, e.email, e.address?.city, e.address?.state, e.phone, maskSsn(e.ssn), e.job_title, e.hire_date, e.go_live_date])], 'Export')}</div>
      <div id="hire-form"></div>
      <div class="table-wrap"><table><tr><th>Status</th><th>Pay Cycle</th><th>Name</th><th>Email</th><th>Gender</th><th>City</th><th>Phone#</th><th>SSN</th><th>Job Title</th><th>Hire Date</th><th>Go Live Date</th><th>Status Change</th></tr>
        ${detail.employees.map((e) => `<tr><td>${statusBadge(e.census_status)}${e.pending_status_change ? `<div class="muted">pending ${esc(e.pending_status_change)}</div>` : ''}</td><td>${FREQ_LABEL[c.pay_frequency]}</td>
          <td>${esc(e.first_name)} ${esc(e.last_name)}</td><td>${esc(e.email || '')}</td><td>${esc(e.gender || '')}</td><td>${esc(e.address?.city || '')}</td><td>${esc(e.phone || '')}</td><td>${maskSsn(e.ssn)}</td>
          <td>${esc(e.job_title || '')}</td><td>${e.hire_date || ''}</td><td>${e.go_live_date || ''}</td><td>${client ? actions(e) : ''}</td></tr>
          <tr class="req-row" id="req-${e.id}" hidden><td colspan="12"></td></tr>`).join('')}
      </table></div></div>
    <div class="panel"><h2 style="margin-top:0">Deductions &amp; Reimbursements <span class="muted">per paycheck</span></h2>
      <p class="muted">Pre-Tax Well is the FGH/FGPT plan deduction, WIMPER the BPT benefits payment back, Post-Tax Well the RWP products.</p>
      <div class="table-wrap"><table><tr><th>Status</th><th>Name</th><th>Products</th><th class="num">Pre-Tax Well</th><th class="num">WIMPER</th><th class="num">Post-Tax Well</th></tr>
        ${ded.filter((d) => d.products.length).map((d) => `<tr><td>${statusBadge(d.status)}</td><td>${esc(d.name)}</td><td>${esc(d.products.join(', '))}</td>
          <td class="num">${dollars(d.preTaxWell)}</td><td class="num">${dollars(d.wimper)}</td><td class="num">${dollars(d.postTaxWell)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nobody is priced yet.</td></tr>'}
      </table></div></div>`, byId, detail };
}

function wireClientRoster(companyId, detail, rerender) {
  view.querySelectorAll('.req').forEach((sel) => sel.addEventListener('change', () => {
    const flow = sel.value;
    const e = detail.employees.find((x) => String(x.id) === sel.dataset.id);
    const row = $(`#req-${e.id}`);
    if (!flow) { row.hidden = true; return; }
    row.hidden = false;
    const cell = row.firstElementChild;
    const gross = e.pay_type === 'salary' ? Number(e.pay_rate) : Math.round(Number(e.pay_rate) * Number(e.standard_hours) * 52);
    cell.innerHTML = `<form class="form-grid req-form"><strong style="grid-column:1/-1">${flow === 'Eligibility Rerun Request' ? 'Eligibility rerun' : flow} · ${esc(e.first_name)} ${esc(e.last_name)}</strong>
      ${['Terminate', 'Unenroll', 'On leave', 'Opt out'].includes(flow) ? `<label>Effective date<input type="date" name="effectiveDate" required value="${todayIso()}"></label>` : ''}
      ${flow === 'Eligibility Rerun Request' ? `<label>New gross annual<input type="number" name="gross_annual" value="${gross}"></label><label>Avg hours / week<input type="number" name="avg_hours_per_week" value="${e.standard_hours}"></label>
        <label>Filing status<select name="filing_status">${['single', 'married', 'head'].map((f) => `<option ${e.w4.filingStatus === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
        <label>Dependents<input type="number" name="dependents" value="${Math.round((e.w4.dependentsCredit || 0) / 2200)}"></label>` : ''}
      ${flow === 'Product Change' ? Object.keys(e.products || {}).map((k) => `<label><input type="checkbox" name="drop" value="${k}"> Drop ${PRODUCT_LABEL[k] || k}</label>`).join('') : ''}
      <label>Reason<input name="reason" placeholder="${flow === 'On leave' ? 'e.g. medical leave' : 'Optional'}"></label>
      <div class="actions"><button type="submit">Submit request</button><button type="button" class="secondary cancel">Cancel</button></div></form>`;
    $('.cancel', cell).addEventListener('click', () => { row.hidden = true; sel.value = ''; });
    $('form', cell).addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const body = { flow, employeeId: e.id, effectiveDate: f.get('effectiveDate'), reason: f.get('reason') };
      if (flow === 'Eligibility Rerun Request') body.newValues = { gross_annual: Number(f.get('gross_annual')), avg_hours_per_week: Number(f.get('avg_hours_per_week')), filing_status: f.get('filing_status'), dependents: Number(f.get('dependents')) };
      if (flow === 'Product Change') body.drop = f.getAll('drop');
      act(() => portalApi(`/clients/${companyId}/requests`, { method: 'POST', body }), 'Request sent to First Gen').then(rerender);
    });
  }));
  $('#add-hire')?.addEventListener('click', () => {
    $('#hire-form').innerHTML = `<form id="hire" class="panel form-grid"><strong style="grid-column:1/-1">Add New Employee</strong>
      <label>First name<input name="first_name" required></label><label>Last name<input name="last_name" required></label>
      <label>Date of birth<input type="date" name="birth_date" required></label><label>Gender<select name="gender"><option>M</option><option>F</option></select></label>
      <label>SSN<input name="ssn" placeholder="123-45-6789"></label><label>Email<input name="email" type="email"></label><label>Phone<input name="phone"></label>
      <label>Address<input name="address"></label><label>City<input name="city"></label><label>ZIP<input name="zip"></label>
      <label>Job title<input name="job_title"></label><label>Start date<input type="date" name="hire_date" value="${todayIso()}"></label>
      <label>Gross annual earnings<input type="number" name="gross_annual" required></label><label>Avg hours / week<input type="number" name="avg_hours_per_week" value="40"></label>
      <label>Pay type<select name="pay_type"><option value="hourly">Hourly</option><option value="salary">Salary</option></select></label>
      <label>Filing status<select name="filing_status"><option>single</option><option>married</option><option>head</option></select></label><label>Dependents<input type="number" name="dependents" value="0"></label>
      <div class="actions"><button type="submit">Submit new hire</button></div></form>`;
    $('#hire').addEventListener('submit', (ev) => {
      ev.preventDefault();
      act(() => portalApi(`/clients/${companyId}/new-hire`, { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }), 'New hire sent to First Gen for pricing').then(rerender);
    });
  });
}

async function renderCsRoster(companyId) {
  const live = state.companies.filter((c) => c.id);
  const id = Number(companyId) || live[0]?.id;
  const { c, html } = await rosterView(id, { client: false });
  view.innerHTML = `<h1>Employee Roster</h1><div class="actions"><label>Company <select id="r-company">${companyOptions(id, false)}</select></label>
    <a href="#/client/${c.id}">Open ${esc(c.name)} →</a></div>${html}`;
  $('#r-company').addEventListener('change', (ev) => { location.hash = `#/roster/${ev.target.value}`; });
}

// ----- CS: Mock Payroll Diagnosis (standalone) and Monthly Review -----

async function renderMockPage(companyId) {
  const id = Number(companyId) || state.companies[0]?.id;
  view.innerHTML = `<h1>Mock Payroll – Reverse Run</h1>
    <div class="panel"><div class="actions"><label>Company <select id="mp-company">${companyOptions(id, false)}</select></label>
      <label>Severity <select id="mp-preset"><option value="standard">Standard (REMOVE ≤ -$50)</option><option value="forward">Forward (REMOVE ≤ -$15)</option></select></label>
      <label>BPT as <select id="mp-bpt"><option value="negativeDeduction">Negative deduction</option><option value="reimbursement">Reimbursement</option></select></label>
      <button id="mp-run">Run analysis</button></div>
      <p class="muted">Runs every priced employee through three pay periods (normal, short and overtime) with and without the program. Fix results on the client's Pricing &amp; Launch tab.</p></div>
    <div id="mp-out"></div>`;
  $('#mp-company').addEventListener('change', (ev) => { location.hash = `#/mock-payroll-run/${ev.target.value}`; });
  $('#mp-run').addEventListener('click', async () => {
    const r = await act(() => portalApi(`/clients/${$('#mp-company').value}/mock-diagnosis?preset=${$('#mp-preset').value}&bptMode=${$('#mp-bpt').value}`));
    const count = (s) => r.results.filter((x) => x.status === s).length;
    $('#mp-out').innerHTML = `<div class="cards">${['OK', 'BUFFER', 'ADJUST', 'REMOVE'].map((s) => `<div class="card"><div class="label">${s}</div><div class="value">${count(s)}</div></div>`).join('')}</div>
      <div class="table-wrap"><table><tr><th>Employee</th><th class="num">Worst net change</th><th>Per period</th><th>Result</th><th>Break-even</th></tr>
      ${r.results.map((x) => `<tr><td>#${esc(x.employeeNumber)} ${esc(x.name)}</td><td class="num">${dollars(x.worstDelta)}</td><td class="muted">${x.deltas.map(dollars).join(' / ')}</td>
        <td>${statusBadge(x.status === 'OK' ? 'Active' : x.status)}</td><td>${x.breakEven ? `Drop ${x.breakEven.drop.join(', ')}` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nobody is priced for this client.</td></tr>'}</table></div>
      <div class="actions"><a class="btn secondary" href="#/client/${$('#mp-company').value}/launch">Fix on Pricing &amp; Launch →</a></div>`;
  });
}

async function renderMonthlyReview(tab = 'All') {
  const uploads = await portalApi(`/monthly-uploads${tab !== 'All' ? `?status=${encodeURIComponent(tab)}` : ''}`);
  const tabs = ['All', 'Ready', 'Processing', 'Failed', 'Needs a fix', 'Reviewed'];
  view.innerHTML = `<h1>Monthly Review Block</h1><p class="muted">Payroll registers live clients sent for last month. A Ready upload becomes that client's monthly reconciliation.</p>
    <div class="tabs">${tabs.map((t) => `<a href="#/monthly-review-block/${encodeURIComponent(t)}" class="${t === tab ? 'active' : ''}">${t}</a>`).join('')}</div>
    <div class="table-wrap"><table><tr><th>Company</th><th>Payroll month</th><th>File</th><th class="num">Employees</th><th>Status</th><th>Sent by</th><th>When</th><th></th></tr>
      ${uploads.map((u) => `<tr><td>${esc(u.company)}</td><td>${u.month}</td><td>${esc(u.file_name || '')}</td><td class="num">${u.employees}</td><td>${esc(u.status)}${u.problems.length ? `<div class="muted">${esc(u.problems.slice(0, 3).join(' '))}</div>` : ''}</td>
        <td>${esc(u.uploaded_by || '')}</td><td>${ago(u.created_at)}</td>
        <td>${u.status === 'Ready' ? `<a class="btn" href="#/client/${u.company_id}/recon">Reconcile</a> <button class="secondary mr" data-id="${u.id}">Mark reviewed</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No uploads.</td></tr>'}
    </table></div>`;
  view.querySelectorAll('.mr').forEach((b) => b.addEventListener('click', () => act(() => portalApi(`/monthly-uploads/${b.dataset.id}/reviewed`, { method: 'POST' }), 'Marked reviewed').then(() => renderMonthlyReview(tab))));
}

// ----- Client view -----

const TOS_ARTICLES = ['Definitions', 'Portal access', 'HIPAA and data governance', 'Security', 'Confidentiality', 'Client responsibilities', 'Disclaimers', 'Indemnification', 'Term', 'Intellectual property', 'General'];

async function renderClientHome() {
  const co = clientCompany();
  if (!co) { location.hash = '#/home'; return; }
  const d = await portalApi(`/clients/${co.id}`);
  const c = d.company, m = c.milestones || {};
  if (c.onboarding_status === 'Completed') {
    const ded = await portalApi(`/clients/${c.id}/deductions`);
    const tasks = await portalApi(`/tasks?status=Open&company=${c.id}`);
    view.innerHTML = `<h1>Welcome back, ${esc(c.contact?.name?.split(' ')[0] || 'there')}</h1>
      <div class="cards"><div class="card"><div class="label">Enrolled employees</div><div class="value">${ded.filter((x) => x.products.length).length}</div></div>
        <div class="card"><div class="label">Requests with First Gen</div><div class="value">${tasks.length}</div></div>
        <div class="card"><div class="label">Go Live Date</div><div class="value">${c.go_live_date || '—'}</div></div></div>
      <div class="panel"><h2 style="margin-top:0">Request Status</h2>${tasks.length ? `<table><tr><th>Request</th><th>Employee</th><th>Sent</th></tr>${tasks.map((t) => `<tr><td>${esc(t.task_flow)}</td><td>${esc(t.first_name || '')} ${esc(t.last_name || '')}</td><td>${ago(t.created_at)}</td></tr>`).join('')}</table>` : '<p class="muted">No open requests.</p>'}
        <div class="actions"><a class="btn" href="#/c-roster">Go to your roster</a><a class="btn secondary" href="#/c-upload">Send last month's payroll</a></div></div>`;
    return;
  }
  const step = (done, title, body) => `<div class="panel onboarding-step ${done ? 'done' : ''}"><h2 style="margin-top:0">${done ? '✅' : '⬜'} ${title}</h2>${done ? '' : body}</div>`;
  const tos = `<details><summary>Read the Terms of Service (Articles I–XI)</summary><ol>${TOS_ARTICLES.map((a) => `<li>${a}</li>`).join('')}</ol><p class="muted">Training copy: article titles only.</p></details>
    <div class="actions"><button id="tos">I accept the Terms of Service</button></div>`;
  const el = `<form id="el" class="form-grid"><p style="grid-column:1/-1" class="muted">Engagement Letter, Articles I–VII. Sign as the client.</p>
    <label>By<input name="by" required></label><label>Printed name<input name="printed_name" required></label><label>Title<input name="title" required></label>
    <label>City<input name="city" required></label><label>State<input name="state" required value="${c.state}"></label><label>Zip<input name="zip" required></label>
    <label style="grid-column:1/-1"><input type="checkbox" name="agree" value="1" required> I have read the Terms &amp; Conditions</label>
    <div class="actions"><button type="submit">Sign engagement letter</button></div></form>`;
  const docs = `<form id="c-docs"><div class="form-grid"><label>Payroll frequency<select name="freq">${['Weekly', 'Bi-Weekly', 'Semi-Monthly', 'Monthly', 'More Than 1'].map((f) => `<option>${f}</option>`).join('')}</select></label>
      <label>Payroll register (CSV)<input type="file" name="file" accept=".csv,text/csv"></label></div>
    <p class="muted">Submit your most recent payroll register. Export it from your payroll system (Reports → Check register → Export register).
      <a href="#" onclick="openOtherApp('payroll', '#/reports', ${c.id}); return false">Open the payroll system ↗</a></p>
    <div class="actions"><button type="submit">Upload payroll documents</button><button type="button" class="secondary" id="c-docs-sim">Send our latest register (simulate)</button></div></form>`;
  const aop = m.aop_sent ? `<p>Your Account Opening Paperwork is ready to sign.</p><div class="actions"><button id="c-aop">Review &amp; sign AOP</button></div>` : '<p class="muted">First Gen will send your AOP after reviewing your proposal.</p>';
  const census = m.census_link ? `<p>Fill in your employee census.</p><div class="actions"><a class="btn" href="#/c-census">Open Employee Census</a></div>` : '<p class="muted">Your census link arrives with the AOP.</p>';
  view.innerHTML = `<h1>Get Started</h1><p class="muted">${esc(c.name)} · step ${d.stepper.step} of 7 · ${esc(c.onboarding_status)}</p>
    ${step(m.tos_accepted, 'Accept the Terms of Service', tos)}
    ${step(m.engagement_letter_signed, 'Sign the engagement letter', m.tos_accepted ? el : '<p class="muted">Accept the Terms of Service first.</p>')}
    ${step(!!d.job, 'Upload payroll documents', m.engagement_letter_signed ? docs : '<p class="muted">Sign the engagement letter first.</p>')}
    ${step(m.aop_signed, 'Sign your Account Opening Paperwork (AOP)', aop)}
    ${step(m.census_reconciled, 'Submit your employee census', census)}`;
  const reload = () => renderClientHome();
  $('#tos')?.addEventListener('click', () => act(() => portalApi(`/clients/${c.id}/tos`, { method: 'POST' }), 'Terms accepted').then(reload));
  $('#el')?.addEventListener('submit', (ev) => { ev.preventDefault(); act(() => portalApi(`/clients/${c.id}/engagement-letter`, { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }), 'Engagement letter signed').then(reload); });
  $('#c-docs')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const file = ev.target.file.files[0];
    if (!file) { toast('Choose your payroll register file, or use simulate.'); return; }
    await act(async () => portalApi(`/clients/${c.id}/payroll-docs`, { method: 'POST', body: { csv: await file.text(), fileName: file.name } }), 'Payroll documents submitted');
    reload();
  });
  $('#c-docs-sim')?.addEventListener('click', () => act(() => portalApi(`/clients/${c.id}/payroll-docs`, { method: 'POST', body: { simulate: true } }), 'Payroll documents submitted').then(reload));
  $('#c-aop')?.addEventListener('click', () => act(() => portalApi(`/clients/${c.id}/milestones/aop_signed`, { method: 'POST' }), 'AOP signed').then(reload));
}

async function renderClientRoster() {
  const co = clientCompany();
  const { c, html, detail } = await rosterView(co.id, { client: true });
  view.innerHTML = `<h1>Roster</h1><p class="muted">${esc(c.name)}. Status changes and new hires go to First Gen as requests.</p>${html}`;
  wireClientRoster(co.id, detail, renderClientRoster);
}

async function renderClientCensus() {
  const co = clientCompany();
  const d = await portalApi(`/clients/${co.id}`);
  const uploads = (await portalApi('/census-uploads')).filter((u) => u.company_id === co.id);
  view.innerHTML = `<h1>Employee Census</h1>
    <div class="panel"><p>${d.census.pct}% of your census is complete (${d.census.complete ?? ''}${d.census.complete != null ? ' people with every required field' : ''}).</p>
      ${d.company.milestones?.census_link ? `<p class="muted">Your census submission: ${uploads.length ? `${esc(uploads[0].status)} ${ago(uploads[0].created_at)}` : 'not sent yet'}.</p>` : '<p class="muted">First Gen sends your census link with the AOP.</p>'}</div>
    <div class="table-wrap"><table><tr><th>Name</th><th>Email</th><th>Employee Status</th><th>Job Title</th></tr>
      ${d.employees.map((e) => `<tr><td>${esc(e.first_name)} ${esc(e.last_name)}</td><td>${esc(e.email || '')}</td><td>${statusBadge(e.census_status)}</td><td>${esc(e.job_title || '')}</td></tr>`).join('')}</table></div>`;
}

async function renderClientUpload() {
  const co = clientCompany();
  const d = await portalApi(`/clients/${co.id}`);
  if (d.company.onboarding_status !== 'Completed') { location.hash = '#/c-home'; return; }
  const uploads = await portalApi(`/monthly-uploads?company=${co.id}`);
  const months = Array.from({ length: 13 }, (_, i) => { const t = new Date(); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - 1 - i); return t.toISOString().slice(0, 7); });
  view.innerHTML = `<h1>Send us last month's payroll</h1>
    <form id="mu" class="panel"><div class="form-grid"><label>Payroll month<select name="month">${months.map((m) => `<option>${m}</option>`).join('')}</select></label>
      <label>Payroll register files (CSV)<input type="file" name="file" accept=".csv,text/csv"></label></div>
      <div class="actions"><button type="submit">Send payroll</button><button type="button" class="secondary" id="mu-sim">Send our register (simulate)</button>
        <a href="#" onclick="openOtherApp('payroll', '#/reports', ${co.id}); return false">Open the payroll system ↗</a></div></form>
    <h2>Recent uploads</h2><div class="table-wrap"><table><tr><th>Month</th><th>File</th><th>Status</th><th>Sent</th></tr>
      ${uploads.map((u) => `<tr><td>${u.month}</td><td>${esc(u.file_name || '')}</td><td>${esc(u.status)}${u.problems.length ? `<div class="muted">${esc(u.problems.join(' '))}</div>` : ''}</td><td>${ago(u.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing sent yet.</td></tr>'}</table></div>`;
  const month = () => $('#mu [name=month]').value;
  $('#mu').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const file = ev.target.file.files[0];
    if (!file) { toast('Choose the payroll register, or use simulate.'); return; }
    const r = await act(async () => portalApi(`/clients/${co.id}/monthly-upload`, { method: 'POST', body: { month: month(), csv: await file.text(), fileName: file.name } }));
    toast(r.status === 'Ready' ? 'Payroll sent. Thank you!' : 'We found problems in that file. See below.');
    renderClientUpload();
  });
  $('#mu-sim').addEventListener('click', () => act(() => portalApi(`/clients/${co.id}/monthly-upload`, { method: 'POST', body: { month: month(), simulate: true } }), 'Payroll sent. Thank you!').then(renderClientUpload));
}
