// The Doc tab is the pad: the app's Docs page is public/pad.html in a frame,
// and it is called Doc everywhere you see it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const INDEX = read('index.html');

test('the Doc tab is the pad', () => {
  assert.match(INDEX, /<iframe class="pad-frame" id="padFrame"/);
  assert.match(INDEX, /f\.src = '\/pad\?embed=1'/, 'embedded, so it drops its own title bar');
  assert.match(INDEX, /<use href="#i-docs"\/><\/svg>Doc<\/button>/, 'the nav says Doc');
  assert.match(read('pad.html'), /<span>doc<\/span><span class="sep"/, 'the breadcrumb says doc');
});

test('every link to a doc lands in the pad', () => {
  // openDocument is what projects, search, the inbox and the palette call.
  const fn = INDEX.slice(INDEX.indexOf('async function openDocument(id) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /padShow\(id\)|openPage\('docs'\)/);
});

// ------------------------------------------------------- the Doc's tools
const PAD = read('pad.html');

test('right-clicking a doc opens our menu, not the browser\'s link menu', () => {
  assert.match(PAD, /\$\('docs'\)\.addEventListener\('contextmenu'[\s\S]*?e\.preventDefault\(\)/);
  for (const label of ['Open', 'Rename…', 'Pin to top', 'Duplicate', 'Copy link', 'Archive']) assert.ok(PAD.includes("'" + label + "'"), label);
  // and it works without a mouse: the menu key or Shift+F10, arrows, Escape
  assert.match(PAD, /e\.key === 'ContextMenu' \|\| \(e\.shiftKey && e\.key === 'F10'\)/);
  assert.match(PAD, /role="menu"/);
  assert.match(PAD, /role="menuitem"/);
});

test('archiving from the menu is undoable, never a delete', () => {
  assert.match(PAD, /'\/archive'/);
  assert.match(PAD, /'\/restore'/);
  assert.doesNotMatch(PAD, /method: 'DELETE'|api\('DELETE'/);
});

test('the sidebar hides, the text resizes, and both are remembered', () => {
  assert.match(PAD, /store\.set\('pad\.side'/);
  assert.match(PAD, /store\.set\('pad\.font'/);
  assert.match(PAD, /aria-keyshortcuts="Meta\+Backslash"/);
});

test('full screen is allowed from inside the app, and falls back if not', () => {
  assert.match(INDEX, /id="padFrame"[^>]*allow="fullscreen"/);
  assert.match(PAD, /requestFullscreen/);
  assert.match(PAD, /catch \{ paintFs\(want\); \}/, 'no Fullscreen API: the same layout inside the window');
});

test('the editor\'s own right-click menu has the doc\'s actions', () => {
  for (const id of ['doc.sidebar', 'doc.fullscreen', 'doc.bigger', 'doc.smaller', 'doc.resetSize']) assert.ok(PAD.includes("'" + id + "'"), id);
  assert.match(PAD, /contextMenuGroupId: '9_doc'/);
});

test('the editor is calm: no rainbow brackets, no completion popups', () => {
  assert.match(PAD, /bracketPairColorization: \{ enabled: false \}/);
  assert.match(PAD, /quickSuggestions: false/);
});
