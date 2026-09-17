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

// ------------------------------------------------------------------ the log
//
// One line per call, appended here rather than sent to the app, for two
// reasons: Claude Code can run several of these processes at once and a
// whole-file rewrite from two of them would shred the file, and a call that
// failed *because the app was closed* is exactly the thing a health panel
// needs to show — there is nothing running to send it to.
const LOG = path.join(DATA_DIR, 'mcp-log.jsonl');
const SESSION = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const LOG_KEEP = 2000;

function logEvent(rec) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
  } catch {}
}
// Once per process, and only when it has actually grown.
function trimLog() {
  try {
    if (fs.statSync(LOG).size < 300 * 1024) return;
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= LOG_KEEP) return;
    fs.writeFileSync(LOG, lines.slice(-LOG_KEEP).join('\n') + '\n');
  } catch {}
}
trimLog();

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
        // A running app older than these tools has no PATCH route for the
        // stores or the day. It answers 405 in plain text, so this has to come
        // before the parse — otherwise it reads as a garbled response.
        if (res.statusCode === 405 && method === 'PATCH') {
          return reject(new Error('Task Notes is running an older build that cannot do this. Update the app (the version pill in the header), then try again.'));
        }
        let j = null;
        try { j = d ? JSON.parse(d) : {}; } catch {
          return reject(new Error(res.statusCode >= 400
            ? 'Task Notes answered HTTP ' + res.statusCode
            : 'Unreadable response from Task Notes'));
        }
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
const PRIORITIES = ['high', 'normal', 'low'];
const IDEA_STATUS = ['captured', 'exploring', 'promising', 'converted', 'archived'];
const LEARN_STATUS = ['bag', 'learning', 'learned', 'paused', 'archived'];
const PROJECT_STATUS = ['planned', 'active', 'paused', 'done'];

function oneOf(field, allowed, v) {
  if (v == null) return undefined;
  if (!allowed.includes(v)) throw new Error(field + ' must be one of ' + allowed.join(', '));
  return v;
}
const thePriority = (v) => oneOf('priority', PRIORITIES, v);
const theStatus = (v) => oneOf('status', STATUSES, v);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
function theDay(v, field) {
  if (v == null || v === '') return null;
  if (!isDate(v)) throw new Error(field + ' must be YYYY-MM-DD, got ' + JSON.stringify(v));
  return v;
}

// The long-lived stores, through the app rather than the files.
const store = async (name) => (await api('GET', '/api/store?name=' + name)).value;
const addStore = (name, item) => api('POST', '/api/store?name=' + name, item);
const patchStore = (name, id, patch) =>
  api('PATCH', '/api/store?name=' + name + (id ? '&id=' + encodeURIComponent(id) : ''), patch);
async function findIn(name, id, label) {
  const found = (await store(name)).find((x) => x && x.id === id);
  if (!found) throw new Error('no ' + (label || name) + ' with id ' + id);
  return found;
}

// Only the keys the caller actually set. Everything left out keeps its value,
// which is what makes these tools safe to call with one field at a time.
function pick(a, keys) {
  const out = {};
  keys.forEach((k) => { if (a[k] !== undefined) out[k] = a[k]; });
  return out;
}
function some(patch) {
  if (!Object.keys(patch).length) throw new Error('nothing to change');
  return patch;
}

const mins = (s) => (s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm'
  : Math.round(s / 60) + 'm');
const ago = (ts) => {
  if (!ts) return '';
  const d = Math.round((Date.now() - ts) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + 'd ago';
};
const line = (t) => '- [' + t.status + (t.priority && t.priority !== 'normal' ? ' · ' + t.priority : '') + '] ' + t.text
  + (t.note ? '  — ' + t.note : '')
  + (t.estimateMin ? '  (' + t.estimateMin + 'm)' : '')
  + ((t.dependsOn || []).length ? '  ⛔ waits on ' + t.dependsOn.length : '')
  + ((t.people || []).length ? '  👥 ' + t.people.join(', ') : '')
  + (t.pickupDate ? '  ⏳ ' + t.pickupDate : '');

// The app's weeks start on Monday, so a review is keyed by that Monday.
function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return iso(x);
}

// -------------------------------------------------------------------- tools
//
// Everything the app itself can do, minus removing things. Each tool is
// named for what a person would say they are doing, and every write comes
// back describing what changed so the log reads as an audit trail.

const TOOLS = [
  // ------------------------------------------------------------------ tasks
  {
    name: 'list_tasks',
    description: "The task board for a day: every task with its column (todo, progress, blocked, done), priority, note, estimate, who is on it, what it waits on. Defaults to today.",
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } } },
    async run(a) {
      const date = theDate(a);
      const { tasks } = await api('GET', '/api/tasks?date=' + date);
      if (!tasks.length) return 'No tasks on ' + date + '.';
      const by = new Map(tasks.map((t) => [t.id, t]));
      return date + '\n' + tasks.map((t) => {
        const dep = (t.dependsOn || []).map((id) => (by.get(id) || {}).text || id).filter(Boolean);
        return line(t) + '  #' + t.id + (dep.length ? '\n    waits on: ' + dep.join('; ') : '');
      }).join('\n');
    },
  },
  {
    name: 'add_task',
    write: true,
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
        priority: { type: 'string', enum: PRIORITIES, description: 'Defaults to normal. Open columns sort high first.' },
        projectId: { type: 'string', description: 'Attach to a project — see list_projects.' },
        learningId: { type: 'string', description: 'Attach to something you are learning — see list_learning.' },
        people: { type: 'array', items: { type: 'string' }, description: 'Who else is on this.' },
        pickupDate: { type: 'string', description: 'YYYY-MM-DD — when you mean to actually start it.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids on the same day that must finish first.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const r = await api('POST', '/api/tasks?date=' + date, {
        text: need(a, 'text'),
        status: theStatus(a.status) || 'todo',
        priority: thePriority(a.priority) || 'normal',
        note: a.note || '',
        estimateMin: a.estimateMin || null,
        projectId: a.projectId || null,
        learningId: a.learningId || null,
        people: Array.isArray(a.people) ? a.people : [],
        pickupDate: theDay(a.pickupDate, 'pickupDate'),
        dependsOn: Array.isArray(a.dependsOn) ? a.dependsOn : [],
      });
      return 'Added to ' + date + ': ' + r.task.text + '  #' + r.task.id;
    },
  },
  {
    name: 'update_task',
    write: true,
    description: 'Change an existing task — move it between columns, reword it, reprioritise, set an estimate, attach it to a project, say who is on it. Get ids from list_tasks.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        date: { type: 'string', description: 'The day the task is on. Defaults to today.' },
        status: { type: 'string', enum: STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        text: { type: 'string' },
        note: { type: 'string' },
        estimateMin: { type: 'number' },
        projectId: { type: 'string' },
        learningId: { type: 'string' },
        people: { type: 'array', items: { type: 'string' } },
        pickupDate: { type: 'string', description: 'YYYY-MM-DD, or "" to clear it.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const patch = pick(a, ['text', 'note', 'estimateMin', 'projectId', 'learningId', 'people']);
      if (a.status != null) patch.status = theStatus(a.status);
      if (a.priority != null) patch.priority = thePriority(a.priority);
      if (a.pickupDate !== undefined) patch.pickupDate = theDay(a.pickupDate, 'pickupDate');
      const r = await api('PATCH', '/api/tasks?date=' + date + '&id=' + encodeURIComponent(need(a, 'id')), some(patch));
      return 'Updated on ' + date + ': ' + line(r.task);
    },
  },
  {
    name: 'link_tasks',
    write: true,
    description: 'Say that one task waits on another. The blocked task cannot be finished until what it waits on is done, and the board shows the chain. Both tasks must be on the same day. Use action "unlink" to take the dependency off again.',
    inputSchema: {
      type: 'object',
      required: ['id', 'dependsOnId'],
      properties: {
        id: { type: 'string', description: 'The task that is waiting.' },
        dependsOnId: { type: 'string', description: 'The task it waits on.' },
        date: { type: 'string', description: 'The day both are on. Defaults to today.' },
        action: { type: 'string', enum: ['link', 'unlink'], description: 'Defaults to link.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const id = need(a, 'id');
      const on = need(a, 'dependsOnId');
      if (id === on) throw new Error('a task cannot wait on itself');
      const { tasks } = await api('GET', '/api/tasks?date=' + date);
      const me = tasks.find((t) => t.id === id);
      const other = tasks.find((t) => t.id === on);
      if (!me) throw new Error('no task ' + id + ' on ' + date);
      if (!other) throw new Error('no task ' + on + ' on ' + date + ' — dependencies only work within a day');
      const cur = Array.isArray(me.dependsOn) ? me.dependsOn.slice() : [];
      if (a.action === 'unlink') {
        const next = cur.filter((x) => x !== on);
        if (next.length === cur.length) return '“' + me.text + '” was not waiting on “' + other.text + '” anyway.';
        await api('PATCH', '/api/tasks?date=' + date + '&id=' + encodeURIComponent(id), { dependsOn: next });
        return '“' + me.text + '” no longer waits on “' + other.text + '”.';
      }
      // A depends on B depends on A would deadlock the board.
      const wouldCycle = (from, target, seen) => {
        if (from === target) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        const t = tasks.find((x) => x.id === from);
        return (t && (t.dependsOn || []).some((d) => wouldCycle(d, target, seen))) || false;
      };
      if (wouldCycle(on, id, new Set())) throw new Error('that would make a loop — “' + other.text + '” already waits on “' + me.text + '”');
      if (cur.includes(on)) return '“' + me.text + '” already waits on “' + other.text + '”.';
      cur.push(on);
      await api('PATCH', '/api/tasks?date=' + date + '&id=' + encodeURIComponent(id), { dependsOn: cur });
      return '“' + me.text + '” now waits on “' + other.text + '”.';
    },
  },

  // --------------------------------------------------------------- projects
  {
    name: 'list_projects',
    description: 'Every project, with its status and id. Use this to find a projectId before attaching a task to one.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const value = await store('projects');
      if (!value.length) return 'No projects yet.';
      return value.map((p) => '- ' + (p.title || '(untitled)') + '  [' + (p.status || 'planned') + ']'
        + (p.due ? '  due ' + p.due : '') + '  #' + p.id).join('\n');
    },
  },
  {
    name: 'project_detail',
    description: 'One project in full: its description and notes, the tasks attached to it across every day, its documents, and how long has been focused on it.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    async run(a) {
      const id = need(a, 'id');
      const p = await findIn('projects', id, 'project');
      const [{ days }, { documents }] = await Promise.all([
        api('GET', '/api/alldays'),
        api('GET', '/api/documents'),
      ]);
      const mine = [];
      (days || []).forEach((d) => (d.tasks || []).forEach((t) => { if (t.projectId === id) mine.push(Object.assign({ _date: d.date }, t)); }));
      const docs = (documents || []).filter((d) => d.projectId === id);
      const done = mine.filter((t) => t.status === 'done').length;
      const out = ['# ' + (p.title || '(untitled)') + '   [' + (p.status || 'planned') + ']  #' + p.id];
      if (p.desc) out.push('', p.desc);
      if (p.start || p.due) out.push('', (p.start ? 'Starts ' + p.start : '') + (p.due ? (p.start ? ' · ' : '') + 'Due ' + p.due : ''));
      if (p.focusSeconds) out.push('', 'Focused ' + mins(p.focusSeconds) + ' on it.');
      out.push('', 'Tasks: ' + done + ' done of ' + mine.length);
      mine.slice(0, 40).forEach((t) => out.push('  ' + t._date + '  ' + line(t) + '  #' + t.id));
      if (docs.length) { out.push('', 'Documents:'); docs.forEach((d) => out.push('  - ' + d.title + '  #' + d.id)); }
      if (p.notes) out.push('', 'Notes:', p.notes);
      return out.join('\n');
    },
  },
  {
    name: 'add_project',
    write: true,
    description: 'Start a new project — a container for related tasks, documents and focus time, which the app tracks progress against.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        desc: { type: 'string', description: 'What you are trying to accomplish.' },
        status: { type: 'string', enum: PROJECT_STATUS, description: 'Defaults to active.' },
        start: { type: 'string', description: 'YYYY-MM-DD' },
        due: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string' },
      },
    },
    async run(a) {
      // The store calls it `title`; the tool calls it `name` because that is
      // what a person says. Sending `name` created untitled projects.
      const r = await addStore('projects', {
        title: need(a, 'name'), desc: a.desc || '', status: oneOf('status', PROJECT_STATUS, a.status) || 'active',
        start: theDay(a.start, 'start') || '', due: theDay(a.due, 'due') || '', notes: a.notes || '',
        learningIds: [], fromIdeaId: null, focusSeconds: 0,
      });
      return 'Project created: ' + r.item.title + '  #' + r.item.id;
    },
  },
  {
    name: 'update_project',
    write: true,
    description: 'Change a project — rename it, move it between planned, active, paused and done, set dates, or add to its notes.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        desc: { type: 'string' },
        status: { type: 'string', enum: PROJECT_STATUS },
        start: { type: 'string', description: 'YYYY-MM-DD, or "" to clear.' },
        due: { type: 'string', description: 'YYYY-MM-DD, or "" to clear.' },
        notes: { type: 'string', description: 'Replaces the notes. Read them with project_detail first if you mean to add.' },
      },
    },
    async run(a) {
      const patch = pick(a, ['desc', 'notes']);
      if (a.name != null) patch.title = a.name;
      if (a.status != null) patch.status = oneOf('status', PROJECT_STATUS, a.status);
      if (a.start !== undefined) patch.start = theDay(a.start, 'start') || '';
      if (a.due !== undefined) patch.due = theDay(a.due, 'due') || '';
      const r = await patchStore('projects', need(a, 'id'), some(patch));
      return 'Updated project: ' + r.item.title + '  [' + r.item.status + ']';
    },
  },

  // ------------------------------------------------------------------ ideas
  {
    name: 'list_ideas',
    description: 'The idea shelf — things worth thinking about that are not work yet. Each carries a status from captured through exploring and promising to converted or archived.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: IDEA_STATUS, description: 'Only ideas in this state.' } } },
    async run(a) {
      let value = await store('ideas');
      if (a.status) value = value.filter((i) => i.status === oneOf('status', IDEA_STATUS, a.status));
      if (!value.length) return a.status ? 'No ideas are ' + a.status + '.' : 'No ideas yet.';
      return value.map((i) => '- ' + i.title + '  [' + (i.status || 'captured') + ']'
        + ((i.tags || []).length ? '  ' + i.tags.map((t) => '#' + t).join(' ') : '')
        + '  · ' + ago(i.updatedAt || i.createdAt) + '  #' + i.id
        + (i.desc ? '\n    ' + i.desc : '')).join('\n');
    },
  },
  {
    name: 'add_idea',
    write: true,
    description: 'Put something on the idea shelf. Not a task and not a project — a thing worth coming back to.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        desc: { type: 'string', description: 'The thought itself.' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: IDEA_STATUS, description: 'Defaults to captured.' },
      },
    },
    async run(a) {
      const r = await addStore('ideas', {
        title: need(a, 'title'), desc: a.desc || '', notes: '',
        tags: Array.isArray(a.tags) ? a.tags : [],
        status: oneOf('status', IDEA_STATUS, a.status) || 'captured',
        updatedAt: Date.now(), convertedProjectId: null, sparks: [],
      });
      return 'On the idea shelf: ' + r.item.title + '  #' + r.item.id;
    },
  },
  {
    name: 'update_idea',
    write: true,
    description: 'Change an idea — move it along from captured to exploring to promising, retitle it, add notes or tags.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        desc: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: IDEA_STATUS },
      },
    },
    async run(a) {
      const patch = pick(a, ['title', 'desc', 'notes', 'tags']);
      if (a.status != null) patch.status = oneOf('status', IDEA_STATUS, a.status);
      patch.updatedAt = Date.now();
      if (Object.keys(patch).length === 1) throw new Error('nothing to change');
      const r = await patchStore('ideas', need(a, 'id'), patch);
      return 'Updated idea: ' + r.item.title + '  [' + r.item.status + ']';
    },
  },
  {
    name: 'convert_idea',
    write: true,
    description: 'Turn an idea into a real project. The idea is kept and marked converted, with a link to the project it became — the shelf stays a record of where work came from.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The idea.' },
        name: { type: 'string', description: 'Project name. Defaults to the idea\'s title.' },
      },
    },
    async run(a) {
      const id = need(a, 'id');
      const idea = await findIn('ideas', id, 'idea');
      if (idea.convertedProjectId) throw new Error('that idea already became project ' + idea.convertedProjectId);
      const r = await addStore('projects', {
        title: a.name || idea.title, desc: idea.desc || '', status: 'active',
        start: '', due: '', notes: idea.notes || '', learningIds: [],
        fromIdeaId: idea.id, focusSeconds: 0,
      });
      await patchStore('ideas', id, { status: 'converted', convertedProjectId: r.item.id, updatedAt: Date.now() });
      return '“' + idea.title + '” is now a project: ' + r.item.title + '  #' + r.item.id;
    },
  },

  // --------------------------------------------------------------- learning
  {
    name: 'list_learning',
    description: 'The learning bag — topics, books and skills you mean to pick up, with where each one stands and how long you have spent on it.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: LEARN_STATUS } } },
    async run(a) {
      let value = await store('learning');
      if (a.status) value = value.filter((l) => l.status === oneOf('status', LEARN_STATUS, a.status));
      if (!value.length) return a.status ? 'Nothing is ' + a.status + '.' : 'The learning bag is empty.';
      return value.map((l) => '- ' + l.name + '  [' + (l.status || 'bag') + ']'
        + (l.priority && l.priority !== 'normal' ? ' · ' + l.priority : '')
        + (l.totalSeconds ? '  ' + mins(l.totalSeconds) : '')
        + (l.deadline ? '  by ' + l.deadline : '')
        + '  #' + l.id
        + (l.want ? '\n    want: ' + l.want : '')).join('\n');
    },
  },
  {
    name: 'add_learning',
    write: true,
    description: 'Put something in the learning bag. "want" is what you want to be able to do afterwards, which is what makes it finishable rather than open-ended.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'The topic, book or skill.' },
        want: { type: 'string', description: 'What you want to be able to do once you know it.' },
        why: { type: 'string', description: 'Why now.' },
        source: { type: 'string', description: 'Book, course, docs — where you are learning it from.' },
        desc: { type: 'string' },
        status: { type: 'string', enum: LEARN_STATUS, description: 'Defaults to bag.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Defaults to normal.' },
        deadline: { type: 'string', description: 'YYYY-MM-DD' },
        expectedMin: { type: 'number', description: 'Roughly how many minutes you think it will take.' },
        projectId: { type: 'string', description: 'If it is for a project.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    async run(a) {
      const r = await addStore('learning', {
        name: need(a, 'name'), desc: a.desc || '', want: a.want || '', why: a.why || '',
        context: '', source: a.source || '',
        priority: thePriority(a.priority) || 'normal',
        status: oneOf('status', LEARN_STATUS, a.status) || 'bag',
        tags: Array.isArray(a.tags) ? a.tags : [], notes: '',
        lastStudied: null, totalSeconds: 0, projectId: a.projectId || null,
        deadline: theDay(a.deadline, 'deadline') || '',
        expectedMin: a.expectedMin || null, parts: [], sessions: [],
      });
      return 'In the learning bag: ' + r.item.name + '  #' + r.item.id;
    },
  },
  {
    name: 'update_learning',
    write: true,
    description: 'Change something in the learning bag — move it from bag to learning to learned, sharpen what you want out of it, add notes.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        want: { type: 'string' },
        why: { type: 'string' },
        source: { type: 'string' },
        desc: { type: 'string' },
        notes: { type: 'string' },
        status: { type: 'string', enum: LEARN_STATUS },
        priority: { type: 'string', enum: PRIORITIES },
        deadline: { type: 'string', description: 'YYYY-MM-DD, or "" to clear.' },
        expectedMin: { type: 'number' },
        projectId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    async run(a) {
      const patch = pick(a, ['name', 'want', 'why', 'source', 'desc', 'notes', 'expectedMin', 'projectId', 'tags']);
      if (a.status != null) patch.status = oneOf('status', LEARN_STATUS, a.status);
      if (a.priority != null) patch.priority = thePriority(a.priority);
      if (a.deadline !== undefined) patch.deadline = theDay(a.deadline, 'deadline') || '';
      const r = await patchStore('learning', need(a, 'id'), some(patch));
      return 'Updated: ' + r.item.name + '  [' + r.item.status + ']';
    },
  },

  // ------------------------------------------------------------------ inbox
  {
    name: 'list_inbox',
    description: 'The Inbox — thoughts captured but not yet sorted into anything. Defaults to the ones still open.',
    inputSchema: {
      type: 'object',
      properties: { includeProcessed: { type: 'boolean', description: 'Also show what has already been dealt with.' } },
    },
    async run(a) {
      const value = await store('captures');
      const rows = a.includeProcessed ? value : value.filter((c) => c.status === 'open');
      if (!rows.length) return a.includeProcessed ? 'Inbox is empty.' : 'Inbox is clear.';
      return rows.slice(0, 60).map((c) => '- [' + (c.status || 'open') + '] ' + c.text
        + (c.note ? '  — ' + c.note : '')
        + '  · ' + ago(c.createdAt)
        + (c.becameKind ? '  → ' + c.becameKind : '')
        + '  #' + c.id).join('\n');
    },
  },
  {
    name: 'capture',
    write: true,
    description: 'Drop a thought into the Inbox to be sorted out later. Use this when something is worth keeping but is not yet a task.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, note: { type: 'string' } } },
    async run(a) {
      const r = await addStore('captures', {
        text: need(a, 'text'), note: a.note || '', context: 'claude', status: 'open',
        becameKind: null, becameId: null, processedAt: null,
      });
      return 'In your inbox: ' + r.item.text;
    },
  },
  {
    name: 'process_inbox_item',
    write: true,
    description: 'Clear something out of the Inbox by turning it into a task, an idea, a learning topic or a document — or just by marking it dealt with. The capture stays as a record of where the thing came from.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The capture — see list_inbox.' },
        into: { type: 'string', enum: ['task', 'idea', 'learning', 'document', 'backlog', 'nothing'], description: 'What to make of it. "nothing" just marks it processed.' },
        date: { type: 'string', description: 'For into="task" — which day\'s board. Defaults to today.' },
        pickupDate: { type: 'string', description: 'For into="backlog" — YYYY-MM-DD it should come back.' },
      },
    },
    async run(a) {
      const id = need(a, 'id');
      const c = await findIn('captures', id, 'capture');
      if (c.status === 'processed') throw new Error('that capture was already processed');
      const into = a.into || 'nothing';
      let kind = null, madeId = null, said = 'Marked processed';
      if (into === 'task') {
        const date = theDate(a);
        const r = await api('POST', '/api/tasks?date=' + date, {
          text: c.text, status: 'todo', priority: 'normal', note: c.note || '',
          estimateMin: null, projectId: null, learningId: null, people: [], pickupDate: null, dependsOn: [],
        });
        kind = 'task'; madeId = r.task.id; said = 'Now a task on ' + date;
      } else if (into === 'idea') {
        const r = await addStore('ideas', {
          title: c.text, desc: c.note || '', notes: '', tags: [], status: 'captured',
          updatedAt: Date.now(), convertedProjectId: null, sparks: [],
        });
        kind = 'idea'; madeId = r.item.id; said = 'Now an idea';
      } else if (into === 'learning') {
        const r = await addStore('learning', {
          name: c.text, desc: c.note || '', want: '', why: '', context: '', source: '',
          priority: 'normal', status: 'bag', tags: [], notes: '', lastStudied: null,
          totalSeconds: 0, projectId: null, deadline: '', expectedMin: null, parts: [], sessions: [],
        });
        kind = 'learning'; madeId = r.item.id; said = 'Now in the learning bag';
      } else if (into === 'document') {
        const r = await api('POST', '/api/documents', { title: c.text.slice(0, 120), content: c.note || '' });
        kind = 'doc'; madeId = r.document.id; said = 'Now a document';
      } else if (into === 'backlog') {
        const when = theDay(a.pickupDate, 'pickupDate');
        const r = await addStore('backlog', {
          text: c.text, note: c.note || '', pickupDate: when, projectId: null,
          estimateMin: null, fromTaskId: null, promotedTo: null, promotedOn: null, notifiedOn: null,
        });
        kind = 'backlog'; madeId = r.item.id;
        said = 'Parked in the backlog' + (when ? ' until ' + when : ' with no date');
      }
      await patchStore('captures', id, { status: 'processed', becameKind: kind, becameId: madeId, processedAt: Date.now() });
      return said + ': ' + c.text + (madeId ? '  #' + madeId : '');
    },
  },

  // -------------------------------------------------------------- reminders
  {
    name: 'list_reminders',
    description: 'Reminders, by the day each one is set for. On its day the app blocks the screen until the reminder is acknowledged or marked done.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Only this day. Omit for all open reminders.' },
        includeDone: { type: 'boolean' },
      },
    },
    async run(a) {
      let value = await store('reminders');
      if (a.date) value = value.filter((r) => r.date === theDay(a.date, 'date'));
      if (!a.includeDone) value = value.filter((r) => r.status !== 'done' && !r.doneAt);
      if (!value.length) return 'No reminders' + (a.date ? ' on ' + a.date : '') + '.';
      return value.map((r) => '- ' + r.date + '  ' + r.text
        + '  [' + (r.doneAt ? 'done' : r.status || 'open') + ']'
        + (r.acks ? '  · snoozed ' + r.acks + '×' : '') + '  #' + r.id).join('\n');
    },
  },
  {
    name: 'add_reminder',
    write: true,
    description: 'Set a reminder for a day. On that day the app blocks the screen until it is acknowledged or marked done.',
    inputSchema: {
      type: 'object',
      required: ['text', 'date'],
      properties: {
        text: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        taskId: { type: 'string', description: 'If it is about a specific task.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const r = await addStore('reminders', {
        text: need(a, 'text'), date, status: 'open', acks: 0,
        quietUntil: null, doneAt: null, notifiedOn: null, taskId: a.taskId || null,
      });
      return 'Reminder set for ' + date + ': ' + r.item.text;
    },
  },
  {
    name: 'update_reminder',
    write: true,
    description: 'Change a reminder — mark it done, move it to another day, or reword it.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        date: { type: 'string', description: 'Move it to this day. YYYY-MM-DD.' },
        done: { type: 'boolean', description: 'true marks it done; false reopens it.' },
      },
    },
    async run(a) {
      const patch = pick(a, ['text']);
      if (a.date != null) patch.date = theDay(a.date, 'date');
      if (a.done != null) { patch.status = a.done ? 'done' : 'open'; patch.doneAt = a.done ? Date.now() : null; }
      const r = await patchStore('reminders', need(a, 'id'), some(patch));
      return 'Reminder ' + (r.item.doneAt ? 'done' : 'set for ' + r.item.date) + ': ' + r.item.text;
    },
  },

  // ---------------------------------------------------------------- backlog
  {
    name: 'list_backlog',
    description: 'Work parked for later, with the date each item is meant to come back.',
    inputSchema: { type: 'object', properties: { includePromoted: { type: 'boolean', description: 'Also show items already pulled onto a board.' } } },
    async run(a) {
      const value = await store('backlog');
      const rows = a.includePromoted ? value : value.filter((b) => !b.promotedTo);
      if (!rows.length) return 'Backlog is empty.';
      return rows.map((b) => '- ' + b.text + '  [' + (b.pickupDate || 'no date') + ']'
        + (b.estimateMin ? '  (' + b.estimateMin + 'm)' : '')
        + (b.promotedOn ? '  → board on ' + b.promotedOn : '')
        + '  #' + b.id).join('\n');
    },
  },
  {
    name: 'add_backlog',
    write: true,
    description: 'Park something for later rather than putting it on today\'s board. A pick-up date is how it comes back; without one it only surfaces when you go looking.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        note: { type: 'string' },
        pickupDate: { type: 'string', description: 'YYYY-MM-DD — the day it should come back.' },
        estimateMin: { type: 'number' },
        projectId: { type: 'string' },
      },
    },
    async run(a) {
      const r = await addStore('backlog', {
        text: need(a, 'text'), note: a.note || '', pickupDate: theDay(a.pickupDate, 'pickupDate'),
        projectId: a.projectId || null, estimateMin: a.estimateMin || null,
        promotedTo: null, promotedOn: null, notifiedOn: null,
      });
      return 'In the backlog: ' + r.item.text + (r.item.pickupDate ? ' — back on ' + r.item.pickupDate : ' — no date set');
    },
  },
  {
    name: 'update_backlog',
    write: true,
    description: 'Change a parked item — most usefully, give it the pick-up date it is missing so it comes back on its own.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        note: { type: 'string' },
        pickupDate: { type: 'string', description: 'YYYY-MM-DD, or "" to clear it.' },
        estimateMin: { type: 'number' },
        projectId: { type: 'string' },
      },
    },
    async run(a) {
      const patch = pick(a, ['text', 'note', 'estimateMin', 'projectId']);
      if (a.pickupDate !== undefined) patch.pickupDate = theDay(a.pickupDate, 'pickupDate');
      const r = await patchStore('backlog', need(a, 'id'), some(patch));
      return 'Backlog updated: ' + r.item.text + (r.item.pickupDate ? ' — back on ' + r.item.pickupDate : ' — no date set');
    },
  },
  {
    name: 'promote_backlog',
    write: true,
    description: 'Pull something out of the backlog and onto a day\'s board. The backlog entry stays, marked with the task it became.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        date: { type: 'string', description: 'Which day\'s board. Defaults to today.' },
        priority: { type: 'string', enum: PRIORITIES },
      },
    },
    async run(a) {
      const date = theDate(a);
      const id = need(a, 'id');
      const b = await findIn('backlog', id, 'backlog item');
      if (b.promotedTo) throw new Error('that was already pulled onto ' + (b.promotedOn || 'a board'));
      const r = await api('POST', '/api/tasks?date=' + date, {
        text: b.text, status: 'todo', priority: thePriority(a.priority) || 'normal',
        note: b.note || '', estimateMin: b.estimateMin || null, projectId: b.projectId || null,
        learningId: null, people: [], pickupDate: null, dependsOn: [],
      });
      await patchStore('backlog', id, { promotedTo: r.task.id, promotedOn: date });
      return 'On the board for ' + date + ': ' + r.task.text + '  #' + r.task.id;
    },
  },
  {
    name: 'park_task',
    write: true,
    description: 'The opposite of promote_backlog: take a task off a day\'s board and park it in the backlog. Nothing is lost — its note, estimate and project go with it, and the backlog entry remembers the task it came from. A carried task parked this way stops coming back.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The task — see list_tasks.' },
        date: { type: 'string', description: 'The day it is on. Defaults to today.' },
        pickupDate: { type: 'string', description: 'YYYY-MM-DD it should come back. Defaults to the task\'s own pick-up date; without either it only surfaces when you go looking.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const body = {};
      if (a.pickupDate !== undefined) body.pickupDate = theDay(a.pickupDate, 'pickupDate');
      const r = await api('POST', '/api/tasks/park?date=' + date + '&id=' + encodeURIComponent(need(a, 'id')), body);
      return 'Parked off ' + date + ': ' + r.item.text
        + (r.item.pickupDate ? ' — back on ' + r.item.pickupDate : ' — no date set')
        + '  #' + r.item.id;
    },
  },

  // ----------------------------------------------------------- task graph
  {
    name: 'list_graph',
    description: 'What is on the Task Graph right now — the small set of tasks pulled into the working canvas, with their status, what each is waiting on, and why it was pulled in. The graph holds references, never copies: every row is a real task on a real day.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const g = (await api('GET', '/api/store?name=graph')).value || {};
      const nodes = Array.isArray(g.nodes) ? g.nodes : [];
      if (!nodes.length) return 'The graph is empty.';
      const byDate = {};
      nodes.forEach((n) => { (byDate[n.date] = byDate[n.date] || []).push(n); });
      const out = [];
      for (const date of Object.keys(byDate).sort()) {
        const { tasks } = await api('GET', '/api/tasks?date=' + date);
        byDate[date].forEach((n) => {
          const t = tasks.find((x) => x.id === n.id);
          if (!t) { out.push('- (gone) ' + n.id); return; }
          const waiting = (t.dependsOn || [])
            .map((d) => tasks.find((x) => x.id === d))
            .filter((x) => x && x.status !== 'done')
            .map((x) => x.text);
          out.push(line(t) + '  #' + t.id
            + (waiting.length ? '\n    waiting on: ' + waiting.join('; ') : '')
            + (n.why ? '\n    pulled in because: ' + n.why : ''));
        });
      }
      return nodes.length + ' on the canvas\n' + out.join('\n');
    },
  },
  {
    name: 'pull_into_graph',
    write: true,
    description: 'Pull a task onto the Task Graph — the canvas of what is actually being worked through. A task in To Do starts when it is pulled in; a blocked task stays blocked if it is still waiting on unfinished work, because clicking a node does not finish its dependencies. Nothing is copied: the node points at the real task.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The task — see list_tasks.' },
        date: { type: 'string', description: 'The day it is on. Defaults to today.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const id = need(a, 'id');
      const { tasks } = await api('GET', '/api/tasks?date=' + date);
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new Error('no task ' + id + ' on ' + date);
      const g = (await api('GET', '/api/store?name=graph')).value || {};
      const nodes = Array.isArray(g.nodes) ? g.nodes : [];
      if (nodes.some((n) => n.date === date && n.id === id)) return 'Already on the canvas: ' + t.text;

      let moved = '';
      const waiting = (t.dependsOn || [])
        .map((d) => tasks.find((x) => x.id === d))
        .filter((x) => x && x.status !== 'done');
      if (t.status === 'todo' || (t.status === 'blocked' && !waiting.length)) {
        await api('PATCH', '/api/tasks?date=' + date + '&id=' + encodeURIComponent(id), { status: 'progress' });
        moved = ' — started';
      } else if (t.status === 'blocked') {
        moved = ' — still blocked, waiting on ' + waiting.map((x) => x.text).join('; ');
      }
      nodes.push({ date, id, x: null, y: null, addedAt: Date.now(), why: 'pulled in from chat' });
      await api('PATCH', '/api/store?name=graph', { nodes });
      return 'On the graph: ' + t.text + moved;
    },
  },
  {
    name: 'clear_graph',
    write: true,
    description: 'Take tasks off the Task Graph. This only clears the canvas — no task is deleted, changed or moved by it. Pass an id to remove one, or nothing to clear the whole canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One task to take off. Omit to clear everything.' },
        date: { type: 'string', description: 'The day that task is on. Defaults to today.' },
      },
    },
    async run(a) {
      const g = (await api('GET', '/api/store?name=graph')).value || {};
      const nodes = Array.isArray(g.nodes) ? g.nodes : [];
      if (!a.id) {
        await api('PATCH', '/api/store?name=graph', { nodes: [] });
        return 'Canvas cleared — ' + nodes.length + ' taken off, every task untouched.';
      }
      const date = theDate(a);
      const left = nodes.filter((n) => !(n.date === date && n.id === a.id));
      if (left.length === nodes.length) return 'That one was not on the canvas.';
      await api('PATCH', '/api/store?name=graph', { nodes: left });
      return 'Off the canvas. The task itself is untouched.';
    },
  },
  {
    name: 'learning_to_task',
    write: true,
    description: 'Turn a learning topic into an ordinary task on a day\'s board, keeping the relationship back to it. The result is a normal task in every respect — status, priority, dependencies, project, documents — not a special kind of task.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The learning item — see list_learning.' },
        date: { type: 'string', description: "Which day's board. Defaults to today." },
      },
    },
    async run(a) {
      const date = theDate(a);
      const l = await findIn('learning', need(a, 'id'), 'learning item');
      const note = [l.want && 'Want: ' + l.want, l.why && 'Why: ' + l.why, l.source && 'Source: ' + l.source]
        .filter(Boolean).join('\n');
      const r = await api('POST', '/api/tasks?date=' + date, {
        text: l.name, status: 'todo',
        priority: PRIORITIES.includes(l.priority) ? l.priority : 'normal',
        note, estimateMin: l.expectedMin || null, projectId: l.projectId || null,
        learningId: l.id, people: [], pickupDate: l.deadline || null, dependsOn: [],
      });
      if (l.status === 'bag') await patchStore('learning', l.id, { status: 'learning' });
      return '“' + l.name + '” is a task on ' + date + '  #' + r.task.id + ' — still linked to the learning item.';
    },
  },

  // ------------------------------------------------------------------- due
  {
    name: 'list_due',
    description: 'Everything with a day it has to be done by — the Due list, grouped from overdue through to no-date-yet. Pass includeOthers to also roll up the dates already carried elsewhere in the app: project due dates, learning deadlines, reminders, backlog pick-ups and task pick-up dates.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDone: { type: 'boolean' },
        includeOthers: { type: 'boolean', description: 'Also list dated things from the rest of the app.' },
      },
    },
    async run(a) {
      const all = await store('todos');
      const rows = a.includeDone ? all : all.filter((t) => t.status !== 'done');
      const day = (d) => {
        if (!d) return null;
        const x = new Date(d + 'T00:00:00'); x.setHours(0, 0, 0, 0);
        const n = new Date(); n.setHours(0, 0, 0, 0);
        return Math.round((x - n) / 86400000);
      };
      const word = (d) => {
        const n = day(d);
        return n === null ? 'no date' : n < 0 ? Math.abs(n) + 'd late' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + 'd';
      };
      const out = [];
      if (!rows.length) out.push('Nothing on the Due list.');
      else {
        rows.slice().sort((x, y) => String(x.due || '9999').localeCompare(String(y.due || '9999')))
          .forEach((t) => out.push('- [' + (t.status === 'done' ? 'done' : word(t.due)) + '] ' + t.text
            + (t.due ? '  (' + t.due + ')' : '')
            + (t.priority && t.priority !== 'normal' ? '  · ' + t.priority : '')
            + (t.note ? '\n    ' + t.note : '')
            + '  #' + t.id));
      }
      if (a.includeOthers) {
        const [projects, learning, reminders, backlog, days] = await Promise.all([
          store('projects'), store('learning'), store('reminders'), store('backlog'),
          api('GET', '/api/alldays').then((r) => r.days || []),
        ]);
        const other = [];
        projects.filter((p) => p.due && p.status !== 'done').forEach((p) => other.push(['Project', p.title, p.due]));
        learning.filter((l) => l.deadline && l.status !== 'learned').forEach((l) => other.push(['Learning', l.name, l.deadline]));
        reminders.filter((r) => r.status !== 'done' && !r.doneAt).forEach((r) => other.push(['Reminder', r.text, r.date]));
        backlog.filter((b) => b.pickupDate && !b.promotedTo).forEach((b) => other.push(['Backlog', b.text, b.pickupDate]));
        days.forEach((d) => (d.tasks || []).forEach((t) => {
          if (t.pickupDate && t.status !== 'done') other.push(['Task', t.text, t.pickupDate]);
        }));
        // A carried task appears once per day carried, same date every time.
        const seen = new Set();
        const uniq = other.filter((o) => {
          const k = o.join('\u0000');
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        uniq.sort((x, y) => String(x[2]).localeCompare(String(y[2])));
        out.push('', 'Already dated elsewhere (' + uniq.length + '):');
        uniq.slice(0, 60).forEach((o) => out.push('- ' + o[2] + '  [' + o[0] + ']  ' + o[1]));
      }
      return out.join('\n');
    },
  },
  {
    name: 'add_due',
    write: true,
    description: 'Put something on the Due list — a commitment with the day it has to be done by. Use this for "X by Friday" when X is not yet a task on a board, a project or anything else. It can be linked to any of those afterwards, or right away.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD it must be done by. Leave it out for something with no date yet.' },
        note: { type: 'string', description: 'Any leeway, conditions or detail.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Defaults to normal.' },
        taskId: { type: 'string' },
        projectId: { type: 'string' },
        docId: { type: 'string' },
        ideaId: { type: 'string' },
        learningId: { type: 'string' },
        reminderId: { type: 'string' },
      },
    },
    async run(a) {
      const r = await addStore('todos', {
        text: need(a, 'text'), note: a.note || '', due: theDay(a.due, 'due'),
        priority: thePriority(a.priority) || 'normal', status: 'open', doneAt: null,
        taskId: a.taskId || null, projectId: a.projectId || null, docId: a.docId || null,
        ideaId: a.ideaId || null, learningId: a.learningId || null, reminderId: a.reminderId || null,
      });
      return 'On the Due list: ' + r.item.text + (r.item.due ? ' — by ' + r.item.due : ' — no date yet') + '  #' + r.item.id;
    },
  },
  {
    name: 'update_due',
    write: true,
    description: 'Change something on the Due list — move its date, mark it done, reword it, or link it to a task, project, document, idea, learning item or reminder.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        note: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD, or "" to take the date off.' },
        priority: { type: 'string', enum: PRIORITIES },
        done: { type: 'boolean' },
        taskId: { type: 'string', description: 'Link to a task; "" unlinks.' },
        projectId: { type: 'string' },
        docId: { type: 'string' },
        ideaId: { type: 'string' },
        learningId: { type: 'string' },
        reminderId: { type: 'string' },
      },
    },
    async run(a) {
      const patch = pick(a, ['text', 'note']);
      if (a.due !== undefined) patch.due = theDay(a.due, 'due');
      if (a.priority != null) patch.priority = thePriority(a.priority);
      if (a.done != null) { patch.status = a.done ? 'done' : 'open'; patch.doneAt = a.done ? Date.now() : null; }
      ['taskId', 'projectId', 'docId', 'ideaId', 'learningId', 'reminderId'].forEach((k) => {
        if (a[k] !== undefined) patch[k] = a[k] || null;
      });
      const r = await patchStore('todos', need(a, 'id'), some(patch));
      return 'Due updated: ' + r.item.text + (r.item.status === 'done' ? ' — done' : r.item.due ? ' — by ' + r.item.due : ' — no date');
    },
  },

  // -------------------------------------------------------------- documents
  {
    name: 'list_documents',
    description: 'Documents in the workspace, with their folders and tags. Pass q to search titles, tags and bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text search.' },
        folder: { type: 'string', description: 'Only this folder.' },
        tag: { type: 'string', description: 'Only documents carrying this tag.' },
      },
    },
    async run(a) {
      const qs = [];
      if (a.q) qs.push('q=' + encodeURIComponent(a.q));
      if (a.tag) qs.push('tag=' + encodeURIComponent(a.tag));
      const { documents } = await api('GET', '/api/documents' + (qs.length ? '?' + qs.join('&') : ''));
      let rows = documents || [];
      if (a.folder) rows = rows.filter((d) => (d.folder || '') === a.folder);
      if (!rows.length) return a.q ? 'Nothing matches “' + a.q + '”.' : 'No documents here.';
      const folders = [...new Set(rows.map((d) => d.folder).filter(Boolean))];
      return rows.map((d) => '- ' + (d.pinned ? '📌 ' : '') + d.title
          + (d.folder ? '  [' + d.folder + ']' : '')
          + ((d.tags || []).length ? '  ' + d.tags.map((t) => '#' + t).join(' ') : '')
          + '  #' + d.id + (d.snippet ? '\n    …' + d.snippet : '')).join('\n')
        + (folders.length ? '\n\nFolders: ' + folders.join(', ') : '');
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
    write: true,
    description: 'Create a document, or change one that exists. With an id and mode "append" the content is added to the end; with mode "replace" it overwrites. Every write keeps a version, so nothing is lost.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string' },
        id: { type: 'string', description: 'Omit to create a new document.' },
        title: { type: 'string', description: 'Required when creating.' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Only when editing. Defaults to append.' },
        folder: { type: 'string', description: 'When creating — which folder it goes in.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    async run(a) {
      const content = a.content == null ? '' : String(a.content);
      if (!a.id) {
        const r = await api('POST', '/api/documents', {
          title: a.title || 'Untitled', content,
          folder: a.folder || '', tags: Array.isArray(a.tags) ? a.tags : [],
        });
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
    name: 'update_document',
    write: true,
    description: 'Everything about a document except its body — rename it, move it to a folder, retag it, pin it, attach it to a project or task, or archive it. Archiving is reversible: pass archived false to bring it back.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        folder: { type: 'string', description: 'Use "" for the top level.' },
        tags: { type: 'array', items: { type: 'string' } },
        pinned: { type: 'boolean' },
        archived: { type: 'boolean', description: 'true files it away, false brings it back. Nothing is lost either way.' },
        projectId: { type: 'string' },
        taskId: { type: 'string' },
        ideaId: { type: 'string' },
        learningId: { type: 'string' },
      },
    },
    async run(a) {
      const id = need(a, 'id');
      const body = pick(a, ['title', 'folder', 'tags', 'pinned', 'projectId', 'taskId', 'ideaId', 'learningId']);
      let said = [];
      if (Object.keys(body).length) {
        const r = await api('PUT', '/api/documents/' + encodeURIComponent(id), body);
        said.push('Updated “' + r.document.title + '”');
      }
      if (a.archived != null) {
        const r = await api('POST', '/api/documents/' + encodeURIComponent(id) + '/' + (a.archived ? 'archive' : 'restore'));
        said.push(a.archived ? 'Archived “' + r.document.title + '”' : 'Back in the workspace: “' + r.document.title + '”');
      }
      if (!said.length) throw new Error('nothing to change');
      return said.join('. ') + '.';
    },
  },

  // -------------------------------------------------------------------- day
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
      const out = [date + (m.dayType ? '  (' + m.dayType + (m.offLabel ? ' — ' + m.offLabel : '') + ')' : '')];
      STATUSES.forEach((s) => {
        const g = by(s);
        if (g.length) out.push('', s.toUpperCase() + ' (' + g.length + ')', ...g.map((t) => line(t)));
      });
      if (!tasks.length) out.push('', 'Nothing on the board.');
      out.push('', 'Focused ' + mins(secs) + ' across ' + (m.sessions || []).length + ' session(s).');
      if (m.login) out.push('Clocked in ' + m.login + (m.logout ? ', out ' + m.logout : ''));
      if (m.location) out.push('Working from ' + m.location);
      return out.join('\n');
    },
  },
  {
    name: 'set_day',
    write: true,
    description: 'The shape of a day rather than what is on it — whether it is a working day or off, what to call the time off, where you are working from, and the clock-in and clock-out stamps.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        dayType: { type: 'string', enum: ['work', 'off'], description: 'An off day is left out of focus averages.' },
        offLabel: { type: 'string', description: 'Why it is off — leave, holiday, sick.' },
        location: { type: 'string', description: 'Office, home, wherever.' },
        login: { type: 'string', description: 'Clock-in time, HH:MM.' },
        logout: { type: 'string', description: 'Clock-out time, HH:MM.' },
        noCarry: { type: 'boolean', description: 'Stop yesterday\'s unfinished work carrying onto this day.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const patch = pick(a, ['offLabel', 'location', 'noCarry']);
      if (a.dayType != null) patch.dayType = oneOf('dayType', ['work', 'off'], a.dayType);
      ['login', 'logout'].forEach((k) => {
        if (a[k] == null) return;
        if (!/^\d{1,2}:\d{2}$/.test(a[k])) throw new Error(k + ' must look like HH:MM');
        patch[k] = a[k];
      });
      const r = await api('PATCH', '/api/meta?date=' + date, some(patch));
      const m = r.meta || {};
      return date + ' set: ' + Object.keys(patch).map((k) => k + ' = ' + JSON.stringify(m[k])).join(', ');
    },
  },

  // ------------------------------------------------------------------ focus
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
  {
    name: 'log_focus',
    write: true,
    description: 'Record a stretch of focused work that happened away from the app, with the wrap-up — what got done and what is next. It lands in the Focus Log and counts toward the day\'s totals, exactly like a session run with the timer.',
    inputSchema: {
      type: 'object',
      required: ['minutes'],
      properties: {
        minutes: { type: 'number', description: 'How long it ran.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        taskText: { type: 'string', description: 'What it was on. Left out, it reads as free focus.' },
        taskId: { type: 'string', description: 'If it was a task on that day\'s board.' },
        accomplished: { type: 'string', description: 'What actually got done.' },
        nextStep: { type: 'string', description: 'Where to pick it up.' },
        startedAt: { type: 'string', description: 'Clock time it began, HH:MM. Defaults to working back from now.' },
      },
    },
    async run(a) {
      const date = theDate(a);
      const minutes = Number(a.minutes);
      if (!(minutes > 0)) throw new Error('minutes must be a positive number');
      if (minutes > 24 * 60) throw new Error('that is more than a day');
      const seconds = Math.round(minutes * 60);
      let start;
      if (a.startedAt) {
        if (!/^\d{1,2}:\d{2}$/.test(a.startedAt)) throw new Error('startedAt must look like HH:MM');
        const [h, m] = a.startedAt.split(':').map(Number);
        start = new Date(date + 'T00:00:00');
        start.setHours(h, m, 0, 0);
        start = start.getTime();
      } else {
        start = Date.now() - seconds * 1000;
      }
      await api('PATCH', '/api/meta?date=' + date, {
        appendSession: {
          start, end: start + seconds * 1000, accumulatedSec: seconds, seconds,
          runningSince: null, taskId: a.taskId || null, taskText: a.taskText || '',
          accomplished: a.accomplished || '', nextStep: a.nextStep || '', source: 'claude',
        },
      });
      return 'Logged ' + mins(seconds) + ' of focus on ' + date + (a.taskText ? ' — ' + a.taskText : '') + '.';
    },
  },

  // ----------------------------------------------------------- weekly review
  {
    name: 'read_review',
    description: 'The weekly review for a week: the numbers the app worked out — tasks finished, focus hours, documents, ideas — alongside whatever reflection is written against it.',
    inputSchema: { type: 'object', properties: { week: { type: 'string', description: 'The Monday of the week, YYYY-MM-DD. Defaults to this week.' } } },
    async run(a) {
      const week = a.week ? theDay(a.week, 'week') : mondayOf(new Date());
      const all = (await api('GET', '/api/store?name=reviews')).value || {};
      const r = all[week];
      if (!r) return 'No review saved for the week of ' + week + ' yet. The app writes one when you open the Weekly Review page.';
      const s = r.snapshot || {};
      const out = ['Week of ' + week];
      if (s.start) out.push(s.start + ' → ' + s.end);
      out.push('', 'Tasks: ' + (s.tasksCompleted || 0) + ' done of ' + (s.tasksTotal || 0)
        + (s.completionRate != null ? '  (' + Math.round(s.completionRate * 100) + '%)' : ''));
      if (s.focusSeconds) out.push('Focused ' + mins(s.focusSeconds));
      if (s.docsCreated || s.docsUpdated) out.push('Documents: ' + (s.docsCreated || 0) + ' new, ' + (s.docsUpdated || 0) + ' edited');
      if (s.ideasCaptured || s.ideasConverted) out.push('Ideas: ' + (s.ideasCaptured || 0) + ' captured, ' + (s.ideasConverted || 0) + ' converted');
      if (s.learnedCount) out.push('Learned: ' + (s.learnedNames || []).join(', '));
      if (r.well || r.bad || r.next) {
        out.push('', 'Reflection');
        if (r.well) out.push('What went well: ' + r.well);
        if (r.bad) out.push("What didn't: " + r.bad);
        if (r.next) out.push('Next week: ' + r.next);
      }
      return out.join('\n');
    },
  },
  {
    name: 'write_review',
    write: true,
    description: "The reflection half of a weekly review — what went well, what didn't, what next week should be about. The numbers beside it are the app's own and are not editable.",
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string', description: 'The Monday of the week, YYYY-MM-DD. Defaults to this week.' },
        well: { type: 'string', description: 'What went well.' },
        bad: { type: 'string', description: "What didn't." },
        next: { type: 'string', description: 'What next week should be about.' },
      },
    },
    async run(a) {
      const week = a.week ? theDay(a.week, 'week') : mondayOf(new Date());
      const patch = some(pick(a, ['well', 'bad', 'next']));
      await patchStore('reviews', week, patch);
      return 'Reflection saved for the week of ' + week + ': ' + Object.keys(patch).join(', ') + '.';
    },
  },

  // --------------------------------------------------------------- settings
  {
    name: 'get_settings',
    description: 'Which parts of the app are switched on — the panels on the Today page and the pages in the sidebar. Anything not listed is on.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const v = (await api('GET', '/api/store?name=settings')).value || {};
      const show = (o) => Object.keys(o || {}).map((k) => '  ' + k + ': ' + (o[k] === false ? 'hidden' : 'shown')).join('\n');
      const out = [];
      out.push('Panels:', show(v.sections) || '  (all shown)');
      out.push('Pages:', show(v.pages) || '  (all shown)');
      out.push('Downloads: ' + ((v.downloads && v.downloads.keepOld)
        ? 'every version is kept in Downloads'
        : 'a new download replaces the last one (the old disk image goes to the Trash)'));
      return out.join('\n');
    },
  },
  {
    name: 'update_settings',
    write: true,
    description: 'Show or hide parts of the app. "sections" are the panels on the Today page; "pages" are the entries in the sidebar. Pass only what you want to change — the rest is left alone.',
    inputSchema: {
      type: 'object',
      properties: {
        sections: { type: 'object', description: 'Panel name to true (shown) or false (hidden), e.g. {"spotify": false}. Read get_settings for the names.' },
        pages: { type: 'object', description: 'Page name to true or false.' },
        keepOldDownloads: { type: 'boolean', description: 'true keeps every downloaded disk image; false (the default) moves the previous one to the Trash when a new one lands.' },
      },
    },
    async run(a) {
      const patch = {};
      if (a.keepOldDownloads != null) patch.downloads = { keepOld: !!a.keepOldDownloads };
      ['sections', 'pages'].forEach((k) => {
        if (a[k] == null) return;
        if (typeof a[k] !== 'object' || Array.isArray(a[k])) throw new Error(k + ' must be an object of name → true/false');
        const clean = {};
        Object.keys(a[k]).forEach((n) => { clean[n] = a[k][n] !== false; });
        patch[k] = clean;
      });
      await patchStore('settings', null, some(patch));
      const changed = [];
      ['sections', 'pages'].forEach((k) => {
        if (patch[k]) Object.keys(patch[k]).forEach((n) => changed.push(n + ' ' + (patch[k][n] ? 'shown' : 'hidden')));
      });
      if (patch.downloads) changed.push(patch.downloads.keepOld ? 'keeping every download' : 'replacing old downloads');
      return changed.join(', ') + '.';
    },
  },

  // --------------------------------------------------------------- activity
  {
    name: 'recent_activity',
    description: 'The app\'s own history — tasks finished, projects moved, ideas converted, learning sessions. Useful for answering "what have I actually been doing".',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many entries. Defaults to 40.' },
        days: { type: 'number', description: 'Only the last N days.' },
      },
    },
    async run(a) {
      let value = await store('activity');
      if (a.days) {
        const since = Date.now() - Number(a.days) * 86400000;
        value = value.filter((r) => (r.ts || 0) >= since);
      }
      value = value.slice(0, Math.max(1, Math.min(200, Number(a.limit) || 40)));
      if (!value.length) return 'Nothing logged.';
      return value.map((r) => '- ' + new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')
        + '  [' + r.type + ']  ' + r.text).join('\n');
    },
  },

  // --------------------------------------------------------------- calendar
  {
    name: 'list_events',
    description: 'Calendar events in a date range, read from the calendars macOS already syncs. Defaults to today.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        to: { type: 'string', description: 'YYYY-MM-DD. Defaults to `from`.' },
      },
    },
    async run(a) {
      const from = a.from ? theDay(a.from, 'from') : today();
      const to = a.to ? theDay(a.to, 'to') : from;
      const r = await api('GET', '/api/calendar/events?from=' + from + '&to=' + to);
      if (r.error) throw new Error('Calendar unavailable: ' + r.error);
      const ev = r.events || [];
      if (!ev.length) return 'Nothing in the calendar ' + (from === to ? 'on ' + from : 'between ' + from + ' and ' + to) + '.';
      const clock = (s) => (s || '').slice(11, 16);
      return ev.map((e) => '- ' + (e.start || '').slice(0, 10) + '  '
        + (e.allDay ? 'all day' : clock(e.start) + '–' + clock(e.end))
        + '  ' + (e.title || '(untitled)')
        + (e.location ? '  @ ' + e.location : '')
        + (e.calendar ? '  [' + e.calendar + ']' : '')).join('\n');
    },
  },
  {
    name: 'add_event',
    write: true,
    description: 'Put an event on the calendar. It goes into the calendar macOS already syncs, so it reaches Google or Exchange the same way anything else you add does. No invitations are sent — this creates an entry, it does not invite anyone.',
    inputSchema: {
      type: 'object',
      required: ['title', 'start'],
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'Local time, "YYYY-MM-DDTHH:MM". A bare date means an all-day event.' },
        end: { type: 'string', description: 'Local time. Defaults to an hour after start.' },
        location: { type: 'string' },
        notes: { type: 'string' },
        allDay: { type: 'boolean' },
        calendarId: { type: 'string', description: 'Which calendar. Defaults to the default one.' },
      },
    },
    async run(a) {
      const start = need(a, 'start');
      if (!/^\d{4}-\d{2}-\d{2}([T ]\d{1,2}:\d{2}(:\d{2})?)?/.test(start)) {
        throw new Error('start must look like 2026-09-16T14:30 (or 2026-09-16 for an all-day event)');
      }
      const allDay = a.allDay != null ? !!a.allDay : !/[T ]\d/.test(start);
      let end = a.end;
      if (!end && !allDay) {
        const d = new Date(start.replace(' ', 'T'));
        if (isNaN(d)) throw new Error('could not read that start time');
        end = new Date(d.getTime() + 3600000).toISOString().slice(0, 16);
      }
      const r = await api('POST', '/api/calendar/event', {
        title: need(a, 'title'), start, end: end || start,
        location: a.location || '', notes: a.notes || '',
        allDay, calendarId: a.calendarId || undefined,
      });
      return 'On the calendar: ' + a.title + '  ' + start + (r.calendar ? '  [' + r.calendar + ']' : '');
    },
  },

  {
    name: 'update_event',
    write: true,
    description: 'Change an event already on the calendar — move it, rename it, add a location or notes. For a repeating event, pass the occurrence you mean, or the change lands on the first one in the series.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The event id, from list_events.' },
        occurrence: { type: 'string', description: 'Which occurrence of a repeating event — its current start, as returned by list_events.' },
        title: { type: 'string' },
        start: { type: 'string', description: 'Local time, "YYYY-MM-DDTHH:MM".' },
        end: { type: 'string', description: 'Local time.' },
        location: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    async run(a) {
      const body = pick(a, ['title', 'location', 'notes', 'occurrence']);
      ['start', 'end'].forEach((k) => {
        if (a[k] == null) return;
        if (!/^\d{4}-\d{2}-\d{2}([T ]\d{1,2}:\d{2}(:\d{2})?)?/.test(a[k])) {
          throw new Error(k + ' must look like 2026-09-16T14:30');
        }
        body[k] = a[k];
      });
      body.id = need(a, 'id');
      if (Object.keys(body).length === 1) throw new Error('nothing to change');
      const r = await api('PUT', '/api/calendar/event', body);
      return 'Calendar updated: ' + (a.title || r.title || 'that event') + (a.start ? '  → ' + a.start : '');
    },
  },

  // ------------------------------------------------------------------ music
  {
    name: 'play_music',
    write: true,
    description: 'Play something in Spotify without leaving what you are doing. Give it words to search for, or a spotify: URI directly. Needs Spotify set up in the app and the desktop client running.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What to play — a song, an album, a playlist, or a spotify: URI.' },
      },
    },
    async run(a) {
      const q = need(a, 'query');
      let uri = q;
      let said = q;
      if (!/^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/.test(q)) {
        const r = await api('GET', '/api/spotify/search?q=' + encodeURIComponent(q));
        if (r.needsSetup) throw new Error('Spotify is not connected yet — connect it from the Today page first.');
        if (r.error) throw new Error('Spotify search failed: ' + r.error);
        const hit = (r.results || [])[0];
        if (!hit) return 'Nothing on Spotify matches “' + q + '”.';
        uri = hit.uri;
        said = hit.name + (hit.artist ? ' — ' + hit.artist : '');
      }
      const p = await api('POST', '/api/spotify/play?uri=' + encodeURIComponent(uri));
      if (p.needsPermission) throw new Error('macOS has not granted Task Notes permission to control Spotify yet.');
      if (p.supported === false) throw new Error('playback control only works on macOS');
      if (!p.ok) throw new Error('Spotify would not start it — is the desktop app running?');
      return 'Playing ' + said + '.';
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
    const who = (params && params.clientInfo) || {};
    logEvent({
      ts: Date.now(), kind: 'connect', session: SESSION, ok: true,
      client: [who.name, who.version].filter(Boolean).join(' ') || 'unknown',
      protocol: want || null,
    });
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
    const started = Date.now();
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      logEvent({ ts: started, kind: 'call', session: SESSION, tool: String(name), ok: false, ms: 0, err: 'unknown tool' });
      return fail(id, -32602, 'Unknown tool: ' + name);
    }
    try {
      const text = await tool.run((params && params.arguments) || {});
      logEvent({
        ts: started, kind: 'call', session: SESSION, tool: name, ok: true,
        ms: Date.now() - started, write: !!tool.write,
        // The first line of the result already says what changed, in words,
        // with the id in it. That is the audit trail.
        result: String(text).split('\n')[0].slice(0, 200),
      });
      return reply(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      logEvent({
        ts: started, kind: 'call', session: SESSION, tool: name, ok: false,
        ms: Date.now() - started, write: !!tool.write, err: String(e.message || e).slice(0, 240),
      });
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
