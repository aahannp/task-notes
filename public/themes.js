// Themes — one table for the whole app.
//
// The app, the Doc editor (the pad) and the two small windows all read this
// file, so a theme is picked once and everything follows: the interface
// colours, and in the editor the syntax colours too. Loaded as a plain
// <script> in each page's <head>, before first paint, and required by the
// tests, which check every theme's contrast.
//
// A theme is a palette for the interface (ui), the editor's own surface
// (editor) and, for the named themes, their syntax colours. `mode` says
// which way it leans; the stylesheets keep the colours that only depend on
// that — the light or dark twin of each status colour — and a theme
// overrides the rest.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TNThemes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const THEMES = [
    // ---------------------------------------------------------------- light
    {
      id: 'light', name: 'Light', group: 'Light', mode: 'light', base: 'vs',
      // Soft on purpose: a warm off-white rather than #fff, and text a step
      // short of black. Full white under near-black is what glares.
      ui: { bg: '#f4f4f1', panel: '#fafaf8', panel2: '#ecece8', panel3: '#fcfcfa', line: '#e0e0db', line2: '#cfcfc9',
        text: '#34373d', muted: '#686c74', accent: '#3a72bd', onAccent: '#ffffff', danger: '#c0433f', done: '#9a9ea6' },
      side: '#efefeb',
      editor: { bg: '#fafaf8', fg: '#34373d', lineNo: '#909397', lineNoActive: '#4b4e55', lineHl: '#efefeb', selection: '#cfe0f5', cursor: '#34373d' },
      // Muted syntax too: Monaco's own light colours are pure #0000ff blue and
      // brick red, the loudest part of VS Code's light theme.
      syntax: { comment: '#7d8a73', keyword: '#3a62a8', string: '#9a5a2c', number: '#2e7d6b', type: '#7a4fa0', tag: '#3a62a8', attr: '#9a5a2c', variable: '#34373d', heading: '#3a62a8' },
    },
    {
      id: 'solarized-light', name: 'Solarized Light', group: 'Light', mode: 'light', base: 'vs',
      ui: { bg: '#fdf6e3', panel: '#f7f0dc', panel2: '#eee8d5', panel3: '#fdf6e3', line: '#e5dec9', line2: '#d3cbb3',
        text: '#4f636a', muted: '#5c6e73', accent: '#1e78b9', onAccent: '#ffffff', danger: '#c9302c', done: '#93a1a1' },
      side: '#eee8d5',
      editor: { bg: '#fdf6e3', fg: '#586e75', lineNo: '#869393', lineNoActive: '#586e75', lineHl: '#eee8d5', selection: '#e3dcc6', cursor: '#657b83' },
      syntax: { comment: '#828f8f', keyword: '#819400', string: '#299c93', number: '#d33682', type: '#b08500', tag: '#268bd2', attr: '#b08500', variable: '#268bd2', heading: '#cb4b16' },
    },
    {
      id: 'github-light', name: 'GitHub Light', group: 'Light', mode: 'light', base: 'vs',
      ui: { bg: '#f6f8fa', panel: '#ffffff', panel2: '#eff2f5', panel3: '#ffffff', line: '#d8dee4', line2: '#c0c8d0',
        text: '#1f2328', muted: '#59636e', accent: '#0969da', onAccent: '#ffffff', danger: '#cf222e', done: '#8c959f' },
      side: '#f6f8fa',
      editor: { bg: '#ffffff', fg: '#1f2328', lineNo: '#8c959f', lineNoActive: '#1f2328', lineHl: '#f6f8fa', selection: '#cfe3fc', cursor: '#0969da' },
      syntax: { comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', type: '#953800', tag: '#116329', attr: '#0550ae', variable: '#953800', heading: '#0550ae' },
    },
    // ----------------------------------------------------------------- dark
    {
      id: 'dark', name: 'Dark', group: 'Dark', mode: 'dark', base: 'vs-dark',
      ui: { bg: '#1e1e1e', panel: '#252526', panel2: '#2d2d30', panel3: '#252526', line: '#333333', line2: '#454545',
        text: '#d4d4d4', muted: '#9da3ad', accent: '#2d77bc', onAccent: '#ffffff', danger: '#f48771', done: '#6f7680' },
      side: '#252526',
      editor: { bg: '#1e1e1e', fg: '#d4d4d4', lineNo: '#858585', lineNoActive: '#c6c6c6', lineHl: '#282828', selection: '#264f78', cursor: '#aeafad' },
    },
    {
      id: 'one-dark', name: 'One Dark', group: 'Dark', mode: 'dark', base: 'vs-dark',
      ui: { bg: '#282c34', panel: '#21252b', panel2: '#2c313a', panel3: '#21252b', line: '#3a3f4b', line2: '#4b5263',
        text: '#c5cad3', muted: '#8f96a3', accent: '#4b74c6', onAccent: '#ffffff', danger: '#e06c75', done: '#5c6370' },
      side: '#21252b',
      editor: { bg: '#282c34', fg: '#abb2bf', lineNo: '#6b7489', lineNoActive: '#abb2bf', lineHl: '#2c313c', selection: '#3e4451', cursor: '#528bff' },
      syntax: { comment: '#7f848e', keyword: '#c678dd', string: '#98c379', number: '#d19a66', type: '#e5c07b', tag: '#e06c75', attr: '#d19a66', variable: '#e06c75', heading: '#e06c75' },
    },
    {
      id: 'dracula', name: 'Dracula', group: 'Dark', mode: 'dark', base: 'vs-dark',
      ui: { bg: '#282a36', panel: '#21222c', panel2: '#343746', panel3: '#21222c', line: '#3b3e50', line2: '#565a73',
        text: '#f8f8f2', muted: '#a9b0d4', accent: '#bd93f9', onAccent: '#1e1f29', danger: '#ff6e6e', done: '#6272a4', lrn: '#ff79c6' },
      side: '#21222c',
      editor: { bg: '#282a36', fg: '#f8f8f2', lineNo: '#6272a4', lineNoActive: '#f8f8f2', lineHl: '#303341', selection: '#44475a', cursor: '#f8f8f0' },
      syntax: { comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', type: '#8be9fd', tag: '#ff79c6', attr: '#50fa7b', variable: '#f8f8f2', heading: '#bd93f9' },
    },
    {
      id: 'monokai', name: 'Monokai', group: 'Dark', mode: 'dark', base: 'vs-dark',
      ui: { bg: '#272822', panel: '#1e1f1c', panel2: '#34352d', panel3: '#1e1f1c', line: '#3e3d32', line2: '#575646',
        text: '#f8f8f2', muted: '#b0aa8f', accent: '#66d9ef', onAccent: '#1e1f1c', danger: '#f92672', done: '#75715e' },
      side: '#1e1f1c',
      editor: { bg: '#272822', fg: '#f8f8f2', lineNo: '#90908a', lineNoActive: '#f8f8f2', lineHl: '#3e3d32', selection: '#49483e', cursor: '#f8f8f0' },
      syntax: { comment: '#88846f', keyword: '#f92672', string: '#e6db74', number: '#ae81ff', type: '#66d9ef', tag: '#f92672', attr: '#a6e22e', variable: '#fd971f', heading: '#a6e22e' },
    },
    {
      id: 'nord', name: 'Nord', group: 'Dark', mode: 'dark', base: 'vs-dark',
      ui: { bg: '#2e3440', panel: '#3b4252', panel2: '#434c5e', panel3: '#3b4252', line: '#434c5e', line2: '#4c566a',
        text: '#e5e9f0', muted: '#aab4c6', accent: '#88c0d0', onAccent: '#2e3440', danger: '#d57780', done: '#6d7a94' },
      side: '#3b4252',
      editor: { bg: '#2e3440', fg: '#d8dee9', lineNo: '#707c94', lineNoActive: '#d8dee9', lineHl: '#3b4252', selection: '#434c5e', cursor: '#d8dee9' },
      syntax: { comment: '#7b88a1', keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead', type: '#8fbcbb', tag: '#81a1c1', attr: '#8fbcbb', variable: '#d8dee9', heading: '#88c0d0' },
    },
    {
      id: 'solarized-dark', name: 'Solarized Dark', group: 'Dark', mode: 'dark', base: 'vs-dark',
      ui: { bg: '#002b36', panel: '#073642', panel2: '#0b4050', panel3: '#073642', line: '#0f4655', line2: '#1d5b6b',
        text: '#a7b4b4', muted: '#909fa1', accent: '#3794d6', onAccent: '#002b36', danger: '#e2504c', done: '#586e75' },
      side: '#073642',
      editor: { bg: '#002b36', fg: '#93a1a1', lineNo: '#60757c', lineNoActive: '#93a1a1', lineHl: '#073642', selection: '#094352', cursor: '#839496' },
      syntax: { comment: '#6c8288', keyword: '#859900', string: '#2aa198', number: '#d33682', type: '#b58900', tag: '#268bd2', attr: '#b58900', variable: '#268bd2', heading: '#cb4b16' },
    },
    // ------------------------------------------------------- high contrast
    // For accessibility: maximum contrast, strong edges — VS Code's own two.
    {
      id: 'hc-light', name: 'High Contrast Light', group: 'High contrast', mode: 'light', base: 'hc-light',
      ui: { bg: '#ffffff', panel: '#ffffff', panel2: '#f0f0f0', panel3: '#ffffff', line: '#0f4a85', line2: '#292929',
        text: '#000000', muted: '#292929', accent: '#0f4a85', onAccent: '#ffffff', danger: '#b5200d', done: '#595959' },
      side: '#ffffff',
      editor: { bg: '#ffffff', fg: '#000000', lineNo: '#292929', lineNoActive: '#000000', lineHl: '#ffffff', selection: '#0f4a8540', cursor: '#0f4a85' },
    },
    {
      id: 'hc-dark', name: 'High Contrast Dark', group: 'High contrast', mode: 'dark', base: 'hc-black',
      ui: { bg: '#000000', panel: '#000000', panel2: '#141414', panel3: '#000000', line: '#6fc3df', line2: '#f38518',
        text: '#ffffff', muted: '#e0e0e0', accent: '#1aebff', onAccent: '#000000', danger: '#f48771', done: '#bfbfbf' },
      side: '#000000',
      editor: { bg: '#000000', fg: '#ffffff', lineNo: '#ffffff', lineNoActive: '#f38518', lineHl: '#000000', selection: '#f3851866', cursor: '#ffffff' },
    },
  ];
  const byId = Object.fromEntries(THEMES.map((t) => [t.id, t]));
  const KEY = 'tn.theme';

  function hexRgb(h) {
    const x = h.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
  }
  // Which theme to show: the one chosen, else the one matching macOS.
  function resolve(storage, prefersDark) {
    let id = null;
    try { id = storage && storage.getItem(KEY); } catch {}
    if (id && byId[id]) return byId[id];
    return byId[prefersDark ? 'dark' : 'light'];
  }
  // The interface tokens every stylesheet in the app is written against.
  function cssVars(t) {
    const u = t.ui;
    const v = {
      '--bg': u.bg, '--panel': u.panel, '--panel-2': u.panel2, '--panel-3': u.panel3,
      '--line': u.line, '--line-2': u.line2, '--text': u.text, '--muted': u.muted,
      '--accent': u.accent, '--on-accent': u.onAccent, '--danger': u.danger, '--done': u.done,
      // An overlay tints with the text colour, so it reads on any ground.
      '--ink': hexRgb(u.text).join(' '),
      // The pad's own names for the same things (see pad.html).
      '--main': t.editor.bg, '--side': t.side, '--side-text': u.text, '--side-muted': u.muted,
      '--field': u.panel3, '--field-line': u.line, '--crumb': u.muted, '--link': u.accent,
      '--btn': u.panel2, '--btn-hover': u.line, '--bar': u.panel2, '--bar-text': u.muted,
      '--active': 'color-mix(in srgb, ' + u.accent + ' 16%, ' + t.side + ')',
    };
    if (u.lrn) v['--lrn'] = u.lrn;
    return v;
  }
  // Put a theme on a document: the id and the way it leans for the
  // stylesheets, and its tokens as inline custom properties, which outrank
  // the stylesheet's defaults.
  function apply(doc, t) {
    const el = doc.documentElement;
    el.dataset.theme = t.id;
    el.dataset.mode = t.mode;
    const vars = cssVars(t);
    Object.keys(vars).forEach((k) => el.style.setProperty(k, vars[k]));
    el.style.colorScheme = t.mode;
  }
  // The same theme for Monaco, which cannot read CSS variables.
  function monacoTheme(t) {
    const e = t.editor, s = t.syntax;
    const strip = (c) => c.replace('#', '');
    const rules = !s ? [] : [
      ['comment', s.comment, 'italic'], ['keyword', s.keyword], ['string', s.string], ['number', s.number],
      ['type', s.type], ['tag', s.tag], ['attribute.name', s.attr], ['attribute.value', s.string],
      ['variable', s.variable], ['constant', s.number], ['regexp', s.string],
      ['keyword.md', s.heading, 'bold'], ['strong', null, 'bold'], ['emphasis', null, 'italic'],
    ].map(([token, fg, fontStyle]) => Object.assign({ token }, fg ? { foreground: strip(fg) } : {}, fontStyle ? { fontStyle } : {}));
    // Brackets and punctuation in the text colour. The base themes paint
    // them in their own fixed bracket colours (#0431fa on light), which no
    // amount of calm elsewhere survives.
    rules.push({ token: 'delimiter', foreground: strip(e.fg) }, { token: 'delimiter.bracket', foreground: strip(e.fg) },
      { token: 'delimiter.curly', foreground: strip(e.fg) }, { token: 'delimiter.parenthesis', foreground: strip(e.fg) },
      { token: 'delimiter.square', foreground: strip(e.fg) });
    const brackets = {};
    for (let i = 1; i <= 6; i++) brackets['editorBracketHighlight.foreground' + i] = e.fg;
    return {
      base: t.base, inherit: true, rules,
      colors: Object.assign(brackets, {
        'editor.background': e.bg, 'editor.foreground': e.fg,
        'editorLineNumber.foreground': e.lineNo, 'editorLineNumber.activeForeground': e.lineNoActive,
        'editor.lineHighlightBackground': e.lineHl, 'editor.lineHighlightBorder': e.lineHl,
        'editor.selectionBackground': e.selection, 'editorCursor.foreground': e.cursor,
        'editorGutter.background': e.bg, 'editorWidget.background': t.side,
      }),
    };
  }
  return { THEMES, byId, KEY, resolve, cssVars, apply, monacoTheme, hexRgb };
});
