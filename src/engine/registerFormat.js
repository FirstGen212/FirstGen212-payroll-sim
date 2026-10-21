// The payroll register file the payroll app exports and the portal reads back in.
// Column headers look like a provider's register export; fields match the portal's job rows.
export const REGISTER_COLUMNS = [
  ['emp_id', 'Employee ID'],
  ['first_name', 'First Name'],
  ['last_name', 'Last Name'],
  ['pay_freq', 'Pay Frequency'],
  ['emp_type', 'Employee Type'],
  ['avg_hrs', 'Hours'],
  ['rate', 'Rate'],
  ['gross', 'Gross Pay'],
  ['reimb', 'Reimbursement'],
  ['fed_filing', 'Federal Filing Status'],
  ['dependents', 'Dependents'],
  ['state_filing', 'State Filing Status'],
  ['work_state', 'Work State'],
  ['fed_tax', 'Federal Income Tax'],
  ['ss', 'Social Security'],
  ['medicare', 'Medicare'],
  ['state_tax', 'State Income Tax'],
  ['net_pay', 'Net Pay'],
];
const NUMERIC = new Set(['avg_hrs', 'rate', 'gross', 'reimb', 'dependents', 'fed_tax', 'ss', 'medicare', 'state_tax', 'net_pay']);

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function registerToCsv(rows) {
  return [REGISTER_COLUMNS.map(([, h]) => h).join(','), ...rows.map((r) => REGISTER_COLUMNS.map(([f]) => cell(r[f])).join(','))].join('\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Reads a register CSV back into job rows. Headers can be the export's names or the field names. */
export function registerFromCsv(text) {
  const [head, ...body] = parseCsv(String(text || ''));
  if (!head) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  const byHeader = new Map(REGISTER_COLUMNS.flatMap(([f, h]) => [[h.toLowerCase(), f], [f, f]]));
  const fields = head.map((h) => byHeader.get(h.trim().toLowerCase()));
  for (const required of ['emp_id', 'gross', 'net_pay']) {
    if (!fields.includes(required)) {
      throw Object.assign(new Error(`This doesn't look like a payroll register: no "${REGISTER_COLUMNS.find(([f]) => f === required)[1]}" column.`), { status: 400 });
    }
  }
  return body.map((r) => {
    const out = {};
    fields.forEach((f, i) => {
      if (!f) return;
      const raw = (r[i] ?? '').trim();
      out[f] = raw === '' ? null : NUMERIC.has(f) ? Number(raw.replace(/[$,]/g, '')) : raw;
    });
    return out;
  });
}
