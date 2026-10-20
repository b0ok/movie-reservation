import { Router } from 'express';
import { validate, parseId, parseDay, parsePaging } from '../validate.js';
import { notFound, conflict, badRequest } from '../errors.js';
import { requireAdmin } from '../auth.js';
import { transaction } from '../db.js';
import { assertWithinHours, ticketPrices } from '../theatre.js';

const SHOWTIME_SELECT = `
  SELECT s.id, s.starts_at, s.ends_at, s.price_cents,
         m.id AS movie_id, m.title AS movie_title, m.poster_url, m.duration_min,
         e.id AS experience_id, e.name AS experience, e.min_age,
         h.id AS hall_id, h.name AS hall_name,
         (SELECT COUNT(*) FROM seats WHERE hall_id = h.id) AS capacity,
         (SELECT COUNT(*) FROM reservation_seats rs WHERE rs.showtime_id = s.id AND rs.active = 1) AS reserved
  FROM showtimes s
  JOIN movies m ON m.id = s.movie_id
  JOIN halls h ON h.id = s.hall_id
  JOIN experiences e ON e.id = s.experience_id`;

const withAvailability = (row) => row && { ...row, available: row.capacity - row.reserved };

export default function showtimeRoutes(db, { auth }) {
  const router = Router();
  const getShowtime = db.prepare(`${SHOWTIME_SELECT} WHERE s.id = ?`);
  const findOverlap = db.prepare(`
    SELECT id, starts_at, ends_at FROM showtimes
    WHERE hall_id = ? AND id != ? AND starts_at < ? AND ends_at > ? LIMIT 1`);

  function assertHallFree(hallId, startsAt, endsAt, excludeId = 0) {
    const clash = findOverlap.get(hallId, excludeId, endsAt, startsAt);
    if (clash) throw conflict('Hall is already booked for an overlapping showtime', clash);
  }

  // Browse showtimes; defaults to upcoming. Filter by day and/or movie.
  router.get('/', (req, res) => {
    const { limit, offset } = parsePaging(req.query);
    const where = [];
    const params = [];
    if (req.query.date) {
      const [from, to] = parseDay(String(req.query.date));
      where.push('s.starts_at >= ? AND s.starts_at < ?');
      params.push(from, to);
    }
    if (req.query.from || req.query.to) {
      const range = validate({ from: req.query.from, to: req.query.to }, { from: { type: 'datetime' }, to: { type: 'datetime' } });
      if (range.from) { where.push('s.starts_at >= ?'); params.push(range.from); }
      if (range.to) { where.push('s.starts_at < ?'); params.push(range.to); }
    }
    // Past showtimes are never bookable, so they are hidden even within a requested day.
    where.push('s.starts_at > ?');
    params.push(new Date().toISOString());
    if (req.query.experience) { where.push('e.name = ? COLLATE NOCASE'); params.push(String(req.query.experience)); }
    if (req.query.movieId) { where.push('s.movie_id = ?'); params.push(parseId(req.query.movieId, 'movieId')); }
    const rows = db.prepare(`${SHOWTIME_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.starts_at LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    res.json({ data: rows.map(withAvailability), limit, offset });
  });

  router.get('/:id', (req, res) => {
    const st = getShowtime.get(parseId(req.params.id));
    if (!st) throw notFound('Showtime');
    res.json({ ...withAvailability(st), ticket_prices: ticketPrices(st.price_cents, st.min_age) });
  });

  // Seat map for a showtime: every seat in the hall and whether it is free.
  router.get('/:id/seats', (req, res) => {
    const id = parseId(req.params.id);
    const st = getShowtime.get(id);
    if (!st) throw notFound('Showtime');
    const seats = db.prepare(`
      SELECT se.id, se.label,
             CASE WHEN rs.seat_id IS NULL THEN 'available' ELSE 'reserved' END AS status
      FROM seats se
      LEFT JOIN reservation_seats rs ON rs.seat_id = se.id AND rs.showtime_id = ? AND rs.active = 1
      WHERE se.hall_id = ?
      ORDER BY substr(se.label, 1, 1), CAST(substr(se.label, 2) AS INTEGER)`).all(id, st.hall_id);
    res.json({ showtime_id: id, capacity: st.capacity, available: st.capacity - st.reserved, seats });
  });

  router.post('/', auth, requireAdmin, (req, res) => {
    const s = validate(req.body, {
      movie_id: { type: 'int', required: true, min: 1 },
      hall_id: { type: 'int', required: true, min: 1 },
      starts_at: { type: 'datetime', required: true },
      price_cents: { type: 'int', required: true, min: 0, max: 100_000 },
      experience_id: { type: 'int', min: 1 },
    });
    const experienceId = s.experience_id ?? db.prepare('SELECT id FROM experiences ORDER BY id LIMIT 1').get()?.id;
    if (!experienceId || !db.prepare('SELECT 1 FROM experiences WHERE id = ?').get(experienceId)) throw notFound('Experience');
    const movie = db.prepare('SELECT duration_min FROM movies WHERE id = ?').get(s.movie_id);
    if (!movie) throw notFound('Movie');
    if (!db.prepare('SELECT 1 FROM halls WHERE id = ?').get(s.hall_id)) throw notFound('Hall');
    if (s.starts_at <= new Date().toISOString()) throw badRequest('starts_at must be in the future');
    const endsAt = new Date(Date.parse(s.starts_at) + movie.duration_min * 60_000).toISOString();
    assertWithinHours(s.starts_at, endsAt);
    // Overlap check and insert share one write lock, so two admins can't both claim the same slot.
    const { lastInsertRowid } = transaction(db, () => {
      assertHallFree(s.hall_id, s.starts_at, endsAt);
      return db.prepare(
        'INSERT INTO showtimes (movie_id, hall_id, experience_id, starts_at, ends_at, price_cents) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(s.movie_id, s.hall_id, experienceId, s.starts_at, endsAt, s.price_cents);
    });
    res.status(201).json(withAvailability(getShowtime.get(lastInsertRowid)));
  });

  // Reschedule, reprice or change format. Hall and movie are fixed once created because seats are tied to the hall.
  router.patch('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    const st = getShowtime.get(id);
    if (!st) throw notFound('Showtime');
    if (st.starts_at <= new Date().toISOString()) throw conflict('Showtime has already started and can no longer be changed');
    const changes = validate(req.body, {
      starts_at: { type: 'datetime' },
      price_cents: { type: 'int', min: 0, max: 100_000 },
      experience_id: { type: 'int', min: 1 },
    }, { partial: true });
    if (!Object.keys(changes).length) throw badRequest('Provide starts_at, price_cents and/or experience_id');
    if (changes.experience_id && !db.prepare('SELECT 1 FROM experiences WHERE id = ?').get(changes.experience_id)) throw notFound('Experience');
    let { starts_at: startsAt, ends_at: endsAt } = st;
    if (changes.starts_at) {
      if (changes.starts_at <= new Date().toISOString()) throw badRequest('starts_at must be in the future');
      startsAt = changes.starts_at;
      endsAt = new Date(Date.parse(startsAt) + st.duration_min * 60_000).toISOString();
      assertWithinHours(startsAt, endsAt);
    }
    transaction(db, () => {
      if (changes.starts_at) assertHallFree(st.hall_id, startsAt, endsAt, id);
      db.prepare('UPDATE showtimes SET starts_at = ?, ends_at = ?, price_cents = ?, experience_id = ? WHERE id = ?')
        .run(startsAt, endsAt, changes.price_cents ?? st.price_cents, changes.experience_id ?? st.experience_id, id);
    });
    res.json(withAvailability(getShowtime.get(id)));
  });

  router.delete('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!getShowtime.get(id)) throw notFound('Showtime');
    if (db.prepare('SELECT 1 FROM reservations WHERE showtime_id = ?').get(id)) {
      throw conflict('Showtime has reservations and cannot be deleted');
    }
    db.prepare('DELETE FROM showtimes WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}
