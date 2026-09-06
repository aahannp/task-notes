<div align="center">

# Task Notes

**A local-first personal operating system for your work — tasks, projects, learning, ideas, and a weekly review that tells you what actually happened.**

Runs entirely on your machine. Plain JSON files. No account, no cloud, no telemetry.

macOS desktop app · zero runtime dependencies · single-file frontend

</div>

<br>

![Today](docs/screenshots/today.png)

<br>

## Why this exists

Most productivity apps are one CRUD list wearing six different hats. This one is built around the idea that you think about your work in genuinely different ways:

|  | answers |
|---|---|
| **Tasks** | What do I need to **do**? |
| **Projects** | What am I trying to **accomplish**? |
| **Learning** | What do I want to **understand**? |
| **Ideas** | What might I **pursue**? |
| **Calendar** | **When** — and in what context? |
| **Weekly Review** | What actually **happened**? |

They aren't separate apps bolted together. A task belongs to a project, references something you're learning, and shows up in the weekly review — and it's the same underlying record everywhere you look at it.

<br>

## The Learning Bag

The part I'm most fond of. You constantly run into things you realise you don't properly understand — *"I should really know how mutexes work."* You don't want a task. You want to throw it in a bag and get to it.

So the bag is an actual bag. Chips sit inside it at slightly odd angles, they shift as you move your cursor through them, and clicking one animates it out of the bag and into today's learning.

![Learning Bag](docs/screenshots/learning-bag.png)

Hover anything for a preview — you shouldn't need to open a modal just to remember what a thing was.

![Learning item preview](docs/screenshots/learning-hover.png)

**Pull one for today** picks for you with a light weighting — never studied, overdue, high priority, and how long it's been sitting all count, plus a little randomness — so the bag doesn't quietly become a graveyard. Starting a topic opens a **learning session** that tracks time, notes and what you actually understood. Nothing is ever auto-marked "Learned"; that stays your call.

Every item keeps the full detail behind it: what you want to understand, why you added it, context, source, priority, status, tags, notes, related project, related tasks, time spent, last studied.

Prefer not to rummage? There's a plain list view, every chip is keyboard-reachable, and `prefers-reduced-motion` turns the physics off while keeping the whole workflow.

<br>

## Projects that know their own progress

Progress is computed from real tasks — never a number you typed in.

![Projects](docs/screenshots/projects.png)

Each project opens into a command center: progress, completed/remaining/blocked, time spent (derived from focus sessions), its tasks grouped by status, the learning topics it depends on, notes, and a history of what happened.

![Project detail](docs/screenshots/project-detail.png)

<br>

## Ideas → Projects

Ideas are for thoughts you haven't committed to. Capture fast, expand later, and when one earns it, convert it into a project — carrying its description, notes and tags across instead of leaving you with a blank page.

![Ideas](docs/screenshots/ideas.png)

<br>

## Weekly Review

One page you look at once a week. Focus time, tasks completed, projects that moved (and by how much), what you learned, work vs personal split, and the flow through your learning bag — all from real data.

![Weekly Review](docs/screenshots/weekly-review.png)

Past weeks are **snapshotted** the first time you view them after they end, so history stays honest instead of quietly rewriting itself as your current data changes. Your written reflections — what went well, what didn't, what's next — persist per week and stay editable forever.

<br>

## Focus

A full-screen focus mode with pause/resume, a daily goal ring, and a session log. Sessions can be tagged to a task or a project, which is where project time-spent comes from.

![Focus](docs/screenshots/focus.png)

On macOS, starting a focus session also opens a small **always-on-top companion window** so the timer stays with you while you work in your editor:

```
┌──────────────────────────┐
│ ● FOCUSING               │
│         42:18            │
│  🎧 Bloody Samaritan     │
│    ⏸    ■    ⏮ ▶ ⏭      │
└──────────────────────────┘
```

It's the *same* session — one timer, one music player. Pause in the mini window and the main app pauses; resume in the app and the mini window follows. It remembers where you put it, survives app reloads, and because the timer is derived from timestamps rather than ticks, it stays correct across sleep/wake.

<br>

## Calendar & day context

Mark days as working, off, vacation or holiday; track home vs office and login/logout. The rest of the app uses that context — for example, Learning nudges you more gently on days you actually have room to breathe.

![Calendar](docs/screenshots/calendar.png)

<br>

## Every task, everywhere

The board is where you work a single day. The Tasks page is every task you have, across every day — grouped by date, filterable by state and project, and showing what each one is attached to.

![Tasks](docs/screenshots/tasks.png)

<br>

## Everything else

- **Kanban board** — To Do / In Progress / Blocked / Finished, drag between columns, confetti when you finish something
- **Carry-forward** — unfinished tasks follow you to the next day, with a carry count so you notice what keeps slipping
- **Global task view** — every task across every day, filterable by state and project
- **Estimates vs actuals** — estimate a task, then see it against the time you actually focused
- **Spotify control** — play/pause, skip, volume, seek and search-and-play against the desktop app (optional)
- **Search, keyboard shortcuts, and a motion language** that's meant to be felt more than noticed

<br>

## Running it

Requires Node.js. There are no dependencies to install for the server.

```bash
node server.js
```

Then open <http://localhost:4321>.

### Build the macOS app

```bash
npm install
npm run dist
```

That produces `dist-app/Task Notes-<version>-arm64.dmg`. The build is unsigned, so the first launch needs right-click → Open.

<br>

## Your data

Everything lives in `data/`, which is git-ignored:

| file | holds |
|---|---|
| `YYYY-MM-DD.json` | that day's tasks |
| `YYYY-MM-DD.meta.json` | that day's login/logout, location, day type, focus sessions, today's learning |
| `projects.json` | projects |
| `learning.json` | the learning bag |
| `ideas.json` | ideas |
| `activity.json` | the activity log that feeds project history and the weekly review |
| `reviews.json` | weekly reflections and frozen week snapshots |

Plain JSON you can read, back up, grep, or edit by hand. The desktop app stores it in `~/task-notes/data`; set `TASKNOTES_DATA` to point it somewhere else.

Nothing leaves your machine. The only outbound calls are the ones Spotify makes if you choose to use it.

<br>

## Keyboard shortcuts

| key | |
|---|---|
| `N` | add a task |
| `/` | search |
| `F` | focus mode |
| `T` `P` `L` `I` `W` | Tasks · Projects · Learning · Ideas · Weekly Review |
| `C` | calendar |
| `←` `→` | previous / next day |
| `Esc` | close whatever's open |

<br>

## Architecture

Deliberately small and boring so it stays hackable:

- **`server.js`** — a zero-dependency Node HTTP server. Serves the frontend and a small JSON API over the files above.
- **`public/index.html`** — the entire frontend. One file: markup, styles and logic.
- **`main.js` / `preload.js`** — the Electron shell for the macOS app and the Focus companion window, talking over a tiny explicit IPC bridge.

<br>

## License

MIT
