# Music Rater — putting it online, syncing, and Spotify

Three free accounts, about 15 minutes total. Do them in this order, because each step
needs the web address from step 1.

Throughout this guide, replace **`rdingram2112`** with your GitHub username.
Your app's address will be: **`https://rdingram2112.github.io/music-rater/`**

---

## 1. Put the app on GitHub Pages (free hosting)

**Easiest (no installs):**
1. Go to <https://github.com/new>. Name the repository **`music-rater`**, leave it **Public**, click **Create repository**.
2. On the next page click **"uploading an existing file"**.
3. Open the `Music Rater` folder on your PC, select **everything inside it** (including the `icons` folder) and drag it onto the page. Click **Commit changes**.
4. In the repository go to **Settings → Pages**. Under *Branch* choose **main** and **/ (root)**, click **Save**.
5. Wait a minute, then open `https://rdingram2112.github.io/music-rater/`. You should see Music Rater.

> Later, when files change, upload just the changed files the same way (GitHub replaces them).
> If you install Git + GitHub CLI, Claude can push updates for you instead.

---

## 2. Sync between phone and computer (Supabase)

1. Sign up at <https://supabase.com> (signing in with GitHub is fine) and click **New project**.
   Pick any name and database password (save it somewhere), choose a region near you, create it, and wait ~2 minutes.
2. Left sidebar → **SQL Editor** → **New query**. Open `supabase.sql` from the app folder, paste all of it in, click **Run**. It should say *Success*.
3. Left sidebar → **Authentication → URL Configuration**:
   - **Site URL:** `https://rdingram2112.github.io/music-rater/`
   - **Redirect URLs:** add `https://rdingram2112.github.io/music-rater/`
4. Left sidebar → **Project Settings → API** (may be called **API Keys**). Copy:
   - the **Project URL** (looks like `https://abcd1234.supabase.co`)
   - the **anon / publishable** key (a long string). **Not** the `service_role` / secret key.
5. Put both into `config.js` (see step 4 below).

---

## 3. Spotify (exact song links + one-tap play)

1. Go to <https://developer.spotify.com/dashboard>, log in with your Spotify account, accept the terms.
2. Click **Create app**:
   - **App name:** Music Rater  **App description:** Personal album rating app
   - **Redirect URI:** `https://rdingram2112.github.io/music-rater/spotify-callback.html` → click **Add**
   - Tick **Web API**, agree to the terms, **Save**.
3. Open the app's **Settings** and copy the **Client ID**. (You don't need the Client secret.)
4. If Spotify later says your account isn't allowed: in the app's settings open **User Management**
   and add the email address of your Spotify account.

---

## 4. Fill in `config.js` and upload it

Open `config.js` in Notepad and fill in the three values between the quotes:

```js
spotifyClientId: 'paste Client ID here',
supabaseUrl: 'https://abcd1234.supabase.co',
supabaseAnonKey: 'paste the anon / publishable key here'
```

Save it, then upload `config.js` to your GitHub repository again (step 1.2–1.3). These values are
designed to be public, so it's fine that the repository is public.

---

## 5. Use it

**On your computer:** open `https://rdingram2112.github.io/music-rater/`.
- **⋯ menu → Sign in to sync devices…** → **Create account** with your email and a password.
  Confirm the email Supabase sends you, then sign in. Any ratings already on this device are uploaded.
- **⋯ menu → Connect Spotify…** → approve.

**On your phone:** open the same address in Safari (iPhone) or Chrome (Android).
- Sign in with the same email/password, and connect Spotify.
- **Add to Home Screen:** iPhone → Share button → *Add to Home Screen*. Android → ⋮ menu → *Add to Home screen* / *Install app*.

### What tapping a song does
- **Spotify Premium:** the song starts playing on whichever Spotify device is active (open the Spotify app once first so it's "awake").
  The rest of the album keeps playing after it.
- **Free Spotify, or no active device:** opens the Spotify app straight to that song or album.
- **Not connected to Spotify:** opens a Spotify search for the song.

### Good to know
- A small dot next to the ⋯ button shows sync status: green = synced, yellow = syncing, red = problem (hover/tap the dot for details).
- Your ratings are still saved on each device too, so the app works offline and catches up when you reconnect.
- The local version (`Start Music Rater.bat`) still works, but Spotify login only works on the online address.
