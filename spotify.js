'use strict';

/* =========================================================
   Spotify: log in (PKCE, no secret needed), find the exact
   album / track IDs, and play them.
   - Links:  phones → open.spotify.com/... (opens the Spotify app)
             computers → spotify:track:... (opens the desktop app)
   - Premium accounts: tapping a song starts it on your active
     Spotify device directly (falls back to opening the link).
   Without a Client ID in config.js, falls back to search links.
   ========================================================= */

const SP_TOKEN = 'mr.spotify.token';
const SP_PKCE = 'mr.spotify.pkce';
const SP_IDS = 'mr.spotify.ids';
const SP_SCOPES = 'user-read-private user-read-playback-state user-modify-playback-state';
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomStr = n => b64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
const norm = s => (s || '').toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/i, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const Spotify = {
  enabled() { return !!CFG.spotifyClientId; },
  token() { try { return JSON.parse(localStorage.getItem(SP_TOKEN)); } catch (_) { return null; } },
  connected() { return this.enabled() && !!this.token(); },
  name() { const t = this.token(); return t && t.name; },
  premium() { const t = this.token(); return !!(t && t.premium); },
  redirectUri() { return new URL('spotify-callback.html', location.href.split('#')[0]).href; },

  /* ---------- links ---------- */
  searchLink(text) {
    const q = text.replace(/[:"]/g, ' ').replace(/\s+/g, ' ').trim();
    return IS_MOBILE
      ? `https://open.spotify.com/search/${encodeURIComponent(q)}`
      : `spotify:search:${encodeURIComponent(q)}`;
  },
  link(kind, id) {
    return IS_MOBILE ? `https://open.spotify.com/${kind}/${id}` : `spotify:${kind}:${id}`;
  },

  /* ---------- login (Authorization Code + PKCE) ---------- */
  async login() {
    if (!window.crypto || !crypto.subtle) {
      toast('Spotify login needs the secure (https) version of the app.');
      return;
    }
    const verifier = randomStr(64);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = randomStr(16);
    localStorage.setItem(SP_PKCE, JSON.stringify({ verifier, state, back: location.hash || '#/' }));
    const p = new URLSearchParams({
      client_id: CFG.spotifyClientId,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: SP_SCOPES
    });
    location.href = `https://accounts.spotify.com/authorize?${p}`;
  },

  /* Called on #/spotify-callback?code=…&state=… */
  async finishLogin(params) {
    let pk = null;
    try { pk = JSON.parse(localStorage.getItem(SP_PKCE)); } catch (_) { /* ignore */ }
    localStorage.removeItem(SP_PKCE);
    const back = (pk && pk.back) || '#/';
    if (params.get('error')) throw new Error(`Spotify login cancelled (${params.get('error')}).`);
    if (!pk || params.get('state') !== pk.state) throw new Error('Spotify login expired — please try again.');
    const tok = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: params.get('code'),
      redirect_uri: this.redirectUri(),
      code_verifier: pk.verifier
    });
    this.saveToken(tok);
    try {
      const me = await this.api('/me');
      const t = this.token();
      t.name = me.display_name || me.id;
      t.premium = me.product === 'premium';
      localStorage.setItem(SP_TOKEN, JSON.stringify(t));
    } catch (_) { /* profile is optional */ }
    return back;
  },

  logout() { localStorage.removeItem(SP_TOKEN); },

  async tokenRequest(body) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CFG.spotifyClientId, ...body })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.error || `Spotify error ${res.status}`);
    return data;
  },

  saveToken(data) {
    const old = this.token() || {};
    localStorage.setItem(SP_TOKEN, JSON.stringify({
      ...old,
      access: data.access_token,
      refresh: data.refresh_token || old.refresh,
      expires: Date.now() + (data.expires_in || 3600) * 1000
    }));
  },

  async accessToken() {
    const t = this.token();
    if (!t) throw new Error('Not connected to Spotify');
    if (Date.now() < t.expires - 60000) return t.access;
    try {
      this.saveToken(await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }));
    } catch (e) {
      this.logout();
      renderAccountMenu();
      throw new Error('Spotify session expired — connect Spotify again from the ⋯ menu.');
    }
    return this.token().access;
  },

  async api(path, opts = {}, retry = true) {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {})
      }
    });
    if (res.status === 401 && retry) {
      const t = this.token(); if (t) { t.expires = 0; localStorage.setItem(SP_TOKEN, JSON.stringify(t)); }
      return this.api(path, opts, false);
    }
    if (res.status === 429 && retry) {
      await sleep((Number(res.headers.get('Retry-After')) || 2) * 1000);
      return this.api(path, opts, false);
    }
    if (res.status === 204 || res.status === 202) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || `Spotify error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },

  /* ---------- finding exact IDs (cached per device) ---------- */
  cache() { try { return JSON.parse(localStorage.getItem(SP_IDS)) || {}; } catch (_) { return {}; } },
  remember(map) { localStorage.setItem(SP_IDS, JSON.stringify({ ...this.cache(), ...map })); },

  async findAlbum(album) {
    const c = this.cache();
    if (c[album.id] !== undefined) return c[album.id];
    const artistN = norm(album.artist.split(/,| & | feat\. /i)[0]);
    const q = encodeURIComponent(`${album.title} ${album.artist}`.replace(/[:"]/g, ' '));
    const data = await this.api(`/search?type=album&limit=10&q=${q}`);
    const items = (data.albums && data.albums.items || []).filter(Boolean);
    const byArtist = items.filter(i => i.artists.some(a => norm(a.name) === artistN || norm(a.name).includes(artistN)));
    const pool = byArtist.length ? byArtist : items;
    const titleN = norm(album.title);
    const best = pool.find(i => norm(i.name) === titleN) ||
      pool.find(i => norm(i.name).startsWith(titleN)) || (byArtist.length ? pool[0] : null);
    const id = best ? best.id : null;
    this.remember({ [album.id]: id });
    return id;
  },

  /* Returns { recordingId: spotifyTrackId } for every track on the album. */
  async findTracks(album, spAlbumId) {
    const c = this.cache();
    const out = {};
    const missing = album.tracks.filter(t => { if (c[t.id] !== undefined) { out[t.id] = c[t.id]; return false; } return true; });
    if (!missing.length) return out;

    const found = {};
    if (spAlbumId) {
      let items = [], url = `/albums/${spAlbumId}/tracks?limit=50`;
      while (url) {
        const page = await this.api(url);
        items = items.concat(page.items || []);
        url = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
      }
      const byName = new Map();
      items.forEach(i => { const k = norm(i.name); if (!byName.has(k)) byName.set(k, i.id); });
      const sameLength = items.length === album.tracks.length;
      album.tracks.forEach((t, idx) => {
        const id = byName.get(norm(t.title)) || (sameLength ? items[idx].id : null);
        if (id) found[t.id] = id;
      });
    }
    // Anything still unmatched: search for the song itself.
    for (const t of missing) {
      if (found[t.id]) continue;
      try {
        const q = encodeURIComponent(`${t.title} ${album.artist}`.replace(/[:"]/g, ' '));
        const data = await this.api(`/search?type=track&limit=5&q=${q}`);
        const items = (data.tracks && data.tracks.items || []).filter(Boolean);
        const hit = items.find(i => norm(i.name) === norm(t.title)) || items[0];
        found[t.id] = hit ? hit.id : null;
      } catch (_) { /* leave as search link */ }
    }
    this.remember(found);
    return { ...out, ...found };
  },

  /* ---------- playback (Premium) ---------- */
  async play(body) {
    try {
      await this.api('/me/player/play', { method: 'PUT', body: JSON.stringify(body) });
      return true;
    } catch (e) {
      if (e.status !== 404) return false;   // 403 = not Premium, etc.
    }
    // No active device: wake the first available one.
    try {
      const d = await this.api('/me/player/devices');
      const dev = (d.devices || []).find(x => !x.is_restricted);
      if (!dev) return false;
      await this.api(`/me/player/play?device_id=${dev.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return true;
    } catch (_) { return false; }
  }
};

/* ---------------- wiring Spotify into the album page ---------------- */

/* Click handler for any [data-sp-kind] link: Premium → play directly, else follow the link. */
document.addEventListener('click', async e => {
  const a = e.target.closest && e.target.closest('a[data-sp-id]');
  if (!a || !a.dataset.spId || !Spotify.connected() || !Spotify.premium()) return;
  e.preventDefault();
  const { spKind, spId, spAlbum } = a.dataset;
  const body = spKind === 'album'
    ? { context_uri: `spotify:album:${spId}` }
    : spAlbum
      ? { context_uri: `spotify:album:${spAlbum}`, offset: { uri: `spotify:track:${spId}` } }
      : { uris: [`spotify:track:${spId}`] };
  let ok = await Spotify.play(body);
  if (!ok && spKind === 'track' && spAlbum) ok = await Spotify.play({ uris: [`spotify:track:${spId}`] });
  if (ok) toast(`▶ Playing on Spotify`);
  else location.href = a.href;          // open the app instead
});

/* After the album page draws: swap search links for exact links. */
async function resolveSpotifyLinks(album) {
  if (!Spotify.connected()) return;
  const albumBtn = document.querySelector('.spotify-btn');
  try {
    const spAlbum = await Spotify.findAlbum(album);
    if (spAlbum && albumBtn) {
      albumBtn.href = Spotify.link('album', spAlbum);
      albumBtn.dataset.spKind = 'album';
      albumBtn.dataset.spId = spAlbum;
    }
    const ids = await Spotify.findTracks(album, spAlbum);
    document.querySelectorAll('.track-link[data-rec]').forEach(link => {
      const id = ids[link.dataset.rec];
      if (!id) return;
      link.href = Spotify.link('track', id);
      link.dataset.spKind = 'track';
      link.dataset.spId = id;
      if (spAlbum) link.dataset.spAlbum = spAlbum;
    });
  } catch (e) {
    console.warn('Spotify lookup failed:', e);
    if (/expired|connect/i.test(e.message)) toast(e.message);
  }
}
