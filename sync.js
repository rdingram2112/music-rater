'use strict';

/* =========================================================
   Account + sync across devices (Supabase).
   Each album is one row: (user_id, album_id, data, updated_at, deleted).
   Merging is per album — the most recently changed copy wins.
   Without config.js values, the app simply stays local-only.
   ========================================================= */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.append(s);
  });
}

const Sync = {
  client: null,
  user: null,
  pending: new Set(),
  running: null,
  again: false,

  enabled() { return !!(CFG.supabaseUrl && CFG.supabaseAnonKey); },

  async init() {
    if (!this.enabled()) { renderAccountMenu(); return; }
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
    } catch (_) {
      this.setState('error', 'Couldn’t load the sync library — check your connection.');
      return;
    }
    this.client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    this.client.auth.onAuthStateChange((_evt, session) => {
      const before = this.user && this.user.id;
      this.user = (session && session.user) || null;
      renderAccountMenu();
      if (!this.user) this.setState('off');
      else if (this.user.id !== before) setTimeout(() => this.syncAll(), 0);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.user) this.syncAll();
    });
    window.addEventListener('online', () => { if (this.user) this.syncAll(); });
  },

  setState(state, msg = '') {
    const dot = document.getElementById('syncDot');
    if (!dot) return;
    dot.className = `sync-dot ${state}`;
    dot.hidden = state === 'off';
    dot.title = {
      idle: 'All changes synced',
      syncing: 'Syncing…',
      offline: 'Offline — changes will sync when you reconnect',
      error: `Sync problem: ${msg}`
    }[state] || '';
  },

  row(id) {
    const a = db.albums[id];
    if (a) return { user_id: this.user.id, album_id: id, data: a, updated_at: a.updatedAt, deleted: false };
    if (db.deleted[id]) return { user_id: this.user.id, album_id: id, data: null, updated_at: db.deleted[id], deleted: true };
    return null;
  },

  /* Push one album shortly after it changes (batched). */
  queue(id) {
    if (!this.user) return;
    this.pending.add(id);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 800);
  },

  async flush() {
    const ids = [...this.pending];
    this.pending.clear();
    const rows = ids.map(id => this.row(id)).filter(Boolean);
    if (!rows.length || !this.user) return;
    this.setState('syncing');
    const { error } = await this.client.from('albums').upsert(rows);
    if (error) {
      ids.forEach(id => this.pending.add(id));
      this.setState(navigator.onLine ? 'error' : 'offline', error.message);
    } else {
      this.setState('idle');
    }
  },

  /* Full two-way merge: pull everything, keep the newest copy of each album, push what's newer here. */
  async syncAll() {
    if (!this.user) return;
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      this.setState('syncing');
      try {
        const { data: rows, error } = await this.client
          .from('albums').select('album_id,data,updated_at,deleted');
        if (error) throw error;
        const t = s => (s ? new Date(s).getTime() : 0);
        const remote = new Map(rows.map(r => [r.album_id, r]));
        let changed = false;

        for (const r of rows) {
          const local = db.albums[r.album_id];
          const localTs = local ? local.updatedAt : db.deleted[r.album_id];
          if (t(r.updated_at) <= t(localTs)) continue;
          if (r.deleted) {
            if (local) { delete db.albums[r.album_id]; changed = true; }
            db.deleted[r.album_id] = r.updated_at;
          } else if (r.data) {
            r.data.updatedAt = r.updated_at;
            db.albums[r.album_id] = r.data;
            delete db.deleted[r.album_id];
            drafts.delete(r.album_id);
            changed = true;
          }
        }

        const up = [];
        for (const a of Object.values(db.albums)) {
          const r = remote.get(a.id);
          if (!r || t(a.updatedAt) > t(r.updated_at)) up.push(this.row(a.id));
        }
        for (const [id, ts] of Object.entries(db.deleted)) {
          const r = remote.get(id);
          if (r && !r.deleted && t(ts) > t(r.updated_at)) up.push(this.row(id));
        }
        if (up.length) {
          const { error: e2 } = await this.client.from('albums').upsert(up);
          if (e2) throw e2;
        }
        saveDb();
        this.setState('idle');
        if (changed) refreshView();
      } catch (e) {
        this.setState(navigator.onLine ? 'error' : 'offline', e.message || String(e));
      }
    })();
    await this.running;
    this.running = null;
    if (this.again) { this.again = false; return this.syncAll(); }
  },

  async signIn(email, password) {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({
      email, password, options: { emailRedirectTo: location.href.split('#')[0] }
    });
    if (error) throw error;
    return !!data.session;   // false → needs email confirmation first
  },

  async signOut() {
    await this.client.auth.signOut();
  }
};

/* Re-draw the current page after synced changes arrive — unless you're typing. */
function refreshView() {
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'checkbox'))) return;
  route({ keepScroll: true });
}

/* ---------------- account dialog + menu ---------------- */

function renderAccountMenu() {
  const box = document.getElementById('accountItems');
  if (!box) return;
  const items = [];
  if (Sync.enabled()) {
    if (Sync.user) {
      items.push(`<div class="menu-note">Signed in as <b>${esc(Sync.user.email)}</b></div>`);
      items.push('<button data-act="syncnow">Sync now</button>');
      items.push('<button data-act="signout">Sign out</button>');
    } else {
      items.push('<button data-act="signin">Sign in to sync devices…</button>');
    }
  }
  if (Spotify.enabled()) {
    items.push(Spotify.connected()
      ? `<button data-act="spotify-off">Disconnect Spotify${Spotify.name() ? ` (${esc(Spotify.name())})` : ''}</button>`
      : '<button data-act="spotify-on">Connect Spotify…</button>');
  }
  if (!Sync.enabled() || !Spotify.enabled()) {
    items.push('<div class="menu-note">Sync / Spotify not set up yet — see SETUP.md</div>');
  }
  box.innerHTML = items.join('') + '<hr>';
  box.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    document.getElementById('menuPop').hidden = true;
    const act = b.dataset.act;
    if (act === 'signin') openAuthDialog();
    if (act === 'signout') Sync.signOut().then(() => toast('Signed out — your ratings stay on this device'));
    if (act === 'syncnow') Sync.syncAll().then(() => toast('Synced'));
    if (act === 'spotify-on') Spotify.login();
    if (act === 'spotify-off') { Spotify.logout(); renderAccountMenu(); toast('Spotify disconnected'); route({ keepScroll: true }); }
  });
}

function openAuthDialog() {
  const dlg = document.getElementById('authDlg');
  const msg = dlg.querySelector('.dlg-msg');
  const email = dlg.querySelector('#authEmail');
  const pass = dlg.querySelector('#authPass');
  msg.textContent = '';
  msg.className = 'dlg-msg';
  const run = async (fn) => {
    msg.className = 'dlg-msg';
    if (!email.value.trim() || pass.value.length < 6) {
      msg.textContent = 'Enter your email and a password of at least 6 characters.';
      msg.classList.add('bad');
      return;
    }
    dlg.querySelectorAll('button').forEach(b => (b.disabled = true));
    msg.textContent = 'Working…';
    try {
      await fn();
    } catch (e) {
      msg.textContent = e.message || 'Something went wrong.';
      msg.classList.add('bad');
    }
    dlg.querySelectorAll('button').forEach(b => (b.disabled = false));
  };
  dlg.querySelector('#authSignIn').onclick = () => run(async () => {
    await Sync.signIn(email.value.trim(), pass.value);
    pass.value = '';
    dlg.close();
    toast('Signed in — syncing your library');
  });
  dlg.querySelector('#authSignUp').onclick = () => run(async () => {
    const ready = await Sync.signUp(email.value.trim(), pass.value);
    if (ready) { pass.value = ''; dlg.close(); toast('Account created — syncing'); return; }
    msg.textContent = 'Check your email and click the confirmation link, then come back and sign in.';
    msg.classList.add('good');
  });
  dlg.querySelector('#authCancel').onclick = () => dlg.close();
  dlg.showModal();
  email.focus();
}
