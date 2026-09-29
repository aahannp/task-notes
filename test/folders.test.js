// Folders for documents (/api/doc-folders), driven over real HTTP against a
// throwaway data directory like the other server tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-folders-'));
const PORT = 6080 + Math.floor(Math.random() * 40);
const BASE = 'http://127.0.0.1:' + PORT;
let server;

async function call(method, p, body) {
  const r = await fetch(BASE + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { code: r.status, body: j };
}
const folders = async () => (await call('GET', '/api/doc-folders')).body.folders;
const docFolder = async (id) => (await call('GET', '/api/documents/' + id)).body.document.folder;

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

let a, b, c;
test('the list is every folder a document is filed in, sorted', async () => {
  a = (await call('POST', '/api/documents', { title: 'A', content: 'a', folder: 'Kafka' })).body.document.id;
  b = (await call('POST', '/api/documents', { title: 'B', content: 'b', folder: 'Go' })).body.document.id;
  c = (await call('POST', '/api/documents', { title: 'C', content: 'c', folder: 'Kafka' })).body.document.id;
  await call('POST', '/api/documents', { title: 'Loose', content: 'x' });
  assert.deepStrictEqual(await folders(), ['Go', 'Kafka']);
});

test('a folder made by hand stays, even with nothing in it', async () => {
  const r = await call('POST', '/api/doc-folders', { name: '  Empty one  ' });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.body.folder, 'Empty one', 'trimmed');
  assert.deepStrictEqual(await folders(), ['Empty one', 'Go', 'Kafka']);
  assert.ok(fs.existsSync(path.join(DIR, 'doc-folders.json')));
});

test('asking for a folder that exists is fine, and changes nothing', async () => {
  const r = await call('POST', '/api/doc-folders', { name: 'Kafka' });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(await folders(), ['Empty one', 'Go', 'Kafka']);
});

test('a blank or overlong name is refused', async () => {
  assert.strictEqual((await call('POST', '/api/doc-folders', { name: '   ' })).code, 400);
  assert.strictEqual((await call('POST', '/api/doc-folders', { name: 'x'.repeat(81) })).code, 400);
  assert.strictEqual((await call('POST', '/api/doc-folders', {})).code, 400);
});

test('once kept, a folder outlives its last document moving out', async () => {
  await call('POST', '/api/doc-folders', { name: 'Go' });
  await call('PUT', '/api/documents/' + b, { folder: '' });
  assert.ok((await folders()).includes('Go'));
});

test('renaming a folder moves its documents with it — archived ones too', async () => {
  await call('POST', '/api/documents/' + c + '/archive');
  const r = await call('PUT', '/api/doc-folders', { from: 'Kafka', to: 'Streaming' });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.moved.sort(), [a, c].sort());
  assert.strictEqual(await docFolder(a), 'Streaming');
  assert.strictEqual(await docFolder(c), 'Streaming');
  assert.deepStrictEqual(await folders(), ['Empty one', 'Go', 'Streaming']);
});

test('renaming onto a folder that exists needs merge', async () => {
  const no = await call('PUT', '/api/doc-folders', { from: 'Streaming', to: 'Go' });
  assert.strictEqual(no.code, 409);
  assert.strictEqual(await docFolder(a), 'Streaming', 'nothing moved');
  const yes = await call('PUT', '/api/doc-folders', { from: 'Streaming', to: 'Go', merge: true });
  assert.strictEqual(yes.code, 200);
  assert.strictEqual(await docFolder(a), 'Go');
  assert.deepStrictEqual(await folders(), ['Empty one', 'Go']);
});

test('renaming a folder that is not there is a 404', async () => {
  assert.strictEqual((await call('PUT', '/api/doc-folders', { from: 'Nope', to: 'Still nope' })).code, 404);
});

test('deleting a folder loses nothing: its documents go to the top level', async () => {
  const r = await call('POST', '/api/doc-folders', { name: 'Go', remove: true });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.moved.map((m) => m.id).sort(), [a, c].sort());
  assert.ok(r.body.moved.every((m) => m.folder === 'Go'), 'with where each one was, for Undo');
  assert.strictEqual(await docFolder(a), '');
  assert.strictEqual(await docFolder(c), '');
  assert.deepStrictEqual(await folders(), ['Empty one']);
  assert.strictEqual((await call('GET', '/api/documents/' + a)).code, 200, 'the document itself is still there');
});

// ------------------------------------------------------------ nested

let n1, n2;
test('folders nest: a path lists every folder above it too', async () => {
  n1 = (await call('POST', '/api/documents', { title: 'Lag', content: 'x', folder: 'Eng/Kafka/Consumers' })).body.document.id;
  n2 = (await call('POST', '/api/documents', { title: 'Topics', content: 'x', folder: 'Eng/Kafka' })).body.document.id;
  await call('POST', '/api/doc-folders', { name: 'Eng/Go' });
  const f = await folders();
  for (const x of ['Eng', 'Eng/Go', 'Eng/Kafka', 'Eng/Kafka/Consumers']) assert.ok(f.includes(x), x);
});

test('a messy path is tidied, not made into a lookalike folder', async () => {
  const r = await call('POST', '/api/documents', { title: 'Messy', content: 'x', folder: ' Eng // Kafka/ ' });
  assert.strictEqual(r.body.document.folder, 'Eng/Kafka');
  const m = await call('POST', '/api/doc-folders', { name: '/Eng/ Go /' });
  assert.strictEqual(m.code, 200, 'already there');
  assert.strictEqual(m.body.folder, 'Eng/Go');
});

test('moving a folder carries everything under it', async () => {
  const r = await call('PUT', '/api/doc-folders', { from: 'Eng/Kafka', to: 'Streaming/Kafka' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(await docFolder(n1), 'Streaming/Kafka/Consumers');
  assert.strictEqual(await docFolder(n2), 'Streaming/Kafka');
  const f = await folders();
  assert.ok(!f.some((x) => x.startsWith('Eng/Kafka')), 'nothing left behind');
  assert.ok(f.includes('Eng'), 'the folder it came out of stays');
});

test('a folder cannot go inside itself', async () => {
  const r = await call('PUT', '/api/doc-folders', { from: 'Streaming', to: 'Streaming/Kafka/Streaming' });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(await docFolder(n1), 'Streaming/Kafka/Consumers');
});

test('removing a nested folder lifts what was in it into its parent', async () => {
  const r = await call('POST', '/api/doc-folders', { name: 'Streaming/Kafka', remove: true });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(await docFolder(n1), 'Streaming');
  assert.strictEqual(await docFolder(n2), 'Streaming');
  const f = await folders();
  assert.ok(f.includes('Streaming'));
  assert.ok(!f.some((x) => x.startsWith('Streaming/')));
});

test('the folder list is local-only like the rest of the API', async () => {
  const r = await fetch(BASE + '/api/doc-folders', {
    method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: '{"name":"pwned"}',
  });
  assert.strictEqual(r.status, 403);
  assert.ok(!(await folders()).includes('pwned'));
});
