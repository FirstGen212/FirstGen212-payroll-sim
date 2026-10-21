// JSON API. Every route below /api/w/:ws is scoped to one sandbox workspace.
import express from 'express';
import { query } from '../db/index.js';
import { createWorkspace, resetWorkspace, listWorkspaces, canAccessWorkspace } from '../services/workspaces.js';
import { loadUser, requireUser } from '../services/auth.js';
import { training } from './training.js';
import { portalRoutes } from './portal.js';
import { createRun, setPaycheckInputs, calculateRun, finalizeRun, checkRegister } from '../services/payroll.js';
import { fakeEmployee } from '../services/census.js';

export const api = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

api.use(loadUser);
api.use(training);

api.get('/workspaces', requireUser, wrap(async (req, res) => res.json(await listWorkspaces(req.user))));
api.post('/workspaces', requireUser, wrap(async (req, res) => {
  res.status(201).json(await createWorkspace({ name: req.body.name || `${req.user.name} · Practice`, userId: req.user.id }));
}));

const ws = express.Router({ mergeParams: true });
api.use('/w/:ws', requireUser, wrap(async (req, res, next) => {
  req.ws = Number(req.params.ws);
  if (!Number.isInteger(req.ws)) return res.status(400).json({ error: 'Bad workspace id' });
  if (!(await canAccessWorkspace(req.user, req.ws))) return res.status(404).json({ error: 'Sandbox not found' });
  next();
}), ws);

ws.use('/portal', portalRoutes);

ws.post('/reset', wrap(async (req, res) => {
  await resetWorkspace(req.ws);
  res.json({ ok: true });
}));

ws.get('/companies', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, (SELECT COUNT(*) FROM employees e WHERE e.company_id = c.id)::int AS employee_count
     FROM companies c WHERE workspace_id = $1 ORDER BY id`, [req.ws]);
  res.json(rows);
}));

// Employees
ws.get('/companies/:cid/employees', wrap(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM employees WHERE workspace_id = $1 AND company_id = $2 ORDER BY last_name, first_name',
    [req.ws, req.params.cid]);
  res.json(rows);
}));

const EMPLOYEE_FIELDS = ['employee_number', 'first_name', 'last_name', 'email', 'phone', 'ssn', 'birth_date', 'hire_date',
  'termination_date', 'address', 'status', 'employment_type', 'pay_type', 'pay_rate', 'standard_hours', 'work_state', 'w4', 'state_w4'];

ws.post('/companies/:cid/employees', wrap(async (req, res) => {
  const body = { ...req.body };
  const cols = EMPLOYEE_FIELDS.filter((f) => body[f] !== undefined);
  const { rows: [row] } = await query(
    `INSERT INTO employees (workspace_id, company_id, ${cols.join(', ')})
     SELECT $1, id, ${cols.map((_, i) => `$${i + 3}`).join(', ')} FROM companies WHERE id = $2 AND workspace_id = $1
     RETURNING *`,
    [req.ws, req.params.cid, ...cols.map((c) => body[c])]);
  if (!row) return res.status(404).json({ error: 'Company not found' });
  res.status(201).json(row);
}));

ws.patch('/employees/:id', wrap(async (req, res) => {
  const cols = EMPLOYEE_FIELDS.filter((f) => req.body[f] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows: [row] } = await query(
    `UPDATE employees SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [req.params.id, req.ws, ...cols.map((c) => req.body[c])]);
  if (!row) return res.status(404).json({ error: 'Employee not found' });
  res.json(row);
}));

// Generate fake census rows (preview only; POST them to /employees to keep).
ws.get('/companies/:cid/census/generate', wrap(async (req, res) => {
  const { rows: [company] } = await query('SELECT state FROM companies WHERE id = $1 AND workspace_id = $2', [req.params.cid, req.ws]);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  const count = Math.min(Number(req.query.count) || 10, 200);
  res.json(Array.from({ length: count }, (_, i) => fakeEmployee({ state: company.state, index: 5000 + i })));
}));

// Earnings and deductions setup
ws.get('/companies/:cid/earning-codes', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM earning_codes WHERE workspace_id = $1 AND company_id = $2 ORDER BY id', [req.ws, req.params.cid]);
  res.json(rows);
}));
ws.post('/companies/:cid/earning-codes', wrap(async (req, res) => {
  const { code, label, category, taxable } = req.body;
  const { rows: [row] } = await query(
    `INSERT INTO earning_codes (workspace_id, company_id, code, label, category, taxable)
     SELECT $1, id, $3, $4, $5, $6 FROM companies WHERE id = $2 AND workspace_id = $1 RETURNING *`,
    [req.ws, req.params.cid, code, label, category, taxable !== false]);
  res.status(201).json(row);
}));
ws.get('/companies/:cid/deduction-codes', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM deduction_codes WHERE workspace_id = $1 AND company_id = $2 ORDER BY id', [req.ws, req.params.cid]);
  res.json(rows);
}));
ws.post('/companies/:cid/deduction-codes', wrap(async (req, res) => {
  const { code, label, kind, category } = req.body;
  const { rows: [row] } = await query(
    `INSERT INTO deduction_codes (workspace_id, company_id, code, label, kind, category)
     SELECT $1, id, $3, $4, $5, $6 FROM companies WHERE id = $2 AND workspace_id = $1 RETURNING *`,
    [req.ws, req.params.cid, code, label, kind, category || 'other']);
  res.status(201).json(row);
}));

ws.get('/employees/:id/deductions', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT ed.*, d.code, d.label, d.kind FROM employee_deductions ed JOIN deduction_codes d ON d.id = ed.deduction_code_id
     WHERE ed.employee_id = $1 AND ed.workspace_id = $2 ORDER BY d.id`, [req.params.id, req.ws]);
  res.json(rows);
}));
ws.put('/employees/:id/deductions/:codeId', wrap(async (req, res) => {
  const { amount = null, percent = null, active = true } = req.body;
  const { rows: [row] } = await query(
    `INSERT INTO employee_deductions (workspace_id, employee_id, deduction_code_id, amount, percent, active)
     SELECT $1, e.id, d.id, $4, $5, $6 FROM employees e JOIN deduction_codes d ON d.company_id = e.company_id
     WHERE e.id = $2 AND d.id = $3 AND e.workspace_id = $1
     ON CONFLICT (employee_id, deduction_code_id) DO UPDATE SET amount = $4, percent = $5, active = $6
     RETURNING *`,
    [req.ws, req.params.id, req.params.codeId, amount, percent, active]);
  if (!row) return res.status(404).json({ error: 'Employee or deduction code not found' });
  res.json(row);
}));

// Payroll runs
ws.get('/companies/:cid/runs', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM payroll_runs WHERE workspace_id = $1 AND company_id = $2 ORDER BY id DESC', [req.ws, req.params.cid]);
  res.json(rows);
}));
ws.post('/companies/:cid/runs', wrap(async (req, res) => {
  const { runType = 'mock', periodStart, periodEnd, checkDate } = req.body;
  res.status(201).json(await createRun({ workspaceId: req.ws, companyId: Number(req.params.cid), runType, periodStart, periodEnd, checkDate }));
}));
ws.post('/runs/:id/calculate', wrap(async (req, res) => res.json(await calculateRun({ workspaceId: req.ws, runId: Number(req.params.id) }))));
ws.post('/runs/:id/finalize', wrap(async (req, res) => res.json(await finalizeRun({ workspaceId: req.ws, runId: Number(req.params.id) }))));
ws.delete('/runs/:id', wrap(async (req, res) => {
  const { rowCount } = await query("DELETE FROM payroll_runs WHERE id = $1 AND workspace_id = $2 AND status <> 'finalized'", [req.params.id, req.ws]);
  res.status(rowCount ? 204 : 409).end();
}));
ws.get('/runs/:id/register', wrap(async (req, res) => res.json(await checkRegister({ workspaceId: req.ws, runId: Number(req.params.id) }))));
ws.put('/paychecks/:id/inputs', wrap(async (req, res) => res.json(await setPaycheckInputs({ workspaceId: req.ws, paycheckId: Number(req.params.id), inputs: req.body }))));
ws.get('/paychecks/:id', wrap(async (req, res) => {
  const { rows: [row] } = await query(
    `SELECT p.*, row_to_json(e) AS employee, row_to_json(r) AS run, row_to_json(c) AS company
     FROM paychecks p JOIN employees e ON e.id = p.employee_id JOIN payroll_runs r ON r.id = p.payroll_run_id
     JOIN companies c ON c.id = r.company_id WHERE p.id = $1 AND p.workspace_id = $2`, [req.params.id, req.ws]);
  if (!row) return res.status(404).json({ error: 'Paycheck not found' });
  res.json(row);
}));

api.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 400).json({ error: err.code === '23505' ? 'That already exists' : err.message });
});
