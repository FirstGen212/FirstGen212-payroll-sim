// Fake company and census generation. Nothing here is real data: SSNs use the
// 9xx area numbers, which the SSA never issues.
import { faker } from '@faker-js/faker';

export const DEFAULT_EARNING_CODES = [
  { code: 'REG', label: 'Regular', category: 'regular', taxable: true },
  { code: 'OT', label: 'Overtime', category: 'overtime', taxable: true },
  { code: 'BONUS', label: 'Bonus', category: 'bonus', taxable: true },
  { code: 'COMM', label: 'Commission', category: 'commission', taxable: true },
  { code: 'REIMB', label: 'Reimbursement (non-taxable)', category: 'reimbursement', taxable: false },
  { code: 'REIMBT', label: 'Reimbursement (taxable)', category: 'reimbursement', taxable: true },
];

export const DEFAULT_DEDUCTION_CODES = [
  { code: 'MED125', label: 'Medical (Sec 125)', kind: 'section125', category: 'medical' },
  { code: 'DEN125', label: 'Dental (Sec 125)', kind: 'section125', category: 'dental' },
  { code: 'VIS125', label: 'Vision (Sec 125)', kind: 'section125', category: 'vision' },
  { code: '401K', label: '401(k)', kind: 'retirement', category: 'retirement' },
  { code: 'ROTH', label: 'Roth 401(k)', kind: 'posttax', category: 'retirement' },
  { code: 'LOAN', label: '401(k) Loan', kind: 'posttax', category: 'loan' },
  { code: 'GARN', label: 'Wage Garnishment', kind: 'garnishment', category: 'garnishment' },
];

const CITIES = {
  NY: [['Brooklyn', '112'], ['Queens', '113'], ['Bronx', '104'], ['Staten Island', '103'], ['Albany', '122']],
  NJ: [['Newark', '071'], ['Jersey City', '073'], ['Paterson', '075'], ['Trenton', '086'], ['Edison', '088']],
  CA: [['Los Angeles', '900'], ['San Diego', '921'], ['Fresno', '937'], ['Oakland', '946'], ['Sacramento', '958']],
};

const pick = (items) => faker.helpers.arrayElement(items);

export function fakeSsn() {
  return `9${faker.string.numeric(2)}-${faker.string.numeric(2)}-${faker.string.numeric(4)}`;
}

export function fakeAddress(state) {
  const [city, zip3] = pick(CITIES[state]);
  return { line1: faker.location.streetAddress(), city, state, zip: `${zip3}${faker.string.numeric(2)}` };
}

export function fakeCompany({ state = pick(['NY', 'NJ', 'CA']), payFrequency } = {}) {
  return {
    name: `${faker.company.name()} ${pick(['Home Care', 'Logistics', 'Staffing', 'Health Services', 'Hospitality', 'Construction'])}`,
    fein: `${faker.string.numeric(2)}-${faker.string.numeric(7)}`,
    state,
    pay_frequency: payFrequency || pick(['weekly', 'biweekly', 'semimonthly', 'monthly']),
    payroll_provider: pick(['ADP Workforce Now', 'ADP Run', 'Paychex Flex', 'Paylocity', 'Gusto', 'Viventium']),
    address: fakeAddress(state),
  };
}

/** One fake employee. `issues` lets scenarios plant data problems for the audit step. */
export function fakeEmployee({ state, index }) {
  const first = faker.person.firstName();
  const last = faker.person.lastName();
  const partTime = faker.datatype.boolean(0.25);
  const salaried = !partTime && faker.datatype.boolean(0.35);
  const status = pick(['single', 'single', 'married', 'married', 'head']);
  return {
    employee_number: String(1000 + index),
    first_name: first,
    last_name: last,
    email: faker.internet.email({ firstName: first, lastName: last, provider: 'example.com' }).toLowerCase(),
    phone: faker.phone.number({ style: 'national' }),
    ssn: fakeSsn(),
    birth_date: faker.date.birthdate({ min: 19, max: 66, mode: 'age' }).toISOString().slice(0, 10),
    hire_date: faker.date.past({ years: 8 }).toISOString().slice(0, 10),
    address: fakeAddress(state),
    employment_type: partTime ? 'PT' : 'FT',
    pay_type: salaried ? 'salary' : 'hourly',
    pay_rate: salaried ? faker.number.int({ min: 42, max: 125 }) * 1000 : faker.number.float({ min: 16.5, max: 42, fractionDigits: 2 }),
    standard_hours: partTime ? faker.number.int({ min: 16, max: 29 }) : 40,
    work_state: state,
    w4: {
      filingStatus: status,
      step2Checked: status === 'married' && faker.datatype.boolean(0.2),
      dependentsCredit: status !== 'single' && faker.datatype.boolean(0.5) ? 2200 * faker.number.int({ min: 1, max: 3 }) : 0,
      extraWithholding: faker.datatype.boolean(0.1) ? 25 : 0,
    },
    state_w4: { filingStatus: status === 'married' ? 'married' : 'single', allowances: faker.number.int({ min: 0, max: 3 }) },
  };
}

/** Starting deductions for a fake employee, by code. */
export function fakeElections(employee) {
  const elections = [];
  if (employee.employment_type === 'FT' && faker.datatype.boolean(0.55)) {
    elections.push({ code: 'MED125', amount: pick([42.5, 68.75, 95, 140.25]) });
    if (faker.datatype.boolean(0.6)) elections.push({ code: 'DEN125', amount: pick([6.25, 9.8, 14.1]) });
    if (faker.datatype.boolean(0.4)) elections.push({ code: 'VIS125', amount: pick([2.4, 3.75]) });
  }
  if (faker.datatype.boolean(0.35)) elections.push({ code: '401K', percent: pick([3, 4, 5, 6, 8]) });
  if (faker.datatype.boolean(0.05)) elections.push({ code: 'GARN', amount: pick([50, 75, 120]) });
  return elections;
}
