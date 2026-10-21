import express from 'express';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { requireAuth, requireAdmin } from './auth.js';
import { errorHandler, notFound } from './errors.js';
import authRoutes from './routes/auth.js';
import movieRoutes from './routes/movies.js';
import hallRoutes from './routes/halls.js';
import showtimeRoutes from './routes/showtimes.js';
import reservationRoutes from './routes/reservations.js';
import adminRoutes from './routes/admin.js';
import { genreRoutes, experienceRoutes } from './routes/catalog.js';
import { THEATRE_NAME, TICKET_TYPES, SNACK_COMBOS, theatreHours } from './theatre.js';

// Creates the initial admin from env vars if no admin exists yet.
export function ensureAdmin(db, email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD) {
  if (!email || !password) return;
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
  } else {
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', ?, ?, 'admin')")
      .run(email.toLowerCase(), bcrypt.hashSync(password, 10));
  }
}

// Portfolio demo: a regular customer account whose login is shown on the sign-in screen. Its password is reset
// from env on every start so the credentials on screen always work. Skipped unless DEMO_EMAIL/DEMO_PASSWORD are set.
export function ensureDemoUser(db, email = process.env.DEMO_EMAIL, password = process.env.DEMO_PASSWORD) {
  if (!email || !password) return;
  const hash = bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (existing?.role === 'admin') return; // never expose an admin account as the demo login
  if (existing) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
  else db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Demo Guest', ?, ?)").run(email.toLowerCase(), hash);
}

export function createApp(db, { uploadDir = process.env.UPLOAD_DIR || fileURLToPath(new URL('../uploads', import.meta.url)) } = {}) {
  const app = express();
  const auth = requireAuth(db);

  app.use(express.json({ limit: '100kb' }));
  // The website is a static single-page app served from the same origin as the API.
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use('/uploads', express.static(uploadDir));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/theatre', (_req, res) => {
    const { open, close, timezone } = theatreHours();
    res.json({ name: THEATRE_NAME, timezone, opens_hour: open, closes_hour: close, ticket_types: TICKET_TYPES,
      snack_combos: Object.entries(SNACK_COMBOS).map(([id, c]) => ({ id, ...c })),
      demo_login: process.env.DEMO_EMAIL && process.env.DEMO_PASSWORD
        ? { email: process.env.DEMO_EMAIL, password: process.env.DEMO_PASSWORD } : null });
  });
  app.use('/api/auth', authRoutes(db, { auth }));
  app.use('/api/movies', movieRoutes(db, { auth, uploadDir }));
  app.use('/api/genres', genreRoutes(db, { auth }));
  app.use('/api/experiences', experienceRoutes(db, { auth }));
  app.use('/api/halls', hallRoutes(db, { auth }));
  app.use('/api/showtimes', showtimeRoutes(db, { auth }));
  app.use('/api/reservations', auth, reservationRoutes(db));
  app.use('/api/admin', auth, requireAdmin, adminRoutes(db));

  app.use((_req, _res, next) => next(notFound('Route')));
  app.use(errorHandler);
  return app;
}
