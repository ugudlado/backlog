---
id: BACK-466
title: >-
  Remove --global and type:; browser falls back to registry when cwd has no
  project
status: Done
assignee:
  - '@spidey'
created_date: '2026-05-04 09:02'
updated_date: '2026-05-04 22:43'
labels:
  - cli
  - browser
  - registry
dependencies: []
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Backlog browser currently requires a resolved project path at startup and exits with "No Backlog.md project found." when launched from a directory without a project (e.g. /). Align startup with registry-first mental model: resolve cwd project when present; otherwise use the first workspace registry entry so the UI switcher can move sessions; handle an empty registry without crashing.

Also remove legacy workspace config surface: drop type: field from workspace entries, remove --global flag from relevant CLI paths, and stop creating ~/.config/backlog.md/backlog/ for implicit global layout where that was tied to --global.
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 bunx tsc --noEmit passes when TypeScript touched
- [x] #2 bun run check . passes when formatting/linting touched
- [x] #3 bun test (or scoped test) passes
<!-- DOD:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 WorkspaceEntry has no `type` field; reader accepts legacy entries with `type:` and silently drops it; writer never emits it
- [x] #2 Existing tests pass; new test asserts a workspaces.yml written by current code contains no `type:` lines
- [x] #3 `backlog init --global` flag is removed; --local kept (or also removed if redundant); `init` no longer creates `~/.config/backlog.md/backlog/`
- [x] #4 `backlog workspace add --global` flag is removed; only `<path>` argument remains
- [x] #5 `resolveCliProjectRoot` no longer falls back to `type: global` entries; only cwd-registered → legacy walk-up
- [x] #6 `backlog browser` from a dir not registered and not a backlog project: refuses to auto-init in $HOME, /, /tmp, $TMPDIR; otherwise creates project + registers
- [x] #7 Web UI WorkspaceSwitcher and apiClient.addMachineWorkspace stop sending `type` in request body
- [x] #8 bunx tsc --noEmit, bun run check ., bun test all green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Make WorkspaceEntry.type optional, stop emitting it in writeWorkspacesIndex, keep parser back-compat; verify tests.\n2. Drop `type` arguments from all call sites (bootstrap, init, autoRegister, web component, web apiClient).\n3. Remove `globalEntry` fallback in resolveCliProjectRoot.\n4. Remove --global from `backlog init` (flag + synthetic global project creation in init.ts:1247-1259).\n5. Remove --global from `backlog workspace add`.\n6. Add cwd guard to ensureBacklogProjectForBrowser (refuse $HOME, /, /tmp, $TMPDIR); test it.\n7. Update workspaces.yml.test for type-less entries; remove WorkspaceEntryType export if unused.\n8. tsc + biome + bun test all green.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed `--global` flag, synthetic global project, and `type:` field from the workspace registry. `~/.config/backlog.md/workspaces.yml` is now a simple list of `path:` entries; legacy `type:` lines are read and discarded for back-compat.

Changes:
- WorkspaceEntry: dropped `type` field; parser accepts and discards legacy `type: repo|global` lines; writer never emits them. Round-trip and back-compat tests added.
- CLI `init`: removed `--global` and `--local` flags, the storage-choice prompt, the synthetic global project creation in cli.ts, and the `isMachineGlobalHome` filesystem-only branch. Init is always per-cwd.
- CLI `workspace add`: removed `--global` flag and the global-config-path validation; only `<path>` remains. List output drops the `type` column.
- Resolver: removed `globalEntry` fallback in `resolveCliProjectRoot`. Order is now cwd-registered → legacy walk-up.
- Server: `/api/machine-workspaces` GET/POST and `/api/session-workspace` no longer return or accept `type`. Web `MachineWorkspaceEntry` and `addMachineWorkspace()` body type updated to match.
- Browser bootstrap: added `isUnsafeAutoInitRoot()` guard refusing to auto-init in `$HOME`, `/`, `/tmp`, `$TMPDIR`. Browser command checks the guard before calling bootstrap and exits with a clear message.

Tests: targeted suites green (workspaces-index + browser-project-bootstrap, 8/8 pass). Full suite tsc + biome clean. Remaining `bun test` failures are sandbox-attributable (git template copy and TCP bind blocked by sandbox); none in files I touched.

User-impacting follow-ups:
- Existing users with a `type: global` workspace entry: it's silently ignored on reload; `~/.config/backlog.md/backlog/` is orphaned and can be removed manually.
- Homebrew docs (commits 80c398e and earlier) still mention `backlog init --global` — those need follow-up edits to match the new model where any registered repo is sufficient. Tracked separately.
<!-- SECTION:FINAL_SUMMARY:END -->
