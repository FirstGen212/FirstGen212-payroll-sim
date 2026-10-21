// Mock payroll "reverse run": models each employee's net pay before and after the
// program and flags who would be harmed, like the portal's Mock Payroll Diagnosis.
import { compareWithProgram, programLines } from './program.js';

export const SEVERITY_PRESETS = {
  standard: { remove: -50, buffer: 5 },
  forward: { remove: -15, buffer: 5 },
};

// Products are dropped in this order when looking for a break-even mix.
const DROP_ORDER = ['VISION', 'DENTAL', 'VIRTUAL', 'MEC'];

/**
 * Classifies a per-paycheck net change (dollars):
 *   REMOVE  delta <= remove threshold: take them out of the program
 *   ADJUST  remove < delta < 0: drop products until they break even
 *   BUFFER  0 <= delta < buffer: technically fine but too close for comfort
 *   OK      delta >= buffer
 */
export function classify(delta, { remove, buffer } = SEVERITY_PRESETS.standard) {
  if (delta <= remove) return 'REMOVE';
  if (delta < 0) return 'ADJUST';
  if (delta < buffer) return 'BUFFER';
  return 'OK';
}

/**
 * employee: { workState, payFrequency, w4, stateW4, partTime }
 * periods: [{ earnings, deductions }] one per pay period in the register
 * products: the employee's elected product codes
 */
export function diagnoseEmployee({ employee, periods, products = [], bptMode, thresholds = SEVERITY_PRESETS.standard }) {
  const run = (prods) => periods.map((p) => compareWithProgram({
    employee,
    earnings: p.earnings,
    deductions: p.deductions || [],
    program: programLines({ payFrequency: employee.payFrequency, partTime: employee.partTime, products: prods, bptMode }),
  }));
  const results = run(products);
  // Worst case across the register's periods.
  const worst = results.reduce((a, b) => (b.netChange < a.netChange ? b : a));
  const worstDelta = worst.netChange / 100;
  const status = worst.issues.includes('NEGATIVE_NET_PAY') || worst.issues.includes('PRETAX_EXCEEDS_TAXABLE_WAGES')
    ? 'REMOVE'
    : classify(worstDelta, thresholds);

  let breakEven = null;
  if (status === 'ADJUST') {
    let remaining = [...products];
    for (const code of DROP_ORDER) {
      if (!remaining.includes(code)) continue;
      remaining = remaining.filter((c) => c !== code);
      const w = run(remaining).reduce((a, b) => (b.netChange < a.netChange ? b : a));
      if (w.netChange >= 0) { breakEven = { keep: remaining, drop: products.filter((p) => !remaining.includes(p)), delta: w.netChange / 100 }; break; }
    }
  }
  return {
    worstDelta,
    deltas: results.map((r) => r.netChange / 100),
    status,
    issues: [...new Set(results.flatMap((r) => r.issues))],
    breakEven,
  };
}
