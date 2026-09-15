#!/usr/bin/env bash
# UserPromptSubmit hook: fires before each response. Emits a terse reminder so
# Claude keeps the user's task-notes app in sync with their learnings/projects.
# The stdout below is injected as context for the turn. Keep it short — the
# detailed rules live in the `task-notes-sync` skill, pulled in only when there
# is actually something to record.
cat <<'EOF'
[task-notes auto-sync] Before finishing this turn, glance back over the recent exchange. If the user has (a) learned something durable worth keeping, (b) started or advanced a project, or (c) surfaced a concrete task, quietly record it by invoking the `task-notes-sync` skill (which handles classification and dedup against existing notes/projects/tasks). If nothing genuinely new and durable qualifies, do nothing and say nothing about task-notes. This must never delay or dilute your actual answer to the user.
EOF
