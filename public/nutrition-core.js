// Nutrition — the arithmetic, and nothing else.
//
// One file, loaded twice: server.js requires it for every rule that touches
// the data, and the page loads it as a plain script for the live preview in
// the add-food flow. The number the page shows before you press Add has to be
// the number the server writes after, and the only way to promise that is for
// there to be one copy of the sum.
//
// It never asks what day it is. Callers pass the day in, from the app's own
// local-date helpers, so "today" means exactly what it means on the board and
// every function here can be tested against any date.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Nutrition = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MEALS = ['breakfast', 'lunch', 'snack', 'dinner', 'other'];
  const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', snack: 'Snack', dinner: 'Dinner', other: 'Other' };
  const GOALS = ['maintain', 'cut', 'gain'];
  const MACROS = ['calories', 'protein', 'carbs', 'fat'];

  // Targets are a dated history rather than one set of numbers. Changing the
  // calorie target today must not quietly re-mark last week's days as over or
  // under, so each change applies from a day onward and every day is judged
  // against the targets that were in force on it. `from: ''` sorts before any
  // date, so it is the target for everything before the first change.
  const DEFAULT_SETTINGS = {
    goal: 'cut', weightKg: 80, heightCm: 180, age: 21,
    targets: [{ from: '', calories: 2450, protein: 170, fat: 70, carbs: null }],
  };

  // Starter foods. Only the Amul figures are exact — they are off the label.
  // Everything else is a typical published value for a common preparation and
  // is marked `estimate`, because a roti with ghee or chicken cooked in oil is
  // a different food, and pretending otherwise is how tracking drifts.
  const SEED_FOODS = [
    { name: 'Amul High Protein Milk', brand: 'Amul', servingSize: 200, servingUnit: 'ml',
      calories: 138, protein: 20, carbs: 19, fat: 1.5, notes: 'Label values, per 200 ml.' },
    { name: 'Whole Egg', servingSize: 1, servingUnit: 'egg',
      calories: 72, protein: 6.3, carbs: 0.4, fat: 4.8, estimate: true,
      notes: 'Large egg, about 50 g, boiled. Frying adds whatever oil it takes up.' },
    { name: 'Chicken Breast', servingSize: 100, servingUnit: 'g',
      calories: 165, protein: 31, carbs: 0, fat: 3.6, estimate: true,
      notes: 'Cooked, skinless, weighed after cooking. Raw is closer to 120 kcal and 23 g protein per 100 g. Oil and marinade are extra.' },
    { name: 'Protein Bar', servingSize: 1, servingUnit: 'bar',
      calories: 181, protein: 10, carbs: null, fat: null,
      notes: 'Carbs and fat not entered yet — they are on the wrapper.' },
    { name: 'Banana', servingSize: 1, servingUnit: 'banana',
      calories: 105, protein: 1.3, carbs: 27, fat: 0.4, estimate: true, notes: 'Medium, about 118 g.' },
    { name: 'Apple', servingSize: 1, servingUnit: 'apple',
      calories: 95, protein: 0.5, carbs: 25, fat: 0.3, estimate: true, notes: 'Medium, about 180 g.' },
    { name: 'Roti', servingSize: 1, servingUnit: 'roti',
      calories: 110, protein: 3, carbs: 18, fat: 3, estimate: true,
      notes: 'Medium whole-wheat, about 40 g, no ghee. A teaspoon of ghee adds about 45 kcal.' },
    { name: 'Rice', servingSize: 100, servingUnit: 'g',
      calories: 130, protein: 2.7, carbs: 28, fat: 0.3, estimate: true, notes: 'Cooked white rice, weighed cooked.' },
    { name: 'Tea', servingSize: 1, servingUnit: 'cup',
      calories: 70, protein: 2, carbs: 10, fat: 2, estimate: true,
      notes: 'Chai with milk and one teaspoon of sugar. Moves a lot with the milk and sugar.' },
    { name: 'Coffee', servingSize: 1, servingUnit: 'cup',
      calories: 60, protein: 1, carbs: 9, fat: 2, estimate: true,
      notes: 'With milk and sugar. Black coffee is about 2 kcal.' },
    { name: 'French Fries', servingSize: 100, servingUnit: 'g',
      calories: 312, protein: 3.4, carbs: 41, fat: 15, estimate: true,
      notes: 'Deep fried. Varies a lot by restaurant and oil.' },
    { name: 'Chicken Nuggets', servingSize: 6, servingUnit: 'pieces',
      calories: 260, protein: 14, carbs: 16, fat: 15, estimate: true,
      notes: 'Fast-food style, per 6 pieces. Varies by brand.' },
  ];

  // ------------------------------------------------------------- numbers

  // A macro is a number or it is unknown. Unknown is not zero: a protein bar
  // whose fat you never read off the wrapper does not have 0 g of fat, and the
  // totals say how many entries they could not count rather than pretending.
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const r1 = (n) => Math.round(n * 10) / 10;
  function roundMacro(k, v) {
    if (v == null) return null;
    return k === 'calories' ? Math.round(v) : r1(v);
  }

  // ---------------------------------------------------------------- dates

  const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  // Noon, so a daylight-saving change can never carry the sum across midnight
  // and hand back the wrong day.
  function shiftDay(day, n) {
    const d = new Date(day + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Both ends included. Capped, because a typo'd year should cost an error,
  // not a loop over every day since the Romans.
  function dayRange(from, to) {
    if (!isDay(from) || !isDay(to) || from > to) return [];
    const out = [];
    for (let d = from; d <= to && out.length < 800; d = shiftDay(d, 1)) out.push(d);
    return out;
  }
  function mealForHour(h) {
    if (h < 11) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 18) return 'snack';
    if (h < 22) return 'dinner';
    return 'snack';
  }
  function theMeal(m) {
    const k = String(m || '').toLowerCase().trim();
    if (!MEALS.includes(k)) throw new Error('meal must be one of ' + MEALS.join(', '));
    return k;
  }

  // ---------------------------------------------------------------- foods

  function normFood(f) {
    f = f || {};
    return {
      id: f.id,
      name: String(f.name || '').trim(),
      brand: String(f.brand || '').trim(),
      servingSize: num(f.servingSize) || 1,
      servingUnit: String(f.servingUnit || '').trim() || 'serving',
      calories: num(f.calories), protein: num(f.protein), carbs: num(f.carbs), fat: num(f.fat),
      notes: String(f.notes || ''),
      estimate: !!f.estimate,
      archived: !!f.archived,
      createdAt: f.createdAt, updatedAt: f.updatedAt,
    };
  }
  function checkFood(f) {
    if (!f.name) throw new Error('a food needs a name');
    if (f.calories == null) throw new Error('a food needs its calories per serving');
    return f;
  }

  // Units compare loosely: "Eggs", "egg" and " egg " are the same unit, so are
  // "piece" and "pieces". Both sides go through the same squeeze, so this can
  // only ever make two spellings agree, never make "g" match "kg".
  function unitKey(u) {
    let s = String(u || '').toLowerCase().trim();
    if (s.length > 2 && s.endsWith('s')) s = s.slice(0, -1);
    return s;
  }
  // Which of the two units a quantity is in. "serving" always works; so does
  // the food's own unit, which is divided by the serving size — 200 g of a
  // food listed per 100 g is two servings.
  function unitFor(serving, unit) {
    if (unit == null || unit === '' || unitKey(unit) === 'serving') return 'serving';
    if (unitKey(unit) === unitKey(serving.unit)) return serving.unit;
    throw new Error('unit must be "serving" or "' + serving.unit + '", got ' + JSON.stringify(unit));
  }
  function servingsFor(serving, quantity, unit) {
    const q = num(quantity);
    if (q == null || q <= 0) throw new Error('quantity must be a positive number');
    return unitFor(serving, unit) === 'serving' ? q : q / (serving.size || 1);
  }
  function macrosFor(serving, quantity, unit) {
    const m = servingsFor(serving, quantity, unit);
    const out = {};
    MACROS.forEach((k) => { out[k] = serving[k] == null ? null : roundMacro(k, serving[k] * m); });
    return out;
  }

  // ------------------------------------------------------------- entries
  //
  // An entry carries a copy of the per-serving values it was logged with.
  // That copy is the point: editing the saved Protein Bar from 181 to 190 kcal
  // later is a correction for the future, not a rewrite of what you ate on a
  // day that is already over. Changing an entry's quantity recomputes from its
  // OWN copy, for the same reason.

  function servingOf(food) {
    return {
      size: food.servingSize, unit: food.servingUnit,
      calories: food.calories, protein: food.protein, carbs: food.carbs, fat: food.fat,
    };
  }
  function makeEntry(food, o) {
    o = o || {};
    const serving = servingOf(food);
    const unit = unitFor(serving, o.unit);
    return Object.assign({
      meal: theMeal(o.meal),
      foodId: food.id || null,
      name: food.name,
      brand: food.brand || '',
      quantity: num(o.quantity),
      unit,
      serving,
      notes: String(o.notes || '').trim(),
      estimate: !!food.estimate,
    }, macrosFor(serving, o.quantity, unit));
  }
  // Something eaten once — a restaurant plate — logged with its own numbers
  // and no food behind it. Its "serving" is the thing itself.
  function customFood(c) {
    return checkFood(normFood({
      name: c.name, brand: c.brand, servingSize: 1, servingUnit: 'serving',
      calories: c.calories, protein: c.protein, carbs: c.carbs, fat: c.fat,
    }));
  }
  function requantify(entry, quantity, unit) {
    const u = unitFor(entry.serving, unit === undefined ? entry.unit : unit);
    return Object.assign({}, entry, { quantity: num(quantity), unit: u }, macrosFor(entry.serving, quantity, u));
  }

  const live = (xs) => (Array.isArray(xs) ? xs : []).filter((x) => x && !x.deletedAt);

  function totals(entries) {
    const t = { calories: 0, protein: 0, carbs: 0, fat: 0, count: 0,
      missing: { calories: 0, protein: 0, carbs: 0, fat: 0 } };
    live(entries).forEach((e) => {
      t.count++;
      MACROS.forEach((k) => { if (e[k] == null) t.missing[k]++; else t[k] += e[k]; });
    });
    MACROS.forEach((k) => { t[k] = roundMacro(k, t[k]); });
    return t;
  }
  function byMeal(entries) {
    const out = {};
    MEALS.forEach((m) => {
      const es = live(entries).filter((e) => e.meal === m);
      out[m] = { entries: es, totals: totals(es) };
    });
    return out;
  }

  // Repeating a meal logs it again with what you know NOW: if the saved food
  // behind an entry still exists, the new entry is built from it, so a label
  // you corrected last week is not undone by copying an older breakfast. Only
  // a food that has since been archived — or whose unit no longer fits the
  // quantity — falls back to the old entry's copy of the numbers.
  function copyEntries(entries, toMeal, foodsById) {
    const meal = theMeal(toMeal);
    return live(entries).map((e) => {
      const f = e.foodId && foodsById && foodsById.get(e.foodId);
      if (f && !f.archived) {
        try { return makeEntry(f, { meal, quantity: e.quantity, unit: e.unit, notes: e.notes }); } catch {}
      }
      const out = { meal, foodId: e.foodId || null, name: e.name, brand: e.brand || '',
        quantity: e.quantity, unit: e.unit, serving: e.serving, notes: e.notes || '', estimate: !!e.estimate };
      MACROS.forEach((k) => { out[k] = e[k] == null ? null : e[k]; });
      return out;
    });
  }
  // The most recent day before `toDate` that has anything in `meal`. `days`
  // is { 'YYYY-MM-DD': entries }.
  function lastMealBefore(days, toDate, meal) {
    const m = theMeal(meal);
    const earlier = Object.keys(days || {}).filter((d) => d < toDate).sort().reverse();
    for (const d of earlier) {
      const es = live(days[d]).filter((e) => e.meal === m);
      if (es.length) return { date: d, entries: es };
    }
    return null;
  }

  // ------------------------------------------------------------- targets

  function normTarget(t) {
    return {
      from: isDay(t && t.from) ? t.from : '',
      calories: num(t && t.calories), protein: num(t && t.protein),
      fat: num(t && t.fat), carbs: num(t && t.carbs),
    };
  }
  function normSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    const d = DEFAULT_SETTINGS;
    let targets = Array.isArray(s.targets) && s.targets.length
      ? s.targets.map(normTarget) : d.targets.map(normTarget);
    targets.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    // One per day at most: the later write wins.
    targets = targets.filter((t, i) => i === targets.length - 1 || targets[i + 1].from !== t.from);
    return {
      goal: GOALS.includes(s.goal) ? s.goal : d.goal,
      weightKg: num(s.weightKg) != null ? num(s.weightKg) : d.weightKg,
      heightCm: num(s.heightCm) != null ? num(s.heightCm) : d.heightCm,
      age: num(s.age) != null ? num(s.age) : d.age,
      targets,
    };
  }
  function targetsFor(settings, day) {
    const list = normSettings(settings).targets;
    let cur = list[0];
    for (const t of list) if (t.from <= day) cur = t;
    return { calories: cur.calories, protein: cur.protein, fat: cur.fat, carbs: cur.carbs, from: cur.from };
  }
  // New targets take effect from `from` onward. Fields left out keep the value
  // that was in force on that day, so changing only protein does not wipe the
  // calorie target.
  function withTargets(settings, patch, from) {
    const s = normSettings(settings);
    const base = targetsFor(s, from);
    const next = normTarget(Object.assign({}, base, pickKnown(patch, ['calories', 'protein', 'fat', 'carbs']), { from }));
    s.targets = s.targets.filter((t) => t.from !== from).concat(next);
    return normSettings(s);
  }
  function pickKnown(o, keys) {
    const out = {};
    keys.forEach((k) => { if (o && o[k] !== undefined) out[k] = o[k]; });
    return out;
  }

  // Remaining, per macro. `left` and `over` are both non-negative so the page
  // never has to reason about a minus sign: over the target is a fact to show
  // plainly, not a negative number to be alarmed by.
  function remaining(t, targets) {
    const out = {};
    MACROS.forEach((k) => {
      const target = targets ? targets[k] : null;
      if (target == null) { out[k] = null; return; }
      const diff = target - t[k];
      out[k] = {
        target, consumed: t[k],
        left: roundMacro(k, Math.max(0, diff)),
        over: roundMacro(k, Math.max(0, -diff)),
        pct: target > 0 ? Math.min(1, t[k] / target) : 0,
      };
    });
    return out;
  }

  // ------------------------------------------------------------- weights

  function normWeight(w) {
    return {
      id: w && w.id, date: w && w.date, kg: num(w && w.kg),
      createdAt: w && w.createdAt, updatedAt: w && w.updatedAt, deletedAt: (w && w.deletedAt) || null,
    };
  }
  // One reading per day. If two ever exist for a day — two laptops, say — the
  // later edit is the one that counts.
  function weightByDay(weights) {
    const m = new Map();
    live(weights).map(normWeight)
      .filter((w) => isDay(w.date) && w.kg != null)
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      .forEach((w) => m.set(w.date, w.kg));
    return m;
  }
  function avgWindow(byDay, day, n) {
    const vals = [];
    for (let i = 0; i < n; i++) {
      const v = byDay.get(shiftDay(day, -i));
      if (v != null) vals.push(v);
    }
    return vals.length ? r1(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  }
  function weightStats(weights, day) {
    const m = weightByDay(weights);
    const before = [...m.keys()].filter((d) => d <= day).sort();
    const last = before[before.length - 1];
    return {
      today: m.has(day) ? m.get(day) : null,
      latest: last ? { date: last, kg: m.get(last) } : null,
      avg7: avgWindow(m, day, 7),
      avg30: avgWindow(m, day, 30),
    };
  }
  // Every weigh-in in the range with the 7-day average ending on it. The
  // average may reach back before `from`; that is what an average is.
  function weightTrend(weights, from, to) {
    const m = weightByDay(weights);
    return [...m.keys()].filter((d) => d >= from && d <= to).sort()
      .map((d) => ({ date: d, kg: m.get(d), avg7: avgWindow(m, d, 7) }));
  }

  // ------------------------------------------------------------- summary
  //
  // Facts about a stretch of days, and no score. Averages are over the days
  // that have anything logged — a day you did not track is missing data, not
  // a day you ate nothing, and averaging it in as zero would make every
  // untracked weekend look like a heroic deficit.
  function summary(o) {
    const settings = normSettings(o.settings);
    const range = dayRange(o.from, o.to);
    const days = o.days || {};
    const per = range.filter((d) => live(days[d]).length)
      .map((d) => ({ date: d, totals: totals(days[d]), targets: targetsFor(settings, d) }));
    const avg = (k) => (per.length ? roundMacro(k, per.reduce((s, p) => s + p.totals[k], 0) / per.length) : null);
    // What "within" means depends on the direction you are going.
    const rule = settings.goal === 'gain' ? 'at or over' : 'at or under';
    const calJudged = per.filter((p) => p.targets.calories != null);
    const calHit = calJudged.filter((p) => (settings.goal === 'gain'
      ? p.totals.calories >= p.targets.calories : p.totals.calories <= p.targets.calories)).length;
    const proJudged = per.filter((p) => p.targets.protein != null);
    const proHit = proJudged.filter((p) => p.totals.protein >= p.targets.protein).length;

    const m = weightByDay(o.weights);
    const readings = [...m.keys()].filter((d) => d >= o.from && d <= o.to).sort();
    const first = readings.length ? { date: readings[0], kg: m.get(readings[0]) } : null;
    const lastD = readings[readings.length - 1];
    const last = readings.length ? { date: lastD, kg: m.get(lastD) } : null;
    return {
      from: o.from, to: o.to, days: range.length, daysLogged: per.length,
      averages: { calories: avg('calories'), protein: avg('protein'), carbs: avg('carbs'), fat: avg('fat') },
      calorieTarget: { rule, hit: calHit, of: calJudged.length },
      proteinTarget: { hit: proHit, of: proJudged.length },
      weight: {
        readings: readings.length,
        average: readings.length ? r1(readings.reduce((s, d) => s + m.get(d), 0) / readings.length) : null,
        first, last,
        change: first && last && readings.length > 1 ? r1(last.kg - first.kg) : null,
      },
      perDay: per.map((p) => ({ date: p.date, totals: p.totals })),
    };
  }

  // -------------------------------------------------------------- search

  function tokens(q) {
    return String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
  }
  // Scored by how many of the typed words appear in the name or brand, with a
  // lift for the name starting with what you typed — so "amul" finds the Amul
  // milk and "chicken breast" picks the breast over the nuggets.
  function searchFoods(foods, q) {
    const ts = tokens(q);
    if (!ts.length) return [];
    const whole = String(q).toLowerCase().trim();
    return (foods || []).filter((f) => f && !f.archived).map((f) => {
      const hay = (f.name + ' ' + (f.brand || '')).toLowerCase();
      let score = ts.filter((t) => hay.includes(t)).length * 10;
      if (f.name.toLowerCase().startsWith(whole)) score += 5;
      if (f.name.toLowerCase() === whole) score += 20;
      return { f, score };
    }).filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.f.name.length - b.f.name.length || a.f.name.localeCompare(b.f.name))
      .map((x) => x.f);
  }
  // For something that has to pick exactly one — a request from Claude.
  // Unique best match wins; a tie is handed back rather than guessed at.
  function resolveFood(foods, q) {
    const hits = searchFoods(foods, q);
    if (!hits.length) return { food: null, matches: [] };
    const ts = tokens(q);
    const score = (f) => {
      const hay = (f.name + ' ' + (f.brand || '')).toLowerCase();
      return ts.filter((t) => hay.includes(t)).length + (f.name.toLowerCase() === String(q).toLowerCase().trim() ? 100 : 0);
    };
    const top = score(hits[0]);
    const tied = hits.filter((f) => score(f) === top);
    return tied.length === 1 ? { food: hits[0], matches: hits } : { food: null, matches: tied };
  }

  // What you reach for. `days` is { date: entries } over the look-back window.
  // Recent is the order you last used things; frequent is how often, and only
  // counts something you have had more than once — one lunch is not a habit.
  function quickPicks(days, foods, limit) {
    const n = limit || 8;
    const byId = new Map((foods || []).filter((f) => f && !f.archived).map((f) => [f.id, f]));
    const uses = new Map();
    let seq = 0;
    Object.keys(days || {}).sort().forEach((d) => {
      live(days[d]).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).forEach((e) => {
        if (!e.foodId || !byId.has(e.foodId)) return;
        const u = uses.get(e.foodId) || { count: 0, last: 0 };
        u.count++;
        u.last = ++seq;
        u.quantity = e.quantity; u.unit = e.unit; u.meal = e.meal;
        uses.set(e.foodId, u);
      });
    });
    const row = ([id, u]) => ({ food: byId.get(id), count: u.count, lastQuantity: u.quantity, lastUnit: u.unit });
    const all = [...uses.entries()];
    return {
      recent: all.slice().sort((a, b) => b[1].last - a[1].last).slice(0, n).map(row),
      frequent: all.filter(([, u]) => u.count > 1)
        .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last).slice(0, n).map(row),
    };
  }

  return {
    MEALS, MEAL_LABEL, GOALS, MACROS, DEFAULT_SETTINGS, SEED_FOODS,
    num, roundMacro, isDay, shiftDay, dayRange, mealForHour, theMeal,
    normFood, checkFood, unitFor, servingsFor, macrosFor,
    makeEntry, customFood, requantify, live, totals, byMeal, copyEntries, lastMealBefore,
    normSettings, targetsFor, withTargets, remaining,
    normWeight, weightByDay, weightStats, weightTrend,
    summary, searchFoods, resolveFood, quickPicks,
  };
});
