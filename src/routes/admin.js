import { Router } from 'express';
import { validate, parseId, parsePaging, parseDay } from '../validate.js';
import { notFound, badRequest } from '../errors.js';
import { formatReservation } from './reservations.js';

// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive) filter on showtime start.
function dateRange(query) {
  const clauses = [];
  const params = [];
  if (query.from) { clauses.push('s.starts_at >= ?'); params.push(parseDay(String(query.from))[0]); }
  if (query.to) { clauses.push('s.starts_at < ?'); params.push(parseDay(String(query.to))[1]); }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

export default function adminRoutes(db) {
  const router = Router();

  // All reservations, filterable by showtime, user, status and date range.
  router.get('/reservations', (req, res) => {
    const { limit, offset } = parsePaging(req.query);
    const range = dateRange(req.query);
    let sql = range.sql;
    const params = [...range.params];
    if (req.query.showtimeId) { sql += ' AND r.showtime_id = ?'; params.push(parseId(req.query.showtimeId, 'showtimeId')); }
    if (req.query.userId) { sql += ' AND r.user_id = ?'; params.push(parseId(req.query.userId, 'userId')); }
    if (req.query.movieId) { sql += ' AND s.movie_id = ?'; params.push(parseId(req.query.movieId, 'movieId')); }
    if (req.query.q) { sql += ' AND (u.email LIKE ? OR u.name LIKE ? OR m.title LIKE ?)'; const q = `%${String(req.query.q)}%`; params.push(q, q, q); }
    if (req.query.upcoming === 'true') { sql += ' AND s.starts_at > ?'; params.push(new Date().toISOString()); }
    if (req.query.status) {
      if (!['confirmed', 'cancelled'].includes(req.query.status)) throw badRequest('status must be confirmed or cancelled');
      sql += ' AND r.status = ?'; params.push(req.query.status);
    }
    const rows = db.prepare(`
      SELECT r.id, r.status, r.total_cents, r.created_at, r.cancelled_at,
             u.id AS user_id, u.name AS user_name, u.email AS user_email,
             s.id AS showtime_id, s.starts_at, m.title AS movie_title, h.name AS hall_name,
             (SELECT name FROM experiences WHERE id = s.experience_id) AS experience,
             (SELECT group_concat(se.label, ',') FROM reservation_seats rs
                JOIN seats se ON se.id = rs.seat_id WHERE rs.reservation_id = r.id) AS seat_labels
      FROM reservations r
      JOIN users u ON u.id = r.user_id
      JOIN showtimes s ON s.id = r.showtime_id
      JOIN movies m ON m.id = s.movie_id
      JOIN halls h ON h.id = s.hall_id
      WHERE 1 = 1 ${sql}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const totals = db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN r.status = 'confirmed' THEN r.total_cents END), 0) AS revenue_cents,
             COALESCE(SUM(CASE WHEN r.status = 'confirmed' THEN
               (SELECT COUNT(*) FROM reservation_seats rs WHERE rs.reservation_id = r.id) END), 0) AS seats
      FROM reservations r
      JOIN users u ON u.id = r.user_id
      JOIN showtimes s ON s.id = r.showtime_id
      JOIN movies m ON m.id = s.movie_id
      WHERE 1 = 1 ${sql}`).get(...params);
    res.json({ data: rows.map(formatReservation), ...totals, limit, offset });
  });

  // Headline numbers: reservations, seats sold, revenue, overall occupancy.
  router.get('/reports/summary', (req, res) => {
    const range = dateRange(req.query);
    const totals = db.prepare(`
      SELECT
        COUNT(CASE WHEN r.status = 'confirmed' THEN 1 END) AS confirmed_reservations,
        COUNT(CASE WHEN r.status = 'cancelled' THEN 1 END) AS cancelled_reservations,
        COALESCE(SUM(CASE WHEN r.status = 'confirmed' THEN r.total_cents END), 0) AS revenue_cents
      FROM reservations r JOIN showtimes s ON s.id = r.showtime_id
      WHERE 1 = 1 ${range.sql}`).get(...range.params);
    const seats = db.prepare(`
      SELECT COUNT(*) AS showtimes,
             COALESCE(SUM((SELECT COUNT(*) FROM seats WHERE hall_id = s.hall_id)), 0) AS capacity,
             COALESCE(SUM((SELECT COUNT(*) FROM reservation_seats rs WHERE rs.showtime_id = s.id AND rs.active = 1)), 0) AS seats_sold
      FROM showtimes s WHERE 1 = 1 ${range.sql}`).get(...range.params);
    res.json({
      ...totals,
      ...seats,
      occupancy_pct: seats.capacity ? Math.round((seats.seats_sold / seats.capacity) * 1000) / 10 : 0,
    });
  });

  // Per-showtime capacity, seats sold, occupancy and revenue.
  router.get('/reports/showtimes', (req, res) => {
    const range = dateRange(req.query);
    const rows = db.prepare(`
      SELECT s.id AS showtime_id, s.starts_at, m.title AS movie_title, h.name AS hall_name,
             (SELECT name FROM experiences WHERE id = s.experience_id) AS experience,
             (SELECT COUNT(*) FROM seats WHERE hall_id = s.hall_id) AS capacity,
             (SELECT COUNT(*) FROM reservation_seats rs WHERE rs.showtime_id = s.id AND rs.active = 1) AS seats_sold,
             COALESCE((SELECT SUM(total_cents) FROM reservations r WHERE r.showtime_id = s.id AND r.status = 'confirmed'), 0) AS revenue_cents
      FROM showtimes s JOIN movies m ON m.id = s.movie_id JOIN halls h ON h.id = s.hall_id
      WHERE 1 = 1 ${range.sql}
      ORDER BY s.starts_at`).all(...range.params);
    res.json(rows.map((r) => ({
      ...r,
      occupancy_pct: r.capacity ? Math.round((r.seats_sold / r.capacity) * 1000) / 10 : 0,
    })));
  });

  // Per-movie totals, best sellers first.
  router.get('/reports/movies', (req, res) => {
    const range = dateRange(req.query);
    res.json(db.prepare(`
      SELECT m.id AS movie_id, m.title,
             COUNT(DISTINCT s.id) AS showtimes,
             COALESCE(SUM((SELECT COUNT(*) FROM reservation_seats rs WHERE rs.showtime_id = s.id AND rs.active = 1)), 0) AS seats_sold,
             COALESCE(SUM((SELECT SUM(total_cents) FROM reservations r WHERE r.showtime_id = s.id AND r.status = 'confirmed')), 0) AS revenue_cents
      FROM movies m JOIN showtimes s ON s.movie_id = m.id
      WHERE 1 = 1 ${range.sql}
      GROUP BY m.id ORDER BY revenue_cents DESC, m.title`).all(...range.params));
  });

  // Per-experience totals: which formats (IMAX, 3D, ...) sell.
  router.get('/reports/experiences', (req, res) => {
    const range = dateRange(req.query);
    res.json(db.prepare(`
      SELECT e.id AS experience_id, e.name,
             COUNT(s.id) AS showtimes,
             COALESCE(SUM((SELECT COUNT(*) FROM reservation_seats rs WHERE rs.showtime_id = s.id AND rs.active = 1)), 0) AS seats_sold,
             COALESCE(SUM((SELECT SUM(total_cents) FROM reservations r WHERE r.showtime_id = s.id AND r.status = 'confirmed')), 0) AS revenue_cents
      FROM experiences e LEFT JOIN showtimes s ON s.experience_id = e.id ${range.sql}
      GROUP BY e.id ORDER BY revenue_cents DESC, e.name`).all(...range.params));
  });

  router.get('/users', (req, res) => {
    const { limit, offset } = parsePaging(req.query);
    res.json({
      data: db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY id LIMIT ? OFFSET ?').all(limit, offset),
      limit,
      offset,
    });
  });

  // Promote a user to admin (or demote back to user).
  router.patch('/users/:id/role', (req, res) => {
    const id = parseId(req.params.id);
    const { role } = validate(req.body, { role: { type: 'string', required: true, oneOf: ['user', 'admin'] } });
    if (id === req.user.id && role !== 'admin') throw badRequest('You cannot demote yourself');
    const { changes } = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (!changes) throw notFound('User');
    res.json(db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(id));
  });

  return router;
}
