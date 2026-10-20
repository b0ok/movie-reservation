import { Router, raw } from 'express';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validate, parseId, parsePaging, parseDay } from '../validate.js';
import { notFound, conflict, badRequest } from '../errors.js';
import { requireAdmin } from '../auth.js';
import { transaction } from '../db.js';

const MOVIE_RULES = {
  title: { type: 'string', required: true, min: 1, max: 200 },
  description: { type: 'string', required: true, min: 1, max: 2000 },
  poster_url: { type: 'string', max: 500, pattern: /^https?:\/\// },
  genres: { type: 'stringArray', required: true, min: 1, max: 5 },
  duration_min: { type: 'int', required: true, min: 1, max: 600 },
};

const MOVIE_SELECT = `
  SELECT m.*,
         (SELECT json_group_array(name) FROM (
            SELECT g.name FROM movie_genres mg JOIN genres g ON g.id = mg.genre_id
            WHERE mg.movie_id = m.id ORDER BY g.name)) AS genres_json
  FROM movies m`;

export const formatMovie = (row) => {
  if (!row) return row;
  const { genres_json, ...rest } = row;
  return { ...rest, genres: JSON.parse(genres_json) };
};

// Identify the image by its magic bytes rather than trusting the Content-Type header.
function imageExtension(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'gif';
  return null;
}

export default function movieRoutes(db, { auth, uploadDir }) {
  const router = Router();
  const posterDir = join(uploadDir, 'posters');
  const getMovie = (id) => formatMovie(db.prepare(`${MOVIE_SELECT} WHERE m.id = ?`).get(id));

  // Replaces a movie's genres, creating any genre names that don't exist yet.
  function setGenres(movieId, names) {
    const unique = [...new Map(names.map((n) => [n.toLowerCase(), n])).values()];
    db.prepare('DELETE FROM movie_genres WHERE movie_id = ?').run(movieId);
    for (const name of unique) {
      db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run(name);
      const { id } = db.prepare('SELECT id FROM genres WHERE name = ?').get(name);
      db.prepare('INSERT INTO movie_genres (movie_id, genre_id) VALUES (?, ?)').run(movieId, id);
    }
  }

  // Only files this server uploaded are deleted; external poster URLs are left alone.
  function removeUploadedPoster(url) {
    if (!url?.startsWith('/uploads/posters/')) return;
    try { unlinkSync(join(posterDir, basename(url))); } catch { /* already gone */ }
  }

  // Public browse: filter by genre, title search, experience, or movies with showtimes on a given day.
  router.get('/', (req, res) => {
    const { limit, offset } = parsePaging(req.query);
    const where = [];
    const params = [];
    if (req.query.genre) {
      where.push(`EXISTS (SELECT 1 FROM movie_genres mg JOIN genres g ON g.id = mg.genre_id
                  WHERE mg.movie_id = m.id AND g.name = ?)`);
      params.push(String(req.query.genre));
    }
    if (req.query.q) { where.push('m.title LIKE ?'); params.push(`%${String(req.query.q)}%`); }
    if (req.query.date) {
      const [from, to] = parseDay(String(req.query.date));
      where.push('EXISTS (SELECT 1 FROM showtimes s WHERE s.movie_id = m.id AND s.starts_at >= ? AND s.starts_at < ?)');
      params.push(from, to);
    }
    if (req.query.experience) {
      where.push(`EXISTS (SELECT 1 FROM showtimes s JOIN experiences e ON e.id = s.experience_id
                  WHERE s.movie_id = m.id AND e.name = ? COLLATE NOCASE AND s.starts_at > ?)`);
      params.push(String(req.query.experience), new Date().toISOString());
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const movies = db.prepare(`${MOVIE_SELECT} ${clause} ORDER BY m.title LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM movies m ${clause}`).get(...params);
    res.json({ data: movies.map(formatMovie), total, limit, offset });
  });

  // Movie detail with its upcoming showtimes.
  router.get('/:id', (req, res) => {
    const movie = getMovie(parseId(req.params.id));
    if (!movie) throw notFound('Movie');
    const showtimes = db.prepare(`
      SELECT s.id, s.starts_at, s.ends_at, s.price_cents, h.id AS hall_id, h.name AS hall_name,
             e.id AS experience_id, e.name AS experience
      FROM showtimes s JOIN halls h ON h.id = s.hall_id JOIN experiences e ON e.id = s.experience_id
      WHERE s.movie_id = ? AND s.starts_at > ?
      ORDER BY s.starts_at`).all(movie.id, new Date().toISOString());
    res.json({ ...movie, showtimes });
  });

  router.post('/', auth, requireAdmin, (req, res) => {
    const m = validate(req.body, MOVIE_RULES);
    const id = transaction(db, () => {
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO movies (title, description, poster_url, duration_min) VALUES (?, ?, ?, ?)',
      ).run(m.title, m.description, m.poster_url ?? null, m.duration_min);
      setGenres(lastInsertRowid, m.genres);
      return lastInsertRowid;
    });
    res.status(201).json(getMovie(id));
  });

  router.patch('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    const existing = getMovie(id);
    if (!existing) throw notFound('Movie');
    const { genres, ...changes } = validate(req.body, MOVIE_RULES, { partial: true });
    const fields = Object.keys(changes);
    if (!fields.length && !genres) throw badRequest('No updatable fields provided');
    // Changing duration would silently invalidate scheduled showtime end times and hall overlap checks.
    if ('duration_min' in changes && changes.duration_min !== existing.duration_min
        && db.prepare('SELECT 1 FROM showtimes WHERE movie_id = ?').get(id)) {
      throw conflict('Cannot change duration of a movie that already has showtimes');
    }
    transaction(db, () => {
      if (fields.length) {
        db.prepare(`UPDATE movies SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
          .run(...fields.map((f) => changes[f]), id);
      }
      if (genres) setGenres(id, genres);
    });
    if ('poster_url' in changes && changes.poster_url !== existing.poster_url) removeUploadedPoster(existing.poster_url);
    res.json(getMovie(id));
  });

  router.delete('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    const movie = getMovie(id);
    if (!movie) throw notFound('Movie');
    if (db.prepare('SELECT 1 FROM showtimes WHERE movie_id = ?').get(id)) {
      throw conflict('Movie has showtimes; delete them first');
    }
    db.prepare('DELETE FROM movies WHERE id = ?').run(id);
    removeUploadedPoster(movie.poster_url);
    res.status(204).end();
  });

  // Upload a poster: send the raw image bytes (JPEG, PNG, WebP or GIF, max 5 MB) as the request body.
  router.put('/:id/poster', auth, requireAdmin, raw({ type: () => true, limit: '5mb' }), (req, res) => {
    const id = parseId(req.params.id);
    const movie = getMovie(id);
    if (!movie) throw notFound('Movie');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ext = imageExtension(buf);
    if (!ext) throw badRequest('Poster must be a JPEG, PNG, WebP or GIF image');
    mkdirSync(posterDir, { recursive: true });
    const file = `${id}-${Date.now()}.${ext}`;
    writeFileSync(join(posterDir, file), buf);
    db.prepare('UPDATE movies SET poster_url = ? WHERE id = ?').run(`/uploads/posters/${file}`, id);
    removeUploadedPoster(movie.poster_url);
    res.json(getMovie(id));
  });

  router.delete('/:id/poster', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    const movie = getMovie(id);
    if (!movie) throw notFound('Movie');
    db.prepare('UPDATE movies SET poster_url = NULL WHERE id = ?').run(id);
    removeUploadedPoster(movie.poster_url);
    res.json(getMovie(id));
  });

  return router;
}
