import fs from 'node:fs';
import pg from 'pg';

// Keep DATE columns as YYYY-MM-DD strings instead of shifting them through JS time zones.
pg.types.setTypeParser(1082, (value) => value);

// Render provides DATABASE_URL; local dev falls back to a local Postgres.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://sim:sim@localhost:5432/payroll_sim',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export const query = (text, params) => pool.query(text, params);

export async function migrate() {
  await pool.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
