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
