# The task-notes-sync skill

A Claude Code skill that keeps this app current with what you are actually
working on, without you having to remember to write anything down. It watches
the conversation you are already having and records what is durable: a learning
becomes a document, a piece of work becomes a project, a concrete next step
becomes a task. It dedupes against what is already there, and stays silent when
nothing qualifies — which is most turns.

It reaches the app through the MCP server in `mcp/`, so the app has to be
running and the MCP server registered (see the README).

## Files

| file | role |
|---|---|
| `task-notes-sync/SKILL.md` | the judgement — what counts, the dedup rules, which tool to use, and when to say nothing |
| `task-notes-sync-reminder.sh` | the one-line nudge the hook emits before each turn |

## Installing it

```bash
mkdir -p ~/.claude/skills ~/.claude/scripts
cp -R skills/task-notes-sync ~/.claude/skills/
cp skills/task-notes-sync-reminder.sh ~/.claude/scripts/
chmod +x ~/.claude/scripts/task-notes-sync-reminder.sh
```

Then add the hook to `~/.claude/settings.json`, keeping whatever is already
there:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "~/.claude/scripts/task-notes-sync-reminder.sh" } ] }
    ]
  }
}
```

The hook fires on every prompt and costs one line of context. The skill itself
is only pulled in when there is something worth recording.

Without the hook the skill still works — ask for it by name, or say
"update my task notes".
