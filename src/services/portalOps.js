// Day-to-day portal operations from the Softr map: CS tasks (CS_TASKS), employee status
// changes and their log (UNENROLLED/TERMINATED), client requests from the roster, the client
// onboarding documents (ToS, engagement letter), and monthly payroll uploads.
import { query, transaction } from '../db/index.js';
import { calculatorRow } from '../engine/calculator.js';
import { perCheck, PROGRAM_PRICING, rewardMonthly } from '../engine/program.js';
import { registerFromCsv } from '../engine/registerFormat.js';
import { log, getCompany, employeesOf, calcInput, PortalError, openReconMonthFor } from './portal.js';
import { firstOfNextMonth } from './portalSeed.js';

export const TASK_FLOWS = ['Census Confirmation', 'Eligibility Rerun Request', 'New Hire', 'Product Change', 'Terminate', 'Unenroll', 'On leave', 'Opt out'];
// What CS clicks for each flow, as in the portal's task cards.
export const TASK_ACTION = {
  'Eligibility Rerun Request': 'Review & Decide', 'New Hire': 'Review & Price', 'Product Change': 'Review & Apply',
  'Census Confirmation': 'Review & Decide', Terminate: 'Review & Apply', Unenroll: 'Review & Apply', 'On leave': 'Review & Apply', 'Opt out': 'Review & Apply',
};
const STATUS_FOR_FLOW = { Terminate: 'Terminated', Unenroll: 'Unenrolled', 'On leave': 'On leave', 'Opt out': 'Opted out' };
export const EMPLOYEE_STATUSES = ['Active', 'New hire', 'Underwriting', 'Unenrolled', 'Terminated', 'Opted out', 'On leave', 'Ineligible', 'Not in payroll', 'Inactive', 'DNU'];
/** Active FT / Active PT are portal sub-statuses of Active. */
export const statusGroup = (s) => (!s ? 'No status' : /^Active/.test(s) ? 'Active' : s);

const today = () => new Date().toISOString().slice(0, 10);
const employeeById = async (db, ws, id) => {
  const { rows: [e] } = await db.query('SELECT * FROM employees WHERE id = $1 AND workspace_id = $2', [id, ws]);
  if (!e) throw Object.assign(new Error('Employee not found'), { status: 404 });
  return e;
};

/** Changes an employee's status and writes the status log, like every status change in the portal. */
export async function setEmployeeStatus(db, ws, e, to, { effective = today(), reason = null, actor = 'CS', products } = {}) {
  const sets = ['census_status = $2', 'status_change_effective_date = $3', 'pending_status_change = NULL'];
  const params = [e.id, to, effective];
  if (products !== undefined) { params.push(products); sets.push(`products = $${params.length}`); }
  if (to === 'Terminated') { params.push(effective); sets.push(`termination_date = $${params.length}`); }
  await db.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = $1`, params);
  await db.query(
    `INSERT INTO employee_status_log (workspace_id, company_id, employee_id, from_status, to_status, effective_date, reason, products, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [ws, e.company_id, e.id, e.census_status, to, effective, reason, products === undefined ? null : JSON.stringify(products), actor]);
}

export async function createTask(db, ws, { companyId, employeeId = null, flow, payload = {}, triggeredBy = 'Client' }) {
  const { rows: [t] } = await db.query(
    'INSERT INTO cs_tasks (workspace_id, company_id, employee_id, task_flow, payload, triggered_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [ws, companyId, employeeId, flow, payload, triggeredBy]);
  return t;
}

const TASK_SELECT = `SELECT t.*, c.name AS company, c.go_live_date AS company_go_live, e.first_name, e.last_name, e.employee_number
  FROM cs_tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN employees e ON e.id = t.employee_id`;

export async function listTasks(ws, { status, flow, companyId } = {}) {
  const where = ['t.workspace_id = $1'];
  const params = [ws];
  if (status) { params.push(status); where.push(`t.status = $${params.length}`); }
  if (flow) { params.push(flow); where.push(`t.task_flow = $${params.length}`); }
  if (companyId) { params.push(companyId); where.push(`t.company_id = $${params.length}`); }
  const { rows } = await query(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.status, t.created_at DESC`, params);
  return rows.map((t) => ({ ...t, action: TASK_ACTION[t.task_flow] }));
}

/** Pricing preview for an employee record (new hire, or a rerun with new values). */
function pricePreview(c, e) {
  const row = calculatorRow(calcInput(e, c.pay_frequency), Number((c.products || []).find((p) => p.code === 'VIRTUAL')?.price) || 149);
  const pt = e.employment_type === 'PT';
  const products = {};
  if (row.eligible) {
    for (const p of c.products || []) products[p.code] = p.code === 'VIRTUAL' && pt ? PROGRAM_PRICING.partTimeProducts.VIRTUAL : Number(p.price);
  }
  return {
    eligible: row.eligible, label: row.label, monthlyAllotment: row.monthlyAllotment, products,
    status: row.eligible ? (pt ? 'Active PT' : 'Active FT') : 'Ineligible',
  };
}

/** Applies a rerun's new values to an employee record (in memory). */
function withRerunValues(e, v) {
  const out = { ...e, w4: { ...e.w4 } };
  if (v.filing_status) out.w4.filingStatus = v.filing_status;
  if (v.dependents != null && v.dependents !== '') out.w4.dependentsCredit = Number(v.dependents) * 2200;
  if (v.avg_hours_per_week) out.standard_hours = Number(v.avg_hours_per_week);
  if (v.gross_annual) {
    out.pay_rate = out.pay_type === 'salary' ? Number(v.gross_annual) : Math.round((Number(v.gross_annual) / 52 / Number(out.standard_hours || 40)) * 100) / 100;
  }
  if (v.employment_type) out.employment_type = v.employment_type;
  return out;
}

export async function taskDetail(ws, id) {
  const { rows: [t] } = await query(`${TASK_SELECT} WHERE t.id = $1 AND t.workspace_id = $2`, [id, ws]);
  if (!t) throw Object.assign(new Error('Task not found'), { status: 404 });
  const c = await getCompany({ query }, ws, t.company_id);
  const e = t.employee_id ? await employeeById({ query }, ws, t.employee_id) : null;
  let preview = null;
  if (e && t.task_flow === 'New Hire') preview = pricePreview(c, e);
  if (e && t.task_flow === 'Eligibility Rerun Request') {
    preview = { before: pricePreview(c, e), after: pricePreview(c, withRerunValues(e, t.payload.newValues || {})) };
  }
  return { task: { ...t, action: TASK_ACTION[t.task_flow] }, company: c, employee: e, preview };
}

/** CS decides a task: approve applies it, reject closes it with no change. */
export async function decideTask(ws, id, { decision, note = '' }, actor = 'CS') {
  if (!['approve', 'reject'].includes(decision)) throw new PortalError('Decision must be approve or reject.');
  return transaction(async (db) => {
    const { rows: [t] } = await db.query('SELECT * FROM cs_tasks WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [id, ws]);
    if (!t) throw Object.assign(new Error('Task not found'), { status: 404 });
    if (t.status !== 'Open') throw new PortalError('This task is already resolved.');
    const c = await getCompany(db, ws, t.company_id);
    let e = t.employee_id ? await employeeById(db, ws, t.employee_id) : null;
    let summary = 'Rejected';
    if (decision === 'reject') {
      if (e) await db.query('UPDATE employees SET pending_status_change = NULL WHERE id = $1', [e.id]);
    } else if (t.task_flow === 'New Hire') {
      if (!(c.products || []).length) throw new PortalError('Tag the client\'s products before pricing new hires.');
      const p = pricePreview(c, e);
      await db.query('UPDATE employees SET eligibility = $2, go_live_date = $3 WHERE id = $1', [e.id, p.label, p.eligible ? (c.go_live_date && c.go_live_date > today() ? c.go_live_date : firstOfNextMonth()) : null]);
      await setEmployeeStatus(db, ws, e, p.status, { reason: 'New hire priced', actor, products: p.products });
      await log(db, ws, c.id, 'New hire priced', { employeeNumber: e.employee_number, eligible: p.eligible }, actor, e.id);
      summary = p.eligible ? `Priced: ${Object.entries(p.products).map(([k, v]) => `${k} $${v}`).join(', ')}` : `Not eligible: ${p.label}`;
    } else if (t.task_flow === 'Eligibility Rerun Request') {
      const updated = withRerunValues(e, t.payload.newValues || {});
      await db.query('UPDATE employees SET w4 = $2, standard_hours = $3, pay_rate = $4, employment_type = $5 WHERE id = $1',
        [e.id, updated.w4, updated.standard_hours, updated.pay_rate, updated.employment_type]);
      const p = pricePreview(c, updated);
      await db.query('UPDATE employees SET eligibility = $2 WHERE id = $1', [e.id, p.label]);
      if (p.status !== e.census_status || JSON.stringify(p.products) !== JSON.stringify(e.products)) {
        await setEmployeeStatus(db, ws, e, p.status, { reason: 'Eligibility rerun', actor, products: p.products });
      }
      await log(db, ws, c.id, 'Pricing recomputed', { employeeNumber: e.employee_number, reason: 'Eligibility rerun' }, actor, e.id);
      summary = p.eligible ? 'Rerun approved: still eligible, repriced' : `Rerun approved: ${p.label}`;
    } else if (t.task_flow === 'Product Change') {
      const drop = t.payload.drop || [];
      const products = Object.fromEntries(Object.entries(e.products || {}).filter(([code]) => !drop.includes(code)));
      if (Object.keys(products).length) {
        await db.query('UPDATE employees SET products = $2 WHERE id = $1', [e.id, products]);
        await db.query(`INSERT INTO employee_status_log (workspace_id, company_id, employee_id, from_status, to_status, reason, products, actor)
          VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`, [ws, c.id, e.id, e.census_status, `Dropped ${drop.join(', ')}`, JSON.stringify(products), actor]);
      } else {
        await setEmployeeStatus(db, ws, e, 'Opted out', { reason: 'Opted out of every product', actor, products: {} });
      }
      await log(db, ws, c.id, 'Product change', { employeeNumber: e.employee_number, drop }, actor, e.id);
      summary = `Dropped ${drop.join(', ')}`;
    } else if (STATUS_FOR_FLOW[t.task_flow]) {
      const to = STATUS_FOR_FLOW[t.task_flow];
      const keepProducts = to === 'On leave';
      await setEmployeeStatus(db, ws, e, to, { effective: t.payload.effectiveDate || today(), reason: t.payload.reason, actor, products: keepProducts ? undefined : {} });
      await log(db, ws, c.id, `${t.task_flow} request`, { employeeNumber: e.employee_number, effectiveDate: t.payload.effectiveDate }, actor, e.id);
      summary = `${to} effective ${t.payload.effectiveDate || today()}`;
    } else if (t.task_flow === 'Census Confirmation') {
      if (!c.milestones?.census_reconciled) throw new PortalError('Reconcile the census in Census Review first.');
      summary = 'Census confirmed';
    }
    await db.query("UPDATE cs_tasks SET status = 'Resolved', decision = $2, notes = $3, decided_by = $4, decided_at = now() WHERE id = $1",
      [t.id, summary, note || null, actor]);
    await log(db, ws, c.id, 'Task updated', { task: t.id, flow: t.task_flow, decision: summary }, actor, e?.id ?? null);
    return { summary };
  });
}

// ---------- client requests (from the client's roster) ----------

/** Terminate / Unenroll / On leave / Opt out / Eligibility rerun / Product change on one employee. */
export async function clientRequest(ws, companyId, { flow, employeeId, effectiveDate, reason, newValues, drop }) {
  if (!['Terminate', 'Unenroll', 'On leave', 'Opt out', 'Eligibility Rerun Request', 'Product Change'].includes(flow)) throw new PortalError(`Unknown request ${flow}`);
  return transaction(async (db) => {
    const c = await getCompany(db, ws, companyId);
    const e = await employeeById(db, ws, employeeId);
    if (e.company_id !== c.id) throw new PortalError('That employee is not on this roster.');
    const { rows: [open] } = await db.query("SELECT id FROM cs_tasks WHERE employee_id = $1 AND task_flow = $2 AND status = 'Open'", [e.id, flow]);
    if (open) throw new PortalError(`There is already an open ${flow} request for ${e.first_name} ${e.last_name}.`);
    if (STATUS_FOR_FLOW[flow] && !effectiveDate) throw new PortalError('Pick an effective date.');
    if (flow === 'Product Change' && !(drop || []).length) throw new PortalError('Pick at least one product to drop.');
    const payload = { effectiveDate, reason, newValues, drop };
    await createTask(db, ws, { companyId: c.id, employeeId: e.id, flow, payload, triggeredBy: 'Client' });
    if (STATUS_FOR_FLOW[flow]) await db.query('UPDATE employees SET pending_status_change = $2 WHERE id = $1', [e.id, STATUS_FOR_FLOW[flow]]);
    await log(db, ws, c.id, `${flow === 'Eligibility Rerun Request' ? 'Rerun' : flow} request`, { employeeNumber: e.employee_number, effectiveDate, reason }, 'Client', e.id);
    return { ok: true };
  });
}

/** Add New Employee from the client's roster: a New hire on the census plus a New Hire task. */
export async function addNewHire(ws, companyId, b) {
  for (const f of ['first_name', 'last_name', 'birth_date', 'gross_annual']) if (!b[f]) throw new PortalError(`${f.replace('_', ' ')} is required.`);
  return transaction(async (db) => {
    const c = await getCompany(db, ws, companyId);
    const { rows: [{ next }] } = await db.query("SELECT COALESCE(MAX(employee_number::int), 999) + 1 AS next FROM employees WHERE company_id = $1 AND employee_number ~ '^[0-9]+$'", [c.id]);
    const hours = Number(b.avg_hours_per_week) || 40;
    const salaried = b.pay_type === 'salary';
    const { rows: [e] } = await db.query(
      `INSERT INTO employees (workspace_id, company_id, employee_number, first_name, last_name, email, phone, ssn, birth_date, hire_date, address,
         employment_type, pay_type, pay_rate, standard_hours, work_state, w4, state_w4, gender, job_title, location_code, company_code, census_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, '1000', $16, 'New hire') RETURNING *`,
      [ws, c.id, String(next), b.first_name, b.last_name, b.email || null, b.phone || null, b.ssn || null, b.birth_date, b.hire_date || today(),
        { line1: b.address || '', city: b.city || '', state: c.state, zip: b.zip || '' },
        hours < 30 ? 'PT' : 'FT', salaried ? 'salary' : 'hourly', salaried ? Number(b.gross_annual) : Math.round((Number(b.gross_annual) / 52 / hours) * 100) / 100,
        hours, c.state, { filingStatus: b.filing_status || 'single', dependentsCredit: (Number(b.dependents) || 0) * 2200 },
        { filingStatus: b.filing_status === 'married' ? 'married' : 'single', allowances: 0 }, b.gender || null, b.job_title || null]);
    await db.query(`INSERT INTO employee_status_log (workspace_id, company_id, employee_id, from_status, to_status, reason, actor)
      VALUES ($1, $2, $3, NULL, 'New hire', 'Added by client', 'Client')`, [ws, c.id, e.id]);
    await createTask(db, ws, { companyId: c.id, employeeId: e.id, flow: 'New Hire', payload: { startDate: e.hire_date }, triggeredBy: 'Client' });
    await log(db, ws, c.id, 'New-hire request', { employeeNumber: e.employee_number }, 'Client', e.id);
    return e;
  });
}

// ---------- client onboarding documents ----------

export async function acceptTos(ws, id) {
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    await db.query("UPDATE companies SET milestones = milestones || jsonb_build_object('tos_accepted', true, 'tos_accepted_at', now()) WHERE id = $1", [c.id]);
    await log(db, ws, c.id, 'Terms of Service accepted', {}, 'Client');
  });
}

export async function signEngagementLetter(ws, id, b) {
  for (const f of ['by', 'printed_name', 'title', 'city', 'state', 'zip']) if (!b[f]) throw new PortalError('Fill in every engagement letter field.');
  if (!b.agree) throw new PortalError('Confirm you have read the Terms and Conditions.');
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    if (!c.milestones?.tos_accepted) throw new PortalError('Accept the Terms of Service first.');
    const signer = { by: b.by, printed_name: b.printed_name, title: b.title, city: b.city, state: b.state, zip: b.zip, at: new Date().toISOString() };
    await db.query("UPDATE companies SET milestones = milestones || jsonb_build_object('engagement_letter_signed', true, 'engagement_letter', $2::jsonb) WHERE id = $1", [c.id, signer]);
    await log(db, ws, c.id, 'Engagement letter signed', { signer: b.printed_name, title: b.title }, 'Client');
  });
}

// ---------- deductions & reimbursements ----------

/**
 * Per-employee program amounts per paycheck, the portal's Deductions & Reimbursements table.
 * Pre-Tax Well = FGH/FGPT, WIMPER = BPT (the benefits payment back), Post-Tax Well = RWP (products).
 */
export async function deductions(ws, companyId) {
  const c = await getCompany({ query }, ws, companyId);
  const freq = c.pay_frequency;
  return (await employeesOf({ query }, c.id)).map((e) => {
    const products = e.products || {};
    const on = Object.keys(products).length && /^Active/.test(e.census_status || '');
    const plan = on ? perCheck(PROGRAM_PRICING.planMonthly[e.employment_type === 'PT' ? 'partTime' : 'fullTime'], freq) : 0;
    return {
      employeeId: e.id, employeeNumber: e.employee_number, name: `${e.first_name} ${e.last_name}`, status: e.census_status, pending: e.pending_status_change,
      products: Object.keys(products), preTaxWell: plan, wimper: plan, postTaxWell: on ? perCheck(rewardMonthly(products), freq) : 0,
    };
  });
}

// ---------- status reports ----------

/** Employee Status Change: everyone's status as of a date, from the status log. */
export async function statusRoster(ws, { asOf = today(), companyId } = {}) {
  const params = [ws, asOf];
  const companyFilter = companyId ? (params.push(companyId), `AND e.company_id = $${params.length}`) : '';
  const { rows } = await query(
    `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.census_status, e.hire_date, c.name AS company, c.id AS company_id,
       (SELECT l.to_status FROM employee_status_log l WHERE l.employee_id = e.id AND l.effective_date <= $2 ORDER BY l.effective_date DESC, l.id DESC LIMIT 1) AS logged,
       (SELECT l.from_status FROM employee_status_log l WHERE l.employee_id = e.id AND l.effective_date > $2 ORDER BY l.effective_date, l.id LIMIT 1) AS before_next
     FROM employees e JOIN companies c ON c.id = e.company_id
     WHERE e.workspace_id = $1 ${companyFilter} AND (e.hire_date IS NULL OR e.hire_date <= $2) ORDER BY c.name, e.last_name`, params);
  return rows.map((r) => {
    // The latest change effective by that date wins. A change dated later means the person
    // still had its "from" status on that date; with nothing logged, today's status stands.
    const { logged, before_next: beforeNext, ...rest } = r;
    return { ...rest, status: statusGroup(logged || beforeNext || r.census_status) };
  });
}

/** Terminated Employees / Status & Product Changes: the log itself. */
export async function statusChanges(ws, { companyId } = {}) {
  const { rows } = await query(
    `SELECT l.*, e.employee_number, e.first_name, e.last_name, e.location_code, e.products AS current_products, c.name AS company
     FROM employee_status_log l JOIN employees e ON e.id = l.employee_id JOIN companies c ON c.id = l.company_id
     WHERE l.workspace_id = $1 ${companyId ? 'AND l.company_id = $2' : ''} ORDER BY l.effective_date DESC, l.id DESC LIMIT 500`,
    companyId ? [ws, companyId] : [ws]);
  return rows;
}

// ---------- monthly payroll uploads ----------

/** A live client sends last month's payroll register. It becomes this month's reconciliation. */
export async function monthlyUpload(ws, companyId, { month, csv, simulate = false, fileName = 'Payroll register.csv' }, actor = 'Client') {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new PortalError('Pick the payroll month.');
  return transaction(async (db) => {
    const c = await getCompany(db, ws, companyId);
    if (c.onboarding_status !== 'Completed') throw new PortalError('Monthly uploads are for live clients.');
    let rows, problems = [];
    if (simulate) {
      await openReconMonthFor(db, ws, c, month);
      rows = (await db.query("SELECT detail FROM activity_log WHERE company_id = $1 AND action = 'Recon month opened' ORDER BY id DESC LIMIT 1", [c.id])).rows[0].detail.payroll;
    } else {
      try { rows = registerFromCsv(csv); } catch (err) { rows = []; problems.push(err.message); }
      rows.forEach((r, i) => {
        if (!r.emp_id) problems.push(`Row ${i + 2}: no Employee ID.`);
        if (r.gross == null || Number.isNaN(r.gross)) problems.push(`Row ${i + 2}: no Gross Pay.`);
      });
      if (!problems.length) await log(db, ws, c.id, 'Recon month opened', { month, payroll: rows, expected: {} }, actor);
    }
    const status = problems.length ? 'Needs a fix' : 'Ready';
    const { rows: [u] } = await db.query(
      'INSERT INTO monthly_uploads (workspace_id, company_id, month, status, file_name, rows, problems, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status',
      [ws, c.id, month, status, simulate ? `${month} payroll register.csv` : fileName, JSON.stringify(rows), JSON.stringify(problems), actor]);
    await log(db, ws, c.id, 'Payroll ticket', { month, status, file: simulate ? 'simulated' : fileName }, actor);
    return { ...u, problems };
  });
}

export async function listMonthlyUploads(ws, { status, companyId } = {}) {
  const where = ['u.workspace_id = $1'];
  const params = [ws];
  if (status) { params.push(status); where.push(`u.status = $${params.length}`); }
  if (companyId) { params.push(companyId); where.push(`u.company_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT u.id, u.company_id, u.month, u.status, u.file_name, u.problems, u.uploaded_by, u.created_at, jsonb_array_length(u.rows) AS employees, c.name AS company
     FROM monthly_uploads u JOIN companies c ON c.id = u.company_id WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC`, params);
  return rows;
}

export async function markUploadReviewed(ws, id) {
  await query("UPDATE monthly_uploads SET status = 'Reviewed' WHERE id = $1 AND workspace_id = $2 AND status = 'Ready'", [id, ws]);
}

// ---------- dashboard ----------

export async function dashboard(ws) {
  const { rows: [k] } = await query(
    `SELECT (SELECT COUNT(*) FROM companies WHERE workspace_id = $1 AND portal_status = 'Active')::int AS active_companies,
            (SELECT COUNT(*) FROM employees e JOIN companies c ON c.id = e.company_id
              WHERE e.workspace_id = $1 AND c.portal_status = 'Active' AND e.census_status ~ '^Active')::int AS active_employees,
            (SELECT COUNT(*) FROM cs_tasks WHERE workspace_id = $1 AND status = 'Open')::int AS pending_tasks,
            (SELECT COUNT(*) FROM companies WHERE workspace_id = $1 AND onboarding_status <> 'Completed')::int AS onboarding_companies`, [ws]);
  return { kpis: k, tasks: (await listTasks(ws, { status: 'Open' })).slice(0, 25), uploads: (await listMonthlyUploads(ws)).slice(0, 5) };
}

/** Master Census: every employee across clients. */
export async function masterCensus(ws) {
  const { rows } = await query(
    `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.census_status, e.employment_type, e.products, e.go_live_date, e.eligibility,
       e.gender, e.birth_date, e.job_title, e.location_code, e.pending_status_change, c.name AS company, c.id AS company_id, c.pay_frequency
     FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.workspace_id = $1 ORDER BY c.name, e.last_name`, [ws]);
  return rows;
}

