// Playlist Converter — Spotify playlist → deep-link export for other services.
// Runs entirely in the browser. Uses Spotify's OAuth 2.0 Authorization Code
// with PKCE, so no client secret is needed.

const SPOTIFY_AUTH  = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API   = 'https://api.spotify.com/v1';
const SCOPES = 'playlist-read-private playlist-read-collaborative';

const LS_CLIENT_ID = 'pc.clientId';
const LS_TOKEN     = 'pc.token';     // { access_token, expires_at }
const SS_VERIFIER  = 'pc.verifier';
const SS_RETURN_TO = 'pc.returnTo';

// Redirect URI must exactly match what's registered in the Spotify dashboard.
// We use the current page's own URL, minus any query/hash, so it works on
// localhost during dev as well as on GitHub Pages.
const REDIRECT_URI = location.origin + location.pathname;

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const setupCard    = $('setupCard');
const authCard     = $('authCard');
const playlistCard = $('playlistCard');
const playlistView = $('playlistView');
const statusEl     = $('status');

// ---------- PKCE helpers ----------
function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return Array.from(out, b => chars[b % chars.length]).join('');
}

async function sha256Base64Url(input) {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- Status ----------
function showStatus(msg, kind = 'info') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + kind;
  statusEl.classList.remove('hidden');
}
function clearStatus() {
  statusEl.textContent = '';
  statusEl.classList.add('hidden');
}

// ---------- State views ----------
function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }
function hideAll() { [setupCard, authCard, playlistCard, playlistView].forEach(hide); }

function renderInitialView() {
  hideAll();
  clearStatus();
  const clientId = localStorage.getItem(LS_CLIENT_ID);
  const token = getToken();
  if (!clientId) { show(setupCard); return; }
  if (!token)    { show(authCard); return; }
  show(playlistCard);
}

// ---------- Token helpers ----------
function getToken() {
  try {
    const raw = localStorage.getItem(LS_TOKEN);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t.access_token || !t.expires_at) return null;
    if (Date.now() >= t.expires_at - 30_000) return null; // 30s safety
    return t.access_token;
  } catch { return null; }
}

function saveToken(accessToken, expiresInSec) {
  localStorage.setItem(LS_TOKEN, JSON.stringify({
    access_token: accessToken,
    expires_at: Date.now() + expiresInSec * 1000,
  }));
}

function clearToken() { localStorage.removeItem(LS_TOKEN); }

// ---------- OAuth flow ----------
async function beginLogin() {
  const clientId = localStorage.getItem(LS_CLIENT_ID);
  if (!clientId) { renderInitialView(); return; }

  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);
  sessionStorage.setItem(SS_VERIFIER, verifier);

  // Preserve any playlist URL the user already typed so we can reuse after return.
  const pending = $('playlistInput')?.value?.trim();
  if (pending) sessionStorage.setItem(SS_RETURN_TO, pending);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  location.assign(`${SPOTIFY_AUTH}?${params}`);
}

async function completeLoginFromQuery() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const err  = url.searchParams.get('error');

  if (err) {
    // Strip query and report.
    history.replaceState({}, '', REDIRECT_URI);
    showStatus(`Spotify login was cancelled: ${err}`, 'error');
    return false;
  }
  if (!code) return false;

  const verifier = sessionStorage.getItem(SS_VERIFIER);
  const clientId = localStorage.getItem(LS_CLIENT_ID);
  if (!verifier || !clientId) {
    history.replaceState({}, '', REDIRECT_URI);
    showStatus('Login state was lost. Please try again.', 'error');
    return false;
  }

  showStatus('Finishing sign-in…', 'info');
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    const res = await fetch(SPOTIFY_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${detail}`);
    }
    const data = await res.json();
    saveToken(data.access_token, data.expires_in);
    sessionStorage.removeItem(SS_VERIFIER);
  } catch (e) {
    showStatus(e.message || 'Sign-in failed.', 'error');
    history.replaceState({}, '', REDIRECT_URI);
    return false;
  }

  history.replaceState({}, '', REDIRECT_URI);
  clearStatus();
  return true;
}

// ---------- Spotify API ----------
async function spotifyGet(path) {
  const token = getToken();
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(path.startsWith('http') ? path : `${SPOTIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('Your Spotify session expired. Please log in again.');
  }
  if (res.status === 404) throw new Error('Playlist not found (or it is private and belongs to another account).');
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After') || '?';
    throw new Error(`Spotify is rate-limiting us. Try again in ${retry}s.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Spotify API error ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

function parsePlaylistId(input) {
  const s = input.trim();
  if (!s) return null;
  // spotify:playlist:ID
  let m = s.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (m) return m[1];
  // open.spotify.com/playlist/ID or /embed/playlist/ID, with optional locale
  m = s.match(/open\.spotify\.com\/(?:[a-z-]+\/)?(?:embed\/)?playlist\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  // Bare ID (Spotify IDs are base62, typically 22 chars)
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return s;
  return null;
}

async function fetchPlaylist(playlistId) {
  // Basic playlist info
  const meta = await spotifyGet(
    `/playlists/${playlistId}?fields=id,name,description,owner(display_name),images,tracks(total)`
  );

  // All tracks, paginated
  const tracks = [];
  let url = `${SPOTIFY_API}/playlists/${playlistId}/tracks` +
            `?fields=items(track(id,name,artists(name),album(name,release_date),duration_ms,is_local,external_urls(spotify))),next` +
            `&limit=100`;
  while (url) {
    const page = await spotifyGet(url);
    for (const item of page.items || []) {
      const t = item.track;
      if (!t) continue; // removed/unavailable
      tracks.push({
        id: t.id || null,
        name: t.name || '',
        artists: (t.artists || []).map(a => a.name).filter(Boolean),
        album: t.album?.name || '',
        releaseDate: t.album?.release_date || '',
        durationMs: t.duration_ms || 0,
        isLocal: !!t.is_local,
        spotifyUrl: t.external_urls?.spotify || '',
      });
    }
    url = page.next;
  }

  return { meta, tracks };
}

// ---------- Service search URL builders ----------
const BUILDERS = {
  apple: (t) => `https://music.apple.com/search?term=${encodeURIComponent(`${t.artists.join(' ')} ${t.name}`)}`,
  ytmusic: (t) => `https://music.youtube.com/search?q=${encodeURIComponent(`${t.artists.join(' ')} ${t.name}`)}`,
  youtube: (t) => `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t.artists.join(' ')} ${t.name}`)}`,
  tidal: (t) => `https://tidal.com/search?q=${encodeURIComponent(`${t.artists.join(' ')} ${t.name}`)}`,
  deezer: (t) => `https://www.deezer.com/search/${encodeURIComponent(`${t.artists.join(' ')} ${t.name}`)}`,
  amazon: (t) => `https://music.amazon.com/search/${encodeURIComponent(`${t.artists.join(' ')} ${t.name}`)}`,
  soundcloud: (t) => `https://soundcloud.com/search/sounds?q=${encodeURIComponent(`${t.artists.join(' ')} ${t.name}`)}`,
};
const SERVICE_NAMES = {
  apple: 'Apple Music', ytmusic: 'YT Music', youtube: 'YouTube',
  tidal: 'Tidal', deezer: 'Deezer', amazon: 'Amazon Music', soundcloud: 'SoundCloud',
};

function currentTarget() {
  const r = document.querySelector('input[name="target"]:checked');
  return r ? r.value : 'apple';
}

// ---------- Rendering ----------
let currentPlaylist = null;

function renderPlaylist(pl) {
  currentPlaylist = pl;
  const { meta, tracks } = pl;

  $('playlistName').textContent = meta.name || 'Untitled playlist';
  const owner = meta.owner?.display_name || 'unknown';
  $('playlistMeta').textContent =
    `${tracks.length} track${tracks.length === 1 ? '' : 's'} · by ${owner}`;

  const cover = meta.images?.[0]?.url;
  const img = $('playlistCover');
  if (cover) { img.src = cover; img.style.display = ''; }
  else { img.removeAttribute('src'); img.style.display = 'none'; }

  renderTracks();
  show(playlistView);
}

function renderTracks() {
  if (!currentPlaylist) return;
  const target = currentTarget();
  const build = BUILDERS[target];
  const buttonLabel = `Open in ${SERVICE_NAMES[target]}`;

  const list = $('trackList');
  list.innerHTML = '';

  currentPlaylist.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'track';
    if (t.isLocal || !t.name) li.classList.add('unavailable');

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.name || '(unknown title)';

    const artist = document.createElement('div');
    artist.className = 'artist';
    artist.textContent = t.artists.join(', ') + (t.album ? ` — ${t.album}` : '');

    meta.append(title, artist);

    const a = document.createElement('a');
    a.className = 'jump';
    a.textContent = buttonLabel;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.href = (t.isLocal || !t.name) ? '#' : build(t);

    li.append(idx, meta, a);
    list.append(li);
  });
}

// ---------- Bulk actions ----------
function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(s) {
  const str = String(s ?? '');
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function trackRowText(t) { return `${t.artists.join(', ')} — ${t.name}`; }

function exportCsv() {
  if (!currentPlaylist) return;
  const header = ['#','title','artist','album','release_date','duration_ms','spotify_url'];
  const rows = [header.join(',')];
  currentPlaylist.tracks.forEach((t, i) => {
    rows.push([
      i + 1, t.name, t.artists.join('; '), t.album, t.releaseDate, t.durationMs, t.spotifyUrl
    ].map(csvEscape).join(','));
  });
  const name = (currentPlaylist.meta.name || 'playlist').replace(/[^\w\-]+/g, '_');
  downloadBlob(`${name}.csv`, rows.join('\n'), 'text/csv;charset=utf-8');
}

function exportJson() {
  if (!currentPlaylist) return;
  const data = {
    name: currentPlaylist.meta.name,
    owner: currentPlaylist.meta.owner?.display_name,
    description: currentPlaylist.meta.description,
    count: currentPlaylist.tracks.length,
    tracks: currentPlaylist.tracks,
  };
  const name = (currentPlaylist.meta.name || 'playlist').replace(/[^\w\-]+/g, '_');
  downloadBlob(`${name}.json`, JSON.stringify(data, null, 2), 'application/json');
}

async function copyList() {
  if (!currentPlaylist) return;
  const text = currentPlaylist.tracks.map(trackRowText).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showStatus(`Copied ${currentPlaylist.tracks.length} tracks to clipboard.`, 'ok');
    setTimeout(clearStatus, 2500);
  } catch {
    showStatus('Clipboard blocked by the browser. Try the Download buttons instead.', 'error');
  }
}

function openAll() {
  if (!currentPlaylist) return;
  const target = currentTarget();
  const build = BUILDERS[target];
  const playable = currentPlaylist.tracks.filter(t => !t.isLocal && t.name);
  if (!playable.length) return;

  if (playable.length > 10) {
    const ok = confirm(
      `This will open ${playable.length} new tabs in ${SERVICE_NAMES[target]}. ` +
      `Your browser will probably block it unless you allow popups for this site. Continue?`
    );
    if (!ok) return;
  }

  let blocked = 0;
  for (const t of playable) {
    const w = window.open(build(t), '_blank', 'noopener');
    if (!w) blocked++;
  }
  if (blocked) {
    showStatus(`${blocked} tab(s) were blocked by the browser. Allow popups and try again, or click tracks individually.`, 'error');
  } else {
    showStatus(`Opened ${playable.length} tabs.`, 'ok');
    setTimeout(clearStatus, 2500);
  }
}

// ---------- Wiring ----------
function wire() {
  $('redirectUriDisplay').textContent = REDIRECT_URI;

  $('copyRedirect').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(REDIRECT_URI); $('copyRedirect').textContent = 'Copied'; setTimeout(() => $('copyRedirect').textContent = 'Copy', 1500); }
    catch { /* silent */ }
  });

  $('saveClientId').addEventListener('click', () => {
    const v = $('clientIdInput').value.trim();
    if (!/^[A-Za-z0-9]{20,}$/.test(v)) {
      showStatus('That does not look like a valid Client ID.', 'error');
      return;
    }
    localStorage.setItem(LS_CLIENT_ID, v);
    clearStatus();
    renderInitialView();
  });

  $('cancelSetup').addEventListener('click', () => {
    if (localStorage.getItem(LS_CLIENT_ID)) renderInitialView();
  });

  $('editClientId').addEventListener('click', () => {
    hideAll();
    $('clientIdInput').value = localStorage.getItem(LS_CLIENT_ID) || '';
    show(setupCard);
  });

  $('loginBtn').addEventListener('click', () => beginLogin().catch(e => showStatus(e.message, 'error')));

  $('loadBtn').addEventListener('click', onLoadPlaylist);
  $('playlistInput').addEventListener('keydown', e => { if (e.key === 'Enter') onLoadPlaylist(); });

  $('logoutBtn').addEventListener('click', () => {
    clearToken();
    currentPlaylist = null;
    renderInitialView();
  });

  $('resetBtn').addEventListener('click', () => {
    if (!confirm('This clears your saved Client ID and Spotify session from this browser. Continue?')) return;
    localStorage.removeItem(LS_CLIENT_ID);
    clearToken();
    sessionStorage.removeItem(SS_VERIFIER);
    sessionStorage.removeItem(SS_RETURN_TO);
    currentPlaylist = null;
    renderInitialView();
  });

  document.querySelectorAll('input[name="target"]').forEach(el =>
    el.addEventListener('change', renderTracks)
  );

  $('openAllBtn').addEventListener('click', openAll);
  $('copyListBtn').addEventListener('click', copyList);
  $('downloadCsvBtn').addEventListener('click', exportCsv);
  $('downloadJsonBtn').addEventListener('click', exportJson);
}

async function onLoadPlaylist() {
  const input = $('playlistInput').value;
  const id = parsePlaylistId(input);
  if (!id) {
    showStatus("That doesn't look like a Spotify playlist URL, URI, or ID.", 'error');
    return;
  }
  showStatus('Loading playlist…', 'info');
  try {
    const pl = await fetchPlaylist(id);
    clearStatus();
    renderPlaylist(pl);
  } catch (e) {
    showStatus(e.message || 'Failed to load playlist.', 'error');
    if (/log in again/i.test(e.message)) renderInitialView();
  }
}

// ---------- Boot ----------
(async function main() {
  wire();

  // If we just came back from Spotify auth, complete the exchange first.
  const url = new URL(location.href);
  if (url.searchParams.has('code') || url.searchParams.has('error')) {
    await completeLoginFromQuery();
  }

  renderInitialView();

  // If we had a pending playlist URL before login, restore and auto-load.
  const pending = sessionStorage.getItem(SS_RETURN_TO);
  if (pending && getToken()) {
    sessionStorage.removeItem(SS_RETURN_TO);
    $('playlistInput').value = pending;
    onLoadPlaylist();
  }
})();
