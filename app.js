// === Minimal Spotify Quick Stats (token-paste) ===
// Requires scopes: user-top-read, user-read-recently-played (for "Recently Played")

const els = {
  token: document.getElementById("token"),
  remember: document.getElementById("rememberToken"),
  btnValidate: document.getElementById("btnValidate"),
  whoami: document.getElementById("whoami"),
  scopeWarning: document.getElementById("scopeWarning"),

  mode: document.getElementById("mode"),
  timeRange: document.getElementById("timeRange"),
  timeRangeWrap: document.getElementById("timeRangeWrap"),
  limit: document.getElementById("limit"),

  btnFetch: document.getElementById("btnFetch"),
  btnClear: document.getElementById("btnClear"),
  btnDownload: document.getElementById("btnDownload"),

  out: document.getElementById("out"),
};

// --- Startup: hydrate token if remembered
(function init() {
  const saved = localStorage.getItem("spotify_access_token");
  if (saved) {
    els.token.value = saved;
    els.remember.checked = true;
  }
  toggleTimeRange();
})();

els.remember.addEventListener("change", () => {
  if (!els.remember.checked) localStorage.removeItem("spotify_access_token");
  else if (els.token.value.trim())
    localStorage.setItem("spotify_access_token", els.token.value.trim());
});

els.token.addEventListener("input", () => {
  if (els.remember.checked) {
    const v = els.token.value.trim();
    if (v) localStorage.setItem("spotify_access_token", v);
  }
});

els.mode.addEventListener("change", toggleTimeRange);

function toggleTimeRange() {
  const m = els.mode.value;
  const usesTimeRange = [
    "top-tracks",
    "top-artists",
    "top-genres",
    "audio-features-radar",
    "era-breakdown",
  ].includes(m);
  els.timeRangeWrap.style.display = usesTimeRange ? "block" : "none";
}

els.btnValidate.addEventListener("click", async () => {
  try {
    const me = await apiGET("/v1/me");
    const scopes = parseJWTScopes(els.token.value);
    els.whoami.innerHTML = me
      ? `Hello, <strong>${escapeHTML(me.display_name || me.id)}</strong> 🎧`
      : "Token looks OK.";
    scopeHints(scopes);
  } catch (e) {
    showError(`Token validation failed: ${e.message}`);
  }
});

els.btnFetch.addEventListener("click", async () => {
  clearOut();
  els.btnFetch.disabled = true;
  els.btnDownload.disabled = true;

  try {
    let data, jsonForDownload;
    const mode = els.mode.value;
    const limit = clamp(parseInt(els.limit.value || "20", 10), 1, 50);
    const time_range = els.timeRange.value;

    if (mode === "top-tracks") {
      data = await getTop("tracks", { time_range, limit });
      renderTopTracks(data.items);
      jsonForDownload = data;
    } else if (mode === "top-artists") {
      data = await getTop("artists", { time_range, limit });
      renderTopArtists(data.items);
      jsonForDownload = data;
    } else if (mode === "top-genres") {
      const artists = await getAllTopArtistsForGenres(time_range, limit);
      const genres = computeTopGenres(artists);
      renderTopGenres(genres);
      jsonForDownload = {
        source: "top-artists (for genres)",
        items: artists,
        genres,
      };
    } else if (mode === "recently-played") {
      data = await getRecentlyPlayed(limit);
      renderRecentlyPlayed(data.items);
      jsonForDownload = data;
    } else if (mode === "audio-features-radar") {
      const tracks =
        (await getTop("tracks", { time_range, limit })).items || [];
      if (!tracks.length) {
        renderEmpty("No tracks to analyze.");
        throw new Error("No tracks");
      }
      const ids = tracks.map((t) => t.id).filter(Boolean);
      const feats = await getAudioFeatures(ids);
      const avg = averageAudioFeatures(feats);
      renderAudioRadar(avg, {
        title: `Avg of Top ${tracks.length} tracks (${labelForRange(
          time_range
        )})`,
      });
      jsonForDownload = { items: tracks, audio_features: feats, averages: avg };
    } else if (mode === "era-breakdown") {
      const tracks =
        (await getTop("tracks", { time_range, limit })).items || [];
      if (!tracks.length) {
        renderEmpty("No tracks to analyze.");
        throw new Error("No tracks");
      }
      const eras = computeEraBreakdown(tracks);
      renderEraBreakdown(eras, {
        title: `Eras in Top ${tracks.length} tracks (${labelForRange(
          time_range
        )})`,
      });
      jsonForDownload = { items: tracks, eras };
    } else if (mode === "top5-playlist") {
      // Uses the Limit field (1..100) instead of a fixed 5
      const n = clamp(parseInt(els.limit.value || "100", 10), 1, 100);
      const top = await getTopTracksUpTo(n, time_range); // <-- new helper below
      if (!top.length) {
        renderEmpty("No top tracks to add to a playlist.");
        throw new Error("No tracks");
      }

      const user = await apiGET("/v1/me");
      const name = `Your Top ${
        top.length
      } • ${new Date().toLocaleDateString()}`;
      const playlist = await apiPOST(
        `/v1/users/${encodeURIComponent(user.id)}/playlists`,
        {
          name,
          description: `Top ${top.length} tracks (${labelForRange(
            time_range
          )}) via Quick Stats`,
          public: false,
        }
      );

      const uris = top.map((t) => t.uri).filter(Boolean);
      await addTracksInBatches(playlist.id, uris); // <-- new helper below

      addItem({
        title: `✅ Created playlist: ${name}`,
        lines: [`Tracks added: ${uris.length}`, `Playlist ID: ${playlist.id}`],
      });
      jsonForDownload = { playlist, added_track_uris: uris };
    }

    if (jsonForDownload) makeDownload(jsonForDownload);
  } catch (e) {
    // Avoid showing "No tracks" as an error toast if we already rendered a friendly message
    if (!/No tracks/.test(e.message)) showError(e.message);
  } finally {
    els.btnFetch.disabled = false;
  }
});

els.btnClear.addEventListener("click", () => {
  clearOut();
  els.btnDownload.disabled = true;
});

function clearOut() {
  els.out.innerHTML = "";
  els.scopeWarning.classList.add("hidden");
}

function showError(msg) {
  const div = document.createElement("div");
  div.className = "item";
  div.innerHTML = `<div class="title">Error</div><div class="meta">${escapeHTML(
    msg
  )}</div>`;
  els.out.prepend(div);
}

// --- API helpers
async function apiGET(path, params) {
  const token = (els.token.value || "").trim();
  if (!token) throw new Error("Please paste a Spotify access token.");

  const url = new URL("https://api.spotify.com" + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 204) return null;
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j && j.error ? ` (${j.error.status}: ${j.error.message})` : "";
    } catch {}
    if (res.status === 401) {
      throw new Error(
        "Unauthorized. Your token may be expired or missing scopes." + detail
      );
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
  const data = await getTop("artists", { time_range, limit: `${capped}` });
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
  return apiGET("/v1/me/player/recently-played", {
    limit: `${clamp(limit, 1, 50)}`,
  });
}

// --- Renderers
function renderTopTracks(items = []) {
  if (!items.length) return renderEmpty("No top tracks found.");
  items.forEach((t, i) => {
    const artists = (t.artists || []).map((a) => a.name).join(", ");
    const album = t.album?.name || "";
    const img = t.album?.images?.[0]?.url || "";
    const ms = t.duration_ms || 0;
    addItem({
      title: `${pad(i + 1)}. ${t.name}`,
      img,
      lines: [
        `Artists: ${artists}`,
        album ? `Album: ${album}` : "",
        `Popularity: ${t.popularity}`,
        `Duration: ${fmtDuration(ms)}`,
      ],
    });
  });
}

function renderTopArtists(items = []) {
  if (!items.length) return renderEmpty("No top artists found.");
  items.forEach((a, i) => {
    const genres = (a.genres || []).slice(0, 5).join(", ");
    const img = a.images?.[0]?.url || "";
    addItem({
      title: `${pad(i + 1)}. ${a.name}`,
      img,
      lines: [
        genres ? `Genres: ${genres}` : "",
        `Followers: ${num(a.followers?.total)}`,
        `Popularity: ${a.popularity}`,
      ],
    });
  });
}

function renderTopGenres(genres = []) {
  if (!genres.length)
    return renderEmpty("No genres computed (need top artists).");
  genres.slice(0, 50).forEach((g, i) => {
    addItem({
      title: `${pad(i + 1)}. ${titleCase(g.genre)}`,
      lines: [`Count among top artists: ${g.count}`],
    });
  });
}

function renderRecentlyPlayed(items = []) {
  if (!items.length)
    return renderEmpty("No recent plays found (or scope missing).");
  items.forEach((it, i) => {
    const t = it.track || {};
    const artists = (t.artists || []).map((a) => a.name).join(", ");
    const playedAt = it.played_at
      ? new Date(it.played_at).toLocaleString()
      : "";
    const img = t.album?.images?.[0]?.url || "";
    addItem({
      title: `${pad(i + 1)}. ${t.name || "Unknown Track"}`,
      img,
      lines: [
        `Artists: ${artists}`,
        t.album?.name ? `Album: ${t.album.name}` : "",
        playedAt ? `Played at: ${playedAt}` : "",
      ],
    });
  });
}

function renderEmpty(msg) {
  const div = document.createElement("div");
  div.className = "item";
  div.innerHTML = `<div class="title">${escapeHTML(msg)}</div>`;
  els.out.appendChild(div);
}

// --- Utilities
function addItem({ title, lines = [], img }) {
  const div = document.createElement("div");
  div.className = "item";

  const meta = lines
    .filter(Boolean)
    .map((l) => `<span class="badge">${escapeHTML(l)}</span>`)
    .join(" ");

  div.innerHTML = `
    ${img ? `<img src="${img}" alt="" class="thumb" />` : ""}
    <div class="content">
      <div class="title">${escapeHTML(title)}</div>
      <div class="meta">${meta}</div>
    </div>
  `;

  els.out.appendChild(div);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function num(n) {
  return (n ?? 0).toLocaleString();
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
function escapeHTML(s = "") {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}

// Try to read scopes from JWT payload if provided in token (some providers do this). Fallback: warn manually.
function parseJWTScopes(token) {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
      );
      const sc = payload.scope || payload.scp || payload.scopes || "";
      if (typeof sc === "string") return sc.split(/\s+/);
      if (Array.isArray(sc)) return sc;
    }
  } catch {}
  return [];
}

function scopeHints(scopes) {
  const needTop = "user-top-read";
  const needRecent = "user-read-recently-played";
  const needPlaylist = ["playlist-modify-private", "playlist-modify-public"];

  const hasTop = scopes.includes(needTop);
  const hasRecent = scopes.includes(needRecent);
  const hasPlaylist = needPlaylist.some((s) => scopes.includes(s));

  let msgs = [];
  if (!hasTop) msgs.push(`Top data requires <code>${needTop}</code>.`);
  if (els.mode.value === "recently-played" && !hasRecent)
    msgs.push(`Recently Played requires <code>${needRecent}</code>.`);
  if (els.mode.value === "top5-playlist" && !hasPlaylist)
    msgs.push(
      `Creating a playlist requires <code>playlist-modify-private</code> (or <code>playlist-modify-public</code>).`
    );
  if (msgs.length) {
    els.scopeWarning.innerHTML = msgs.join(" ");
    els.scopeWarning.classList.remove("hidden");
  } else {
    els.scopeWarning.classList.add("hidden");
  }
}

// Download JSON
function makeDownload(obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  els.btnDownload.disabled = false;
  els.btnDownload.onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `spotify_${els.mode.value}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

async function apiPOST(path, body) {
  const token = (els.token.value || "").trim();
  if (!token) throw new Error("Please paste a Spotify access token.");
  const url = new URL("https://api.spotify.com" + path);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error ? ` (${j.error.status}: ${j.error.message})` : "";
    } catch {}
    throw new Error(`Request failed: ${res.status}${detail}`);
  }
  return res.json();
}

// Batch fetch audio features (100 ids max per call)
async function getAudioFeatures(ids = []) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const out = [];
  for (const chunk of chunks) {
    const data = await apiGET("/v1/audio-features", { ids: chunk.join(",") });
    if (data?.audio_features) out.push(...data.audio_features.filter(Boolean));
  }
  return out;
}

function averageAudioFeatures(features = []) {
  if (!features.length) return null;
  const keys = [
    "danceability",
    "energy",
    "valence",
    "acousticness",
    "instrumentalness",
    "liveness",
  ];
  const sums = Object.fromEntries(keys.map((k) => [k, 0]));
  features.forEach((f) => keys.forEach((k) => (sums[k] += f?.[k] ?? 0)));
  const avg = Object.fromEntries(
    keys.map((k) => [k, sums[k] / features.length])
  );
  return avg;
}

function labelForRange(r) {
  return r === "short_term"
    ? "Last 4 weeks"
    : r === "medium_term"
    ? "Last 6 months"
    : "All time";
}

// Era breakdown from track album release dates
function computeEraBreakdown(tracks = []) {
  const buckets = new Map(); // '1970s' => count
  const toEra = (year) => {
    const y = Number(year);
    if (!y || isNaN(y)) return "Unknown";
    const decade = Math.floor(y / 10) * 10;
    return `${decade}s`;
  };
  for (const t of tracks) {
    const d = t.album?.release_date || "";
    const y = d.slice(0, 4); // works for YYYY or YYYY-MM-DD
    const era = toEra(y);
    buckets.set(era, (buckets.get(era) || 0) + 1);
  }
  // Sort by numeric decade where possible, Unknown last
  const entries = Array.from(buckets.entries());
  entries.sort((a, b) => {
    const av = a[0] === "Unknown" ? 1e9 : parseInt(a[0]);
    const bv = b[0] === "Unknown" ? 1e9 : parseInt(b[0]);
    return av - bv;
  });
  const total = tracks.length || 1;
  return entries.map(([era, count]) => ({
    era,
    count,
    pct: Math.round((count / total) * 100),
  }));
}

function renderAudioRadar(avg, { title } = {}) {
  if (!avg) return renderEmpty("No audio features available.");
  // Prepare metrics (0..1)
  const metrics = [
    { key: "danceability", label: "Dance" },
    { key: "energy", label: "Energy" },
    { key: "valence", label: "Valence" },
    { key: "acousticness", label: "Acoustic" },
    { key: "instrumentalness", label: "Instr." },
    { key: "liveness", label: "Live" },
  ];
  const values = metrics.map((m) => Math.max(0, Math.min(1, avg[m.key] ?? 0)));
  const size = 260,
    cx = size / 2,
    cy = size / 2,
    r = size * 0.38,
    N = metrics.length;

  // Build polygon points
  const pts = values
    .map((v, i) => {
      const ang = (Math.PI * 2 * i) / N - Math.PI / 2; // start at top
      const rr = r * v;
      return `${cx + rr * Math.cos(ang)},${cy + rr * Math.sin(ang)}`;
    })
    .join(" ");

  const rings = 5;
  const ringCircles = Array.from({ length: rings }, (_, i) => {
    const rr = r * ((i + 1) / rings);
    return `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="currentColor" opacity="0.15"/>`;
  }).join("");

  const spokes = metrics
    .map((m, i) => {
      const ang = (Math.PI * 2 * i) / N - Math.PI / 2;
      const x = cx + r * Math.cos(ang),
        y = cy + r * Math.sin(ang);
      const lx = cx + (r + 16) * Math.cos(ang),
        ly = cy + (r + 16) * Math.sin(ang);
      const label = `${m.label} ${(values[i] * 100) | 0}`;
      return `
      <line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="currentColor" opacity="0.2"/>
      <text x="${lx}" y="${ly}" font-size="10" text-anchor="${
        Math.cos(ang) > 0.1 ? "start" : Math.cos(ang) < -0.1 ? "end" : "middle"
      }"
            alignment-baseline="middle">${escapeHTML(label)}</text>
    `;
    })
    .join("");

  const svg = `
    <div class="item">
      <div class="title">${escapeHTML(title || "Audio Feature Radar")}</div>
      <div class="meta"></div>
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="max-width:100%">
        ${ringCircles}
        ${spokes}
        <polygon points="${pts}" fill="currentColor" opacity="0.18"></polygon>
        <polyline points="${pts} ${
    pts.split(" ")[0]
  }" fill="none" stroke="currentColor" stroke-width="2"></polyline>
        <circle cx="${cx}" cy="${cy}" r="2" fill="currentColor"></circle>
      </svg>
    </div>
  `;
  const wrap = document.createElement("div");
  wrap.innerHTML = svg;
  els.out.appendChild(wrap.firstElementChild);
}

function renderEraBreakdown(eras = [], { title } = {}) {
  if (!eras.length) return renderEmpty("No era data.");
  // Simple bar chart with CSS
  const max = Math.max(...eras.map((e) => e.count));
  const div = document.createElement("div");
  div.className = "item";
  div.innerHTML = `<div class="title">${escapeHTML(
    title || "Era Breakdown"
  )}</div>`;
  const content = document.createElement("div");
  content.className = "content";
  eras.forEach((e) => {
    const w = max ? Math.round((e.count / max) * 100) : 0;
    const row = document.createElement("div");
    row.style.margin = "6px 0";
    row.innerHTML = `
      <div class="meta" style="display:flex; gap:8px; align-items:center;">
        <div style="min-width:56px">${escapeHTML(e.era)}</div>
        <div style="flex:1; background: currentColor; opacity: .15; height: 10px; border-radius: 4px; position: relative;">
          <div style="width:${w}%; height: 10px; background: currentColor; opacity:.35; border-radius: 4px;"></div>
        </div>
        <span class="badge">${e.count} • ${e.pct}%</span>
      </div>
    `;
    content.appendChild(row);
  });
  div.appendChild(content);
  els.out.appendChild(div);
}

// Fetch up to N top tracks (N ≤ 100) in 50-item pages
async function getTopTracksUpTo(n, time_range) {
  const wanted = clamp(n, 1, 100);
  const out = [];
  // Spotify max per call = 50; use offsets 0 and 50 if needed
  const first = await getTop('tracks', { time_range, limit: 50, offset: 0 });
  out.push(...(first.items || []));
  if (wanted > 50) {
    const second = await getTop('tracks', { time_range, limit: wanted - 50, offset: 50 });
    out.push(...(second.items || []));
  }
  return out.slice(0, wanted);
}

// Add tracks (URIs) to a playlist in batches of up to 100 per request
async function addTracksInBatches(playlistId, uris = []) {
  const batchSize = 100; // Spotify allows up to 100 per add call
  for (let i = 0; i < uris.length; i += batchSize) {
    const chunk = uris.slice(i, i + batchSize);
    await apiPOST(`/v1/playlists/${playlistId}/tracks`, { uris: chunk });
  }
}

