import { Router } from 'express';
import { createHmac } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { validate, parseId } from '../validate.js';
import { notFound, conflict, badRequest, HttpError } from '../errors.js';
import { transaction } from '../db.js';
import { TICKET_TYPES, ticketPrices, SNACK_COMBOS, MAX_COMBO_QTY } from '../theatre.js';

export const MAX_SEATS_PER_RESERVATION = 10;

const RESERVATION_SELECT = `
  SELECT r.id, r.user_id, r.status, r.total_cents, r.created_at, r.cancelled_at,
         s.id AS showtime_id, s.starts_at, s.ends_at, s.price_cents,
         m.id AS movie_id, m.title AS movie_title, m.poster_url, h.name AS hall_name, e.name AS experience,
         (SELECT group_concat(se.label, ',') FROM reservation_seats rs
            JOIN seats se ON se.id = rs.seat_id WHERE rs.reservation_id = r.id) AS seat_labels,
         (SELECT json_group_array(json_object('type', ticket_type, 'count', n, 'price_cents', p)) FROM (
            SELECT ticket_type, COUNT(*) AS n, price_cents AS p FROM reservation_seats
            WHERE reservation_id = r.id GROUP BY ticket_type, price_cents)) AS tickets_json,
         (SELECT json_group_array(json_object('combo', combo, 'qty', qty, 'price_cents', price_cents))
            FROM reservation_snacks WHERE reservation_id = r.id) AS snacks_json
  FROM reservations r
  JOIN showtimes s ON s.id = r.showtime_id
  JOIN movies m ON m.id = s.movie_id
  JOIN halls h ON h.id = s.hall_id
  JOIN experiences e ON e.id = s.experience_id`;

// The code printed on a ticket and in its QR: booking id plus a short HMAC, so a scanner can tell a real
// ticket from a guessed one without a lookup table. Keyed by JWT_SECRET; changing the secret changes every code.
export function ticketCode(id) {
  const sig = createHmac('sha256', process.env.JWT_SECRET || '').update(`ticket:${id}`).digest('hex').slice(0, 8).toUpperCase();
  return `NAT-${id}-${sig}`;
}

export function ticketQrSvg(code) {
  const qr = qrcode(0, 'M');
  qr.addData(code);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function formatReservation(row) {
  if (!row) return row;
  const { seat_labels, tickets_json, snacks_json, ...rest } = row;
  const out = { ...rest, seats: seat_labels ? seat_labels.split(',') : [] };
  if (tickets_json) {
    out.tickets = JSON.parse(tickets_json).map((t) => ({ ...t, label: TICKET_TYPES[t.type]?.label ?? t.type }));
  }
  out.snacks = snacks_json ? JSON.parse(snacks_json).map((s) => ({ ...s, label: SNACK_COMBOS[s.combo]?.label ?? s.combo })) : [];
  out.ticket_code = ticketCode(out.id);
  return out;
}

// Books seats (by label) for a user inside one write transaction. Used by the API and the demand simulator.
// tickets is { adult, child, senior } counts that must add up to the number of seats; omitted means all adult.
// snacks is { comboId: qty }; prices come from SNACK_COMBOS and are added to the total.
export function createReservation(db, userId, showtimeId, labels, tickets = { adult: labels.length }, snacks = {}) {
  for (const [combo, qty] of Object.entries(snacks)) {
    if (!Object.hasOwn(SNACK_COMBOS, combo)) throw badRequest(`Unknown snack combo: ${combo}`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_COMBO_QTY) throw badRequest(`Snack quantity must be 1 to ${MAX_COMBO_QTY}`);
  }
  const snackCents = Object.entries(snacks).reduce((sum, [combo, qty]) => sum + SNACK_COMBOS[combo].price_cents * qty, 0);
  return transaction(db, () => {
    const st = db.prepare(`SELECT s.id, s.hall_id, s.starts_at, s.price_cents, e.min_age
      FROM showtimes s JOIN experiences e ON e.id = s.experience_id WHERE s.id = ?`).get(showtimeId);
    if (!st) throw notFound('Showtime');
    if (st.starts_at <= new Date().toISOString()) throw badRequest('Showtime has already started');

    const placeholders = labels.map(() => '?').join(',');
    const seats = db.prepare(`SELECT id, label FROM seats WHERE hall_id = ? AND label IN (${placeholders})`)
      .all(st.hall_id, ...labels);
    if (seats.length !== labels.length) {
      const found = new Set(seats.map((s) => s.label));
      throw badRequest('Unknown seats for this hall', labels.filter((l) => !found.has(l)));
    }

    const taken = db.prepare(`
      SELECT se.label FROM reservation_seats rs JOIN seats se ON se.id = rs.seat_id
      WHERE rs.showtime_id = ? AND rs.active = 1 AND rs.seat_id IN (${placeholders})`)
      .all(st.id, ...seats.map((s) => s.id));
    if (taken.length) throw conflict('Some seats are already reserved', taken.map((t) => t.label));

    // One price per seat, from the ticket types on sale for this showtime.
    const prices = Object.fromEntries(ticketPrices(st.price_cents, st.min_age).map((t) => [t.type, t.price_cents]));
    const perSeat = [];
    for (const [type, count] of Object.entries(tickets)) {
      if (!Object.hasOwn(prices, type)) {
        throw badRequest(type === 'child' && st.min_age ? `Child tickets aren't sold for ${st.min_age}+ showings` : `Unknown ticket type: ${type}`);
      }
      for (let i = 0; i < count; i++) perSeat.push(type);
    }
    if (perSeat.length !== seats.length) throw badRequest(`Ticket count (${perSeat.length}) must match the number of seats (${seats.length})`);

    const { lastInsertRowid } = db.prepare(
      'INSERT INTO reservations (user_id, showtime_id, total_cents) VALUES (?, ?, ?)',
    ).run(userId, st.id, perSeat.reduce((sum, type) => sum + prices[type], 0) + snackCents);
    const insertSnack = db.prepare('INSERT INTO reservation_snacks (reservation_id, combo, qty, price_cents) VALUES (?, ?, ?, ?)');
    for (const [combo, qty] of Object.entries(snacks)) insertSnack.run(lastInsertRowid, combo, qty, SNACK_COMBOS[combo].price_cents);
    const insertSeat = db.prepare(`INSERT INTO reservation_seats (reservation_id, showtime_id, seat_id, ticket_type, price_cents)
                                   VALUES (?, ?, ?, ?, ?)`);
    try {
      seats.forEach((seat, i) => insertSeat.run(lastInsertRowid, st.id, seat.id, perSeat[i], prices[perSeat[i]]));
    } catch (err) {
      // Backstop for concurrent writers (e.g. multiple server processes): the partial unique index wins.
      if (/UNIQUE constraint failed/.test(err.message)) throw conflict('Some seats were just reserved by someone else');
      throw err;
    }
    return lastInsertRowid;
  });
}

export default function reservationRoutes(db) {
  const router = Router();
  const getReservation = db.prepare(`${RESERVATION_SELECT} WHERE r.id = ?`);

  function loadOwned(req) {
    const r = getReservation.get(parseId(req.params.id));
    // Report someone else's reservation as missing rather than forbidden, so IDs can't be probed.
    if (!r || (r.user_id !== req.user.id && req.user.role !== 'admin')) throw notFound('Reservation');
    return r;
  }

  // Reserve seats for a showtime. Body: { showtime_id, seats: ["A1", "A2"], tickets?: { adult: 1, child: 1 } }
  router.post('/', (req, res) => {
    const input = validate(req.body, {
      showtime_id: { type: 'int', required: true, min: 1 },
      seats: { type: 'stringArray', required: true, min: 1, max: MAX_SEATS_PER_RESERVATION, upper: true },
    });
    const labels = [...new Set(input.seats)];
    if (labels.length !== input.seats.length) throw badRequest('Duplicate seats in request');
    let tickets;
    if (req.body.tickets !== undefined) {
      const t = req.body.tickets;
      if (!t || typeof t !== 'object' || Array.isArray(t)
          || Object.values(t).some((n) => !Number.isInteger(n) || n < 0 || n > MAX_SEATS_PER_RESERVATION)) {
        throw badRequest('tickets must be an object of counts, e.g. { "adult": 2, "child": 1 }');
      }
      tickets = Object.fromEntries(Object.entries(t).filter(([, n]) => n > 0));
    }
    let snacks = {};
    if (req.body.snacks !== undefined) {
      const s = req.body.snacks;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw badRequest('snacks must be an object of counts, e.g. { "wombo": 1 }');
      snacks = Object.fromEntries(Object.entries(s).filter(([, n]) => n !== 0));
    }

    const id = createReservation(db, req.user.id, input.showtime_id, labels, tickets, snacks);
    res.status(201).json(formatReservation(getReservation.get(id)));
  });

  // Current user's reservations. ?scope=upcoming|past|all (default upcoming)
  router.get('/', (req, res) => {
    const scope = req.query.scope || 'upcoming';
    if (!['upcoming', 'past', 'all'].includes(scope)) throw badRequest('scope must be upcoming, past or all');
    const now = new Date().toISOString();
    const timeFilter = { upcoming: 'AND s.starts_at > ?', past: 'AND s.starts_at <= ?', all: '' }[scope];
    const params = scope === 'all' ? [req.user.id] : [req.user.id, now];
    const rows = db.prepare(`${RESERVATION_SELECT} WHERE r.user_id = ? ${timeFilter}
      ORDER BY s.starts_at ${scope === 'past' ? 'DESC' : 'ASC'}`).all(...params);
    res.json(rows.map(formatReservation));
  });

  // Single reservation, with the QR code for its ticket pass.
  router.get('/:id', (req, res) => {
    const r = formatReservation(loadOwned(req));
    res.json({ ...r, qr_svg: ticketQrSvg(r.ticket_code) });
  });

  // Cancel: only upcoming, confirmed reservations. Frees the seats immediately.
  router.delete('/:id', (req, res) => {
    const r = loadOwned(req);
    if (r.status === 'cancelled') throw conflict('Reservation is already cancelled');
    if (r.starts_at <= new Date().toISOString()) throw new HttpError(422, 'Cannot cancel a reservation for a past showtime');
    transaction(db, () => {
      db.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
        .run(new Date().toISOString(), r.id);
      db.prepare('UPDATE reservation_seats SET active = 0 WHERE reservation_id = ?').run(r.id);
    });
    res.json(formatReservation(getReservation.get(r.id)));
  });

  return router;
}
