'use strict';

/* =========================================================
   Music Rater — rate albums and every track on them.
   Data: MusicBrainz (search + tracklists), Cover Art Archive (artwork).
   Storage: localStorage in this browser (export/import as JSON).
   ========================================================= */

const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';
const STORE_KEY = 'musicrater.v1';
const CFG = window.MUSIC_RATER_CONFIG || {};

const view = document.getElementById('view');

/* ---------------- storage ---------------- */

let db = loadDb();
function loadDb() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (_) { /* ignore */ }
  if (!d || !d.albums) d = { version: 1, albums: {} };
  d.deleted = d.deleted || {};      // album id → time removed (so removals sync too)
  return d;
}
function saveDb() { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }

const drafts = new Map();          // albums being viewed but not yet saved
function getAlbum(id) { return db.albums[id] || drafts.get(id); }
function isSaved(id) { return !!db.albums[id]; }

function commit(album) {
  const now = new Date().toISOString();
  album.updatedAt = now;
  if (!album.addedAt) album.addedAt = now;
  if (!album.status) album.status = 'listened';
  if (album.status === 'listened' && !album.listenedOn) album.listenedOn = today();
  db.albums[album.id] = album;
  delete db.deleted[album.id];
  drafts.delete(album.id);
  saveDb();
  Sync.queue(album.id);
}

function removeAlbum(id) {
  delete db.albums[id];
  db.deleted[id] = new Date().toISOString();
  saveDb();
  Sync.queue(id);
}

/* ---------------- helpers ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const credit = ac => (ac || []).map(a => a.name + (a.joinphrase || '')).join('') || 'Unknown artist';
const fmtLen = ms => {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtRating = v => v ? (Number.isInteger(v) ? v.toFixed(1) : String(v)) : '–';
const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

const loadingHtml = msg => `<div class="loading"><div class="spinner"></div>${esc(msg)}</div>`;
const errorHtml = (msg, retry) =>
  `<div class="error">${esc(msg)}${retry ? `<div style="margin-top:14px"><button class="btn" id="retryBtn">Try again</button></div>` : ''}</div>`;

/* ---------------- MusicBrainz (rate limited: ~1 req/sec) ---------------- */

const mbCache = new Map();
let mbChain = Promise.resolve();
let mbLast = 0;

function mb(path) {
  if (mbCache.has(path)) return mbCache.get(path);
  const run = mbChain.then(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = mbLast + 1250 - Date.now();
      if (wait > 0) await sleep(wait);
      mbLast = Date.now();
      let res;
      try {
        res = await fetch(`${MB}${path}${path.includes('?') ? '&' : '?'}fmt=json`, {
          headers: { Accept: 'application/json' }
        });
      } catch (e) {
        if (attempt >= 2) throw new Error('Could not reach MusicBrainz. Check your internet connection.');
        await sleep(1500);
        continue;
      }
      // MusicBrainz answers 503 when it's rate limiting — back off and retry.
      if (res.status === 503 || res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`MusicBrainz returned an error (${res.status}).`);
      return res.json();
    }
    throw new Error('MusicBrainz is busy right now. Try again in a moment.');
  });
  mbChain = run.catch(() => {});
  mbCache.set(path, run);
  run.catch(() => mbCache.delete(path));
  return run;
}

/* Escape Lucene special characters so user text is searched literally. */
const lucene = s => s.trim().replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
const phrase = s => s.trim().replace(/["\\]/g, '\\$&');

/* Album search, optionally narrowed to an artist name. */
async function searchAlbums(artist, album) {
  const parts = [];
  if (album) parts.push(`(releasegroup:"${phrase(album)}"^3 OR releasegroup:(${lucene(album)}))`);
  if (artist) parts.push(`(artist:"${phrase(artist)}"^3 OR artistname:"${phrase(artist)}" OR artist:(${lucene(artist)}))`);
  const data = await mb(`/release-group?query=${encodeURIComponent(parts.join(' AND '))}&limit=60`);
  return mapGroups(data['release-groups'] || []);
}

/* Artist search by name. */
async function searchArtists(name) {
  const q = `artist:"${phrase(name)}"^3 OR alias:"${phrase(name)}" OR artist:(${lucene(name)})`;
  const data = await mb(`/artist?query=${encodeURIComponent(q)}&limit=12`);
  return (data.artists || []).map(a => ({
    id: a.id,
    name: a.name,
    disambiguation: a.disambiguation || '',
    type: a.type || '',
    country: a.country || (a.area && a.area.name) || '',
    begin: (a['life-span'] && a['life-span'].begin || '').slice(0, 4),
    score: a.score || 0
  }));
}

/* Everything an artist has released (albums, EPs, singles…). */
async function getDiscography(artistId) {
  const [artist, data] = await Promise.all([
    mb(`/artist/${artistId}`),
    mb(`/release-group?artist=${artistId}&type=album%7Cep&inc=artist-credits&limit=100`)
  ]);
  return { artist, groups: mapGroups(data['release-groups'] || []) };
}

function mapGroups(groups) {
  return groups.map(g => ({
    id: g.id,
    title: g.title,
    artist: credit(g['artist-credit']),
    date: g['first-release-date'] || '',
    year: (g['first-release-date'] || '').slice(0, 4),
    type: g['primary-type'] || 'Other',
    secondary: g['secondary-types'] || [],
    score: g.score || 0
  }));
}

/* All editions (releases) of an album, best first. Lightweight: no tracklists. */
async function getReleases(rgId) {
  const data = await mb(`/release?release-group=${rgId}&inc=media+artist-credits+release-groups&limit=100`);
  let rels = (data.releases || []).filter(r => (r.media || []).some(m => m['track-count']));
  const official = rels.filter(r => r.status === 'Official');
  if (official.length) rels = official;
  const fmtScore = r => {
    const f = (r.media || []).map(m => m.format || '');
    if (f.every(x => x === 'Digital Media')) return 0;
    if (f.every(x => x === 'CD')) return 1;
    return 2;
  };
  return rels.sort((a, b) =>
    fmtScore(a) - fmtScore(b) ||
    (a.date || '9999').localeCompare(b.date || '9999'));
}

function releaseLabel(r) {
  const formats = [...new Set((r.media || []).map(m => m.format || 'Unknown'))].join(' + ');
  const n = (r.media || []).reduce((s, m) => s + (m['track-count'] || 0), 0);
  return [r.date || 'Unknown date', r.country, formats, `${n} tracks`, r.disambiguation]
    .filter(Boolean).join(' · ');
}

async function getTracks(releaseId) {
  return buildTracks(await mb(`/release/${releaseId}?inc=recordings`));
}

function buildTracks(release) {
  const multi = (release.media || []).length > 1;
  const out = [];
  (release.media || []).forEach((m, i) => {
    (m.tracks || []).forEach(t => {
      out.push({
        id: (t.recording && t.recording.id) || t.id,   // recording id → ratings survive edition changes
        number: t.number || String(t.position),
        disc: multi ? i + 1 : 0,
        discTitle: m.title || '',
        title: t.title,
        length: t.length || (t.recording && t.recording.length) || 0
      });
    });
  });
  return out;
}

/* ---------------- cover art ---------------- */

function coverHtml(a, size = 250) {
  const fallback = a.releaseId ? `${CAA}/release/${a.releaseId}/front-${size}` : '';
  return `<div class="cover">
    <img loading="lazy" alt="" src="${CAA}/release-group/${a.id}/front-${size}"
         data-fallback="${fallback}" data-ph="${esc(a.title)}" onerror="coverFail(this)">
  </div>`;
}
window.coverFail = img => {
  const fb = img.dataset.fallback;
  if (fb) { img.dataset.fallback = ''; img.src = fb; return; }
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.textContent = img.dataset.ph || '♪';
  img.replaceWith(ph);
};

/* ---------------- star rating widget ---------------- */

function stars(value, { size = '', onChange } = {}) {
  const el = document.createElement('span');
  el.className = `stars ${size}${onChange ? ' editable' : ''}`;
  el.innerHTML = '<span class="base">★★★★★</span><span class="fill">★★★★★</span>';
  const fill = el.querySelector('.fill');
  const show = v => { fill.style.width = `${(v / 5) * 100}%`; };
  const label = () => el.setAttribute('aria-valuenow', value);
  show(value);
  if (!onChange) { el.setAttribute('aria-label', `${value} out of 5 stars`); return el; }

  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-valuemin', 0);
  el.setAttribute('aria-valuemax', 5);
  el.title = 'Click to rate (click again to clear)';
  label();
  const valAt = e => {
    const r = el.getBoundingClientRect();
    return Math.min(5, Math.max(0.5, Math.ceil(((e.clientX - r.left) / r.width) * 10) / 2));
  };
  const set = v => { value = v; show(v); label(); onChange(v); };
  el.addEventListener('mousemove', e => { el.classList.add('hover'); show(valAt(e)); });
  el.addEventListener('mouseleave', () => { el.classList.remove('hover'); show(value); });
  el.addEventListener('click', e => { const v = valAt(e); set(v === value ? 0 : v); });
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); set(Math.min(5, value + 0.5)); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); set(Math.max(0, value - 0.5)); }
    else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { e.preventDefault(); set(0); }
  });
  return el;
}

/* ---------------- router ---------------- */

let routeToken = 0;
function route(opts = {}) {
  const token = ++routeToken;
  let raw = location.hash.slice(1) || '/';
  // Email-confirmation links land with "#access_token=…" — Supabase reads that; show the library.
  if (/^(access_token|error|refresh_token)=/.test(raw)) raw = '/';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(qs || '');
  document.getElementById('menuPop').hidden = true;
  if (!opts.keepScroll) window.scrollTo(0, 0);

  if (parts[0] === 'spotify-callback') {
    view.innerHTML = loadingHtml('Connecting Spotify…');
    Spotify.finishLogin(params)
      .then(back => { toast('Spotify connected'); renderAccountMenu(); location.replace(back); })
      .catch(e => { toast(e.message); location.replace('#/'); });
    return;
  }

  const tab = parts.length === 0 ? (params.get('tab') === 'want' ? 'want' : 'listened') : '';
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === tab));

  if (parts[0] === 'search') {
    const artist = params.get('artist') || '';
    const album = params.get('album') || params.get('q') || '';
    document.getElementById('artistInput').value = artist;
    document.getElementById('albumInput').value = album;
    renderSearch(artist, album, token);
  } else if (parts[0] === 'artist' && parts[1]) {
    renderArtist(parts[1], token);
  } else if (parts[0] === 'album' && parts[1]) {
    renderAlbum(parts[1], token);
  } else {
    renderLibrary(tab, params);
  }
}
window.addEventListener('hashchange', route);

/* ---------------- library ---------------- */

function renderLibrary(tab, params) {
  const all = Object.values(db.albums);
  const sort = params.get('sort') || 'recent';
  const filter = (params.get('f') || '').toLowerCase();
  let list = all.filter(a => (a.status || 'listened') === tab);
  if (filter) list = list.filter(a => (a.title + ' ' + a.artist).toLowerCase().includes(filter));

  const sorters = {
    recent: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0) || (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    listened: (a, b) => (b.listenedOn || '').localeCompare(a.listenedOn || ''),
    title: (a, b) => a.title.localeCompare(b.title),
    artist: (a, b) => a.artist.localeCompare(b.artist) || (a.year || '').localeCompare(b.year || ''),
    year: (a, b) => (b.year || '').localeCompare(a.year || '')
  };
  list.sort(sorters[sort] || sorters.recent);

  const listened = all.filter(a => (a.status || 'listened') === 'listened');
  const rated = listened.filter(a => a.rating);
  const tracksRated = all.reduce((n, a) => n + Object.values(a.trackRatings || {}).filter(Boolean).length, 0);
  const dist = Array.from({ length: 10 }, (_, i) => rated.filter(a => a.rating === (i + 1) / 2).length);
  const maxD = Math.max(1, ...dist);

  const statsHtml = tab === 'listened' && all.length ? `
    <section class="stats">
      <div class="stat"><div class="n">${listened.length}</div><div class="l">Albums logged</div></div>
      <div class="stat"><div class="n">${tracksRated}</div><div class="l">Tracks rated</div></div>
      <div class="stat"><div class="n">${rated.length ? avg(rated.map(a => a.rating)).toFixed(2) : '–'}</div><div class="l">Avg rating</div></div>
      <div class="dist-wrap" title="Your rating distribution">
        <div class="dist">${dist.map((d, i) =>
          `<div class="bar" style="height:${(d / maxD) * 100}%" title="${(i + 1) / 2}★ — ${d} album${d === 1 ? '' : 's'}"></div>`).join('')}</div>
        <div class="dist-labels"><span>½★</span><span>5★</span></div>
      </div>
    </section>` : '';

  const opt = (v, l) => `<option value="${v}"${sort === v ? ' selected' : ''}>${l}</option>`;
  view.innerHTML = `
    <div class="page-head">
      <h1>${tab === 'want' ? 'Want to listen' : 'Your library'}</h1>
      <div class="toolbar">
        <input class="field" id="libFilter" type="search" placeholder="Filter…" value="${esc(params.get('f') || '')}">
        <select id="libSort" aria-label="Sort">
          ${opt('recent', 'Recently updated')}${opt('rating', 'Highest rated')}${opt('listened', 'Date listened')}
          ${opt('artist', 'Artist')}${opt('title', 'Title')}${opt('year', 'Release year')}
        </select>
      </div>
    </div>
    ${statsHtml}
    ${list.length ? `<div class="grid">${list.map(libraryCard).join('')}</div>` : `
      <div class="empty">
        ${filter ? 'Nothing matches that filter.' : tab === 'want'
          ? 'Nothing here yet. Open any album and hit “Want to listen”.'
          : 'Your library is empty.<br>Search for an album above, then rate it and its tracks.'}
      </div>`}
  `;

  const update = (k, v) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    if (tab === 'want') p.set('tab', 'want');
    history.replaceState(null, '', '#/?' + p.toString());
    renderLibrary(tab, p);
  };
  document.getElementById('libSort').onchange = e => update('sort', e.target.value);
  const f = document.getElementById('libFilter');
  f.oninput = () => { clearTimeout(f._t); f._t = setTimeout(() => update('f', f.value.trim()), 250); };
  if (filter) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }

  view.querySelectorAll('[data-stars]').forEach(s =>
    s.replaceWith(stars(Number(s.dataset.stars), { size: 'xs' })));
}

function libraryCard(a) {
  const trackCount = Object.values(a.trackRatings || {}).filter(Boolean).length;
  return `<a class="card" href="#/album/${a.id}">
    ${coverHtml(a)}
    <div class="t">${esc(a.title)}</div>
    <div class="a">${esc(a.artist)}</div>
    <div class="meta">
      ${a.rating ? `<span data-stars="${a.rating}"></span>` : ''}
      ${trackCount ? `<span title="Tracks rated">${trackCount}/${a.tracks.length} tracks</span>` : ''}
    </div>
  </a>`;
}

/* ---------------- search ---------------- */

async function renderSearch(artist, album, token) {
  artist = artist.trim(); album = album.trim();
  if (!artist && !album) {
    view.innerHTML = '<div class="empty">Type an artist, an album, or both in the search boxes above.</div>';
    return;
  }
  const what = [artist, album].filter(Boolean).join(' — ');
  view.innerHTML = loadingHtml(`Searching for “${what}”…`);
  let artists = [], albums = [];
  try {
    if (album) albums = await searchAlbums(artist, album);
    else artists = await searchArtists(artist);
  } catch (e) {
    if (token !== routeToken) return;
    view.innerHTML = errorHtml(e.message, true);
    document.getElementById('retryBtn').onclick = route;
    return;
  }
  if (token !== routeToken) return;

  // Artist-only search: list matching artists → their discography.
  if (!album) {
    view.innerHTML = `
      <div class="page-head"><h1>Artists matching “${esc(artist)}”</h1></div>
      ${artists.length
        ? `<div class="artists">${artists.map(artistCard).join('')}</div>`
        : '<div class="empty">No artists found with that name.</div>'}`;
    return;
  }

  const head = artist
    ? `Albums matching “${esc(album)}” by “${esc(artist)}”`
    : `Albums matching “${esc(album)}”`;
  drawAlbumGrid(head, albums,
    'No albums found. Check the spelling, or try just the artist to browse their discography.');
}

/* Grid of albums with the "include singles etc." toggle. */
function drawAlbumGrid(headHtml, results, emptyMsg, extraHtml = '', toggle = true) {
  const all = !toggle || sessionStorage.getItem('mr.showAll') === '1';
  const list = all ? results : results.filter(r => ['Album', 'EP'].includes(r.type));
  const hidden = results.length - list.length;
  view.innerHTML = `
    <div class="page-head"><h1>${headHtml}</h1></div>
    ${extraHtml}
    ${toggle ? `<div class="filters">
      <label><input type="checkbox" id="showAll" ${all ? 'checked' : ''}>
        Include singles, broadcasts &amp; other releases${!all && hidden ? ` (${hidden} hidden)` : ''}</label>
    </div>` : ''}
    ${list.length ? `<div class="grid">${list.map(searchCard).join('')}</div>`
      : `<div class="empty">${hidden ? 'Only singles or other releases found — tick the box above to see them.' : esc(emptyMsg)}</div>`}
  `;
  if (toggle) document.getElementById('showAll').onchange = e => {
    sessionStorage.setItem('mr.showAll', e.target.checked ? '1' : '0');
    drawAlbumGrid(headHtml, results, emptyMsg, extraHtml);
  };
}

function artistCard(a) {
  const info = [a.disambiguation, a.type, a.country, a.begin && `since ${a.begin}`].filter(Boolean).join(' · ');
  return `<a class="artist-card" href="#/artist/${a.id}">
    <div class="av">${esc((a.name || '?').charAt(0).toUpperCase())}</div>
    <div><div class="nm">${esc(a.name)}</div><div class="ds">${esc(info || 'Artist')}</div></div>
  </a>`;
}

/* ---------------- artist page (discography) ---------------- */

async function renderArtist(id, token) {
  view.innerHTML = loadingHtml('Loading discography…');
  let res;
  try {
    res = await getDiscography(id);
  } catch (e) {
    if (token !== routeToken) return;
    view.innerHTML = errorHtml(e.message, true);
    document.getElementById('retryBtn').onclick = route;
    return;
  }
  if (token !== routeToken) return;
  const { artist, groups } = res;
  groups.sort((a, b) => (b.date || '0').localeCompare(a.date || '0'));
  const info = [artist.disambiguation, artist.type, artist.country].filter(Boolean).join(' · ');
  drawAlbumGrid(esc(artist.name), groups, 'MusicBrainz has no releases listed for this artist yet.',
    `<div class="muted" style="margin:-14px 0 18px">${esc(info)}</div>`, false);
}

function searchCard(r) {
  const saved = db.albums[r.id];
  const tags = [r.type, ...r.secondary].filter(t => t !== 'Album');
  return `<a class="card" href="#/album/${r.id}">
    <div style="position:relative">${coverHtml(r)}
      ${saved ? `<span class="saved-dot">${saved.rating ? '★ ' + fmtRating(saved.rating) : saved.status === 'want' ? 'Want' : 'Logged'}</span>` : ''}
    </div>
    <div class="t">${esc(r.title)}</div>
    <div class="a">${esc(r.artist)}</div>
    <div class="meta">${r.year ? esc(r.year) : ''} ${tags.map(t => `<span class="badge">${esc(t)}</span>`).join(' ')}</div>
  </a>`;
}

/* ---------------- album page ---------------- */

async function renderAlbum(id, token) {
  let album = getAlbum(id);
  let releases = null;

  if (!album) {
    view.innerHTML = loadingHtml('Loading album, artwork and tracklist…');
    try {
      const rels = await getReleases(id);
      if (!rels.length) throw new Error('MusicBrainz has no tracklist for this album yet.');
      releases = rels;
      const best = rels[0];
      const rg = best['release-group'] || { title: best.title };
      const tracks = await getTracks(best.id);
      album = {
        id,
        title: rg.title,
        artist: credit(rg['artist-credit'] || best['artist-credit']),
        artistId: ((best['artist-credit'] || [])[0] || {}).artist?.id || '',
        date: rg['first-release-date'] || '',
        year: (rg['first-release-date'] || '').slice(0, 4),
        type: rg['primary-type'] || '',
        secondary: rg['secondary-types'] || [],
        releaseId: best.id,
        tracks,
        rating: 0,
        review: '',
        listenedOn: '',
        status: null,
        trackRatings: {},
        favTracks: {}
      };
      drafts.set(id, album);
    } catch (e) {
      if (token !== routeToken) return;
      view.innerHTML = errorHtml(e.message, true);
      document.getElementById('retryBtn').onclick = route;
      return;
    }
    if (token !== routeToken) return;
  }

  drawAlbum(album);

  // Load editions for the "edition" picker (in the background for saved albums).
  const sel = document.getElementById('editionSel');
  const fill = rels => {
    if (token !== routeToken) return;
    sel.innerHTML = rels.map(r =>
      `<option value="${r.id}"${r.id === album.releaseId ? ' selected' : ''}>${esc(releaseLabel(r))}</option>`).join('');
    if (!rels.some(r => r.id === album.releaseId)) {
      sel.insertAdjacentHTML('afterbegin', `<option value="${album.releaseId}" selected>Current edition</option>`);
    }
    sel.disabled = rels.length < 2;
    sel.onchange = async () => {
      const r = rels.find(x => x.id === sel.value);
      if (!r) return;
      sel.disabled = true;
      try {
        const tracks = await getTracks(r.id);
        album.releaseId = r.id;
        album.tracks = tracks;
        if (isSaved(album.id)) commit(album);
        drawTracks(album);
        toast('Tracklist updated');
      } catch (e) {
        toast(e.message);
        sel.value = album.releaseId;
      }
      sel.disabled = false;
    };
  };
  if (releases) fill(releases);
  else getReleases(id).then(fill).catch(() => { sel.innerHTML = '<option>Couldn’t load editions</option>'; });
}

function drawAlbum(a) {
  const tags = [a.type, ...(a.secondary || [])].filter(Boolean);
  const totalMs = a.tracks.reduce((s, t) => s + (t.length || 0), 0);
  view.innerHTML = `
    <div class="album">
      <div class="side">
        ${coverHtml(a, 500)}
        <div class="edition">
          <span>Edition</span>
          <select id="editionSel" disabled><option>Loading editions…</option></select>
        </div>
      </div>
      <div>
        <div class="dim" style="font-size:13px">${tags.map(t => `<span class="badge">${esc(t)}</span>`).join(' ')}</div>
        <h1>${esc(a.title)}</h1>
        <div class="artist">${a.artistId
          ? `<a class="artist-link" href="#/artist/${a.artistId}">${esc(a.artist)}</a>`
          : esc(a.artist)}</div>
        <div class="sub">
          ${a.date ? `<span>${esc(a.date)}</span><span>·</span>` : ''}
          <span>${a.tracks.length} tracks</span>
          ${totalMs ? `<span>·</span><span>${Math.round(totalMs / 60000)} min</span>` : ''}
          <span>·</span><a class="dim" href="https://musicbrainz.org/release-group/${a.id}" target="_blank" rel="noopener">MusicBrainz ↗</a>
        </div>
        <a class="btn spotify-btn" href="${Spotify.searchLink(`${a.title} ${a.artist}`)}">
          <span class="sp-dot">▶</span> Open in Spotify</a>

        <section class="panel">
          <h3>Your rating</h3>
          <div class="your">
            <div class="rating-row"><span id="albumStars"></span><span class="rating-val" id="albumVal"></span></div>
            <div class="avg"><div class="n" id="trackAvg">–</div><div class="l" id="trackAvgLabel">Track average</div></div>
          </div>
          <div class="actions">
            <button class="btn" id="btnListened">✓ Listened</button>
            <button class="btn" id="btnWant">＋ Want to listen</button>
            <button class="btn danger small" id="btnRemove" ${isSaved(a.id) ? '' : 'hidden'}>Remove</button>
            <label id="dateWrap">Listened on <input class="field" type="date" id="listenedOn" value="${esc(a.listenedOn || '')}"></label>
          </div>
        </section>

        <section class="panel">
          <h3>Review</h3>
          <textarea class="field" id="review" placeholder="What did you think?">${esc(a.review || '')}</textarea>
          <div class="saved-note" id="reviewNote"></div>
        </section>

        <section class="panel">
          <h3>Tracklist</h3>
          <table class="tracks" id="tracks"></table>
        </section>
      </div>
    </div>`;

  // album stars
  const val = document.getElementById('albumVal');
  val.textContent = fmtRating(a.rating);
  document.getElementById('albumStars').replaceWith(stars(a.rating || 0, {
    size: 'lg',
    onChange: v => {
      a.rating = v; val.textContent = fmtRating(v);
      commit(a); syncStatus(a);
    }
  }));

  // status buttons
  document.getElementById('btnListened').onclick = () => {
    a.status = 'listened';
    if (!a.listenedOn) a.listenedOn = today();
    commit(a); syncStatus(a); toast('Added to your library');
  };
  document.getElementById('btnWant').onclick = () => {
    a.status = a.status === 'want' && isSaved(a.id) ? 'listened' : 'want';
    commit(a); syncStatus(a); toast(a.status === 'want' ? 'Added to Want to listen' : 'Moved to your library');
  };
  document.getElementById('btnRemove').onclick = () => {
    if (!confirm(`Remove “${a.title}” and all its ratings from your library?`)) return;
    removeAlbum(a.id);
    Object.assign(a, { rating: 0, review: '', listenedOn: '', status: null, trackRatings: {}, favTracks: {}, addedAt: null });
    drafts.set(a.id, a);
    toast('Removed');
    route();
  };
  document.getElementById('listenedOn').onchange = e => {
    a.listenedOn = e.target.value;
    if (isSaved(a.id)) commit(a);
  };

  // review autosave
  const review = document.getElementById('review');
  const note = document.getElementById('reviewNote');
  review.oninput = () => {
    note.textContent = 'Saving…';
    clearTimeout(review._t);
    review._t = setTimeout(() => {
      a.review = review.value;
      if (a.review.trim() || isSaved(a.id)) { commit(a); syncStatus(a); }
      note.textContent = 'Saved';
    }, 500);
  };

  syncStatus(a);
  drawTracks(a);
}

function syncStatus(a) {
  const saved = isSaved(a.id);
  const l = document.getElementById('btnListened');
  const w = document.getElementById('btnWant');
  if (!l) return;
  l.classList.toggle('on', saved && a.status === 'listened');
  l.classList.toggle('green', saved && a.status === 'listened');
  w.classList.toggle('on', saved && a.status === 'want');
  document.getElementById('btnRemove').hidden = !saved;
  document.getElementById('dateWrap').style.display = saved && a.status === 'listened' ? '' : 'none';
  document.getElementById('listenedOn').value = a.listenedOn || '';
}

function drawTracks(a) {
  const table = document.getElementById('tracks');
  if (!table) return;
  table.innerHTML = '';
  let lastDisc = null;
  for (const t of a.tracks) {
    if (t.disc && t.disc !== lastDisc) {
      lastDisc = t.disc;
      const dr = table.insertRow();
      dr.className = 'disc-row';
      const c = dr.insertCell(); c.colSpan = 5;
      c.textContent = `Disc ${t.disc}${t.discTitle ? ' — ' + t.discTitle : ''}`;
    }
    const tr = table.insertRow();
    tr.innerHTML = `
      <td class="num">${esc(t.number)}</td>
      <td class="ttl"><a class="track-link" data-rec="${esc(t.id)}" href="${Spotify.searchLink(`${t.title} ${a.artist}`)}"
        title="Play “${esc(t.title)}” in Spotify"><span class="play">▶</span>${esc(t.title)}</a></td>
      <td class="len">${fmtLen(t.length)}</td>
      <td class="rate"></td>
      <td class="fav"></td>`;
    const tval = document.createElement('span');
    tval.className = 'tval';
    const cur = (a.trackRatings || {})[t.id] || 0;
    tval.textContent = cur ? fmtRating(cur) : '';
    tr.querySelector('.rate').append(stars(cur, {
      size: 'sm',
      onChange: v => {
        a.trackRatings = a.trackRatings || {};
        if (v) a.trackRatings[t.id] = v; else delete a.trackRatings[t.id];
        tval.textContent = v ? fmtRating(v) : '';
        commit(a); syncStatus(a); updateTrackAvg(a);
      }
    }), tval);

    const heart = document.createElement('button');
    heart.className = 'heart' + ((a.favTracks || {})[t.id] ? ' on' : '');
    heart.textContent = '♥';
    heart.title = 'Favorite track';
    heart.setAttribute('aria-label', `Favorite ${t.title}`);
    heart.onclick = () => {
      a.favTracks = a.favTracks || {};
      if (a.favTracks[t.id]) delete a.favTracks[t.id]; else a.favTracks[t.id] = true;
      heart.classList.toggle('on', !!a.favTracks[t.id]);
      commit(a); syncStatus(a);
    };
    tr.querySelector('.fav').append(heart);
  }
  updateTrackAvg(a);
  resolveSpotifyLinks(a);
}

function updateTrackAvg(a) {
  const ids = new Set(a.tracks.map(t => t.id));
  const vals = Object.entries(a.trackRatings || {}).filter(([k, v]) => ids.has(k) && v).map(([, v]) => v);
  const n = document.getElementById('trackAvg');
  const l = document.getElementById('trackAvgLabel');
  if (!n) return;
  n.textContent = vals.length ? avg(vals).toFixed(2) : '–';
  l.textContent = vals.length ? `Track average · ${vals.length}/${a.tracks.length} rated` : 'Rate tracks below';
}

/* ---------------- header: search, export, import ---------------- */

document.getElementById('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const artist = document.getElementById('artistInput').value.trim();
  const album = document.getElementById('albumInput').value.trim();
  if (!artist && !album) return;
  const p = new URLSearchParams();
  if (artist) p.set('artist', artist);
  if (album) p.set('album', album);
  location.hash = `#/search?${p}`;
});

const menuBtn = document.getElementById('menuBtn');
const menuPop = document.getElementById('menuPop');
menuBtn.onclick = e => { e.stopPropagation(); menuPop.hidden = !menuPop.hidden; };
document.addEventListener('click', e => { if (!menuPop.contains(e.target)) menuPop.hidden = true; });

document.getElementById('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: `music-rater-${today()}.json` });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  menuPop.hidden = true;
};

document.getElementById('importInput').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.albums !== 'object') throw new Error();
    const n = Object.keys(data.albums).length;
    if (!confirm(`Import ${n} album${n === 1 ? '' : 's'}? Albums already in your library with the same ID will be replaced.`)) return;
    for (const [id, a] of Object.entries(data.albums)) {
      a.updatedAt = a.updatedAt || new Date().toISOString();
      db.albums[id] = a;
      delete db.deleted[id];
    }
    saveDb();
    Sync.syncAll();
    toast(`Imported ${n} albums`);
    route();
  } catch (_) {
    alert('That file doesn’t look like a Music Rater export.');
  }
  menuPop.hidden = true;
};

route();
Sync.init();
