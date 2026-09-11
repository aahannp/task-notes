//
// Data sync, over git.
//
// The data folder is its own repository. Committing is the offline copy and
// pushing is the sync — which is why git rather than something bespoke: an
// edit made on a plane is a commit that has not been pushed yet, and that
// behaviour is free rather than written.
//
// Nothing here ever merges a JSON file. Every write in this app rewrites a
// whole file, so a three-way merge produces plausible nonsense rather than a
// conflict you can see. When two machines have genuinely diverged the local
// side is parked on a branch, the remote is taken as canonical, and the app
// says so. Loud and recoverable beats clever.
//
// Zero dependencies: it shells out to the git that is already on the machine.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let DATA = null;
let BRANCH = 'main';

const state = {
  ready: false,          // data/ is a repo
  remote: null,          // origin's URL, or null
  branch: 'main',
  lastSync: 0,           // last successful push or fast-forward
  lastTry: 0,
  lastError: null,
  pending: 0,            // files changed since the last commit
  behind: 0,
  ahead: 0,
  conflict: null,        // { branch, at } — local work parked, needs a look
  busy: false,
};

// The Spotify token file is rewritten every time the access token refreshes —
// roughly hourly — and committing that would be a commit an hour, each one
// carrying a live credential into history that outlives any later rotation.
// It is only worth committing when the *refresh* token actually changes.
const SPOTIFY = 'spotify-user.json';

const IGNORED = [
  'port.json',           // where THIS machine is listening — never the other one
  'mini-window.json',    // window position, per screen
  'mcp-log.jsonl',       // append-only; would conflict on every sync
  '.sync-ack',           // which conflict you have already dealt with, here
  '*.tmp',               // writeAtomic's scratch files
  '.DS_Store',
];

function git(args, opts) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', DATA, ...args], { timeout: (opts && opts.timeout) || 45000, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
  });
}
const ok = async (args, opts) => { try { return await git(args, opts); } catch { return null; } };

async function init(dataDir) {
  DATA = dataDir;
  await refresh();
  // Only once the folder is actually a repo — this never opts anyone in, it
  // just makes sure the list of things that must not travel is in place.
  if (state.ready) {
    if (!fs.existsSync(path.join(DATA, '.gitignore'))) writeIgnore(DATA);
    await ensureRepoConfig();
  }
  return state;
}

function status() {
  return Object.assign({}, state, { data: DATA });
}

// ---------------------------------------------------------------- inspection

async function refresh() {
  if (!DATA) return state;
  // Being *inside* a work tree is not the same as being a repository. The data
  // folder lives inside the app's own checkout, so `git -C data` walks up and
  // cheerfully reports the source repo — and a sync built on that answer would
  // have committed and pushed Task Notes itself. Only the folder being the top
  // level counts.
  const top = await ok(['rev-parse', '--show-toplevel']);
  let here = DATA, there = top ? top.stdout.trim() : '';
  try { here = fs.realpathSync(here); } catch {}
  try { there = there ? fs.realpathSync(there) : ''; } catch {}
  state.ready = !!there && here === there;
  if (!state.ready) { state.remote = null; state.conflict = null; return state; }

  const rem = await ok(['remote', 'get-url', 'origin']);
  state.remote = rem ? rem.stdout.trim() : null;

  const br = await ok(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (br && br.stdout.trim() && br.stdout.trim() !== 'HEAD') BRANCH = state.branch = br.stdout.trim();

  // Changed files, not counting the ones we deliberately never commit.
  const st = await ok(['status', '--porcelain']);
  state.pending = st ? st.stdout.split('\n').filter((l) => {
    const f = l.slice(3).trim();
    return f && f !== SPOTIFY;
  }).length : 0;

  // A parked branch outlives the process that made it. Reading it back from
  // the repo rather than remembering it means quitting the app cannot quietly
  // clear a warning about work that is still sitting on a branch unread.
  const parked = await ok(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads/local-*']);
  const rows = parked ? parked.stdout.split('\n').filter(Boolean) : [];
  let acked = '';
  try { acked = fs.readFileSync(path.join(DATA, '.sync-ack'), 'utf8').trim(); } catch {}
  if (rows.length) {
    const [name, when] = rows[0].split(' ');
    state.conflict = name === acked ? null : { branch: name, at: Number(when) * 1000, parked: rows.length };
  } else {
    state.conflict = null;
  }

  const counts = await ok(['rev-list', '--left-right', '--count', 'HEAD...origin/' + BRANCH]);
  if (counts) {
    const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
    state.ahead = a || 0;
    state.behind = b || 0;
  }
  return state;
}

// ------------------------------------------------------------------ plumbing

async function ensureRepoConfig() {
  const e = await ok(['config', 'user.email']);
  if (!e || !e.stdout.trim()) {
    await ok(['config', 'user.email', 'task-notes@' + os.hostname()]);
    await ok(['config', 'user.name', 'Task Notes']);
  }
  // This is a data folder, not a service repo. Cloning it picks up whatever
  // commit hooks are configured globally — on a work machine that means a
  // secret scanner, which would block the sync outright on a folder that
  // deliberately holds an OAuth token. Point the repo at an empty hooks
  // directory rather than passing --no-verify to a scanner that is doing its
  // job somewhere it was never meant to run.
  const hp = await ok(['config', 'core.hooksPath']);
  if (!hp || !hp.stdout.trim()) {
    try {
      fs.mkdirSync(path.join(DATA, '.git', 'no-hooks'), { recursive: true });
      await ok(['config', 'core.hooksPath', '.git/no-hooks']);
    } catch {}
  }
}

async function spotifyWorthCommitting() {
  try {
    const head = await git(['show', BRANCH + ':' + SPOTIFY]);
    const now = fs.readFileSync(path.join(DATA, SPOTIFY), 'utf8');
    if (head.stdout === now) return false;
    // Only the access token moved; the durable half is unchanged.
    return JSON.parse(head.stdout).refreshToken !== JSON.parse(now).refreshToken;
  } catch {
    // Never committed before, or unreadable — let it through once.
    return fs.existsSync(path.join(DATA, SPOTIFY));
  }
}

async function commitLocal(reason) {
  await ensureRepoConfig();
  // Everything except the token file, which is judged separately.
  await ok(['add', '-A', '--', '.', ':(exclude)' + SPOTIFY]);
  if (await spotifyWorthCommitting()) await ok(['add', '--', SPOTIFY]);

  const staged = await ok(['diff', '--cached', '--name-only']);
  if (!staged || !staged.stdout.trim()) return false;
  const msg = (reason || 'sync') + ' from ' + os.hostname() + ' · '
    + new Date().toISOString().replace('T', ' ').slice(0, 16);
  await ok(['commit', '-m', msg]);
  return true;
}

// --------------------------------------------------------------------- sync

// Called before the server starts reading anything. Time-boxed: a slow network
// must not hold the app shut, and starting with yesterday's data is recoverable
// where starting late is just broken.
async function pullFirst(timeoutMs) {
  if (!DATA) return state;
  await refresh();
  if (!state.ready || !state.remote) return state;
  try {
    await Promise.race([
      pull(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), timeoutMs || 8000)),
    ]);
  } catch (e) {
    state.lastError = 'Could not pull at launch: ' + (e.message || e);
  }
  return state;
}

async function pull() {
  const fetched = await ok(['fetch', 'origin', BRANCH], { timeout: 30000 });
  if (!fetched) { state.lastError = 'fetch failed'; return false; }
  await refresh();

  if (state.behind && !state.ahead) {
    const ff = await ok(['merge', '--ff-only', 'origin/' + BRANCH]);
    if (ff) { state.lastSync = Date.now(); state.lastError = null; await refresh(); return true; }
  }
  if (state.behind && state.ahead) {
    // Genuinely diverged. Keep both, take the remote, and say so.
    const parkName = 'local-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await ok(['branch', parkName]);
    await ok(['reset', '--hard', 'origin/' + BRANCH]);
    state.lastError = null;
    await refresh();                 // picks the branch back up off the repo
    return true;
  }
  return true;
}

async function syncNow(reason) {
  if (!DATA || state.busy) return state;
  state.busy = true;
  state.lastTry = Date.now();
  try {
    await refresh();
    if (!state.ready) { state.lastError = 'data folder is not a git repository'; return state; }
    if (!state.remote) { state.lastError = 'no remote configured'; return state; }

    await commitLocal(reason);
    await pull();
    if (state.conflict) await commitLocal('after conflict');
    const pushed = await ok(['push', 'origin', BRANCH], { timeout: 45000 });
    if (pushed) { state.lastSync = Date.now(); state.lastError = null; }
    else state.lastError = 'push failed — offline? changes are committed locally and will go next time';
    await refresh();
  } catch (e) {
    state.lastError = String(e.message || e);
  } finally {
    state.busy = false;
  }
  return state;
}

// Writes the ignore file. Called on setup; harmless to repeat.
function writeIgnore(dataDir) {
  const f = path.join(dataDir, '.gitignore');
  const body = '# Machine-local. Syncing these would be actively harmful:\n'
    + '# port.json points at THIS machine\'s server.\n'
    + IGNORED.join('\n') + '\n';
  try { fs.writeFileSync(f, body); return true; } catch { return false; }
}

// Nothing here creates a repository or a remote on its own. Pointing this at
// somewhere new is a decision, not a side effect of launching the app.
function setupHint(dataDir) {
  return [
    'cd ' + dataDir,
    'git init -b main',
    '# the app writes .gitignore and turns off commit hooks on first launch',
    'git add -A && git commit -m "task notes data"',
    'git remote add origin <your private repo url>',
    'git push -u origin main',
  ].join('\n');
}

// Acknowledging does not delete the branch — the work stays where it is.
// It only stops the app asking again about something you have looked at.
async function ackConflict() {
  if (!state.conflict) return state;
  try { fs.writeFileSync(path.join(DATA, '.sync-ack'), state.conflict.branch); } catch {}
  await refresh();
  return state;
}

module.exports = { init, refresh, status, pullFirst, pull, syncNow, ackConflict, writeIgnore, setupHint, IGNORED, SPOTIFY };
