// Trainee sandboxes: create, seed and reset.
import { query, transaction } from '../db/index.js';
import { withSeed } from './fake.js';
import { seedPortal } from './portalSeed.js';
import { scenarioByKey } from './scenarios.js';
import { DEFAULT_EARNING_CODES, DEFAULT_DEDUCTION_CODES, fakeCompany, fakeEmployee, fakeElections } from './census.js';

/** Generates a company's fake people. */
export function fakePeople(state, count = 25) {
  return Array.from({ length: count }, (_, index) => {
    const emp = fakeEmployee({ state, index });
    return { emp, elections: fakeElections(emp) };
  });
}

export async function createCompany(client, workspaceId, company, people = fakePeople(company.state)) {
  const { rows: [row] } = await client.query(
    `INSERT INTO companies (workspace_id, name, fein, state, pay_frequency, payroll_provider, address)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [workspaceId, company.name, company.fein, company.state, company.pay_frequency, company.payroll_provider, company.address],
  );
  for (const e of DEFAULT_EARNING_CODES) {
    await client.query(
      'INSERT INTO earning_codes (workspace_id, company_id, code, label, category, taxable) VALUES ($1, $2, $3, $4, $5, $6)',
      [workspaceId, row.id, e.code, e.label, e.category, e.taxable],
    );
  }
  const deductionIds = {};
  for (const d of DEFAULT_DEDUCTION_CODES) {
    const { rows: [code] } = await client.query(
      'INSERT INTO deduction_codes (workspace_id, company_id, code, label, kind, category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [workspaceId, row.id, d.code, d.label, d.kind, d.category],
    );
    deductionIds[d.code] = code.id;
  }
  for (const { emp, elections } of people) {
    const { rows: [inserted] } = await client.query(
      `INSERT INTO employees (workspace_id, company_id, employee_number, first_name, last_name, email, phone, ssn,
         birth_date, hire_date, address, employment_type, pay_type, pay_rate, standard_hours, work_state, w4, state_w4,
         gender, job_title, location_code, company_code, census_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING id`,
      [workspaceId, row.id, emp.employee_number, emp.first_name, emp.last_name, emp.email, emp.phone, emp.ssn,
        emp.birth_date, emp.hire_date, emp.address, emp.employment_type, emp.pay_type, emp.pay_rate,
        emp.standard_hours, emp.work_state, emp.w4, emp.state_w4,
        emp.gender, emp.job_title, emp.location_code, emp.company_code, emp.census_status],
    );
    for (const election of elections) {
      await client.query(
        'INSERT INTO employee_deductions (workspace_id, employee_id, deduction_code_id, amount, percent) VALUES ($1, $2, $3, $4, $5)',
        [workspaceId, inserted.id, deductionIds[election.code], election.amount ?? null, election.percent ?? null],
      );
    }
  }
  return row;
}

function seed(client, workspaceId, scenarioKey) {
  const scenario = scenarioByKey(scenarioKey);
  // Scenario sandboxes get the same fake people every time, so instructions can name them.
  return withSeed(scenario?.seed ?? Math.floor(Math.random() * 1e9), async () => {
    // One client company per training state, each on a different pay cycle.
    for (const [state, payFrequency] of [['NY', 'weekly'], ['NJ', 'biweekly'], ['CA', 'semimonthly']]) {
      await createCompany(client, workspaceId, fakeCompany({ state, payFrequency }), fakePeople(state));
    }
    await seedPortal(client, workspaceId);
    if (scenario?.setup) await scenario.setup({ db: client, ws: workspaceId });
  });
}

export async function createWorkspace({ name, userId = null, scenario = null, assignmentId = null }) {
  return transaction(async (client) => {
    const { rows: [ws] } = await client.query(
      'INSERT INTO workspaces (name, user_id, scenario, assignment_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, userId, scenario, assignmentId],
    );
    await seed(client, ws.id, scenario);
    return ws;
  });
}

/** Wipes a sandbox back to a freshly seeded state. */
export async function resetWorkspace(workspaceId) {
  return transaction(async (client) => {
    const { rows: [ws] } = await client.query('SELECT scenario FROM workspaces WHERE id = $1', [workspaceId]);
    await client.query('DELETE FROM companies WHERE workspace_id = $1', [workspaceId]);
    await seed(client, workspaceId, ws?.scenario);
  });
}

export async function listWorkspaces(user) {
  const { rows } = user.role === 'trainer'
    ? await query('SELECT w.*, u.name AS owner FROM workspaces w LEFT JOIN users u ON u.id = w.user_id ORDER BY w.id')
    : await query('SELECT w.*, u.name AS owner FROM workspaces w LEFT JOIN users u ON u.id = w.user_id WHERE w.user_id = $1 ORDER BY w.id', [user.id]);
  return rows;
}

/** Trainers may open any sandbox; trainees only their own. */
export async function canAccessWorkspace(user, workspaceId) {
  if (user.role === 'trainer') return true;
  const { rows } = await query('SELECT 1 FROM workspaces WHERE id = $1 AND user_id = $2', [workspaceId, user.id]);
  return rows.length > 0;
}
