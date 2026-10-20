# The Nguyen Awards Theatre

Movie reservation service: user auth with admin/user roles, films with genres and posters, showtimes in three experiences (Standard, 4DX and VIP 19+) within theatre hours of 12:00 PM to midnight, ticket types (General Admission, Child, Senior), seat reservations without overbooking, and admin reporting. The website in `public/` is served by the same server at http://localhost:3000.

**Stack:** Node.js 22 · Express 5 · SQLite (built-in `node:sqlite`) · JWT · bcrypt

## Quick start

```bash
npm install
cp .env.example .env      # set JWT_SECRET and the admin credentials
npm run seed              # optional: sample movies, 2 halls, 7 days of showtimes
npm start                 # http://localhost:3000
npm test
```

On startup, if no admin exists, one is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Public signup always creates a regular `user`. Admins can promote other users.

## Data model

```
users ─< reservations >─ showtimes >─ movies ─< movie_genres >─ genres
              │              │  └──> experiences
              └─< reservation_seats >─ seats >─ halls
```

- **genres** are shared tags; a movie has 1 to 5 of them. A genre can't be deleted if it's the only genre of some movie.
- **experiences** are presentation formats with a per-ticket surcharge. Every showtime has one (Standard by default). The showtime's `price_cents` is the full ticket price, so changing a surcharge never reprices tickets already on sale.
- Schema changes are numbered migrations in `src/db.js`, tracked with `PRAGMA user_version`, so existing databases upgrade automatically on startup.

- **halls** generate their seat map on creation (`row_count` × `seats_per_row`, labels `A1`, `A2`, …).
- **showtimes** link a movie to a hall. `ends_at` is computed from the movie's duration, and overlapping showtimes in the same hall are rejected.
- **reservation_seats** has a partial unique index on `(showtime_id, seat_id) WHERE active = 1`. That index is what guarantees a seat can't be double-booked, even with concurrent requests or multiple processes. Cancelling sets `active = 0`, which frees the seats and keeps the history.

## Booking flow

Modelled on Cineplex: a movie page with a **Get Tickets** section (date strip, then times grouped by experience with their amenities), then a four-step flow at `#/book/:showtimeId`: **Tickets** (ticket types with +/- counters, up to 10) → **Seats** (pick exactly that many) → **Review** → **Confirmed**. On phones the order total and the next-step button sit in a bar pinned to the bottom of the screen.

- Ticket prices: the showtime price is General Admission; Child (3–13) is $4 less and Senior (65+) is $3 less. Each booked seat stores its ticket type and price.
- VIP has `min_age = 19`, so child tickets aren't sold for it.
- Theatre hours are set by `THEATRE_HOURS` (default `12-24`) in `THEATRE_TZ` (default: the server's time zone). Showtimes that start before opening or end after closing are refused.

## Demand simulator (demo)

With `SIMULATE_DEMAND=true` (the default), the server books seats under a **Simulated guests** account so the theatre looks busy. It fills each show to about 80% of a target on startup, then adds a party every ~12 seconds. The target is higher for evening, weekend and premium-format shows, and rises as a show gets closer. Center seats a little past the middle row go first. These are real reservations, so they block seats and count toward revenue reports; the admin Reservations tab labels them **Simulated**. Nobody can log in to that account. Set `SIMULATE_DEMAND=false` before using this with real customers or real sales numbers.

The seat page checks the seat map every 6 seconds, flashes seats that were just taken, releases any of your picks that someone else got first, and suggests other times for the same film that have more best-view seats left.

## API

All bodies are JSON. Authenticated routes need `Authorization: Bearer <token>`. Money is in cents and times are ISO-8601 UTC.

### Auth
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/signup` | – | `{ name, email, password }` → `{ token, user }` |
| POST | `/api/auth/login` | – | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | user | current user |

### Movies
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/movies` | – | `?genre=` `?q=` (title search) `?date=YYYY-MM-DD` `?experience=IMAX` `?limit` `?offset` |
| GET | `/api/movies/:id` | – | movie plus upcoming showtimes |
| POST | `/api/movies` | admin | `{ title, description, genres: ["Action", ...], duration_min, poster_url? }`. Unknown genre names are created |
| PATCH | `/api/movies/:id` | admin | any subset of fields (duration is locked once showtimes exist) |
| DELETE | `/api/movies/:id` | admin | blocked if showtimes exist |
| PUT | `/api/movies/:id/poster` | admin | raw image bytes as the body (JPEG/PNG/WebP/GIF, ≤ 5 MB), saved under `uploads/posters/` |
| DELETE | `/api/movies/:id/poster` | admin | removes the poster |

### Genres & experiences
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/genres` | – | with `movie_count` |
| POST / PATCH / DELETE | `/api/genres[/:id]` | admin | `{ name }` |
| GET | `/api/experiences` | – | with `surcharge_cents` and `upcoming_showtimes` |
| POST / PATCH / DELETE | `/api/experiences[/:id]` | admin | `{ name, description?, surcharge_cents? }`. Delete is blocked while showtimes use it |

### Halls
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/halls` | – | includes `capacity` |
| GET | `/api/halls/:id` | – | |
| POST | `/api/halls` | admin | `{ name, row_count (1-26), seats_per_row (1-50) }` |
| DELETE | `/api/halls/:id` | admin | blocked if showtimes exist |

### Showtimes
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/showtimes` | – | upcoming only; `?date=YYYY-MM-DD` (UTC day) or `?from=&to=` (ISO datetimes, e.g. a local day) `?movieId=` `?experience=`; includes `available` seat count |
| GET | `/api/showtimes/:id` | – | |
| GET | `/api/showtimes/:id/seats` | – | seat map with `available` / `reserved` per seat |
| POST | `/api/showtimes` | admin | `{ movie_id, hall_id, starts_at, price_cents, experience_id? }` |
| PATCH | `/api/showtimes/:id` | admin | `{ starts_at?, price_cents?, experience_id? }` |
| DELETE | `/api/showtimes/:id` | admin | blocked if any reservations exist |

### Reservations (user)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/reservations` | `{ showtime_id, seats: ["A1","A2"] }`, max 10 seats, upcoming showtimes only. `409` lists seats that are already taken |
| GET | `/api/reservations` | your reservations; `?scope=upcoming` (default) \| `past` \| `all` |
| GET | `/api/reservations/:id` | |
| DELETE | `/api/reservations/:id` | cancel (upcoming only); seats are released immediately |

### Admin & reporting (admin only)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/reservations` | all reservations with `total`, `seats`, `revenue_cents` for the filter; `?q` (customer or film) `?movieId` `?status` `?upcoming=true` `?showtimeId` `?userId` `?from` `?to`. Admins can cancel any upcoming one with `DELETE /api/reservations/:id` |
| GET | `/api/admin/reports/summary` | confirmed/cancelled counts, revenue, capacity, seats sold, occupancy % |
| GET | `/api/admin/reports/showtimes` | per showtime: capacity, seats sold, occupancy %, revenue |
| GET | `/api/admin/reports/movies` | per movie: showtimes, seats sold, revenue |
| GET | `/api/admin/reports/experiences` | per experience: showtimes, seats sold, revenue |
| GET | `/api/admin/users` | |
| PATCH | `/api/admin/users/:id/role` | `{ role: "admin" \| "user" }` |

Report endpoints accept `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, by showtime date).

Errors use the format `{ "error": "message", "details": [...] }` with the matching HTTP status (400, 401, 403, 404, 409, 422).

## Example

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"name":"Ann","email":"ann@example.com","password":"password123"}' | jq -r .token)

curl -s "localhost:3000/api/showtimes?date=2026-10-21"
curl -s localhost:3000/api/showtimes/1/seats
curl -s -X POST localhost:3000/api/reservations -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"showtime_id":1,"seats":["C5","C6"]}'
```
