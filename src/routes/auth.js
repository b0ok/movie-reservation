import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { validate } from '../validate.js';
import { conflict, HttpError } from '../errors.js';
import { signToken } from '../auth.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Failed-login throttle per IP + email: after MAX_FAILURES within the window, further attempts get 429.
// In-memory, so it resets on restart and isn't shared between processes; fine for a single server.
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const failures = new Map();

const loginKey = (req, email) => `${req.ip}|${email.toLowerCase()}`;

function retryAfterSeconds(key) {
  const f = failures.get(key);
  if (!f) return 0;
  const left = f.first + WINDOW_MS - Date.now();
  if (left <= 0) { failures.delete(key); return 0; }
  return f.count >= MAX_FAILURES ? Math.ceil(left / 1000) : 0;
}

function recordFailure(key) {
  const f = failures.get(key);
  if (!f || f.first + WINDOW_MS < Date.now()) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
}

export default function authRoutes(db, { auth }) {
  const router = Router();
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const insertUser = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)');
  const getUser = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?');

  // Signup always creates a regular user; admins are seeded or promoted by another admin.
  // Closed unless ALLOW_SIGNUP=true: the portfolio site only uses the shared demo login.
  router.post('/signup', async (req, res) => {
    if (process.env.ALLOW_SIGNUP !== 'true') throw new HttpError(403, 'Sign-up is closed');
    const input = validate(req.body, {
      name: { type: 'string', required: true, min: 1, max: 100 },
      email: { type: 'string', required: true, max: 254, pattern: EMAIL },
      password: { type: 'string', required: true, min: 8, max: 72, trim: false },
    });
    if (findByEmail.get(input.email)) throw conflict('Email is already registered');
    const hash = await bcrypt.hash(input.password, 10);
    const { lastInsertRowid } = insertUser.run(input.name, input.email.toLowerCase(), hash);
    const user = getUser.get(lastInsertRowid);
    res.status(201).json({ token: signToken(user), user });
  });

  router.post('/login', async (req, res) => {
    const input = validate(req.body, {
      email: { type: 'string', required: true },
      password: { type: 'string', required: true, trim: false },
    });
    const key = loginKey(req, input.email);
    const wait = retryAfterSeconds(key);
    if (wait) {
      res.set('Retry-After', String(wait));
      throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    }
    const row = findByEmail.get(input.email);
    // Compare against a dummy hash when the user is missing so timing doesn't reveal which emails exist.
    const ok = await bcrypt.compare(input.password, row?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    if (!row || !ok) {
      recordFailure(key);
      throw new HttpError(401, 'Invalid email or password');
    }
    failures.delete(key);
    const user = getUser.get(row.id);
    res.json({ token: signToken(user), user });
  });

  router.get('/me', auth, (req, res) => {
    res.json(getUser.get(req.user.id));
  });

  return router;
}
