// Theatre-wide rules: opening hours and ticket types.
import { badRequest } from './errors.js';

export const THEATRE_NAME = 'The Nguyen Awards Theatre';

// Ticket types and their discount off the showtime's (adult) price.
export const TICKET_TYPES = {
  adult: { label: 'General Admission', discount_cents: 0 },
  child: { label: 'Child (3–13)', discount_cents: 400 },
  senior: { label: 'Senior (65+)', discount_cents: 300 },
};

// Ticket types on sale for a showtime; age-restricted experiences (VIP is 19+) don't sell child tickets.
export function ticketPrices(priceCents, minAge = 0) {
  return Object.entries(TICKET_TYPES)
    .filter(([type]) => !(type === 'child' && minAge > 13))
    .map(([type, t]) => ({ type, label: t.label, price_cents: Math.max(priceCents - t.discount_cents, 0) }));
}

// Opening hours as "open-close" in whole hours, e.g. "12-24" = noon to midnight. Read on each call so tests can change it.
export function theatreHours() {
  const [open, close] = (process.env.THEATRE_HOURS || '12-24').split('-').map(Number);
  return { open, close, timezone: process.env.THEATRE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone };
}

// Local calendar date and minutes past midnight for an instant, in the theatre's time zone.
function localClock(iso, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const label = (h) => (h % 24 === 0 ? '12:00 AM' : h === 12 ? '12:00 PM' : h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`);

// A show must start at or after opening and finish by closing. Hours count from the start day's midnight,
// so closing at 24 means midnight and 26 would mean 2:00 AM the next morning.
export function assertWithinHours(startsAt, endsAt) {
  const { open, close, timezone } = theatreHours();
  const start = localClock(startsAt, timezone);
  const end = localClock(endsAt, timezone);
  const nextDay = localClock(new Date(Date.parse(startsAt) + 86_400_000).toISOString(), timezone).date;
  const endMinutes = end.date === start.date ? end.minutes : (end.date === nextDay ? 1440 + end.minutes : Infinity);
  if (start.minutes < open * 60 || endMinutes > close * 60) {
    throw badRequest(`Showtimes must start at or after ${label(open)} and end by ${label(close)} (theatre hours)`);
  }
}
