#!/usr/bin/env node
//
// Task Notes MCP server.
//
// Speaks MCP over stdio — newline-delimited JSON-RPC 2.0 — and translates it
// into calls against the app's own local HTTP API. Zero dependencies, like
// the rest of the server.
//
// Everything goes through the running app rather than the data directory.
// Every rule that makes the data coherent — carry-forward lineage, day-local
// dependencies, the activity log, document bodies as real .md files, atomic
// writes — lives in server.js. A second process editing the files directly
// would honour none of it, and would race with the app whenever it is open.
// One writer, one set of rules.
//
// Nothing here deletes. Claude can create and change; removing things stays
// something you do yourself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA_DIR = process.env.TASKNOTES_DATA || path.join(os.homedir(), 'task-notes', 'data');
const NOT_RUNNING = 'Task Notes is not running. Open the app, then try again.';

// ---------------------------------------------------------------- transport

// The app writes its port here when it binds; it removes the file on quit, so
// a missing file means "not running". The pid is checked because a hard crash
// leaves the file behind.
function appPort() {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'port.json'), 'utf8')); } catch { return null; }
  if (!j || !j.port) return null;
  if (j.pid) {
    try { process.kill(j.pid, 0); } catch { return null; }   // stale file
  }
  return j.port;
}

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const port = appPort();
    if (!port) return reject(new Error(NOT_RUNNING));
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : {}; } catch { return reject(new Error('Unreadable response from Task Notes')); }
        if (res.statusCode >= 400) return reject(new Error(j.error || ('HTTP ' + res.statusCode)));
        resolve(j);
      });
    });
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? NOT_RUNNING : e.message)));
    if (data) req.write(data);
    req.end();
  });
}

// ------------------------------------------------------------------ helpers

const iso = (d) => d.getFullYear() + '-'
  + String(d.getMonth() + 1).padStart(2, '0') + '-'
  + String(d.getDate()).padStart(2, '0');
const today = () => iso(new Date());

function theDate(a) {
  const d = (a && a.date) || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('date must be YYYY-MM-DD, got ' + JSON.stringify(d));
  return d;
}
function need(a, k) {
  const v = a && a[k];
  if (v == null || String(v).trim() === '') throw new Error(k + ' is required');
  return typeof v === 'string' ? v.trim() : v;
}
const STATUSES = ['todo', 'progress', 'blocked', 'done'];
function theStatus(v) {
  if (v == null) return undefined;
  if (!STATUSES.includes(v)) throw new Error('status must be one of ' + STATUSES.join(', '));
  return v;
}
const mins = (s) => (s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm'
  : Math.round(s / 60) + 'm');
const line = (t) => '- [' + t.status + '] ' + t.text
  + (t.note ? '  — ' + t.note : '')
  + (t.estimateMin ? '  (' + t.estimateMin + 'm)' : '');

// -------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'list_tasks',
    description: "The task board for a day: every task with its column (todo, progress, blocked, done), note and estimate. Defaults to today.",
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } } },
    async run(a) {
      const date = theDate(a);
      const { tasks } = await api('GET', '/api/tasks?date=' + date);
      if (!tasks.length) return 'No tasks on ' + date + '.';
      return date + '\n' + tasks.map((t) => line(t) + '  #' + t.id).join('\n');
    },
  },
  {
    name: 'add_task',
    description: 'Put a new task on a day\'s board. Defaults to today and to the "todo" column.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'What the task is.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        note: { type: 'string' },
        estimateMin: { type: 'number', description: 'Estimate in minutes.' },
        status: { type: 'string', enum: STATUSES, description: 'Defaults to todo.' },
        projectId: { type: 'string', description: 'Attach to a project — see list_projects.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const r = await api('POST', '/api/tasks?date=' + date, {
        text: need(a, 'text'),
        status: theStatus(a.status) || 'todo',
        note: a.note || '',
        estimateMin: a.estimateMin || null,
        projectId: a.projectId || null,
      });
      return 'Added to ' + date + ': ' + r.task.text + '  #' + r.task.id;
    },
  },
  {
    name: 'update_task',
    description: 'Change an existing task — move it between columns, reword it, add a note or an estimate. Get ids from list_tasks.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        date: { type: 'string', description: 'The day the task is on. Defaults to today.' },
        status: { type: 'string', enum: STATUSES },
        text: { type: 'string' },
        note: { type: 'string' },
        estimateMin: { type: 'number' },
        projectId: { type: 'string' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const patch = {};
      if (a.status != null) patch.status = theStatus(a.status);
      ['text', 'note', 'estimateMin', 'projectId'].forEach((k) => { if (a[k] != null) patch[k] = a[k]; });
      if (!Object.keys(patch).length) throw new Error('nothing to change');
      const r = await api('PATCH', '/api/tasks?date=' + date + '&id=' + encodeURIComponent(need(a, 'id')), patch);
      return 'Updated on ' + date + ': ' + line(r.task);
    },
  },
  {
    name: 'list_projects',
    description: 'Every project, with its status and id. Use this to find a projectId before attaching a task to one.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const { value } = await api('GET', '/api/store?name=projects');
      if (!value.length) return 'No projects yet.';
      return value.map((p) => '- ' + (p.title || '(untitled)') + '  [' + (p.status || 'planned') + ']  #' + p.id).join('\n');
    },
  },
  {
    name: 'add_project',
    description: 'Start a new project — a container for related tasks, documents and focus time, which the app tracks progress against.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, desc: { type: 'string', description: 'What you are trying to accomplish.' } },
    },
    async run(a) {
      // The store calls it `title`; the tool calls it `name` because that is
      // what a person says. Sending `name` created untitled projects.
      const r = await api('POST', '/api/store?name=projects', {
        title: need(a, 'name'), desc: a.desc || '', status: 'active',
        start: '', due: '', notes: '', learningIds: [], fromIdeaId: null, focusSeconds: 0,
      });
      return 'Project created: ' + r.item.title + '  #' + r.item.id;
    },
  },
  {
    name: 'capture',
    description: 'Drop a thought into the Inbox to be sorted out later. Use this when something is worth keeping but is not yet a task.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    async run(a) {
      const r = await api('POST', '/api/store?name=captures', {
        text: need(a, 'text'), note: '', context: 'claude', status: 'open',
        becameKind: null, becameId: null, processedAt: null,
      });
      return 'In your inbox: ' + r.item.text;
    },
  },
  {
    name: 'list_backlog',
    description: 'Work parked for later, with the date each item is meant to come back.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const { value } = await api('GET', '/api/store?name=backlog');
      const open = value.filter((b) => !b.promotedTo);
      if (!open.length) return 'Backlog is empty.';
      return open.map((b) => '- ' + b.text + '  [' + (b.pickupDate || 'no date') + ']  #' + b.id).join('\n');
    },
  },
  {
    name: 'add_backlog',
    description: 'Park something for later rather than putting it on today\'s board. A pick-up date is how it comes back; without one it only surfaces when you go looking.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        pickupDate: { type: 'string', description: 'YYYY-MM-DD — the day it should come back.' },
      },
    },
    async run(a) {
      if (a.pickupDate && !/^\d{4}-\d{2}-\d{2}$/.test(a.pickupDate)) throw new Error('pickupDate must be YYYY-MM-DD');
      const r = await api('POST', '/api/store?name=backlog', {
        text: need(a, 'text'), note: '', pickupDate: a.pickupDate || null,
        projectId: null, estimateMin: null, promotedTo: null, promotedOn: null, notifiedOn: null,
      });
      return 'In the backlog: ' + r.item.text + (r.item.pickupDate ? ' — back on ' + r.item.pickupDate : ' — no date set');
    },
  },
  {
    name: 'add_reminder',
    description: 'Set a reminder for a day. On that day the app blocks the screen until it is acknowledged or marked done.',
    inputSchema: {
      type: 'object',
      required: ['text', 'date'],
      properties: { text: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } },
    },
    async run(a) {
      const date = theDate(a);
      const r = await api('POST', '/api/store?name=reminders', {
        text: need(a, 'text'), date, status: 'open', acks: 0,
        quietUntil: null, doneAt: null, notifiedOn: null, taskId: null,
      });
      return 'Reminder set for ' + date + ': ' + r.item.text;
    },
  },
  {
    name: 'list_documents',
    description: 'Documents in the workspace. Pass q to search titles, tags and bodies.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Free-text search.' } } },
    async run(a) {
      const q = a && a.q ? '?q=' + encodeURIComponent(a.q) : '';
      const { documents } = await api('GET', '/api/documents' + q);
      if (!documents.length) return a && a.q ? 'Nothing matches “' + a.q + '”.' : 'No documents yet.';
      return documents.map((d) => '- ' + d.title + '  #' + d.id + (d.snippet ? '\n    …' + d.snippet : '')).join('\n');
    },
  },
  {
    name: 'read_document',
    description: 'The full markdown of one document. Get ids from list_documents.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    async run(a) {
      const { document } = await api('GET', '/api/documents/' + encodeURIComponent(need(a, 'id')));
      return '# ' + document.title + '\n\n' + (document.content || '(empty)');
    },
  },
  {
    name: 'write_document',
    description: 'Create a document, or change one that exists. With an id and mode "append" the content is added to the end; with mode "replace" it overwrites. Every write keeps a version, so nothing is lost.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string' },
        id: { type: 'string', description: 'Omit to create a new document.' },
        title: { type: 'string', description: 'Required when creating.' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Only when editing. Defaults to append.' },
      },
    },
    async run(a) {
      const content = a.content == null ? '' : String(a.content);
      if (!a.id) {
        const r = await api('POST', '/api/documents', { title: a.title || 'Untitled', content });
        return 'Created “' + r.document.title + '”  #' + r.document.id;
      }
      const id = need(a, 'id');
      const { document } = await api('GET', '/api/documents/' + encodeURIComponent(id));
      const next = (a.mode === 'replace')
        ? content
        : (document.content ? document.content.replace(/\s*$/, '') + '\n\n' + content : content);
      const body = { content: next, baseVersion: document.version };
      if (a.title) body.title = a.title;
      await api('PUT', '/api/documents/' + encodeURIComponent(id), body);
      return (a.mode === 'replace' ? 'Replaced' : 'Appended to') + ' “' + (a.title || document.title) + '”';
    },
  },
  {
    name: 'day_summary',
    description: 'What a day looked like: the board by column, hours focused, and the login/logout stamps. Defaults to today.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } } },
    async run(a) {
      const date = theDate(a);
      const [{ tasks }, { meta }] = await Promise.all([
        api('GET', '/api/tasks?date=' + date),
        api('GET', '/api/meta?date=' + date),
      ]);
      const m = meta || {};
      const by = (s) => tasks.filter((t) => t.status === s);
      const secs = (m.sessions || []).reduce((sum, x) => sum + (x.seconds || x.accumulatedSec || 0), 0);
      const out = [date];
      STATUSES.forEach((s) => {
        const g = by(s);
        if (g.length) out.push('', s.toUpperCase() + ' (' + g.length + ')', ...g.map((t) => line(t)));
      });
      if (!tasks.length) out.push('', 'Nothing on the board.');
      out.push('', 'Focused ' + mins(secs) + ' across ' + (m.sessions || []).length + ' session(s).');
      if (m.login) out.push('Clocked in ' + m.login + (m.logout ? ', out ' + m.logout : ''));
      return out.join('\n');
    },
  },
  {
    name: 'focus_summary',
    description: 'Every focus session on a day — when it ran, how long, what it was on, and the wrap-up written afterwards. Defaults to today.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } } },
    async run(a) {
      const date = theDate(a);
      const { meta } = await api('GET', '/api/meta?date=' + date);
      const ss = ((meta || {}).sessions || []).filter((x) => (x.seconds || x.accumulatedSec || 0) >= 60);
      if (!ss.length) return 'No focus sessions on ' + date + '.';
      const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
      const total = ss.reduce((sum, x) => sum + (x.seconds || x.accumulatedSec || 0), 0);
      return date + ' — ' + mins(total) + ' across ' + ss.length + ' session(s)\n'
        + ss.map((x) => '- ' + hhmm(x.start) + (x.end ? '–' + hhmm(x.end) : '–now')
            + '  ' + mins(x.seconds || x.accumulatedSec || 0)
            + '  ' + (x.taskText || 'Free focus')
            + (x.accomplished ? '\n    ✓ ' + x.accomplished : '')
            + (x.nextStep ? '\n    → ' + x.nextStep : '')).join('\n');
    },
  },
];

// --------------------------------------------------------------- JSON-RPC

const PROTOCOL = '2025-06-18';
const KNOWN = ['2024-11-05', '2025-03-26', '2025-06-18'];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    const want = params && params.protocolVersion;
    return reply(id, {
      protocolVersion: KNOWN.includes(want) ? want : PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'task-notes', version: '1.0.0' },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) return;

  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return fail(id, -32602, 'Unknown tool: ' + name);
    try {
      const text = await tool.run((params && params.arguments) || {});
      return reply(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      // A tool failing is a result the model should see and can act on, not a
      // protocol error — so it comes back as an errored result, not a fault.
      return reply(id, { content: [{ type: 'text', text: 'Error: ' + (e.message || String(e)) }], isError: true });
    }
  }

  if (isRequest) fail(id, -32601, 'Method not found: ' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const raw = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!raw) continue;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }   // never crash on garbage
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && msg.id != null) fail(msg.id, -32603, e.message || String(e));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
