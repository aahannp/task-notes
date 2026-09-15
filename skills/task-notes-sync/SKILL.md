---
name: task-notes-sync
description: Keep the user's task-notes app in sync with what they are learning and working on. Invoked automatically (via the UserPromptSubmit hook) before each response, and manually with phrases like "update my task notes", "log this learning", "sync task-notes", "capture this to task notes". Reviews the recent exchange and records genuinely durable learnings (as documents), new/advancing projects, and concrete tasks — deduping against what already exists — using the task-notes MCP. Stays silent when nothing qualifies.
---

# Task-notes sync

Keep the user's **task-notes** app current with two things they care about:
their **learnings** and their **projects** (plus concrete tasks that fall out of
the work). This runs quietly in the background of normal work — it must never
delay, dilute, or distract from the user's actual request.

## The prime directive: be selective and silent

Most turns record **nothing**. Only capture something that is **durable and
genuinely new** — something the user would be glad to find in their notes next
week. When in doubt, don't.

- **Never narrate the assessment.** If nothing qualifies, do nothing and say
  nothing about task-notes at all.
- **When you do record something**, add at most one short line at the very end
  of your response: `📝 task-notes: <what you logged>` — never a paragraph.
- **Answer the user first.** The sync is secondary to whatever they actually
  asked; do it before or after the substantive answer, but it never crowds it out.
- **Cap it:** at most ~2 writes per turn. This is a journal, not a firehose.

## What counts (and where it goes)

Classify the new, durable thing and use the matching tool:

| The thing | Tool | Notes |
|---|---|---|
| A concept the user learned / studied (a language feature, a pattern, an arch idea) | `write_document` | A learning note. Title = the concept. See dedup below. |
| A new initiative / area of work | `add_project` | Only if not already in `list_projects`. |
| Meaningful progress on existing work | `write_document` (append to that project's status doc) or `update_task` | Keep the record moving, don't duplicate. |
| A concrete to-do the user named ("I need to X", "next I'll Y") | `add_task` | Attach `projectId` when it maps to a known project. |
| A loose thought / link worth keeping, not yet actionable | `capture` | Goes to the Inbox for the user to sort. |
| Something to return to on a specific day | `add_backlog` | With `pickupDate`. |

Prefer **documents for learnings** and **projects/tasks for work** — that mirrors
how the user already organises the app (e.g. docs like "Channels in go", "side
car envoy pattern"; projects like "S2S", "upi proxy layer").

## Dedup — always check before you write

The whole value is a clean, non-repetitive record. Before writing:

1. **Learnings** → `list_documents` with `q=<topic>`. If a note on that topic
   exists, `read_document` it and **append** the new detail (mode `append`)
   instead of creating a second note. Only create a new document when the topic
   is genuinely new.
2. **Projects** → `list_projects`. Reuse the existing `projectId`; never create a
   near-duplicate project.
3. **Tasks** → glance at `list_tasks` for today. Don't re-add a task that's
   already on the board; if it exists and has advanced, `update_task` its status.

## What NOT to capture

- Routine mechanics of the work (individual edits, build/test runs, commits) —
  unless the user explicitly frames one as a takeaway.
- Your own explanations that the user didn't engage with or act on.
- Anything already recorded (see dedup).
- Transient chit-chat, acknowledgements, or clarifying back-and-forth.
- Secrets, tokens, credentials, or PII — never write these anywhere.

## Writing style for entries

- **Learning documents:** a clear title (the concept), then a few tight bullets
  in the user's own framing — what it is, why it matters, the one thing that
  clicked. Short. Link related notes by title if obvious.
- **Tasks:** start with a verb, be specific enough to act on later.
- **Projects:** `name` + a one-line `desc` of what success looks like.

## Manual invocation

When the user says something like "log that", "save this to my notes", "add a
task for X", or "update task-notes" — do exactly that, skipping the selectivity
gate (they've asked explicitly), still deduping.
