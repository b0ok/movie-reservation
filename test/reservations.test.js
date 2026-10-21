import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp, ensureAdmin } from '../src/app.js';
import { ensureSimulatedUser, simulateTick, targetOccupancy, seatScore, SIMULATED_EMAIL } from '../src/simulator.js';

process.env.JWT_SECRET = 'test-secret';
process.env.ALLOW_SIGNUP = 'true';
process.env.THEATRE_HOURS = '0-48'; // effectively always open

let db;
let server;
let base;
let adminToken;
let userToken;
let movieId;
let hallId;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const schedule = (hours, extra = {}) => api('POST', '/api/showtimes', {
  token: adminToken, body: { movie_id: movieId, hall_id: hallId, starts_at: inHours(hours), price_cents: 1000, ...extra },
});

before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db, 'admin@test.com', 'adminpass123');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  adminToken = (await api('POST', '/api/auth/login', { body: { email: 'admin@test.com', password: 'adminpass123' } })).body.token;
  userToken = (await api('POST', '/api/auth/signup', { body: { name: 'Ann', email: 'ann@test.com', password: 'password123' } })).body.token;
  movieId = (await api('POST', '/api/movies', {
    token: adminToken, body: { title: 'Sim Movie', description: 'x', genres: ['Drama'], duration_min: 90 },
  })).body.id;
  hallId = (await api('POST', '/api/halls', { token: adminToken, body: { name: 'Hall', row_count: 8, seats_per_row: 12 } })).body.id;
});

after(() => server.close());

test('showtimes can be listed for an explicit time range (a local calendar day)', async () => {
  const a = (await schedule(5)).body;
  const b = (await schedule(50)).body;
  const shows = await api('GET', `/api/showtimes?from=${encodeURIComponent(inHours(0))}&to=${encodeURIComponent(inHours(24))}`);
  const ids = shows.body.data.map((s) => s.id);
  assert.ok(ids.includes(a.id));
  assert.ok(!ids.includes(b.id));
  assert.equal((await api('GET', '/api/showtimes?from=not-a-date')).status, 400);
});

test('seat scoring prefers center seats a little past the middle row', () => {
  assert.ok(seatScore('F6', 10, 12) > seatScore('A1', 10, 12));
  assert.ok(seatScore('F6', 10, 12) > seatScore('J12', 10, 12));
  assert.ok(seatScore('F6', 10, 12) > seatScore('A6', 10, 12));
});

test('target occupancy is higher for soon, evening, premium shows', () => {
  const soonEvening = new Date();
  soonEvening.setHours(21, 0, 0, 0);
  if (soonEvening <= new Date()) soonEvening.setDate(soonEvening.getDate() + 1);
  const farMatinee = new Date(Date.now() + 6 * 86_400_000);
  farMatinee.setHours(13, 0, 0, 0);
  const now = new Date(soonEvening.getTime() - 2 * 3_600_000);
  const hot = targetOccupancy({ id: 1, starts_at: soonEvening.toISOString(), experience: 'IMAX' }, now);
  const cold = targetOccupancy({ id: 1, starts_at: farMatinee.toISOString(), experience: 'Standard' }, now);
  assert.ok(hot > cold, `${hot} should exceed ${cold}`);
  assert.ok(hot <= 0.9 && cold >= 0.05);
});

test('simulator pre-books seats without ever double-booking or blocking real users', async () => {
  const show = (await schedule(2, { experience_id: db.prepare("SELECT id FROM experiences WHERE name = 'VIP'").get().id })).body;
  const simId = ensureSimulatedUser(db);
  assert.equal(ensureSimulatedUser(db), simId); // idempotent

  const booked = simulateTick(db, simId, { warmup: true });
  assert.ok(booked > 0);
  const seats = (await api('GET', `/api/showtimes/${show.id}/seats`)).body;
  const taken = seats.seats.filter((s) => s.status === 'reserved').length;
  assert.ok(taken > 0 && taken < seats.capacity, `taken ${taken} of ${seats.capacity}`);

  // Repeated live ticks never exceed capacity and never double-book (the unique index would throw).
  for (let i = 0; i < 40; i++) simulateTick(db, simId, { chance: 1 });
  const after = (await api('GET', `/api/showtimes/${show.id}/seats`)).body;
  assert.ok(after.available >= 0);
  const dupes = db.prepare(`SELECT seat_id FROM reservation_seats WHERE showtime_id = ? AND active = 1
                            GROUP BY seat_id HAVING COUNT(*) > 1`).all(show.id);
  assert.equal(dupes.length, 0);

  // A real user can still book any seat the simulator left free.
  const free = after.seats.find((s) => s.status === 'available');
  const mine = await api('POST', '/api/reservations', { token: userToken, body: { showtime_id: show.id, seats: [free.label] } });
  assert.equal(mine.status, 201);

  // Nobody can log in as the simulated account.
  assert.equal((await api('POST', '/api/auth/login', { body: { email: SIMULATED_EMAIL, password: '' } })).status, 400);
});

test('admins see all reservations with filters and totals', async () => {
  const all = await api('GET', '/api/admin/reservations?limit=100', { token: adminToken });
  assert.equal(all.status, 200);
  assert.ok(all.body.total >= 2);
  assert.ok(all.body.revenue_cents > 0);
  assert.ok(all.body.data[0].user_name);
  assert.ok(all.body.data[0].experience);

  const ann = await api('GET', '/api/admin/reservations?q=ann@test.com', { token: adminToken });
  assert.equal(ann.body.total, 1);
  assert.equal(ann.body.seats, 1);
  assert.equal(ann.body.revenue_cents, ann.body.data[0].total_cents);

  // Admins can cancel any upcoming reservation; regular users can't see the list.
  const cancel = await api('DELETE', `/api/reservations/${ann.body.data[0].id}`, { token: adminToken });
  assert.equal(cancel.body.status, 'cancelled');
  assert.equal((await api('GET', '/api/admin/reservations', { token: userToken })).status, 403);
});
