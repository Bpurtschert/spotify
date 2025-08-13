// === Minimal Spotify Quick Stats (token-paste) ===
// Requires scopes: user-top-read, user-read-recently-played (for "Recently Played")

const els = {
  token: document.getElementById('token'),
  remember: document.getElementById('rememberToken'),
  btnValidate: document.getElementById('btnValidate'),
  whoami: document.getElementById('whoami'),
  scopeWarning: document.getElementById('scopeWarning'),

  mode: document.getElementById('mode'),
  timeRange: document.getElementById('timeRange'),
  timeRangeWrap: document.getElementById('timeRangeWrap'),
  limit: document.getElementById('limit'),

  btnFetch: document.getElementById('btnFetch'),
  btnClear: document.getElementById('btnClear'),
  btnDownload: document.getElementById('btnDownload'),

  out: document.getElementById('out'),
};

// --- Startup: hydrate token if remembered
(function init() {
  const saved = localStorage.getItem('spotify_access_token');
  if (saved) {
    els.token.value = saved;
    els.remember.checked = true;
  }
  toggleTimeRange();
})();

els.remember.addEventListener('change', () => {
  if (!els.remember.checked) localStorage.removeItem('spotify_access_token');
  else if (els.token.value.trim()) localStorage.setItem('spotify_access_token', els.token.value.trim());
});

els.token.addEventListener('input', () => {
  if (els.remember.checked) {
    const v = els.token.value.trim();
    if (v) localStorage.setItem('spotify_access_token', v);
  }
});

els.mode.addEventListener('change', toggleTimeRange);

function toggleTimeRange() {
  const m = els.mode.value;
  // Recently Played doesn't use time_range
  els.timeRangeWrap.style.display = (m === 'recently-played') ? 'none' : 'block';
}

els.btnValidate.addEventListener('click', async () => {
  try {
    const me = await apiGET('/v1/me');
    const scopes = parseJWTScopes(els.token.value);
    els.whoami.innerHTML = me
      ? `Hello, <strong>${escapeHTML(me.display_name || me.id)}</strong> 🎧`
      : 'Token looks OK.';
    scopeHints(scopes);
  } catch (e) {
    showError(`Token validation failed: ${e.message}`);
  }
});

els.btnFetch.addEventListener('click', async () => {
  clearOut();
  els.btnFetch.disabled = true;
  els.btnDownload.disabled = true;

  try {
    let data, jsonForDownload, mode = els.mode.value;
    const limit = clamp(parseInt(els.limit.value || '20', 10), 1, 50);
    const time_range = els.timeRange.value;

    if (mode === 'top-tracks') {
      data = await getTop('tracks', { time_range, limit });
      renderTopTracks(data.items);
      jsonForDownload = data;
    } else if (mode === 'top-artists') {
      data = await getTop('artists', { time_range, limit });
      renderTopArtists(data.items);
      jsonForDownload = data;
    } else if (mode === 'top-genres') {
      const artists = await getAllTopArtistsForGenres(time_range, limit);
      const genres = computeTopGenres(artists);
      renderTopGenres(genres);
      jsonForDownload = { source: 'top-artists (for genres)', items: artists, genres };
    } else if (mode === 'recently-played') {
      data = await getRecentlyPlayed(limit);
      renderRecentlyPlayed(data.items);
      jsonForDownload = data;
    }

    makeDownload(jsonForDownload);
  } catch (e) {
    showError(e.message);
  } finally {
    els.btnFetch.disabled = false;
  }
});

els.btnClear.addEventListener('click', () => {
  clearOut();
  els.btnDownload.disabled = true;
});

function clearOut() {
  els.out.innerHTML = '';
  els.scopeWarning.classList.add('hidden');
}

function showError(msg) {
  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML = `<div class="title">Error</div><div class="meta">${escapeHTML(msg)}</div>`;
  els.out.prepend(div);
}

// --- API helpers
async function apiGET(path, params) {
  const token = (els.token.value || '').trim();
  if (!token) throw new Error('Please paste a Spotify access token.');

  const url = new URL('https://api.spotify.com' + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 204) return null;
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j && j.error ? ` (${j.error.status}: ${j.error.message})` : '';
    } catch {}
    if (res.status === 401) {
      throw new Error('Unauthorized. Your token may be expired or missing scopes.' + detail);
    }
    throw new Error(`Request failed: ${res.status}${detail}`);
  }
  return res.json();
}

// --- Data fetchers
function getTop(kind, { time_range, limit }) {
  return apiGET(`/v1/me/top/${kind}`, { time_range, limit });
}

async function getAllTopArtistsForGenres(time_range, limit) {
  // Fetch up to 50 top artists (max allowed), but respect UI limit as cap
  const capped = clamp(limit, 1, 50);
  const data = await getTop('artists', { time_range, limit: `${capped}` });
  return data.items || [];
}

function computeTopGenres(artists) {
  const map = new Map();
  for (const a of artists) {
    const genres = a.genres || [];
    for (const g of genres) {
      const key = g.toLowerCase();
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  const arr = Array.from(map.entries())
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count);
  return arr;
}

function getRecentlyPlayed(limit) {
  // Spotify allows up to 50. It returns last ~50 tracks played in ~24 hours.
  return apiGET('/v1/me/player/recently-played', { limit: `${clamp(limit, 1, 50)}` });
}

// --- Renderers
function renderTopTracks(items = []) {
  if (!items.length) return renderEmpty('No top tracks found.');
  items.forEach((t, i) => {
    const artists = (t.artists || []).map(a => a.name).join(', ');
    const album = t.album?.name || '';
    const ms = t.duration_ms || 0;
    addItem({
      title: `${pad(i+1)}. ${t.name}`,
      lines: [
        `Artists: ${artists}`,
        album ? `Album: ${album}` : '',
        `Popularity: ${t.popularity}`,
        `Duration: ${fmtDuration(ms)}`
      ]
    });
  });
}

function renderTopArtists(items = []) {
  if (!items.length) return renderEmpty('No top artists found.');
  items.forEach((a, i) => {
    const genres = (a.genres || []).slice(0, 5).join(', ');
    addItem({
      title: `${pad(i+1)}. ${a.name}`,
      lines: [
        genres ? `Genres: ${genres}` : '',
        `Followers: ${num(a.followers?.total)}`,
        `Popularity: ${a.popularity}`
      ]
    });
  });
}

function renderTopGenres(genres = []) {
  if (!genres.length) return renderEmpty('No genres computed (need top artists).');
  genres.slice(0, 50).forEach((g, i) => {
    addItem({
      title: `${pad(i+1)}. ${titleCase(g.genre)}`,
      lines: [ `Count among top artists: ${g.count}` ]
    });
  });
}

function renderRecentlyPlayed(items = []) {
  if (!items.length) return renderEmpty('No recent plays found (or scope missing).');
  items.forEach((it, i) => {
    const t = it.track || {};
    const artists = (t.artists || []).map(a => a.name).join(', ');
    const playedAt = it.played_at ? new Date(it.played_at).toLocaleString() : '';
    addItem({
      title: `${pad(i+1)}. ${t.name || 'Unknown Track'}`,
      lines: [
        `Artists: ${artists}`,
        t.album?.name ? `Album: ${t.album.name}` : '',
        playedAt ? `Played at: ${playedAt}` : ''
      ]
    });
  });
}

function renderEmpty(msg) {
  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML = `<div class="title">${escapeHTML(msg)}</div>`;
  els.out.appendChild(div);
}

// --- Utilities
function addItem({ title, lines = [] }) {
  const div = document.createElement('div');
  div.className = 'item';
  const meta = lines.filter(Boolean).map(l => `<span class="badge">${escapeHTML(l)}</span>`).join(' ');
  div.innerHTML = `
    <div class="title">${escapeHTML(title)}</div>
    <div class="meta">${meta}</div>
  `;
  els.out.appendChild(div);
}

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function pad(n){ return String(n).padStart(2, '0'); }
function num(n){ return (n ?? 0).toLocaleString(); }
function fmtDuration(ms){ const s=Math.round(ms/1000); const m=Math.floor(s/60); const r=s%60; return `${m}:${String(r).padStart(2,'0')}`; }
function titleCase(s){ return s.replace(/\b\w/g, c => c.toUpperCase()); }
function escapeHTML(s=''){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Try to read scopes from JWT payload if provided in token (some providers do this). Fallback: warn manually.
function parseJWTScopes(token) {
  try{
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      const sc = payload.scope || payload.scp || payload.scopes || '';
      if (typeof sc === 'string') return sc.split(/\s+/);
      if (Array.isArray(sc)) return sc;
    }
  }catch{}
  return [];
}

function scopeHints(scopes) {
  const needTop = 'user-top-read';
  const needRecent = 'user-read-recently-played';

  const hasTop = scopes.includes(needTop);
  const hasRecent = scopes.includes(needRecent);

  let msgs = [];
  if (!hasTop) msgs.push(`Top data requires <code>${needTop}</code>.`);
  if (els.mode.value === 'recently-played' && !hasRecent) msgs.push(`Recently Played requires <code>${needRecent}</code>.`);
  if (msgs.length) {
    els.scopeWarning.innerHTML = msgs.join(' ');
    els.scopeWarning.classList.remove('hidden');
  } else {
    els.scopeWarning.classList.add('hidden');
  }
}

// Download JSON
function makeDownload(obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  els.btnDownload.disabled = false;
  els.btnDownload.onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = `spotify_${els.mode.value}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}
