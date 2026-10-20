// Demand simulator: books seats under a "simulated guests" account so the theatre feels busy.
// Bookings follow real-world patterns (evenings, weekends and premium formats sell more; center seats go
// first; shows fill up as they get closer) and keep trickling in while the server runs.
// These are real reservations, so they block seats and count in reports. Disable with SIMULATE_DEMAND=false.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createReservation } from './routes/reservations.js';

export const SIMULATED_EMAIL = 'simulated-guests@nguyenawards.local';

const EXPERIENCE_BOOST = { VIP: 0.12, '4DX': 0.1 };
// Party sizes, weighted: couples are the most common booking.
const PARTY_SIZES = [1, 2, 2, 2, 2, 3, 3, 4, 4, 5];

// Creates the account simulated bookings belong to. Its password is random and never stored, so nobody can log in.
export function ensureSimulatedUser(db) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(SIMULATED_EMAIL);
  if (existing) return existing.id;
  const hash = bcrypt.hashSync(randomBytes(24).toString('hex'), 10);
  return db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Simulated guests', ?, ?)")
    .run(SIMULATED_EMAIL, hash).lastInsertRowid;
}

// Fraction of seats that should be sold by now, from time of day, weekday, format and how soon the show is.
export function targetOccupancy(show, now = new Date()) {
  const start = new Date(show.starts_at);
  const hour = start.getHours();
  const day = start.getDay();
  let t = 0.22;
  if (hour >= 17) t += 0.15;
  if (hour >= 20) t += 0.05;
  if (day === 5 || day === 6) t += 0.15;
  else if (day === 0) t += 0.08;
  t += EXPERIENCE_BOOST[show.experience] ?? 0;
  // Fixed per-showtime variation, so neighbouring times differ and some are clearly better bets.
  t += (((show.id * 2654435761) >>> 0) % 1000) / 1000 * 0.3 - 0.15;
  const hoursAway = (start - now) / 3_600_000;
  const closeness = hoursAway < 3 ? 1 : hoursAway < 24 ? 0.85 : hoursAway < 72 ? 0.6 : 0.4;
  return Math.min(Math.max(t * closeness, 0.05), 0.9);
}

// How desirable a seat is: center columns and rows a little past the middle score highest.
export function seatScore(label, rowCount, perRow) {
  const r = label.charCodeAt(0) - 65;
  const c = Number(label.slice(1)) - 1;
  const center = 1 - Math.abs(c - (perRow - 1) / 2) / (perRow / 2);
  const rowPos = rowCount > 1 ? r / (rowCount - 1) : 0.5;
  const row = 1 - Math.abs(rowPos - 0.6) / 0.6;
  return 0.55 * center + 0.45 * row;
}

// A believable ticket mix: mostly adults, the odd senior, and kids in bigger groups (never at 19+ shows).
function partyTickets(size, minAge, random) {
  const t = { adult: size };
  if (size >= 3 && !minAge && random() < 0.6) {
    const kids = Math.min(size - 1, 1 + Math.floor(random() * 2));
    t.adult -= kids;
    t.child = kids;
  }
  if (t.adult >= 1 && random() < 0.15) { t.adult -= 1; t.senior = 1; }
  return t;
}

// Picks a block of up to `size` adjacent free seats, starting from a well-scored free seat.
function pickGroup(free, rowCount, perRow, size, random) {
  if (!free.size) return [];
  const ranked = [...free].map((l) => [l, seatScore(l, rowCount, perRow) + random() * 0.35]).sort((a, b) => b[1] - a[1]);
  const anchor = ranked[0][0];
  const row = anchor[0];
  const col = Number(anchor.slice(1));
  const group = [anchor];
  for (let step = 1; group.length < size && step < perRow; step++) {
    for (const c of [col + step, col - step]) {
      if (group.length < size && c >= 1 && c <= perRow && free.has(`${row}${c}`)) group.push(`${row}${c}`);
    }
    // Stop once both directions are blocked, so the group stays contiguous.
    if (!free.has(`${row}${col + step}`) && !free.has(`${row}${col - step}`)) break;
  }
  return group;
}

// One pass over upcoming showtimes. In warmup mode each show is filled straight to most of its target;
// otherwise each show below target has a chance to gain one party.
export function simulateTick(db, userId, { warmup = false, now = new Date(), random = Math.random, chance = 0.35 } = {}) {
  const shows = db.prepare(`
    SELECT s.id, s.starts_at, h.row_count, h.seats_per_row, e.name AS experience, e.min_age
    FROM showtimes s JOIN halls h ON h.id = s.hall_id JOIN experiences e ON e.id = s.experience_id
    WHERE s.starts_at > ?`).all(now.toISOString());
  const seatsFor = db.prepare(`
    SELECT se.label, rs.seat_id IS NOT NULL AS taken
    FROM showtimes s JOIN seats se ON se.hall_id = s.hall_id
    LEFT JOIN reservation_seats rs ON rs.seat_id = se.id AND rs.showtime_id = s.id AND rs.active = 1
    WHERE s.id = ?`);
  let booked = 0;

  for (const show of shows) {
    const seats = seatsFor.all(show.id);
    const free = new Set(seats.filter((s) => !s.taken).map((s) => s.label));
    const target = Math.round(targetOccupancy(show, now) * seats.length);
    let sold = seats.length - free.size;
    const goal = warmup ? Math.round(target * 0.8) : target;
    if (sold >= goal) continue;
    if (!warmup && random() > chance) continue;

    do {
      const size = PARTY_SIZES[Math.floor(random() * PARTY_SIZES.length)];
      const group = pickGroup(free, show.row_count, show.seats_per_row, Math.min(size, goal - sold), random);
      if (!group.length) break;
      try {
        createReservation(db, userId, show.id, group, partyTickets(group.length, show.min_age, random));
      } catch {
        break; // a real customer got there first; try again next tick
      }
      for (const l of group) free.delete(l);
      sold += group.length;
      booked += group.length;
    } while (warmup && sold < goal);
  }
  return booked;
}

export function startDemandSimulator(db, { intervalMs = 12_000 } = {}) {
  const userId = ensureSimulatedUser(db);
  const warm = simulateTick(db, userId, { warmup: true });
  console.log(`Demand simulator on: ${warm} seats pre-booked, more every ~${Math.round(intervalMs / 1000)}s`);
  const timer = setInterval(() => {
    try { simulateTick(db, userId); } catch (err) { console.error('Demand simulator:', err.message); }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
