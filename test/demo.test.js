import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db.js';
import { ensureAdmin, ensureDemoUser } from '../src/app.js';
import { isResetDue, runDemoResetIfDue } from '../src/demo.js';
import { createReservation } from '../src/routes/reservations.js';

test('demo login is a regular customer, kept in sync with env, and never an admin', () => {
  const db = openDb(':memory:');
  const user = (email) => db.prepare('SELECT role, password_hash FROM users WHERE email = ?').get(email);

  ensureDemoUser(db, 'demo@example.com', 'first-pass');
  assert.equal(user('demo@example.com').role, 'user');
  ensureDemoUser(db, 'demo@example.com', 'second-pass'); // password follows env on restart
  assert.ok(bcrypt.compareSync('second-pass', user('demo@example.com').password_hash));

  ensureAdmin(db, 'boss@example.com', 'admin-pass');
  ensureDemoUser(db, 'boss@example.com', 'leaked'); // pointing the demo at an admin does nothing
  assert.ok(bcrypt.compareSync('admin-pass', user('boss@example.com').password_hash));

  ensureDemoUser(db, undefined, undefined); // unset env: no demo account
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
});

test('demo reset is due once per local day, at or after the reset hour', () => {
  const tz = 'America/Toronto'; // UTC-4 in October
  const at = (iso) => new Date(iso);
  assert.equal(isResetDue(null, at('2026-10-21T07:30:00Z'), 4, tz), null); // 3:30 AM local: too early
  assert.equal(isResetDue(null, at('2026-10-21T08:05:00Z'), 4, tz), '2026-10-21'); // 4:05 AM
  assert.equal(isResetDue('2026-10-21', at('2026-10-21T20:00:00Z'), 4, tz), null); // already done today
  assert.equal(isResetDue('2026-10-20', at('2026-10-21T18:00:00Z'), 4, tz), '2026-10-21'); // slept through 4 AM: catch up
  // 02:00 UTC on the 22nd is still the evening of the 21st in Toronto.
  assert.equal(isResetDue('2026-10-21', at('2026-10-22T02:00:00Z'), 4, tz), null);
});

test('demo reset deletes only the demo account bookings, frees seats, and records the day', () => {
  const db = openDb(':memory:');
  ensureDemoUser(db, 'demo@example.com', 'pw');
  const other = db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Real', 'real@example.com', 'x')").run().lastInsertRowid;
  const demo = db.prepare("SELECT id FROM users WHERE email = 'demo@example.com'").get().id;
  const hall = db.prepare("INSERT INTO halls (name, row_count, seats_per_row) VALUES ('H', 1, 3)").run().lastInsertRowid;
  for (const l of ['A1', 'A2', 'A3']) db.prepare('INSERT INTO seats (hall_id, label) VALUES (?, ?)').run(hall, l);
  const movie = db.prepare("INSERT INTO movies (title, duration_min) VALUES ('M', 90)").run().lastInsertRowid;
  const start = new Date(Date.now() + 86_400_000);
  const show = db.prepare(`INSERT INTO showtimes (movie_id, hall_id, experience_id, starts_at, ends_at, price_cents)
    VALUES (?, ?, (SELECT id FROM experiences WHERE name = 'Standard'), ?, ?, 1000)`)
    .run(movie, hall, start.toISOString(), new Date(start.getTime() + 5_400_000).toISOString()).lastInsertRowid;
  createReservation(db, demo, show, ['A1'], { adult: 1 }, { wombo: 1 });
  createReservation(db, demo, show, ['A2']);
  createReservation(db, other, show, ['A3']);

  const opts = { email: 'demo@example.com', resetHour: 4, timeZone: 'UTC', now: new Date('2026-10-21T05:00:00Z') };
  assert.equal(runDemoResetIfDue(db, opts), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 1); // the real customer's booking stays
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservation_snacks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservation_seats WHERE active = 1').get().n, 1); // A1, A2 freed
  assert.equal(runDemoResetIfDue(db, { ...opts, now: new Date('2026-10-21T23:00:00Z') }), null); // once per day
  assert.equal(runDemoResetIfDue(db, { ...opts, now: new Date('2026-10-22T04:30:00Z') }), 0); // next day runs again
});
