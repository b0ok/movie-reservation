import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS movies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  poster_url   TEXT,
  genre        TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A hall is a physical auditorium; its seats are generated from row_count x seats_per_row.
CREATE TABLE IF NOT EXISTS halls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  row_count     INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 26),
  seats_per_row INTEGER NOT NULL CHECK (seats_per_row BETWEEN 1 AND 50)
);

CREATE TABLE IF NOT EXISTS seats (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  hall_id INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,            -- e.g. "C7"
  UNIQUE (hall_id, label)
);

CREATE TABLE IF NOT EXISTS showtimes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id    INTEGER NOT NULL REFERENCES movies(id) ON DELETE RESTRICT,
  hall_id     INTEGER NOT NULL REFERENCES halls(id) ON DELETE RESTRICT,
  starts_at   TEXT NOT NULL,        -- ISO-8601 UTC
  ends_at     TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_showtimes_hall_time ON showtimes (hall_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_showtimes_movie ON showtimes (movie_id);

CREATE TABLE IF NOT EXISTS reservations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  showtime_id  INTEGER NOT NULL REFERENCES showtimes(id) ON DELETE RESTRICT,
  status       TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  total_cents  INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_user ON reservations (user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_showtime ON reservations (showtime_id);

CREATE TABLE IF NOT EXISTS reservation_seats (
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  showtime_id    INTEGER NOT NULL REFERENCES showtimes(id),
  seat_id        INTEGER NOT NULL REFERENCES seats(id),
  active         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (reservation_id, seat_id)
);
-- The core overbooking guarantee: a seat can be held by at most one active reservation per showtime.
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_seat
  ON reservation_seats (showtime_id, seat_id) WHERE active = 1;
`;

// Ordered schema changes; PRAGMA user_version records how many have been applied.
// Never edit a shipped migration; append a new one.
export const MIGRATIONS = [
  SCHEMA,
  // 2: many-to-many genres, and viewing experiences (IMAX, 3D, ...) per showtime.
  `
  CREATE TABLE genres (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE movie_genres (
    movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (movie_id, genre_id)
  );
  CREATE INDEX idx_movie_genres_genre ON movie_genres (genre_id);
  INSERT OR IGNORE INTO genres (name) SELECT DISTINCT genre FROM movies;
  INSERT INTO movie_genres (movie_id, genre_id) SELECT m.id, g.id FROM movies m JOIN genres g ON g.name = m.genre;
  ALTER TABLE movies DROP COLUMN genre;

  CREATE TABLE experiences (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description     TEXT NOT NULL DEFAULT '',
    surcharge_cents INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_cents >= 0)
  );
  INSERT INTO experiences (name, description, surcharge_cents) VALUES
    ('Standard',    'Digital projection with surround sound.', 0),
    ('IMAX',        'Floor-to-ceiling screen with laser projection and precision sound.', 600),
    ('3D',          'Stereoscopic 3D. Glasses included.', 400),
    ('4DX',         'Motion seats, wind, mist and scent effects synced to the film.', 900),
    ('Live',        'A live event on stage or broadcast live to the big screen.', 1000),
    ('Puppet Show', 'The film plus a live puppet troupe performing alongside it. Yes, really.', 300);
  ALTER TABLE showtimes ADD COLUMN experience_id INTEGER REFERENCES experiences(id);
  UPDATE showtimes SET experience_id = (SELECT id FROM experiences WHERE name = 'Standard');
  CREATE INDEX idx_showtimes_experience ON showtimes (experience_id);
  `,
  // 3: the theatre's formats become Standard, 4DX and VIP (19+); each seat records its ticket type and price.
  `
  INSERT OR IGNORE INTO experiences (name, description, surcharge_cents) VALUES
    ('VIP', 'Heated leather recliners, in-seat food and drink service, licensed for 19+.', 800);
  UPDATE showtimes SET experience_id = (SELECT id FROM experiences WHERE name = 'VIP')
    WHERE experience_id IN (SELECT id FROM experiences WHERE name = 'IMAX');
  UPDATE showtimes SET experience_id = (SELECT id FROM experiences WHERE name = 'Standard')
    WHERE experience_id IN (SELECT id FROM experiences WHERE name IN ('3D', 'Live', 'Puppet Show'));
  DELETE FROM experiences WHERE name IN ('IMAX', '3D', 'Live', 'Puppet Show');
  ALTER TABLE experiences ADD COLUMN min_age INTEGER NOT NULL DEFAULT 0;
  UPDATE experiences SET min_age = 19 WHERE name = 'VIP';

  ALTER TABLE reservation_seats ADD COLUMN ticket_type TEXT NOT NULL DEFAULT 'adult';
  ALTER TABLE reservation_seats ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0;
  UPDATE reservation_seats SET price_cents = (SELECT price_cents FROM showtimes WHERE id = reservation_seats.showtime_id);
  `,
];

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function openDb(path = process.env.DB_PATH || 'data.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

// Runs fn inside a write transaction; rolls back on any throw.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
