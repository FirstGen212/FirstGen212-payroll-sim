// Trainee sandboxes: create, seed and reset.
import { query, transaction } from '../db/index.js';
import { DEFAULT_EARNING_CODES, DEFAULT_DEDUCTION_CODES, fakeCompany, fakeEmployee, fakeElections } from './census.js';

export async function createCompany(client, workspaceId, company, { employees = 25 } = {}) {
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
  for (let i = 0; i < employees; i++) {
    const emp = fakeEmployee({ state: company.state, index: i });
    const { rows: [inserted] } = await client.query(
      `INSERT INTO employees (workspace_id, company_id, employee_number, first_name, last_name, email, phone, ssn,
         birth_date, hire_date, address, employment_type, pay_type, pay_rate, standard_hours, work_state, w4, state_w4)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [workspaceId, row.id, emp.employee_number, emp.first_name, emp.last_name, emp.email, emp.phone, emp.ssn,
        emp.birth_date, emp.hire_date, emp.address, emp.employment_type, emp.pay_type, emp.pay_rate,
        emp.standard_hours, emp.work_state, emp.w4, emp.state_w4],
    );
    for (const election of fakeElections(emp)) {
      await client.query(
        'INSERT INTO employee_deductions (workspace_id, employee_id, deduction_code_id, amount, percent) VALUES ($1, $2, $3, $4, $5)',
        [workspaceId, inserted.id, deductionIds[election.code], election.amount ?? null, election.percent ?? null],
      );
    }
  }
  return row;
}

async function seed(client, workspaceId) {
  // One client company per training state, each on a different pay cycle.
  const companies = [
    fakeCompany({ state: 'NY', payFrequency: 'weekly' }),
    fakeCompany({ state: 'NJ', payFrequency: 'biweekly' }),
    fakeCompany({ state: 'CA', payFrequency: 'semimonthly' }),
  ];
  for (const company of companies) await createCompany(client, workspaceId, company);
}

export async function createWorkspace({ name, userId = null, scenario = 'default' }) {
  return transaction(async (client) => {
    const { rows: [ws] } = await client.query(
      'INSERT INTO workspaces (name, user_id, scenario) VALUES ($1, $2, $3) RETURNING *',
      [name, userId, scenario],
    );
    await seed(client, ws.id);
    return ws;
  });
}

/** Wipes a sandbox back to a freshly seeded state. */
export async function resetWorkspace(workspaceId) {
  return transaction(async (client) => {
    await client.query('DELETE FROM companies WHERE workspace_id = $1', [workspaceId]);
    await seed(client, workspaceId);
  });
}

export async function listWorkspaces() {
  const { rows } = await query('SELECT * FROM workspaces ORDER BY id');
  return rows;
}
