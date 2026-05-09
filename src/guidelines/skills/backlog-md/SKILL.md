---
name: backlog-md
description: |
  Manage tasks, plans, and project state with backlog.md (a CLI + MCP task
  management tool). Use when the user asks to create, list, or edit tasks,
  run the backlog web UI, or work with multiple backlog projects.
---

# backlog-md

You are working in a repo (or environment) where backlog.md may be installed
as the task management system.

## Quick rules

- The CLI is the interface. Never edit `backlog/tasks/*.md` files directly —
  always go through `backlog task ...` commands.
- If the repo has CLAUDE.md or AGENTS.md, read those first; they contain the
  full backlog.md command reference.
- If they are missing, run `backlog agents --update-instructions` (or
  `backlog init` for a fresh repo) to install them.
- For multi-project setups, use `backlog workspace list --plain`.
- The web UI runs in the foreground via `backlog server`, or as a macOS
  launchd daemon via `backlog service start`.

## When to invoke

Trigger on user phrases like "manage backlog tasks", "list backlog tasks",
"create a backlog task", "open the backlog UI", or "switch backlog projects".

## Discovery

Run `backlog --help` for the full CLI surface, or read the in-repo
CLAUDE.md / AGENTS.md for the canonical workflow guide.
