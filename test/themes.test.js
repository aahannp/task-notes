// Every theme in public/themes.js, checked for what makes it usable: that
// text is readable on the surfaces it sits on, and that each theme is
// complete. A new theme that fails here fails before anyone squints at it.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../public/themes.js');

const lum = (h) => T.hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
  .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const HEX = /^#[0-9a-f]{6}$/i;

test('the set VS Code users would look for is there, plus high contrast', () => {
  const ids = T.THEMES.map((t) => t.id);
  for (const id of ['light', 'dark', 'solarized-light', 'solarized-dark', 'github-light', 'one-dark', 'dracula', 'monokai', 'nord', 'hc-light', 'hc-dark']) {
    assert.ok(ids.includes(id), id);
  }
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
});

for (const t of T.THEMES) {
  test(t.name + ': complete, and readable (WCAG AA)', () => {
    const u = t.ui, e = t.editor;
    for (const k of ['bg', 'panel', 'panel2', 'panel3', 'line', 'line2', 'text', 'muted', 'accent', 'onAccent', 'danger', 'done']) {
      assert.match(u[k], HEX, k);
    }
    assert.ok(['light', 'dark'].includes(t.mode));
    assert.ok(['vs', 'vs-dark', 'hc-light', 'hc-black'].includes(t.base));
    const at = (name, a, b, need) => assert.ok(cr(a, b) >= need, `${name} ${cr(a, b).toFixed(2)} < ${need}`);
    at('text on bg', u.text, u.bg, 4.5);
    at('text on panel', u.text, u.panel, 4.5);
    at('muted on bg', u.muted, u.bg, 4.5);
    at('muted on panel', u.muted, u.panel, 4.5);
    at('accent as text', u.accent, u.bg, 3);
    // Links sit on the Doc sidebar and on cards too, not only on the page.
    at('accent on the sidebar', u.accent, t.side, 3);
    at('accent on a panel', u.accent, u.panel, 3);
    at('text on accent buttons', u.onAccent, u.accent, 4.5);
    at('editor text', e.fg, e.bg, 4.5);
    at('line numbers', e.lineNo, e.bg, 2.8);
    // Syntax colours are text too; comments are allowed to be the quietest.
    for (const [k, c] of Object.entries(t.syntax || {})) at('syntax ' + k, c, e.bg, 3);
  });
}

test("the default light theme is soft: no pure white, no pure black", () => {
  const u = T.byId.light.ui;
  assert.notStrictEqual(u.bg.toLowerCase(), '#ffffff');
  assert.notStrictEqual(T.byId.light.editor.bg.toLowerCase(), '#ffffff');
  assert.ok(lum(u.text) > lum('#1a1a1a'), 'text is a step short of black');
  assert.ok(cr(u.text, u.bg) < 13, 'and not glaring against the ground');
});

test('with nothing chosen, the theme follows macOS; a choice sticks', () => {
  const store = (v) => ({ getItem: () => v });
  assert.strictEqual(T.resolve(store(null), false).id, 'light');
  assert.strictEqual(T.resolve(store(null), true).id, 'dark');
  assert.strictEqual(T.resolve(store('nord'), false).id, 'nord');
  assert.strictEqual(T.resolve(store('no-such-theme'), true).id, 'dark', 'an unknown id falls back');
  assert.strictEqual(T.resolve(store('light'), true).id, 'light', 'the old light/dark values still work');
});

test('a theme becomes CSS variables and a Monaco theme', () => {
  const v = T.cssVars(T.byId.dracula);
  assert.strictEqual(v['--bg'], '#282a36');
  assert.strictEqual(v['--on-accent'], '#1e1f29');
  assert.strictEqual(v['--ink'], '248 248 242');
  const m = T.monacoTheme(T.byId.dracula);
  assert.strictEqual(m.base, 'vs-dark');
  assert.strictEqual(m.colors['editor.background'], '#282a36');
  assert.ok(m.rules.some((r) => r.token === 'keyword' && r.foreground === 'ff79c6'));
  // The plain themes keep Monaco's own syntax colours; they only calm the brackets.
  assert.ok(T.monacoTheme(T.byId.dark).rules.every((r) => r.token.startsWith('delimiter')));
  assert.ok(T.monacoTheme(T.byId.light).rules.some((r) => r.token === 'delimiter.curly' && r.foreground === '34373d'),
    'brackets take the text colour, not the base theme\'s vivid blue');
});
