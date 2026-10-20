import { Router } from 'express';
import { validate, parseId } from '../validate.js';
import { notFound, conflict } from '../errors.js';
import { requireAdmin } from '../auth.js';
import { transaction } from '../db.js';

export default function hallRoutes(db, { auth }) {
  const router = Router();
  const getHall = db.prepare(`
    SELECT h.*, (SELECT COUNT(*) FROM seats WHERE hall_id = h.id) AS capacity
    FROM halls h WHERE h.id = ?`);

  router.get('/', (_req, res) => {
    res.json(db.prepare(`
      SELECT h.*, (SELECT COUNT(*) FROM seats WHERE hall_id = h.id) AS capacity
      FROM halls h ORDER BY h.name`).all());
  });

  router.get('/:id', (req, res) => {
    const hall = getHall.get(parseId(req.params.id));
    if (!hall) throw notFound('Hall');
    res.json(hall);
  });

  // Creates the hall and generates its seat map (rows A, B, C... x numbered seats).
  router.post('/', auth, requireAdmin, (req, res) => {
    const h = validate(req.body, {
      name: { type: 'string', required: true, min: 1, max: 100 },
      row_count: { type: 'int', required: true, min: 1, max: 26 },
      seats_per_row: { type: 'int', required: true, min: 1, max: 50 },
    });
    if (db.prepare('SELECT 1 FROM halls WHERE name = ?').get(h.name)) throw conflict('Hall name already exists');
    const id = transaction(db, () => {
      const { lastInsertRowid } = db.prepare('INSERT INTO halls (name, row_count, seats_per_row) VALUES (?, ?, ?)')
        .run(h.name, h.row_count, h.seats_per_row);
      const insertSeat = db.prepare('INSERT INTO seats (hall_id, label) VALUES (?, ?)');
      for (let r = 0; r < h.row_count; r++) {
        const row = String.fromCharCode(65 + r);
        for (let n = 1; n <= h.seats_per_row; n++) insertSeat.run(lastInsertRowid, `${row}${n}`);
      }
      return lastInsertRowid;
    });
    res.status(201).json(getHall.get(id));
  });

  router.delete('/:id', auth, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!getHall.get(id)) throw notFound('Hall');
    if (db.prepare('SELECT 1 FROM showtimes WHERE hall_id = ?').get(id)) {
      throw conflict('Hall has showtimes; delete them first');
    }
    db.prepare('DELETE FROM halls WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}
