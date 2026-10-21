import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, MIGRATIONS } from '../src/db.js';
import { createApp, ensureAdmin } from '../src/app.js';

process.env.JWT_SECRET = 'test-secret';
process.env.ALLOW_SIGNUP = 'true';
process.env.THEATRE_HOURS = '0-48'; // effectively always open

let server;
let base;
let adminToken;
let userToken;
let movieId;
let hallId;
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

  adminToken = (await api('POST', '/api/auth/login', { body: { email: 'admin@test.com', password: 'adminpass123' } })).body.token;
  userToken = (await api('POST', '/api/auth/signup', { body: { name: 'Ann', email: 'ann@test.com', password: 'password123' } })).body.token;
  movieId = (await api('POST', '/api/movies', {
    token: adminToken, body: { title: 'Test Movie', description: 'A test.', genres: ['Drama', 'Mystery'], duration_min: 120 },
  })).body.id;
  hallId = (await api('POST', '/api/halls', { token: adminToken, body: { name: 'Small', row_count: 2, seats_per_row: 3 } })).body.id;
});

after(() => server.close());

test('movies require a description and at least one genre', async () => {
  const missing = await api('POST', '/api/movies', { token: adminToken, body: { title: 'X', genres: [], duration_min: 90 } });
  assert.equal(missing.status, 400);
  assert.ok(missing.body.details.some((d) => d.startsWith('description')));
  assert.ok(missing.body.details.some((d) => d.startsWith('genres')));
});

test('admins can update a movie and its genres', async () => {
  const updated = await api('PATCH', `/api/movies/${movieId}`, {
    token: adminToken, body: { title: "Test Movie: Director's Cut", genres: ['Drama', 'Thriller'] },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.title, "Test Movie: Director's Cut");
  assert.deepEqual(updated.body.genres, ['Drama', 'Thriller']);
  assert.equal((await api('PATCH', `/api/movies/${movieId}`, { token: userToken, body: { title: 'x' } })).status, 403);
  assert.equal((await api('GET', '/api/movies?genre=thriller')).body.total, 1);
  assert.equal((await api('GET', '/api/movies?genre=mystery')).body.total, 0);
});

test('admins can toggle a movie into Now Playing', async () => {
  const on = await api('PATCH', `/api/movies/${movieId}`, { token: adminToken, body: { now_playing: 1 } });
  assert.equal(on.status, 200);
  assert.equal(on.body.now_playing, 1);
  assert.equal((await api('PATCH', `/api/movies/${movieId}`, { token: adminToken, body: { now_playing: 2 } })).status, 400);
  assert.equal((await api('PATCH', `/api/movies/${movieId}`, { token: userToken, body: { now_playing: 0 } })).status, 403);
  assert.equal((await api('PATCH', `/api/movies/${movieId}`, { token: adminToken, body: { now_playing: 0 } })).body.now_playing, 0);
});

test('reviews: admin writes, updates and deletes one per film; everyone can read', async () => {
  const url = `/api/movies/${movieId}/review`;
  assert.equal((await api('PUT', url, { token: userToken, body: { rating: 8 } })).status, 403);
  assert.equal((await api('PUT', url, { token: adminToken, body: { rating: 11 } })).status, 400);
  assert.equal((await api('PUT', url, { token: adminToken, body: { rating: 8, watched_on: '2026-02-31' } })).status, 400);
  const saved = await api('PUT', url, { token: adminToken, body: { rating: 8, body: 'Great.', watched_on: '2026-10-01' } });
  assert.equal(saved.status, 200);
  assert.equal((await api('PUT', url, { token: adminToken, body: { rating: 9 } })).body.rating, 9);
  const detail = (await api('GET', `/api/movies/${movieId}`)).body;
  assert.equal(detail.review.rating, 9);
  assert.equal(detail.my_rating, 9);
  assert.equal((await api('GET', '/api/movies/reviews')).body.length, 1);
  assert.equal((await api('DELETE', url, { token: adminToken })).status, 204);
  assert.equal((await api('GET', `/api/movies/${movieId}`)).body.review, null);
  assert.equal((await api('DELETE', url, { token: adminToken })).status, 404);
});

test('genres: a movie keeps at least one', async () => {
  const genres = (await api('GET', '/api/genres')).body;
  const thriller = genres.find((g) => g.name === 'Thriller');
  assert.equal(thriller.movie_count, 1);
  // Thriller can go because the movie still has Drama; then Drama is its only genre and can't.
  assert.equal((await api('DELETE', `/api/genres/${thriller.id}`, { token: adminToken })).status, 204);
  const drama = genres.find((g) => g.name === 'Drama');
  const blocked = await api('DELETE', `/api/genres/${drama.id}`, { token: adminToken });
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.details, ["Test Movie: Director's Cut"]);
});

test('poster upload accepts real images only and cleans up files', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const put = (body) => fetch(`${base}/api/movies/${movieId}/poster`, {
    method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'image/png' }, body,
  });

  const up = await put(png);
  assert.equal(up.status, 200);
  const { poster_url: posterUrl } = await up.json();
  assert.match(posterUrl, /^\/uploads\/posters\/\d+-\d+\.png$/);
  assert.equal((await fetch(base + posterUrl)).status, 200);

  assert.equal((await put('<?php echo "not an image";')).status, 400);

  const cleared = await api('DELETE', `/api/movies/${movieId}/poster`, { token: adminToken });
  assert.equal(cleared.body.poster_url, null);
  assert.equal(existsSync(join(uploadDir, 'posters', posterUrl.split('/').pop())), false);
});

test('experiences: seeded list, admin create, schedule, filter and report', async () => {
  const list = (await api('GET', '/api/experiences')).body;
  assert.deepEqual(list.map((e) => e.name).sort(), ['4DX', 'Standard', 'VIP']);

  const created = await api('POST', '/api/experiences', {
    token: adminToken, body: { name: 'Drive-In', description: 'Watch from your car.', surcharge_cents: 500 },
  });
  assert.equal(created.status, 201);
  assert.equal((await api('POST', '/api/experiences', { token: userToken, body: { name: 'Nope' } })).status, 403);
  assert.equal((await api('POST', '/api/experiences', { token: adminToken, body: { name: 'vip' } })).status, 409);

  const vip = list.find((e) => e.name === 'VIP');
  const st = await api('POST', '/api/showtimes', {
    token: adminToken,
    body: { movie_id: movieId, hall_id: hallId, experience_id: vip.id, starts_at: inHours(24), price_cents: 2250 },
  });
  assert.equal(st.status, 201);
  assert.equal(st.body.experience, 'VIP');

  const plain = await api('POST', '/api/showtimes', {
    token: adminToken, body: { movie_id: movieId, hall_id: hallId, starts_at: inHours(30), price_cents: 1500 },
  });
  assert.equal(plain.body.experience, 'Standard');

  assert.deepEqual((await api('GET', '/api/showtimes?experience=vip')).body.data.map((s) => s.id), [st.body.id]);
  assert.equal((await api('GET', '/api/movies?experience=VIP')).body.total, 1);

  await api('POST', '/api/reservations', { token: userToken, body: { showtime_id: st.body.id, seats: ['A1', 'A2'] } });
  const report = (await api('GET', '/api/admin/reports/experiences', { token: adminToken })).body;
  assert.deepEqual(report.find((r) => r.name === 'VIP'), { experience_id: vip.id, name: 'VIP', showtimes: 1, seats_sold: 2, revenue_cents: 4500 });

  const changed = await api('PATCH', `/api/showtimes/${plain.body.id}`, { token: adminToken, body: { experience_id: created.body.id } });
  assert.equal(changed.body.experience, 'Drive-In');
  assert.equal((await api('DELETE', `/api/experiences/${created.body.id}`, { token: adminToken })).status, 409);

  const ticket = (await api('GET', '/api/reservations', { token: userToken })).body[0];
  assert.equal(ticket.experience, 'VIP');
});

test('migration converts an existing single-genre database', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nat-db-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(MIGRATIONS[0]);
  old.exec("INSERT INTO movies (title, genre, duration_min) VALUES ('Old Film', 'Western', 100)");
  old.exec("INSERT INTO halls (name, row_count, seats_per_row) VALUES ('H', 1, 1)");
  old.exec(`INSERT INTO showtimes (movie_id, hall_id, starts_at, ends_at, price_cents)
            VALUES (1, 1, '2030-01-01T00:00:00.000Z', '2030-01-01T01:40:00.000Z', 1000)`);
  old.close();

  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const genre = db.prepare('SELECT g.name FROM movie_genres mg JOIN genres g ON g.id = mg.genre_id WHERE mg.movie_id = 1').get();
  assert.equal(genre.name, 'Western');
  const exp = db.prepare('SELECT e.name FROM showtimes s JOIN experiences e ON e.id = s.experience_id').get();
  assert.equal(exp.name, 'Standard');
  db.close();
});
