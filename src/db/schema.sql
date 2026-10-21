-- Every simulation record belongs to a workspace: one trainee's sandbox.
-- Resetting a sandbox deletes the workspace's rows and reseeds them.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'trainee' CHECK (role IN ('trainer', 'trainee')),
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  scenario TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fein TEXT,
  state TEXT NOT NULL,
  pay_frequency TEXT NOT NULL CHECK (pay_frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  payroll_provider TEXT,
  address JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_number TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  ssn TEXT,
  birth_date DATE,
  hire_date DATE,
  termination_date DATE,
  address JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'leave', 'terminated')),
  employment_type TEXT NOT NULL DEFAULT 'FT' CHECK (employment_type IN ('FT', 'PT')),
  pay_type TEXT NOT NULL CHECK (pay_type IN ('hourly', 'salary')),
  pay_rate NUMERIC(12, 2) NOT NULL,
  standard_hours NUMERIC(6, 2) NOT NULL DEFAULT 40,
  work_state TEXT NOT NULL,
  w4 JSONB NOT NULL DEFAULT '{"filingStatus":"single"}',
  state_w4 JSONB NOT NULL DEFAULT '{"filingStatus":"single"}',
  UNIQUE (company_id, employee_number)
);

CREATE TABLE IF NOT EXISTS earning_codes (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('regular', 'overtime', 'bonus', 'commission', 'reimbursement', 'other')),
  taxable BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS deduction_codes (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  -- section125 / retirement are pre-tax; posttax / garnishment are after tax.
  kind TEXT NOT NULL CHECK (kind IN ('section125', 'retirement', 'posttax', 'garnishment')),
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('medical', 'dental', 'vision', 'retirement', 'program', 'loan', 'garnishment', 'other')),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS employee_deductions (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  deduction_code_id INTEGER NOT NULL REFERENCES deduction_codes(id) ON DELETE CASCADE,
  -- Per-check dollar amount (may be negative, e.g. BPT) or a percent of gross.
  amount NUMERIC(12, 2),
  percent NUMERIC(6, 3),
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (employee_id, deduction_code_id)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL CHECK (run_type IN ('mock', 'full')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'finalized', 'voided')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  check_date DATE NOT NULL,
  totals JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS paychecks (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  check_number INTEGER,
  -- Hours and one-off earnings entered for this run.
  inputs JSONB NOT NULL DEFAULT '{}',
  -- Full engine output, amounts in cents.
  detail JSONB,
  gross_cents BIGINT,
  net_cents BIGINT,
  UNIQUE (payroll_run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS employees_workspace ON employees (workspace_id);
CREATE INDEX IF NOT EXISTS paychecks_employee ON paychecks (employee_id);
