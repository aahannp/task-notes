// The nutrition MCP tools, over real stdio JSON-RPC, against a real server on
// a throwaway data directory — the path Claude actually takes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-nutrition-mcp-'));
const PORT = 5996 + Math.floor(Math.random() * 3);
const BASE = 'http://127.0.0.1:' + PORT;
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TODAY = iso(new Date());
let server, mcp, buf = '', seq = 0;
const waiting = new Map();

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), TASKNOTES_DATA: DIR }), stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/rev'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  // The MCP server finds the app through the port file the server writes.
  for (let i = 0; i < 50 && !fs.existsSync(path.join(DIR, 'port.json')); i++) await new Promise((r) => setTimeout(r, 50));
  mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'tasknotes.js')], {
    env: Object.assign({}, process.env, { TASKNOTES_DATA: DIR }), stdio: ['pipe', 'pipe', 'ignore'],
  });
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
});
after(() => { if (mcp) mcp.kill(); if (server) server.kill(); fs.rmSync(DIR, { recursive: true, force: true }); });

function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  return { text: r.result.content[0].text, error: !!r.result.isError };
}

test('every nutrition tool is listed, and none of them deletes', async () => {
  const r = await rpc('tools/list', {});
  const names = r.result.tools.map((t) => t.name).filter((n) => n.startsWith('nutrition_'));
  for (const want of ['nutrition_today', 'nutrition_get_day', 'nutrition_log_food', 'nutrition_update_food_log',
    'nutrition_add_food', 'nutrition_update_food', 'nutrition_log_weight', 'nutrition_get_weight_history',
    'nutrition_summary', 'nutrition_update_settings', 'nutrition_copy_meal', 'nutrition_list_foods']) {
    assert.ok(names.includes(want), want);
  }
  assert.ok(!names.some((n) => /delete|remove/.test(n)));
});

test('"Log two Amul protein shakes for breakfast."', async () => {
  const r = await call('nutrition_log_food', { food: 'Amul protein shake', quantity: 2, meal: 'breakfast' });
  assert.ok(!r.error, r.text);
  assert.match(r.text, /Logged Amul High Protein Milk × 2 servings to breakfast/);
  assert.match(r.text, /276 kcal · 40 g protein/);
});

test('"Log 200g chicken breast for lunch."', async () => {
  const r = await call('nutrition_log_food', { food: 'chicken breast', quantity: 200, unit: 'g', meal: 'lunch' });
  assert.ok(!r.error, r.text);
  assert.match(r.text, /330 kcal/);
  assert.match(r.text, /typical estimate/, 'an estimated food says so');
});

test('an ambiguous food is handed back with its options, not guessed', async () => {
  const r = await call('nutrition_log_food', { food: 'chicken', quantity: 1, meal: 'dinner' });
  assert.ok(r.error);
  assert.match(r.text, /More than one saved food matches/);
  assert.match(r.text, /Chicken Breast \[/);
  assert.match(r.text, /Chicken Nuggets \[/);
});

test('an unknown food needs its numbers', async () => {
  const miss = await call('nutrition_log_food', { food: 'masala dosa', meal: 'dinner' });
  assert.ok(miss.error);
  assert.match(miss.text, /Give its calories/);
  const hit = await call('nutrition_log_food', { food: 'masala dosa', meal: 'dinner', calories: 390, protein: 8, carbs: 55, fat: 15, notes: 'restaurant' });
  assert.ok(!hit.error, hit.text);
  assert.match(hit.text, /390 kcal/);
});

test('"What have I eaten today?" / "How much protein do I have left?"', async () => {
  const r = await call('nutrition_today');
  assert.match(r.text, new RegExp('^' + TODAY + ' — 996 kcal of 2,450 kcal \\(1,454 kcal left\\)'));
  assert.match(r.text, /110 g of 170 g protein \(60 g left\)/);
  assert.match(r.text, /Breakfast — 276 kcal/);
  assert.match(r.text, /\(restaurant\)/);
});

test('changing a logged quantity', async () => {
  const day = (await call('nutrition_today')).text;
  const id = day.match(/Amul High Protein Milk × 2 servings .*\[([a-z0-9]+)\]/)[1];
  const r = await call('nutrition_update_food_log', { id, quantity: 1 });
  assert.ok(!r.error, r.text);
  assert.match(r.text, /× 1 serving — 138 kcal/);
});

test('"Add my usual breakfast." repeats the last one', async () => {
  // Nothing earlier than today yet, so there is nothing to repeat.
  const none = await call('nutrition_copy_meal', { meal: 'breakfast' });
  assert.ok(none.error);
  assert.match(none.text, /no earlier breakfast/);
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return iso(d); })();
  const r = await call('nutrition_copy_meal', { meal: 'breakfast', date: tomorrow });
  assert.ok(!r.error, r.text);
  assert.match(r.text, new RegExp('Copied 1 item from ' + TODAY));
});

test('adding and correcting a saved food', async () => {
  const a = await call('nutrition_add_food', { name: 'Greek Yogurt', brand: 'Epigamia', servingSize: 90, servingUnit: 'g', calories: 90, protein: 7, carbs: 7, fat: 3.5 });
  assert.ok(!a.error, a.text);
  assert.match(a.text, /Saved Greek Yogurt — per 90 g: 90 kcal/);
  const u = await call('nutrition_update_food', { food: 'protein bar', carbs: 18, fat: 6 });
  assert.ok(!u.error, u.text);
  assert.match(u.text, /18 g carbs · 6 g fat/);
  assert.match(u.text, /Earlier entries keep/);
});

test('"Log my weight as 79.6 kg."', async () => {
  const r = await call('nutrition_log_weight', { kg: 79.6 });
  assert.ok(!r.error, r.text);
  assert.match(r.text, new RegExp('Logged 79.6 kg for ' + TODAY));
  const again = await call('nutrition_log_weight', { kg: 79.4 });
  assert.match(again.text, /^Corrected 79.4 kg/);
  const h = await call('nutrition_get_weight_history', { days: 14 });
  assert.match(h.text, /79.4 kg/);
});

test('"Give me my nutrition summary for the last 7 days."', async () => {
  const r = await call('nutrition_summary', {});
  assert.ok(!r.error, r.text);
  assert.match(r.text, /food logged on 1 of 7 days/);
  assert.match(r.text, /Protein target hit: 0 \/ 1 days/);
  assert.match(r.text, /Weight: 79.4 kg/);
});

test('targets change from today, and bad values come back as errors', async () => {
  const r = await call('nutrition_update_settings', { protein: 175 });
  assert.ok(!r.error, r.text);
  assert.match(r.text, new RegExp('Targets from ' + TODAY + ': 2,450 kcal · 175 g protein'));
  const bad = await call('nutrition_update_settings', { goal: 'bulk' });
  assert.ok(bad.error);
  const none = await call('nutrition_update_settings', {});
  assert.ok(none.error);
  assert.match(none.text, /nothing to change/);
});
