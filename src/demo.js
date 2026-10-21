// Nightly reset of the shared portfolio demo account: every visitor signs in as the same demo customer, so its
// bookings are wiped once a day (default 4 AM theatre time) to keep the demo clean and free the seats.
// The last reset date lives in app_meta, so restarts never reset twice and a server that slept through the
// reset hour catches up on its first check after waking.
import { transaction } from './db.js';
import { theatreHours } from './theatre.js';

const META_KEY = 'demo_last_reset';

// Local calendar date (YYYY-MM-DD) and hour of an instant in the given time zone.
function localDateHour(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// Due once per local day, at or after the reset hour.
export function isResetDue(lastResetDay, now, resetHour, timeZone) {
  const { day, hour } = localDateHour(now, timeZone);
  return hour >= resetHour && lastResetDay !== day ? day : null;
}

// Deletes all of the demo user's reservations (seats and snack orders cascade). Returns how many were removed.
export function resetDemoBookings(db, email) {
  const user = db.prepare("SELECT id FROM users WHERE email = ? AND role = 'user'").get(email);
  if (!user) return 0;
  return transaction(db, () => db.prepare('DELETE FROM reservations WHERE user_id = ?').run(user.id).changes);
}

export function runDemoResetIfDue(db, { email, resetHour, timeZone, now = new Date() }) {
  const last = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_KEY)?.value ?? null;
  const day = isResetDue(last, now, resetHour, timeZone);
  if (!day) return null;
  const removed = resetDemoBookings(db, email);
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(META_KEY, day);
  return removed;
}

export function startDemoReset(db, { email = process.env.DEMO_EMAIL, resetHour = Number(process.env.DEMO_RESET_HOUR ?? 4), intervalMs = 10 * 60_000 } = {}) {
  if (!email) return () => {};
  const check = () => {
    try {
      const removed = runDemoResetIfDue(db, { email, resetHour, timeZone: theatreHours().timezone });
      if (removed !== null) console.log(`Demo reset: removed ${removed} demo booking${removed === 1 ? '' : 's'}`);
    } catch (err) { console.error('Demo reset:', err.message); }
  };
  check();
  const timer = setInterval(check, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
