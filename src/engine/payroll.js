// Paycheck calculator. All money moves through this module in integer cents.
import { PAY_PERIODS, FICA, FEDERAL, STATES } from './taxTables2026.js';

export const DEDUCTION_KINDS = {
  // Section 125 cafeteria plan (medical, dental, vision, FGH...).
  section125: { fit: true, fica: true, state: true },
  // 401(k) style deferral: income tax only.
  retirement: { fit: true, fica: false, state: true },
  posttax: { fit: false, fica: false, state: false },
  garnishment: { fit: false, fica: false, state: false },
};

export const EMPLOYER_RATES = {
  futaRate: 0.006,
  futaWageBase: 7000,
  sui: {
    NY: { rate: 0.041, wageBase: 17600 },
    NJ: { rate: 0.028, wageBase: 44800 },
    CA: { rate: 0.034, wageBase: 7000 },
  },
};

const toCents = (dollars) => Math.round(dollars * 100);
const sum = (lines) => lines.reduce((total, line) => total + line.amount, 0);

function bracketTax(taxable, brackets, scale = 1) {
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const lower = brackets[i][0] * scale;
    const upper = i + 1 < brackets.length ? brackets[i + 1][0] * scale : Infinity;
    if (taxable <= lower) break;
    tax += (Math.min(taxable, upper) - lower) * brackets[i][1];
  }
  return tax;
}

// IRS Pub 15-T Worksheet 1A (percentage method, 2020+ Form W-4). Returns cents.
export function federalWithholding(periodWagesCents, periods, w4 = {}) {
  if (w4.exempt) return 0;
  const status = w4.filingStatus || 'single';
  const scale = w4.step2Checked ? 0.5 : 1;
  const annual = (periodWagesCents / 100) * periods + (w4.otherIncome || 0) - (w4.deductions || 0);
  const taxable = Math.max(0, annual - FEDERAL.standardDeduction[status] * scale);
  const annualTax = Math.max(0, bracketTax(taxable, FEDERAL.brackets[status], scale) - (w4.dependentsCredit || 0));
  return Math.max(0, toCents(annualTax / periods) + toCents(w4.extraWithholding || 0));
}

export function stateWithholding(state, periodWagesCents, periods, stateW4 = {}) {
  const table = STATES[state];
  if (!table || stateW4.exempt) return 0;
  const status = stateW4.filingStatus === 'married' ? 'married' : 'single';
  const allowances = stateW4.allowances ?? (state === 'CA' ? 1 : 0);
  let annual = (periodWagesCents / 100) * periods - table.deduction[stateW4.filingStatus || 'single'];
  if (table.allowanceValue) annual -= allowances * table.allowanceValue;
  let tax = bracketTax(Math.max(0, annual), table.brackets[status]);
  if (table.exemptionCredit) tax -= allowances * table.exemptionCredit;
  return Math.max(0, toCents(Math.max(0, tax) / periods) + toCents(stateW4.extraWithholding || 0));
}

function capped(rate, wagesCents, ytdWagesCents, wageBase) {
  if (wageBase == null) return Math.round(wagesCents * rate);
  const room = Math.max(0, toCents(wageBase) - ytdWagesCents);
  return Math.round(Math.min(wagesCents, room) * rate);
}

/**
 * Calculates one paycheck.
 *
 * employee: { workState, payFrequency, w4: {filingStatus, step2Checked, dependentsCredit,
 *             otherIncome, deductions, extraWithholding, exempt}, stateW4: {...} }
 * earnings: [{ code, label, amount (dollars), hours?, taxable (default true) }]
 * deductions: [{ code, label, amount (dollars, may be negative), kind }]
 * ytd: prior year-to-date totals in cents { ssWages, medicareWages, futaWages, suiWages, taxes: {CODE: cents}, wages: {CODE: cents} }
 */
export function calcPaycheck({ employee, earnings = [], deductions = [], ytd = {} }) {
  const periods = PAY_PERIODS[employee.payFrequency];
  if (!periods) throw new Error(`Unknown pay frequency: ${employee.payFrequency}`);
  const state = employee.workState;
  const stateTable = STATES[state];
  if (!stateTable) throw new Error(`Unsupported state: ${state}`);

  const earningLines = earnings.map((e) => ({ ...e, amount: toCents(e.amount), taxable: e.taxable !== false }));
  const dedLines = deductions.map((d) => {
    const kind = DEDUCTION_KINDS[d.kind] ? d.kind : 'posttax';
    return { ...d, kind, amount: toCents(d.amount) };
  });

  const grossPay = sum(earningLines);
  const taxableGross = sum(earningLines.filter((e) => e.taxable));
  const preTax = dedLines.filter((d) => d.kind === 'section125' || d.kind === 'retirement');
  const postTax = dedLines.filter((d) => !preTax.includes(d));

  const reduce = (test) => sum(preTax.filter(test));
  const s125 = reduce((d) => d.kind === 'section125');
  const retirement = reduce((d) => d.kind === 'retirement');

  const fitWages = Math.max(0, taxableGross - s125 - retirement);
  const ficaWages = Math.max(0, taxableGross - s125);
  const stateWages = Math.max(0, taxableGross - retirement - (stateTable.section125Exempt ? s125 : 0));

  const taxes = [];
  const add = (code, label, amount) => taxes.push({ code, label, amount: Math.max(0, amount) });

  add('FIT', 'Federal Income Tax', federalWithholding(fitWages, periods, employee.w4));

  const ss = capped(FICA.socialSecurityRate, ficaWages, ytd.ssWages || 0, FICA.socialSecurityWageBase);
  add('SS', 'Social Security', ss);

  const priorMedicare = ytd.medicareWages || 0;
  const overThreshold = Math.max(0, priorMedicare + ficaWages - toCents(FICA.additionalMedicareThreshold))
    - Math.max(0, priorMedicare - toCents(FICA.additionalMedicareThreshold));
  add('MED', 'Medicare', Math.round(ficaWages * FICA.medicareRate + overThreshold * FICA.additionalMedicareRate));

  add(`${state}_SIT`, `${stateTable.name} Income Tax`, stateWithholding(state, stateWages, periods, employee.stateW4));

  for (const t of stateTable.employeeTaxes) {
    const wages = t.section125Exempt ? ficaWages : taxableGross;
    let amount = capped(t.rate, wages, ytd.wages?.[t.code] || 0, t.wageBase);
    if (t.perWeekMax != null) amount = Math.min(amount, toCents((t.perWeekMax * 52) / periods));
    if (t.annualMax != null) amount = Math.min(amount, Math.max(0, toCents(t.annualMax) - (ytd.taxes?.[t.code] || 0)));
    add(t.code, t.label, amount);
  }

  const totalTaxes = sum(taxes);
  const netPay = grossPay - sum(preTax) - totalTaxes - sum(postTax);

  const sui = EMPLOYER_RATES.sui[state];
  const employerTaxes = [
    { code: 'ER_SS', label: 'Social Security (ER)', amount: ss },
    { code: 'ER_MED', label: 'Medicare (ER)', amount: Math.round(ficaWages * FICA.medicareRate) },
    { code: 'FUTA', label: 'FUTA', amount: capped(EMPLOYER_RATES.futaRate, ficaWages, ytd.futaWages || 0, EMPLOYER_RATES.futaWageBase) },
    { code: `${state}_SUI`, label: `${state} SUI`, amount: capped(sui.rate, ficaWages, ytd.suiWages || 0, sui.wageBase) },
  ];

  const warnings = [];
  if (netPay < 0) warnings.push('NEGATIVE_NET_PAY');
  if (taxableGross - s125 - retirement < 0) warnings.push('PRETAX_EXCEEDS_TAXABLE_WAGES');

  return {
    periods,
    grossPay,
    taxableGross,
    earnings: earningLines,
    preTaxDeductions: preTax,
    taxes,
    postTaxDeductions: postTax,
    totalTaxes,
    netPay,
    wageBases: { federal: fitWages, fica: ficaWages, state: stateWages },
    employerTaxes,
    warnings,
  };
}

export const cents = { toCents, fromCents: (c) => c / 100 };
