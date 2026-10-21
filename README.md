# Payroll Training Simulator

A payroll system and First Gen employer-portal simulator for customer success training. Everything in it is fictitious. It is not a certified payroll or tax calculator.

## What's here so far

- `src/engine/taxTables2026.js`: 2026 federal, FICA and NY/NJ/CA parameters
- `src/engine/payroll.js`: paycheck calculator (earnings, Section 125, 401(k), post-tax, taxes, employer taxes)
- `src/engine/program.js`: FGH / BPT / RWP pricing and the launch "no net pay decrease" check

## Run tests

```
npm test
```
