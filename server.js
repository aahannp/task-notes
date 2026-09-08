// Simple local task/notes app — zero dependencies, Node built-ins only.
// Stores one JSON file per day in ./data/YYYY-MM-DD.json
// Run: node server.js   then open http://localhost:4321

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// --- Spotify (local desktop app control via AppleScript; macOS only) ---
function runOsa(script, cb) {
  execFile('osascript', ['-e', script], { timeout: 4000 }, (err, stdout, stderr) => {
    cb(err, (stdout || '').trim(), (stderr || '').trim());
  });
}
const SPOTIFY_READ = [
  'tell application "Spotify"',
  '  if it is running then',
  '    set tn to ""',
  '    set ta to ""',
  '    set td to 0',
  '    set tp to 0',
  '    set aUrl to ""',
  '    set aAlbum to ""',
  '    set aId to ""',
  '    try',
  '      set tn to name of current track',
  '      set ta to artist of current track',
  '      set td to (duration of current track) / 1000',
  '      set tp to player position',
  '      set aUrl to artwork url of current track',
  '      set aAlbum to album of current track',
  '      set aId to id of current track',
  '    end try',
  '    return (player state as text) & "||" & tn & "||" & ta & "||" & td & "||" & tp & "||" & aUrl & "||" & aAlbum & "||" & aId & "||" & (sound volume as text) & "||" & (shuffling as text) & "||" & (repeating as text)',
  '  else',
  '    return "notrunning"',
  '  end if',
  'end tell',
].join('\n');
const SPOTIFY_ACTIONS = { playpause: 'playpause', next: 'next track', previous: 'previous track' };

// Spotify Web API search needs app credentials (client-credentials flow, no user login).
// Read from env or <DATA_DIR>/spotify.json = { "clientId": "...", "clientSecret": "..." }
function spotifyCreds() {
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    return { id: process.env.SPOTIFY_CLIENT_ID, secret: process.env.SPOTIFY_CLIENT_SECRET };
  }
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'spotify.json'), 'utf8'));
    if (c.clientId && c.clientSecret) return { id: c.clientId, secret: c.clientSecret };
  } catch {}
  return null;
}
let spTokenCache = { token: null, exp: 0 };
function spotifyToken(cb) {
  if (spTokenCache.token && Date.now() < spTokenCache.exp) return cb(null, spTokenCache.token);
  const creds = spotifyCreds();
  if (!creds) return cb(new Error('no-creds'));
  const body = 'grant_type=client_credentials';
  const req = https.request({
    hostname: 'accounts.spotify.com', path: '/api/token', method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(creds.id + ':' + creds.secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (j.access_token) { spTokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 }; return cb(null, j.access_token); }
        cb(new Error('token-failed'));
      } catch { cb(new Error('token-parse')); }
    });
  });
  req.on('error', cb); req.end(body);
}
// --- Spotify user auth (to like/save tracks — needs the user to log in once) ---
const SPOTIFY_REDIRECT = 'http://127.0.0.1:4321/callback';
const SPOTIFY_SCOPE = 'user-library-modify user-library-read playlist-read-private playlist-read-collaborative';
function userTokenFile() { return path.join(DATA_DIR, 'spotify-user.json'); }
function readUserTok() { try { return JSON.parse(fs.readFileSync(userTokenFile(), 'utf8')); } catch { return null; } }
function writeUserTok(o) { try { writeAtomic(userTokenFile(), JSON.stringify(o, null, 2)); } catch {} }

function httpsJson(opts, body, cb) {
  const req = https.request(opts, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => {
      let j = null; try { j = d ? JSON.parse(d) : {}; } catch {}
      cb(null, r.statusCode, j, d);
    });
  });
  req.on('error', cb);
  if (body) req.write(body);
  req.end();
}
function tokenPost(form, cb) {
  const creds = spotifyCreds();
  if (!creds) return cb(new Error('no-creds'));
  const body = new URLSearchParams(form).toString();
  httpsJson({
    hostname: 'accounts.spotify.com', path: '/api/token', method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(creds.id + ':' + creds.secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body, (err, code, j) => cb(err, j));
}
// Return a valid user access token, refreshing if needed.
function spotifyUserToken(cb) {
  const t = readUserTok();
  if (!t || !t.refreshToken) return cb(new Error('no-auth'));
  if (t.accessToken && Date.now() < (t.exp || 0)) return cb(null, t.accessToken);
  tokenPost({ grant_type: 'refresh_token', refresh_token: t.refreshToken }, (err, j) => {
    if (err || !j || !j.access_token) return cb(err || new Error('refresh-failed'));
    const nt = { refreshToken: j.refresh_token || t.refreshToken, accessToken: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    writeUserTok(nt);
    cb(null, nt.accessToken);
  });
}
function trackIdFromUri(uri) { const m = /spotify:track:([A-Za-z0-9]+)/.exec(uri || ''); return m ? m[1] : null; }

function spotifySearch(q, cb) {
  spotifyToken((err, token) => {
    if (err) return cb(err);
    const p = '/v1/search?type=track,album,playlist&limit=6&q=' + encodeURIComponent(q);
    https.get({ hostname: 'api.spotify.com', path: p, headers: { Authorization: 'Bearer ' + token } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => {
        try {
          const j = JSON.parse(d);
          const img = (arr) => (arr && arr[0] && arr[0].url) || '';
          const tracks = ((j.tracks && j.tracks.items) || []).map((t) => ({
            type: 'track', name: t.name, sub: (t.artists || []).map((a) => a.name).join(', '), uri: t.uri, image: img(t.album && t.album.images),
          }));
          const albums = ((j.albums && j.albums.items) || []).map((a) => ({
            type: 'album', name: a.name, sub: (a.artists || []).map((x) => x.name).join(', '), uri: a.uri, image: img(a.images),
          }));
          const playlists = ((j.playlists && j.playlists.items) || []).filter(Boolean).map((pl) => ({
            type: 'playlist', name: pl.name, sub: (pl.owner && pl.owner.display_name) || 'Playlist', uri: pl.uri, image: img(pl.images),
          }));
          cb(null, [...tracks.slice(0, 5), ...albums.slice(0, 3), ...playlists.slice(0, 3)]);
        } catch { cb(new Error('search-parse')); }
      });
    }).on('error', cb);
  });
}

const PORT = process.env.PORT || 4321;
// Data dir is overridable (the desktop app points this at a writable folder outside the app bundle).
const DATA_DIR = process.env.TASKNOTES_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Only allow clean YYYY-MM-DD to avoid path traversal.
function safeDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function fileFor(date) {
  return path.join(DATA_DIR, `${date}.json`);
}

function readTasks(date) {
  const f = fileFor(date);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
}

// Atomic write: write to a temp file then rename, so concurrent readers
// never observe a half-written (unparseable) file.
function writeAtomic(file, str) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, file);
}

function writeTasks(date, tasks) {
  writeAtomic(fileFor(date), JSON.stringify(tasks, null, 2));
}

function isoDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function daysInRange(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end) { out.push(isoDate(d)); d.setDate(d.getDate() + 1); }
  return out;
}

// Active seconds of one focus session (supports pause/resume + legacy shapes).
function sessionSec(s) {
  if (s.end != null) {
    if (typeof s.seconds === 'number') return s.seconds;
    if (typeof s.accumulatedSec === 'number') return s.accumulatedSec;
    return s.start ? (s.end - s.start) / 1000 : 0;
  }
  if ('accumulatedSec' in s) {
    return (s.accumulatedSec || 0) + (s.runningSince ? (Date.now() - s.runningSince) / 1000 : 0);
  }
  return s.start ? (Date.now() - s.start) / 1000 : 0; // legacy open session
}

// Total focused seconds for a day, from the session log.
function metaFocusSeconds(meta) {
  if (Array.isArray(meta.sessions)) return meta.sessions.reduce((sum, s) => sum + sessionSec(s), 0);
  return meta.focusSeconds || 0;
}

function metaFileFor(date) {
  return path.join(DATA_DIR, `${date}.meta.json`);
}

function readMeta(date) {
  const f = metaFileFor(date);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

function writeMeta(date, meta) {
  writeAtomic(metaFileFor(date), JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Collections: long-lived stores that aren't tied to a single day.
// projects / learning / ideas / activity / reviews each live in their own file.
// ---------------------------------------------------------------------------
const COLLECTIONS = {
  projects: 'projects.json',
  learning: 'learning.json',
  ideas: 'ideas.json',
  activity: 'activity.json',
  reviews: 'reviews.json',
  captures: 'captures.json',
};
// reviews is an object keyed by week-start; everything else is an array.
const OBJECT_COLLECTIONS = new Set(['reviews']);

function collectionFile(name) { return path.join(DATA_DIR, COLLECTIONS[name]); }
function readCollection(name) {
  const empty = OBJECT_COLLECTIONS.has(name) ? {} : [];
  try {
    const v = JSON.parse(fs.readFileSync(collectionFile(name), 'utf8'));
    if (OBJECT_COLLECTIONS.has(name)) return (v && typeof v === 'object' && !Array.isArray(v)) ? v : empty;
    return Array.isArray(v) ? v : empty;
  } catch { return empty; }
}
function writeCollection(name, value) {
  writeAtomic(collectionFile(name), JSON.stringify(value, null, 2));
}

// One-time migration: the old projects.json held projects, learning items and
// ideas together (distinguished by `type`). Split them into their own stores,
// preserving every field, and leave a marker so this only ever runs once.
function migrateStores() {
  const marker = path.join(DATA_DIR, '.migrated-v2');
  if (fs.existsSync(marker)) return;
  const all = readCollection('projects');
  // The marker alone is not enough to decide this. A data directory can easily
  // arrive without it — restored from a backup, copied by hand, or pointed at
  // by TASKNOTES_DATA — and rewriting an already-migrated store through the v1
  // mapping below reads `desc` out of `note` and `due` out of `deadline`, which
  // for a v2 record means blanking the real ones. So the shape decides, and a
  // store with nothing legacy in it is only marked, never rewritten.
  const isLegacy = (p) => p && (p.type !== undefined || p.note !== undefined || p.deadline !== undefined)
    && p.desc === undefined && p.learningIds === undefined;
  const legacy = all.filter(isLegacy).length ? all : [];
  if (legacy.length) {
    const projects = [], learning = [], ideas = [];
    legacy.forEach((p) => {
      if (p.type === 'learning') {
        learning.push({
          id: p.id, name: p.title || '', desc: p.note || '', want: '', why: '', context: '',
          source: '', priority: 'normal', status: p.status === 'done' ? 'learned' : p.status === 'active' ? 'learning' : p.status === 'hold' ? 'paused' : 'bag',
          tags: [], notes: p.note || '', createdAt: p.createdAt || Date.now(), lastStudied: null,
          totalSeconds: p.focusSeconds || 0, projectId: null, deadline: p.deadline || '',
          expectedMin: p.expectedMin || null, parts: Array.isArray(p.subs) ? p.subs : [], sessions: [],
        });
      } else if (p.type === 'idea') {
        ideas.push({
          id: p.id, title: p.title || '', desc: p.note || '', notes: '', tags: [],
          status: p.status === 'done' ? 'archived' : 'captured',
          createdAt: p.createdAt || Date.now(), updatedAt: p.createdAt || Date.now(),
          convertedProjectId: null, sparks: Array.isArray(p.subs) ? p.subs : [],
        });
      } else {
        // A mixed store can hold records that are already v2; those keep what
        // they have rather than being mapped through the v1 field names.
        projects.push({
          id: p.id, title: p.title || '', desc: p.desc || p.note || '',
          status: p.status === 'backlog' ? 'planned' : (p.status || 'planned'),
          start: p.start || '', due: p.due || p.deadline || '', notes: p.notes || p.note || '',
          learningIds: Array.isArray(p.learningIds) ? p.learningIds : [],
          createdAt: p.createdAt || Date.now(), updatedAt: p.updatedAt || Date.now(),
          focusSeconds: p.focusSeconds || 0, subs: Array.isArray(p.subs) ? p.subs : [],
        });
      }
    });
    writeCollection('projects', projects);
    if (learning.length) writeCollection('learning', learning);
    if (ideas.length) writeCollection('ideas', ideas);
  }
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
}
migrateStores();

// ---------------------------------------------------------------------------
// DOCUMENTS — a markdown knowledge store.
//
// Adapted from central-dashboard's document handler: metadata and body are
// stored apart so listing never has to read document bodies (their
// `defer(Document.content)`), edits carry a `baseVersion` for optimistic
// concurrency (their 409-on-mismatch), and every save snapshots a version.
// Bodies live one-file-per-document as plain .md you can read outside the app.
// ---------------------------------------------------------------------------
const DOCS_DIR = () => path.join(DATA_DIR, 'docs');
const ASSETS_DIR = () => path.join(DATA_DIR, 'assets');
const MAX_DOC_BYTES = 4 * 1024 * 1024;      // matches the reference's content cap
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
function docIdOk(id) { return /^[A-Za-z0-9_-]{1,64}$/.test(id || ''); }
function docBodyFile(id) { return path.join(DOCS_DIR(), id + '.md'); }
function docVersionsFile(id) { return path.join(DOCS_DIR(), id + '.versions.json'); }

function readDocBody(id) {
  try { return fs.readFileSync(docBodyFile(id), 'utf8'); } catch { return ''; }
}
function writeDocBody(id, content) {
  ensureDir(DOCS_DIR());
  writeAtomic(docBodyFile(id), content == null ? '' : String(content));
}
function readDocVersions(id) {
  try { const v = JSON.parse(fs.readFileSync(docVersionsFile(id), 'utf8')); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
// Snapshot the state we are leaving behind, newest first, capped so a long-
// lived document cannot grow its history without bound.
function snapshotDocVersion(id, meta, content) {
  const versions = readDocVersions(id);
  versions.unshift({
    version: meta.version || 1, title: meta.title || '', content: content || '',
    tags: Array.isArray(meta.tags) ? meta.tags.slice() : [], at: Date.now(),
  });
  if (versions.length > 30) versions.length = 30;
  try { ensureDir(DOCS_DIR()); writeAtomic(docVersionsFile(id), JSON.stringify(versions)); } catch {}
}
function deleteDocFiles(id) {
  [docBodyFile(id), docVersionsFile(id)].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  try { fs.rmSync(path.join(ASSETS_DIR(), id), { recursive: true, force: true }); } catch {}
}

// Everything a list view needs — deliberately without the body.
function docSummary(d) {
  return {
    id: d.id, title: d.title || 'Untitled', tags: d.tags || [], folder: d.folder || '',
    status: d.status || 'active', pinned: !!d.pinned,
    projectId: d.projectId || null, learningId: d.learningId || null,
    taskId: d.taskId || null, ideaId: d.ideaId || null,
    version: d.version || 1, createdAt: d.createdAt, updatedAt: d.updatedAt,
    archivedAt: d.archivedAt || null,
  };
}

const ASSET_TYPES = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
};
const ASSET_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' };

function readBody(req, cb, limit) {
  let body = '';
  let over = false;
  req.on('data', (c) => {
    if (over) return;
    body += c;
    if (body.length > (limit || MAX_DOC_BYTES) * 1.4) { over = true; cb(new Error('too large')); }
  });
  req.on('end', () => { if (!over) cb(null, body); });
}

// ---------------------------------------------------------------------------
// CALENDAR — read-only view of the user's real calendars via EventKit.
//
// Driving Calendar.app over Apple events takes ~11s for one week even when it
// returns nothing, so a small compiled helper (helpers/tn-calendar) answers the
// same query in milliseconds and works whether or not Calendar.app is running.
// Nothing here writes to a calendar, and no event data leaves the machine.
// ---------------------------------------------------------------------------
function calendarHelperPath() {
  // Packaged, the binary sits in the app bundle's Resources; in development it
  // is next to the source.
  const candidates = [
    process.env.TASKNOTES_CAL_HELPER,
    process.resourcesPath ? path.join(process.resourcesPath, 'helpers', 'tn-calendar') : null,
    path.join(__dirname, 'helpers', 'tn-calendar'),
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const CAL_TIMEOUT_MS = 25000;
function runCalendarHelper(args, cb) {
  const bin = calendarHelperPath();
  if (!bin) return cb(null, { error: 'helper-missing' });
  execFile(bin, args, { timeout: CAL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    let parsed = null;
    try { parsed = JSON.parse(String(stdout || '').trim()); } catch {}
    if (parsed) {
      // Normalise the helper's message into a stable code the UI can branch on.
      if (parsed.error && /not granted/i.test(parsed.error)) parsed.error = 'not-granted';
      return cb(null, parsed);
    }
    // Exit code 2 is our "not granted" signal; anything else is unexpected.
    if (err && err.killed) return cb(null, { error: 'timeout' });
    return cb(null, { error: (err && err.code === 2) ? 'not-granted' : 'helper-failed' });
  });
}

// Short-lived cache: the agenda is polled, and a fresh EventKit query per poll
// is wasteful when meetings change on the order of minutes.
const calCache = new Map();
const CAL_CACHE_MS = 60 * 1000;
function calCacheGet(key) {
  const hit = calCache.get(key);
  if (hit && Date.now() - hit.at < CAL_CACHE_MS) return hit.value;
  return null;
}
function calCacheSet(key, value) {
  calCache.set(key, { at: Date.now(), value });
  if (calCache.size > 60) calCache.delete(calCache.keys().next().value);
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  // Strip the query BEFORE testing for the root, so "/?x=1" still serves the app.
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // API: /api/tasks?date=YYYY-MM-DD
  if (u.pathname === '/api/tasks') {
    const date = safeDate(u.searchParams.get('date'));
    if (!date) return sendJSON(res, 400, { error: 'bad date' });

    if (req.method === 'GET') {
      return sendJSON(res, 200, { date, tasks: readTasks(date) });
    }

    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const tasks = JSON.parse(body);
          if (!Array.isArray(tasks)) throw new Error('not array');
          writeTasks(date, tasks);
          sendJSON(res, 200, { ok: true });
        } catch {
          sendJSON(res, 400, { error: 'bad body' });
        }
      });
      return;
    }

    res.writeHead(405);
    return res.end('Method not allowed');
  }

  // API: /api/meta?date=YYYY-MM-DD  — per-day info (login/logout/location/focus)
  if (u.pathname === '/api/meta') {
    const date = safeDate(u.searchParams.get('date'));
    if (!date) return sendJSON(res, 400, { error: 'bad date' });

    if (req.method === 'GET') {
      return sendJSON(res, 200, { date, meta: readMeta(date) });
    }

    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const meta = JSON.parse(body);
          if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('not object');
          writeMeta(date, meta);
          sendJSON(res, 200, { ok: true });
        } catch {
          sendJSON(res, 400, { error: 'bad body' });
        }
      });
      return;
    }

    res.writeHead(405);
    return res.end('Method not allowed');
  }

  // API: /api/summary?from=YYYY-MM-DD&to=YYYY-MM-DD — aggregate stats over a range
  if (u.pathname === '/api/summary' && req.method === 'GET') {
    const from = safeDate(u.searchParams.get('from'));
    const to = safeDate(u.searchParams.get('to'));
    if (!from || !to) return sendJSON(res, 400, { error: 'bad range' });

    let totalFocus = 0, office = 0, home = 0, finished = 0, total = 0, workedMins = 0;
    let estMin = 0, actualFocusSec = 0, estCount = 0;
    const perDay = daysInRange(from, to).map((date) => {
      const tasks = readTasks(date);
      const m = readMeta(date);
      const f = metaFocusSeconds(m);
      const fin = tasks.filter((t) => (t.status || (t.done ? 'done' : 'todo')) === 'done').length;
      totalFocus += f; total += tasks.length; finished += fin;

      // Estimate accuracy: for finished tasks that had an estimate, compare to focused time
      const sessions = Array.isArray(m.sessions) ? m.sessions : [];
      tasks.forEach((t) => {
        const status = t.status || (t.done ? 'done' : 'todo');
        if (status === 'done' && t.estimateMin) {
          estMin += t.estimateMin;
          actualFocusSec += sessions.filter((s) => s.taskId === t.id).reduce((a, s) => a + sessionSec(s), 0);
          estCount++;
        }
      });
      if (m.location === 'office') office++;
      if (m.location === 'home') home++;
      let wm = 0;
      if (m.login && m.logout) {
        const [lh, lm] = m.login.split(':').map(Number);
        const [oh, om] = m.logout.split(':').map(Number);
        wm = Math.max(0, (oh * 60 + om) - (lh * 60 + lm));
        workedMins += wm;
      }
      const dow = new Date(date + 'T00:00:00').getDay();
      const effType = (m.dayType === 'work' || m.dayType === 'off') ? m.dayType : ((dow === 0 || dow === 6) ? 'off' : 'work');
      return { date, dow, dayType: effType, offLabel: m.offLabel || '',
               focusSeconds: f, finished: fin, total: tasks.length,
               location: m.location || '', login: m.login || '', logout: m.logout || '', workedMins: wm };
    });
    return sendJSON(res, 200, {
      from, to, totalFocusSeconds: totalFocus, workedMins,
      officeDays: office, homeDays: home, finished, total, perDay,
      estimatedMin: estMin, actualFocusedSec: actualFocusSec, estimatedCount: estCount,
    });
  }

  // API: /api/spotify/search?q=…  → catalog search (needs app credentials)
  if (u.pathname === '/api/spotify/search' && req.method === 'GET') {
    const q = (u.searchParams.get('q') || '').trim();
    if (!spotifyCreds()) return sendJSON(res, 200, { needsSetup: true, results: [] });
    if (!q) return sendJSON(res, 200, { results: [] });
    return spotifySearch(q, (err, results) => {
      if (err) return sendJSON(res, 200, { error: err.message, results: [] });
      sendJSON(res, 200, { results });
    });
  }

  // API: /api/spotify/play?uri=spotify:track:…  → play a specific track in the desktop app
  if (u.pathname === '/api/spotify/play' && req.method === 'POST') {
    if (process.platform !== 'darwin') return sendJSON(res, 200, { ok: false, supported: false });
    const uri = u.searchParams.get('uri') || '';
    if (!/^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/.test(uri)) return sendJSON(res, 400, { error: 'bad uri' });
    // Play the track but keep the user where they are — capture the frontmost app,
    // play in Spotify, then restore focus so we don't yank them into Spotify.
    const playScript = [
      'set prevApp to (path to frontmost application as text)',
      `tell application "Spotify" to play track "${uri}"`,
      'try',
      '  tell application prevApp to activate',
      'end try',
    ].join('\n');
    return runOsa(playScript, (err, out, serr) => {
      if (err) {
        const denied = /-1743|not authoriz/i.test(serr + ' ' + (err.message || ''));
        return sendJSON(res, 200, { ok: false, needsPermission: denied });
      }
      sendJSON(res, 200, { ok: true });
    });
  }

  // The user's own playlists
  if (u.pathname === '/api/spotify/myplaylists' && req.method === 'GET') {
    return spotifyUserToken((err, token) => {
      if (err) return sendJSON(res, 200, { needsAuth: true, playlists: [] });
      httpsJson({ hostname: 'api.spotify.com', path: '/v1/me/playlists?limit=50', headers: { Authorization: 'Bearer ' + token } },
        null, (e, code, j) => {
          if (code === 403) return sendJSON(res, 200, { restricted: true, playlists: [] });
          const playlists = ((j && j.items) || []).filter(Boolean).map((pl) => ({
            type: 'playlist', name: pl.name, uri: pl.uri,
            sub: 'Playlist · ' + ((pl.owner && pl.owner.display_name) || ''),
            image: (pl.images && pl.images[0] && pl.images[0].url) || '',
          }));
          sendJSON(res, 200, { playlists });
        });
    });
  }

  // Spotify user login: redirect to the consent screen
  if (u.pathname === '/api/spotify/auth' && req.method === 'GET') {
    const creds = spotifyCreds();
    if (!creds) return sendJSON(res, 200, { needsSetup: true });
    const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: creds.id, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT, scope: SPOTIFY_SCOPE, show_dialog: 'true',
    }).toString();
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  // OAuth callback: exchange the code for tokens and store them
  if (u.pathname === '/callback' && req.method === 'GET') {
    const code = u.searchParams.get('code');
    if (!code) { res.writeHead(400); return res.end('Missing code'); }
    return tokenPost({ grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT }, (err, j) => {
      const ok = !err && j && j.refresh_token;
      if (ok) writeUserTok({ refreshToken: j.refresh_token, accessToken: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset=utf8><body style="background:#0b0c11;color:#eef0f7;font-family:-apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:44px">${ok ? '💚' : '⚠️'}</div><h2>${ok ? 'Connected to Spotify!' : 'Could not connect'}</h2><p style="color:#a6adbf">${ok ? 'You can close this tab and go back to Task Notes.' : 'Please try again.'}</p></div>`);
    });
  }

  // Like / unlike the current (or given) track
  if (u.pathname === '/api/spotify/like' && (req.method === 'POST' || req.method === 'DELETE')) {
    const id = trackIdFromUri(u.searchParams.get('uri'));
    if (!id) return sendJSON(res, 400, { error: 'bad uri' });
    return spotifyUserToken((err, token) => {
      if (err) return sendJSON(res, 200, { needsAuth: true });
      httpsJson({
        hostname: 'api.spotify.com', path: '/v1/me/tracks?ids=' + id, method: req.method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Length': 0 },
      }, null, (e, code) => sendJSON(res, 200, {
        ok: code >= 200 && code < 300, liked: req.method === 'POST',
        status: code, restricted: code === 403,
      }));
    });
  }

  // Is the current (or given) track already liked?
  if (u.pathname === '/api/spotify/liked' && req.method === 'GET') {
    const id = trackIdFromUri(u.searchParams.get('uri'));
    if (!id) return sendJSON(res, 200, { liked: false, authed: !!readUserTok() });
    return spotifyUserToken((err, token) => {
      if (err) return sendJSON(res, 200, { liked: false, authed: false });
      httpsJson({ hostname: 'api.spotify.com', path: '/v1/me/tracks/contains?ids=' + id, headers: { Authorization: 'Bearer ' + token } },
        null, (e, code, j) => sendJSON(res, 200, { liked: Array.isArray(j) && j[0] === true, authed: true }));
    });
  }

  // API: /api/spotify — GET current track; POST ?action=playpause|next|previous
  if (u.pathname === '/api/spotify') {
    if (process.platform !== 'darwin') return sendJSON(res, 200, { running: false, supported: false });

    const readAndSend = () => runOsa(SPOTIFY_READ, (err, out, serr) => {
      if (err) {
        const denied = /-1743|not authoriz/i.test(serr + ' ' + (err.message || ''));
        return sendJSON(res, 200, { running: false, needsPermission: denied });
      }
      if (!out || out === 'notrunning') return sendJSON(res, 200, { running: false });
      const [state, name, artist, dur, pos, art, album, uri, vol, shuf, rep] = out.split('||');
      sendJSON(res, 200, {
        running: true, state, name, artist, durationSec: +dur, positionSec: +pos,
        artworkUrl: art || '', album: album || '', uri: uri || '',
        volume: +vol, shuffling: shuf === 'true', repeating: rep === 'true',
      });
    });

    if (req.method === 'GET') return readAndSend();

    if (req.method === 'POST') {
      const a = u.searchParams.get('action');
      let cmd = null;
      if (SPOTIFY_ACTIONS[a]) cmd = `tell application "Spotify" to ${SPOTIFY_ACTIONS[a]}`;
      else if (a === 'shuffle') cmd = 'tell application "Spotify" to set shuffling to not shuffling';
      else if (a === 'repeat') cmd = 'tell application "Spotify" to set repeating to not repeating';
      else if (a === 'volume') {
        const v = Math.max(0, Math.min(100, parseInt(u.searchParams.get('value'), 10) || 0));
        cmd = `tell application "Spotify" to set sound volume to ${v}`;
      } else if (a === 'seek') {
        const p = Math.max(0, parseInt(u.searchParams.get('value'), 10) || 0);
        cmd = `tell application "Spotify" to set player position to ${p}`;
      }
      if (!cmd) return sendJSON(res, 400, { error: 'bad action' });
      return runOsa(cmd, (err, out, serr) => {
        if (err) {
          const denied = /-1743|not authoriz/i.test(serr + ' ' + (err.message || ''));
          return sendJSON(res, 200, { ok: false, needsPermission: denied });
        }
        setTimeout(readAndSend, 150);
      });
    }

    res.writeHead(405);
    return res.end('Method not allowed');
  }

  // API: /api/projects — the long-lived projects/goals/learning store
  if (u.pathname === '/api/projects') {
    const f = path.join(DATA_DIR, 'projects.json');
    if (req.method === 'GET') {
      let projects = [];
      try { projects = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      return sendJSON(res, 200, { projects: Array.isArray(projects) ? projects : [] });
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const projects = JSON.parse(body);
          if (!Array.isArray(projects)) throw new Error('not array');
          writeAtomic(f, JSON.stringify(projects, null, 2));
          sendJSON(res, 200, { ok: true });
        } catch { sendJSON(res, 400, { error: 'bad body' }); }
      });
      return;
    }
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  // API: /api/store?name=projects|learning|ideas|activity|reviews
  // Generic persistence for the long-lived stores. GET returns the whole
  // collection; PUT replaces it (the client owns the merge, same as projects).
  if (u.pathname === '/api/store') {
    const name = u.searchParams.get('name');
    if (!Object.prototype.hasOwnProperty.call(COLLECTIONS, name)) {
      return sendJSON(res, 400, { error: 'unknown collection' });
    }
    if (req.method === 'GET') {
      return sendJSON(res, 200, { name, value: readCollection(name) });
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const value = JSON.parse(body);
          const wantObject = OBJECT_COLLECTIONS.has(name);
          const ok = wantObject
            ? (value && typeof value === 'object' && !Array.isArray(value))
            : Array.isArray(value);
          if (!ok) throw new Error('shape');
          writeCollection(name, value);
          sendJSON(res, 200, { ok: true });
        } catch { sendJSON(res, 400, { error: 'bad body' }); }
      });
      return;
    }
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  // API: /api/alldays[?from=&to=] — every day's tasks + meta in one shot.
  // Powers the global Tasks view, project progress and the Weekly Review, so
  // that all of those read the *same* underlying per-day task records.
  if (u.pathname === '/api/alldays' && req.method === 'GET') {
    const from = safeDate(u.searchParams.get('from'));
    const to = safeDate(u.searchParams.get('to'));
    let dates = fs.readdirSync(DATA_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace('.json', ''))
      .sort();
    if (from) dates = dates.filter((d) => d >= from);
    if (to) dates = dates.filter((d) => d <= to);
    const days = dates.map((date) => {
      const m = readMeta(date);
      return {
        date,
        tasks: readTasks(date),
        sessions: Array.isArray(m.sessions) ? m.sessions : [],
        focusSeconds: metaFocusSeconds(m),
        dayType: m.dayType || '',
        offLabel: m.offLabel || '',
        location: m.location || '',
        learning: m.learning || null,
      };
    });
    return sendJSON(res, 200, { days });
  }

  // ---- Assets: images embedded in documents -------------------------------
  // Stored under data/assets/<docId>/ and served back from the same origin, so
  // an image survives reload and packaging (never a blob: URL).
  if (u.pathname === '/api/assets' && req.method === 'POST') {
    const docId = u.searchParams.get('doc');
    if (!docIdOk(docId)) return sendJSON(res, 400, { error: 'bad doc id' });
    readBody(req, (err, body) => {
      if (err) return sendJSON(res, 413, { error: 'file too large' });
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'bad body' }); }
      const ext = ASSET_TYPES[payload.type];
      if (!ext) return sendJSON(res, 415, { error: 'unsupported image type' });
      let buf;
      try { buf = Buffer.from(String(payload.data || ''), 'base64'); }
      catch { return sendJSON(res, 400, { error: 'bad data' }); }
      if (!buf.length) return sendJSON(res, 400, { error: 'empty file' });
      if (buf.length > MAX_ASSET_BYTES) return sendJSON(res, 413, { error: 'file too large' });
      const dir = path.join(ASSETS_DIR(), docId);
      ensureDir(dir);
      const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext;
      try { fs.writeFileSync(path.join(dir, name), buf); }
      catch { return sendJSON(res, 500, { error: 'write failed' }); }
      return sendJSON(res, 201, { url: `/assets/${docId}/${name}`, name, bytes: buf.length });
    }, MAX_ASSET_BYTES);
    return;
  }
  if (u.pathname.startsWith('/assets/') && req.method === 'GET') {
    const parts = u.pathname.split('/').filter(Boolean); // assets, docId, file
    if (parts.length !== 3 || !docIdOk(parts[1]) || !/^[A-Za-z0-9_.-]+$/.test(parts[2]) || parts[2].includes('..')) {
      res.writeHead(404); return res.end('Not found');
    }
    const file = path.join(ASSETS_DIR(), parts[1], parts[2]);
    if (!file.startsWith(ASSETS_DIR())) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': ASSET_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Served content is user-supplied; never let an SVG script run inline.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
    return;
  }

  // ---- Documents ----------------------------------------------------------
  if (u.pathname === '/api/documents') {
    const docsFile = path.join(DATA_DIR, 'documents.json');
    const readDocs = () => { try { const v = JSON.parse(fs.readFileSync(docsFile, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
    const writeDocs = (arr) => writeAtomic(docsFile, JSON.stringify(arr, null, 2));

    if (req.method === 'GET') {
      const docs = readDocs();
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      const tag = (u.searchParams.get('tag') || '').trim().toLowerCase();
      const includeArchived = u.searchParams.get('include_archived') === 'true';
      let list = docs.filter((d) => includeArchived || d.status !== 'archived');
      if (tag) list = list.filter((d) => (d.tags || []).some((t) => String(t).toLowerCase() === tag));
      ['projectId', 'learningId', 'taskId', 'ideaId'].forEach((k) => {
        const v = u.searchParams.get(k);
        if (v) list = list.filter((d) => d[k] === v);
      });
      // Free-text runs over title, tags and the body — the body is only read
      // when a query is actually present, so plain listing stays cheap.
      let out = list.map(docSummary);
      if (q) {
        out = [];
        list.forEach((d) => {
          const inTitle = (d.title || '').toLowerCase().includes(q);
          const inTags = (d.tags || []).some((t) => String(t).toLowerCase().includes(q));
          const body = readDocBody(d.id);
          const at = body.toLowerCase().indexOf(q);
          if (!inTitle && !inTags && at < 0) return;
          const s = docSummary(d);
          if (at >= 0) {
            const from = Math.max(0, at - 40);
            s.snippet = (from > 0 ? '…' : '') +
              body.slice(from, at + q.length + 60).replace(/\s+/g, ' ').trim() +
              (at + q.length + 60 < body.length ? '…' : '');
          }
          s.matchedTitle = inTitle; s.matchedTags = inTags;
          out.push(s);
        });
      }
      out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return sendJSON(res, 200, { documents: out });
    }

    if (req.method === 'POST') {
      readBody(req, (err, body) => {
        if (err) return sendJSON(res, 413, { error: 'too large' });
        let p; try { p = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'bad body' }); }
        const docs = readDocs();
        const id = (p.id && docIdOk(p.id)) ? p.id
          : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (docs.some((d) => d.id === id)) return sendJSON(res, 409, { error: 'exists' });
        const now = Date.now();
        const d = {
          id, title: (p.title || 'Untitled').slice(0, 300),
          tags: Array.isArray(p.tags) ? p.tags.slice(0, 30) : [],
          folder: p.folder || '', status: 'active', pinned: false,
          projectId: p.projectId || null, learningId: p.learningId || null,
          taskId: p.taskId || null, ideaId: p.ideaId || null,
          version: 1, createdAt: now, updatedAt: now, archivedAt: null,
        };
        docs.unshift(d);
        writeDocs(docs);
        const content = typeof p.content === 'string' ? p.content : '';
        writeDocBody(id, content);
        return sendJSON(res, 201, { document: Object.assign(docSummary(d), { content }) });
      });
      return;
    }
    res.writeHead(405); return res.end('Method not allowed');
  }

  if (u.pathname.startsWith('/api/documents/')) {
    const rest = u.pathname.slice('/api/documents/'.length).split('/');
    const id = rest[0];
    const sub = rest[1] || '';
    if (!docIdOk(id)) return sendJSON(res, 400, { error: 'bad id' });
    const docsFile = path.join(DATA_DIR, 'documents.json');
    const readDocs = () => { try { const v = JSON.parse(fs.readFileSync(docsFile, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
    const writeDocs = (arr) => writeAtomic(docsFile, JSON.stringify(arr, null, 2));
    const docs = readDocs();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: 'not found' });
    const doc = docs[idx];

    if (!sub && req.method === 'GET') {
      return sendJSON(res, 200, { document: Object.assign(docSummary(doc), { content: readDocBody(id) }) });
    }

    if (!sub && req.method === 'PUT') {
      readBody(req, (err, body) => {
        if (err) return sendJSON(res, 413, { error: 'too large' });
        let p; try { p = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'bad body' }); }
        const contentChanged = typeof p.content === 'string' && p.content !== readDocBody(id);
        const titleChanged = typeof p.title === 'string' && p.title !== doc.title;
        // Optimistic concurrency, as in the reference: an edit that started
        // from an older version loses rather than silently overwriting.
        if ((contentChanged || titleChanged) && p.baseVersion != null && p.baseVersion !== doc.version) {
          return sendJSON(res, 409, {
            error: 'conflict', serverVersion: doc.version,
            detail: 'This document changed elsewhere while you were editing.',
          });
        }
        if (typeof p.content === 'string' && p.content.length > MAX_DOC_BYTES) {
          return sendJSON(res, 413, { error: 'document too large' });
        }
        if (contentChanged || titleChanged) snapshotDocVersion(id, doc, readDocBody(id));
        if (typeof p.title === 'string') doc.title = p.title.slice(0, 300) || 'Untitled';
        if (Array.isArray(p.tags)) doc.tags = p.tags.slice(0, 30);
        if (typeof p.folder === 'string') doc.folder = p.folder;
        if (typeof p.pinned === 'boolean') doc.pinned = p.pinned;
        ['projectId', 'learningId', 'taskId', 'ideaId'].forEach((k) => {
          if (k in p) doc[k] = p[k] || null;
        });
        if (typeof p.content === 'string') writeDocBody(id, p.content);
        if (contentChanged || titleChanged) doc.version = (doc.version || 1) + 1;
        doc.updatedAt = Date.now();
        docs[idx] = doc; writeDocs(docs);
        return sendJSON(res, 200, { document: Object.assign(docSummary(doc), { content: readDocBody(id) }) });
      });
      return;
    }

    if (sub === 'archive' && req.method === 'POST') {
      doc.status = 'archived'; doc.archivedAt = Date.now(); doc.updatedAt = Date.now();
      docs[idx] = doc; writeDocs(docs);
      return sendJSON(res, 200, { document: docSummary(doc) });
    }
    if (sub === 'restore' && req.method === 'POST') {
      doc.status = 'active'; doc.archivedAt = null; doc.updatedAt = Date.now();
      docs[idx] = doc; writeDocs(docs);
      return sendJSON(res, 200, { document: docSummary(doc) });
    }
    if (sub === 'versions' && req.method === 'GET') {
      return sendJSON(res, 200, { versions: readDocVersions(id) });
    }
    if (!sub && req.method === 'DELETE') {
      docs.splice(idx, 1); writeDocs(docs);
      deleteDocFiles(id);
      return sendJSON(res, 200, { ok: true });
    }
    res.writeHead(405); return res.end('Method not allowed');
  }

  // API: /api/calendar/status  — authorisation state, without prompting
  if (u.pathname === '/api/calendar/status' && req.method === 'GET') {
    runCalendarHelper(['--status'], (_e, r) => {
      const status = r && r.status ? r.status : (r && r.error) || 'unknown';
      sendJSON(res, 200, { status, available: status === 'authorized', helper: !!calendarHelperPath() });
    });
    return;
  }

  // API: /api/calendar/calendars — which calendars exist (for the picker)
  if (u.pathname === '/api/calendar/calendars' && req.method === 'GET') {
    runCalendarHelper(['--list'], (_e, r) => {
      if (!r || r.error) return sendJSON(res, 200, { calendars: [], error: (r && r.error) || 'unknown' });
      sendJSON(res, 200, { calendars: r.calendars || [] });
    });
    return;
  }

  // API: /api/calendar/events?from=&to=&ids=
  if (u.pathname === '/api/calendar/events' && req.method === 'GET') {
    const from = safeDate(u.searchParams.get('from'));
    const to = safeDate(u.searchParams.get('to'));
    if (!from || !to) return sendJSON(res, 400, { error: 'bad range' });
    const ids = (u.searchParams.get('ids') || '').split(',').filter((x) => /^[A-Za-z0-9-]+$/.test(x));
    const key = from + '..' + to + '#' + ids.sort().join(',');
    const cached = calCacheGet(key);
    if (cached) return sendJSON(res, 200, Object.assign({ cached: true }, cached));
    const args = ['--from', from, '--to', to];
    if (ids.length) { args.push('--ids', ids.join(',')); }
    runCalendarHelper(args, (_e, r) => {
      if (!r || r.error) return sendJSON(res, 200, { events: [], error: (r && r.error) || 'unknown' });
      const payload = { events: r.events || [] };
      calCacheSet(key, payload);
      sendJSON(res, 200, payload);
    });
    return;
  }

  // Managing events. Writes go to the calendar macOS already syncs, so an event
  // created here reaches Google without this app holding any credentials.
  if (u.pathname === '/api/calendar/event') {
    const finish = (r) => {
      calCache.clear();                    // the agenda must not serve a stale copy
      if (!r || r.error) {
        const code = r && r.error === 'not-granted' ? 403 : 400;
        return sendJSON(res, code, { error: (r && r.error) || 'unknown' });
      }
      sendJSON(res, 200, r);
    };

    if (req.method === 'POST' || req.method === 'PUT') {
      readBody(req, (err, body) => {
        if (err) return sendJSON(res, 413, { error: 'too large' });
        let p; try { p = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'bad body' }); }
        const args = [req.method === 'POST' ? '--create' : '--update'];
        if (req.method === 'PUT') {
          if (!p.id) return sendJSON(res, 400, { error: 'id required' });
          args.push('--event', String(p.id));
          // Which occurrence of a recurring series is meant. Without it the
          // helper can only find the first one, and editing Wednesday's
          // meeting would change Monday's.
          if (p.occurrence) args.push('--occurrence', String(p.occurrence));
        }
        if (p.title != null) args.push('--title', String(p.title).slice(0, 300));
        if (p.start) args.push('--start', String(p.start));
        if (p.end) args.push('--end', String(p.end));
        if (p.location != null) args.push('--location', String(p.location).slice(0, 300));
        if (p.notes != null) args.push('--notes', String(p.notes).slice(0, 2000));
        if (p.calendarId) args.push('--calendar', String(p.calendarId));
        if (p.allDay) args.push('--all-day');
        runCalendarHelper(args, (_e, r) => finish(r));
      });
      return;
    }

    if (req.method === 'DELETE') {
      const id = u.searchParams.get('id');
      if (!id) return sendJSON(res, 400, { error: 'id required' });
      const occ = u.searchParams.get('occurrence');
      const del = ['--delete', '--event', id];
      if (occ) del.push('--occurrence', occ);
      runCalendarHelper(del, (_e, r) => finish(r));
      return;
    }

    res.writeHead(405);
    return res.end('Method not allowed');
  }

  // List which dates have task data (exclude .meta.json sidecar files)
  if (u.pathname === '/api/days' && req.method === 'GET') {
    const days = fs
      .readdirSync(DATA_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) // only day files (not meta / projects / spotify)
      .map((f) => f.replace('.json', ''));
    return sendJSON(res, 200, { days });
  }

  serveStatic(req, res);
});

// Run directly (node server.js / LaunchAgent): listen on the fixed port.
// Required as a module (the Electron desktop app): just export the server so
// the caller can listen on any free port.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  ✅ Task Notes running at  http://localhost:${PORT}`);
    console.log(`  📁 Data stored in         ${DATA_DIR}\n`);
  });
}

module.exports = server;
