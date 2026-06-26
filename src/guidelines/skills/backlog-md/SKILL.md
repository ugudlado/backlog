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

- The CLI is the interface. Never edit task `.md` files directly — always go
  through `backlog task ...` commands.
- Projects live in a configured **global store** (`globalStore` in
  `~/.config/backlog/config.yml`), one slot per project keyed by name. Create
  with `backlog init <name>` or `backlog project create <name>`.
- If the repo has CLAUDE.md or AGENTS.md, read those first; they contain the
  full backlog.md command reference.
- If they are missing, run `backlog agents --update-instructions` (or
  `backlog init <name>` for a fresh project) to install them.
- Select the project to act on: `backlog project list`, `backlog project switch
  <name>`, or `--project <name>` per command. Without it, commands use the
  current project.
- The web UI runs in the foreground via `backlog server`, or as a background
  service: `backlog service start` on macOS (launchd), or the systemd recipe on
  Linux. See SERVICE.md in the backlog.md repo for the full Linux/Windows setup
  and the `scripts/service-{linux,macos}.sh` helpers.
- A running server can create a project without shell access:
  `POST /api/projects {"name": "My Project"}`.

## When to invoke

Trigger on user phrases like "manage backlog tasks", "list backlog tasks",
"create a backlog task", "open the backlog UI", or "switch backlog projects".

## Discovery

Run `backlog --help` for the full CLI surface, or read the in-repo
CLAUDE.md / AGENTS.md for the canonical workflow guide.
