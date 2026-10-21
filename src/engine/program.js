// First Gen program pricing and the launch-day "do no harm" check.
import { PAY_PERIODS } from './taxTables2026.js';
import { calcPaycheck } from './payroll.js';

// Monthly amounts in dollars.
export const PROGRAM_PRICING = {
  planMonthly: { fullTime: 1293, partTime: 780 },
  products: { VIRTUAL: 149, MEC: 55, DENTAL: 30, VISION: 20 },
};

// Deduction codes by employment type, as uploaded to the client's payroll system.
export const PROGRAM_CODES = {
  fullTime: { plan: 'FGH', benefitsPayment: 'BPT', reward: 'RWP' },
  partTime: { plan: 'FGPT', benefitsPayment: 'BPTpt', reward: 'RWPpt' },
};

export function perCheck(monthlyDollars, payFrequency) {
  const periods = PAY_PERIODS[payFrequency];
  if (!periods) throw new Error(`Unknown pay frequency: ${payFrequency}`);
  return Math.round((monthlyDollars * 12 * 100) / periods) / 100;
}

// Week of the month the implementation files go in, by pay cycle.
export const IMPLEMENTATION_WEEK = { weekly: 1, biweekly: 2, semimonthly: 2, monthly: 3 };

// Monthly RWP amount: the sum of the products the employee elected.
export function rewardMonthly(products = []) {
  return products.reduce((total, code) => {
    const price = PROGRAM_PRICING.products[code];
    if (price == null) throw new Error(`Unknown product: ${code}`);
    return total + price;
  }, 0);
}

/**
 * Builds the program lines for one employee.
 *
 * FGH: pre-tax Section 125 plan deduction ($1,293 FT / $780 PT a month).
 * BPT: pays the same amount back, either as a negative deduction or as a
 *      non-taxable reimbursement earning, depending on the payroll system.
 * RWP: the elected products, deducted the same way as FGH.
 * Monthly amounts are spread per check by pay cycle.
 */
export function programLines({ payFrequency, partTime = false, products = [], bptMode = 'negativeDeduction' }) {
  const codes = partTime ? PROGRAM_CODES.partTime : PROGRAM_CODES.fullTime;
  const plan = perCheck(PROGRAM_PRICING.planMonthly[partTime ? 'partTime' : 'fullTime'], payFrequency);
  const deductions = [{ code: codes.plan, label: 'First Gen Health Plan', amount: plan, kind: 'section125' }];
  const earnings = [];
  if (bptMode === 'reimbursement') {
    earnings.push({ code: codes.benefitsPayment, label: 'Benefits Payment', amount: plan, taxable: false });
  } else {
    deductions.push({ code: codes.benefitsPayment, label: 'Benefits Payment', amount: -plan, kind: 'posttax' });
  }
  const reward = rewardMonthly(products);
  if (reward) deductions.push({ code: codes.reward, label: 'Reward Plan', amount: perCheck(reward, payFrequency), kind: 'section125' });
  return { earnings, deductions };
}

/** Runs a paycheck with and without the program and flags anything that would block launch. */
export function compareWithProgram({ employee, earnings, deductions = [], ytd, program }) {
  const before = calcPaycheck({ employee, earnings, deductions, ytd });
  const after = calcPaycheck({
    employee,
    earnings: [...earnings, ...program.earnings],
    deductions: [...deductions, ...program.deductions],
    ytd,
  });
  const issues = [...after.warnings];
  if (after.netPay < before.netPay) issues.push('NET_PAY_DECREASE');
  if (after.taxes.some((t) => t.amount < 0)) issues.push('NEGATIVE_TAX');
  return { before, after, netChange: after.netPay - before.netPay, issues, ok: issues.length === 0 };
}
