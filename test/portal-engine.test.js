import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatorRow, eligibility, runCalculator } from '../src/engine/calculator.js';
import { runAudit, censusCompletion } from '../src/engine/audit.js';
import { classify, diagnoseEmployee } from '../src/engine/mockDiagnosis.js';

const base = { workState: 'NY', payFrequency: 'weekly', w4: { filingStatus: 'single' }, stateW4: { filingStatus: 'single' } };

test('allotment is 75% of the monthly tax FGH saves, and FGH shows per weekly check', () => {
  const row = calculatorRow({ ...base, name: 'A', grossPerPeriod: 1000, avgHoursPerPeriod: 40 });
  assert.equal(row.firstGenPerPeriod, 298.38);
  assert.ok(row.taxPerPeriod < row.taxPreFirstGen);
  assert.equal(row.monthlyAllotment, Math.round((row.annualTaxSavings / 12) * 0.75 * 100) / 100);
  assert.equal(row.label, 'Eligible');
});

test('eligibility rules apply in order', () => {
  const ok = { monthlyAllotment: 200, fedTax: 10, ssTax: 10, stateTax: 10, annualGross: 50000, avgHoursPerPeriod: 40 };
  assert.equal(eligibility(ok).label, 'Eligible');
  assert.equal(eligibility({ ...ok, monthlyAllotment: 450 }).ruleId, 0);
  assert.equal(eligibility({ ...ok, monthlyAllotment: 100, fedTax: 0 }).ruleId, 1);
  assert.equal(eligibility({ ...ok, monthlyAllotment: 100 }).ruleId, 4);
  assert.equal(eligibility({ ...ok, stateTax: 0 }).ruleId, 7);
  assert.equal(eligibility({ ...ok, annualGross: 25000 }).ruleId, 8);
  assert.equal(eligibility({ ...ok, avgHoursPerPeriod: 20 }).ruleId, 9);
  assert.equal(eligibility({ ...ok, avgHoursPerPeriod: 20 }, 149, [9]).label, 'Eligible');
});

test('low earners are not eligible and tiers are reported', () => {
  const result = runCalculator([
    { ...base, name: 'Low', grossPerPeriod: 300, avgHoursPerPeriod: 20 },
    { ...base, name: 'Mid', grossPerPeriod: 1500, avgHoursPerPeriod: 40 },
  ]);
  assert.equal(result.rows[0].eligible, false);
  assert.equal(result.rows[1].eligible, true);
  assert.deepEqual(result.tiers.map((t) => t.price), [159, 149, 139, 129]);
});

const goodEmp = (over = {}) => ({
  id: 1, employee_number: '1001', first_name: 'Ana', last_name: 'Ruiz', ssn: '123-45-6789', birth_date: '1990-01-01', gender: 'F',
  email: 'ana@example.com', phone: '(212) 555-0100', hire_date: '2022-01-01', go_live_date: '2026-11-01', location_code: '1000',
  census_status: 'Active', employment_type: 'FT', pay_type: 'hourly', pay_rate: 25, standard_hours: 40,
  address: { line1: '1 Main St', city: 'Brooklyn', state: 'NY', zip: '11201' }, w4: { filingStatus: 'single' },
  products: { VIRTUAL: 149, MEC: 55 }, ...over,
});
const goodCompany = { reflect_group: '1G012', go_live_date: '2026-11-01', company_code: 'NY', products: [{ code: 'VIRTUAL' }, { code: 'MEC' }] };

test('a clean census has no issues', () => {
  const r = runAudit(goodCompany, [goodEmp(), goodEmp({ id: 2, employee_number: '1002', first_name: 'Bo', ssn: '223-45-6789', email: 'bo@example.com', phone: '2125550101' })]);
  assert.deepEqual(r.issues, []);
});

test('audit catches planted problems', () => {
  const r = runAudit(goodCompany, [
    goodEmp(),
    goodEmp({ id: 2, employee_number: '1001', first_name: 'Bo', ssn: '123-45-6789', email: 'bo@example.com', phone: '2125550101' }),
    goodEmp({ id: 3, employee_number: '1003', first_name: 'Cy', ssn: '912-45-6789', email: 'cy@example.com', phone: '2125550102', location_code: '1500', products: { MEC: 60 }, address: { line1: '1 Main', city: 'X', state: 'NY', zip: '7302' } }),
  ]);
  const msgs = r.issues.map((i) => `${i.employeeId}:${i.field}`);
  assert.ok(msgs.includes('2:ssn'));
  assert.ok(msgs.includes('2:employee_number'));
  assert.ok(msgs.includes('3:ssn'));
  assert.ok(msgs.includes('3:location_code'));
  assert.ok(msgs.includes('3:products'));
  assert.ok(msgs.includes('3:address.zip'));
});

test('census completion counts people with every required field', () => {
  const c = censusCompletion([goodEmp(), goodEmp({ id: 2, gender: null })]);
  assert.equal(c.pct, 50);
});

test('mock diagnosis classifies net changes', () => {
  assert.equal(classify(-60), 'REMOVE');
  assert.equal(classify(-10), 'ADJUST');
  assert.equal(classify(2), 'BUFFER');
  assert.equal(classify(20), 'OK');
  const d = diagnoseEmployee({
    employee: { ...base, payFrequency: 'biweekly' },
    periods: [{ earnings: [{ code: 'REG', amount: 2000 }] }],
    products: ['MEC'],
  });
  assert.equal(d.status, 'OK');
});
