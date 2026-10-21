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

-- Training: classes, assignments and graded attempts.
CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS class_members (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, user_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  scenario_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'in_progress', 'submitted')),
  best_score NUMERIC(5, 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS attempts (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  score NUMERIC(5, 1) NOT NULL,
  results JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Employer portal (onboarding pipeline). Companies double as portal clients.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'Welcome';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_status TEXT NOT NULL DEFAULT 'Onboarding';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS reflect_group TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_code TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS go_live_date DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pipedrive_deal_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contract_products JSONB NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS products JSONB NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact JSONB NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS milestones JSONB NOT NULL DEFAULT '{}';

ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_title TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS location_code TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS company_code TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS go_live_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS census_status TEXT DEFAULT 'Active';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS products JSONB NOT NULL DEFAULT '{}';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS eligibility TEXT;

CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  actor TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payroll documents a client submitted, extracted into rows for review.
CREATE TABLE IF NOT EXISTS payroll_jobs (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  queue TEXT NOT NULL DEFAULT 'review' CHECK (queue IN ('review', 'csm', 'done')),
  status TEXT NOT NULL DEFAULT 'Needs review',
  -- source: what the payroll register really says. rows: what extraction produced (editable).
  source JSONB NOT NULL,
  rows JSONB NOT NULL,
  notes JSONB NOT NULL DEFAULT '[]',
  proposal JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Census files a client uploaded through a census link.
CREATE TABLE IF NOT EXISTS census_uploads (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'Ready for review',
  rows JSONB NOT NULL,
  -- Answers the client gives when CS asks for missing info, keyed by row and field.
  client_answers JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
