// The nutrition arithmetic, on its own. Every number the page and the MCP
// server show comes out of public/nutrition-core.js, so this is where the
// sums are checked — with no server, no DOM and no clock.
const test = require('node:test');
const assert = require('node:assert');
const N = require('../public/nutrition-core.js');

const food = (o) => N.checkFood(N.normFood(Object.assign({ id: 'f1', name: 'Thing', servingSize: 1, servingUnit: 'serving', calories: 100, protein: 10, carbs: 10, fat: 2 }, o)));
const AMUL = food({ id: 'amul', name: 'Amul High Protein Milk', brand: 'Amul', servingSize: 200, servingUnit: 'ml', calories: 138, protein: 20, carbs: 19, fat: 1.5 });
const CHICKEN = food({ id: 'chk', name: 'Chicken Breast', servingSize: 100, servingUnit: 'g', calories: 165, protein: 31, carbs: 0, fat: 3.6 });
const BAR = food({ id: 'bar', name: 'Protein Bar', servingSize: 1, servingUnit: 'bar', calories: 181, protein: 10, carbs: null, fat: null });
const EGG = food({ id: 'egg', name: 'Whole Egg', servingSize: 1, servingUnit: 'egg', calories: 72, protein: 6.3, carbs: 0.4, fat: 4.8 });

// ------------------------------------------------------------- adding food

test('two servings of Amul come out at the label values doubled', () => {
  const e = N.makeEntry(AMUL, { meal: 'breakfast', quantity: 2, unit: 'serving' });
  assert.deepStrictEqual([e.calories, e.protein, e.carbs, e.fat], [276, 40, 38, 3]);
  assert.strictEqual(e.meal, 'breakfast');
  assert.strictEqual(e.foodId, 'amul');
});

test("a quantity in the food's own unit is divided by the serving size", () => {
  const e = N.makeEntry(CHICKEN, { meal: 'lunch', quantity: 200, unit: 'g' });
  assert.strictEqual(e.calories, 330);
  assert.strictEqual(e.protein, 62);
  assert.strictEqual(e.unit, 'g');
});

test('units match loosely on case and plural, but never across units', () => {
  assert.strictEqual(N.makeEntry(EGG, { meal: 'breakfast', quantity: 3, unit: 'Eggs' }).protein, 18.9);
  assert.throws(() => N.makeEntry(CHICKEN, { meal: 'lunch', quantity: 1, unit: 'kg' }), /unit must be/);
});

test('an entry keeps a copy of the numbers it was logged with', () => {
  const e = N.makeEntry(BAR, { meal: 'snack', quantity: 1 });
  assert.deepStrictEqual(e.serving, { size: 1, unit: 'bar', calories: 181, protein: 10, carbs: null, fat: null });
});

test('nonsense quantities and meals are refused, not stored', () => {
  assert.throws(() => N.makeEntry(AMUL, { meal: 'breakfast', quantity: 0 }), /positive/);
  assert.throws(() => N.makeEntry(AMUL, { meal: 'breakfast', quantity: -1 }), /positive/);
  assert.throws(() => N.makeEntry(AMUL, { meal: 'brunch', quantity: 1 }), /meal must be/);
  assert.throws(() => N.checkFood(N.normFood({ name: 'x' })), /calories/);
});

// ----------------------------------------------------------------- totals

const breakfast = [
  N.makeEntry(AMUL, { meal: 'breakfast', quantity: 2 }),
  N.makeEntry(BAR, { meal: 'breakfast', quantity: 1 }),
];

test('daily totals add every live entry', () => {
  const t = N.totals(breakfast);
  assert.strictEqual(t.calories, 457);
  assert.strictEqual(t.protein, 50);
  assert.strictEqual(t.count, 2);
});

test('a missing macro is counted as missing, not as zero', () => {
  const t = N.totals(breakfast);
  assert.strictEqual(t.fat, 3);                 // only the milk's fat is known
  assert.strictEqual(t.missing.fat, 1);         // and the page is told one entry had none
  assert.strictEqual(t.missing.carbs, 1);
  assert.strictEqual(t.missing.protein, 0);
});

test('deleted entries do not count', () => {
  const es = breakfast.concat([Object.assign(N.makeEntry(EGG, { meal: 'breakfast', quantity: 2 }), { deletedAt: 1 })]);
  assert.strictEqual(N.totals(es).calories, 457);
});

test('an empty day totals to zero with nothing missing', () => {
  const t = N.totals([]);
  assert.deepStrictEqual([t.calories, t.protein, t.carbs, t.fat, t.count], [0, 0, 0, 0, 0]);
  assert.deepStrictEqual(N.totals(undefined), t);
});

test('meals subtotal separately', () => {
  const es = breakfast.concat([N.makeEntry(CHICKEN, { meal: 'lunch', quantity: 150, unit: 'g' })]);
  const m = N.byMeal(es);
  assert.strictEqual(m.breakfast.totals.calories, 457);
  assert.strictEqual(m.lunch.totals.protein, 46.5);
  assert.strictEqual(m.dinner.entries.length, 0);
});

// -------------------------------------------------------------- remaining

const SETTINGS = N.normSettings({});

test('remaining calories and protein against the default targets', () => {
  const r = N.remaining({ calories: 1840, protein: 132, carbs: 0, fat: 0 }, N.targetsFor(SETTINGS, '2026-09-25'));
  assert.strictEqual(r.calories.target, 2450);
  assert.strictEqual(r.calories.left, 610);
  assert.strictEqual(r.calories.over, 0);
  assert.strictEqual(r.protein.left, 38);
});

test('going over shows how far over, never a negative left', () => {
  const r = N.remaining({ calories: 2600, protein: 180, carbs: 0, fat: 80 }, N.targetsFor(SETTINGS, '2026-09-25'));
  assert.strictEqual(r.calories.left, 0);
  assert.strictEqual(r.calories.over, 150);
  assert.strictEqual(r.protein.over, 10);
  assert.strictEqual(r.calories.pct, 1);
});

test('a macro with no target has no remaining at all', () => {
  const r = N.remaining({ calories: 0, protein: 0, carbs: 200, fat: 0 }, N.targetsFor(SETTINGS, '2026-09-25'));
  assert.strictEqual(r.carbs, null);            // no carb target by default
  assert.notStrictEqual(r.fat, null);
});

// ------------------------------------------------------ updating quantities

test('changing a quantity recomputes from the entry, not the library', () => {
  const e = N.makeEntry(BAR, { meal: 'snack', quantity: 1 });
  // requantify is not even handed the library: whatever the saved bar says
  // now, the entry can only be recomputed from its own copy.
  const two = N.requantify(e, 2);
  assert.strictEqual(two.calories, 362);        // 181 × 2, not 190 × 2
  assert.strictEqual(two.quantity, 2);
});

test('a quantity can switch between servings and the food unit', () => {
  const e = N.makeEntry(CHICKEN, { meal: 'lunch', quantity: 1 });
  assert.strictEqual(N.requantify(e, 250, 'g').calories, 413);
});

// ------------------------------------------------------------ copying meals

test('copying rebuilds from the saved food when it still exists', () => {
  const old = [N.makeEntry(BAR, { meal: 'breakfast', quantity: 1, notes: 'after gym' })];
  const fixed = food({ id: 'bar', name: 'Protein Bar', servingUnit: 'bar', calories: 190, protein: 12, carbs: 20, fat: 7 });
  const [c] = N.copyEntries(old, 'breakfast', new Map([['bar', fixed]]));
  assert.strictEqual(c.calories, 190);          // today's knowledge…
  assert.strictEqual(old[0].calories, 181);     // …and the old day untouched
  assert.strictEqual(c.notes, 'after gym');
  assert.strictEqual(c.id, undefined);          // identity is the server's to give
});

test('copying keeps the old numbers when the food has been archived', () => {
  const old = [N.makeEntry(BAR, { meal: 'breakfast', quantity: 1 })];
  const gone = Object.assign({}, BAR, { archived: true, calories: 999 });
  const [c] = N.copyEntries(old, 'lunch', new Map([['bar', gone]]));
  assert.strictEqual(c.calories, 181);
  assert.strictEqual(c.meal, 'lunch');
});

test('copying skips deleted entries', () => {
  const es = [N.makeEntry(EGG, { meal: 'breakfast', quantity: 2 }),
    Object.assign(N.makeEntry(AMUL, { meal: 'breakfast', quantity: 1 }), { deletedAt: 5 })];
  assert.strictEqual(N.copyEntries(es, 'breakfast', new Map()).length, 1);
});

test('the meal to repeat is the most recent earlier one', () => {
  const days = {
    '2026-09-22': [N.makeEntry(EGG, { meal: 'breakfast', quantity: 2 })],
    '2026-09-23': [N.makeEntry(CHICKEN, { meal: 'lunch', quantity: 1 })],   // no breakfast
    '2026-09-25': [N.makeEntry(AMUL, { meal: 'breakfast', quantity: 1 })],  // today, not a source
  };
  assert.strictEqual(N.lastMealBefore(days, '2026-09-25', 'breakfast').date, '2026-09-22');
  assert.strictEqual(N.lastMealBefore(days, '2026-09-25', 'dinner'), null);
});

// ------------------------------------------------------------------ targets

test('a target change applies from its day forward, not to history', () => {
  const s = N.withTargets(SETTINGS, { calories: 2300 }, '2026-09-25');
  assert.strictEqual(N.targetsFor(s, '2026-09-24').calories, 2450);
  assert.strictEqual(N.targetsFor(s, '2026-09-25').calories, 2300);
  assert.strictEqual(N.targetsFor(s, '2026-10-30').calories, 2300);
  assert.strictEqual(N.targetsFor(s, '2026-09-25').protein, 170, 'untouched fields carry over');
});

test('two changes on the same day leave one entry for that day', () => {
  let s = N.withTargets(SETTINGS, { calories: 2300 }, '2026-09-25');
  s = N.withTargets(s, { protein: 180 }, '2026-09-25');
  assert.strictEqual(s.targets.filter((t) => t.from === '2026-09-25').length, 1);
  assert.deepStrictEqual([N.targetsFor(s, '2026-09-25').calories, N.targetsFor(s, '2026-09-25').protein], [2300, 180]);
});

test('defaults are the ones asked for, and stored rather than hard-coded', () => {
  const t = N.targetsFor(N.normSettings(null), '2026-01-01');
  assert.deepStrictEqual([t.calories, t.protein, t.fat, t.carbs], [2450, 170, 70, null]);
  assert.strictEqual(N.normSettings(null).goal, 'cut');
});

// ------------------------------------------------------------------ weight

const W = (date, kg, extra) => Object.assign({ id: date, date, kg, updatedAt: 1 }, extra);

test('logging weight: today, latest and averages', () => {
  const ws = [W('2026-09-19', 80.6), W('2026-09-21', 80.2), W('2026-09-23', 80.0), W('2026-09-25', 79.6)];
  const s = N.weightStats(ws, '2026-09-25');
  assert.strictEqual(s.today, 79.6);
  assert.deepStrictEqual(s.latest, { date: '2026-09-25', kg: 79.6 });
  assert.strictEqual(s.avg7, 80.1);             // 80.6, 80.2, 80.0, 79.6
});

test('the 7-day average is exactly seven calendar days', () => {
  const ws = [W('2026-09-18', 90), W('2026-09-19', 80), W('2026-09-25', 80)];
  // 09-19 … 09-25 is seven days; 09-18 falls outside.
  assert.strictEqual(N.weightStats(ws, '2026-09-25').avg7, 80);
});

test('a day with no weigh-in has no "today", but still a latest', () => {
  const s = N.weightStats([W('2026-09-20', 80.4)], '2026-09-25');
  assert.strictEqual(s.today, null);
  assert.strictEqual(s.latest.date, '2026-09-20');
});

test('deleted weigh-ins are gone from every figure', () => {
  const s = N.weightStats([W('2026-09-25', 79.6), W('2026-09-24', 99, { id: 'x', deletedAt: 3 })], '2026-09-25');
  assert.strictEqual(s.avg7, 79.6);
});

test('no weights at all is a quiet empty, not an error', () => {
  const s = N.weightStats([], '2026-09-25');
  assert.deepStrictEqual(s, { today: null, latest: null, avg7: null, avg30: null });
});

test('the trend carries a running 7-day average', () => {
  const ws = [W('2026-09-20', 81), W('2026-09-22', 80), W('2026-09-24', 79)];
  const t = N.weightTrend(ws, '2026-09-21', '2026-09-30');
  assert.deepStrictEqual(t.map((x) => x.date), ['2026-09-22', '2026-09-24']);
  assert.strictEqual(t[0].avg7, 80.5);          // reaches back to 09-20
  assert.strictEqual(t[1].avg7, 80);
});

// ----------------------------------------------------------------- summary

test('the summary averages over logged days only', () => {
  const day = (cal, pro) => [Object.assign(N.makeEntry(food({ calories: cal, protein: pro }), { meal: 'lunch', quantity: 1 }))];
  const days = {
    '2026-09-19': day(2400, 175),
    '2026-09-20': day(2500, 160),
    // 09-21 not tracked at all
    '2026-09-22': day(2300, 170),
  };
  const s = N.summary({ days, weights: [W('2026-09-19', 79.8), W('2026-09-22', 79.3)], settings: SETTINGS, from: '2026-09-19', to: '2026-09-25' });
  assert.strictEqual(s.days, 7);
  assert.strictEqual(s.daysLogged, 3);
  assert.strictEqual(s.averages.calories, 2400);
  assert.strictEqual(s.averages.protein, 168.3);
  assert.deepStrictEqual(s.calorieTarget, { rule: 'at or under', hit: 2, of: 3 });
  assert.deepStrictEqual(s.proteinTarget, { hit: 2, of: 3 });
  assert.deepStrictEqual([s.weight.first.kg, s.weight.last.kg, s.weight.change], [79.8, 79.3, -0.5]);
});

test('an empty week summarises to nothing rather than zeros', () => {
  const s = N.summary({ days: {}, weights: [], settings: SETTINGS, from: '2026-09-19', to: '2026-09-25' });
  assert.strictEqual(s.daysLogged, 0);
  assert.strictEqual(s.averages.calories, null);
  assert.strictEqual(s.weight.change, null);
  assert.deepStrictEqual(s.calorieTarget, { rule: 'at or under', hit: 0, of: 0 });
});

test('a gaining goal flips what counts as within the calorie target', () => {
  const days = { '2026-09-25': [N.makeEntry(food({ calories: 2600 }), { meal: 'lunch', quantity: 1 })] };
  const s = N.summary({ days, weights: [], settings: N.normSettings({ goal: 'gain' }), from: '2026-09-25', to: '2026-09-25' });
  assert.deepStrictEqual(s.calorieTarget, { rule: 'at or over', hit: 1, of: 1 });
});

test('each day in a summary is judged by the targets of that day', () => {
  const s0 = N.withTargets(SETTINGS, { calories: 2000 }, '2026-09-25');
  const day = (cal) => [N.makeEntry(food({ calories: cal }), { meal: 'lunch', quantity: 1 })];
  const s = N.summary({ days: { '2026-09-24': day(2400), '2026-09-25': day(2400) }, weights: [], settings: s0, from: '2026-09-24', to: '2026-09-25' });
  assert.strictEqual(s.calorieTarget.hit, 1);   // under 2450 on the 24th, over 2000 on the 25th
});

// ------------------------------------------------------------ date bounds

test('day arithmetic crosses months, years and leap days', () => {
  assert.strictEqual(N.shiftDay('2026-09-30', 1), '2026-10-01');
  assert.strictEqual(N.shiftDay('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(N.shiftDay('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(N.shiftDay('2026-03-01', -1), '2026-02-28');
});

test('day arithmetic survives daylight-saving changes', () => {
  // Europe and the US both shift in March and October/November; noon anchoring
  // means stepping a day never lands on the same date twice or skips one.
  const days = N.dayRange('2026-03-01', '2026-11-30');
  assert.strictEqual(new Set(days).size, days.length);
  for (let i = 1; i < days.length; i++) assert.strictEqual(N.shiftDay(days[i - 1], 1), days[i]);
});

test('ranges include both ends and refuse nonsense', () => {
  assert.deepStrictEqual(N.dayRange('2026-09-24', '2026-09-26'), ['2026-09-24', '2026-09-25', '2026-09-26']);
  assert.deepStrictEqual(N.dayRange('2026-09-26', '2026-09-24'), []);
  assert.deepStrictEqual(N.dayRange('nope', '2026-09-24'), []);
  assert.ok(N.dayRange('1900-01-01', '2026-01-01').length <= 800);
});

test('the default meal follows the clock', () => {
  assert.deepStrictEqual([7, 12, 16, 20, 23].map(N.mealForHour), ['breakfast', 'lunch', 'snack', 'dinner', 'snack']);
});

// ----------------------------------------------------------------- search

const LIB = N.SEED_FOODS.map((f, i) => N.normFood(Object.assign({ id: 's' + i }, f)));

test('typing "amul" finds the Amul milk', () => {
  assert.strictEqual(N.searchFoods(LIB, 'amul')[0].name, 'Amul High Protein Milk');
});

test('a spoken name resolves to one food, or hands back the tie', () => {
  assert.strictEqual(N.resolveFood(LIB, 'amul protein shake').food.name, 'Amul High Protein Milk');
  assert.strictEqual(N.resolveFood(LIB, 'chicken breast').food.name, 'Chicken Breast');
  assert.strictEqual(N.resolveFood(LIB, 'eggs').food.name, 'Whole Egg');
  const tie = N.resolveFood(LIB, 'chicken');
  assert.strictEqual(tie.food, null);
  assert.strictEqual(tie.matches.length, 2);
  assert.strictEqual(N.resolveFood(LIB, 'pizza').food, null);
});

test('archived foods are not offered', () => {
  const lib = LIB.map((f) => (f.name === 'Banana' ? Object.assign({}, f, { archived: true }) : f));
  assert.strictEqual(N.searchFoods(lib, 'banana').length, 0);
});

test('recent is order of use; frequent needs more than one use', () => {
  const e = (f, meal, at) => Object.assign(N.makeEntry(f, { meal, quantity: 2 }), { createdAt: at });
  const days = {
    '2026-09-23': [e(EGG, 'breakfast', 1), e(AMUL, 'breakfast', 2)],
    '2026-09-24': [e(EGG, 'breakfast', 3)],
    '2026-09-25': [e(CHICKEN, 'lunch', 4)],
  };
  const q = N.quickPicks(days, [EGG, AMUL, CHICKEN]);
  assert.deepStrictEqual(q.recent.map((x) => x.food.id), ['chk', 'egg', 'amul']);
  assert.deepStrictEqual(q.frequent.map((x) => x.food.id), ['egg']);
  assert.strictEqual(q.recent[0].lastQuantity, 2);
});

test('the starter foods are all valid, and only Amul claims to be exact', () => {
  LIB.forEach((f) => N.checkFood(f));
  assert.strictEqual(LIB.length, 12);
  const amul = LIB.find((f) => f.brand === 'Amul');
  assert.deepStrictEqual([amul.servingSize, amul.calories, amul.protein, amul.carbs, amul.fat, amul.estimate], [200, 138, 20, 19, 1.5, false]);
  assert.ok(LIB.filter((f) => f.estimate).length >= 9);
});
