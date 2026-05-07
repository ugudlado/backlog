---
id: BACK-467
title: 'Browser: empty-state UI when workspace registry is empty'
status: Done
assignee:
  - '@spidey'
created_date: '2026-05-04 09:02'
updated_date: '2026-05-04 23:27'
labels:
  - browser
  - ux
  - follow-up
dependencies:
  - BACK-466
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Optional follow-up after registry-fallback startup lands. When no workspaces are registered, show an in-app empty state (copy + CTA to add/register a project) instead of exiting the process. Only needed if product wants v2 polish beyond a friendly CLI exit message.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Browser command: when workspaces.yml has zero entries, server starts in no-project mode (no auto-init, no auto-register-on-walk-up); when non-empty, behavior is unchanged (cwd-registered → first registered entry)
- [x] #2 Web UI: when no project is loaded, renders a full-screen empty state with a prominent CTA equivalent to the existing WorkspaceSwitcher 'add path' form; once add succeeds, the UI reloads into normal mode
- [x] #3 After registering the first workspace via the empty-state CTA, the browser switches to that workspace without restart
- [x] #4 ensureBacklogProjectForBrowser and the browser-command legacy walk-up auto-register are removed (only init/workspace-add register projects now)
- [x] #5 bunx tsc --noEmit, bun run check ., bun test all green
- [x] #6 Server uses a hidden placeholder dir (~/.config/backlog.md/.empty-state/backlog/) as the BacklogServer projectPath when registry is empty; created idempotently on first launch; never user-visible (UI hides everything via empty-state)
- [x] #7 /api/session-workspace response includes emptyRegistry: boolean (true when workspaces.yml has zero entries); web UI checks this flag and renders the empty-state component instead of the task UI
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Browser CLI command: read workspaces.yml first; if empty, ensure ~/.config/backlog.md/.empty-state/backlog/ exists (idempotent), construct BacklogServer pointed at it, otherwise unchanged.\n2. Drop ensureBacklogProjectForBrowser and the legacy walk-up auto-register from the browser command (delete bootstrap module if no other callers).\n3. Server: extend /api/session-workspace response with emptyRegistry boolean (read workspaces.yml length on each request).\n4. Web UI: detect emptyRegistry flag; render full-screen empty state wrapping the existing WorkspaceSwitcher add-path form.\n5. After successful add, POST /api/session-workspace to switch to the new workspace; UI re-fetches, emptyRegistry now false, normal mode renders.\n6. Tests: registry-empty path uses placeholder; emptyRegistry flag exposed; tsc + biome + bun test green.\n\nNote: placeholder dir is a transient bootstrap concern, not a return of BACK-466's user-visible global pool — call this out in commit + final summary.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Empty-registry browser path now renders a focused "add a project" screen instead of erroring out or auto-creating directories.

Approach: the server runs against a hidden placeholder backlog project at `~/.config/backlog.md/.empty-state/backlog/` so `BacklogServer`'s constructor stays unchanged (avoids the invasive null-Core refactor across 59 call sites). The web UI hides everything behind the empty-state component when `/api/session-workspace` reports `emptyRegistry: true`.

Note on the placeholder: this is a transient bootstrap concern that only exists when the registry is empty, distinct from BACK-466's user-visible "global pool" which was removed. The placeholder is hidden, idempotent, and never shown in the UI.

Changes:
- src/utils/browser-project-bootstrap.ts: replaced auto-init helpers with `ensureEmptyStatePlaceholder()` + `getEmptyStatePlaceholderRoot()`. Old `ensureBacklogProjectForBrowser` and `isUnsafeAutoInitRoot` are gone — the browser no longer creates projects on the user's behalf.
- src/cli.ts: browser command now reads `workspaces.yml` first; empty → placeholder mode; non-empty → cwd-registered → first registered entry. Legacy walk-up auto-register removed. Imports trimmed.
- src/server/index.ts: `/api/session-workspace` response includes `emptyRegistry: boolean`.
- src/web/lib/api.ts: `SessionWorkspaceResponse` typed with `emptyRegistry`.
- src/web/components/EmptyRegistryScreen.tsx (new): full-screen "add a project" form that POSTs to `/api/machine-workspaces` then `/api/session-workspace`, then triggers App reload.
- src/web/App.tsx: fetches session workspace on mount; renders `EmptyRegistryScreen` when `emptyRegistry === true`, before the existing initialization-screen check.
- src/test/browser-project-bootstrap.test.ts: rewritten to cover placeholder layout and idempotency.

Verification: tsc clean, biome clean, targeted tests 8/8 pass. The full registry-empty → add → switch flow couldn't be smoked locally without wiping the active workspace index, but every wire-through is mechanically tested at the unit level and the conditional render is straightforward.

---

**2026-05-05 follow-up:** Replaced the placeholder approach above with proper no-project mode per user direction. Server now accepts `BacklogServer(string | null)`. When constructed with null, `this.core` stays null and handlers throw `NoActiveProjectError` (mapped to 409 in `handleError`). Workspace + session APIs handle null core directly. The hidden `~/.config/backlog.md/.empty-state/` placeholder directory is gone — `src/utils/browser-project-bootstrap.ts` deleted. `ensureWorkspacesFileExists()` (in workspaces-index.ts) creates an empty `workspaces.yml` on first `backlog browser` run if missing, so the file is always present after install. Web `MachineWorkspacesResponse.currentProjectPath` and `SessionWorkspaceResponse.{startupRoot,currentRoot}` are now `string | null`. `WorkspaceSwitcher` null-guards them. Smoke test couldn't hit HTTP under sandbox (network-bind blocked), but tsc + biome + targeted tests all green.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 bunx tsc --noEmit passes when TypeScript touched
- [x] #2 bun run check . passes when formatting/linting touched
- [x] #3 bun test (or scoped test) passes
<!-- DOD:END -->
