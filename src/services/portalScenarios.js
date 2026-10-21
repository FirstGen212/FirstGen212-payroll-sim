// Employer portal training scenarios: one per stage of the CS flow, each graded
// from the sandbox's portal state. They reuse the standard portal seed:
//   CA starts at Payroll Docs, NJ at Census, NY is live.
import { runCalculator } from '../engine/calculator.js';
import { PAY_PERIODS } from '../engine/taxTables2026.js';
import { jobInputs, launchFiles, mockDiagnosis, audit, openReconMonthFor, sendCensusFor } from './portal.js';
import { firstOfNextMonth } from './portalSeed.js';

const company = async (db, ws, state) =>
  (await db.query('SELECT * FROM companies WHERE workspace_id = $1 AND state = $2', [ws, state])).rows[0];
const employee = async (db, companyId, number) =>
  (await db.query('SELECT * FROM employees WHERE company_id = $1 AND employee_number = $2', [companyId, number])).rows[0];
const latestJob = async (db, companyId) =>
  (await db.query('SELECT * FROM payroll_jobs WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [companyId])).rows[0];
const latestCensus = async (db, companyId) =>
  (await db.query('SELECT * FROM census_uploads WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [companyId])).rows[0];
const logged = async (db, companyId, action) =>
  (await db.query('SELECT * FROM activity_log WHERE company_id = $1 AND action = $2 ORDER BY id DESC LIMIT 1', [companyId, action])).rows[0];

const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const same = (a, b) => (typeof b === 'number' ? near(a, b) : String(a ?? '') === String(b ?? ''));

// The flagged row for one planted extraction error (false flags are on fed_tax).
const plantedRow = (job, field) => job.rows.findIndex((r) => r.flags.some((f) => f.field === field));
const fixedField = (field) => async ({ db, ws }) => {
  const job = await latestJob(db, (await company(db, ws, 'CA')).id);
  const i = plantedRow(job, field);
  return i >= 0 && same(job.rows[i][field], job.source[i][field]);
};

/** What a census value should be once the client's answer is applied, read off the roster. */
function rosterValue(e, field) {
  if (field === 'filing_status') return e.w4?.filingStatus;
  if (field === 'address.zip') return e.address?.zip;
  return e[field];
}

/** Puts the CA review job into the CSM queue exactly as a clean review would leave it. */
async function confirmCaJob(db, ws) {
  const ca = await company(db, ws, 'CA');
  const job = await latestJob(db, ca.id);
  const rows = job.source.map((r, i) => ({ ...r, verified: true, flags: job.rows[i].flags }));
  await db.query("UPDATE payroll_jobs SET rows = $2, queue = 'csm', status = 'Pending' WHERE id = $1", [job.id, JSON.stringify(rows)]);
  await db.query("UPDATE companies SET onboarding_status = 'Awaiting CSM Verification' WHERE id = $1", [ca.id]);
}

/** Reconciles the NJ census the right way: every answer applied, duplicate row dropped. */
async function reconcileNjCensus(db, ws) {
  const nj = await company(db, ws, 'NJ');
  const u = await latestCensus(db, nj.id);
  const rows = u.rows.filter((r) => r.email !== 'second.entry@example.com').map((r) => {
    const row = { ...r, address: { ...r.address } };
    for (const [key, value] of Object.entries(u.client_answers)) {
      const [num, ...path] = key.split('.');
      if (num !== row.employee_number) continue;
      if (path.length === 2) row[path[0]][path[1]] = value; else row[path[0]] = value;
    }
    return row;
  });
  await db.query('UPDATE census_uploads SET rows = $2 WHERE id = $1', [u.id, JSON.stringify(rows)]);
  await sendCensusFor(db, ws, { ...u, rows });
  return nj;
}

export const PORTAL_SCENARIOS = [
  {
    key: 'portal-payroll-review',
    title: 'Review an extracted payroll in the Onboarding Queue',
    skill: 'Portal: pre-onboarding',
    seed: 601,
    instructions: `
      <p>The <strong>California</strong> client uploaded a payroll register. The extraction is waiting in the <strong>Onboarding Queue</strong>.</p>
      <ol>
        <li>Open the review and click <strong>Show source document</strong> to see what the register really says.</li>
        <li>Check every <strong>flagged</strong> cell against the source. Fix what is wrong. Leave what is right.</li>
        <li>Verify each flagged row, then <strong>Confirm &amp; send</strong> to the CSM.</li>
      </ol>
      <p class="muted">Low confidence does not always mean wrong. Don't change correct values.</p>`,
    checks: [
      { label: 'Gross pay digits corrected', points: 14, test: fixedField('gross') },
      { label: 'Missing federal filing status filled in', points: 14, test: fixedField('fed_filing') },
      { label: 'State tax corrected from 0', points: 14, test: fixedField('state_tax') },
      { label: 'Net pay corrected', points: 14, test: fixedField('net_pay') },
      { label: 'Missing hours filled in', points: 14, test: fixedField('avg_hrs') },
      { label: 'Correct values flagged as low confidence were left alone', points: 10, test: async ({ db, ws }) => {
        const job = await latestJob(db, (await company(db, ws, 'CA')).id);
        if (job.queue === 'review') return false;
        const falseFlags = job.rows.map((r, i) => i).filter((i) => job.rows[i].flags.some((f) => f.field === 'fed_tax'));
        return falseFlags.length > 0 && falseFlags.every((i) => near(job.rows[i].fed_tax, job.source[i].fed_tax));
      } },
      { label: 'Payroll confirmed and sent to the CSM', points: 20, test: async ({ db, ws }) =>
        (await latestJob(db, (await company(db, ws, 'CA')).id)).queue !== 'review' },
    ],
  },
  {
    key: 'portal-csm-proposal',
    title: 'Build the proposal in the Proposal Requested Queue',
    skill: 'Portal: pre-onboarding',
    seed: 602,
    setup: async ({ db, ws }) => confirmCaJob(db, ws),
    instructions: `
      <p>The <strong>California</strong> payroll was reviewed and is in the <strong>Proposal Requested</strong> queue.</p>
      <ol>
        <li>Open the job and run the <strong>calculator</strong>.</li>
        <li>Compare the program tiers (159, 149, 139, 129) and pick the one with the <strong>highest 12-month profit</strong>.</li>
        <li><strong>Send the proposal to Pipedrive</strong> at that price, then <strong>mark the job complete</strong>.</li>
      </ol>`,
    checks: [
      { label: 'Proposal sent to Pipedrive', points: 30, test: async ({ db, ws }) =>
        !!(await latestJob(db, (await company(db, ws, 'CA')).id)).proposal },
      { label: 'Proposal uses the tier with the highest 12-month profit', points: 40, test: async ({ db, ws }) => {
        const job = await latestJob(db, (await company(db, ws, 'CA')).id);
        const best = runCalculator(jobInputs(job)).tiers.find((t) => t.best);
        return job.proposal?.programPrice === best.price;
      } },
      { label: 'Job completed and client moved to Proposal Ready', points: 30, test: async ({ db, ws }) => {
        const ca = await company(db, ws, 'CA');
        return (await latestJob(db, ca.id)).queue === 'done' && ca.onboarding_status === 'Proposal Ready';
      } },
    ],
  },
  {
    key: 'portal-census-review',
    title: 'Reconcile a client census upload',
    skill: 'Portal: census',
    seed: 603,
    instructions: `
      <p>The <strong>New Jersey</strong> client signed the AOP and uploaded their census. Open it from <strong>Census Review</strong>.</p>
      <ol>
        <li>Red cells are missing or invalid. Use <strong>Ask client</strong> to get each correct value and enter it.</li>
        <li>Find and delete the <strong>duplicate person</strong>.</li>
        <li><strong>Save &amp; send to CSM</strong>, then advance the client to <strong>Completed</strong> (the census must be at least 90% complete).</li>
      </ol>`,
    checks: [
      { label: 'Census reconciled and sent to the CSM', points: 15, test: async ({ db, ws }) =>
        !!(await company(db, ws, 'NJ')).milestones?.census_reconciled },
      { label: 'Every missing or invalid value fixed with the client\'s answer', points: 50, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        const { client_answers: answers } = await latestCensus(db, nj.id);
        for (const [key, value] of Object.entries(answers)) {
          const [num, ...path] = key.split('.');
          const e = await employee(db, nj.id, num);
          const field = path.join('.');
          const got = rosterValue(e || {}, field);
          if (field === 'ssn' ? digits(got) !== digits(value) : String(got ?? '') !== String(value)) return false;
        }
        return true;
      } },
      { label: 'Duplicate person not added to the roster', points: 20, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        if (!nj.milestones?.census_reconciled) return false;
        const { rows: [{ n }] } = await db.query("SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1 AND email = 'second.entry@example.com'", [nj.id]);
        return n === 0;
      } },
      { label: 'Client advanced to Completed', points: 15, test: async ({ db, ws }) => (await company(db, ws, 'NJ')).onboarding_status === 'Completed' },
    ],
  },
  {
    key: 'portal-pricing-audit',
    title: 'Price the group, pass the data audit and mark good to launch',
    skill: 'Portal: onboarding',
    seed: 604,
    setup: async ({ db, ws }) => {
      const nj = await reconcileNjCensus(db, ws);
      // A location code typo that Reflect would reject.
      await db.query("UPDATE employees SET location_code = '100' WHERE company_id = $1 AND employee_number = '1002'", [nj.id]);
    },
    instructions: `
      <p>The <strong>New Jersey</strong> census is reconciled. Take the client from Census to <strong>good to launch</strong>.</p>
      <ol>
        <li>Advance the client to <strong>Completed</strong>.</li>
        <li>In <strong>Overview</strong>, check the contract and tag exactly the contracted products and prices. Set the <strong>Reflect group</strong> (for example 1G204) and the <strong>Go Live Date</strong>: the 1st of next month.</li>
        <li>On <strong>Pricing &amp; Launch</strong>, run pricing, send the email trigger and complete education.</li>
        <li>Run the <strong>data audit</strong>, fix every red issue in the employee records, then <strong>mark good to launch</strong>.</li>
      </ol>`,
    checks: [
      { label: 'Client advanced to Completed', points: 10, test: async ({ db, ws }) => (await company(db, ws, 'NJ')).onboarding_status === 'Completed' },
      { label: 'Products and prices match the contract', points: 20, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        const key = (list) => (list || []).map((p) => `${p.code}:${Number(p.price)}`).sort().join('|');
        return key(nj.products) !== '' && key(nj.products) === key(nj.contract_products);
      } },
      { label: 'Reflect group set and Go Live Date is the 1st of next month', points: 15, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        return /^[A-Z0-9-]{2,20}$/.test(nj.reflect_group || '') && nj.go_live_date === firstOfNextMonth();
      } },
      { label: 'Roster priced', points: 15, test: async ({ db, ws }) => !!(await company(db, ws, 'NJ')).milestones?.priced },
      { label: 'Email trigger sent and education completed', points: 10, test: async ({ db, ws }) => {
        const m = (await company(db, ws, 'NJ')).milestones || {};
        return !!(m.emails_sent && m.education_done);
      } },
      { label: 'Location code for #1002 fixed', points: 10, test: async ({ db, ws }) =>
        /^[1-9]000$/.test((await employee(db, (await company(db, ws, 'NJ')).id, '1002'))?.location_code || '') },
      { label: 'Data audit clean and marked good to launch', points: 20, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        return !!nj.milestones?.audit_passed && (await audit(ws, nj.id)).red === 0;
      } },
    ],
  },
  {
    key: 'portal-launch',
    title: 'Fix the mock diagnosis and upload the launch files',
    skill: 'Portal: launch',
    seed: 605,
    setup: async ({ db, ws }) => {
      const ny = await company(db, ws, 'NY');
      const set = (num, fields) => db.query(
        `UPDATE employees SET employment_type = 'PT', pay_type = 'hourly', pay_rate = $3, standard_hours = $4, products = $5,
           census_status = 'Active PT', eligibility = 'Eligible', go_live_date = $6 WHERE company_id = $1 AND employee_number = $2`,
        [ny.id, num, fields.rate, fields.hours, fields.products, ny.go_live_date]);
      // One part-timer needs a product dropped; another earns too little for the plan at all.
      await set('1003', { rate: 20, hours: 28, products: { VIRTUAL: 74, MEC: 55, DENTAL: 30, VISION: 20 } });
      await set('1005', { rate: 16.5, hours: 12, products: { VIRTUAL: 74, MEC: 55 } });
    },
    instructions: `
      <p>The <strong>New York (weekly)</strong> client is priced and good to launch. Before the files go in, prove nobody is harmed.</p>
      <ol>
        <li>On <strong>Pricing &amp; Launch</strong>, run the <strong>mock diagnosis</strong>.</li>
        <li>For every <strong>ADJUST</strong>, drop products until they break even. For every <strong>REMOVE</strong>, take them out of the program. Run it again until it's clean.</li>
        <li>Generate the implementation files (FGH/FGPT, BPT/BPTpt, RWP/RWPpt) and <strong>upload them into payroll</strong>. Note the upload week for a weekly client.</li>
        <li>In the payroll system, run a <strong>mock</strong> payroll for this client and check there are no warnings.</li>
      </ol>`,
    checks: [
      { label: 'Mock diagnosis is clean (no ADJUST or REMOVE left)', points: 30, test: async ({ db, ws }) => {
        const ny = await company(db, ws, 'NY');
        return (await mockDiagnosis(ws, ny.id)).results.every((r) => !['ADJUST', 'REMOVE'].includes(r.status));
      } },
      { label: '#1003 kept in the program with only Vision dropped', points: 15, test: async ({ db, ws }) => {
        const e = await employee(db, (await company(db, ws, 'NY')).id, '1003');
        return Object.keys(e.products || {}).sort().join(',') === 'DENTAL,MEC,VIRTUAL';
      } },
      { label: '#1005 removed from the program', points: 10, test: async ({ db, ws }) =>
        !Object.keys((await employee(db, (await company(db, ws, 'NY')).id, '1005')).products || {}).length },
      { label: 'Launch files uploaded after the fixes, with matching amounts', points: 25, test: async ({ db, ws }) => {
        const ny = await company(db, ws, 'NY');
        if (!ny.milestones?.files_uploaded) return false;
        const { files } = await launchFiles(ws, ny.id);
        const { rows } = await db.query(
          `SELECT e.employee_number, UPPER(d.code) AS code, ed.amount FROM employee_deductions ed
             JOIN employees e ON e.id = ed.employee_id JOIN deduction_codes d ON d.id = ed.deduction_code_id
           WHERE e.company_id = $1 AND ed.active AND d.category = 'program'`, [ny.id]);
        const have = new Map(rows.map((r) => [`${r.employee_number}:${r.code}`, Number(r.amount)]));
        const lines = [...files.plan, ...files.benefitsPayment, ...files.reward];
        const removed = rows.filter((r) => r.employee_number === '1005');
        return removed.length === 0 && lines.every((l) => near(have.get(`${l.employee_id}:${l.code.toUpperCase()}`), l.amount));
      } },
      { label: 'Mock payroll run after the upload with no warnings', points: 20, test: async ({ db, ws }) => {
        const ny = await company(db, ws, 'NY');
        const uploaded = await logged(db, ny.id, 'Implementation files uploaded');
        if (!uploaded) return false;
        const { rows: [run] } = await db.query(
          "SELECT * FROM payroll_runs WHERE company_id = $1 AND run_type = 'mock' AND status = 'calculated' AND created_at > $2 ORDER BY id DESC LIMIT 1",
          [ny.id, uploaded.at]);
        if (!run) return false;
        // Only people on the program count; the files are what's being tested.
        const { rows: checks } = await db.query(
          `SELECT p.detail FROM paychecks p JOIN employees e ON e.id = p.employee_id
           WHERE p.payroll_run_id = $1 AND e.products <> '{}'::jsonb`, [run.id]);
        return checks.length > 0 && checks.every((c) => !(c.detail?.warnings || []).length);
      } },
    ],
  },
  {
    key: 'portal-monthly-recon',
    title: 'Run the monthly reconciliation',
    skill: 'Portal: reconciliation',
    seed: 606,
    setup: async ({ db, ws }) => {
      const ny = await company(db, ws, 'NY');
      await openReconMonthFor(db, ws, ny, firstOfNextMonth().slice(0, 7));
    },
    instructions: `
      <p>It's the 1st. This month's payroll for the <strong>New York</strong> client is loaded on <strong>Monthly Recon</strong>.</p>
      <ol>
        <li>Anyone on the census but missing from payroll has left: <strong>terminate</strong> them.</li>
        <li>Anyone whose pay changed: <strong>update their pay</strong> so pricing is recomputed.</li>
        <li>Anyone in payroll but not on the census is a new hire: <strong>add</strong> them, then <strong>price</strong> them.</li>
        <li>Mark the recon <strong>finished</strong>.</li>
      </ol>`,
    checks: (() => {
      const expected = async (db, ws) => {
        const ny = await company(db, ws, 'NY');
        return { ny, month: (await logged(db, ny.id, 'Recon month opened')).detail };
      };
      return [
        { label: 'The leaver was terminated, and nobody else', points: 25, test: async ({ db, ws }) => {
          const { ny, month } = await expected(db, ws);
          const { rows } = await db.query("SELECT employee_number FROM employees WHERE company_id = $1 AND census_status = 'Terminated'", [ny.id]);
          return rows.length === 1 && rows[0].employee_number === month.expected.leaver;
        } },
        { label: 'The pay change was updated', points: 25, test: async ({ db, ws }) => {
          const { ny, month } = await expected(db, ws);
          const p = month.payroll.find((x) => x.emp_id === month.expected.raised);
          const e = await employee(db, ny.id, month.expected.raised);
          return near(e.pay_rate, p.rate ?? p.gross * PAY_PERIODS[ny.pay_frequency]);
        } },
        { label: 'The new hire was added to the census', points: 20, test: async ({ db, ws }) => {
          const { ny, month } = await expected(db, ws);
          return !!(await employee(db, ny.id, month.expected.newHire));
        } },
        { label: 'The new hire was priced', points: 15, test: async ({ db, ws }) => {
          const { ny, month } = await expected(db, ws);
          return !!(await employee(db, ny.id, month.expected.newHire))?.eligibility;
        } },
        { label: 'Recon marked finished', points: 15, test: async ({ db, ws }) => !!(await logged(db, (await company(db, ws, 'NY')).id, 'Recon completed')) },
      ];
    })(),
  },
];
