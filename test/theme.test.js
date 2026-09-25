// The light / dark theme is a set of tokens, and a token one mode forgets
// to define does not fail loudly — the colour just silently vanishes. These
// read the stylesheets and hold the rules the redesign rests on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const styleOf = (html) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const block = (css, theme) => {
  const i = css.indexOf('html[data-theme="' + theme + '"] {');
  assert.ok(i >= 0, 'no ' + theme + ' block');
  return css.slice(i, css.indexOf('\n  }', i));
};
const defined = (b) => new Set([...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

const INDEX = read('index.html');
const CSS = styleOf(INDEX);

test('every theme colour token used is defined in both modes', () => {
  const used = new Set([...INDEX.matchAll(/var\((--c-[0-9a-f]{6}|--on-lrn|--scrim|--code-bg|--ev-base|--ink)\b/g)].map((m) => m[1]));
  assert.ok(used.size > 20, 'the tokens are actually in use');
  for (const theme of ['light', 'dark']) {
    const have = defined(block(CSS, theme));
    const missing = [...used].filter((t) => !have.has(t));
    assert.deepStrictEqual(missing, [], theme + ' is missing ' + missing.join(', '));
  }
});

test('both modes define the core surface tokens', () => {
  for (const theme of ['light', 'dark']) {
    const have = defined(block(CSS, theme));
    for (const t of ['--bg', '--panel', '--panel-2', '--panel-3', '--line', '--text', '--muted', '--accent', '--danger', '--done']) {
      assert.ok(have.has(t), theme + ' has no ' + t);
    }
  }
});

test('no white overlay is left hard-coded — it would vanish on white', () => {
  for (const f of ['index.html', 'mini.html', 'capture.html']) {
    assert.doesNotMatch(styleOf(read(f)), /rgba\(\s*255\s*,\s*255\s*,\s*255/, f);
  }
});

test('no glass: the theme turns every backdrop blur off', () => {
  assert.match(CSS, /html\[data-theme\] \*[^{]*\{\s*-webkit-backdrop-filter: none !important; backdrop-filter: none !important;/);
});

test('the mode is set before first paint, and shared with the pad', () => {
  const head = INDEX.slice(0, INDEX.indexOf('<style>'));
  assert.match(head, /localStorage\.getItem\('tn\.theme'\)/, 'the head script reads the setting');
  assert.match(head, /dataset\.theme = t/);
  assert.match(read('pad.html'), /store\.get\('tn\.theme'\)/, 'the pad reads the same setting');
});

test('the small windows have both modes too', () => {
  for (const f of ['mini.html', 'capture.html']) {
    const css = styleOf(read(f));
    for (const theme of ['light', 'dark']) assert.ok(css.includes('html[data-theme="' + theme + '"]'), f + ' has no ' + theme);
    const used = new Set([...read(f).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    for (const theme of ['light', 'dark']) {
      const have = defined(block(css, theme));
      const missing = [...used].filter((t) => ['--ink'].includes(t) || t.startsWith('--c-')).filter((t) => !have.has(t));
      assert.deepStrictEqual(missing, [], f + ' ' + theme + ' is missing ' + missing.join(', '));
    }
  }
});
