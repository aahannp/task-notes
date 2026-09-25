// The checklist's scheduling rules, lifted out of the page and exercised
// directly. Which item belongs on which day is the whole feature; the DOM
// around it is not what breaks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Pull the real functions out of index.html rather than restating them here,
// so this cannot drift into testing a copy that agrees with itself.
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function lift(...names) {
  const src = html.slice(html.indexOf('// CHECKLIST — the day'), html.indexOf('function renderChecklist'));
  const iso = "function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}";
  return new Function(iso + src + '\nreturn {' + names.join(',') + '};')();
}
const { normChecklist, ckOnDay, ckIsDone, ckRepeatLabel } =
  lift('normChecklist', 'ckOnDay', 'ckIsDone', 'ckRepeatLabel');

const mk = (o) => normChecklist(Object.assign({ text: 'x', createdAt: Date.parse('2026-09-01T09:00:00') }, o));
// 2026-09-21 is a Monday; 2026-09-26 a Saturday, 2026-09-27 a Sunday.
const MON = '2026-09-21', FRI = '2026-09-25', SAT = '2026-09-26', SUN = '2026-09-27';

test('a daily item lands on every day', () => {
  const c = mk({ repeat: { mode: 'daily' } });
  for (const d of [MON, FRI, SAT, SUN]) assert.ok(ckOnDay(c, d), d);
});

test('working days skip the weekend', () => {
  const c = mk({ repeat: { mode: 'weekdays' } });
  assert.ok(ckOnDay(c, MON));
  assert.ok(ckOnDay(c, FRI));
  assert.ok(!ckOnDay(c, SAT));
  assert.ok(!ckOnDay(c, SUN));
});

test('days off are only the weekend', () => {
  const c = mk({ repeat: { mode: 'weekends' } });
  assert.ok(!ckOnDay(c, MON));
  assert.ok(ckOnDay(c, SAT));
  assert.ok(ckOnDay(c, SUN));
});

test('custom honours exactly the days picked', () => {
  const c = mk({ repeat: { mode: 'custom', days: [1, 5] } });   // Mon + Fri
  assert.ok(ckOnDay(c, MON));
  assert.ok(ckOnDay(c, FRI));
  assert.ok(!ckOnDay(c, SAT));
});

test('ticking a repeating item on one day leaves the next day untouched', () => {
  const c = mk({ repeat: { mode: 'daily' } });
  c.done[MON] = Date.now();
  assert.ok(ckIsDone(c, MON));
  assert.ok(!ckIsDone(c, FRI));
  assert.ok(ckOnDay(c, FRI), 'still due on a later day');
});

test('a one-off carries forward until it is cleared', () => {
  const c = mk({ repeat: null });
  assert.ok(ckOnDay(c, MON));
  assert.ok(ckOnDay(c, FRI), 'still waiting days later');
});

test('a cleared one-off shows on the day it was done, and not after', () => {
  const c = mk({ repeat: null });
  c.done[MON] = Date.now();
  assert.ok(ckOnDay(c, MON), 'struck through for the rest of that day');
  assert.ok(!ckOnDay(c, FRI), 'gone the next day');
});

test('nothing appears on a day before it was created', () => {
  const c = mk({ repeat: { mode: 'daily' }, createdAt: Date.parse('2026-09-25T09:00:00') });
  assert.ok(!ckOnDay(c, MON), 'no retroactive guilt');
  assert.ok(ckOnDay(c, FRI));
});

test('a day already ticked still shows even when the schedule says otherwise', () => {
  // You tick it, then narrow the schedule. The record of having done it stands.
  const c = mk({ repeat: { mode: 'weekdays' } });
  c.done[SAT] = Date.now();
  assert.ok(ckOnDay(c, SAT));
});

test('labels read the way the schedule was chosen', () => {
  assert.strictEqual(ckRepeatLabel(mk({ repeat: { mode: 'daily' } })), 'Every day');
  assert.strictEqual(ckRepeatLabel(mk({ repeat: { mode: 'weekdays' } })), 'Working days');
  assert.strictEqual(ckRepeatLabel(mk({ repeat: { mode: 'weekends' } })), 'Days off');
  assert.strictEqual(ckRepeatLabel(mk({ repeat: { mode: 'custom', days: [3, 1] } })), 'Mon · Wed');
});

test('a malformed stored item is normalised rather than trusted', () => {
  const c = normChecklist({ text: 'x', repeat: { mode: 'nonsense', days: [9, 2] }, done: 'bad' });
  assert.strictEqual(c.repeat.mode, 'daily');
  assert.deepStrictEqual(c.repeat.days, [2]);
  assert.deepStrictEqual(c.done, {});
  assert.ok(c.id);
});

// The rules above were all correct while the panel still showed yesterday's
// ticks, because nothing re-rendered it on a day change. Unit tests cannot see
// that, so this checks the wiring itself: the day loader must repaint the list.
test('changing the viewed day re-renders the checklist', () => {
  const load = html.slice(html.indexOf('async function load() {'));
  const body = load.slice(0, load.indexOf('\n}\n'));
  assert.ok(/renderChecklist\(\)/.test(body),
    'load() must call renderChecklist(), or the panel keeps the previous day\'s ticks');
});

test('the checklist is a registered store, not an ad-hoc file', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /checklist: 'checklist\.json'/);
});
