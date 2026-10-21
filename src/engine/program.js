// First Gen program pricing and the launch-day "do no harm" check.
import { PAY_PERIODS } from './taxTables2026.js';
import { calcPaycheck } from './payroll.js';

// Monthly amounts in dollars.
export const PROGRAM_PRICING = {
  planMonthly: 1293,
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

/**
 * Builds the three program deduction lines for one employee.
 * benefitsPayment and reward are per-check dollar amounts; how they are priced
 * is still to be confirmed, so callers pass them in.
 */
export function programDeductions({ payFrequency, partTime = false, benefitsPayment = 0, reward = 0, planMonthly = PROGRAM_PRICING.planMonthly }) {
  const codes = partTime ? PROGRAM_CODES.partTime : PROGRAM_CODES.fullTime;
  const lines = [{ code: codes.plan, label: 'First Gen Health Plan', amount: perCheck(planMonthly, payFrequency), kind: 'section125' }];
  if (benefitsPayment) lines.push({ code: codes.benefitsPayment, label: 'Benefits Payment', amount: -Math.abs(benefitsPayment), kind: 'posttax' });
  if (reward) lines.push({ code: codes.reward, label: 'Reward Plan', amount: -Math.abs(reward), kind: 'posttax' });
  return lines;
}

/** Runs a paycheck with and without the program and flags anything that would block launch. */
export function compareWithProgram({ employee, earnings, deductions = [], ytd, program }) {
  const before = calcPaycheck({ employee, earnings, deductions, ytd });
  const after = calcPaycheck({ employee, earnings, deductions: [...deductions, ...program], ytd });
  const issues = [...after.warnings];
  if (after.netPay < before.netPay) issues.push('NET_PAY_DECREASE');
  if (after.taxes.some((t) => t.amount < 0)) issues.push('NEGATIVE_TAX');
  return { before, after, netChange: after.netPay - before.netPay, issues, ok: issues.length === 0 };
}
