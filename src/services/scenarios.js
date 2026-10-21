// Training scenarios. Each one seeds its own sandbox (same fake data every time,
// via a fixed seed) and grades the sandbox when the trainee submits.
import { perCheck } from '../engine/program.js';

const company = async (db, ws, state) =>
  (await db.query('SELECT * FROM companies WHERE workspace_id = $1 AND state = $2', [ws, state])).rows[0];

const employee = async (db, companyId, number) =>
  (await db.query('SELECT * FROM employees WHERE company_id = $1 AND employee_number = $2', [companyId, number])).rows[0];

const deductionCode = async (db, companyId, code) =>
  (await db.query('SELECT * FROM deduction_codes WHERE company_id = $1 AND UPPER(code) = $2', [companyId, code])).rows[0];

const election = async (db, employeeId, code) =>
  (await db.query(
    `SELECT ed.* FROM employee_deductions ed JOIN deduction_codes d ON d.id = ed.deduction_code_id
     WHERE ed.employee_id = $1 AND UPPER(d.code) = $2 AND ed.active`, [employeeId, code])).rows[0];

const latestRun = async (db, companyId, where = '') =>
  (await db.query(`SELECT * FROM payroll_runs WHERE company_id = $1 ${where} ORDER BY id DESC LIMIT 1`, [companyId])).rows[0];

const paycheck = async (db, runId, employeeId) =>
  (await db.query('SELECT * FROM paychecks WHERE payroll_run_id = $1 AND employee_id = $2', [runId, employeeId])).rows[0];

const near = (a, b) => a != null && Math.abs(Number(a) - Number(b)) < 0.005;
const earningLine = (check, code) => check?.detail?.earnings.find((e) => e.code === code);

const setEmployee = (db, companyId, number, fields) => {
  const cols = Object.keys(fields);
  return db.query(
    `UPDATE employees SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE company_id = $1 AND employee_number = $2`,
    [companyId, number, ...cols.map((c) => fields[c])]);
};

export const SCENARIOS = [
  {
    key: 'employee-update',
    title: 'Update an employee from a client ticket',
    skill: 'Employee records',
    seed: 101,
    instructions: `
      <p>The client <strong>(New York, weekly)</strong> emailed: "Employee <strong>#1007</strong> moved and got married. Please update their file."</p>
      <ul>
        <li>New address: <strong>88 Atlantic Ave, Brooklyn, NY 11201</strong></li>
        <li>New phone: <strong>(555) 201-7788</strong></li>
        <li>New federal W-4: <strong>Married filing jointly</strong>, nothing else changed</li>
      </ul>`,
    checks: [
      { label: 'Street address updated', points: 20, test: async ({ db, ws }) => {
        const e = await employee(db, (await company(db, ws, 'NY')).id, '1007');
        return /^88 atlantic ave/i.test(e.address.line1 || '');
      } },
      { label: 'City and ZIP updated', points: 20, test: async ({ db, ws }) => {
        const e = await employee(db, (await company(db, ws, 'NY')).id, '1007');
        return /brooklyn/i.test(e.address.city || '') && e.address.zip === '11201';
      } },
      { label: 'Phone updated', points: 20, test: async ({ db, ws }) => {
        const e = await employee(db, (await company(db, ws, 'NY')).id, '1007');
        return (e.phone || '').replace(/\D/g, '') === '5552017788';
      } },
      { label: 'Federal filing status is Married filing jointly', points: 40, test: async ({ db, ws }) => {
        const e = await employee(db, (await company(db, ws, 'NY')).id, '1007');
        return e.w4.filingStatus === 'married';
      } },
    ],
  },
  {
    key: 'section125-deduction',
    title: 'Create a Section 125 deduction and enroll an employee',
    skill: 'Deductions setup',
    seed: 202,
    setup: async ({ db, ws }) => {
      const nj = await company(db, ws, 'NJ');
      await setEmployee(db, nj.id, '1004', { employment_type: 'FT', status: 'active' });
    },
    instructions: `
      <p>For the <strong>New Jersey (biweekly)</strong> client, set up the First Gen Health Plan.</p>
      <ol>
        <li>Create deduction code <strong>FGH</strong>, "First Gen Health Plan", as a <strong>Section 125 medical</strong> pre-tax deduction.</li>
        <li>Enroll full-time employee <strong>#1004</strong> in FGH at the correct <strong>per-paycheck</strong> amount. The plan is $1,293 a month.</li>
      </ol>
      <p class="muted">Hint: monthly amount × 12 ÷ pay periods per year.</p>`,
    checks: [
      { label: 'FGH deduction code exists', points: 15, test: async ({ db, ws }) => !!(await deductionCode(db, (await company(db, ws, 'NJ')).id, 'FGH')) },
      { label: 'FGH is pre-tax Section 125', points: 20, test: async ({ db, ws }) => (await deductionCode(db, (await company(db, ws, 'NJ')).id, 'FGH'))?.kind === 'section125' },
      { label: 'FGH category is medical', points: 10, test: async ({ db, ws }) => (await deductionCode(db, (await company(db, ws, 'NJ')).id, 'FGH'))?.category === 'medical' },
      { label: '#1004 is enrolled in FGH', points: 15, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        return !!(await election(db, (await employee(db, nj.id, '1004')).id, 'FGH'));
      } },
      { label: `FGH amount is ${perCheck(1293, 'biweekly')} per biweekly check`, points: 40, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        const d = await election(db, (await employee(db, nj.id, '1004')).id, 'FGH');
        return near(d?.amount, perCheck(1293, 'biweekly'));
      } },
    ],
  },
  {
    key: 'nontaxable-reimbursement',
    title: 'Pay a non-taxable reimbursement in a mock run',
    skill: 'Earnings and mock payroll',
    seed: 303,
    instructions: `
      <p>The <strong>New York (weekly)</strong> client approved a <strong>$86.40</strong> mileage reimbursement for employee <strong>#1002</strong>.
      Mileage at the IRS rate is <strong>not taxable</strong>.</p>
      <ol>
        <li>Create a <strong>mock</strong> payroll (do not run a full payroll).</li>
        <li>Add the reimbursement to #1002 using the correct earning code, then calculate.</li>
        <li>Open #1002's paycheck and confirm the reimbursement did not change their taxes.</li>
      </ol>`,
    checks: [
      { label: 'A mock payroll was calculated', points: 20, test: async ({ db, ws }) => !!(await latestRun(db, (await company(db, ws, 'NY')).id, "AND run_type = 'mock' AND status = 'calculated'")) },
      { label: '#1002 was paid $86.40 as a reimbursement', points: 30, test: async ({ db, ws }) => {
        const ny = await company(db, ws, 'NY');
        const run = await latestRun(db, ny.id, "AND run_type = 'mock' AND status = 'calculated'");
        const line = run && earningLine(await paycheck(db, run.id, (await employee(db, ny.id, '1002')).id), 'REIMB')
          || run && earningLine(await paycheck(db, run.id, (await employee(db, ny.id, '1002')).id), 'REIMBT');
        return line && near(line.amount / 100, 86.40);
      } },
      { label: 'The reimbursement was non-taxable', points: 40, test: async ({ db, ws }) => {
        const ny = await company(db, ws, 'NY');
        const run = await latestRun(db, ny.id, "AND run_type = 'mock' AND status = 'calculated'");
        const line = run && earningLine(await paycheck(db, run.id, (await employee(db, ny.id, '1002')).id), 'REIMB');
        return line && line.taxable === false && near(line.amount / 100, 86.40);
      } },
      { label: 'No full payroll was run by mistake', points: 10, test: async ({ db, ws }) => {
        const ny = await company(db, ws, 'NY');
        return !!(await latestRun(db, ny.id, "AND run_type = 'mock'")) && !(await latestRun(db, ny.id, "AND run_type = 'full'"));
      } },
    ],
  },
  {
    key: 'full-run',
    title: 'Process and finalize a full payroll',
    skill: 'Full payroll and check register',
    seed: 404,
    setup: async ({ db, ws }) => {
      const ca = await company(db, ws, 'CA');
      await setEmployee(db, ca.id, '1006', { pay_type: 'hourly', pay_rate: 24.5, employment_type: 'FT', standard_hours: 40, status: 'active' });
      await setEmployee(db, ca.id, '1010', { status: 'active' });
    },
    instructions: `
      <p>Run this period's payroll for the <strong>California (semi-monthly)</strong> client.</p>
      <ul>
        <li>Employee <strong>#1006</strong> worked <strong>6 overtime hours</strong>.</li>
        <li>Employee <strong>#1010</strong> gets a <strong>$500 bonus</strong>.</li>
      </ul>
      <p>Create a <strong>full</strong> run, enter the inputs, calculate, review the check register, then <strong>finalize</strong>.</p>`,
    checks: [
      { label: 'A full payroll was finalized', points: 30, test: async ({ db, ws }) => !!(await latestRun(db, (await company(db, ws, 'CA')).id, "AND run_type = 'full' AND status = 'finalized'")) },
      { label: '#1006 was paid 6 overtime hours', points: 25, test: async ({ db, ws }) => {
        const ca = await company(db, ws, 'CA');
        const run = await latestRun(db, ca.id, "AND run_type = 'full' AND status = 'finalized'");
        const ot = run && earningLine(await paycheck(db, run.id, (await employee(db, ca.id, '1006')).id), 'OT');
        return ot && Number(ot.hours) === 6;
      } },
      { label: '#1010 was paid a $500 bonus', points: 25, test: async ({ db, ws }) => {
        const ca = await company(db, ws, 'CA');
        const run = await latestRun(db, ca.id, "AND run_type = 'full' AND status = 'finalized'");
        const bonus = run && earningLine(await paycheck(db, run.id, (await employee(db, ca.id, '1010')).id), 'BONUS');
        return bonus && near(bonus.amount / 100, 500);
      } },
      { label: 'Checks were issued with check numbers', points: 20, test: async ({ db, ws }) => {
        const run = await latestRun(db, (await company(db, ws, 'CA')).id, "AND run_type = 'full' AND status = 'finalized'");
        if (!run) return false;
        const { rows: [{ missing }] } = await db.query('SELECT COUNT(*)::int AS missing FROM paychecks WHERE payroll_run_id = $1 AND check_number IS NULL', [run.id]);
        return missing === 0;
      } },
    ],
  },
  {
    key: 'program-launch-mock',
    title: 'Load program deductions and run the launch mock',
    skill: 'Launch',
    seed: 505,
    setup: async ({ db, ws }) => {
      const nj = await company(db, ws, 'NJ');
      await setEmployee(db, nj.id, '1001', { employment_type: 'FT', pay_type: 'hourly', pay_rate: 26, standard_hours: 40, status: 'active' });
      await setEmployee(db, nj.id, '1003', { employment_type: 'PT', pay_type: 'hourly', pay_rate: 21, standard_hours: 28, status: 'active' });
    },
    instructions: `
      <p>The <strong>New Jersey (biweekly)</strong> client is launching. Load the program for two employees, then run a mock to prove no one is harmed.</p>
      <ol>
        <li>Create the deduction codes <strong>FGH</strong> and <strong>FGPT</strong> (pre-tax Section 125), <strong>BPT</strong> and <strong>BPTpt</strong> (post-tax, entered as a negative amount), and <strong>RWP</strong> and <strong>RWPpt</strong> (pre-tax Section 125).</li>
        <li><strong>#1001 (full-time)</strong>: plan $1,293/month, product MEC ($55/month).</li>
        <li><strong>#1003 (part-time)</strong>: plan $780/month, products MEC + Dental ($85/month).</li>
        <li>Enter each code at its per-paycheck amount, then run a <strong>mock</strong> payroll and check for warnings, negative taxes or lower net pay.</li>
      </ol>`,
    checks: [
      { label: 'Program codes created with the right tax treatment', points: 20, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        const want = { FGH: 'section125', FGPT: 'section125', BPT: 'posttax', BPTPT: 'posttax', RWP: 'section125', RWPPT: 'section125' };
        for (const [code, kind] of Object.entries(want)) if ((await deductionCode(db, nj.id, code))?.kind !== kind) return false;
        return true;
      } },
      { label: '#1001 amounts: FGH 596.77, BPT -596.77, RWP 25.38', points: 25, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        const id = (await employee(db, nj.id, '1001')).id;
        return near((await election(db, id, 'FGH'))?.amount, perCheck(1293, 'biweekly'))
          && near((await election(db, id, 'BPT'))?.amount, -perCheck(1293, 'biweekly'))
          && near((await election(db, id, 'RWP'))?.amount, perCheck(55, 'biweekly'));
      } },
      { label: '#1003 amounts: FGPT 360.00, BPTpt -360.00, RWPpt 39.23', points: 25, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        const id = (await employee(db, nj.id, '1003')).id;
        return near((await election(db, id, 'FGPT'))?.amount, perCheck(780, 'biweekly'))
          && near((await election(db, id, 'BPTPT'))?.amount, -perCheck(780, 'biweekly'))
          && near((await election(db, id, 'RWPPT'))?.amount, perCheck(85, 'biweekly'));
      } },
      { label: 'Mock run calculated with no warnings for either employee', points: 30, test: async ({ db, ws }) => {
        const nj = await company(db, ws, 'NJ');
        const run = await latestRun(db, nj.id, "AND run_type = 'mock' AND status = 'calculated'");
        if (!run) return false;
        for (const num of ['1001', '1003']) {
          const check = await paycheck(db, run.id, (await employee(db, nj.id, num)).id);
          const codes = check?.detail?.preTaxDeductions.map((d) => d.code.toUpperCase()) || [];
          if (!codes.some((c) => c.startsWith('FG')) || check.detail.warnings.length) return false;
        }
        return true;
      } },
    ],
  },
];

export const scenarioByKey = (key) => SCENARIOS.find((s) => s.key === key);

export async function gradeScenario(db, scenario, ws) {
  const results = [];
  for (const check of scenario.checks) {
    let passed = false;
    try { passed = !!(await check.test({ db, ws })); } catch { passed = false; }
    results.push({ label: check.label, points: check.points, passed });
  }
  const total = results.reduce((t, r) => t + r.points, 0);
  const earned = results.reduce((t, r) => t + (r.passed ? r.points : 0), 0);
  return { score: Math.round((earned / total) * 1000) / 10, results };
}
