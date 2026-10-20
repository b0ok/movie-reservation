import { Router } from 'express';
import { validate, parseId } from '../validate.js';
import { notFound, conflict, badRequest } from '../errors.js';
import { requireAdmin } from '../auth.js';

// Genres: public list with movie counts; admins can add, rename and delete.
export function genreRoutes(db, { auth }) {
  const router = Router();
  const getGenre = db.prepare(`
    SELECT g.id, g.name, (SELECT COUNT(*) FROM movie_genres WHERE genre_id = g.id) AS movie_count
    FROM genres g WHERE g.id = ?`);

  router.get('/', (_req, res) => {
    res.json(db.prepare(`
      SELECT g.id, g.name, (SELECT COUNT(*) FROM movie_genres WHERE genre_id = g.id) AS movie_count
      FROM genres g ORDER BY g.name`).all());
  });

  router.post('/', auth, requireAdmin, (req, res) => {
    const { name } = validate(req.body, { name: { type: 'string', required: true, min: 1, max: 50 } });
    if (db.prepare('SELECT 1 FROM genres WHERE name = ?').get(name)) throw conflict('Genre already exists');
    const { lastInsertRowid } = db.prepare('INSERT INTO genres (name) VALUES (?)').run(name);
    res.status(201).json(getGenre.get(lastInsertRowid));
  });

  router.patch('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!getGenre.get(id)) throw notFound('Genre');
    const { name } = validate(req.body, { name: { type: 'string', required: true, min: 1, max: 50 } });
    if (db.prepare('SELECT 1 FROM genres WHERE name = ? AND id != ?').get(name, id)) throw conflict('Genre already exists');
    db.prepare('UPDATE genres SET name = ? WHERE id = ?').run(name, id);
    res.json(getGenre.get(id));
  });

  // A movie must keep at least one genre, so a genre that is some movie's only genre can't be deleted.
  router.delete('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!getGenre.get(id)) throw notFound('Genre');
    const orphans = db.prepare(`
      SELECT m.title FROM movie_genres mg JOIN movies m ON m.id = mg.movie_id
      WHERE mg.genre_id = ? AND (SELECT COUNT(*) FROM movie_genres x WHERE x.movie_id = mg.movie_id) = 1`).all(id);
    if (orphans.length) throw conflict('These movies would be left without a genre', orphans.map((o) => o.title));
    db.prepare('DELETE FROM genres WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}

const EXPERIENCE_RULES = {
  name: { type: 'string', required: true, min: 1, max: 40 },
  min_age: { type: 'int', min: 0, max: 21 },
  description: { type: 'string', max: 300 },
  surcharge_cents: { type: 'int', min: 0, max: 100_000 },
};

// Experiences (Standard, IMAX, 3D, 4DX, ...): a format a showtime is presented in, with a ticket surcharge.
export function experienceRoutes(db, { auth }) {
  const router = Router();
  const getExperience = db.prepare(`
    SELECT e.*, (SELECT COUNT(*) FROM showtimes s WHERE s.experience_id = e.id AND s.starts_at > ?) AS upcoming_showtimes
    FROM experiences e WHERE e.id = ?`);
  const one = (id) => getExperience.get(new Date().toISOString(), id);

  router.get('/', (_req, res) => {
    res.json(db.prepare(`
      SELECT e.*, (SELECT COUNT(*) FROM showtimes s WHERE s.experience_id = e.id AND s.starts_at > ?) AS upcoming_showtimes
      FROM experiences e ORDER BY e.surcharge_cents, e.name`).all(new Date().toISOString()));
  });

  router.post('/', auth, requireAdmin, (req, res) => {
    const x = validate(req.body, EXPERIENCE_RULES);
    if (db.prepare('SELECT 1 FROM experiences WHERE name = ?').get(x.name)) throw conflict('Experience already exists');
    const { lastInsertRowid } = db.prepare('INSERT INTO experiences (name, description, surcharge_cents, min_age) VALUES (?, ?, ?, ?)')
      .run(x.name, x.description ?? '', x.surcharge_cents ?? 0, x.min_age ?? 0);
    res.status(201).json(one(lastInsertRowid));
  });

  // Changing the surcharge only affects showtimes scheduled afterwards; existing showtime prices are fixed.
  router.patch('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!one(id)) throw notFound('Experience');
    const changes = validate(req.body, EXPERIENCE_RULES, { partial: true });
    const fields = Object.keys(changes);
    if (!fields.length) throw badRequest('No updatable fields provided');
    if (changes.name && db.prepare('SELECT 1 FROM experiences WHERE name = ? AND id != ?').get(changes.name, id)) {
      throw conflict('Experience already exists');
    }
    db.prepare(`UPDATE experiences SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
      .run(...fields.map((f) => changes[f]), id);
    res.json(one(id));
  });

  router.delete('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!one(id)) throw notFound('Experience');
    if (db.prepare('SELECT 1 FROM showtimes WHERE experience_id = ?').get(id)) {
      throw conflict('Experience is used by showtimes and cannot be deleted');
    }
    db.prepare('DELETE FROM experiences WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}
