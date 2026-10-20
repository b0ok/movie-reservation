// Seeds an admin, four halls, ten films and two weeks of noon-to-midnight showtimes. Skips if movies exist.
import { openDb, transaction } from '../src/db.js';
import { ensureAdmin } from '../src/app.js';

try { process.loadEnvFile(); } catch { /* .env is optional */ }

const db = openDb();
ensureAdmin(db);

if (db.prepare('SELECT 1 FROM movies').get()) {
  console.log('Database already has movies; skipping seed.');
  process.exit(0);
}

const movies = [
  ['Dune: Part Two', 'Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family.', ['Sci-Fi', 'Adventure'], 166],
  ['Oppenheimer', 'The story of J. Robert Oppenheimer and the race to build the atomic bomb during the Second World War.', ['Drama', 'History'], 180],
  ['Spider-Man: Across the Spider-Verse', 'Miles Morales catapults across the Multiverse, where he encounters a team of Spider-People charged with protecting its very existence.', ['Animation', 'Action'], 140],
  ['Top Gun: Maverick', 'After thirty years of service, Pete "Maverick" Mitchell trains a detachment of graduates for a specialized mission.', ['Action', 'Drama'], 131],
  ['Everything Everywhere All at Once', 'A laundromat owner is swept into an adventure in which she alone can save existence by exploring other universes.', ['Sci-Fi', 'Comedy'], 139],
  ['Past Lives', 'Two deeply connected childhood friends are reunited in New York for one fateful week as they confront notions of destiny and love.', ['Drama', 'Romance'], 106],
  ['Inside Out 2', 'Riley enters her teenage years, and Headquarters makes room for some unexpected new Emotions.', ['Animation', 'Family', 'Comedy'], 96],
  ['The Batman', 'In his second year of fighting crime, Batman uncovers corruption in Gotham City that connects to his own family.', ['Action', 'Crime'], 176],
  ['Barbie', 'Barbie and Ken leave Barbieland for the real world and discover the joys and perils of living among humans.', ['Comedy', 'Family'], 114],
  ['Interstellar', 'A team of explorers travels through a wormhole in space in an attempt to ensure humanity\'s survival.', ['Sci-Fi', 'Adventure', 'Drama'], 169],
];

// [name, rows, seats per row, experience]. Formats need the right auditorium, so each hall runs one experience.
const halls = [
  ['The Grand Hall', 10, 16, 'Standard'],
  ['Studio Gold', 8, 14, 'Standard'],
  ['4DX Studio', 8, 12, '4DX'],
  ['VIP Lounge', 6, 10, 'VIP'],
];

const OPEN_HOUR = 12;
const CLOSE_HOUR = 24;
const TURNOVER_MIN = 20; // cleaning time between shows
const DAYS = 14;

transaction(db, () => {
  const experience = Object.fromEntries(db.prepare('SELECT name, id, surcharge_cents FROM experiences').all().map((e) => [e.name, e]));

  const movieIds = movies.map(([title, description, genres, duration]) => {
    const id = db.prepare('INSERT INTO movies (title, description, duration_min) VALUES (?, ?, ?)')
      .run(title, description, duration).lastInsertRowid;
    for (const name of genres) {
      db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run(name);
      db.prepare('INSERT INTO movie_genres (movie_id, genre_id) SELECT ?, id FROM genres WHERE name = ?').run(id, name);
    }
    return id;
  });

  const hallIds = halls.map(([name, rows, perRow]) => {
    const id = db.prepare('INSERT INTO halls (name, row_count, seats_per_row) VALUES (?, ?, ?)').run(name, rows, perRow).lastInsertRowid;
    const insertSeat = db.prepare('INSERT INTO seats (hall_id, label) VALUES (?, ?)');
    for (let r = 0; r < rows; r++) for (let n = 1; n <= perRow; n++) insertSeat.run(id, `${String.fromCharCode(65 + r)}${n}`);
    return id;
  });

  // Pack each hall from noon to midnight: start on a quarter hour, play the next film in rotation that still
  // finishes by midnight, leave time for cleaning, repeat. Halls start staggered so start times spread out.
  const insertShow = db.prepare(`INSERT INTO showtimes (movie_id, hall_id, experience_id, starts_at, ends_at, price_cents)
                                 VALUES (?, ?, ?, ?, ?, ?)`);
  const roundUpToQuarter = (d) => new Date(Math.ceil(d.getTime() / 900_000) * 900_000);
  let rotation = 0;
  for (let day = 0; day < DAYS; day++) {
    halls.forEach(([, , , xpName], h) => {
      const exp = experience[xpName];
      const open = new Date();
      open.setHours(0, 0, 0, 0);
      open.setDate(open.getDate() + day);
      const close = new Date(open);
      close.setHours(CLOSE_HOUR, 0, 0, 0);
      let start = new Date(open);
      start.setHours(OPEN_HOUR, h * 15, 0, 0);
      while (start < close) {
        let pick = -1;
        for (let k = 0; k < movies.length; k++) {
          const idx = (rotation + k) % movies.length;
          if (start.getTime() + movies[idx][3] * 60_000 <= close.getTime()) { pick = idx; break; }
        }
        if (pick < 0) break;
        rotation = pick + 1;
        const end = new Date(start.getTime() + movies[pick][3] * 60_000);
        // Matinees (before 5 PM) are cheaper; the experience surcharge is added on top.
        const base = start.getHours() < 17 ? 1350 : 1695;
        if (start > new Date()) {
          insertShow.run(movieIds[pick], hallIds[h], exp.id, start.toISOString(), end.toISOString(), base + exp.surcharge_cents);
        }
        start = roundUpToQuarter(new Date(end.getTime() + TURNOVER_MIN * 60_000));
      }
    });
  }
});

console.log(`Seeded ${movies.length} movies, ${halls.length} halls and ${db.prepare('SELECT COUNT(*) AS n FROM showtimes').get().n} showtimes.`);
