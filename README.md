# Payroll Training Simulator

A payroll system and First Gen employer-portal simulator for customer success training. Everything in it is fictitious. It is not a certified payroll or tax calculator.

## What's here so far

- `src/engine/taxTables2026.js`: 2026 federal, FICA and NY/NJ/CA parameters
- `src/engine/payroll.js`: paycheck calculator (earnings, Section 125, 401(k), post-tax, taxes, employer taxes)
- `src/engine/program.js`: FGH / BPT / RWP pricing and the launch "no net pay decrease" check

- `src/db/schema.sql`, `src/services/`: Postgres schema, sandbox seeding (NY weekly, NJ biweekly, CA semimonthly clients with 25 fake employees each), payroll runs
- `public/`: the payroll app (employees, W-4s, earnings and deductions setup, mock and full runs, check register, payroll summary, paystubs, census import and fake data)

## Run locally

Needs Node 20+ and Postgres. Set `DATABASE_URL` (defaults to `postgres://sim:sim@localhost:5432/payroll_sim`), then:

```
npm install
npm start
```

Open http://localhost:3000.

## Deploy on Render

In Render, choose **New > Blueprint** and pick this repo. `render.yaml` creates the web service and its Postgres database.

## Run tests

```
npm test
```
