// Status transitions and graph/task synchronisation.
//
// node --test test/          — no test framework, same as the rest of the app.
// It starts a real server on a throwaway data directory and drives the actual
// HTTP API, because the rules being checked here live in server.js and in the
// pull semantics, not in a mock.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-graph-'));
const PORT = 5910 + Math.floor(Math.random() * 60);
const BASE = 'http://127.0.0.1:' + PORT;
const TODAY = new Date().toISOString().slice(0, 10);
let server;

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: r.status, body: await r.json().catch(() => ({})) };
};
const day = () => JSON.parse(fs.readFileSync(path.join(DIR, TODAY + '.json'), 'utf8'));
const graph = () => JSON.parse(fs.readFileSync(path.join(DIR, 'graph.json'), 'utf8'));

// The rule the page implements: pulling something onto the canvas says you
// have started it — except when it is waiting on work that is not finished.
async function pull(id) {
  const { body } = await api('GET', '/api/tasks?date=' + TODAY);
  const tasks = body.tasks;
  const t = tasks.find((x) => x.id === id);
  const waiting = (t.dependsOn || [])
    .map((d) => tasks.find((x) => x.id === d))
    .filter((x) => x && x.status !== 'done');
  if (t.status === 'todo' || (t.status === 'blocked' && !waiting.length)) {
    await api('PATCH', '/api/tasks?date=' + TODAY + '&id=' + id, { status: 'progress' });
  }
  const g = (await api('GET', '/api/store?name=graph')).body.value || {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  if (!nodes.some((n) => n.date === TODAY && n.id === id)) nodes.push({ date: TODAY, id });
  await api('PATCH', '/api/store?name=graph', { nodes });
  return waiting;
}
const add = async (text, extra) =>
  (await api('POST', '/api/tasks?date=' + TODAY, Object.assign({ text, status: 'todo' }, extra))).body.task;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), TASKNOTES_DATA: DIR }),
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/rev'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { if (server) server.kill(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('the graph store exists and starts empty', async () => {
  const { code, body } = await api('GET', '/api/store?name=graph');
  assert.equal(code, 200);
  assert.deepEqual(body.value, {});
});

test('pulling a TODO task starts it, and the change is persisted', async () => {
  const t = await add('todo one');
  await pull(t.id);
  assert.equal(day().find((x) => x.id === t.id).status, 'progress');
});

test('pulling creates no second task record', async () => {
  const t = await add('no clones');
  const before = day().length;
  await pull(t.id);
  assert.equal(day().length, before);
  assert.equal(day().filter((x) => x.text === 'no clones').length, 1);
});

test('a blocked task waiting on unfinished work stays blocked', async () => {
  const dep = await add('the blocker');
  const t = await add('waits on it');
  await api('PATCH', '/api/tasks?date=' + TODAY + '&id=' + t.id, { status: 'blocked', dependsOn: [dep.id] });
  const waiting = await pull(t.id);
  assert.equal(day().find((x) => x.id === t.id).status, 'blocked');
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].text, 'the blocker');
});

test('a blocked task whose blockers are done does start', async () => {
  const dep = await add('already finished');
  await api('PATCH', '/api/tasks?date=' + TODAY + '&id=' + dep.id, { status: 'done' });
  const t = await add('stale block');
  await api('PATCH', '/api/tasks?date=' + TODAY + '&id=' + t.id, { status: 'blocked', dependsOn: [dep.id] });
  const waiting = await pull(t.id);
  assert.equal(waiting.length, 0);
  assert.equal(day().find((x) => x.id === t.id).status, 'progress');
});

test('an IN PROGRESS task is not disturbed by being pulled in', async () => {
  const t = await add('already going', { status: 'progress' });
  await pull(t.id);
  assert.equal(day().find((x) => x.id === t.id).status, 'progress');
});

test('the graph stores references, never task data', async () => {
  const nodes = graph().nodes;
  assert.ok(nodes.length > 0);
  for (const n of nodes) {
    assert.deepEqual(Object.keys(n).sort(), ['date', 'id']);
    assert.ok(day().some((t) => t.id === n.id), 'node points at a real task');
  }
  assert.ok(!JSON.stringify(graph()).includes('already going'), 'no task text is copied into the graph');
});

test('editing a task elsewhere is what the graph reads back', async () => {
  const t = await add('rename me');
  await pull(t.id);
  await api('PATCH', '/api/tasks?date=' + TODAY + '&id=' + t.id, { text: 'renamed', priority: 'high' });
  const node = graph().nodes.find((n) => n.id === t.id);
  const live = day().find((x) => x.id === node.id);
  assert.equal(live.text, 'renamed');
  assert.equal(live.priority, 'high');
});

test('taking a node off the canvas leaves the task untouched', async () => {
  const t = await add('survivor');
  await pull(t.id);
  const left = graph().nodes.filter((n) => n.id !== t.id);
  await api('PATCH', '/api/store?name=graph', { nodes: left });
  assert.ok(!graph().nodes.some((n) => n.id === t.id));
  const live = day().find((x) => x.id === t.id);
  assert.ok(live, 'the task still exists');
  assert.equal(live.status, 'progress');
});

test('completing from the graph marks the canonical task done', async () => {
  const t = await add('finish me');
  await pull(t.id);
  await api('PATCH', '/api/tasks?date=' + TODAY + '&id=' + t.id, { status: 'done' });
  const live = day().find((x) => x.id === t.id);
  assert.equal(live.status, 'done');
  assert.ok(live.doneAt, 'doneAt is stamped by the server, not the caller');
});

test('a learning item converts into an ordinary task that keeps the link', async () => {
  const learn = (await api('POST', '/api/store?name=learning', {
    name: 'Understand mutexes', want: 'use them without deadlocking', why: 'concurrency',
    priority: 'high', status: 'bag', expectedMin: 90,
  })).body.item;
  // The same payload learning_to_task sends, so this exercises the real shape.
  const t = (await api('POST', '/api/tasks?date=' + TODAY, {
    text: learn.name, status: 'todo', priority: learn.priority,
    note: 'Want: ' + learn.want, estimateMin: learn.expectedMin,
    projectId: learn.projectId || null, learningId: learn.id,
    people: [], pickupDate: learn.deadline || null, dependsOn: [],
  })).body.task;
  const live = day().find((x) => x.id === t.id);
  assert.equal(live.learningId, learn.id, 'the relationship survives');
  assert.equal(live.status, 'todo', 'it is an ordinary task, in an ordinary state');
  assert.equal(live.priority, 'high');
  assert.ok('dependsOn' in live && 'projectId' in live, 'it has the whole task shape');
  await pull(live.id);
  assert.equal(day().find((x) => x.id === t.id).status, 'progress', 'and behaves like one');
});

test('the graph rejects nothing it should accept, and keeps its view', async () => {
  await api('PATCH', '/api/store?name=graph', { view: { zoom: 1.4, x: 10, y: -20 } });
  assert.equal(graph().view.zoom, 1.4);
  assert.ok(graph().nodes.length > 0, 'patching the view did not drop the nodes');
});

// Carrying forward. Unfinished work becomes a new record on the next day with
// a srcId pointing back, so a node pulled in on Monday must follow the work
// rather than keep showing Monday's copy.
test('a node follows its task onto the day it was carried to', async () => {
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const old = { id: 'CHAIN1', text: 'carried work', status: 'progress', dependsOn: [] };
  await api('PUT', '/api/tasks?date=' + yday, [old]);
  const today = (await api('GET', '/api/tasks?date=' + TODAY)).body.tasks;
  today.push({ id: 'CHAIN2', text: 'carried work', status: 'progress', srcId: 'CHAIN1', carried: true, dependsOn: [] });
  await api('PUT', '/api/tasks?date=' + TODAY, today);

  await api('PATCH', '/api/store?name=graph', { nodes: [{ date: yday, id: 'CHAIN1' }] });

  // The lineage walk the page does: the newest record whose chain reaches the id.
  const days = (await api('GET', '/api/alldays')).body.days || [];
  const all = [];
  days.forEach((d) => (d.tasks || []).forEach((t) => all.push(Object.assign({ _date: d.date }, t))));
  const chainHits = (t, id) => {
    let cur = t;
    for (let hop = 0; hop < 90 && cur; hop++) {
      if (cur.id === id) return true;
      cur = cur.srcId ? all.find((x) => x.id === cur.srcId) : null;
    }
    return false;
  };
  const line = all.filter((t) => chainHits(t, 'CHAIN1'))
    .sort((a, b) => (a._date < b._date ? -1 : 1));
  const latest = line[line.length - 1];
  assert.equal(latest.id, 'CHAIN2', 'resolves to the copy on the later day');
  assert.equal(latest._date, TODAY);
});
