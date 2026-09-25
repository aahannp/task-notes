// The pad (/pad) and the rules that keep the server to this Mac, driven over
// real HTTP against a throwaway data directory like the other server tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-pad-'));
const PORT = 6030 + Math.floor(Math.random() * 40);
const BASE = 'http://127.0.0.1:' + PORT;
let server;

// Raw requests, so Host and Origin can be set the way a hostile page would.
function raw(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: headers || {} }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ code: res.statusCode, text: d, body: j }); });
    });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
const json = { 'Content-Type': 'application/json' };

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), TASKNOTES_DATA: DIR }), stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/rev'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { if (server) server.kill(); fs.rmSync(DIR, { recursive: true, force: true }); });

// ------------------------------------------------------------------ the pad

test('/pad serves the pad, with the editor from the vendored copy', async () => {
  const r = await raw('GET', '/pad');
  assert.strictEqual(r.code, 200);
  assert.match(r.text, /\/vendor\/monaco\/vs\/loader\.js/);
  assert.doesNotMatch(r.text, /https?:\/\/(cdn|unpkg|jsdelivr)/, 'nothing is fetched from a CDN');
  assert.strictEqual((await raw('GET', '/vendor/monaco/vs/loader.js')).code, 200);
  assert.strictEqual((await raw('GET', '/vendor/monaco/vs/editor/editor.main.js')).code, 200);
});

test('the trimmed language workers are really gone, and the pad never asks for them', () => {
  const vs = path.join(__dirname, '..', 'public', 'vendor', 'monaco', 'vs');
  const left = fs.readdirSync(path.join(vs, 'assets')).filter((f) => /^(ts|json|css|html)\.worker-/.test(f));
  assert.deepStrictEqual(left, []);
  const pad = fs.readFileSync(path.join(__dirname, '..', 'public', 'pad.html'), 'utf8');
  for (const ns of ['typescript', 'json', 'css', 'html']) assert.match(pad, new RegExp('monaco\\.' + ns + ','));
  assert.match(pad, /setModeConfiguration/);
});

let docId;
test('a document remembers its language, and changing it is not an edit', async () => {
  const c = await raw('POST', '/api/documents', json, { title: 'Pad test', content: 'fn main() {}', language: 'rust' });
  assert.strictEqual(c.code, 201);
  docId = c.body.document.id;
  assert.strictEqual(c.body.document.language, 'rust');
  const p = await raw('PUT', '/api/documents/' + docId, json, { language: 'go' });
  assert.strictEqual(p.body.document.language, 'go');
  assert.strictEqual(p.body.document.version, 1, 'no version for a language change');
  const v = await raw('GET', '/api/documents/' + docId + '/versions');
  assert.strictEqual(v.body.versions.length, 0, 'and nothing snapshotted');
});

test('a nonsense language is ignored, not stored', async () => {
  const p = await raw('PUT', '/api/documents/' + docId, json, { language: '<script>' });
  assert.strictEqual(p.body.document.language, 'go');
});

test('documents from before the pad read as having no language', async () => {
  const c = await raw('POST', '/api/documents', json, { title: 'Old style', content: '# hi' });
  assert.strictEqual(c.body.document.language, '');
});

test('the pad saves with baseVersion, and a stale save is refused', async () => {
  const a = await raw('PUT', '/api/documents/' + docId, json, { content: 'one', baseVersion: 1 });
  assert.strictEqual(a.code, 200);
  const stale = await raw('PUT', '/api/documents/' + docId, json, { content: 'two', baseVersion: 1 });
  assert.strictEqual(stale.code, 409, 'an edit made elsewhere is not silently overwritten');
  const g = await raw('GET', '/api/documents/' + docId);
  assert.strictEqual(g.body.document.content, 'one');
});

// -------------------------------------------------------------- local only

test('a request naming another host is refused before anything is read', async () => {
  const r = await raw('GET', '/api/documents', { Host: 'evil.example:' + PORT });
  assert.strictEqual(r.code, 403);
  assert.doesNotMatch(r.text, /Pad test/);
});

test('a write from another site is refused, and nothing is created', async () => {
  const before = (await raw('GET', '/api/documents')).body.documents.length;
  const r1 = await raw('POST', '/api/documents', { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, '{"title":"pwned"}');
  const r2 = await raw('POST', '/api/documents', { Origin: 'null' }, '{"title":"pwned"}');
  assert.strictEqual(r1.code, 403);
  assert.strictEqual(r2.code, 403);
  assert.strictEqual((await raw('GET', '/api/documents')).body.documents.length, before);
});

test("this Mac's own pages, and the MCP server, still get through", async () => {
  for (const origin of ['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT, 'http://127.0.0.1:51234']) {
    const r = await raw('PUT', '/api/documents/' + docId, Object.assign({ Origin: origin }, json), { title: 'Pad test' });
    assert.strictEqual(r.code, 200, origin);
  }
  const mcp = await raw('PUT', '/api/documents/' + docId, json, { title: 'Pad test' });     // no Origin at all
  assert.strictEqual(mcp.code, 200);
  const viaLocalhost = await raw('GET', '/api/documents', { Host: 'localhost:' + PORT });
  assert.strictEqual(viaLocalhost.code, 200);
});

test('run directly, the server listens on this Mac only', (t) => {
  // What it is bound to, not whether a connection happens to get through:
  // a firewall can hide an all-interfaces bind, and did on the machine this
  // was written on. `listen(PORT)` with no host binds every interface.
  let out;
  try {
    out = require('node:child_process').execFileSync('lsof', ['-nP', '-a', '-p', String(server.pid), '-iTCP:' + PORT, '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch { return t.skip('lsof is not available here'); }
  const addrs = out.split('\n').slice(1).filter(Boolean).map((l) => l.trim().split(/\s+/)[8]);
  assert.ok(addrs.length, 'the server is listening');
  addrs.forEach((a) => assert.match(a, /^127\.0\.0\.1:\d+$/, 'bound to ' + a));
});
