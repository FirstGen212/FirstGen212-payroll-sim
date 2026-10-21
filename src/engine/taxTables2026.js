// 2026 tax parameters used by the simulator.
//
// TRAINING USE ONLY. Federal figures follow Rev. Proc. 2025-32 and the 2026
// SSA wage base. State withholding is a simplified annualized-bracket model of
// each state's method, close to real paychecks but not a certified calculation.
// Every amount here is in dollars; the engine converts to cents.

export const PAY_PERIODS = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

export const FICA = {
  socialSecurityRate: 0.062,
  socialSecurityWageBase: 184500,
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  additionalMedicareThreshold: 200000,
};

// Brackets are [lower bound of taxable income, rate].
export const FEDERAL = {
  standardDeduction: { single: 16100, married: 32200, head: 24150 },
  brackets: {
    single: [[0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24], [201775, 0.32], [256225, 0.35], [640600, 0.37]],
    married: [[0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24], [403550, 0.32], [512450, 0.35], [768700, 0.37]],
    head: [[0, 0.10], [17700, 0.12], [67450, 0.22], [105700, 0.24], [201750, 0.32], [256200, 0.35], [640600, 0.37]],
  },
  supplementalFlatRate: 0.22,
};

export const STATES = {
  NY: {
    name: 'New York',
    // W-4 "single" and "head" withhold on the single table, like the IT-2104.
    deduction: { single: 7400, married: 7950, head: 7400 },
    allowanceValue: 1000,
    brackets: {
      single: [[0, 0.04], [8500, 0.045], [11700, 0.0525], [13900, 0.055], [80650, 0.06], [215400, 0.0685], [1077550, 0.0965], [5000000, 0.103], [25000000, 0.109]],
      married: [[0, 0.04], [17150, 0.045], [23600, 0.0525], [27900, 0.055], [161550, 0.06], [323200, 0.0685], [2155350, 0.0965], [5000000, 0.103], [25000000, 0.109]],
    },
    // Paid Family Leave and Disability Benefits Law (employee share).
    employeeTaxes: [
      { code: 'NY_PFL', label: 'NY Paid Family Leave', rate: 0.00432, annualMax: 411.91 },
      { code: 'NY_DBL', label: 'NY Disability (SDI)', rate: 0.005, perWeekMax: 0.60 },
    ],
    section125Exempt: true,
  },
  NJ: {
    name: 'New Jersey',
    deduction: { single: 0, married: 0, head: 0 },
    allowanceValue: 1000,
    brackets: {
      single: [[0, 0.015], [20000, 0.02], [35000, 0.039], [40000, 0.061], [75000, 0.07], [500000, 0.099], [1000000, 0.118]],
      married: [[0, 0.015], [20000, 0.02], [50000, 0.027], [70000, 0.039], [80000, 0.061], [150000, 0.07], [500000, 0.099], [1000000, 0.118]],
    },
    employeeTaxes: [
      { code: 'NJ_SDI', label: 'NJ Disability (TDI)', rate: 0.0019, wageBase: 171100 },
      { code: 'NJ_FLI', label: 'NJ Family Leave (FLI)', rate: 0.0023, wageBase: 171100 },
      { code: 'NJ_UI', label: 'NJ Unemployment/WF', rate: 0.00425, wageBase: 44800 },
    ],
    // NJ does not follow the federal cafeteria plan exclusion: Section 125
    // salary reductions stay in NJ taxable wages (NJ TB-39(R)).
    section125Exempt: false,
  },
  CA: {
    name: 'California',
    deduction: { single: 5706, married: 11412, head: 11412 },
    exemptionCredit: 154.20,
    brackets: {
      single: [[0, 0.01], [11079, 0.02], [26264, 0.04], [41452, 0.06], [57542, 0.08], [72724, 0.093], [371479, 0.103], [445771, 0.113], [742953, 0.123], [1000000, 0.133]],
      married: [[0, 0.01], [22158, 0.02], [52528, 0.04], [82904, 0.06], [115084, 0.08], [145448, 0.093], [742958, 0.103], [891542, 0.113], [1485906, 0.123], [2000000, 0.133]],
    },
    employeeTaxes: [
      { code: 'CA_SDI', label: 'CA SDI', rate: 0.013, section125Exempt: true },
    ],
    section125Exempt: true,
  },
};
