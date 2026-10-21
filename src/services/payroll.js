// Payroll runs: build each employee's paycheck inputs, calculate, finalize.
// Mock runs never count toward year-to-date totals; finalized full runs do.
import { query, transaction } from '../db/index.js';
import { calcPaycheck } from '../engine/payroll.js';
import { PAY_PERIODS } from '../engine/taxTables2026.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function defaultHours(employee, payFrequency) {
  if (employee.pay_type === 'salary') return null;
  return round2((Number(employee.standard_hours) * 52) / PAY_PERIODS[payFrequency]);
}

/** Turns an employee record plus this run's inputs into engine earnings lines. */
export function buildEarnings(employee, payFrequency, inputs, earningCodes) {
  const byCode = Object.fromEntries(earningCodes.map((c) => [c.code, c]));
  const rate = Number(employee.pay_rate);
  const lines = [];
  if (employee.pay_type === 'salary') {
    lines.push({ code: 'REG', label: 'Regular', amount: round2(rate / PAY_PERIODS[payFrequency]) });
  } else {
    const hours = inputs.hours ?? defaultHours(employee, payFrequency);
    lines.push({ code: 'REG', label: 'Regular', hours, rate, amount: round2(hours * rate) });
    if (inputs.overtimeHours) {
      lines.push({ code: 'OT', label: 'Overtime', hours: inputs.overtimeHours, rate: round2(rate * 1.5), amount: round2(inputs.overtimeHours * rate * 1.5) });
    }
  }
  for (const extra of inputs.extra || []) {
    const code = byCode[extra.code];
    if (!code) throw new Error(`Unknown earning code ${extra.code}`);
    lines.push({ code: code.code, label: code.label, amount: Number(extra.amount), taxable: code.taxable });
  }
  return lines;
}

export function buildDeductions(elections, earnings) {
  const gross = earnings.filter((e) => e.taxable !== false).reduce((t, e) => t + e.amount, 0);
  return elections.map((d) => ({
    code: d.code,
    label: d.label,
    kind: d.kind,
    amount: d.percent != null ? round2((gross * Number(d.percent)) / 100) : Number(d.amount),
  }));
}

async function ytdFor(client, employeeId, year) {
  const { rows } = await client.query(
    `SELECT p.detail FROM paychecks p JOIN payroll_runs r ON r.id = p.payroll_run_id
     WHERE p.employee_id = $1 AND r.run_type = 'full' AND r.status = 'finalized'
       AND EXTRACT(YEAR FROM r.check_date) = $2`,
    [employeeId, year],
  );
  const ytd = { ssWages: 0, medicareWages: 0, futaWages: 0, suiWages: 0, taxes: {}, wages: {}, gross: 0, net: 0 };
  for (const { detail } of rows) {
    const fica = detail.wageBases.fica;
    ytd.ssWages += fica;
    ytd.medicareWages += fica;
    ytd.futaWages += fica;
    ytd.suiWages += fica;
    ytd.gross += detail.grossPay;
    ytd.net += detail.netPay;
    for (const t of detail.taxes) {
      ytd.taxes[t.code] = (ytd.taxes[t.code] || 0) + t.amount;
      ytd.wages[t.code] = (ytd.wages[t.code] || 0) + fica;
    }
  }
  return ytd;
}

export async function createRun({ workspaceId, companyId, runType, periodStart, periodEnd, checkDate }) {
  return transaction(async (client) => {
    const { rows: [run] } = await client.query(
      `INSERT INTO payroll_runs (workspace_id, company_id, run_type, period_start, period_end, check_date)
       SELECT $1, id, $3, $4, $5, $6 FROM companies WHERE id = $2 AND workspace_id = $1 RETURNING *`,
      [workspaceId, companyId, runType, periodStart, periodEnd, checkDate],
    );
    if (!run) throw new Error('Company not found');
    await client.query(
      `INSERT INTO paychecks (workspace_id, payroll_run_id, employee_id)
       SELECT $1, $2, id FROM employees WHERE company_id = $3 AND status = 'active'`,
      [workspaceId, run.id, companyId],
    );
    return run;
  });
}

export async function setPaycheckInputs({ workspaceId, paycheckId, inputs }) {
  const { rows: [row] } = await query(
    `UPDATE paychecks p SET inputs = $3 FROM payroll_runs r
     WHERE p.id = $2 AND p.workspace_id = $1 AND r.id = p.payroll_run_id AND r.status <> 'finalized'
     RETURNING p.*`,
    [workspaceId, paycheckId, inputs],
  );
  if (!row) throw new Error('Paycheck not found or already finalized');
  return row;
}

export async function calculateRun({ workspaceId, runId }) {
  return transaction(async (client) => {
    const { rows: [run] } = await client.query(
      `SELECT r.*, c.pay_frequency FROM payroll_runs r JOIN companies c ON c.id = r.company_id
       WHERE r.id = $1 AND r.workspace_id = $2 FOR UPDATE OF r`,
      [runId, workspaceId],
    );
    if (!run) throw new Error('Run not found');
    if (run.status === 'finalized') throw new Error('Run is already finalized');

    const { rows: earningCodes } = await client.query('SELECT * FROM earning_codes WHERE company_id = $1', [run.company_id]);
    const { rows: checks } = await client.query(
      `SELECT p.id, p.inputs, row_to_json(e) AS employee FROM paychecks p JOIN employees e ON e.id = p.employee_id
       WHERE p.payroll_run_id = $1`,
      [runId],
    );
    const totals = { gross: 0, net: 0, taxes: 0, employerTaxes: 0, preTax: 0, postTax: 0, count: 0, warnings: 0 };
    const year = new Date(run.check_date).getUTCFullYear();

    for (const check of checks) {
      const emp = check.employee;
      const { rows: elections } = await client.query(
        `SELECT d.code, d.label, d.kind, ed.amount, ed.percent FROM employee_deductions ed
         JOIN deduction_codes d ON d.id = ed.deduction_code_id WHERE ed.employee_id = $1 AND ed.active`,
        [emp.id],
      );
      const earnings = buildEarnings(emp, run.pay_frequency, check.inputs, earningCodes);
      const detail = calcPaycheck({
        employee: { workState: emp.work_state, payFrequency: run.pay_frequency, w4: emp.w4, stateW4: emp.state_w4 },
        earnings,
        deductions: buildDeductions(elections, earnings),
        ytd: await ytdFor(client, emp.id, year),
      });
      await client.query('UPDATE paychecks SET detail = $2, gross_cents = $3, net_cents = $4 WHERE id = $1',
        [check.id, detail, detail.grossPay, detail.netPay]);
      totals.gross += detail.grossPay;
      totals.net += detail.netPay;
      totals.taxes += detail.totalTaxes;
      totals.employerTaxes += detail.employerTaxes.reduce((t, x) => t + x.amount, 0);
      totals.preTax += detail.preTaxDeductions.reduce((t, x) => t + x.amount, 0);
      totals.postTax += detail.postTaxDeductions.reduce((t, x) => t + x.amount, 0);
      totals.count += 1;
      totals.warnings += detail.warnings.length;
    }
    const { rows: [updated] } = await client.query(
      "UPDATE payroll_runs SET status = 'calculated', totals = $2 WHERE id = $1 RETURNING *",
      [runId, totals],
    );
    return updated;
  });
}

/** Locks a full run: assigns check numbers and counts it toward YTD. */
export async function finalizeRun({ workspaceId, runId }) {
  return transaction(async (client) => {
    const { rows: [run] } = await client.query(
      'SELECT * FROM payroll_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [runId, workspaceId]);
    if (!run) throw new Error('Run not found');
    if (run.run_type !== 'full') throw new Error('Mock runs cannot be finalized');
    if (run.status !== 'calculated') throw new Error('Calculate the run before finalizing');
    const { rows: [{ max }] } = await client.query(
      `SELECT COALESCE(MAX(p.check_number), 10000) AS max FROM paychecks p
       JOIN payroll_runs r ON r.id = p.payroll_run_id WHERE r.company_id = $1`, [run.company_id]);
    await client.query(
      `UPDATE paychecks p SET check_number = n.num FROM (
         SELECT p2.id, $2::int + ROW_NUMBER() OVER (ORDER BY e.last_name, e.first_name) AS num
         FROM paychecks p2 JOIN employees e ON e.id = p2.employee_id WHERE p2.payroll_run_id = $1
       ) n WHERE p.id = n.id`,
      [runId, max],
    );
    const { rows: [updated] } = await client.query(
      "UPDATE payroll_runs SET status = 'finalized', finalized_at = now() WHERE id = $1 RETURNING *", [runId]);
    return updated;
  });
}

/** Check register: one row per paycheck with every earning, deduction and tax broken out. */
export async function checkRegister({ workspaceId, runId }) {
  const { rows } = await query(
    `SELECT p.id, p.check_number, p.detail, p.inputs, e.employee_number, e.first_name, e.last_name, e.employment_type
     FROM paychecks p JOIN employees e ON e.id = p.employee_id
     WHERE p.payroll_run_id = $1 AND p.workspace_id = $2 ORDER BY e.last_name, e.first_name`,
    [runId, workspaceId],
  );
  return rows;
}
