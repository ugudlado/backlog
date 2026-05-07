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
  - registry
  - storage
  - workspaces
  - breaking-change
  - git-history
dependencies:
  - BACK-471
priority: high
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today every repo carries its own backlog/ folder; tasks live alongside code. This causes two problems: (1) every status flip becomes a noisy bookkeeping commit ('BACK-123 mark Done', 'BACK-456 update plan') that pollutes the code repo's log, and (2) tasks for cross-cutting work have nowhere natural to live.\n\nMove tasks to a single shared store at ~/.config/backlog.md/backlog/ that holds tickets for every registered project, each task carrying a 'project:' field that names its workspace. The shared store has its OWN git repository (~/.config/backlog.md/backlog/.git) so task history is preserved as a separate audit trail — task edits no longer touch any code repo's git log. The workspace registry from BACK-468 already gives us the project namespace; this ticket extends it from a list-of-repos pointer into the canonical task home.\n\nThis is a breaking change to the on-disk model. Must include a one-shot migration that walks every workspaces.yml entry, copies tasks into the central store with project tags, initializes the central git repo, and either keeps the per-repo backlog/ in place (read-only) or removes it (user-chosen). Ticket-id namespacing across projects must be decided up front.\n\nImpacts: src/core/backlog.ts (load/save paths), src/utils/workspaces-index.ts (project metadata), src/server/index.ts (multi-project queries), src/web/ (project filter + 'All Projects' view), all CLI commands that resolve a project root, MCP server task tools, plus a new git-write layer that auto-commits task changes to the central .git. Depends on BACK-471 (registry hardening: locking + doctor) so the central store is durable under concurrent writes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Decision recorded for task-ID namespace: either (a) global monotonic IDs (BACK-001, BACK-002, ...) ignoring project, or (b) per-project prefix (REPOA-001, REPOB-001, ...) keyed off the workspace name. Decision lives in spec/decisions/ before implementation starts
- [ ] #2 ~/.config/backlog.md/backlog/ becomes the canonical task store: tasks/, drafts/, docs/, decisions/, milestones/, completed/ all live here once and only once
- [ ] #3 Central store is initialized as a standalone git repo on first run (~/.config/backlog.md/backlog/.git); never tied to any code repo's git
- [ ] #4 Every task write (create, edit, archive, status flip) is auto-committed to the central .git with a message like 'BACK-123 status: To Do -> In Progress' — no user-facing git step
- [ ] #5 Auto-commit can be disabled via config flag (e.g. taskGit.autoCommit: false in ~/.config/backlog.md/config.yml) for users who prefer manual snapshots
- [ ] #6 Code repo workflow no longer requires backlog commits: removing per-repo backlog/ leaves the code repo's git log free of task bookkeeping; existing 'BACK-123 - title' commit-message convention is preserved for code commits that reference tasks
- [ ] #7 Every task file (frontmatter) carries 'project: <workspace-name>' identifying which registered workspace it belongs to
- [ ] #8 All read paths (CLI list, search, MCP tools, server endpoints, web UI) filter by 'project:' resolved from cwd via workspaces.yml when scoped, or aggregate across all projects when --all / 'All Projects' is selected
- [ ] #9 All write paths (task create, edit, archive, draft, milestone) write to the central store with the project tag derived from the resolving workspace; per-repo backlog/ is no longer written to
- [ ] #10 'backlog migrate centralize' command walks every workspaces.yml entry, copies its backlog/ into the central store with project tags applied, handles ID collisions per the chosen namespace strategy, initializes the central .git, and prints a per-workspace report
- [ ] #11 Migration is idempotent and reversible: re-running is a no-op; 'backlog migrate centralize --dry-run' prints planned changes without writing
- [ ] #12 After migration, per-repo backlog/ folders are kept as a read-only archive by default; '--prune' flag deletes them after user confirmation; 'backlog migrate decentralize' restores per-repo layout from the central store if the user wants to revert
- [ ] #13 Web UI gains a project filter (chip-style or dropdown) and an 'All Projects' aggregate view; current WorkspaceSwitcher behavior is preserved as a 'scope to one project' shortcut
- [ ] #14 MCP task tools accept an optional 'project' parameter; when omitted in a registered cwd, defaults to that workspace; documented in tool schemas
- [ ] #15 Agent-instruction templates updated (folds into BACK-472) to describe the shared store + project tags + cross-project queries + the central git audit trail
- [ ] #16 Documentation: covers the on-disk layout change, migration steps, rollback, the central git repo (where it lives, how to push it to a remote for multi-machine sync), and how task history is now decoupled from code history
- [ ] #17 Tests cover: migration with collision (both namespace strategies), idempotent re-run, --dry-run, decentralize rollback, scoped read by cwd, aggregate read, write-routing-by-cwd, auto-commit on task write, autoCommit:false suppresses commits, MCP project parameter, and a regression that legacy single-repo backlog/ still works for unmigrated users
- [ ] #18 bunx tsc --noEmit, bun run check ., bun test all green
<!-- AC:END -->































## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 bunx tsc --noEmit passes when TypeScript touched
- [ ] #2 bun run check . passes when formatting/linting touched
- [ ] #3 bun test (or scoped test) passes
<!-- DOD:END -->
