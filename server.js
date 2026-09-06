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
  const legacy = readCollection('projects');
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
        projects.push({
          id: p.id, title: p.title || '', desc: p.note || '',
          status: p.status === 'backlog' ? 'planned' : (p.status || 'planned'),
          start: '', due: p.deadline || '', notes: p.note || '',
          learningIds: [], createdAt: p.createdAt || Date.now(), updatedAt: Date.now(),
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
  let urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
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
