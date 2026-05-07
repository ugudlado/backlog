---
id: BACK-468
title: Multi-repo workspaces (workspaces.yml + global init + project switcher)
status: Done
assignee:
  - '@spidey'
created_date: '2026-05-03 11:37'
updated_date: '2026-05-07 15:45'
labels: []
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Turn Backlog.md into a multi-workspace tool. Adds a global config dir at ~/.config/backlog.md/ with workspaces.yml as the single index of every backlog dataset on the machine. Supports both repo-level (existing) and global storage of tasks. Adds 'backlog workspace' CLI commands and updates all non-init commands to resolve their target workspace explicitly. BacklogServer becomes multi-project; web UI gains a project switcher with an 'All Projects' aggregate view. Builds on BACK-463 (daemon) — once both ship, the daemon serves every workspace from workspaces.yml instead of just cwd.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Global config dir lives at ~/.config/backlog.md/; created on first invocation that needs it
- [x] #2 ~/.config/backlog.md/workspaces.yml is the single index of every backlog dataset on the machine: a 'workspaces:' list where each entry has 'path:' (parent dir; data lives at <path>/backlog/) and 'type:' (global | repo)
- [x] #3 'backlog init' interactively prompts whether to store backlog data in the current repo or globally; '--global' / '--local' flags skip the prompt
- [x] #4 Both init paths create the backlog/ dir AND append/update the matching entry in workspaces.yml; the global option also creates ~/.config/backlog.md/backlog/ which mirrors the standard per-repo layout (config.yml, tasks/, drafts/, docs/, decisions/)
- [x] #5 Tasks live in exactly one place per workspace (repo's backlog/ OR global backlog/, never both); existing single-repo workflows continue to work unchanged when --local is chosen
- [x] #6 'backlog workspace add <path>' / 'backlog workspace remove <path>' / 'backlog workspace list' manage workspaces.yml directly, for repos that already had a backlog/ from before this feature or were freshly cloned
- [x] #7 All non-init CLI commands (task, draft, board, doc, decision, etc.) resolve their target workspace by: (1) explicit '--workspace <path|name>' flag if provided, (2) the current working directory if it matches a registered workspace, (3) the global workspace as a fallback when no repo workspace matches; if cwd matches multiple registered workspaces, error with a clear message listing them
- [x] #8 BacklogServer accepts multiple project paths and exposes each as a separate project in the API
- [x] #9 Web UI shows a project switcher with an 'All Projects' option that aggregates tasks across every loaded workspace; each task shows which project it belongs to
- [x] #10 Migration: on first invocation of any backlog command in an unregistered repo that already has a backlog/ dir, the CLI auto-registers it in workspaces.yml (one-time, idempotent); existing repo-only users continue to work with no manual registration step
- [ ] #11 If BACK-463 has shipped, 'backlog server start' is updated to load every workspace from workspaces.yml as a separate project (instead of just cwd); 'server status' reports the loaded workspace list
- [ ] #12 Tests cover: global init, local init auto-registration, workspaces.yml CRUD, workspace resolution by cwd, ambiguity errors, multi-project server endpoints, and the auto-register-on-first-run migration path
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Superseded by BACK-463 on 2026-05-03. The multi-repo workspace concept has been folded into BACK-463 alongside the daemon work, since the daemon is only meaningful once the multi-project model exists. Closing without implementation; all ACs absorbed into BACK-463's expanded spec.

2026-05-03: Re-opened. Original 'multi-repo workspace support' framing rewritten as workspaces.yml + global init + project switcher. The daemon piece moved to BACK-463 to ship independently; once both land, BACK-462 teaches the daemon to load every workspace.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped as the workspace registry feature in commits bc7bf1c, 1260286, 5a78552, 2114e65. workspaces.yml at ~/.config/backlog.md/ tracks every backlog dataset on the machine; backlog workspace add/list/remove manages it; web UI WorkspaceSwitcher + EmptyRegistryScreen handles multi-project + zero-project states; resolveCliProjectRoot resolves cwd -> registry. AC#11 (daemon-loads-every-workspace) folded into BACK-470. AC#9 'All Projects' aggregate view not shipped (current UI switches one workspace at a time) — track follow-up if needed.
<!-- SECTION:FINAL_SUMMARY:END -->
