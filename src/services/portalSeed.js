// Puts each sandbox's clients at different points in the onboarding pipeline:
//   NY (weekly)      Completed and live: used for launch files and monthly recon
//   NJ (biweekly)    Census: a client census upload with gaps and errors to reconcile
//   CA (semimonthly) Payroll Docs: an extracted payroll register waiting in the review queue
// Every random choice comes from the seeded faker, so scenario sandboxes repeat exactly.
import { faker } from './fake.js';
import { calcPaycheck } from '../engine/payroll.js';
import { PAY_PERIODS } from '../engine/taxTables2026.js';
import { calculatorRow } from '../engine/calculator.js';

const pick = (items) => faker.helpers.arrayElement(items);
const round2 = (n) => Math.round(n * 100) / 100;

export function firstOfNextMonth(from = new Date()) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function grossPerPeriod(e, freq) {
  const periods = PAY_PERIODS[freq];
  return e.pay_type === 'salary' ? round2(Number(e.pay_rate) / periods) : round2(Number(e.pay_rate) * Number(e.standard_hours) * (52 / periods));
}

/** What a payroll register line for this employee really says (one period). */
export function registerLine(e, freq) {
  const gross = grossPerPeriod(e, freq);
  const check = calcPaycheck({
    employee: { workState: e.work_state, payFrequency: freq, w4: e.w4, stateW4: e.state_w4 },
    earnings: [{ code: 'REG', label: 'Regular', amount: gross }],
  });
  const tax = (code) => (check.taxes.find((t) => t.code === code)?.amount || 0) / 100;
  return {
    emp_id: e.employee_number,
    first_name: e.first_name,
    last_name: e.last_name,
    gross,
    reimb: 0,
    pay_freq: freq,
    emp_type: e.pay_type === 'salary' ? 'Salary' : 'Hourly',
    avg_hrs: e.pay_type === 'salary' ? round2(40 * (52 / PAY_PERIODS[freq])) : round2(Number(e.standard_hours) * (52 / PAY_PERIODS[freq])),
    rate: e.pay_type === 'salary' ? null : Number(e.pay_rate),
    fed_filing: e.w4.filingStatus,
    dependents: e.w4.dependentsCredit ? Math.round(e.w4.dependentsCredit / 2200) : 0,
    state_filing: e.state_w4.filingStatus,
    work_state: e.work_state,
    fed_tax: tax('FIT'),
    ss: tax('SS'),
    medicare: tax('MED'),
    state_tax: tax(`${e.work_state}_SIT`),
    net_pay: check.netPay / 100,
  };
}

// Extraction mistakes the trainee must catch against the source register.
const EXTRACTION_ERRORS = [
  { field: 'gross', apply: (r) => ({ ...r, gross: Number(String(Math.round(r.gross * 100)).replace(/(\d)(\d)(\d\d)$/, '$2$1$3')) / 100 }), note: 'Low confidence: digits' },
  { field: 'fed_filing', apply: (r) => ({ ...r, fed_filing: null }), note: 'Missing federal filing status' },
  // Someone who really pays no state tax gets a made-up amount instead, so the cell is always wrong.
  { field: 'state_tax', apply: (r) => ({ ...r, state_tax: r.state_tax ? 0 : round2(r.gross * 0.04) }), note: (r) => (r.state_tax ? 'State tax not found' : 'Low confidence: amount') },
  { field: 'net_pay', apply: (r) => ({ ...r, net_pay: round2(r.net_pay + 100) }), note: 'Low confidence: amount' },
  { field: 'avg_hrs', apply: (r) => ({ ...r, avg_hrs: null }), note: 'Hours not found' },
];

/**
 * "Extracts" a payroll register the way the document reader would: mostly right, with
 * planted mistakes on flagged cells and two correct cells flagged anyway.
 */
export function simulateExtraction(source) {
  const rows = source.map((r) => ({ ...r, verified: false, flags: [] }));
  const errors = EXTRACTION_ERRORS.slice(0, Math.max(0, rows.length - 2));
  const errorTargets = faker.helpers.arrayElements(rows.map((_, i) => i), errors.length);
  errorTargets.forEach((rowIndex, i) => {
    const err = errors[i];
    const note = typeof err.note === 'function' ? err.note(rows[rowIndex]) : err.note;
    rows[rowIndex] = { ...err.apply(rows[rowIndex]), verified: false, flags: [{ field: err.field, note }] };
  });
  // Two correct values flagged anyway: low confidence doesn't always mean wrong.
  for (const i of faker.helpers.arrayElements(rows.map((_, idx) => idx).filter((idx) => !errorTargets.includes(idx)), 2)) {
    rows[i].flags.push({ field: 'fed_tax', note: 'Low confidence: amount' });
  }
  return rows;
}

export async function seedPortal(client, ws) {
  const { rows: companies } = await client.query('SELECT * FROM companies WHERE workspace_id = $1 ORDER BY id', [ws]);
  const byState = Object.fromEntries(companies.map((c) => [c.state, c]));
  const goLive = firstOfNextMonth();
  const employeesOf = async (c) => (await client.query('SELECT * FROM employees WHERE company_id = $1 ORDER BY employee_number', [c.id])).rows;

  // NY: live client with priced, enrolled employees.
  const ny = byState.NY;
  const nyProducts = [{ code: 'VIRTUAL', price: 149 }, { code: 'MEC', price: pick([55, 65]) }];
  await client.query(
    `UPDATE companies SET onboarding_status = 'Completed', portal_status = 'Active', reflect_group = $2, company_code = 'NY',
       go_live_date = $3, pipedrive_deal_id = $4, contract_products = $5, products = $5,
       contact = $6, milestones = '{"proposal_sent": true, "er_presented": true, "aop_sent": true, "aop_signed": true, "census_reconciled": true, "priced": true, "emails_sent": true, "education_done": true, "audit_passed": true}'
     WHERE id = $1`,
    [ny.id, `1G${faker.string.numeric(3)}`, goLive, faker.string.numeric(5), JSON.stringify(nyProducts),
      { name: faker.person.fullName(), title: 'HR Manager', email: 'hr@example.com', phone: faker.phone.number({ style: 'national' }) }]);
  for (const e of await employeesOf(ny)) {
    const row = calculatorRow({ workState: 'NY', payFrequency: ny.pay_frequency, grossPerPeriod: grossPerPeriod(e, ny.pay_frequency), avgHoursPerPeriod: Number(e.standard_hours), w4: e.w4, stateW4: e.state_w4, partTime: e.employment_type === 'PT' });
    const products = row.eligible
      ? (e.employment_type === 'PT' ? { VIRTUAL: 74, MEC: nyProducts[1].price } : { VIRTUAL: 149, MEC: nyProducts[1].price })
      : {};
    await client.query(
      'UPDATE employees SET go_live_date = $2, products = $3, eligibility = $4, census_status = $5 WHERE id = $1',
      [e.id, goLive, products, row.label, row.eligible ? (e.employment_type === 'PT' ? 'Active PT' : 'Active FT') : 'Ineligible']);
  }

  // NJ: AOP signed, census uploaded and waiting for review. The roster has gaps.
  const nj = byState.NJ;
  await client.query(
    `UPDATE companies SET onboarding_status = 'Census', portal_status = 'Onboarding', company_code = 'NJ', pipedrive_deal_id = $2,
       contract_products = $3, contact = $4, milestones = '{"proposal_sent": true, "er_presented": true, "aop_sent": true, "aop_signed": true}'
     WHERE id = $1`,
    [nj.id, faker.string.numeric(5), JSON.stringify([{ code: 'VIRTUAL', price: 149 }, { code: 'MEC', price: 65 }, { code: 'DENTAL', price: 30 }]),
      { name: faker.person.fullName(), title: 'Owner', email: 'owner@example.com', phone: faker.phone.number({ style: 'national' }) }]);
  const njEmployees = await employeesOf(nj);
  const censusRows = njEmployees.map((e) => ({
    employee_number: e.employee_number, first_name: e.first_name, last_name: e.last_name, birth_date: e.birth_date, gender: e.gender,
    ssn: e.ssn, email: e.email, phone: e.phone, address: e.address, hire_date: e.hire_date, job_title: e.job_title,
    filing_status: e.w4.filingStatus, dependents: e.w4.dependentsCredit ? Math.round(e.w4.dependentsCredit / 2200) : 0,
    gross_annual: e.pay_type === 'salary' ? Number(e.pay_rate) : Math.round(Number(e.pay_rate) * Number(e.standard_hours) * 52),
    avg_hours: Number(e.standard_hours), employment_type: e.employment_type,
  }));
  const answers = {};
  // Leave about 1 in 5 people missing something; the client can answer when asked.
  for (const row of faker.helpers.arrayElements(censusRows, 6)) {
    const field = pick(['gender', 'birth_date', 'filing_status', 'ssn']);
    answers[`${row.employee_number}.${field}`] = row[field];
    row[field] = null;
  }
  // Plant data problems for the audit: a short SSN and a 4-digit ZIP.
  // The client can supply the right values when asked.
  const [shortSsn, badZip] = faker.helpers.arrayElements(censusRows.filter((r) => r.ssn && !answers[`${r.employee_number}.ssn`]), 2);
  answers[`${shortSsn.employee_number}.ssn`] = shortSsn.ssn;
  shortSsn.ssn = shortSsn.ssn.replace(/-/g, '').slice(0, 8);
  answers[`${badZip.employee_number}.address.zip`] = badZip.address.zip;
  badZip.address = { ...badZip.address, zip: badZip.address.zip.slice(1) };
  // The census also has a duplicate person typed twice with a new email.
  const dupe = { ...pick(censusRows), employee_number: String(1000 + censusRows.length), email: 'second.entry@example.com' };
  censusRows.push(dupe);
  await client.query('INSERT INTO census_uploads (workspace_id, company_id, rows, client_answers) VALUES ($1, $2, $3, $4)',
    [ws, nj.id, JSON.stringify(censusRows), answers]);
  // Until the census is reconciled, the roster is missing what the upload is missing.
  for (const row of censusRows.filter((r) => r.gender == null || r.birth_date == null)) {
    await client.query('UPDATE employees SET gender = $3, birth_date = $4 WHERE company_id = $1 AND employee_number = $2',
      [nj.id, row.employee_number, row.gender, row.birth_date]);
  }

  // CA: payroll documents in, extraction waiting for human review.
  const ca = byState.CA;
  await client.query(
    `UPDATE companies SET onboarding_status = 'Payroll Docs', portal_status = 'Onboarding', company_code = 'CA', pipedrive_deal_id = $2,
       contact = $3, milestones = '{}' WHERE id = $1`,
    [ca.id, faker.string.numeric(5), { name: faker.person.fullName(), title: 'Controller', email: 'payroll@example.com', phone: faker.phone.number({ style: 'national' }) }]);
  const source = (await employeesOf(ca)).map((e) => registerLine(e, ca.pay_frequency));
  const rows = simulateExtraction(source);
  await client.query('INSERT INTO payroll_jobs (workspace_id, company_id, source, rows) VALUES ($1, $2, $3, $4)',
    [ws, ca.id, JSON.stringify(source), JSON.stringify(rows)]);
  await client.query(
    "INSERT INTO activity_log (workspace_id, company_id, action, detail, actor) VALUES ($1, $2, 'document.upload', $3, 'Client')",
    [ws, ca.id, { file: 'Payroll Register.pdf' }]);
}
