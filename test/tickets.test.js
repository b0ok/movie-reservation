import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp, ensureAdmin } from '../src/app.js';

process.env.JWT_SECRET = 'test-secret';
process.env.THEATRE_TZ = 'UTC';
process.env.THEATRE_HOURS = '12-24';

let server;
let base;
let admin;
let user;
let movieId;
let hallId;
let vipId;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// A UTC time `days` from now at hh:mm (THEATRE_TZ is UTC here).
function at(days, hh, mm = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

const schedule = (startsAt, extra = {}) => api('POST', '/api/showtimes', {
  token: admin, body: { movie_id: movieId, hall_id: hallId, starts_at: startsAt, price_cents: 1500, ...extra },
});

before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, 'admin@test.com', 'adminpass123');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  admin = (await api('POST', '/api/auth/login', { body: { email: 'admin@test.com', password: 'adminpass123' } })).body.token;
  user = (await api('POST', '/api/auth/signup', { body: { name: 'Kim', email: 'kim@test.com', password: 'password123' } })).body.token;
  movieId = (await api('POST', '/api/movies', { token: admin, body: { title: 'T', description: 'd', genres: ['Drama'], duration_min: 120 } })).body.id;
  hallId = (await api('POST', '/api/halls', { token: admin, body: { name: 'H', row_count: 3, seats_per_row: 4 } })).body.id;
  vipId = (await api('GET', '/api/experiences')).body.find((e) => e.name === 'VIP').id;
});

after(() => server.close());

test('theatre info exposes hours and ticket types', async () => {
  const info = (await api('GET', '/api/theatre')).body;
  assert.equal(info.name, 'The Nguyen Awards Theatre');
  assert.equal(info.opens_hour, 12);
  assert.equal(info.closes_hour, 24);
  assert.deepEqual(Object.keys(info.ticket_types), ['adult', 'child', 'senior']);
});

test('showtimes must fit inside 12:00 PM to midnight', async () => {
  assert.equal((await schedule(at(2, 11, 30))).status, 400); // starts before opening
  assert.equal((await schedule(at(2, 22, 30))).status, 400); // 120 min would end at 00:30
  assert.equal((await schedule(at(2, 12, 0))).status, 201); // first show at opening
  assert.equal((await schedule(at(2, 22, 0))).status, 201); // ends exactly at midnight
  const res = await schedule(at(3, 9, 0));
  assert.match(res.body.error, /12:00 PM.*12:00 AM/);
});

test('ticket types are priced per seat and must match the seat count', async () => {
  const show = (await schedule(at(4, 15, 0))).body;
  const detail = (await api('GET', `/api/showtimes/${show.id}`)).body;
  assert.deepEqual(detail.ticket_prices.map((t) => [t.type, t.price_cents]), [['adult', 1500], ['child', 1100], ['senior', 1200]]);

  const r = await api('POST', '/api/reservations', {
    token: user, body: { showtime_id: show.id, seats: ['A1', 'A2', 'A3'], tickets: { adult: 1, child: 1, senior: 1 } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total_cents, 1500 + 1100 + 1200);
  assert.deepEqual(r.body.tickets.map((t) => [t.type, t.count]).sort(), [['adult', 1], ['child', 1], ['senior', 1]]);

  const mismatch = await api('POST', '/api/reservations', {
    token: user, body: { showtime_id: show.id, seats: ['B1', 'B2'], tickets: { adult: 1 } },
  });
  assert.equal(mismatch.status, 400);
  const bogus = await api('POST', '/api/reservations', {
    token: user, body: { showtime_id: show.id, seats: ['B1'], tickets: { student: 1 } },
  });
  assert.equal(bogus.status, 400);

  // Without a tickets object, every seat is general admission.
  const plain = await api('POST', '/api/reservations', { token: user, body: { showtime_id: show.id, seats: ['C1', 'C2'] } });
  assert.equal(plain.body.total_cents, 3000);
});

test('VIP is 19+: no child tickets', async () => {
  const show = (await schedule(at(5, 19, 0), { experience_id: vipId })).body;
  const detail = (await api('GET', `/api/showtimes/${show.id}`)).body;
  assert.equal(detail.min_age, 19);
  assert.ok(!detail.ticket_prices.some((t) => t.type === 'child'));
  const kid = await api('POST', '/api/reservations', {
    token: user, body: { showtime_id: show.id, seats: ['A1'], tickets: { child: 1 } },
  });
  assert.equal(kid.status, 400);
  assert.match(kid.body.error, /19\+/);
});
