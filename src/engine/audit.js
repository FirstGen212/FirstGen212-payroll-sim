// Pre-launch data audit, modeled on the portal's "What the audit checks" rules.
// Red issues block the carrier (Reflect) file; amber should be fixed but don't block it.

export const CENSUS_STATUSES = ['Active', 'Active FT', 'Active PT', 'New hire', 'Underwriting', 'Unenrolled', 'Terminated',
  'Opted out', 'Ineligible', 'Not in payroll', 'Inactive', 'DNU'];
const LEAVER_STATUSES = ['Terminated', 'Unenrolled', 'Opted out'];
const LOCATION_CODES = ['1000', '2000', '3000', '4000', '5000', '6000', '7000', '8000', '9000'];
export const MEC_PRICES = [55, 65, 90, 95];
export const VIRTUAL_PRICES = [119, 129, 139, 149, 159];

const isActive = (e) => /^active/i.test(e.census_status || '') || e.census_status === 'New hire';
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const fullName = (e) => `${(e.first_name || '').trim().toLowerCase()} ${(e.last_name || '').trim().toLowerCase()}`;
const annualPay = (e) => (e.pay_type === 'salary' ? Number(e.pay_rate) : Number(e.pay_rate) * Number(e.standard_hours) * 52);

function ageOn(dob, on = new Date()) {
  const d = new Date(dob);
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

/**
 * company: { name, go_live_date, reflect_group, company_code, products: [{code, price}] }
 * employees: census rows. others: employees at other companies (for cross-company duplicates).
 */
export function runAudit(company, employees, others = []) {
  const issues = [];
  const add = (employee, category, severity, field, message) => issues.push({
    employeeId: employee?.id ?? null,
    employeeNumber: employee?.employee_number ?? null,
    name: employee ? `${employee.first_name} ${employee.last_name}` : null,
    category, severity, field, message,
  });

  // Company setup
  if (!company.reflect_group) add(null, 'Company setup', 'red', 'reflect_group', 'Company has no Reflect group number.');
  else if (!/^[A-Z0-9-]{2,20}$/.test(company.reflect_group)) add(null, 'Company setup', 'red', 'reflect_group', 'Reflect ID must be 2-20 capital letters, numbers or dashes.');
  if (!company.go_live_date) add(null, 'Missing Go Live Date', 'red', 'go_live_date', 'Company has no Go Live Date.');
  if (!company.company_code) add(null, 'Company setup', 'amber', 'company_code', 'Company has no company code.');
  const companyProducts = new Set((company.products || []).map((p) => p.code));
  if (!companyProducts.size) add(null, 'Product and price', 'red', 'products', 'Company has no products set up.');

  const groups = (keyFn) => {
    const map = new Map();
    for (const e of employees) {
      const key = keyFn(e);
      if (!key) continue;
      map.set(key, [...(map.get(key) || []), e]);
    }
    return map;
  };
  const duplicate = (keyFn, label, severity, field) => {
    for (const list of groups(keyFn).values()) {
      if (list.length < 2) continue;
      for (const e of list) {
        const other = list.find((x) => x !== e);
        add(e, 'Duplicates', severity, field, `${label} as ${other.first_name} ${other.last_name} in this company. Each person needs their own. Correct one of them.`);
      }
    }
  };
  duplicate((e) => (digits(e.ssn).length >= 7 ? digits(e.ssn) : null), 'Same SSN', 'red', 'ssn');
  duplicate((e) => (e.first_name ? fullName(e) : null), 'Same first and last name', 'amber', 'last_name');
  duplicate((e) => (e.first_name && e.birth_date ? `${fullName(e)}|${e.birth_date}` : null), 'Same name and date of birth', 'red', 'birth_date');
  duplicate((e) => (e.email ? e.email.trim().toLowerCase() : null), 'Same email', 'amber', 'email');
  duplicate((e) => (digits(e.phone).length === 10 ? digits(e.phone) : null), 'Same phone', 'amber', 'phone');
  duplicate((e) => e.employee_number || null, 'Same employee ID', 'red', 'employee_number');

  const otherSsns = new Map(others.filter((o) => digits(o.ssn).length === 9).map((o) => [digits(o.ssn), o]));

  for (const e of employees) {
    const active = isActive(e);
    const leaver = LEAVER_STATUSES.includes(e.census_status);

    // Go Live
    if (active && !e.go_live_date) add(e, 'Missing Go Live Date', 'red', 'go_live_date', `${e.census_status} with no Go Live Date.`);
    if (e.go_live_date && e.hire_date && e.go_live_date < e.hire_date) add(e, 'Missing Go Live Date', 'amber', 'go_live_date', 'Go Live Date is before the start date.');

    // Location code
    if (active && !LOCATION_CODES.includes(String(e.location_code ?? ''))) add(e, 'Location Code format', 'red', 'location_code', 'Location code must be 1000, 2000 ... 9000. Reflect rejects the whole file otherwise.');

    // SSN
    const ssn = digits(e.ssn);
    if (!ssn) add(e, 'SSN problems', 'red', 'ssn', 'No SSN. Reflect rejects the whole file.');
    else if (ssn.length === 7 || ssn.length === 8) add(e, 'SSN problems', 'red', 'ssn', 'SSN has 7-8 digits. Leading zeros are probably missing.');
    else if (ssn.length !== 9) add(e, 'SSN problems', 'red', 'ssn', 'SSN is not 9 digits.');
    else if (/^(\d)\1{8}$/.test(ssn)) add(e, 'SSN problems', 'red', 'ssn', 'Stand-in SSN (repeated digit).');
    else if (ssn.startsWith('9')) add(e, 'SSN problems', 'red', 'ssn', 'Starts with 9: that is a tax ID (ITIN), not an SSN.');
    if (ssn.length === 9 && otherSsns.has(ssn)) add(e, 'Duplicates', 'amber', 'ssn', `Same SSN as someone at another company (${otherSsns.get(ssn).company_name || 'another client'}).`);

    // Products and prices
    const products = e.products || {};
    const on = Object.entries(products).filter(([, v]) => v != null && v !== false);
    if (active && !on.length) add(e, 'Product and price', 'amber', 'products', 'Active with no products.');
    for (const [code, price] of on) {
      if (price === true || price === '' || Number.isNaN(Number(price))) add(e, 'Product and price', 'red', 'products', `${code} is on with no price.`);
      else if (code === 'MEC' && !MEC_PRICES.includes(Number(price))) add(e, 'Product and price', 'red', 'products', `MEC price ${price} is not 55, 65, 90 or 95.`);
      else if (code === 'VIRTUAL' && e.employment_type === 'FT' && !VIRTUAL_PRICES.includes(Number(price))) add(e, 'Product and price', 'red', 'products', `Full-time virtual price ${price} is not 119, 129, 139, 149 or 159.`);
      if (companyProducts.size && !companyProducts.has(code)) add(e, 'Product and price', 'amber', 'products', `${code} is not set up for this company.`);
    }

    // Status and dates
    if (!e.census_status) add(e, 'Status and dates', 'amber', 'census_status', 'No status. Left out of the Reflect file.');
    else if (!CENSUS_STATUSES.includes(e.census_status)) add(e, 'Status and dates', 'red', 'census_status', `Status "${e.census_status}" is not on the list.`);
    if (leaver && !e.termination_date) add(e, 'Status and dates', 'red', 'termination_date', `${e.census_status} with no end date. Reflect rejects the file.`);
    if (active && e.termination_date) add(e, 'Status and dates', 'amber', 'termination_date', 'Active but has an end date.');
    if (e.termination_date && e.go_live_date && e.termination_date <= e.go_live_date) add(e, 'Status and dates', 'amber', 'termination_date', 'End date is on or before Go Live.');

    // Identity fields
    if (active) {
      const a = e.address || {};
      for (const [field, label, value] of [['address.line1', 'address', a.line1], ['address.city', 'city', a.city], ['address.state', 'state', a.state], ['address.zip', 'ZIP', a.zip], ['birth_date', 'date of birth', e.birth_date], ['gender', 'gender', e.gender]]) {
        if (!value) add(e, 'Identity fields', 'red', field, `Missing ${label}.`);
      }
      if (e.gender && !['M', 'F'].includes(e.gender)) add(e, 'Identity fields', 'red', 'gender', 'Gender must be M or F.');
      if (a.zip && !/^\d{5}$/.test(a.zip)) add(e, 'Identity fields', 'red', 'address.zip', a.zip.length < 5 ? 'ZIP has 3-4 digits (leading zero lost?).' : 'ZIP is not 5 digits.');
      if (a.state && !/^[A-Z]{2}$/.test(a.state)) add(e, 'Identity fields', 'red', 'address.state', 'State must be a 2-letter code.');
      if (!e.first_name || !e.last_name || !e.hire_date) add(e, 'Identity fields', 'red', 'first_name', 'Active with no first name, last name or start date.');
      if (!e.phone && !e.email) add(e, 'Identity fields', 'red', 'email', 'Needs a phone or an email.');
    }
    if (e.phone && digits(e.phone).length !== 10) add(e, 'Identity fields', 'amber', 'phone', 'Phone is not 10 digits.');
    if (e.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email)) add(e, 'Identity fields', 'amber', 'email', 'Email is not valid.');
    if (e.first_name && /[\d()[\]{}]/.test(e.first_name)) add(e, 'Identity fields', 'amber', 'first_name', 'First name has numbers or brackets.');
    for (const field of ['first_name', 'last_name', 'email']) {
      if (/^[=@+-]/.test(e[field] || '')) add(e, 'Identity fields', 'red', field, `Value starts with = @ + or - (spreadsheet formula risk).`);
    }
    if (e.birth_date) {
      const age = ageOn(e.birth_date);
      if (new Date(e.birth_date) > new Date()) add(e, 'Identity fields', 'red', 'birth_date', 'Date of birth is in the future.');
      else if (age < 14 || age > 100) add(e, 'Identity fields', 'red', 'birth_date', `Age ${age} is outside 14-100.`);
    }

    // Employee ID
    if (active && !e.employee_number) add(e, 'Employee ID', 'amber', 'employee_number', 'Active with no employee ID.');

    // Pay and eligibility
    if (active && e.pay_rate != null && e.standard_hours != null) {
      const looksPt = annualPay(e) <= 20000 && Number(e.standard_hours) <= 29;
      if (looksPt !== (e.employment_type === 'PT')) add(e, 'Pay and eligibility', 'amber', 'employment_type', 'Part-time flag disagrees with pay and hours (PT = $20,000 or less a year and 29 hours or fewer a week).');
    }
    if (active && !Number(e.pay_rate)) add(e, 'Pay and eligibility', 'red', 'pay_rate', 'Active with no gross pay.');
  }

  const affected = new Set(issues.filter((i) => i.employeeId != null).map((i) => i.employeeId));
  return {
    issues,
    red: issues.filter((i) => i.severity === 'red').length,
    amber: issues.filter((i) => i.severity === 'amber').length,
    peopleAffected: affected.size,
    people: employees.length,
  };
}

/** Census completion: share of active people with every field the census review requires. */
export const CENSUS_REQUIRED = ['first_name', 'last_name', 'birth_date', 'gender', 'ssn', 'address.line1', 'address.city', 'address.state', 'address.zip', 'hire_date', 'w4.filingStatus', 'pay_rate', 'standard_hours'];

export function censusCompletion(employees) {
  const get = (e, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), e);
  const rows = employees.filter((e) => !LEAVER_STATUSES.includes(e.census_status));
  if (!rows.length) return { pct: 0, complete: 0, total: 0, missing: [] };
  const missing = rows.map((e) => ({ id: e.id, fields: CENSUS_REQUIRED.filter((f) => get(e, f) == null || get(e, f) === '') })).filter((m) => m.fields.length);
  const complete = rows.length - missing.length;
  return { pct: Math.round((complete / rows.length) * 1000) / 10, complete, total: rows.length, missing };
}
