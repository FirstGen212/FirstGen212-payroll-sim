// Proposal calculator: per-employee allotment, eligibility and program economics,
// modeled on the portal's CSM calculator.
import { calcPaycheck } from './payroll.js';
import { PAY_PERIODS } from './taxTables2026.js';
import { perCheck, PROGRAM_PRICING } from './program.js';

export const PROGRAM_TIERS = [159, 149, 139, 129];
export const ALLOTMENT_SHARE = 0.75;
export const EMPLOYER_FICA_RATE = 0.0765;

// Evaluated top to bottom; the first rule that matches decides the result.
export const ELIGIBILITY_RULES = [
  { id: 0, label: 'NEEDS REVIEW', test: (e) => e.monthlyAllotment >= 401 },
  { id: 1, label: 'Not Eligible - Insufficient Savings + No Federal Taxes Paid', test: (e, p) => e.monthlyAllotment < p && e.fedTax < 0.01 },
  { id: 2, label: 'Not Eligible - Insufficient Savings + No Social Security Paid', test: (e, p) => e.monthlyAllotment < p && e.ssTax < 0.01 },
  { id: 3, label: 'Not Eligible - Insufficient Savings + No State Taxes Paid', test: (e, p) => e.monthlyAllotment < p && e.stateTax < 0.01 },
  { id: 4, label: 'Not Eligible - Insufficient Savings', test: (e, p) => e.monthlyAllotment < p },
  { id: 5, label: 'No Federal Taxes Paid', test: (e) => e.fedTax < 0.01 },
  { id: 6, label: 'No Social Security Taxes Paid', test: (e) => e.ssTax < 0.01 },
  { id: 7, label: 'No State Taxes Paid', test: (e) => e.stateTax < 0.01 },
  { id: 8, label: 'Not Eligible - Low Income', test: (e) => e.annualGross <= 26000 },
  { id: 9, label: 'Not Eligible - Insufficient Hours', test: (e) => e.avgHoursPerPeriod != null && e.avgHoursPerPeriod < 23 },
];

export function eligibility(row, programPrice = 149, disabledRules = []) {
  for (const rule of ELIGIBILITY_RULES) {
    if (disabledRules.includes(rule.id)) continue;
    if (rule.test(row, programPrice)) return { eligible: false, ruleId: rule.id, label: rule.label };
  }
  return { eligible: true, ruleId: 10, label: 'Eligible' };
}

/**
 * One employee's calculator row from a single representative paycheck.
 * input: { name, workState, payFrequency, grossPerPeriod, avgHoursPerPeriod, w4, stateW4, preTax: [{code,label,amount,kind}] }
 */
export function calculatorRow(input, programPrice = 149, disabledRules = []) {
  const periods = PAY_PERIODS[input.payFrequency];
  const employee = { workState: input.workState, payFrequency: input.payFrequency, w4: input.w4 || {}, stateW4: input.stateW4 || {} };
  const firstGen = perCheck(PROGRAM_PRICING.planMonthly[input.partTime ? 'partTime' : 'fullTime'], input.payFrequency);
  const earnings = [{ code: 'REG', label: 'Regular', amount: input.grossPerPeriod }];
  const before = calcPaycheck({ employee, earnings, deductions: input.preTax || [] });
  const after = calcPaycheck({
    employee,
    earnings,
    deductions: [...(input.preTax || []), { code: 'FGH', label: 'First Gen Health Plan', amount: firstGen, kind: 'section125' }],
  });
  const tax = (code) => (before.taxes.find((t) => t.code === code)?.amount || 0) / 100;
  // The allotment is funded by the tax the FGH pre-tax deduction saves, not total tax:
  // (annual tax savings / 12) x 75%. That keeps typical allotments in the $129-$159 program range.
  const annualTaxSavings = ((before.totalTaxes - after.totalTaxes) / 100) * periods;
  const row = {
    name: input.name,
    employeeId: input.employeeId,
    workState: input.workState,
    payFrequency: input.payFrequency,
    annualGross: Math.round(input.grossPerPeriod * periods * 100) / 100,
    avgHoursPerPeriod: input.avgHoursPerPeriod ?? null,
    firstGenPerPeriod: firstGen,
    netPerPeriod: after.netPay / 100,
    taxPreFirstGen: before.totalTaxes / 100,
    taxPerPeriod: after.totalTaxes / 100,
    fedTax: tax('FIT'),
    ssTax: tax('SS'),
    medTax: tax('MED'),
    stateTax: tax(`${input.workState}_SIT`),
    annualTax: Math.round((before.totalTaxes / 100) * periods * 100) / 100,
    annualTaxSavings: Math.round(annualTaxSavings * 100) / 100,
    monthlyAllotment: Math.round((annualTaxSavings / 12) * ALLOTMENT_SHARE * 100) / 100,
  };
  row.effectiveRate = row.annualGross ? Math.round((row.annualTax / row.annualGross) * 10000) / 100 : 0;
  return { ...row, ...eligibility(row, programPrice, disabledRules) };
}

/** Runs the whole roster at every program tier, like the Margin Strategy Analyzer. */
export function runCalculator(inputs, { programPrice = 149, disabledRules = [], ebitdaMultiple = 3.8 } = {}) {
  const rows = inputs.map((input) => calculatorRow(input, programPrice, disabledRules));
  const eligibleRows = rows.filter((r) => r.eligible);
  const annualSavingsPerEe = PROGRAM_PRICING.planMonthly.fullTime * 12 * EMPLOYER_FICA_RATE;
  const annualSavings = Math.round(eligibleRows.length * annualSavingsPerEe * 100) / 100;
  const tiers = PROGRAM_TIERS.map((price) => {
    const eligible = inputs.map((i) => calculatorRow(i, price, disabledRules)).filter((r) => r.eligible);
    // Margin: what the allotment funds beyond the program price.
    const allotment = eligible.reduce((t, r) => t + r.monthlyAllotment, 0);
    const revenue = eligible.length * price;
    return {
      price,
      eligible: eligible.length,
      marginPct: allotment ? Math.round(((allotment - revenue) / allotment) * 1000) / 10 : 0,
      twelveMonthProfit: Math.round(revenue * 12 * 100) / 100,
    };
  });
  const best = tiers.reduce((a, b) => (b.twelveMonthProfit > a.twelveMonthProfit ? b : a), tiers[0]);
  return {
    rows,
    tiers: tiers.map((t) => ({ ...t, current: t.price === programPrice, best: t.price === best.price })),
    summary: {
      employees: rows.length,
      eligible: eligibleRows.length,
      eligiblePct: rows.length ? Math.round((eligibleRows.length / rows.length) * 1000) / 10 : 0,
      monthlySavings: Math.round((annualSavings / 12) * 100) / 100,
      annualSavings,
      avgSavingsPerEe: eligibleRows.length ? Math.round((annualSavings / 12 / eligibleRows.length) * 100) / 100 : 0,
      valuationIncrease: Math.round(annualSavings * ebitdaMultiple * 100) / 100,
      allotmentDistribution: {
        under139: rows.filter((r) => r.monthlyAllotment < 139).length,
        from139to149: rows.filter((r) => r.monthlyAllotment >= 139 && r.monthlyAllotment < 149).length,
        over149: rows.filter((r) => r.monthlyAllotment >= 149).length,
      },
    },
  };
}
