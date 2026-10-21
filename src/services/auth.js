// Password hashing and signed session cookies, using only node:crypto.
import crypto from 'node:crypto';
import { query } from '../db/index.js';

const SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const COOKIE = 'sim_session';
const MAX_AGE_SECONDS = 60 * 60 * 12;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

export function setSession(res, userId) {
  const payload = `${userId}.${Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS}`;
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: MAX_AGE_SECONDS * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE);
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : null;
}

/** Attaches req.user when the session cookie is valid. */
export async function loadUser(req, res, next) {
  try {
    const raw = readCookie(req);
    if (raw) {
      const [id, expires, signature] = raw.split('.');
      const payload = `${id}.${expires}`;
      const valid = signature && signature.length === sign(payload).length
        && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)));
      if (valid && Number(expires) > Date.now() / 1000) {
        const { rows: [user] } = await query('SELECT id, email, name, role FROM users WHERE id = $1', [id]);
        req.user = user || null;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  next();
}

export function requireTrainer(req, res, next) {
  if (req.user?.role !== 'trainer') return res.status(403).json({ error: 'Trainer access only' });
  next();
}
