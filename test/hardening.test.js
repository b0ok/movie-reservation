import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp, ensureAdmin } from '../src/app.js';

process.env.JWT_SECRET = 'test-secret';
process.env.THEATRE_HOURS = '0-48'; // effectively always open

let server;
let base;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, 'admin@test.com', 'adminpass123');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

test('repeated failed logins are throttled, even with the right password afterwards', async () => {
  await api('POST', '/api/auth/signup', { body: { name: 'Vic', email: 'vic@test.com', password: 'password123' } });
  for (let i = 0; i < 5; i++) {
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'vic@test.com', password: 'wrong-guess' } })).status, 401);
  }
  const blocked = await api('POST', '/api/auth/login', { body: { email: 'VIC@test.com', password: 'password123' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Other accounts are unaffected.
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'admin@test.com', password: 'adminpass123' } })).status, 200);
});

test('started showtimes cannot be rescheduled', async () => {
  const admin = (await api('POST', '/api/auth/login', { body: { email: 'admin@test.com', password: 'adminpass123' } })).body.token;
  const movie = (await api('POST', '/api/movies', { token: admin, body: { title: 'M', description: 'd', genres: ['Drama'], duration_min: 60 } })).body;
  const hall = (await api('POST', '/api/halls', { token: admin, body: { name: 'H', row_count: 1, seats_per_row: 2 } })).body;
  const show = (await api('POST', '/api/showtimes', {
    token: admin, body: { movie_id: movie.id, hall_id: hall.id, starts_at: new Date(Date.now() + 2000).toISOString(), price_cents: 100 },
  })).body;
  await new Promise((r) => setTimeout(r, 2100));
  const res = await api('PATCH', `/api/showtimes/${show.id}`, { token: admin, body: { price_cents: 1 } });
  assert.equal(res.status, 409);
});
