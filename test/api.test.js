import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, MIGRATIONS } from '../src/db.js';
import { createApp, ensureAdmin } from '../src/app.js';

process.env.JWT_SECRET = 'test-secret';
process.env.THEATRE_HOURS = '0-48'; // effectively always open

let server;
let base;
let adminToken;
let userToken;
let otherToken;
let movieId;
let hallId;
let showtimeId;
let uploadDir;

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

before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, 'admin@test.com', 'adminpass123');
  uploadDir = mkdtempSync(join(tmpdir(), 'nat-uploads-'));
  server = createApp(db, { uploadDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

test('signup, login and me', async () => {
  const signup = await api('POST', '/api/auth/signup', { body: { name: 'Ann', email: 'ann@test.com', password: 'password123' } });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.role, 'user');
  assert.ok(signup.body.token);
  userToken = signup.body.token;

  assert.equal((await api('POST', '/api/auth/signup', { body: { name: 'A', email: 'ANN@test.com', password: 'password123' } })).status, 409);
  assert.equal((await api('POST', '/api/auth/signup', { body: { name: 'B', email: 'bad', password: 'short' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'ann@test.com', password: 'wrongpass' } })).status, 401);

  const login = await api('POST', '/api/auth/login', { body: { email: 'admin@test.com', password: 'adminpass123' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'admin');
  adminToken = login.body.token;

  otherToken = (await api('POST', '/api/auth/signup', { body: { name: 'Bob', email: 'bob@test.com', password: 'password123' } })).body.token;

  const me = await api('GET', '/api/auth/me', { token: userToken });
  assert.equal(me.body.email, 'ann@test.com');
  assert.equal((await api('GET', '/api/auth/me')).status, 401);
  assert.equal((await api('GET', '/api/auth/me', { token: 'garbage' })).status, 401);
});

test('only admins manage movies, halls and showtimes', async () => {
  const movie = { title: 'Test Movie', description: 'A test.', genres: ['Drama', 'Romance'], duration_min: 120 };
  assert.equal((await api('POST', '/api/movies', { token: userToken, body: movie })).status, 403);

  const created = await api('POST', '/api/movies', { token: adminToken, body: movie });
  assert.equal(created.status, 201);
  movieId = created.body.id;
  assert.deepEqual(created.body.genres, ['Drama', 'Romance']);
  assert.equal((await api('POST', '/api/movies', { token: adminToken, body: { title: 'No genre', description: 'x', genres: [], duration_min: 90 } })).status, 400);

  const hall = await api('POST', '/api/halls', { token: adminToken, body: { name: 'Small', row_count: 2, seats_per_row: 3 } });
  assert.equal(hall.status, 201);
  assert.equal(hall.body.capacity, 6);
  hallId = hall.body.id;

  const st = await api('POST', '/api/showtimes', {
    token: adminToken,
    body: { movie_id: movieId, hall_id: hallId, starts_at: inHours(24), price_cents: 1200 },
  });
  assert.equal(st.status, 201);
  assert.equal(st.body.available, 6);
  showtimeId = st.body.id;

  // 120-minute movie: a show one hour later in the same hall overlaps.
  const clash = await api('POST', '/api/showtimes', {
    token: adminToken,
    body: { movie_id: movieId, hall_id: hallId, starts_at: inHours(25), price_cents: 1200 },
  });
  assert.equal(clash.status, 409);

  const past = await api('POST', '/api/showtimes', {
    token: adminToken,
    body: { movie_id: movieId, hall_id: hallId, starts_at: inHours(-1), price_cents: 1200 },
  });
  assert.equal(past.status, 400);
});

test('browse movies and showtimes', async () => {
  const list = await api('GET', '/api/movies?genre=drama');
  assert.equal(list.body.total, 1);
  const detail = await api('GET', `/api/movies/${movieId}`);
  assert.equal(detail.body.showtimes.length, 1);
  const day = inHours(24).slice(0, 10);
  const shows = await api('GET', `/api/showtimes?date=${day}`);
  assert.ok(shows.body.data.some((s) => s.id === showtimeId));
  const seats = await api('GET', `/api/showtimes/${showtimeId}/seats`);
  assert.deepEqual(seats.body.seats.map((s) => s.label), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.equal((await api('GET', '/api/movies/9999')).status, 404);
});

test('reserve seats without overbooking', async () => {
  const r = await api('POST', '/api/reservations', { token: userToken, body: { showtime_id: showtimeId, seats: ['a1', 'A2'] } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.seats.sort(), ['A1', 'A2']);
  assert.equal(r.body.total_cents, 2400);

  const dup = await api('POST', '/api/reservations', { token: otherToken, body: { showtime_id: showtimeId, seats: ['A2', 'A3'] } });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body.details, ['A2']);

  assert.equal((await api('POST', '/api/reservations', { token: otherToken, body: { showtime_id: showtimeId, seats: ['Z9'] } })).status, 400);
  assert.equal((await api('POST', '/api/reservations', { token: otherToken, body: { showtime_id: showtimeId, seats: ['B1', 'B1'] } })).status, 400);
  assert.equal((await api('POST', '/api/reservations', { body: { showtime_id: showtimeId, seats: ['B1'] } })).status, 401);

  // Concurrent requests for the same seat: exactly one wins.
  const results = await Promise.all([userToken, otherToken].map((token) =>
    api('POST', '/api/reservations', { token, body: { showtime_id: showtimeId, seats: ['B3'] } })));
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409]);

  const seats = await api('GET', `/api/showtimes/${showtimeId}/seats`);
  assert.equal(seats.body.available, 3);
});

test('list, view and cancel own reservations', async () => {
  const mine = await api('GET', '/api/reservations', { token: userToken });
  assert.ok(mine.body.length >= 1);
  const target = mine.body.find((r) => r.seats.includes('A1'));

  assert.equal((await api('GET', `/api/reservations/${target.id}`, { token: otherToken })).status, 404);
  assert.equal((await api('DELETE', `/api/reservations/${target.id}`, { token: otherToken })).status, 404);

  const cancelled = await api('DELETE', `/api/reservations/${target.id}`, { token: userToken });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await api('DELETE', `/api/reservations/${target.id}`, { token: userToken })).status, 409);

  // Freed seats are bookable again.
  const rebook = await api('POST', '/api/reservations', { token: otherToken, body: { showtime_id: showtimeId, seats: ['A1'] } });
  assert.equal(rebook.status, 201);
});

test('admin reports', async () => {
  assert.equal((await api('GET', '/api/admin/reports/summary', { token: userToken })).status, 403);

  const summary = await api('GET', '/api/admin/reports/summary', { token: adminToken });
  assert.equal(summary.status, 200);
  assert.equal(summary.body.capacity, 6);
  assert.equal(summary.body.seats_sold, 2); // B3 + A1 (A1/A2 reservation was cancelled)
  assert.equal(summary.body.cancelled_reservations, 1);
  assert.equal(summary.body.revenue_cents, 2400);

  const byShow = await api('GET', '/api/admin/reports/showtimes', { token: adminToken });
  assert.equal(byShow.body[0].occupancy_pct, 33.3);

  const byMovie = await api('GET', '/api/admin/reports/movies', { token: adminToken });
  assert.equal(byMovie.body[0].seats_sold, 2);

  const all = await api('GET', '/api/admin/reservations?status=cancelled', { token: adminToken });
  assert.equal(all.body.data.length, 1);

  // Showtimes with reservations cannot be deleted.
  assert.equal((await api('DELETE', `/api/showtimes/${showtimeId}`, { token: adminToken })).status, 409);
});

test('admin can promote a user', async () => {
  const users = await api('GET', '/api/admin/users', { token: adminToken });
  const bob = users.body.data.find((u) => u.email === 'bob@test.com');
  const promoted = await api('PATCH', `/api/admin/users/${bob.id}/role`, { token: adminToken, body: { role: 'admin' } });
  assert.equal(promoted.body.role, 'admin');
  // Role is read from the DB per request, so Bob's existing token gains access immediately.
  assert.equal((await api('GET', '/api/admin/reports/summary', { token: otherToken })).status, 200);
});
