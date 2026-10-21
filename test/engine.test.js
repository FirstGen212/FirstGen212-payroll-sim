import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcPaycheck } from '../src/engine/payroll.js';
import { perCheck, programDeductions, compareWithProgram } from '../src/engine/program.js';

const nyEmployee = { workState: 'NY', payFrequency: 'biweekly', w4: { filingStatus: 'single' }, stateW4: { filingStatus: 'single' } };
const tax = (check, code) => check.taxes.find((t) => t.code === code).amount;
const regular = (amount) => [{ code: 'REG', label: 'Regular', amount }];

test('NY single biweekly $2,000 paycheck', () => {
  const check = calcPaycheck({ employee: nyEmployee, earnings: regular(2000) });
  assert.equal(check.grossPay, 200000);
  assert.equal(tax(check, 'FIT'), 15615);
  assert.equal(tax(check, 'SS'), 12400);
  assert.equal(tax(check, 'MED'), 2900);
  assert.equal(tax(check, 'NY_SIT'), 8800);
  assert.equal(tax(check, 'NY_PFL'), 864);
  assert.equal(tax(check, 'NY_DBL'), 120);
  assert.equal(check.netPay, 200000 - check.totalTaxes);
});

test('Section 125 lowers NJ federal and FICA wages but not NJ state wages', () => {
  const employee = { ...nyEmployee, workState: 'NJ' };
  const check = calcPaycheck({
    employee,
    earnings: regular(2000),
    deductions: [{ code: 'MED125', label: 'Medical', amount: 100, kind: 'section125' }],
  });
  assert.equal(check.wageBases.federal, 190000);
  assert.equal(check.wageBases.fica, 190000);
  assert.equal(check.wageBases.state, 200000);
});

test('401(k) lowers income tax wages but not FICA', () => {
  const check = calcPaycheck({
    employee: { ...nyEmployee, workState: 'CA' },
    earnings: regular(2000),
    deductions: [{ code: '401K', label: '401(k)', amount: 200, kind: 'retirement' }],
  });
  assert.equal(check.wageBases.federal, 180000);
  assert.equal(check.wageBases.state, 180000);
  assert.equal(check.wageBases.fica, 200000);
});

test('Non-taxable reimbursement adds to net pay only', () => {
  const base = calcPaycheck({ employee: nyEmployee, earnings: regular(2000) });
  const withReimb = calcPaycheck({
    employee: nyEmployee,
    earnings: [...regular(2000), { code: 'REIMB', label: 'Reimbursement', amount: 50, taxable: false }],
  });
  assert.equal(withReimb.totalTaxes, base.totalTaxes);
  assert.equal(withReimb.netPay, base.netPay + 5000);
});

test('Taxable reimbursement is taxed', () => {
  const base = calcPaycheck({ employee: nyEmployee, earnings: regular(2000) });
  const withReimb = calcPaycheck({
    employee: nyEmployee,
    earnings: [...regular(2000), { code: 'REIMBT', label: 'Reimbursement (taxable)', amount: 50, taxable: true }],
  });
  assert.ok(withReimb.totalTaxes > base.totalTaxes);
});

test('Social Security stops at the wage base', () => {
  const check = calcPaycheck({ employee: nyEmployee, earnings: regular(5000), ytd: { ssWages: 184000_00 } });
  assert.equal(tax(check, 'SS'), Math.round(50000 * 0.062));
});

test('Program plan amount per check by pay cycle', () => {
  assert.equal(perCheck(1293, 'weekly'), 298.38);
  assert.equal(perCheck(1293, 'biweekly'), 596.77);
  assert.equal(perCheck(1293, 'semimonthly'), 646.5);
  assert.equal(perCheck(1293, 'monthly'), 1293);
});

test('Program codes switch for part-time employees', () => {
  const lines = programDeductions({ payFrequency: 'weekly', partTime: true, benefitsPayment: 250, reward: 10 });
  assert.deepEqual(lines.map((l) => l.code), ['FGPT', 'BPTpt', 'RWPpt']);
});

test('Launch check flags a net pay decrease', () => {
  const result = compareWithProgram({
    employee: nyEmployee,
    earnings: regular(2000),
    program: programDeductions({ payFrequency: 'biweekly' }),
  });
  assert.ok(result.issues.includes('NET_PAY_DECREASE'));
});
