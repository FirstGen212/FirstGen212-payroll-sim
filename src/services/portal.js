// Employer portal simulation: onboarding stages, queues, census, pricing, audit, launch and recon.
import { query, transaction } from '../db/index.js';
import { runAudit, censusCompletion } from '../engine/audit.js';
import { runCalculator, calculatorRow } from '../engine/calculator.js';
import { diagnoseEmployee, SEVERITY_PRESETS } from '../engine/mockDiagnosis.js';
import { perCheck, PROGRAM_PRICING, PROGRAM_CODES, IMPLEMENTATION_WEEK, rewardMonthly } from '../engine/program.js';
import { PAY_PERIODS } from '../engine/taxTables2026.js';
import { registerLine } from './portalSeed.js';

export const ONBOARDING_STATUSES = ['Welcome', 'Payroll Docs', 'Underwriting', 'Awaiting Payroll Confirmation', 'Awaiting CSM Verification',
  'Proposal Ready', 'Eligibility Review', 'Engagement Letter', 'AOP Pending', 'Census', 'Completed'];

const STEPS = ["Let's Get Started", 'Underwriting', 'Proposal Ready', 'Eligibility Review', 'Engagement Letter / AOP', 'Census Submission', 'Completed'];
const STEP_OF = {
  Welcome: 1, 'Payroll Docs': 1, Underwriting: 2, 'Awaiting Payroll Confirmation': 2, 'Awaiting CSM Verification': 2,
  'Proposal Ready': 3, 'Eligibility Review': 4, 'Engagement Letter': 5, 'AOP Pending': 5, Census: 6, Completed: 7,
};

export class PortalError extends Error {
  constructor(message) { super(message); this.status = 409; }
}

export async function log(db, ws, companyId, action, detail = {}, actor = 'CS', employeeId = null) {
  await db.query('INSERT INTO activity_log (workspace_id, company_id, employee_id, action, detail, actor) VALUES ($1, $2, $3, $4, $5, $6)',
    [ws, companyId, employeeId, action, detail, actor]);
}

async function getCompany(db, ws, id) {
  const { rows: [c] } = await db.query('SELECT * FROM companies WHERE id = $1 AND workspace_id = $2', [id, ws]);
  if (!c) throw Object.assign(new Error('Client not found'), { status: 404 });
  return c;
}

const employeesOf = async (db, companyId) =>
  (await db.query("SELECT * FROM employees WHERE company_id = $1 ORDER BY employee_number", [companyId])).rows;

function grossPerPeriod(e, freq) {
  const periods = PAY_PERIODS[freq];
  return e.pay_type === 'salary' ? Number(e.pay_rate) / periods : Number(e.pay_rate) * Number(e.standard_hours) * (52 / periods);
}

function calcInput(e, freq) {
  return {
    name: `${e.first_name} ${e.last_name}`, employeeId: e.employee_number, workState: e.work_state, payFrequency: freq,
    grossPerPeriod: Math.round(grossPerPeriod(e, freq) * 100) / 100,
    avgHoursPerPeriod: Number(e.standard_hours) * (52 / PAY_PERIODS[freq]),
    w4: e.w4, stateW4: e.state_w4, partTime: e.employment_type === 'PT',
  };
}

// ---------- clients and stages ----------

export async function listClients(ws) {
  const { rows } = await query('SELECT * FROM companies WHERE workspace_id = $1 ORDER BY id', [ws]);
  const out = [];
  for (const c of rows) {
    const employees = await employeesOf({ query }, c.id);
    out.push({ ...c, employee_count: employees.length, census_pct: censusCompletion(employees).pct, step: STEP_OF[c.onboarding_status] });
  }
  return out;
}

/** What has to be true before a client can move past its current status. */
async function gate(db, c) {
  const m = c.milestones || {};
  const job = (await db.query('SELECT * FROM payroll_jobs WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [c.id])).rows[0];
  switch (c.onboarding_status) {
    case 'Payroll Docs': return job ? null : 'Waiting on payroll documents from the client.';
    case 'Underwriting': return null;
    case 'Awaiting Payroll Confirmation': return job && job.queue !== 'review' ? null : 'Confirm the extracted payroll in the Onboarding Queue first.';
    case 'Awaiting CSM Verification': return job?.queue === 'done' ? null : 'Build the proposal in the Proposal Requested Queue and mark it complete.';
    case 'Eligibility Review': return m.er_presented ? null : 'Sales has to present the Engagement Report (ER) first.';
    case 'Engagement Letter': return m.aop_sent ? null : 'Send the AOP first.';
    case 'AOP Pending': return m.aop_signed ? null : 'Waiting for the client to sign the AOP.';
    case 'Census': {
      const pct = censusCompletion(await employeesOf(db, c.id)).pct;
      if (!m.census_reconciled) return 'Reconcile the census upload and send it to the CSM first.';
      if (pct < 90) return `Census is ${pct}% complete. It must be at least 90% before pricing.`;
      return null;
    }
    case 'Completed': return 'This client has finished onboarding.';
    default: return null;
  }
}

export async function clientDetail(ws, id) {
  const db = { query };
  const c = await getCompany(db, ws, id);
  const employees = await employeesOf(db, c.id);
  const { rows: activity } = await query('SELECT * FROM activity_log WHERE company_id = $1 ORDER BY id DESC LIMIT 50', [c.id]);
  const step = STEP_OF[c.onboarding_status];
  const idx = ONBOARDING_STATUSES.indexOf(c.onboarding_status);
  return {
    company: c,
    stepper: { step, of: 7, name: STEPS[step - 1], pct: Math.round((step / 7) * 100), next: ONBOARDING_STATUSES[idx + 1] || null, blocked: await gate(db, c) },
    census: censusCompletion(employees),
    employees,
    activity,
  };
}

export async function advance(ws, id) {
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    const blocked = await gate(db, c);
    if (blocked) throw new PortalError(blocked);
    const next = ONBOARDING_STATUSES[ONBOARDING_STATUSES.indexOf(c.onboarding_status) + 1];
    await db.query('UPDATE companies SET onboarding_status = $2 WHERE id = $1', [c.id, next]);
    await log(db, ws, c.id, 'Onboarding advanced', { from: c.onboarding_status, to: next });
    return next;
  });
}

const MILESTONES = {
  er_presented: { action: 'ER presented', actor: 'Sales', requires: (c) => c.onboarding_status === 'Eligibility Review' || 'The ER is presented during Eligibility Review.' },
  aop_sent: { action: 'AOP sent', actor: 'Sales', requires: (c) => (c.milestones.er_presented ? true : 'Present the ER before sending the AOP.') },
  aop_signed: { action: 'AOP signed', actor: 'Client', requires: (c) => (c.milestones.aop_sent ? true : 'The AOP has not been sent.') },
  census_link: { action: 'Census upload link sent', actor: 'CS', requires: (c) => (c.milestones.aop_sent ? true : 'Send census links once the AOP is out.') },
  payroll_access_requested: { action: 'Payroll access requested', actor: 'CS', requires: (c) => (c.milestones.aop_signed ? true : 'Request payroll access after the AOP is signed.') },
  emails_sent: { action: 'Email trigger sent (ActiveCampaign)', actor: 'CS', requires: (c) => (c.milestones.priced ? true : 'Price the group before sending communications.') },
  education_done: { action: 'Education completed', actor: 'CS', requires: (c) => (c.milestones.emails_sent ? true : 'Send the email campaign before education.') },
};

export async function setMilestone(ws, id, name) {
  const def = MILESTONES[name];
  if (!def) throw new PortalError(`Unknown action ${name}`);
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    const ok = def.requires(c);
    if (ok !== true) throw new PortalError(ok);
    await db.query("UPDATE companies SET milestones = milestones || jsonb_build_object($2::text, true) WHERE id = $1", [c.id, name]);
    await log(db, ws, c.id, def.action, {}, def.actor);
    if (name === 'census_link') {
      // The simulated client fills in the link right away.
      const rows = (await employeesOf(db, c.id)).map((e) => ({
        employee_number: e.employee_number, first_name: e.first_name, last_name: e.last_name, birth_date: e.birth_date, gender: e.gender,
        ssn: e.ssn, email: e.email, phone: e.phone, address: e.address, hire_date: e.hire_date, job_title: e.job_title,
        filing_status: e.w4.filingStatus, dependents: e.w4.dependentsCredit ? Math.round(e.w4.dependentsCredit / 2200) : 0,
        gross_annual: e.pay_type === 'salary' ? Number(e.pay_rate) : Math.round(Number(e.pay_rate) * Number(e.standard_hours) * 52),
        avg_hours: Number(e.standard_hours), employment_type: e.employment_type,
      }));
      const answers = {};
      rows.filter((_, i) => i % 6 === 2).forEach((r) => { answers[`${r.employee_number}.gender`] = r.gender; r.gender = null; });
      await db.query('INSERT INTO census_uploads (workspace_id, company_id, rows, client_answers) VALUES ($1, $2, $3, $4)', [ws, c.id, JSON.stringify(rows), answers]);
      await log(db, ws, c.id, 'document.upload', { file: 'Census.xlsx' }, 'Client');
    }
  });
}

const SETTINGS = ['reflect_group', 'company_code', 'go_live_date', 'pipedrive_deal_id', 'contact', 'products', 'name'];

export async function updateClient(ws, id, body) {
  const cols = SETTINGS.filter((k) => body[k] !== undefined);
  if (!cols.length) return getCompany({ query }, ws, id);
  const values = cols.map((k) => (k === 'products' || k === 'contact' ? JSON.stringify(body[k]) : body[k] === '' ? null : body[k]));
  const { rows: [c] } = await query(
    `UPDATE companies SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [id, ws, ...values]);
  if (body.products) await log({ query }, ws, id, 'Product applied', { products: body.products });
  return c;
}

// ---------- onboarding queue (payroll review) and CSM queue ----------

export async function listJobs(ws, queue) {
  const { rows } = await query(
    `SELECT j.id, j.company_id, j.queue, j.status, j.created_at, j.notes, c.name AS company, jsonb_array_length(j.rows) AS employees,
       (SELECT COUNT(*)::int FROM jsonb_array_elements(j.rows) r WHERE jsonb_array_length(r->'flags') > 0 AND NOT (r->>'verified')::boolean) AS flags
     FROM payroll_jobs j JOIN companies c ON c.id = j.company_id WHERE j.workspace_id = $1 AND j.queue = $2 ORDER BY j.created_at`,
    [ws, queue]);
  return rows;
}

async function getJob(db, ws, id) {
  const { rows: [job] } = await db.query('SELECT j.*, c.name AS company, c.pay_frequency FROM payroll_jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = $1 AND j.workspace_id = $2', [id, ws]);
  if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
  return job;
}

export async function jobDetail(ws, id) {
  const job = await getJob({ query }, ws, id);
  // The "source document" view: what the register really says.
  return job;
}

const ROW_FIELDS = ['gross', 'reimb', 'avg_hrs', 'rate', 'fed_filing', 'dependents', 'state_filing', 'fed_tax', 'ss', 'medicare', 'state_tax', 'net_pay'];

export async function updateJobRow(ws, id, index, body) {
  return transaction(async (db) => {
    const job = await getJob(db, ws, id);
    if (job.queue !== 'review') throw new PortalError('This job has left the review queue.');
    const rows = job.rows;
    if (!rows[index]) throw new PortalError('Row not found');
    for (const f of ROW_FIELDS) if (body[f] !== undefined) rows[index][f] = body[f] === '' ? null : body[f];
    if (body.verified !== undefined) rows[index].verified = !!body.verified;
    await db.query("UPDATE payroll_jobs SET rows = $2, status = 'In review' WHERE id = $1", [id, JSON.stringify(rows)]);
    return rows[index];
  });
}

export async function addJobNote(ws, id, text, author) {
  await query("UPDATE payroll_jobs SET notes = notes || jsonb_build_array(jsonb_build_object('text', $2::text, 'author', $3::text, 'at', now())) WHERE id = $1 AND workspace_id = $4",
    [id, text, author, ws]);
}

/** Confirm & send: every flagged row must be verified first. */
export async function confirmJob(ws, id) {
  return transaction(async (db) => {
    const job = await getJob(db, ws, id);
    if (job.queue !== 'review') throw new PortalError('Already confirmed.');
    const open = job.rows.filter((r) => r.flags.length && !r.verified);
    if (open.length) throw new PortalError(`${open.length} flagged row${open.length === 1 ? '' : 's'} still need verifying.`);
    await db.query("UPDATE payroll_jobs SET queue = 'csm', status = 'Pending' WHERE id = $1", [id]);
    await db.query("UPDATE companies SET onboarding_status = 'Awaiting CSM Verification' WHERE id = $1 AND onboarding_status IN ('Payroll Docs', 'Underwriting', 'Awaiting Payroll Confirmation')", [job.company_id]);
    await log(db, ws, job.company_id, 'Payroll finalized', { job: id });
  });
}

export async function pushBackJob(ws, id, reason) {
  return transaction(async (db) => {
    const job = await getJob(db, ws, id);
    await db.query("UPDATE payroll_jobs SET queue = 'review', status = 'Rerun requested' WHERE id = $1", [id]);
    await log(db, ws, job.company_id, 'CSM pushed back', { job: id, reason });
  });
}

function jobInputs(job) {
  return job.rows.map((r) => ({
    name: `${r.first_name} ${r.last_name}`, employeeId: r.emp_id, workState: r.work_state, payFrequency: r.pay_freq,
    grossPerPeriod: Number(r.gross) - Number(r.reimb || 0), avgHoursPerPeriod: r.avg_hrs == null ? null : Number(r.avg_hrs),
    w4: { filingStatus: r.fed_filing || 'single', dependentsCredit: (Number(r.dependents) || 0) * 2200 },
    stateW4: { filingStatus: r.state_filing === 'married' ? 'married' : 'single' },
  }));
}

export async function jobCalculator(ws, id, { programPrice = 149, disabledRules = [] } = {}) {
  const job = await getJob({ query }, ws, id);
  return runCalculator(jobInputs(job), { programPrice, disabledRules });
}

export async function saveProposal(ws, id, { programPrice }) {
  return transaction(async (db) => {
    const job = await getJob(db, ws, id);
    if (job.queue !== 'csm') throw new PortalError('Only jobs in the CSM queue can get a proposal.');
    const result = runCalculator(jobInputs(job), { programPrice: Number(programPrice) });
    const proposal = { programPrice: Number(programPrice), summary: result.summary, sentToPipedrive: true, at: new Date().toISOString() };
    await db.query("UPDATE payroll_jobs SET proposal = $2, status = 'In progress' WHERE id = $1", [id, proposal]);
    await db.query("UPDATE companies SET milestones = milestones || '{\"proposal_sent\": true}' WHERE id = $1", [job.company_id]);
    await log(db, ws, job.company_id, 'CSM started', { programPrice: Number(programPrice) });
    await log(db, ws, job.company_id, 'Proposal sent to Pipedrive', { eligible: result.summary.eligible, programPrice: Number(programPrice) }, 'CS');
    return proposal;
  });
}

export async function completeJob(ws, id) {
  return transaction(async (db) => {
    const job = await getJob(db, ws, id);
    if (!job.proposal) throw new PortalError('Create the proposal and send it to Pipedrive first.');
    await db.query("UPDATE payroll_jobs SET queue = 'done', status = 'Complete' WHERE id = $1", [id]);
    await db.query("UPDATE companies SET onboarding_status = 'Proposal Ready' WHERE id = $1 AND onboarding_status = 'Awaiting CSM Verification'", [job.company_id]);
    await log(db, ws, job.company_id, 'CSM completed', { job: id });
  });
}

// ---------- census review ----------

export async function listCensusUploads(ws) {
  const { rows } = await query(
    `SELECT u.id, u.company_id, u.status, u.created_at, c.name AS company, jsonb_array_length(u.rows) AS employees
     FROM census_uploads u JOIN companies c ON c.id = u.company_id WHERE u.workspace_id = $1 ORDER BY u.id DESC`, [ws]);
  return rows;
}

const CENSUS_FIELDS = ['employee_number', 'first_name', 'last_name', 'birth_date', 'gender', 'ssn', 'email', 'phone', 'hire_date', 'job_title', 'filing_status', 'dependents', 'gross_annual', 'avg_hours', 'employment_type'];

export async function censusUpload(ws, id) {
  const { rows: [u] } = await query('SELECT u.*, c.name AS company FROM census_uploads u JOIN companies c ON c.id = u.company_id WHERE u.id = $1 AND u.workspace_id = $2', [id, ws]);
  if (!u) throw Object.assign(new Error('Census upload not found'), { status: 404 });
  const required = ['first_name', 'last_name', 'birth_date', 'gender', 'ssn', 'hire_date', 'filing_status'];
  const complete = u.rows.filter((r) => required.every((f) => r[f] != null && r[f] !== '') && r.address?.zip).length;
  const { client_answers: _hidden, ...rest } = u;
  return { ...rest, pct: u.rows.length ? Math.round((complete / u.rows.length) * 1000) / 10 : 0 };
}

export async function updateCensusRows(ws, id, rows) {
  await query("UPDATE census_uploads SET rows = $3, status = 'In review' WHERE id = $1 AND workspace_id = $2", [id, ws, JSON.stringify(rows)]);
}

/** "Contact sales rep": the simulated client answers one missing value. */
export async function askClient(ws, id, employeeNumber, field) {
  const { rows: [u] } = await query('SELECT client_answers FROM census_uploads WHERE id = $1 AND workspace_id = $2', [id, ws]);
  const answer = u?.client_answers?.[`${employeeNumber}.${field}`];
  return answer == null
    ? { answer: null, message: 'The client says they sent everything they have for that field.' }
    : { answer, message: `Client replied: ${field.replace('_', ' ')} for #${employeeNumber} is ${answer}.` };
}

/** Save & send to CSM: writes the reviewed census into the roster. */
export async function sendCensus(ws, id) {
  return transaction(async (db) => {
    const { rows: [u] } = await db.query('SELECT * FROM census_uploads WHERE id = $1 AND workspace_id = $2', [id, ws]);
    if (!u) throw Object.assign(new Error('Census upload not found'), { status: 404 });
    let updated = 0, added = 0;
    for (const r of u.rows) {
      const { rows: [existing] } = await db.query('SELECT id, w4 FROM employees WHERE company_id = $1 AND employee_number = $2', [u.company_id, r.employee_number]);
      const ssn = r.ssn && /^\d{9}$/.test(String(r.ssn)) ? String(r.ssn).replace(/(\d{3})(\d{2})(\d{4})/, '$1-$2-$3') : r.ssn;
      if (existing) {
        await db.query(
          `UPDATE employees SET first_name = $2, last_name = $3, birth_date = $4, gender = $5, ssn = $6, email = $7, phone = $8,
             address = $9, hire_date = $10, w4 = w4 || jsonb_build_object('filingStatus', $11::text) WHERE id = $1`,
          [existing.id, r.first_name, r.last_name, r.birth_date || null, r.gender || null, ssn, r.email, r.phone, r.address, r.hire_date || null, r.filing_status || existing.w4.filingStatus]);
        updated++;
      } else {
        const { rows: [c] } = await db.query('SELECT state FROM companies WHERE id = $1', [u.company_id]);
        await db.query(
          `INSERT INTO employees (workspace_id, company_id, employee_number, first_name, last_name, birth_date, gender, ssn, email, phone, address,
             hire_date, employment_type, pay_type, pay_rate, standard_hours, work_state, w4, location_code, company_code, census_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'hourly', $14, $15, $16, $17, '1000', $16, 'Active')`,
          [ws, u.company_id, r.employee_number, r.first_name, r.last_name, r.birth_date || null, r.gender || null, ssn, r.email, r.phone, r.address,
            r.hire_date || null, r.employment_type || 'FT', Math.round((Number(r.gross_annual) / 52 / (Number(r.avg_hours) || 40)) * 100) / 100,
            Number(r.avg_hours) || 40, c.state, { filingStatus: r.filing_status || 'single' }]);
        added++;
      }
    }
    await db.query("UPDATE census_uploads SET status = 'Sent to CSM' WHERE id = $1", [id]);
    await db.query("UPDATE companies SET milestones = milestones || '{\"census_reconciled\": true}' WHERE id = $1", [u.company_id]);
    await log(db, ws, u.company_id, 'Census reconciled', { updated, added });
    return { updated, added };
  });
}

// ---------- pricing, mock diagnosis, audit ----------

/** Run Pricing: eligibility per employee, then products at the client's prices. */
export async function priceRoster(ws, id) {
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    if (!c.products.length) throw new PortalError('Tag the contracted products on the client page first.');
    if (!c.go_live_date) throw new PortalError('Set the Go Live Date in Account Settings first.');
    const priceOf = Object.fromEntries(c.products.map((p) => [p.code, Number(p.price)]));
    let eligible = 0;
    for (const e of await employeesOf(db, c.id)) {
      if (['Terminated', 'Unenrolled', 'Opted out'].includes(e.census_status)) continue;
      const row = calculatorRow(calcInput(e, c.pay_frequency), priceOf.VIRTUAL || 149);
      const pt = e.employment_type === 'PT';
      const products = {};
      if (row.eligible) {
        eligible++;
        for (const [code, price] of Object.entries(priceOf)) products[code] = code === 'VIRTUAL' && pt ? PROGRAM_PRICING.partTimeProducts.VIRTUAL : price;
      }
      await db.query('UPDATE employees SET products = $2, eligibility = $3, census_status = $4, go_live_date = COALESCE(go_live_date, $5) WHERE id = $1',
        [e.id, products, row.label, row.eligible ? (pt ? 'Active PT' : 'Active FT') : 'Ineligible', row.eligible ? c.go_live_date : null]);
    }
    await db.query("UPDATE companies SET milestones = milestones || '{\"priced\": true}' WHERE id = $1", [c.id]);
    await log(db, ws, c.id, 'Roster priced', { eligible });
    return { eligible };
  });
}

export async function mockDiagnosis(ws, id, { preset = 'standard', bptMode = 'negativeDeduction' } = {}) {
  const c = await getCompany({ query }, ws, id);
  const thresholds = SEVERITY_PRESETS[preset] || SEVERITY_PRESETS.standard;
  const results = [];
  for (const e of await employeesOf({ query }, c.id)) {
    const products = e.products || {};
    if (!Object.keys(products).length) continue;
    const gross = Math.round(grossPerPeriod(e, c.pay_frequency) * 100) / 100;
    // Three pay periods, like pulling 2-3 more payrolls: a normal one, a short week and an overtime week.
    const periods = [1, 0.8, 1.1].map((f) => ({ earnings: [{ code: 'REG', label: 'Regular', amount: Math.round(gross * f * 100) / 100 }] }));
    const d = diagnoseEmployee({
      employee: { workState: e.work_state, payFrequency: c.pay_frequency, w4: e.w4, stateW4: e.state_w4, partTime: e.employment_type === 'PT' },
      periods, products: Object.keys(products), bptMode, thresholds,
    });
    results.push({ employeeId: e.id, employeeNumber: e.employee_number, name: `${e.first_name} ${e.last_name}`, ...d });
  }
  return { thresholds, results };
}

export async function audit(ws, id) {
  const c = await getCompany({ query }, ws, id);
  const employees = await employeesOf({ query }, c.id);
  const { rows: others } = await query(
    'SELECT e.ssn, c.name AS company_name FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.workspace_id = $1 AND e.company_id <> $2', [ws, c.id]);
  return runAudit(c, employees, others);
}

export async function markGoodToLaunch(ws, id) {
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    const m = c.milestones || {};
    if (!m.priced) throw new PortalError('Price the group first.');
    if (!m.education_done) throw new PortalError('Finish communications and education first.');
    const result = await audit(ws, id);
    if (result.red) throw new PortalError(`The data audit still has ${result.red} red issue${result.red === 1 ? '' : 's'}. Fix them before launch.`);
    const pct = censusCompletion(await employeesOf(db, c.id)).pct;
    if (pct < 90) throw new PortalError(`Census is ${pct}% complete; launch needs at least 90%.`);
    await db.query("UPDATE companies SET milestones = milestones || '{\"audit_passed\": true}', portal_status = 'Active' WHERE id = $1", [c.id]);
    await log(db, ws, c.id, 'Good to launch', { amber: result.amber });
    await log(db, ws, c.id, 'Carrier communication started', { carrier: 'Reflect Health' }, 'System');
  });
}

// ---------- launch files ----------

/** The three implementation files, per-check amounts by pay cycle. */
export async function launchFiles(ws, id, { bptMode = 'negativeDeduction' } = {}) {
  const c = await getCompany({ query }, ws, id);
  const freq = c.pay_frequency;
  const lines = { plan: [], benefitsPayment: [], reward: [] };
  for (const e of await employeesOf({ query }, c.id)) {
    const products = e.products || {};
    if (!Object.keys(products).length || !/^Active/.test(e.census_status || '')) continue;
    const pt = e.employment_type === 'PT';
    const codes = pt ? PROGRAM_CODES.partTime : PROGRAM_CODES.fullTime;
    const plan = perCheck(PROGRAM_PRICING.planMonthly[pt ? 'partTime' : 'fullTime'], freq);
    const base = { employee_id: e.employee_number, last_name: e.last_name, first_name: e.first_name };
    lines.plan.push({ ...base, code: codes.plan, amount: plan });
    lines.benefitsPayment.push({ ...base, code: codes.benefitsPayment, amount: bptMode === 'reimbursement' ? plan : -plan, type: bptMode === 'reimbursement' ? 'Earning (non-taxable)' : 'Deduction (negative)' });
    lines.reward.push({ ...base, code: codes.reward, amount: perCheck(rewardMonthly(products), freq) });
  }
  return { payFrequency: freq, implementationWeek: IMPLEMENTATION_WEEK[freq], bptMode, files: lines };
}

/** Uploads the files into the client's payroll (this simulator's payroll side). */
export async function applyLaunchFiles(ws, id, { bptMode = 'negativeDeduction' } = {}) {
  const { files } = await launchFiles(ws, id, { bptMode });
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    const codeId = async (code, label, kind) => {
      const { rows: [row] } = await db.query(
        `INSERT INTO deduction_codes (workspace_id, company_id, code, label, kind, category) VALUES ($1, $2, $3, $4, $5, 'program')
         ON CONFLICT (company_id, code) DO UPDATE SET label = EXCLUDED.label RETURNING id`, [ws, c.id, code, label, kind]);
      return row.id;
    };
    const elect = async (employeeNumber, deductionId, amount) => {
      await db.query(
        `INSERT INTO employee_deductions (workspace_id, employee_id, deduction_code_id, amount, active)
         SELECT $1, e.id, $3, $4, true FROM employees e WHERE e.company_id = $2 AND e.employee_number = $5
         ON CONFLICT (employee_id, deduction_code_id) DO UPDATE SET amount = $4, active = true`, [ws, c.id, deductionId, amount, employeeNumber]);
    };
    for (const l of files.plan) await elect(l.employee_id, await codeId(l.code, 'First Gen Health Plan', 'section125'), l.amount);
    for (const l of files.reward) await elect(l.employee_id, await codeId(l.code, 'Reward Plan', 'section125'), l.amount);
    if (bptMode === 'reimbursement') {
      for (const code of new Set(files.benefitsPayment.map((l) => l.code))) {
        await db.query(`INSERT INTO earning_codes (workspace_id, company_id, code, label, category, taxable) VALUES ($1, $2, $3, 'Benefits Payment', 'reimbursement', false)
          ON CONFLICT (company_id, code) DO NOTHING`, [ws, c.id, code]);
      }
    } else {
      for (const l of files.benefitsPayment) await elect(l.employee_id, await codeId(l.code, 'Benefits Payment', 'posttax'), l.amount);
    }
    await db.query("UPDATE companies SET milestones = milestones || '{\"files_uploaded\": true}' WHERE id = $1", [c.id]);
    await log(db, ws, c.id, 'Implementation files uploaded', { employees: files.plan.length, bptMode });
    return { employees: files.plan.length };
  });
}

// ---------- monthly reconciliation ----------

/**
 * Builds this month's payroll for a live client and compares it with the census:
 * new hires in payroll but not the census, census people missing from payroll, and pay changes.
 */
export async function reconciliation(ws, id) {
  const c = await getCompany({ query }, ws, id);
  const employees = await employeesOf({ query }, c.id);
  const census = employees.filter((e) => !['Terminated', 'Unenrolled', 'Opted out'].includes(e.census_status));
  const { rows: [state] } = await query("SELECT detail FROM activity_log WHERE company_id = $1 AND action = 'Recon month opened' ORDER BY id DESC LIMIT 1", [c.id]);
  if (!state) return { opened: false };
  const month = state.detail;
  const payroll = month.payroll;
  const byId = new Map(payroll.map((p) => [p.emp_id, p]));
  const censusById = new Map(census.map((e) => [e.employee_number, e]));
  const newHires = payroll.filter((p) => !censusById.has(p.emp_id));
  const missing = census.filter((e) => !byId.has(e.employee_number) && e.census_status !== 'Ineligible');
  const payChanges = census.filter((e) => byId.has(e.employee_number)).map((e) => {
    const p = byId.get(e.employee_number);
    const annualCensus = Math.round(grossPerPeriod(e, c.pay_frequency) * PAY_PERIODS[c.pay_frequency]);
    const annualPayroll = Math.round(Number(p.gross) * PAY_PERIODS[c.pay_frequency]);
    return Math.abs(annualCensus - annualPayroll) > 500 ? { employee: e, annualCensus, annualPayroll, payroll: p } : null;
  }).filter(Boolean);
  return { opened: true, month: month.month, payroll, newHires, missing, payChanges };
}

export async function openReconMonth(ws, id, month) {
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    if (c.onboarding_status !== 'Completed') throw new PortalError('Monthly recon is for live clients.');
    const employees = (await employeesOf(db, c.id)).filter((e) => !['Terminated', 'Unenrolled', 'Opted out'].includes(e.census_status));
    // This month's payroll: one person left, one got a raise, and one new hire appeared.
    const payroll = employees.map((e) => registerLine(e, c.pay_frequency));
    const leaverIdx = employees.findIndex((e) => /^Active/.test(e.census_status || ''));
    const leaver = payroll.splice(leaverIdx, 1)[0];
    const raised = payroll.find((p) => p.emp_type === 'Hourly');
    if (raised) { raised.gross = Math.round(raised.gross * 1.18 * 100) / 100; raised.rate = Math.round(raised.rate * 1.18 * 100) / 100; }
    const nextNumber = String(Math.max(...employees.map((e) => Number(e.employee_number) || 0)) + 1);
    payroll.push({ ...payroll[0], emp_id: nextNumber, first_name: 'Jordan', last_name: 'Newhire', gross: 1080, rate: 27, avg_hrs: 40, fed_filing: 'single', dependents: 0 });
    await log(db, ws, c.id, 'Recon month opened', { month, payroll, expected: { leaver: leaver.emp_id, raised: raised?.emp_id, newHire: nextNumber } });
  });
}

export async function reconAction(ws, id, { action, employeeNumber, date }) {
  return transaction(async (db) => {
    const c = await getCompany(db, ws, id);
    const recon = await reconciliation(ws, id);
    if (!recon.opened) throw new PortalError('Open a payroll month first.');
    if (action === 'terminate') {
      await db.query("UPDATE employees SET census_status = 'Terminated', termination_date = $3 WHERE company_id = $1 AND employee_number = $2",
        [c.id, employeeNumber, date || new Date().toISOString().slice(0, 10)]);
      await log(db, ws, c.id, 'Terminate request', { employeeNumber });
    } else if (action === 'update_pay') {
      const p = recon.payroll.find((x) => x.emp_id === employeeNumber);
      if (!p) throw new PortalError('Not in this month\'s payroll.');
      await db.query('UPDATE employees SET pay_rate = $3 WHERE company_id = $1 AND employee_number = $2', [c.id, employeeNumber, p.rate ?? p.gross * PAY_PERIODS[c.pay_frequency]]);
      await log(db, ws, c.id, 'Pricing recomputed', { employeeNumber, reason: 'Pay changed' });
    } else if (action === 'add_new_hire') {
      const p = recon.payroll.find((x) => x.emp_id === employeeNumber);
      if (!p) throw new PortalError('Not in this month\'s payroll.');
      await db.query(
        `INSERT INTO employees (workspace_id, company_id, employee_number, first_name, last_name, address, employment_type, pay_type, pay_rate,
           standard_hours, work_state, w4, location_code, company_code, census_status, hire_date)
         VALUES ($1, $2, $3, $4, $5, '{}', 'FT', 'hourly', $6, 40, $7, $8, '1000', $7, 'New hire', CURRENT_DATE)`,
        [ws, c.id, employeeNumber, p.first_name, p.last_name, p.rate, c.state, { filingStatus: p.fed_filing || 'single' }]);
      await log(db, ws, c.id, 'New-hire request', { employeeNumber });
    } else if (action === 'price_new_hire') {
      const { rows: [e] } = await db.query("SELECT * FROM employees WHERE company_id = $1 AND employee_number = $2", [c.id, employeeNumber]);
      if (!e) throw new PortalError('Add the new hire to the census first.');
      const row = calculatorRow(calcInput(e, c.pay_frequency));
      const priceOf = Object.fromEntries(c.products.map((p) => [p.code, Number(p.price)]));
      await db.query('UPDATE employees SET products = $2, eligibility = $3, census_status = $4, go_live_date = $5 WHERE id = $1',
        [e.id, row.eligible ? priceOf : {}, row.label, row.eligible ? 'Active FT' : 'Ineligible', c.go_live_date]);
      await log(db, ws, c.id, 'New hire priced', { employeeNumber, eligible: row.eligible });
    } else if (action === 'finish') {
      await log(db, ws, c.id, 'Recon completed', { month: recon.month });
    } else {
      throw new PortalError(`Unknown recon action ${action}`);
    }
  });
}

export async function activity(ws, { companyId } = {}) {
  const { rows } = await query(
    `SELECT a.*, c.name AS company FROM activity_log a LEFT JOIN companies c ON c.id = a.company_id
     WHERE a.workspace_id = $1 ${companyId ? 'AND a.company_id = $2' : ''} ORDER BY a.id DESC LIMIT 200`,
    companyId ? [ws, companyId] : [ws]);
  return rows;
}
