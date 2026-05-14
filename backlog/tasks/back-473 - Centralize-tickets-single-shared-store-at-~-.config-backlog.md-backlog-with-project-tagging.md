---
id: BACK-473
title: >-
  Centralize tickets: shared store with own git history, decoupled from code
  repos
status: To Do
assignee: []
created_date: '2026-05-07 20:01'
updated_date: '2026-05-07 20:09'
labels:
  - storage
  - workspaces
  - opt-in
dependencies: []
priority: high
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today every repo carries its own backlog/ folder, mixing task bookkeeping commits into the code repo's git log. This ticket makes the store location configurable so users can opt out of that coupling.

**Model:**
- Default (no config change): existing per-repo `backlog/` behavior is unchanged — zero breaking change.
- Opt-in: set `globalStore: ~/.config/backlog` (or any path) in `~/.config/backlog.md/config.yml`. Backlog then routes all reads/writes to `<globalStore>/<repo-name>/` where `repo-name` is `basename` of the git root.
- Git history for the external store is the user's responsibility — they can `git init` the directory if they want an audit trail. Backlog does not manage it.

**Layout example:**
```
~/.config/backlog/
  backlog.md/     ← tickets for this repo
  myapp/          ← tickets for another repo
```

**No migration required.** Users who opt in start fresh in the global store; existing per-repo `backlog/` is left untouched and still readable if the user switches back.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `globalStore` config key accepted in `~/.config/backlog.md/config.yml`; when absent, behavior is identical to today
- [ ] #2 When `globalStore` is set, all read/write paths resolve the backlog root as `<globalStore>/<basename(git-root)>/` instead of `<git-root>/backlog/`
- [ ] #3 `backlog init` with `globalStore` set creates `<globalStore>/<repo-name>/` and initializes the store there; does not touch the code repo's git
- [ ] #4 All CLI commands (list, create, edit, search, archive, etc.), MCP tools, and server endpoints work correctly against the global store path
- [ ] #5 No data is auto-migrated; existing per-repo `backlog/` is untouched when user opts in
- [ ] #6 Config docs and `backlog config list` output describe the `globalStore` key
- [ ] #7 Tests cover: globalStore set → reads/writes go to external path; globalStore unset → reads/writes go to per-repo path; missing external dir gives a clear error
- [ ] #8 bunx tsc --noEmit, bun run check ., bun test all green
<!-- AC:END -->































## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 bunx tsc --noEmit passes when TypeScript touched
- [ ] #2 bun run check . passes when formatting/linting touched
- [ ] #3 bun test (or scoped test) passes
<!-- DOD:END -->
