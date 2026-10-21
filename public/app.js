// The Nguyen Awards Theatre: single-page frontend for the reservation API (hash routing, no build step).

const view = document.getElementById('view');
let liveTimer = null; // seat-map polling on the booking page
const modalRoot = document.getElementById('modal-root');
const TOKEN_KEY = 'nat.token';

const state = {
  user: null,
  token: readToken(),
  ticketScope: 'upcoming',
  adminTab: 'overview',
  showSort: { key: 'when', dir: 1 }, // admin showtimes table; dir 1 = ascending
  browseGenre: 'All', // home page genre filter
};

// ---------- helpers ----------

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (cents) => (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtLong = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
const localDay = (iso) => new Date(iso).toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const runtime = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
const isToday = (iso) => localDay(iso) === localDay(new Date().toISOString());

function dayLabel(iso) {
  const d = localDay(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (d === localDay(today.toISOString())) return 'Today';
  if (d === localDay(tomorrow.toISOString())) return 'Tomorrow';
  return new Date(iso).toLocaleDateString([], { weekday: 'short' });
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(state.token && { Authorization: `Bearer ${state.token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && state.token) signOut(false);
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

function errorText(err) {
  if (Array.isArray(err.details) && err.details.length) return `${err.message}: ${err.details.join(', ')}`;
  return err.message;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

// Deterministic poster art from the title, so every film gets a distinct look without image hosting.
function hues(title) {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [h % 360, (h >> 9) % 360];
}
function artBg(title) {
  const [a, b] = hues(title);
  return `radial-gradient(120% 90% at 80% 10%, hsl(${a} 70% 42% / .9), transparent 60%),
          radial-gradient(90% 80% at 0% 100%, hsl(${b} 75% 30% / .9), transparent 65%),
          linear-gradient(160deg, hsl(${a} 45% 16%), hsl(${b} 55% 7%))`;
}
function poster(movie) {
  const img = movie.poster_url ? `<img src="${esc(movie.poster_url)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="poster ${img ? 'has-img' : ''}" style="--p-bg:${artBg(movie.title)}">${img}
    <div class="poster-genre">${esc((movie.genres || []).slice(0, 2).join(' · '))}</div>
    <div class="poster-title">${esc(movie.title)}</div>
    <div class="poster-foot"><span>Nguyen Awards</span><span class="poster-laurel">★</span></div>
  </div>`;
}

// Experience badge (IMAX, 3D, ...); Standard is the default format, so it stays unbadged unless forced.
const xpSlug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
const xpBadge = (name, force = false) => (name && (force || name !== 'Standard'))
  ? `<span class="xp" data-xp="${xpSlug(name)}">${esc(name)}</span>` : '';
const genreTags = (genres = []) => genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('');

const spinner = () => '<div class="skeleton"><div class="spinner" aria-label="Loading"></div></div>';

// ---------- auth ----------

async function loadUser() {
  if (!state.token) return;
  try { state.user = await api('GET', '/api/auth/me'); } catch { state.user = null; }
}

function signOut(rerender = true) {
  state.user = null;
  state.token = null;
  writeToken(null);
  renderNav();
  if (rerender) { location.hash = '#/'; toast('Signed out'); }
}

// Opens the sign in / sign up dialog; onSuccess runs after a successful login.
// Sign-in only: this is a portfolio demo, so the demo customer login is shown and sign-up is a placeholder.
async function openAuth(_mode, onSuccess) {
  const demo = (await theatreInfo()).demo_login;
  openModal(`
    <div class="auth">
      <span class="brand-mark">N</span>
      <h2>Welcome back</h2>
      <p>Sign in to reserve seats and see your tickets.</p>
      ${demo ? `<div class="demo-login">
        <b>Just exploring? Use this login</b>
        <dl><dt>Email</dt><dd><code>${esc(demo.email)}</code></dd><dt>Password</dt><dd><code>${esc(demo.password)}</code></dd></dl>
        <button type="button" class="btn btn-line btn-sm" id="demo-fill">Use demo login</button>
      </div>` : ''}
      <form id="auth-form" novalidate>
        <div class="field"><label for="auth-email">Email</label><input id="auth-email" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="current-password" required></div>
        <div class="form-error" id="auth-error"></div>
        <button class="btn btn-gold btn-lg" type="submit">Sign in</button>
      </form>
      <div class="auth-switch">New here?
        <button class="link-btn" id="auth-switch">Create an account</button></div>
      <p class="hint auth-closed" id="auth-closed" hidden>Sign-ups are closed in this demo. Use the demo login above.</p>
    </div>`, { narrow: true });

  // Placeholder only: sign-up isn't offered in the demo.
  modalRoot.querySelector('#auth-switch').onclick = () => { modalRoot.querySelector('#auth-closed').hidden = false; };
  const form = modalRoot.querySelector('#auth-form');
  modalRoot.querySelector('#demo-fill')?.addEventListener('click', () => {
    form.querySelector('#auth-email').value = demo.email;
    form.querySelector('#auth-password').value = demo.password;
    form.requestSubmit();
  });
  form.querySelector('input').focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const body = Object.fromEntries(new FormData(form));
    btn.disabled = true;
    try {
      const { token, user } = await api('POST', '/api/auth/login', body);
      state.token = token;
      state.user = user;
      writeToken(token);
      closeModal();
      renderNav();
      toast(`Welcome back, ${user.name}`, 'ok');
      if (onSuccess) onSuccess(); else render();
    } catch (err) {
      form.querySelector('#auth-error').textContent = errorText(err);
      btn.disabled = false;
    }
  };
}

function requireLogin(next) {
  if (state.user) return next();
  openAuth('login', next);
}

// ---------- modal ----------

function openModal(html, { narrow = false, onClose } = {}) {
  modalRoot.innerHTML = `<div class="overlay" id="overlay"><div class="modal ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true">
    <button class="modal-close" id="modal-close" aria-label="Close">✕</button>${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  const close = () => { closeModal(); onClose?.(); };
  modalRoot.querySelector('#modal-close').onclick = close;
  modalRoot.querySelector('#overlay').onclick = (e) => { if (e.target.id === 'overlay') close(); };
  modalRoot._onClose = close;
}
function closeModal() {
  modalRoot.innerHTML = '';
  modalRoot._onClose = null;
  document.body.style.overflow = '';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalRoot._onClose) modalRoot._onClose(); });

// ---------- nav ----------

function renderNav() {
  const route = location.hash.split('/')[1] || '';
  const link = (href, label, key) => `<a href="${href}" class="${route === key ? 'active' : ''}">${label}</a>`;
  document.getElementById('nav-links').innerHTML = [
    link('#/', 'Now Showing', ''),
    link('#/schedule', 'Showtimes', 'schedule'),
    state.user ? link('#/tickets', 'My Tickets', 'tickets') : '',
    state.user?.role === 'admin' ? link('#/admin', 'Admin', 'admin') : '',
  ].join('');
  const userBox = document.getElementById('nav-user');
  if (state.user) {
    userBox.innerHTML = `
      ${state.user.role === 'admin' ? '<span class="role-tag">Admin</span>' : ''}
      <span class="user-name">${esc(state.user.name)}</span>
      <span class="avatar" aria-hidden="true">${esc(state.user.name.trim()[0]?.toUpperCase() || '?')}</span>
      <button class="btn btn-line btn-sm" id="sign-out">Sign out</button>`;
    userBox.querySelector('#sign-out').onclick = () => signOut();
  } else {
    userBox.innerHTML = '<button class="btn btn-gold btn-sm" id="sign-in">Sign in</button>';
    userBox.querySelector('#sign-in').onclick = () => openAuth('login');
  }
}
window.addEventListener('scroll', () => document.getElementById('nav').classList.toggle('solid', scrollY > 40), { passive: true });

// ---------- home ----------

// What each experience offers, shown on the movie page like a cinema's format legend.
const EXPERIENCE_INFO = {
  Standard: { tagline: 'Big screen, reserved seating', amenities: ['Reserved seating', 'Digital sound'] },
  '4DX': { tagline: 'Seats that move. Wind. Mist. Hold on.', amenities: ['Motion seats', 'Wind, mist & scent', 'Reserved seating'],
    notice: '4DX motion seats aren\'t recommended for children under 4 or anyone pregnant or with heart, back or neck conditions.' },
  VIP: { tagline: 'Recliners and in-seat service, 19+', amenities: ['19+', 'Heated recliners', 'In-seat service'],
    notice: 'VIP is licensed: everyone in the auditorium must be 19 or older with valid ID.' },
};
const XP_ORDER = ['Standard', '4DX', 'VIP'];
const xpOrder = (a, b) => ((XP_ORDER.indexOf(a) + 1) || 99) - ((XP_ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b);

async function renderHome() {
  const [movies, shows] = await Promise.all([
    api('GET', '/api/movies?limit=100'),
    api('GET', '/api/showtimes?limit=100'),
  ]);
  const byMovie = new Map();
  for (const s of shows.data) {
    if (!byMovie.has(s.movie_id)) byMovie.set(s.movie_id, []);
    byMovie.get(s.movie_id).push(s);
  }
  const showing = movies.data.filter((m) => byMovie.has(m.id));
  if (!movies.data.length) {
    view.innerHTML = `<div class="page"><div class="empty"><strong>No films yet</strong>
      ${state.user?.role === 'admin' ? 'Add your first film from the admin panel.<a class="btn btn-gold" href="#/admin">Open admin</a>' : 'Check back soon for this week\'s lineup.'}</div></div>`;
    return;
  }

  // Feature the most recently added film. ponytail: picks from the first 100 films only, add an API sort if the catalog outgrows that.
  const featured = movies.data.reduce((a, b) => (b.created_at > a.created_at || (b.created_at === a.created_at && b.id > a.id) ? b : a));
  const nextShow = byMovie.get(featured.id)?.[0];

  // Cards show at most two premium formats to stay scannable; the detail view lists them all.
  const formats = (id) => {
    const xs = [...new Set((byMovie.get(id) || []).map((s) => s.experience))].filter((x) => x !== 'Standard').sort();
    return xs.slice(0, 2).map((x) => xpBadge(x)).join('') + (xs.length > 2 ? `<span class="more">+${xs.length - 2}</span>` : '');
  };
  const card = (m) => {
    const next = byMovie.get(m.id)?.[0];
    return `<button class="card" data-movie="${m.id}" aria-label="${esc(m.title)}">
      ${poster(m)}
      <div class="card-info">
        <div class="card-title">${esc(m.title)}</div>
        ${m.my_rating ? `<div class="card-rating" aria-label="My rating ${m.my_rating} out of 10">★ ${m.my_rating}<span>/10</span></div>` : ''}
        <div class="card-sub">${esc(m.genres.join(', '))} · ${runtime(m.duration_min)}</div>
        ${next ? `<div class="card-next">${isToday(next.starts_at) ? 'Today' : dayLabel(next.starts_at)} ${fmtTime(next.starts_at)}</div>` : '<div class="card-sub">No upcoming shows</div>'}
        ${formats(m.id) ? `<div class="card-xps">${formats(m.id)}</div>` : ''}
      </div></button>`;
  };
  const row = (title, list, note = '') => list.length ? `<section class="row"><h2>${title}${note ? ` <small>${note}</small>` : ''}</h2>
    <div class="row-track">
      <button class="row-arrow prev" data-dir="-1" aria-label="Previous films">‹</button>
      <div class="row-scroller">${list.map(card).join('')}</div>
      <button class="row-arrow next" data-dir="1" aria-label="More films">›</button>
    </div></section>` : '';

  const tonight = showing.filter((m) => byMovie.get(m.id).some((s) => isToday(s.starts_at)));
  const genres = [...new Set(movies.data.flatMap((m) => m.genres))].sort();
  // One row per premium experience currently on the schedule.
  const experiences = [...new Set(shows.data.map((s) => s.experience))].filter((x) => x !== 'Standard').sort();
  const inExperience = (x) => showing.filter((m) => byMovie.get(m.id).some((s) => s.experience === x));
  const popular = [...showing].sort((a, b) =>
    byMovie.get(b.id).reduce((n, s) => n + s.reserved, 0) - byMovie.get(a.id).reduce((n, s) => n + s.reserved, 0));

  // Films the admin marked Now Playing lead the top row; with none marked, today's most-booked films fill it.
  const picked = movies.data.filter((m) => m.now_playing).slice(0, 10);

  view.innerHTML = `
    <section class="hero">
      <div class="hero-art" style="background:${artBg(featured.title)}">${featured.poster_url
        ? `<img class="hero-bg-img" src="${esc(featured.poster_url)}" alt="" onerror="this.remove()">`
        : `<div class="hero-title-art" aria-hidden="true">${esc(featured.title)}</div>`}</div>
      ${featured.poster_url ? `<button class="hero-poster" data-movie="${featured.id}" aria-label="${esc(featured.title)} details">${poster(featured)}</button>` : ''}
      <div class="hero-content">
        <div class="hero-eyebrow">Featured presentation</div>
        <h1>${esc(featured.title)}</h1>
        <div class="meta">${genreTags(featured.genres)}<span>${runtime(featured.duration_min)}</span>
          ${nextShow ? `<span class="dot"></span><span>Next: ${dayLabel(nextShow.starts_at)} ${fmtTime(nextShow.starts_at)} · ${esc(nextShow.hall_name)}</span>${xpBadge(nextShow.experience)}` : ''}</div>
        <p>${esc(featured.description)}</p>
        <div class="hero-actions">
          ${nextShow ? `<a class="btn btn-gold btn-lg" href="#/movie/${featured.id}/tickets">▶&nbsp; Get tickets</a>` : ''}
          <button class="btn btn-ghost btn-lg" data-movie="${featured.id}">ⓘ&nbsp; More info</button>
        </div>
      </div>
    </section>
    <div class="rows">
      ${row('Now Playing', picked.length ? picked : popular.filter((m) => tonight.includes(m)).slice(0, 10), `My top 10 films <a class="btn btn-line btn-sm" href="#/schedule">See all showtimes →</a>`)}
      ${experiences.map((x) => row(`${xpBadge(x, true)} Experience`, inExperience(x), esc(EXPERIENCE_INFO[x]?.tagline || ''))).join('')}
      ${row('Most booked this week', popular)}
      <section class="row browse" aria-labelledby="browse-title">
        <h2 id="browse-title">Browse by genre</h2>
        <div class="browse-controls">
          <div class="browse-search">
            <input type="search" id="browse-q" placeholder="Search titles" aria-label="Search titles">
            <button class="btn btn-gold" id="browse-random" title="Picks from the films shown below">🎲&nbsp; Pick me a random movie</button>
          </div>
          <div class="xp-filter" role="tablist" aria-label="Genre" id="genre-pills"></div>
        </div>
        <div class="browse-grid" id="browse-grid" aria-live="polite"></div>
      </section>
    </div>`;

  // One genre at a time (plus an optional title search) instead of a row per genre.
  if (!['All', ...genres].includes(state.browseGenre)) state.browseGenre = 'All';
  const grid = view.querySelector('#browse-grid');
  const browseList = () => {
    const q = view.querySelector('#browse-q').value.trim().toLowerCase();
    return movies.data.filter((m) => (state.browseGenre === 'All' || m.genres.includes(state.browseGenre))
      && (!q || m.title.toLowerCase().includes(q)));
  };
  const drawBrowse = () => {
    const list = browseList();
    grid.innerHTML = list.map(card).join('') || '<div class="empty"><strong>No films match</strong>Try another genre or search.</div>';
    view.querySelector('#browse-random').disabled = !list.length;
  };
  // Random pick from whatever the genre/search currently shows; avoids repeating the last pick when there's a choice.
  view.querySelector('#browse-random').onclick = () => {
    const list = browseList();
    const pool = list.length > 1 ? list.filter((m) => m.id !== state.lastRandom) : list;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!pick) return;
    state.lastRandom = pick.id;
    location.hash = `#/movie/${pick.id}`;
  };
  // The 10 most common genres are buttons; the rest sit behind "+N more" so the list stays short as films are added.
  const count = (g) => movies.data.filter((m) => m.genres.includes(g)).length;
  const byCount = [...genres].sort((a, b) => count(b) - count(a) || a.localeCompare(b));
  const TOP = 10;
  const drawPills = () => {
    const shown = state.browseMore ? byCount : byCount.slice(0, TOP);
    // A picked genre stays visible even when it's one of the hidden ones.
    if (!shown.includes(state.browseGenre) && state.browseGenre !== 'All') shown.push(state.browseGenre);
    const extra = byCount.length - TOP;
    view.querySelector('#genre-pills').innerHTML = ['All', ...shown].map((g) =>
      `<button class="xp-pill" role="tab" data-genre="${esc(g)}" aria-selected="${g === state.browseGenre}">${esc(g)}</button>`).join('')
      + (extra > 0 ? `<button class="xp-pill more-pill" id="genre-more" aria-expanded="${!!state.browseMore}">${state.browseMore ? 'Show less' : `+${extra} more`}</button>` : '');
    view.querySelectorAll('[data-genre]').forEach((b) => {
      b.onclick = () => { state.browseGenre = b.dataset.genre; drawPills(); drawBrowse(); };
    });
    view.querySelector('#genre-more')?.addEventListener('click', () => { state.browseMore = !state.browseMore; drawPills(); });
  };
  drawPills();
  view.querySelector('#browse-q').oninput = drawBrowse;
  grid.onclick = (e) => { const c = e.target.closest('[data-movie]'); if (c) location.hash = `#/movie/${c.dataset.movie}`; };
  drawBrowse();

  view.querySelectorAll('[data-movie]').forEach((el) => {
    el.onclick = () => { location.hash = `#/movie/${el.dataset.movie}`; };
  });

  // Arrows page each row by its visible width and hide at the ends.
  view.querySelectorAll('.row-track').forEach((track) => {
    const scroller = track.querySelector('.row-scroller');
    const [prev, next] = track.querySelectorAll('.row-arrow');
    const sync = () => {
      prev.hidden = scroller.scrollLeft <= 4;
      next.hidden = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4;
    };
    for (const btn of [prev, next]) {
      btn.onclick = () => scroller.scrollBy({ left: btn.dataset.dir * scroller.clientWidth * 0.85, behavior: 'smooth' });
    }
    scroller.addEventListener('scroll', sync, { passive: true });
    new ResizeObserver(sync).observe(scroller);
  });
}

// ---------- theatre info ----------

const hourLabel = (h) => (h % 24 === 0 ? '12:00 AM' : h === 12 ? '12:00 PM' : h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`);

async function theatreInfo() {
  if (!state.theatre) {
    try { state.theatre = await api('GET', '/api/theatre'); } catch { state.theatre = { opens_hour: 12, closes_hour: 24 }; }
  }
  return state.theatre;
}

// ---------- movie page (Cineplex-style: details, then Get Tickets by date and experience) ----------

// The owner's review of a film: read-only for visitors, editable for the admin.
function drawReview(section, movie) {
  const r = movie.review;
  const isAdmin = state.user?.role === 'admin';
  section.hidden = !r && !isAdmin;
  if (section.hidden) return;
  const showForm = isAdmin && (!r || section.dataset.editing === '1');
  if (!showForm) {
    section.innerHTML = `
      <div class="review-head"><h2>My Review</h2>${isAdmin ? '<button class="btn btn-line btn-sm" id="rv-edit">Edit review</button>' : ''}</div>
      <div class="review-card">
        <div class="review-score"><b>${r.rating}</b><span>/10</span></div>
        <div class="review-text">
          ${r.watched_on ? `<div class="review-when">Watched ${new Date(`${r.watched_on}T12:00:00`).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}</div>` : ''}
          ${r.body ? `<p>${esc(r.body)}</p>` : '<p class="hint">No write-up yet.</p>'}
        </div>
      </div>`;
    section.querySelector('#rv-edit')?.addEventListener('click', () => { section.dataset.editing = '1'; drawReview(section, movie); });
    return;
  }
  const today = localDay(new Date().toISOString());
  section.innerHTML = `
    <div class="review-head"><h2>${r ? 'Edit my review' : 'Write a review'}</h2></div>
    <form class="panel form-grid review-form" novalidate>
      <fieldset class="field rating-field"><legend>Rating</legend>
        <div class="rating-pick">${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `
          <label><input type="radio" name="rating" value="${n}" ${r?.rating === n ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
      </fieldset>
      <div class="field"><label for="rv-date">Watched on</label><input id="rv-date" name="watched_on" type="date" max="${today}" value="${esc(r?.watched_on ?? today)}"></div>
      <div class="field"><label for="rv-body">Review</label><textarea id="rv-body" name="body" maxlength="10000" rows="6" placeholder="What did you think?">${esc(r?.body)}</textarea></div>
      <div class="form-error" id="rv-error"></div>
      <div class="review-actions">
        <button class="btn btn-gold" type="submit">Save review</button>
        ${r ? '<button class="btn btn-line" type="button" id="rv-cancel">Cancel</button><button class="btn btn-danger" type="button" id="rv-delete">Delete</button>' : ''}
      </div>
    </form>`;
  const form = section.querySelector('form');
  const done = (review) => { movie.review = review; section.dataset.editing = ''; drawReview(section, movie); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!f.rating) { form.querySelector('#rv-error').textContent = 'Pick a rating from 1 to 10.'; return; }
    try {
      done(await api('PUT', `/api/movies/${movie.id}/review`, { rating: Number(f.rating), body: f.body, watched_on: f.watched_on }));
      toast('Review saved', 'ok');
    } catch (err) { form.querySelector('#rv-error').textContent = errorText(err); }
  };
  section.querySelector('#rv-cancel')?.addEventListener('click', () => done(r));
  section.querySelector('#rv-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete your review of this film?')) return;
    try { await api('DELETE', `/api/movies/${movie.id}/review`); done(null); toast('Review deleted', 'ok'); }
    catch (err) { toast(errorText(err), 'error'); }
  });
}

async function renderMovie(id, sub) {
  const [movie, shows, theatre] = await Promise.all([
    api('GET', `/api/movies/${id}`),
    api('GET', `/api/showtimes?movieId=${id}&limit=100`),
    theatreInfo(),
  ]);
  const today = localDay(new Date().toISOString());
  const strip = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + i);
    return d.toISOString();
  });
  const daysWithShows = new Set(shows.data.map((s) => localDay(s.starts_at)));
  if (!daysWithShows.has(state.movieDay)) state.movieDay = [...daysWithShows][0] || today;
  const formats = [...new Set(shows.data.map((s) => s.experience))];
  const art = movie.poster_url
    ? `<img class="movie-hero-img" src="${esc(movie.poster_url)}" alt="" onerror="this.remove()">`
    : `<div class="hero-title-art" aria-hidden="true">${esc(movie.title)}</div>`;

  view.innerHTML = `
    <section class="movie-hero" style="background:${artBg(movie.title)}">
      ${art}
      <div class="movie-hero-inner">
        <div class="movie-poster">${poster(movie)}</div>
        <div class="movie-info">
          <a class="link-btn" href="#/">← All films</a>
          <h1>${esc(movie.title)}</h1>
          <div class="meta">${movie.genres.map((g) => `<a class="tag tag-link" href="#/genre/${encodeURIComponent(g)}" title="Browse ${esc(g)} films">${esc(g)}</a>`).join('')}<span>${runtime(movie.duration_min)}</span></div>
          ${formats.length ? `<div class="meta">${formats.sort(xpOrder).map((x) => xpBadge(x, true)).join('')}</div>` : ''}
          <p>${esc(movie.description)}</p>
          <div class="hero-actions">
            <a class="btn btn-gold btn-lg" href="#/movie/${movie.id}/tickets">Get Tickets</a>
          </div>
        </div>
      </div>
    </section>
    <section class="page review-panel" id="review"></section>
    <section class="page tickets-panel" id="tickets">
      <div class="tp-head">
        <h2>Get Tickets</h2>
        <div class="tp-theatre"><b>${esc(theatre.name || 'The Nguyen Awards Theatre')}</b>
          <span>Open daily ${hourLabel(theatre.opens_hour)} – ${hourLabel(theatre.closes_hour)}</span></div>
      </div>
      <div class="day-tabs date-strip" role="tablist" aria-label="Date">
        ${strip.map((iso) => {
          const d = localDay(iso);
          const has = daysWithShows.has(d);
          return `<button class="day-tab" role="tab" data-day="${d}" aria-selected="${d === state.movieDay}" ${has ? '' : 'disabled'}>
            <span>${dayLabel(iso)}</span><b>${new Date(iso).getDate()}</b><span class="mon">${new Date(iso).toLocaleDateString([], { month: 'short' })}</span></button>`;
        }).join('')}
      </div>
      <div id="xp-groups"></div>
    </section>`;

  const drawGroups = () => {
    const dayShows = shows.data.filter((s) => localDay(s.starts_at) === state.movieDay);
    const groups = [...new Set(dayShows.map((s) => s.experience))].sort(xpOrder);
    view.querySelector('#xp-groups').innerHTML = groups.length ? groups.map((x) => {
      const list = dayShows.filter((s) => s.experience === x);
      const info = EXPERIENCE_INFO[x];
      return `<article class="xp-group">
        <header>
          ${xpBadge(x, true)}
          <span class="xp-amenities">${(info?.amenities || []).map(esc).join(' · ')}</span>
          <span class="xp-from">From ${money(Math.min(...list.map((s) => s.price_cents)))}</span>
        </header>
        <div class="time-grid">${list.map((s) => {
          const ratio = s.available / s.capacity;
          return `<a class="time-btn ${s.available ? '' : 'sold'}" ${s.available ? `href="#/book/${s.id}"` : 'aria-disabled="true"'}>
            <b>${fmtTime(s.starts_at)}</b>
            <small class="${ratio <= 0.25 ? 'low' : ''}">${s.available ? (ratio <= 0.25 ? `${s.available} left` : esc(s.hall_name)) : 'Sold out'}</small>
          </a>`;
        }).join('')}</div>
      </article>`;
    }).join('') : '<div class="empty"><strong>No showtimes this day</strong>Pick another date above.</div>';
  };
  view.querySelectorAll('[data-day]').forEach((b) => {
    b.onclick = () => {
      state.movieDay = b.dataset.day;
      view.querySelectorAll('[data-day]').forEach((x) => x.setAttribute('aria-selected', x === b));
      drawGroups();
    };
  });
  drawGroups();
  drawReview(view.querySelector('#review'), movie);
  if (sub === 'tickets' || sub === 'review') view.querySelector(`#${sub}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
  view.querySelector('.date-strip [aria-selected="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// ---------- seat helpers ----------

// Same desirability curve the server's demand simulator uses: center columns, rows a little past the middle.
function seatScore(label, rowCount, perRow) {
  const r = label.charCodeAt(0) - 65;
  const c = Number(label.slice(1)) - 1;
  const center = 1 - Math.abs(c - (perRow - 1) / 2) / (perRow / 2);
  const rowPos = rowCount > 1 ? r / (rowCount - 1) : 0.5;
  return 0.55 * center + 0.45 * (1 - Math.abs(rowPos - 0.6) / 0.6);
}
const PRIME = 0.62;

function hallShape(seats) {
  const rows = new Set(seats.map((s) => s.label[0]));
  const perRow = Math.max(...seats.map((s) => Number(s.label.slice(1))));
  return { rowCount: rows.size, perRow };
}
function primeFree(seatMap) {
  const { rowCount, perRow } = hallShape(seatMap.seats);
  return seatMap.seats.filter((s) => s.status === 'available' && seatScore(s.label, rowCount, perRow) >= PRIME).length;
}

const LIVE_POLL_MS = 6000;
const MAX_TICKETS = 10;

// ---------- booking flow: Tickets → Seats → Review → Confirmed ----------

async function renderBooking(id) {
  const [show, seatMap, theatre] = await Promise.all([api('GET', `/api/showtimes/${id}`), api('GET', `/api/showtimes/${id}/seats`), theatreInfo()]);
  // Keep choices when moving between steps of the same showtime. Switching to another time (e.g. from
  // "Better seats here") carries the ticket counts over and goes straight to seat selection.
  if (state.booking?.id !== show.id) {
    const carry = state.booking?.show?.movie_id === show.movie_id ? state.booking.counts : {};
    const counts = Object.fromEntries(show.ticket_prices.map((t) => [t.type, carry[t.type] || 0]));
    const carried = Object.values(counts).reduce((a, n) => a + n, 0);
    state.booking = { id: show.id, step: carried && carried <= show.available ? 'seats' : 'tickets', counts, seats: [], snacks: {} };
  }
  const b = state.booking;
  b.show = show;
  b.seatMap = seatMap;
  b.combos = theatre.snack_combos || [];
  b.snacks ||= {};
  drawBooking();
}

const ticketTotal = (b) => b.show.ticket_prices.reduce((sum, t) => sum + (b.counts[t.type] || 0) * t.price_cents, 0);
const snackTotal = (b) => b.combos.reduce((sum, c) => sum + (b.snacks[c.id] || 0) * c.price_cents, 0);
const orderTotal = (b) => ticketTotal(b) + snackTotal(b);
const ticketCount = (b) => Object.values(b.counts).reduce((a, n) => a + n, 0);

function drawBooking() {
  clearInterval(liveTimer);
  const b = state.booking;
  const { show } = b;
  const steps = [['tickets', 'Tickets'], ['seats', 'Seats'], ['review', 'Review'], ['done', 'Confirmed']];
  const at = steps.findIndex(([k]) => k === b.step);
  const info = EXPERIENCE_INFO[show.experience];

  view.innerHTML = `
    <div class="page book">
      <header class="book-head">
        <div class="book-poster">${poster({ title: show.movie_title, poster_url: show.poster_url })}</div>
        <div class="book-title">
          <a class="link-btn" href="#/movie/${show.movie_id}/tickets">← Change showtime</a>
          <h1>${esc(show.movie_title)}</h1>
          <div class="meta">${xpBadge(show.experience, true)}<span>${fmtLong(show.starts_at)} · ${fmtTime(show.starts_at)}</span><span class="dot"></span><span>${esc(show.hall_name)}</span></div>
        </div>
      </header>
      <ol class="stepper">${steps.map(([k, l], i) => `<li class="${i < at ? 'done' : i === at ? 'current' : ''}"><span>${i < at ? '✓' : i + 1}</span>${l}</li>`).join('')}</ol>
      <div class="book-grid">
        <div class="book-main" id="book-main"></div>
        <aside class="book-summary" id="book-summary"></aside>
      </div>
      ${info?.notice ? `<p class="hint book-notice">${esc(info.notice)}</p>` : ''}
    </div>`;

  ({ tickets: stepTickets, seats: stepSeats, review: stepReview, done: stepDone })[b.step]();
}

function goStep(step) {
  state.booking.step = step;
  drawBooking();
  scrollTo({ top: 0, behavior: 'smooth' });
}

// Order summary + primary action; on phones this becomes a bar pinned to the bottom of the screen.
function drawSummary({ action, enabled, onAction, back }) {
  const b = state.booking;
  const lines = b.show.ticket_prices.filter((t) => b.counts[t.type]).map((t) =>
    `<div class="line"><span>${b.counts[t.type]} × ${esc(t.label)}</span><b>${money(b.counts[t.type] * t.price_cents)}</b></div>`).join('')
    + b.combos.filter((c) => b.snacks[c.id]).map((c) =>
      `<div class="line"><span>${b.snacks[c.id]} × ${esc(c.label)}</span><b>${money(b.snacks[c.id] * c.price_cents)}</b></div>`).join('');
  const box = view.querySelector('#book-summary');
  box.innerHTML = `
    <h3>Order summary</h3>
    <div class="sum-lines">${lines || '<span class="hint">No tickets yet</span>'}
      ${b.seats.length ? `<div class="line"><span>Seats</span><b>${b.seats.slice().sort(seatSort).join(', ')}</b></div>` : ''}</div>
    <div class="line total"><span>Total</span><b>${money(orderTotal(b))}</b></div>
    <div class="sum-actions">
      ${back ? `<button class="btn btn-line" id="sum-back">Back</button>` : ''}
      ${action ? `<button class="btn btn-gold" id="sum-next" ${enabled ? '' : 'disabled'}>${action}</button>` : ''}
    </div>`;
  box.querySelector('#sum-next')?.addEventListener('click', onAction);
  box.querySelector('#sum-back')?.addEventListener('click', () => goStep(back));
}

const seatSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });

function stepTickets() {
  const b = state.booking;
  const { show } = b;
  const cap = Math.min(MAX_TICKETS, show.available);
  const main = view.querySelector('#book-main');
  const draw = () => {
    const n = ticketCount(b);
    main.innerHTML = `
      <h2>How many tickets?</h2>
      <p class="hint">Up to ${cap} per booking. Prices include taxes.${show.min_age ? ` This is a ${show.min_age}+ showing; bring valid ID.` : ''}</p>
      <div class="ticket-types">${show.ticket_prices.map((t) => `
        <div class="ticket-type">
          <div><b>${esc(t.label)}</b><span>${money(t.price_cents)}</span></div>
          <div class="stepper-ctl">
            <button class="qty" data-minus="${t.type}" aria-label="Remove ${esc(t.label)}" ${b.counts[t.type] ? '' : 'disabled'}>−</button>
            <output aria-live="polite">${b.counts[t.type] || 0}</output>
            <button class="qty" data-plus="${t.type}" aria-label="Add ${esc(t.label)}" ${n >= cap ? 'disabled' : ''}>+</button>
          </div>
        </div>`).join('')}
      </div>
      ${show.available < 1 ? '<div class="empty"><strong>Sold out</strong>Pick another showtime.</div>' : ''}`;
    main.querySelectorAll('[data-plus]').forEach((x) => { x.onclick = () => { b.counts[x.dataset.plus]++; draw(); }; });
    main.querySelectorAll('[data-minus]').forEach((x) => { x.onclick = () => { b.counts[x.dataset.minus]--; draw(); }; });
    // Fewer tickets than picked seats: drop the most recent picks.
    while (b.seats.length > n) b.seats.pop();
    drawSummary({ action: n ? `Choose ${n} seat${n > 1 ? 's' : ''}` : 'Choose seats', enabled: n > 0, onAction: () => goStep('seats') });
  };
  draw();
}

function stepSeats() {
  const b = state.booking;
  const { show, seatMap } = b;
  const need = ticketCount(b);
  if (!need) return goStep('tickets');
  const { rowCount, perRow } = hallShape(seatMap.seats);
  let reserved = new Set(seatMap.seats.filter((s) => s.status === 'reserved').map((s) => s.label));
  b.seats = b.seats.filter((l) => !reserved.has(l));
  let takenSinceArrival = 0;
  const rows = new Map();
  for (const seat of seatMap.seats) {
    if (!rows.has(seat.label[0])) rows.set(seat.label[0], []);
    rows.get(seat.label[0]).push(seat);
  }
  const mid = Math.ceil(perRow / 2);

  const main = view.querySelector('#book-main');
  main.innerHTML = `
    <div class="rush" role="note">
      <span class="rush-icon" aria-hidden="true">⚠</span>
      <div><strong>Warning: leave this page, lose your place.</strong>
        <span>Someone out there shares your seat taste, and they're racing for the space.</span></div>
      <span class="rush-live"><i></i>Live</span>
    </div>
    <div class="stage">
      <div class="seat-count" id="seat-count"></div>
      <div class="screen"><div class="screen-arc"></div><span>SCREEN</span></div>
      <div class="seat-grid" style="--left:${mid};--right:${perRow - mid}">
        ${[...rows].map(([r, seats]) => `<div class="seat-row"><span class="row-label">${r}</span>
          ${seats.map((s, i) => `${i === mid ? '<span class="aisle"></span>' : ''}<button class="seat ${seatScore(s.label, rowCount, perRow) >= PRIME ? 'prime' : ''}"
            data-label="${s.label}" aria-label="Seat ${s.label}" aria-pressed="${b.seats.includes(s.label)}" ${reserved.has(s.label) ? 'disabled' : ''}>${s.label.slice(1)}</button>`).join('')}
          <span class="row-label">${r}</span></div>`).join('')}
      </div>
      <div class="legend"><span><i></i>Available</span><span><i class="prime"></i>Best view</span><span><i class="sel"></i>Your pick</span><span><i class="taken"></i>Taken</span></div>
      <div class="stage-foot" id="stage-foot"></div>
    </div>
    <section class="alt-times" id="alt-times" hidden>
      <h3 class="section-label">Better seats at another time?</h3>
      <div class="alt-grid" id="alt-grid"></div>
    </section>`;

  const sync = () => {
    const left = need - b.seats.length;
    main.querySelector('#seat-count').innerHTML = left
      ? `Select <b>${left}</b> more seat${left > 1 ? 's' : ''} <span class="hint">(${b.seats.length} of ${need})</span>`
      : `<b class="ok">All ${need} seats selected</b> <span class="hint">Tap a seat again to change it</span>`;
    const free = seatMap.seats.length - reserved.size;
    const prime = seatMap.seats.filter((s) => !reserved.has(s.label) && seatScore(s.label, rowCount, perRow) >= PRIME).length;
    main.querySelector('#stage-foot').innerHTML = `
      <span><b>${free}</b> of ${seatMap.seats.length} free</span>
      <span><b class="gold">${prime}</b> best-view left</span>
      ${takenSinceArrival ? `<span class="hot"><b>${takenSinceArrival}</b> taken since you arrived</span>` : ''}`;
    drawSummary({ action: 'Review order', enabled: b.seats.length === need, onAction: () => goStep('review'), back: 'tickets' });
  };
  main.querySelectorAll('.seat').forEach((btn) => {
    btn.onclick = () => {
      const label = btn.dataset.label;
      if (b.seats.includes(label)) b.seats = b.seats.filter((l) => l !== label);
      else if (b.seats.length >= need) return toast(`You have ${need} ticket${need > 1 ? 's' : ''}. Tap a selected seat to swap it.`);
      else b.seats.push(label);
      btn.setAttribute('aria-pressed', b.seats.includes(label));
      sync();
    };
  });
  sync();

  // Live seat map: other guests' bookings appear while you choose; any of your picks they take are released.
  liveTimer = setInterval(async () => {
    let latest;
    try { latest = await api('GET', `/api/showtimes/${show.id}/seats`); } catch { return; }
    if (state.booking !== b || b.step !== 'seats') return;
    b.seatMap = latest;
    const now = new Set(latest.seats.filter((s) => s.status === 'reserved').map((s) => s.label));
    const fresh = [...now].filter((l) => !reserved.has(l));
    const lost = fresh.filter((l) => b.seats.includes(l));
    for (const label of fresh) {
      const el = main.querySelector(`.seat[data-label="${label}"]`);
      if (!el) continue;
      el.disabled = true;
      el.setAttribute('aria-pressed', 'false');
      el.classList.add('just-taken');
      setTimeout(() => el.classList.remove('just-taken'), 2600);
    }
    for (const label of reserved) {
      if (now.has(label)) continue;
      const el = main.querySelector(`.seat[data-label="${label}"]`);
      if (el) el.disabled = false;
    }
    b.seats = b.seats.filter((l) => !now.has(l));
    takenSinceArrival += fresh.length;
    reserved = now;
    if (lost.length) toast(`${lost.join(', ')} ${lost.length > 1 ? 'were' : 'was'} just taken by another guest. Pick another seat.`, 'error');
    if (fresh.length) sync();
  }, LIVE_POLL_MS);

  loadAlternatives(show, primeFree(seatMap));
}

function stepReview() {
  const b = state.booking;
  const { show } = b;
  if (b.seats.length !== ticketCount(b) || !b.seats.length) return goStep('seats');
  const main = view.querySelector('#book-main');
  main.innerHTML = `
    <h2>Review your order</h2>
    <div class="review">
      <div class="review-row"><span>Film</span><b>${esc(show.movie_title)}</b></div>
      <div class="review-row"><span>When</span><b>${fmtLong(show.starts_at)} at ${fmtTime(show.starts_at)}</b></div>
      <div class="review-row"><span>Where</span><b>${esc(show.hall_name)} · ${xpBadge(show.experience, true)}</b></div>
      <div class="review-row"><span>Seats</span><div class="chips">${b.seats.slice().sort(seatSort).map((s) => `<span class="chip">${s}</span>`).join('')}</div></div>
      <div class="review-row"><span>Tickets</span><b>${show.ticket_prices.filter((t) => b.counts[t.type]).map((t) => `${b.counts[t.type]} ${esc(t.label)}`).join(', ')}</b></div>
    </div>
    ${b.combos.length ? '<section class="combo-upsell" id="combo-upsell" aria-labelledby="combo-title"></section>' : ''}
    <p class="hint">Pay at the box office or kiosk when you arrive. Snacks are ready at the concession pickup counter. You can cancel from My Tickets any time before the show starts.</p>
    ${state.user ? `<p class="hint">Booking as <b>${esc(state.user.email)}</b></p>` : '<div class="signin-box"><b>Sign in to finish your booking</b><span class="hint">Your seats, tickets and snacks will be kept.</span></div>'}`;

  // Wombo Combo upsell: one combo is recommended for the party size (1 → Solo, 2–3 → Wombo, 4+ → Mega).
  const party = ticketCount(b);
  const recommended = [...b.combos].sort((x, y) => y.party - x.party).find((c) => c.party <= party)?.id;
  const drawCombos = () => {
    const box = main.querySelector('#combo-upsell');
    if (!box) return;
    box.innerHTML = `
      <div class="combo-head">
        <span class="combo-eyebrow">🍿 Wombo Combo deals</span>
        <h3 id="combo-title">Make it a movie night</h3>
        <p class="hint">Add snacks now and skip the line. Pickup at the concession counter.</p>
      </div>
      <div class="combo-grid">${b.combos.map((c) => {
        const qty = b.snacks[c.id] || 0;
        return `<article class="combo ${qty ? 'added' : ''} ${c.id === recommended ? 'recommended' : ''}">
          ${c.id === recommended ? `<span class="combo-flag">Best for ${party === 1 ? '1 person' : `your party of ${party}`}</span>` : ''}
          <b class="combo-name">${esc(c.label)}</b>
          <span class="combo-items">${esc(c.items)}</span>
          <div class="combo-foot">
            <span class="combo-price">${money(c.price_cents)}</span>
            ${qty ? `<div class="stepper-ctl">
                <button class="qty" data-snack-minus="${c.id}" aria-label="Remove one ${esc(c.label)}">−</button>
                <output aria-live="polite">${qty}</output>
                <button class="qty" data-snack-plus="${c.id}" aria-label="Add another ${esc(c.label)}" ${qty >= 10 ? 'disabled' : ''}>+</button>
              </div>`
              : `<button class="btn ${c.id === recommended ? 'btn-gold' : 'btn-line'} btn-sm" data-snack-plus="${c.id}">Add</button>`}
          </div>
        </article>`;
      }).join('')}</div>`;
    box.querySelectorAll('[data-snack-plus]').forEach((x) => { x.onclick = () => { b.snacks[x.dataset.snackPlus] = (b.snacks[x.dataset.snackPlus] || 0) + 1; redraw(); }; });
    box.querySelectorAll('[data-snack-minus]').forEach((x) => {
      x.onclick = () => { const k = x.dataset.snackMinus; b.snacks[k] = Math.max(0, (b.snacks[k] || 0) - 1); if (!b.snacks[k]) delete b.snacks[k]; redraw(); };
    });
  };

  const reserve = () => requireLogin(async () => {
    const btn = view.querySelector('#sum-next');
    if (btn) btn.disabled = true;
    try {
      const tickets = Object.fromEntries(Object.entries(b.counts).filter(([, n]) => n > 0));
      b.result = await api('POST', '/api/reservations', { showtime_id: show.id, seats: b.seats, tickets, snacks: b.snacks });
      goStep('done');
    } catch (err) {
      toast(errorText(err), 'error');
      if (err.status === 409) {
        // Someone took a seat: refresh the map and send them back to pick again.
        const taken = new Set(err.details || []);
        b.seats = b.seats.filter((l) => !taken.has(l));
        b.seatMap = await api('GET', `/api/showtimes/${show.id}/seats`);
        goStep('seats');
      } else if (btn) btn.disabled = false;
    }
  });
  const redraw = () => {
    drawCombos();
    drawSummary({ action: state.user ? `Reserve · ${money(orderTotal(b))}` : 'Sign in to reserve', enabled: true, onAction: reserve, back: 'seats' });
  };
  redraw();
}

function stepDone() {
  const b = state.booking;
  const r = b.result;
  if (!r) return goStep('tickets');
  view.querySelector('#book-main').innerHTML = `
    <div class="booked">
      <div class="confirmed-mark" aria-hidden="true">✓</div>
      <h2>You're booked!</h2>
      <p>Booking <b>#${r.id}</b> · ${esc(r.movie_title)} · ${fmtLong(r.starts_at)} at ${fmtTime(r.starts_at)}</p>
      <div class="chips">${r.seats.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
      <p class="hint">${[...(r.tickets || []).map((t) => `${t.count} × ${esc(t.label)}`), ...(r.snacks || []).map((s) => `🍿 ${s.qty} × ${esc(s.label)}`)].join(' · ')} · Total ${money(r.total_cents)}</p>
      <div class="hero-actions"><button class="btn btn-gold" id="done-pass">Show ticket</button><a class="btn btn-line" href="#/tickets">My tickets</a><a class="btn btn-line" href="#/">Back to films</a></div>
    </div>`;
  view.querySelector('#done-pass').onclick = () => openTicketPass(r.id);
  view.querySelector('#book-summary').hidden = true;
  state.booking = null;
}

// The scannable ticket pass: what a guest shows at the door. The QR holds the signed ticket code.
async function openTicketPass(id) {
  let r;
  try { r = await api('GET', `/api/reservations/${id}`); } catch (err) { return toast(errorText(err), 'error'); }
  const admits = r.seats.length;
  const lines = [
    ...(r.tickets || []).map((t) => [`${t.count} × ${esc(t.label)}`, t.count * t.price_cents]),
    ...(r.snacks || []).map((s) => [`🍿 ${s.qty} × ${esc(s.label)}`, s.qty * s.price_cents]),
  ];
  openModal(`
    <article class="pass" aria-label="Ticket for ${esc(r.movie_title)}">
      <header class="pass-head">
        <span class="brand-mark">N</span>
        <div><b>The Nguyen Awards Theatre</b><span>Admit ${admits} · ${xpBadge(r.experience, true)}</span></div>
      </header>
      <div class="pass-film">
        ${poster({ title: r.movie_title, poster_url: r.poster_url })}
        <div><h2>${esc(r.movie_title)}</h2><div class="pass-when">${fmtLong(r.starts_at)}<b>${fmtTime(r.starts_at)}</b></div></div>
      </div>
      <dl class="pass-grid">
        <div><dt>Hall</dt><dd>${esc(r.hall_name)}</dd></div>
        <div><dt>Seats</dt><dd>${r.seats.slice().sort(seatSort).map(esc).join(', ')}</dd></div>
        <div><dt>Booking</dt><dd>#${r.id}</dd></div>
      </dl>
      <div class="pass-tear" aria-hidden="true"></div>
      <div class="pass-scan">
        <div class="pass-qr" role="img" aria-label="QR code for ticket ${esc(r.ticket_code)}">${r.qr_svg}</div>
        <code class="pass-code">${esc(r.ticket_code)}</code>
        <p class="hint">Show this at the door to be scanned in.${r.snacks?.length ? ' Use the same code at the concession counter for your snacks.' : ''}</p>
      </div>
      <ul class="ticket-lines pass-lines">${lines.map(([label, cents]) => `<li><span>${label}</span><b>${money(cents)}</b></li>`).join('')}
        <li class="pass-total"><span>Total, pay at the box office</span><b>${money(r.total_cents)}</b></li></ul>
      ${r.status === 'cancelled' ? '<p class="pass-void">Cancelled: this ticket is no longer valid</p>' : ''}
    </article>`, { narrow: true });
}

// Compares best-view availability across this film's other times nearby, and points to any that beat this one.
async function loadAlternatives(show, herePrime) {
  let others;
  try {
    const shows = await api('GET', `/api/showtimes?movieId=${show.movie_id}&limit=100`);
    const t = Date.parse(show.starts_at);
    others = shows.data.filter((s) => s.id !== show.id && Math.abs(Date.parse(s.starts_at) - t) < 2 * 86_400_000).slice(0, 6);
    if (!others.length) return;
    const maps = await Promise.all(others.map((s) => api('GET', `/api/showtimes/${s.id}/seats`)));
    others = others.map((s, i) => ({ ...s, prime: primeFree(maps[i]) })).sort((a, c) => c.prime - a.prime);
  } catch { return; }
  const box = view.querySelector('#alt-times');
  if (!box || state.booking?.step !== 'seats') return;
  const best = others[0].prime > herePrime ? others[0].id : null;
  box.hidden = false;
  box.querySelector('#alt-grid').innerHTML = others.map((s) => `
    <a class="alt ${s.id === best ? 'best' : ''}" href="#/book/${s.id}">
      ${s.id === best ? '<span class="alt-flag">Better seats here</span>' : ''}
      <span class="alt-when"><b>${fmtTime(s.starts_at)}</b> ${dayLabel(s.starts_at)}</span>
      ${xpBadge(s.experience, true)}
      <span class="alt-prime"><b>${s.prime}</b> best-view seats free <em>vs ${herePrime} here</em></span>
      <span class="hint">${esc(s.hall_name)} · ${money(s.price_cents)}</span>
    </a>`).join('');
}

// ---------- browse by date ----------

async function renderSchedule(dayParam) {
  const today = localDay(new Date().toISOString());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam || '') && dayParam >= today ? dayParam : today;
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const [shows, movies] = await Promise.all([
    api('GET', `/api/showtimes?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}&limit=100`),
    api('GET', '/api/movies?limit=100'),
  ]);
  const movieById = new Map(movies.data.map((m) => [m.id, m]));
  const experiences = [...new Set(shows.data.map((s) => s.experience))].sort();
  const xp = experiences.includes(state.scheduleXp) ? state.scheduleXp : 'all';

  const strip = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + i);
    return d.toISOString();
  });

  const filtered = shows.data.filter((s) => xp === 'all' || s.experience === xp);
  const byMovie = new Map();
  for (const s of filtered) {
    if (!byMovie.has(s.movie_id)) byMovie.set(s.movie_id, []);
    byMovie.get(s.movie_id).push(s);
  }

  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><h1>Showtimes</h1><p>${fmtLong(start.toISOString())} at The Nguyen Awards Theatre</p></div>
      </div>
      <div class="day-tabs date-strip" role="tablist" aria-label="Date">
        ${strip.map((iso) => {
          const d = localDay(iso);
          return `<a class="day-tab" role="tab" aria-selected="${d === day}" href="#/schedule/${d}">
            <span>${dayLabel(iso)}</span><b>${new Date(iso).getDate()}</b><span class="mon">${new Date(iso).toLocaleDateString([], { month: 'short' })}</span></a>`;
        }).join('')}
      </div>
      ${experiences.length > 1 ? `<div class="xp-filter" role="tablist" aria-label="Experience">
        ${['all', ...experiences].map((x) => `<button role="tab" class="xp-pill" data-x="${esc(x)}" aria-selected="${x === xp}">${x === 'all' ? 'All formats' : esc(x)}</button>`).join('')}
      </div>` : ''}
      ${byMovie.size ? `<div class="schedule">${[...byMovie].map(([movieId, list]) => {
        const m = movieById.get(movieId) || { title: list[0].movie_title, genres: [], duration_min: list[0].duration_min };
        return `<article class="sched-row">
          <a class="sched-poster" href="#/movie/${movieId}">${poster(m)}</a>
          <div class="sched-body">
            <a href="#/movie/${movieId}"><h2>${esc(m.title)}</h2></a>
            <div class="meta">${genreTags(m.genres)}<span>${runtime(m.duration_min)}</span></div>
            ${m.description ? `<p>${esc(m.description)}</p>` : ''}
            <div class="times">${list.map((s) => {
              const ratio = s.available / s.capacity;
              return `<a class="time-chip" href="#/book/${s.id}">
                <span class="time-top"><b>${fmtTime(s.starts_at)}</b>${xpBadge(s.experience, true)}</span>
                <span>${esc(s.hall_name)} · ${money(s.price_cents)}</span>
                <span class="left ${ratio <= 0.3 ? 'low' : ''}">${s.available ? (ratio <= 0.3 ? `Selling fast · ${s.available} left` : `${s.available} seats left`) : 'Sold out'}</span>
              </a>`;
            }).join('')}</div>
          </div>
        </article>`;
      }).join('')}</div>`
      : `<div class="empty"><strong>No showtimes${xp === 'all' ? '' : ` in ${esc(xp)}`} on this day</strong>Try another date${xp === 'all' ? '' : ' or format'}.</div>`}
    </div>`;

  view.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => { state.scheduleXp = b.dataset.x; renderSchedule(day); }; });
  view.querySelector('.date-strip [aria-selected="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// ---------- my tickets ----------

async function renderTickets() {
  if (!state.user) {
    view.innerHTML = `<div class="page"><div class="empty"><strong>Sign in to see your tickets</strong>
      <button class="btn btn-gold" id="t-login">Sign in</button></div></div>`;
    view.querySelector('#t-login').onclick = () => openAuth('login');
    return;
  }
  const list = await api('GET', `/api/reservations?scope=${state.ticketScope}`);
  const now = new Date().toISOString();
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><h1>My Tickets</h1><p>Your seats at The Nguyen Awards Theatre.</p></div>
        <div class="tabs" role="tablist">
          ${['upcoming', 'past', 'all'].map((s) => `<button role="tab" data-scope="${s}" aria-selected="${state.ticketScope === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        </div>
      </div>
      ${list.length ? `<div class="tickets">${list.map((r) => {
        const past = r.starts_at <= now;
        const statusClass = r.status === 'cancelled' ? 'cancelled' : past ? 'past' : 'confirmed';
        const statusText = r.status === 'cancelled' ? 'Cancelled' : past ? 'Attended' : 'Confirmed';
        // Itemized like a receipt: ticket types, then snack combos.
        const lines = [
          ...(r.tickets || []).map((t) => [`${t.count} × ${esc(t.label)}`, t.count * t.price_cents]),
          ...(r.snacks || []).map((s) => [`🍿 ${s.qty} × ${esc(s.label)}`, s.qty * s.price_cents]),
        ];
        const soon = r.status === 'confirmed' && !past && ['Today', 'Tomorrow'].includes(dayLabel(r.starts_at));
        return `<article class="ticket is-${statusClass}">
          <a class="ticket-poster" href="#/movie/${r.movie_id}" aria-label="${esc(r.movie_title)}">${poster({ title: r.movie_title, poster_url: r.poster_url })}</a>
          <div class="ticket-body">
            <header class="ticket-top">
              <div class="ticket-heading">
                <h3>${esc(r.movie_title)}</h3>
                <div class="ticket-when">${soon ? `<span class="ticket-soon">${dayLabel(r.starts_at)}</span>` : ''}${fmtLong(r.starts_at)} · ${fmtTime(r.starts_at)}</div>
              </div>
              <span class="status ${statusClass}">${statusText}</span>
            </header>
            <div class="ticket-where">${xpBadge(r.experience, true)}<span>${esc(r.hall_name)}</span></div>
            <div class="ticket-seats"><span class="ticket-label">Seats</span><div class="chips">${r.seats.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div></div>
            ${lines.length ? `<ul class="ticket-lines">${lines.map(([label, cents]) => `<li><span>${label}</span><b>${money(cents)}</b></li>`).join('')}</ul>` : ''}
            <footer class="ticket-foot">
              <span class="ticket-ref">Booking #${r.id}</span>
              <span class="ticket-total">Total <b>${money(r.total_cents)}</b></span>
              ${r.status === 'confirmed' && !past ? `<span class="confirm-row" data-cancel-wrap="${r.id}"><button class="btn btn-line btn-sm ticket-cancel" data-cancel="${r.id}">Cancel booking</button><button class="btn btn-gold btn-sm" data-pass="${r.id}">Show ticket</button></span>` : ''}
            </footer>
          </div></article>`;
      }).join('')}</div>`
      : `<div class="empty"><strong>${state.ticketScope === 'upcoming' ? 'No upcoming tickets' : 'Nothing here yet'}</strong>
          Find a film you like and pick your seats.<a class="btn btn-gold" href="#/">Browse films</a></div>`}
    </div>`;

  view.querySelectorAll('[data-scope]').forEach((b) => { b.onclick = () => { state.ticketScope = b.dataset.scope; renderTickets(); }; });
  view.querySelectorAll('[data-pass]').forEach((b) => { b.onclick = () => openTicketPass(b.dataset.pass); });
  view.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = () => {
      const wrap = view.querySelector(`[data-cancel-wrap="${b.dataset.cancel}"]`);
      wrap.innerHTML = `Cancel booking? <button class="btn btn-danger btn-sm" data-yes>Yes, cancel</button><button class="btn btn-line btn-sm" data-no>Keep</button>`;
      wrap.querySelector('[data-no]').onclick = () => renderTickets();
      wrap.querySelector('[data-yes]').onclick = async () => {
        try {
          await api('DELETE', `/api/reservations/${b.dataset.cancel}`);
          toast('Booking cancelled. Your seats have been released.', 'ok');
        } catch (err) { toast(errorText(err), 'error'); }
        renderTickets();
      };
    };
  });
}

// ---------- admin ----------

async function renderAdmin() {
  if (state.user?.role !== 'admin') {
    view.innerHTML = `<div class="page"><div class="empty"><strong>Admins only</strong>This area is for theatre staff.<a class="btn btn-gold" href="#/">Back to films</a></div></div>`;
    return;
  }
  const tabs = [['overview', 'Overview'], ['reservations', 'Reservations'], ['movies', 'Films'], ['showtimes', 'Showtimes'], ['experiences', 'Experiences'], ['reviews', 'Reviews'], ['users', 'Members']];
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><h1>Theatre Admin</h1><p>Manage films, schedule showtimes and track bookings.</p></div>
        <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${state.adminTab === k}">${l}</button>`).join('')}</div>
      </div>
      <div id="admin-body">${spinner()}</div>
    </div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.editMovieId = null; state.editXpId = null; location.hash = `#/admin/${b.dataset.tab}`; };
  });
  const body = view.querySelector('#admin-body');
  try {
    await ({ overview: adminOverview, reservations: adminReservations, movies: adminMovies, showtimes: adminShowtimes, experiences: adminExperiences, reviews: adminReviews, users: adminUsers })[state.adminTab](body);
  } catch (err) {
    body.innerHTML = `<div class="empty"><strong>Couldn't load this tab</strong>${esc(errorText(err))}</div>`;
  }
}

const occupancy = (sold, cap, pct) => `<div class="occ"><span>${sold} / ${cap} · ${pct}%</span><div class="meter"><i style="width:${Math.min(pct, 100)}%"></i></div></div>`;

async function adminOverview(body) {
  const [sum, byMovie, byShow, byXp] = await Promise.all([
    api('GET', '/api/admin/reports/summary'),
    api('GET', '/api/admin/reports/movies'),
    api('GET', '/api/admin/reports/showtimes'),
    api('GET', '/api/admin/reports/experiences'),
  ]);
  const upcoming = byShow.filter((s) => s.starts_at > new Date().toISOString()).slice(0, 12);
  body.innerHTML = `
    <div style="display:grid;gap:20px">
      <div class="stats">
        <div class="stat"><span>Revenue</span><b class="gold">${money(sum.revenue_cents)}</b></div>
        <div class="stat"><span>Bookings</span><b>${sum.confirmed_reservations}</b></div>
        <div class="stat"><span>Seats sold</span><b>${sum.seats_sold}</b><small class="hint">of ${sum.capacity.toLocaleString()} capacity</small></div>
        <div class="stat"><span>Occupancy</span><b>${sum.occupancy_pct}%</b><div class="meter"><i style="width:${Math.min(sum.occupancy_pct, 100)}%"></i></div></div>
        <div class="stat"><span>Cancellations</span><b>${sum.cancelled_reservations}</b></div>
      </div>
      <div class="admin-grid even">
        <div class="panel"><h2>By film</h2><div class="table-wrap"><table>
          <thead><tr><th>Film</th><th>Seats</th><th>Revenue</th></tr></thead>
          <tbody>${byMovie.map((m) => `<tr><td>${esc(m.title)}</td><td class="num">${m.seats_sold}</td><td class="num">${money(m.revenue_cents)}</td></tr>`).join('')
            || '<tr><td colspan="3">No showtimes yet.</td></tr>'}</tbody></table></div></div>
        <div class="panel"><h2>By experience</h2><div class="table-wrap"><table>
          <thead><tr><th>Experience</th><th>Shows</th><th>Seats</th><th>Revenue</th></tr></thead>
          <tbody>${byXp.map((x) => `<tr><td>${xpBadge(x.name, true)}</td><td class="num">${x.showtimes}</td><td class="num">${x.seats_sold}</td><td class="num">${money(x.revenue_cents)}</td></tr>`).join('')}</tbody></table></div></div>
      </div>
      <div class="panel"><h2>Next showtimes</h2><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Film</th><th>Experience</th><th>Hall</th><th>Sold</th></tr></thead>
        <tbody>${upcoming.map((s) => `<tr><td class="num">${fmtDay(s.starts_at)} ${fmtTime(s.starts_at)}</td><td>${esc(s.movie_title)}</td><td>${xpBadge(s.experience, true)}</td><td>${esc(s.hall_name)}</td><td>${occupancy(s.seats_sold, s.capacity, s.occupancy_pct)}</td></tr>`).join('')
          || '<tr><td colspan="5">Nothing scheduled.</td></tr>'}</tbody></table></div></div>
    </div>`;
}

// Sends the raw file bytes; the server checks the image type itself.
async function uploadPoster(movieId, file) {
  const res = await fetch(`/api/movies/${movieId}/poster`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || 'Poster upload failed'), { details: data?.details });
  return data;
}

async function adminMovies(body) {
  const [movies, genres, shows] = await Promise.all([
    api('GET', '/api/movies?limit=100'),
    api('GET', '/api/genres'),
    api('GET', '/api/showtimes?limit=100'),
  ]);
  const editing = movies.data.find((m) => m.id === state.editMovieId) || null;
  const selected = new Set(editing?.genres || []);
  const allGenres = new Set(genres.map((g) => g.name));
  let file = null;
  const upcomingCount = (id) => shows.data.filter((s) => s.movie_id === id).length;
  const linkedPoster = editing?.poster_url?.startsWith('http') ? editing.poster_url : '';

  body.innerHTML = `
    <div class="admin-grid">
      <div style="display:grid;gap:20px;min-width:0">
        <form class="panel form-grid" id="movie-form" novalidate>
          <div class="panel-head"><h2>${editing ? 'Edit film' : 'Add a film'}</h2>
            ${editing ? '<button type="button" class="link-btn" id="cancel-edit">Cancel</button>' : ''}</div>
          <div class="field"><label for="m-title">Title</label><input id="m-title" name="title" required maxlength="200" value="${esc(editing?.title)}"></div>
          <fieldset class="field runtime-field"><legend>Runtime</legend>
            <div class="runtime-inputs">
              <label><input id="m-hours" name="hours" type="number" min="0" max="10" inputmode="numeric" placeholder="0" value="${editing ? Math.floor(editing.duration_min / 60) : ''}"> hr</label>
              <label><input id="m-mins" name="mins" type="number" min="0" max="59" inputmode="numeric" placeholder="0" value="${editing ? editing.duration_min % 60 : ''}"> min</label>
            </div></fieldset>
          <div class="field"><label for="m-new-genre">Genres <span class="hint">pick at least 1</span></label>
            <div class="genre-picker" id="genre-picker"></div>
            <input id="m-new-genre" placeholder="New genre, then press Enter" maxlength="50">
          </div>
          <div class="field"><label for="m-desc">Synopsis</label><textarea id="m-desc" name="description" maxlength="2000" required>${esc(editing?.description)}</textarea></div>
          <div class="field"><label for="m-file">Poster</label>
            <div class="poster-input">
              <div class="poster-preview" id="poster-preview"></div>
              <div class="poster-controls">
                <label class="btn btn-line btn-sm file-btn">Upload image<input type="file" id="m-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden></label>
                <span class="hint">JPEG, PNG, WebP or GIF up to 5 MB. A 2:3 portrait looks best.</span>
                <input id="m-poster" name="poster_url" type="url" placeholder="…or paste an image link" value="${esc(linkedPoster)}">
                ${editing?.poster_url ? '<button type="button" class="link-btn danger-link" id="remove-poster">Remove poster</button>' : ''}
              </div>
            </div>
          </div>
          <div class="form-error" id="m-error"></div>
          <button class="btn btn-gold" type="submit">${editing ? 'Save changes' : 'Add film'}</button>
        </form>
        <div class="panel"><h2>Genres</h2>
          <div class="chips">${genres.map((g) => `<span class="genre-chip">${esc(g.name)} <small>${g.movie_count}</small>
            <button class="chip-x" data-del-genre="${g.id}" aria-label="Delete ${esc(g.name)}">×</button></span>`).join('') || '<span class="hint">No genres yet.</span>'}</div>
        </div>
      </div>
      <div class="panel"><h2>Films (${movies.total})</h2><div class="table-wrap"><table>
        <thead><tr><th></th><th>Title</th><th>Genres</th><th>Runtime</th><th>Shows</th><th>Now Playing</th><th></th></tr></thead>
        <tbody>${movies.data.map((m) => `<tr class="${m.id === state.editMovieId ? 'editing' : ''}">
          <td class="thumb">${poster(m)}</td>
          <td><b>${esc(m.title)}</b></td><td>${esc(m.genres.join(', '))}</td><td class="num">${runtime(m.duration_min)}</td>
          <td class="num">${upcomingCount(m.id)}</td>
          <td><button class="btn btn-sm ${m.now_playing ? 'btn-gold' : 'btn-line'}" data-now="${m.id}" aria-pressed="${!!m.now_playing}">${m.now_playing ? '★ Now Playing' : '+ Now Playing'}</button></td>
          <td class="actions" data-row="${m.id}"><button class="btn btn-line btn-sm" data-edit="${m.id}">Edit</button>
            <button class="btn btn-danger btn-sm" data-del-movie="${m.id}">Delete</button></td></tr>`).join('')
          || '<tr><td colspan="7">No films yet. Add one with the form.</td></tr>'}</tbody></table></div></div>
    </div>`;

  const form = body.querySelector('#movie-form');
  const errorBox = form.querySelector('#m-error');
  let previewUrl = null;
  const preview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = file ? URL.createObjectURL(file) : null;
    const url = previewUrl || form.querySelector('#m-poster').value.trim()
      || (editing?.poster_url?.startsWith('/uploads') ? editing.poster_url : '');
    body.querySelector('#poster-preview').innerHTML = poster({ title: form.querySelector('#m-title').value || 'Your film', genres: [...selected], poster_url: url });
  };
  const drawGenres = () => {
    body.querySelector('#genre-picker').innerHTML = [...allGenres].sort().map((g) =>
      `<button type="button" class="genre-toggle" aria-pressed="${selected.has(g)}" data-g="${esc(g)}">${esc(g)}</button>`).join('');
    body.querySelectorAll('[data-g]').forEach((b) => {
      b.onclick = () => {
        if (selected.has(b.dataset.g)) selected.delete(b.dataset.g);
        else selected.add(b.dataset.g);
        drawGenres();
        preview();
      };
    });
  };
  drawGenres();
  preview();

  form.querySelector('#m-new-genre').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = e.target.value.trim();
    if (!name) return;
    const match = [...allGenres].find((g) => g.toLowerCase() === name.toLowerCase()) || name;
    allGenres.add(match);
    selected.add(match);
    e.target.value = '';
    drawGenres();
    preview();
  };
  form.querySelector('#m-title').oninput = preview;
  form.querySelector('#m-poster').oninput = () => { file = null; preview(); };
  form.querySelector('#m-file').onchange = (e) => {
    file = e.target.files[0] || null;
    errorBox.textContent = '';
    if (file && file.size > 5 * 1024 * 1024) { errorBox.textContent = 'That image is over 5 MB.'; file = null; }
    preview();
  };
  form.querySelector('#cancel-edit')?.addEventListener('click', () => { state.editMovieId = null; renderAdmin(); });
  form.querySelector('#remove-poster')?.addEventListener('click', async () => {
    try { await api('DELETE', `/api/movies/${editing.id}/poster`); toast('Poster removed', 'ok'); renderAdmin(); }
    catch (err) { errorBox.textContent = errorText(err); }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    errorBox.textContent = '';
    const f = Object.fromEntries(new FormData(form));
    if (!selected.size) { errorBox.textContent = 'Pick at least one genre.'; return; }
    if (!editing && !file && !f.poster_url) { errorBox.textContent = 'Add a poster: upload an image or paste a link.'; return; }
    const hours = Number(f.hours || 0), mins = Number(f.mins || 0);
    if (!Number.isInteger(hours) || !Number.isInteger(mins) || hours < 0 || mins < 0 || mins > 59) { errorBox.textContent = 'Runtime: whole hours, and minutes from 0 to 59.'; return; }
    const duration_min = hours * 60 + mins;
    if (duration_min < 1 || duration_min > 600) { errorBox.textContent = 'Runtime must be between 1 minute and 10 hours.'; return; }
    const payload = { title: f.title, description: f.description, duration_min, genres: [...selected] };
    if (f.poster_url && f.poster_url !== linkedPoster) payload.poster_url = f.poster_url;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const saved = editing ? await api('PATCH', `/api/movies/${editing.id}`, payload) : await api('POST', '/api/movies', payload);
      if (file) {
        try { await uploadPoster(saved.id, file); }
        catch (err) { toast(`Film saved, but the poster upload failed: ${errorText(err)}`, 'error'); }
      }
      toast(editing ? `Saved ${saved.title}` : `Added ${saved.title}`, 'ok');
      state.editMovieId = null;
      renderAdmin();
    } catch (err) {
      errorBox.textContent = errorText(err);
      btn.disabled = false;
    }
  };

  body.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => { state.editMovieId = Number(b.dataset.edit); renderAdmin(); scrollTo({ top: 0, behavior: 'smooth' }); };
  });
  body.querySelectorAll('[data-now]').forEach((b) => {
    b.onclick = async () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.disabled = true;
      try { await api('PATCH', `/api/movies/${b.dataset.now}`, { now_playing: on ? 1 : 0 }); toast(on ? 'Added to Now Playing' : 'Removed from Now Playing', 'ok'); }
      catch (err) { toast(errorText(err), 'error'); }
      renderAdmin();
    };
  });
  body.querySelectorAll('[data-del-movie]').forEach((b) => {
    b.onclick = () => {
      const cell = body.querySelector(`[data-row="${b.dataset.delMovie}"]`);
      cell.innerHTML = `<span class="confirm-row">Delete? <button class="btn btn-danger btn-sm" data-yes>Yes</button><button class="btn btn-line btn-sm" data-no>No</button></span>`;
      cell.querySelector('[data-no]').onclick = () => renderAdmin();
      cell.querySelector('[data-yes]').onclick = async () => {
        try { await api('DELETE', `/api/movies/${b.dataset.delMovie}`); toast('Film deleted', 'ok'); }
        catch (err) { toast(errorText(err), 'error'); }
        renderAdmin();
      };
    };
  });
  body.querySelectorAll('[data-del-genre]').forEach((b) => {
    b.onclick = async () => {
      try { await api('DELETE', `/api/genres/${b.dataset.delGenre}`); toast('Genre deleted', 'ok'); renderAdmin(); }
      catch (err) { toast(errorText(err), 'error'); }
    };
  });
}

async function adminReviews(body) {
  const [reviews, movies] = await Promise.all([api('GET', '/api/movies/reviews'), api('GET', '/api/movies?limit=100')]);
  const unreviewed = movies.data.filter((m) => !m.my_rating);
  body.innerHTML = `<div class="stack">
    <div class="panel"><h2>My reviews (${reviews.length})</h2><div class="table-wrap"><table>
      <thead><tr><th>Film</th><th>Rating</th><th>Watched</th><th>Review</th><th></th></tr></thead>
      <tbody>${reviews.map((r) => `<tr>
        <td><b>${esc(r.title)}</b></td><td class="num"><b class="gold">★ ${r.rating}</b>/10</td>
        <td class="num">${r.watched_on ? fmtDay(`${r.watched_on}T12:00:00`) : '—'}</td>
        <td><div class="review-excerpt">${esc(r.body) || '<span class="hint">No write-up</span>'}</div></td>
        <td class="actions"><a class="btn btn-line btn-sm" href="#/movie/${r.movie_id}/review">Edit</a></td></tr>`).join('')
        || '<tr><td colspan="5">No reviews yet. Open a film below to write one.</td></tr>'}</tbody></table></div></div>
    ${unreviewed.length ? `<div class="panel"><h2>Not reviewed yet (${unreviewed.length})</h2>
      <div class="chips">${unreviewed.map((m) => `<a class="genre-chip" href="#/movie/${m.id}/review">${esc(m.title)} <small>+ Review</small></a>`).join('')}</div></div>` : ''}</div>`;
}

const SHOW_COLS = [['when', 'When'], ['film', 'Film'], ['experience', 'Experience'], ['hall', 'Hall'], ['price', 'Price'], ['sold', 'Sold']];

async function adminShowtimes(body) {
  // The API pages at 100; fetch every upcoming show so sorting covers the whole schedule.
  const allShows = async () => {
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const page = await api('GET', `/api/showtimes?limit=100&offset=${offset}`);
      out.push(...page.data);
      if (page.data.length < 100) return { data: out };
    }
  };
  const [movies, halls, shows, experiences] = await Promise.all([
    api('GET', '/api/movies?limit=100'),
    api('GET', '/api/halls'),
    allShows(),
    api('GET', '/api/experiences'),
  ]);
  // Default the picker to tomorrow 7:00 PM local time.
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(19, 0, 0, 0);
  const localValue = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

  body.innerHTML = `
    <div class="admin-grid">
      <form class="panel form-grid" id="show-form">
        <h2>Schedule a showtime</h2>
        <div class="field"><label for="s-movie">Film</label><select id="s-movie" name="movie_id" required>
          ${movies.data.map((m) => `<option value="${m.id}">${esc(m.title)} (${runtime(m.duration_min)})</option>`).join('')}</select></div>
        <div class="two">
          <div class="field"><label for="s-hall">Hall</label><select id="s-hall" name="hall_id" required>
            ${halls.map((h) => `<option value="${h.id}">${esc(h.name)} · ${h.capacity} seats</option>`).join('')}</select></div>
          <div class="field"><label for="s-xp">Experience</label><select id="s-xp" name="experience_id" required>
            ${experiences.map((x) => `<option value="${x.id}" data-surcharge="${x.surcharge_cents}">${esc(x.name)}${x.surcharge_cents ? ` (+${money(x.surcharge_cents)})` : ''}</option>`).join('')}</select></div>
        </div>
        <div class="two">
          <div class="field"><label for="s-start">Starts</label><input id="s-start" name="starts_at" type="datetime-local" value="${localValue}" required></div>
          <div class="field"><label for="s-price">Base price ($)</label><input id="s-price" name="price" type="number" min="0" step="0.01" value="16.50" required></div>
        </div>
        <div class="line total"><span>Ticket price</span><b id="s-total"></b></div>
        <span class="hint">Ticket price is the base price plus the experience surcharge. The end time comes from the film's runtime. Shows must fit inside theatre hours (12:00 PM to midnight), and overlapping shows in the same hall are refused.</span>
        <div class="form-error" id="s-error"></div>
        <button class="btn btn-gold" type="submit" ${movies.data.length && halls.length ? '' : 'disabled'}>Schedule</button>
      </form>
      <div class="panel"><h2>Upcoming showtimes (${shows.data.length})</h2><div class="table-wrap"><table>
        <thead><tr>${SHOW_COLS.map(([k, label]) => `<th data-col="${k}"><button class="th-sort" data-sort="${k}">${label}<i aria-hidden="true"></i></button></th>`).join('')}<th></th></tr></thead>
        <tbody id="show-rows"></tbody></table></div></div>
    </div>`;

  // Click a column header to sort by it; click again to flip ascending/descending. Ties fall back to start time.
  const sorters = {
    when: (s) => s.starts_at, film: (s) => s.movie_title.toLowerCase(), experience: (s) => s.experience.toLowerCase(),
    hall: (s) => s.hall_name.toLowerCase(), price: (s) => s.price_cents, sold: (s) => s.reserved / s.capacity,
  };
  const drawShows = () => {
    const { key, dir } = state.showSort;
    const by = sorters[key];
    const rows = [...shows.data].sort((a, b) => (by(a) < by(b) ? -dir : by(a) > by(b) ? dir : 0) || a.starts_at.localeCompare(b.starts_at));
    body.querySelector('#show-rows').innerHTML = rows.map((s) => {
      const pct = Math.round((s.reserved / s.capacity) * 1000) / 10;
      return `<tr><td class="num">${fmtDay(s.starts_at)}<br>${fmtTime(s.starts_at)}</td><td>${esc(s.movie_title)}</td><td>${xpBadge(s.experience, true)}</td><td>${esc(s.hall_name)}</td>
        <td class="num">${money(s.price_cents)}</td><td>${occupancy(s.reserved, s.capacity, pct)}</td>
        <td class="actions"><button class="btn btn-danger btn-sm" data-del-show="${s.id}" ${s.reserved ? 'disabled title="Has bookings"' : ''}>Delete</button></td></tr>`;
    }).join('') || '<tr><td colspan="7">Nothing scheduled.</td></tr>';
    body.querySelectorAll('th[data-col]').forEach((th) => {
      th.setAttribute('aria-sort', th.dataset.col === key ? (dir > 0 ? 'ascending' : 'descending') : 'none');
    });
    body.querySelectorAll('[data-del-show]').forEach((b) => {
      b.onclick = async () => {
        try { await api('DELETE', `/api/showtimes/${b.dataset.delShow}`); toast('Showtime removed', 'ok'); renderAdmin(); }
        catch (err) { toast(errorText(err), 'error'); }
      };
    });
  };
  body.querySelectorAll('[data-sort]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.sort;
      state.showSort = { key: k, dir: state.showSort.key === k ? -state.showSort.dir : 1 };
      drawShows();
    };
  });
  drawShows();

  const form = body.querySelector('#show-form');
  const ticketCents = () => Math.round(Number(form.querySelector('#s-price').value) * 100)
    + Number(form.querySelector('#s-xp').selectedOptions[0]?.dataset.surcharge || 0);
  const syncTotal = () => { form.querySelector('#s-total').textContent = money(ticketCents()); };
  form.querySelector('#s-price').oninput = syncTotal;
  form.querySelector('#s-xp').onchange = syncTotal;
  syncTotal();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      await api('POST', '/api/showtimes', {
        movie_id: Number(f.movie_id),
        hall_id: Number(f.hall_id),
        experience_id: Number(f.experience_id),
        starts_at: new Date(f.starts_at).toISOString(),
        price_cents: ticketCents(),
      });
      toast('Showtime scheduled', 'ok');
      renderAdmin();
    } catch (err) {
      // An overlap conflict returns the clashing showtime as details.
      const clash = err.details?.starts_at ? ` (clashes with the ${fmtTime(err.details.starts_at)} show)` : '';
      form.querySelector('#s-error').textContent = (Array.isArray(err.details) ? errorText(err) : err.message) + clash;
    }
  };
}

async function adminExperiences(body) {
  const list = await api('GET', '/api/experiences');
  const editing = list.find((x) => x.id === state.editXpId) || null;
  body.innerHTML = `
    <div class="admin-grid">
      <form class="panel form-grid" id="xp-form">
        <div class="panel-head"><h2>${editing ? 'Edit experience' : 'Add an experience'}</h2>
          ${editing ? '<button type="button" class="link-btn" id="xp-cancel">Cancel</button>' : ''}</div>
        <div class="field"><label for="x-name">Name</label><input id="x-name" name="name" required maxlength="40" placeholder="e.g. Dolby Cinema" value="${esc(editing?.name)}"></div>
        <div class="field"><label for="x-desc">What makes it special</label><textarea id="x-desc" name="description" maxlength="300">${esc(editing?.description)}</textarea></div>
        <div class="field"><label for="x-age">Minimum age (0 = all ages)</label><input id="x-age" name="min_age" type="number" min="0" max="21" value="${editing?.min_age ?? 0}"></div>
        <div class="field"><label for="x-sur">Surcharge per ticket ($)</label><input id="x-sur" name="surcharge" type="number" min="0" step="0.01" value="${((editing?.surcharge_cents ?? 0) / 100).toFixed(2)}"></div>
        <span class="hint">Changing a surcharge only affects showtimes you schedule afterwards.</span>
        <div class="form-error" id="x-error"></div>
        <button class="btn btn-gold" type="submit">${editing ? 'Save changes' : 'Add experience'}</button>
      </form>
      <div class="xp-grid">${list.map((x) => `
        <article class="xp-card ${x.id === state.editXpId ? 'editing' : ''}">
          <div class="xp-card-top">${xpBadge(x.name, true)}<b>${x.surcharge_cents ? `+${money(x.surcharge_cents)}` : 'No surcharge'}</b></div>
          <p>${esc(x.description || 'No description yet.')}</p>
          <div class="xp-card-foot"><span class="hint">${x.upcoming_showtimes} upcoming show${x.upcoming_showtimes === 1 ? '' : 's'}</span>
            <span><button class="btn btn-line btn-sm" data-xedit="${x.id}">Edit</button>
            <button class="btn btn-danger btn-sm" data-xdel="${x.id}">Delete</button></span></div>
        </article>`).join('')}</div>
    </div>`;

  const form = body.querySelector('#xp-form');
  form.querySelector('#xp-cancel')?.addEventListener('click', () => { state.editXpId = null; renderAdmin(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const payload = { name: f.name, description: f.description, min_age: Number(f.min_age || 0), surcharge_cents: Math.round(Number(f.surcharge || 0) * 100) };
    try {
      const x = editing ? await api('PATCH', `/api/experiences/${editing.id}`, payload) : await api('POST', '/api/experiences', payload);
      toast(`${editing ? 'Saved' : 'Added'} ${x.name}`, 'ok');
      state.editXpId = null;
      renderAdmin();
    } catch (err) { form.querySelector('#x-error').textContent = errorText(err); }
  };
  body.querySelectorAll('[data-xedit]').forEach((b) => { b.onclick = () => { state.editXpId = Number(b.dataset.xedit); renderAdmin(); }; });
  body.querySelectorAll('[data-xdel]').forEach((b) => {
    b.onclick = async () => {
      try { await api('DELETE', `/api/experiences/${b.dataset.xdel}`); toast('Experience deleted', 'ok'); renderAdmin(); }
      catch (err) { toast(errorText(err), 'error'); }
    };
  });
}

const timeAgo = (iso) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return fmtDay(iso);
};

async function adminReservations(body) {
  const f = state.resFilter ||= { q: '', status: '', when: 'upcoming', movieId: '', offset: 0 };
  const PAGE = 50;
  const qs = new URLSearchParams({ limit: PAGE, offset: f.offset });
  if (f.q) qs.set('q', f.q);
  if (f.status) qs.set('status', f.status);
  if (f.when === 'upcoming') qs.set('upcoming', 'true');
  if (f.movieId) qs.set('movieId', f.movieId);
  const [res, movies, sum] = await Promise.all([
    api('GET', `/api/admin/reservations?${qs}`),
    api('GET', '/api/movies?limit=100'),
    api('GET', '/api/admin/reports/summary'),
  ]);
  const now = new Date().toISOString();

  body.innerHTML = `
    <div style="display:grid;gap:20px">
      <div class="stats">
        <div class="stat"><span>Capacity</span><b>${sum.capacity.toLocaleString()}</b><small class="hint">seats across ${sum.showtimes} showtimes</small></div>
        <div class="stat"><span>Seats sold</span><b>${sum.seats_sold.toLocaleString()}</b><div class="meter"><i style="width:${Math.min(sum.occupancy_pct, 100)}%"></i></div></div>
        <div class="stat"><span>Seats left</span><b>${(sum.capacity - sum.seats_sold).toLocaleString()}</b></div>
        <div class="stat"><span>Revenue</span><b class="gold">${money(sum.revenue_cents)}</b></div>
      </div>
      <form class="panel filters" id="res-filters">
        <div class="field grow"><label for="rf-q">Search</label><input id="rf-q" name="q" placeholder="Customer name, email or film" value="${esc(f.q)}"></div>
        <div class="field"><label for="rf-movie">Film</label><select id="rf-movie" name="movieId"><option value="">All films</option>
          ${movies.data.map((m) => `<option value="${m.id}" ${String(m.id) === f.movieId ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select></div>
        <div class="field"><label for="rf-status">Status</label><select id="rf-status" name="status">
          <option value="">Any</option><option value="confirmed" ${f.status === 'confirmed' ? 'selected' : ''}>Confirmed</option>
          <option value="cancelled" ${f.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select></div>
        <div class="field"><label for="rf-when">Showtimes</label><select id="rf-when" name="when">
          <option value="upcoming" ${f.when === 'upcoming' ? 'selected' : ''}>Upcoming</option><option value="all" ${f.when === 'all' ? 'selected' : ''}>All</option></select></div>
        <button class="btn btn-gold" type="submit">Apply</button>
      </form>
      <div class="panel">
        <div class="panel-head"><h2>Reservations</h2>
          <span class="hint"><b>${res.total.toLocaleString()}</b> bookings · <b>${res.seats.toLocaleString()}</b> seats · <b class="gold">${money(res.revenue_cents)}</b> confirmed revenue</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Booked</th><th>Customer</th><th>Film</th><th>Showtime</th><th>Seats</th><th>Total</th><th>Status</th><th></th></tr></thead>
          <tbody>${res.data.map((r) => {
            const simulated = r.user_email === 'simulated-guests@nguyenawards.local';
            const canCancel = r.status === 'confirmed' && r.starts_at > now;
            return `<tr>
              <td class="num">${r.id}</td>
              <td class="num">${timeAgo(r.created_at)}</td>
              <td>${simulated ? '<span class="sim-tag">Simulated</span>' : `<b>${esc(r.user_name)}</b><br><span class="hint">${esc(r.user_email)}</span>`}</td>
              <td>${esc(r.movie_title)}<br>${xpBadge(r.experience, true)}</td>
              <td class="num">${fmtDay(r.starts_at)} ${fmtTime(r.starts_at)}<br><span class="hint">${esc(r.hall_name)}</span></td>
              <td><div class="chips">${r.seats.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div></td>
              <td class="num">${money(r.total_cents)}</td>
              <td><span class="status ${r.status === 'cancelled' ? 'cancelled' : r.starts_at <= now ? 'past' : 'confirmed'}">${r.status === 'cancelled' ? 'Cancelled' : r.starts_at <= now ? 'Past' : 'Confirmed'}</span></td>
              <td class="actions" data-res="${r.id}">${canCancel ? `<button class="btn btn-danger btn-sm" data-cancel-res="${r.id}">Cancel</button>` : ''}</td>
            </tr>`;
          }).join('') || '<tr><td colspan="9">No reservations match these filters.</td></tr>'}</tbody></table></div>
        ${res.total > PAGE ? `<div class="pager">
          <button class="btn btn-line btn-sm" id="pg-prev" ${f.offset ? '' : 'disabled'}>← Newer</button>
          <span class="hint">${f.offset + 1}–${Math.min(f.offset + PAGE, res.total)} of ${res.total}</span>
          <button class="btn btn-line btn-sm" id="pg-next" ${f.offset + PAGE < res.total ? '' : 'disabled'}>Older →</button></div>` : ''}
      </div>
    </div>`;

  body.querySelector('#res-filters').onsubmit = (e) => {
    e.preventDefault();
    Object.assign(f, Object.fromEntries(new FormData(e.target)), { offset: 0 });
    renderAdmin();
  };
  body.querySelector('#pg-prev')?.addEventListener('click', () => { f.offset = Math.max(0, f.offset - PAGE); renderAdmin(); });
  body.querySelector('#pg-next')?.addEventListener('click', () => { f.offset += PAGE; renderAdmin(); });
  body.querySelectorAll('[data-cancel-res]').forEach((b) => {
    b.onclick = () => {
      const cell = body.querySelector(`[data-res="${b.dataset.cancelRes}"]`);
      cell.innerHTML = `<span class="confirm-row">Cancel? <button class="btn btn-danger btn-sm" data-yes>Yes</button><button class="btn btn-line btn-sm" data-no>No</button></span>`;
      cell.querySelector('[data-no]').onclick = () => renderAdmin();
      cell.querySelector('[data-yes]').onclick = async () => {
        try { await api('DELETE', `/api/reservations/${b.dataset.cancelRes}`); toast(`Reservation #${b.dataset.cancelRes} cancelled and seats released`, 'ok'); }
        catch (err) { toast(errorText(err), 'error'); }
        renderAdmin();
      };
    };
  });
}

async function adminUsers(body) {
  const users = await api('GET', '/api/admin/users?limit=100');
  body.innerHTML = `
    <div class="panel"><h2>Members (${users.data.length})</h2><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th></th></tr></thead>
      <tbody>${users.data.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td>
        <td>${u.role === 'admin' ? '<span class="role-tag">Admin</span>' : 'Member'}</td><td class="num">${fmtDay(u.created_at)}</td>
        <td class="actions">${u.id === state.user.id ? '<span class="hint">You</span>'
          : `<button class="btn btn-line btn-sm" data-role="${u.role === 'admin' ? 'user' : 'admin'}" data-uid="${u.id}">${u.role === 'admin' ? 'Make member' : 'Make admin'}</button>`}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  body.querySelectorAll('[data-uid]').forEach((b) => {
    b.onclick = async () => {
      try {
        const u = await api('PATCH', `/api/admin/users/${b.dataset.uid}/role`, { role: b.dataset.role });
        toast(`${u.name} is now ${u.role === 'admin' ? 'an admin' : 'a member'}`, 'ok');
        renderAdmin();
      } catch (err) { toast(errorText(err), 'error'); }
    };
  });
}

// ---------- router ----------

async function render() {
  clearInterval(liveTimer);
  const [, route, id, sub] = location.hash.split('/');
  renderNav();
  // Old seat-page links go to the booking flow.
  if (route === 'showtime' && id) return location.replace(`#/book/${id}`);
  // "Get Tickets" on the movie page that's already open just scrolls down to the showtimes.
  if (route === 'movie' && sub === 'tickets' && state.moviePage === id && view.querySelector('#tickets')) {
    return view.querySelector('#tickets').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  closeModal();
  view.innerHTML = spinner();
  scrollTo(0, 0);
  state.moviePage = null;
  try {
    if (route === 'movie' && id) { await renderMovie(id, sub); state.moviePage = id; }
    else if (route === 'book' && id) await renderBooking(id);
    else if (route === 'schedule') await renderSchedule(id);
    else if (route === 'tickets') await renderTickets();
    else if (route === 'genre' && id) {
      // Genre tags on movie pages land on the home page's browse section with that genre picked.
      try { state.browseGenre = decodeURIComponent(id); } catch { state.browseGenre = 'All'; }
      await renderHome();
      view.querySelector('.browse')?.scrollIntoView({ block: 'start' });
    }
    else if (route === 'admin') {
      if (['overview', 'reservations', 'movies', 'showtimes', 'experiences', 'reviews', 'users'].includes(id)) state.adminTab = id;
      await renderAdmin();
    }
    else await renderHome();
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="empty"><strong>Something went wrong</strong>${esc(errorText(err))}<a class="btn btn-gold" href="#/">Back to films</a></div></div>`;
  }
}

window.addEventListener('hashchange', render);
await loadUser();
render();
