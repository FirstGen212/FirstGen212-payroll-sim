// Sign-in, trainee management, assignments and grading.
import express from 'express';
import { query, pool } from '../db/index.js';
import { hashPassword, verifyPassword, setSession, clearSession, requireUser, requireTrainer } from '../services/auth.js';
import { createWorkspace } from '../services/workspaces.js';
import { SCENARIOS, scenarioByKey, gradeScenario } from '../services/scenarios.js';

export const training = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

async function trainerExists() {
  const { rows } = await query("SELECT 1 FROM users WHERE role = 'trainer' LIMIT 1");
  return rows.length > 0;
}

async function ensurePracticeSandbox(user) {
  const { rows } = await query('SELECT 1 FROM workspaces WHERE user_id = $1 AND assignment_id IS NULL LIMIT 1', [user.id]);
  if (!rows.length) await createWorkspace({ name: `${user.name} · Practice`, userId: user.id });
}

// ---------- auth ----------

training.get('/auth/status', wrap(async (req, res) => {
  res.json({ user: req.user || null, needsSetup: !(await trainerExists()) });
}));

// First visit only: whoever sets up the app becomes its trainer.
training.post('/auth/setup', wrap(async (req, res) => {
  if (await trainerExists()) return res.status(409).json({ error: 'Setup is already complete' });
  const { email, name, password } = req.body;
  if (!email || !name || !password || password.length < 8) return res.status(400).json({ error: 'Name, email and an 8+ character password are required' });
  const { rows: [user] } = await query(
    "INSERT INTO users (email, name, role, password_hash) VALUES (LOWER($1), $2, 'trainer', $3) RETURNING id, email, name, role",
    [email, name, hashPassword(password)]);
  await ensurePracticeSandbox(user);
  setSession(res, user.id);
  res.json({ user });
}));

training.post('/auth/login', wrap(async (req, res) => {
  const { rows: [user] } = await query('SELECT * FROM users WHERE email = LOWER($1)', [req.body.email || '']);
  if (!user || !verifyPassword(req.body.password || '', user.password_hash)) return res.status(401).json({ error: 'Wrong email or password' });
  await ensurePracticeSandbox(user);
  setSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}));

training.post('/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// ---------- people and classes (trainer) ----------

training.get('/training/users', requireTrainer, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.role, u.created_at,
       COALESCE(json_agg(json_build_object('id', c.id, 'name', c.name)) FILTER (WHERE c.id IS NOT NULL), '[]') AS classes
     FROM users u LEFT JOIN class_members m ON m.user_id = u.id LEFT JOIN classes c ON c.id = m.class_id
     GROUP BY u.id ORDER BY u.role, u.name`);
  res.json(rows);
}));

training.post('/training/users', requireTrainer, wrap(async (req, res) => {
  const { email, name, password, role = 'trainee' } = req.body;
  if (!email || !name || !password || password.length < 8) return res.status(400).json({ error: 'Name, email and an 8+ character password are required' });
  const { rows: [user] } = await query(
    'INSERT INTO users (email, name, role, password_hash) VALUES (LOWER($1), $2, $3, $4) RETURNING id, email, name, role',
    [email, name, role === 'trainer' ? 'trainer' : 'trainee', hashPassword(password)]);
  res.status(201).json(user);
}));

training.post('/training/users/:id/password', requireTrainer, wrap(async (req, res) => {
  if (!req.body.password || req.body.password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.params.id, hashPassword(req.body.password)]);
  res.json({ ok: true });
}));

training.get('/training/classes', requireTrainer, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, COALESCE(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS member_ids
     FROM classes c LEFT JOIN class_members m ON m.class_id = c.id GROUP BY c.id ORDER BY c.id DESC`);
  res.json(rows);
}));

training.post('/training/classes', requireTrainer, wrap(async (req, res) => {
  const { rows: [cls] } = await query('INSERT INTO classes (name) VALUES ($1) RETURNING *', [req.body.name]);
  for (const userId of req.body.userIds || []) {
    await query('INSERT INTO class_members (class_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cls.id, userId]);
  }
  res.status(201).json(cls);
}));

training.put('/training/classes/:id/members', requireTrainer, wrap(async (req, res) => {
  await query('DELETE FROM class_members WHERE class_id = $1', [req.params.id]);
  for (const userId of req.body.userIds || []) {
    await query('INSERT INTO class_members (class_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, userId]);
  }
  res.json({ ok: true });
}));

// ---------- scenarios and assignments ----------

training.get('/training/scenarios', requireUser, (req, res) => {
  res.json(SCENARIOS.map(({ key, title, skill, instructions, checks }) => ({
    key, title, skill, instructions, points: checks.reduce((t, c) => t + c.points, 0), checkCount: checks.length,
  })));
});

// Assign a scenario to individual trainees, a whole class, or both.
training.post('/training/assignments', requireTrainer, wrap(async (req, res) => {
  const { scenarioKey, userIds = [], classId = null, dueDate = null } = req.body;
  if (!scenarioByKey(scenarioKey)) return res.status(400).json({ error: 'Unknown scenario' });
  const targets = new Set(userIds.map(Number));
  if (classId) {
    const { rows } = await query('SELECT user_id FROM class_members WHERE class_id = $1', [classId]);
    rows.forEach((r) => targets.add(r.user_id));
  }
  const created = [];
  for (const userId of targets) {
    const { rows: [a] } = await query(
      'INSERT INTO assignments (scenario_key, user_id, class_id, assigned_by, due_date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [scenarioKey, userId, classId, req.user.id, dueDate || null]);
    created.push(a);
  }
  res.status(201).json(created);
}));

training.get('/training/assignments', requireUser, wrap(async (req, res) => {
  const mine = req.user.role !== 'trainer' || req.query.mine === '1';
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name, c.name AS class_name, w.id AS workspace_id,
       (SELECT COUNT(*)::int FROM attempts t WHERE t.assignment_id = a.id) AS attempt_count,
       (SELECT row_to_json(t) FROM attempts t WHERE t.assignment_id = a.id ORDER BY t.id DESC LIMIT 1) AS last_attempt
     FROM assignments a JOIN users u ON u.id = a.user_id LEFT JOIN classes c ON c.id = a.class_id
     LEFT JOIN workspaces w ON w.assignment_id = a.id
     ${mine ? 'WHERE a.user_id = $1' : ''} ORDER BY a.id DESC`,
    mine ? [req.user.id] : []);
  res.json(rows.map((a) => ({ ...a, scenario_title: scenarioByKey(a.scenario_key)?.title })));
}));

async function ownAssignment(req) {
  const { rows: [a] } = await query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
  if (!a || (a.user_id !== req.user.id && req.user.role !== 'trainer')) throw Object.assign(new Error('Assignment not found'), { status: 404 });
  return a;
}

training.post('/training/assignments/:id/start', requireUser, wrap(async (req, res) => {
  const a = await ownAssignment(req);
  const { rows: [existing] } = await query('SELECT * FROM workspaces WHERE assignment_id = $1', [a.id]);
  if (existing) return res.json(existing);
  const scenario = scenarioByKey(a.scenario_key);
  const ws = await createWorkspace({ name: `${scenario.title}`, userId: a.user_id, scenario: scenario.key, assignmentId: a.id });
  await query("UPDATE assignments SET status = 'in_progress' WHERE id = $1 AND status = 'assigned'", [a.id]);
  res.json(ws);
}));

training.post('/training/assignments/:id/submit', requireUser, wrap(async (req, res) => {
  const a = await ownAssignment(req);
  const { rows: [ws] } = await query('SELECT * FROM workspaces WHERE assignment_id = $1', [a.id]);
  if (!ws) return res.status(400).json({ error: 'Start the assignment first' });
  const client = await pool.connect();
  let graded;
  try {
    graded = await gradeScenario(client, scenarioByKey(a.scenario_key), ws.id);
  } finally {
    client.release();
  }
  const { rows: [attempt] } = await query(
    'INSERT INTO attempts (assignment_id, score, results) VALUES ($1, $2, $3) RETURNING *',
    [a.id, graded.score, JSON.stringify(graded.results)]);
  await query(
    "UPDATE assignments SET status = 'submitted', best_score = GREATEST(COALESCE(best_score, 0), $2) WHERE id = $1",
    [a.id, graded.score]);
  res.json(attempt);
}));

training.delete('/training/assignments/:id', requireTrainer, wrap(async (req, res) => {
  await query('DELETE FROM assignments WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));
