// Carrying unfinished work from one day to the next, across days you never
// opened.
//
// The case this pins down is the one that actually happened: Friday was a
// real day; Saturday was never opened, so it had no file; Sunday had a stale
// forecast written back on Sep 7 by paging forward through the calendar; and
// Monday, opened for real, took Sunday's stale list as "yesterday". Tuesday
// then copied Monday. Friday's work never reached any of them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The real functions, lifted out of index.html, so this cannot drift into
// testing a copy that agrees with itself.
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function slice(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, 'could not find ' + from);
  return html.slice(a, b);
}
const SRC = [
  slice('const PRIO_RANK', '\n'),
  slice('function normalize(t) {', 'function taskFocusedSeconds'),
  slice('const CARRY_OPEN', 'async function carryForward'),
].join('\n');

// A data directory in memory, behind the same three calls the page makes.
function world(files, metas = {}) {
  const tasks = JSON.parse(JSON.stringify(files));
  const meta = JSON.parse(JSON.stringify(metas));
  const writes = [];
  const json = (v) => ({ json: async () => v });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://x');
    const date = u.searchParams.get('date');
    if (u.pathname === '/api/tasks' && (opts.method || 'GET') === 'GET') {
      return json({ date, tasks: tasks[date] ? JSON.parse(JSON.stringify(tasks[date])) : [] });
    }
    if (u.pathname === '/api/tasks' && opts.method === 'PUT') {
      tasks[date] = JSON.parse(opts.body);
      writes.push(date);
      return json({ ok: true, rev: writes.length });
    }
    if (u.pathname === '/api/meta') return json({ date, meta: meta[date] ? JSON.parse(JSON.stringify(meta[date])) : {} });
    throw new Error('unexpected fetch ' + url);
  };
  let n = 0;
  const uid = () => 'new' + (++n);
  const lib = new Function('fetch', 'uid', 'iso', 'calShift',
    SRC + '\nreturn { catchUpCarry, normalize };')(fetch, uid, iso, calShift);
  return { lib, tasks, writes, days: () => Object.keys(tasks) };
}
function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function calShift(ds, n) { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); }

// Open work on a board, as the words on it, in order.
const open = (arr) => (arr || []).filter((t) => t.status !== 'done').map((t) => t.text + ':' + t.status).sort();

const THU = '2026-09-24', FRI = '2026-09-25', SAT = '2026-09-26', SUN = '2026-09-27',
  MON = '2026-09-28', TUE = '2026-09-29';

// Friday as it really was: carried in from Thursday, plus something new.
const thursday = [
  { id: 'a', text: 'finish the dist queue', status: 'todo', carried: false },
  { id: 'b', text: 'code review of the libs', status: 'progress', carried: false },
  { id: 'c', text: 'shipped thing', status: 'done', carried: false },
];
const friday = [
  { id: 'fa', text: 'finish the dist queue', status: 'todo', carried: true, srcId: 'a', carriedAs: 'todo', carriedNote: '' },
  { id: 'fb', text: 'code review of the libs', status: 'progress', carried: true, srcId: 'b', carriedAs: 'progress', carriedNote: '' },
  { id: 'ff', text: 'idp hard failure', status: 'todo', carried: false },
];
// Sunday, as written on Sep 7: an old lineage-less snapshot of that week.
const sundayForecast = [
  { id: 'g1', text: 'idp auth manager doc read', status: 'todo', carried: true, carryCount: 14 },
  { id: 'g2', text: 'finish the dist queue', status: 'progress', carried: true, carryCount: 16 },
];
// Monday and Tuesday, opened for real, faithfully copying the wrong thing.
const monday = [
  { id: 'm1', text: 'idp auth manager doc read', status: 'todo', carried: true, srcId: 'g1', carriedAs: 'todo', carriedNote: '' },
  { id: 'm2', text: 'finish the dist queue', status: 'progress', carried: true, srcId: 'g2', carriedAs: 'progress', carriedNote: '' },
];
const tuesday = [
  { id: 't1', text: 'idp auth manager doc read', status: 'todo', carried: true, srcId: 'm1', carriedAs: 'todo', carriedNote: '' },
  { id: 't2', text: 'finish the dist queue', status: 'progress', carried: true, srcId: 'm2', carriedAs: 'progress', carriedNote: '' },
];
const FRIDAY_OPEN = open(friday);

function run(w, day, board) {
  const here = board || { tasks: (w.tasks[day] || []).map(w.lib.normalize), meta: {} };
  return w.lib.catchUpCarry(w.days(), day, here).then((changed) => ({ changed, here }));
}

test('Friday reaches Saturday, Sunday, Monday and Tuesday across a skipped weekend', async () => {
  const w = world({ [THU]: thursday, [FRI]: friday, [SUN]: sundayForecast, [MON]: monday, [TUE]: tuesday });
  const { changed, here } = await run(w, TUE);

  assert.ok(changed, 'Tuesday itself had to change');
  assert.deepStrictEqual(open(w.tasks[SAT]), FRIDAY_OPEN, 'Saturday');
  assert.deepStrictEqual(open(w.tasks[SUN]), FRIDAY_OPEN, 'Sunday');
  assert.deepStrictEqual(open(w.tasks[MON]), FRIDAY_OPEN, 'Monday');
  assert.deepStrictEqual(open(here.tasks), FRIDAY_OPEN, 'Tuesday');
  assert.ok(!w.writes.includes(FRI) && !w.writes.includes(THU), 'the days already in step were not rewritten');
});

test('each copy points at the day directly before it', async () => {
  const w = world({ [THU]: thursday, [FRI]: friday, [SUN]: sundayForecast, [MON]: monday, [TUE]: tuesday });
  const { here } = await run(w, TUE);
  const ids = (d) => new Set(w.tasks[d].map((t) => t.id));
  for (const [day, prev] of [[SAT, FRI], [SUN, SAT], [MON, SUN]]) {
    for (const t of w.tasks[day]) assert.ok(ids(prev).has(t.srcId), day + ' → ' + prev + ': ' + t.text);
  }
  for (const t of here.tasks) assert.ok(ids(MON).has(t.srcId), 'Tuesday → Monday: ' + t.text);
});

test('what you did on a day in the gap is kept, and still flows forward', async () => {
  const sunday = sundayForecast.concat([{ id: 's-new', text: 'typed on sunday', status: 'todo', carried: false }]);
  const mon = monday.concat([{ id: 'm-done', text: 'finished on monday', status: 'done', carried: false }]);
  const w = world({ [THU]: thursday, [FRI]: friday, [SUN]: sunday, [MON]: mon, [TUE]: tuesday });
  const { here } = await run(w, TUE);

  assert.ok(w.tasks[SUN].some((t) => t.text === 'typed on sunday'), 'typed on Sunday stays on Sunday');
  assert.ok(w.tasks[MON].some((t) => t.text === 'finished on monday' && t.status === 'done'), 'finished work is never removed');
  assert.ok(here.tasks.some((t) => t.text === 'typed on sunday'), 'and it carries on to Tuesday');
  assert.ok(!here.tasks.some((t) => t.text === 'finished on monday'), 'finished work does not carry');
});

test('a day you emptied on purpose is left alone', async () => {
  const w = world({ [THU]: thursday, [FRI]: friday, [SUN]: [], [TUE]: [] }, { [SUN]: { noCarry: true } });
  await run(w, TUE);
  assert.ok(!w.writes.includes(SUN), 'Sunday was not written');
  assert.deepStrictEqual(w.tasks[SUN], []);
});

test('nothing is written when every day is already in step', async () => {
  const w = world({ [THU]: thursday, [FRI]: friday, [SUN]: sundayForecast, [MON]: monday, [TUE]: tuesday });
  const first = await run(w, TUE);
  w.tasks[TUE] = first.here.tasks;             // the page saves the day on screen itself
  const w2 = world(w.tasks);
  const { changed } = await run(w2, TUE);
  assert.strictEqual(changed, false);
  assert.deepStrictEqual(w2.writes, []);
});
