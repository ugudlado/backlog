---
id: BACK-471
title: 'Workspace registry hardening: locking, doctor, and MCP parity'
status: To Do
assignee: []
created_date: '2026-05-07 15:45'
labels:
  - registry
  - mcp
  - reliability
dependencies: []
priority: high
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
~/.config/backlog.md/workspaces.yml is a brand-new shared-mutable file that the daemon and every CLI in every checkout can write concurrently — but writeWorkspacesIndex doesn't use the existing Lockfile pattern that single-repo task storage uses. Plus there's no drift-repair story when entries point at moved/deleted/renamed dirs, and MCP has no awareness of the registry at all (CLI + Web UI have it; agents don't). Project rule 'keep behavior consistent across similar stores (defaults, parse errors, locking)' is currently violated. Fix the three together before more surfaces bake in assumptions about an unrepairable, lock-less registry.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 writeWorkspacesIndex acquires the existing Lockfile around read-modify-write so daemon + CLI writes are serialized
- [ ] #2 Lockfile contention has a tested timeout + clear error; concurrent test exercises two writers
- [ ] #3 'backlog workspace doctor' scans every entry and reports: missing path, non-git path, path with no backlog/ subdir, duplicate paths, current-workspace pointer pointing at a removed entry
- [ ] #4 'backlog workspace doctor --fix' prunes broken entries (with a y/N prompt unless --yes); preserves entries that pass
- [ ] #5 MCP exposes workspace_list and workspace_switch tools mirroring the CLI; tool schemas documented in MCP server
- [ ] #6 Agent-instruction templates (CLAUDE.md, AGENTS.md, .cursorrules) describe the registry and the workspace_list/workspace_switch MCP tools
- [ ] #7 bunx tsc --noEmit, bun run check ., bun test all green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 bunx tsc --noEmit passes when TypeScript touched
- [ ] #2 bun run check . passes when formatting/linting touched
- [ ] #3 bun test (or scoped test) passes
<!-- DOD:END -->
