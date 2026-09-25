// Nutrition through the real HTTP API, on a throwaway data directory — the
// same way graph.test.js drives the board. The arithmetic is checked on its
// own in nutrition.test.js; this is about what gets stored, what is kept, and
// what survives a restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const N = require('../public/nutrition-core.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-nutrition-'));
const PORT = 5980 + Math.floor(Math.random() * 15);
const BASE = 'http://127.0.0.1:' + PORT;
// Local date, the way the server and the page both compute it. Not
// toISOString(), which is UTC and names the wrong day for half the evening.
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TODAY = iso(new Date());
const YESTERDAY = N.shiftDay(TODAY, -1);
let server;

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: r.status, body: await r.json().catch(() => ({})) };
};
const dayFile = (d) => JSON.parse(fs.readFileSync(path.join(DIR, d + '.nutrition.json'), 'utf8'));

async function start() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), TASKNOTES_DATA: DIR }),
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/rev'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!server) return;
  const s = server; server = null;
  await new Promise((r) => { s.once('exit', r); s.kill(); });
}
before(start);
after(async () => { await stop(); fs.rmSync(DIR, { recursive: true, force: true }); });

const foodNamed = async (name) => (await api('GET', '/api/nutrition/foods')).body.foods.find((f) => f.name === name);

// ------------------------------------------------------------------ setup

test('the starter foods are seeded once, with the Amul label values', async () => {
  const { body } = await api('GET', '/api/nutrition/foods');
  assert.strictEqual(body.foods.length, 12);
  const amul = body.foods.find((f) => f.brand === 'Amul');
  assert.deepStrictEqual([amul.servingSize, amul.servingUnit, amul.calories, amul.protein, amul.carbs, amul.fat], [200, 'ml', 138, 20, 19, 1.5]);
  assert.ok(amul.id && amul.createdAt && amul.updatedAt);
});

test('settings start at the requested defaults and live in a store', async () => {
  const { body } = await api('GET', '/api/nutrition/settings');
  assert.deepStrictEqual([body.targets.calories, body.targets.protein, body.targets.fat, body.targets.carbs], [2450, 170, 70, null]);
  assert.strictEqual(body.settings.goal, 'cut');
  assert.strictEqual(body.today, TODAY, 'the server and the test agree on what today is');
});

test('searching "amul" finds it', async () => {
  const { body } = await api('GET', '/api/nutrition/foods?q=amul');
  assert.strictEqual(body.foods[0].name, 'Amul High Protein Milk');
});

// ---------------------------------------------------------------- logging

let entryId;
test('logging two servings writes the computed numbers to the day file', async () => {
  const amul = await foodNamed('Amul High Protein Milk');
  const { code, body } = await api('POST', '/api/nutrition/log', { date: TODAY, meal: 'breakfast', foodId: amul.id, quantity: 2, unit: 'serving' });
  assert.strictEqual(code, 201);
  entryId = body.entry.id;
  assert.deepStrictEqual([body.entry.calories, body.entry.protein, body.entry.carbs, body.entry.fat], [276, 40, 38, 3]);
  assert.strictEqual(body.day.totals.calories, 276);
  assert.strictEqual(body.day.remaining.calories.left, 2450 - 276);
  assert.strictEqual(body.day.remaining.protein.left, 130);
  const onDisk = dayFile(TODAY).entries;
  assert.strictEqual(onDisk.length, 1);
  assert.ok(onDisk[0].createdAt && onDisk[0].updatedAt);
});

test('grams against a per-100 g food', async () => {
  const chicken = await foodNamed('Chicken Breast');
  const { body } = await api('POST', '/api/nutrition/log', { date: TODAY, meal: 'lunch', foodId: chicken.id, quantity: 200, unit: 'g', notes: 'air fried' });
  assert.strictEqual(body.entry.calories, 330);
  assert.strictEqual(body.entry.notes, 'air fried');
});

test('a custom food can be logged and saved to the library in one go', async () => {
  const { code, body } = await api('POST', '/api/nutrition/log', {
    date: TODAY, meal: 'dinner', custom: { name: 'Paneer Tikka', calories: 320, protein: 22, carbs: 8, fat: 22 }, save: true,
  });
  assert.strictEqual(code, 201);
  assert.strictEqual(body.entry.calories, 320);
  assert.ok(body.entry.foodId, 'it points at the new library food');
  assert.ok(await foodNamed('Paneer Tikka'));
});

test('bad input is refused with a reason, not stored', async () => {
  const amul = await foodNamed('Amul High Protein Milk');
  const r1 = await api('POST', '/api/nutrition/log', { date: TODAY, meal: 'brunch', foodId: amul.id, quantity: 1 });
  assert.strictEqual(r1.code, 400);
  assert.match(r1.body.error, /meal must be/);
  const r2 = await api('POST', '/api/nutrition/log', { date: '25-09-2026', meal: 'lunch', foodId: amul.id, quantity: 1 });
  assert.strictEqual(r2.code, 400);
  assert.match(r2.body.error, /YYYY-MM-DD/);
  const r3 = await api('POST', '/api/nutrition/log', { date: TODAY, meal: 'lunch', foodId: amul.id, quantity: 1, unit: 'kg' });
  assert.strictEqual(r3.code, 400);
  const r4 = await api('POST', '/api/nutrition/foods', { name: 'No calories' });
  assert.strictEqual(r4.code, 400);
});

// ------------------------------------------------------------ editing

test('changing a quantity recomputes from the entry', async () => {
  const { body } = await api('PATCH', '/api/nutrition/log?date=' + TODAY + '&id=' + entryId, { quantity: 3 });
  assert.strictEqual(body.entry.calories, 414);
  assert.strictEqual(body.entry.quantity, 3);
});

test('an entry can move to another meal', async () => {
  const { body } = await api('PATCH', '/api/nutrition/log?date=' + TODAY + '&id=' + entryId, { meal: 'snack' });
  assert.strictEqual(body.entry.meal, 'snack');
  assert.strictEqual(body.day.meals.snack.entries.length, 1);
  assert.strictEqual(body.day.meals.breakfast.entries.length, 0);
  await api('PATCH', '/api/nutrition/log?date=' + TODAY + '&id=' + entryId, { meal: 'breakfast', quantity: 2 });
});

test('duplicating logs the same food again', async () => {
  const { code, body } = await api('POST', '/api/nutrition/duplicate', { date: TODAY, id: entryId });
  assert.strictEqual(code, 201);
  assert.notStrictEqual(body.entry.id, entryId);
  assert.strictEqual(body.day.meals.breakfast.entries.length, 2);
});

test('deleting is a tombstone that can be undone', async () => {
  const before = (await api('GET', '/api/nutrition/day?date=' + TODAY)).body.totals.calories;
  const del = await api('DELETE', '/api/nutrition/log?date=' + TODAY + '&id=' + entryId);
  assert.strictEqual(del.body.day.totals.calories, before - 276);
  // Still on disk, just marked.
  const kept = dayFile(TODAY).entries.find((e) => e.id === entryId);
  assert.ok(kept && kept.deletedAt);
  const undo = await api('PATCH', '/api/nutrition/log?date=' + TODAY + '&id=' + entryId, { restore: true });
  assert.strictEqual(undo.body.day.totals.calories, before);
});

// -------------------------------------------------------- data integrity

test('editing a saved food leaves every logged entry alone', async () => {
  const bar = await foodNamed('Protein Bar');
  await api('POST', '/api/nutrition/log', { date: YESTERDAY, meal: 'snack', foodId: bar.id, quantity: 1 });
  const upd = await api('PATCH', '/api/nutrition/foods?id=' + bar.id, { calories: 190, carbs: 20, fat: 7 });
  assert.strictEqual(upd.body.food.calories, 190);
  const y = (await api('GET', '/api/nutrition/day?date=' + YESTERDAY)).body;
  assert.strictEqual(y.meals.snack.entries[0].calories, 181, 'yesterday still says what was logged');
  assert.strictEqual(y.meals.snack.entries[0].serving.calories, 181);
});

test('changing a target applies from today, and yesterday keeps the old one', async () => {
  const r = await api('PATCH', '/api/nutrition/settings', { calories: 2300 });
  assert.strictEqual(r.body.targets.calories, 2300);
  const y = (await api('GET', '/api/nutrition/day?date=' + YESTERDAY)).body;
  const t = (await api('GET', '/api/nutrition/day?date=' + TODAY)).body;
  assert.strictEqual(y.targets.calories, 2450);
  assert.strictEqual(t.targets.calories, 2300);
  assert.strictEqual(t.targets.protein, 170);
  await api('PATCH', '/api/nutrition/settings', { calories: 2450 });
});

test('a bad target or goal is refused', async () => {
  assert.strictEqual((await api('PATCH', '/api/nutrition/settings', { calories: -5 })).code, 400);
  assert.strictEqual((await api('PATCH', '/api/nutrition/settings', { goal: 'bulk' })).code, 400);
  assert.strictEqual((await api('PATCH', '/api/nutrition/settings', { protein: null })).code, 400, 'protein cannot be switched off');
  assert.strictEqual((await api('PATCH', '/api/nutrition/settings', { carbs: null })).code, 200, 'carbs can');
});

// ------------------------------------------------------------ copying

test('copying a meal from yesterday', async () => {
  const { code, body } = await api('POST', '/api/nutrition/copy', { fromDate: YESTERDAY, fromMeal: 'snack', toDate: TODAY, toMeal: 'snack' });
  assert.strictEqual(code, 201);
  assert.strictEqual(body.count, 1);
  // Rebuilt from the corrected library food, because the food still exists.
  assert.strictEqual(body.entries[0].calories, 190);
});

test('repeating a meal finds the most recent earlier one', async () => {
  const egg = await foodNamed('Whole Egg');
  const twoDaysAgo = N.shiftDay(TODAY, -2);
  await api('POST', '/api/nutrition/log', { date: twoDaysAgo, meal: 'dinner', foodId: egg.id, quantity: 3 });
  const { code, body } = await api('POST', '/api/nutrition/copy', { toDate: TODAY, meal: 'dinner' });
  assert.strictEqual(code, 201);
  assert.strictEqual(body.from, twoDaysAgo);
});

test('repeating a meal that was never eaten says so', async () => {
  const { code, body } = await api('POST', '/api/nutrition/copy', { toDate: TODAY, meal: 'other' });
  assert.strictEqual(code, 404);
  assert.match(body.error, /no earlier other/);
});

// ------------------------------------------------------------ weight

let weighId;
test('logging weight, and logging again the same day corrects it', async () => {
  const a = await api('POST', '/api/nutrition/weights', { date: TODAY, kg: 80.14 });
  assert.strictEqual(a.code, 201);
  assert.strictEqual(a.body.weight.kg, 80.1);
  weighId = a.body.weight.id;
  const b = await api('POST', '/api/nutrition/weights', { date: TODAY, kg: 79.9 });
  assert.strictEqual(b.code, 200);
  assert.strictEqual(b.body.updated, true);
  assert.strictEqual(b.body.weight.id, weighId);
  const all = JSON.parse(fs.readFileSync(path.join(DIR, 'nutrition-weights.json'), 'utf8'));
  assert.strictEqual(all.length, 1);
});

test('weights feed the averages and the trend', async () => {
  await api('POST', '/api/nutrition/weights', { date: N.shiftDay(TODAY, -3), kg: 80.5 });
  const { body } = await api('GET', '/api/nutrition/weights');
  assert.strictEqual(body.stats.today, 79.9);
  assert.strictEqual(body.stats.avg7, 80.2);
  assert.strictEqual(body.trend.length, 2);
});

test('an impossible weight is refused', async () => {
  assert.strictEqual((await api('POST', '/api/nutrition/weights', { kg: 8000 })).code, 400);
  assert.strictEqual((await api('POST', '/api/nutrition/weights', { kg: 'heavy' })).code, 400);
});

test('deleting a weigh-in is undoable too', async () => {
  await api('DELETE', '/api/nutrition/weights?id=' + weighId);
  assert.strictEqual((await api('GET', '/api/nutrition/weights')).body.stats.today, null);
  await api('PATCH', '/api/nutrition/weights?id=' + weighId, { restore: true });
  assert.strictEqual((await api('GET', '/api/nutrition/weights')).body.stats.today, 79.9);
});

// ------------------------------------------------------- history / summary

test('history lists every day in the range, logged or not, with weight', async () => {
  const { body } = await api('GET', '/api/nutrition/history');
  assert.strictEqual(body.days.length, 14);
  const t = body.days.find((d) => d.date === TODAY);
  assert.ok(t.logged);
  assert.strictEqual(t.weight, 79.9);
  assert.ok(body.days.some((d) => !d.logged), 'unlogged days are present, marked as such');
});

test('the 7-day summary covers the last seven days by default', async () => {
  const { body } = await api('GET', '/api/nutrition/summary');
  assert.strictEqual(body.to, TODAY);
  assert.strictEqual(body.from, N.shiftDay(TODAY, -6));
  assert.strictEqual(body.daysLogged, 3);
  assert.ok(body.averages.calories > 0);
  assert.strictEqual(body.weight.change, -0.6);
});

test('quick picks come from what was actually logged', async () => {
  const { body } = await api('GET', '/api/nutrition/quick');
  const names = body.recent.map((x) => x.food.name);
  assert.ok(names.includes('Amul High Protein Milk'));
  assert.ok(body.frequent.some((x) => x.food.name === 'Amul High Protein Milk'), 'logged more than once');
});

// ------------------------------------------------------ app integration

test('a nutrition write moves the revision the app polls', async () => {
  const a = (await api('GET', '/api/rev?date=' + TODAY)).body;
  assert.ok(a.nutrition > 0);
  assert.ok('nutrition-foods' in a.stores && 'nutrition-weights' in a.stores && 'nutrition' in a.stores);
  await new Promise((r) => setTimeout(r, 15));
  const amul = await foodNamed('Amul High Protein Milk');
  await api('POST', '/api/nutrition/log', { date: TODAY, meal: 'other', foodId: amul.id, quantity: 1 });
  const b = (await api('GET', '/api/rev?date=' + TODAY)).body;
  assert.notStrictEqual(b.nutrition, a.nutrition);
});

test('the day sidecar is not mistaken for a task day', async () => {
  const { body } = await api('GET', '/api/days');
  assert.ok(!body.days.some((d) => /nutrition/.test(d)));
});

test('unknown nutrition routes are a 404, not a crash', async () => {
  assert.strictEqual((await api('GET', '/api/nutrition/nope')).code, 404);
  assert.strictEqual((await api('PUT', '/api/nutrition/settings', {})).code, 404);
});

test('everything is still there after a restart', async () => {
  const before = (await api('GET', '/api/nutrition/day?date=' + TODAY)).body;
  await stop();
  await start();
  const after = (await api('GET', '/api/nutrition/day?date=' + TODAY)).body;
  assert.deepStrictEqual(after.totals, before.totals);
  assert.strictEqual((await api('GET', '/api/nutrition/foods')).body.foods.length, 13, 'no second seeding');
  assert.strictEqual((await api('GET', '/api/nutrition/weights')).body.stats.today, 79.9);
});
