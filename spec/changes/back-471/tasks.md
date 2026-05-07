# Tasks: Workspace Registry Hardening — Locking, Doctor, MCP Parity

- [x] T-1 Write tests: `withRegistryLock` cross-process serialisation + lock-timeout error (RED — tests must fail)
  - **Why**: AC-1, AC-2 (FR-1, FR-2, FR-3, NFR-4). Must spawn two child Bun processes that each call `upsertWorkspaceEntry` against a shared `BACKLOG_MACHINE_CONFIG_DIR` and assert both entries land. Second test: hold the lock manually, call `withRegistryLock` with `timeoutMs: 50`, assert `EREGISTRYLOCK` thrown.
  - **Verify**: `bun test src/test/workspace-registry-lock.test.ts` runs and FAILS for the right reason — `withRegistryLock` does not yet exist / both writers race.

- [x] T-2 Implement: `withRegistryLock`, `EREGISTRYLOCK`, `getRegistryLockPath`; route `upsertWorkspaceEntry` / `removeWorkspaceEntry` / `setCurrentWorkspaceId` / `readWorkspacesWithIds` migration write through it (GREEN) (depends: T-1)
  - **Why**: AC-1, AC-2 (FR-1, FR-2, FR-3, NFR-1). Mirror `FileSystem.withCreateLock` shape: `proper-lockfile`, `stale: 10_000`, `factor: 1`, `retries.minTimeout: 100`, `timeoutMs: 5_000`. Lock target `<machineConfigDir>/.locks/workspaces`. Preserve in-process `writeLocks` Map as inner guard.
  - **Verify**: All T-1 tests pass green; `bunx tsc --noEmit` clean; existing `src/test/workspace-registration-fixes.test.ts` still passes.

- [x] T-3 Refactor: extract a single shared lock-options builder if both `withCreateLock` and `withRegistryLock` end up duplicating the proper-lockfile option block (depends: T-2)
  - **Why**: Code quality — keep a single source for retry/stale defaults across the two stores (project rule: "keep behavior consistent across similar stores").
  - **Verify**: All tests still pass; no duplicated literal `{ stale: 10_000, retries: { factor: 1, ... } }` block across the two helpers; `biome check .` clean.

- [x] T-4 Review checkpoint (phase gate)
  - **Verify**: `bunx tsc --noEmit` + `bun test src/test/workspace-registry-lock.test.ts src/test/workspace-registration-fixes.test.ts` + `bun run check .` all pass.

- [ ] T-5 Write tests: `scanWorkspaces` and `applyFixes` for all five issue categories (RED) (depends: T-2)
  - **Why**: AC-3, AC-4, AC-5 (FR-4, FR-5). Cover: missing path, non-git path, no-`backlog/`-dir, duplicate paths (one with id, one without), stale current pointer. Tests use temp dirs with controlled fixtures. Plus `applyFixes` keeps healthy entries untouched and removes/dedupes/clears as specified.
  - **Verify**: `bun test src/test/workspace-doctor.test.ts` runs and FAILS — module does not yet exist.

- [ ] T-6 Implement: `src/commands/workspace-doctor.ts` (`scanWorkspaces`, `applyFixes`) (GREEN) (depends: T-5)
  - **Why**: AC-3, AC-4, AC-5 (FR-4, FR-5). Pure functions, no CLI dependency.
  - **Verify**: All T-5 tests pass; `bunx tsc --noEmit` clean.

- [ ] T-7 Write tests: `backlog workspace doctor` CLI integration — healthy registry exits 0; broken registry exits 1; `--fix` prompts via clack and prunes on confirmation; `--yes` skips prompt (RED) (depends: T-6)
  - **Why**: AC-3, AC-4, AC-5 (FR-4, FR-5). Spawn the CLI binary via the existing test helper; mock clack confirm where needed via the project's prompt-mock pattern.
  - **Verify**: `bun test` for the new test file FAILS — CLI command does not yet exist.

- [ ] T-8 Implement: `program.command("workspace")` parent + `doctor [--fix] [--yes]` subcommand wiring (GREEN) (depends: T-7)
  - **Why**: AC-3, AC-4, AC-5 (FR-4, FR-5). Wire CLI flags to `scanWorkspaces` / `applyFixes`; print categorised report; use `clack.confirm` unless `--yes`; release lock before any prompt.
  - **Verify**: T-7 tests pass; `backlog workspace doctor --help` lists the new flags; `bunx tsc --noEmit` clean.

- [ ] T-9 Review checkpoint (phase gate)
  - **Verify**: `bunx tsc --noEmit` + `bun test` (workspace-doctor + CLI tests) + `bun run check .` all pass; coverage ≥ 90% on `workspace-doctor.ts`.

- [ ] T-10 Write tests: MCP `workspace_list` and `workspace_switch` handlers — happy paths + unknown id error (RED) (depends: T-2)
  - **Why**: AC-6 (FR-6). Cover: `workspace_list` returns `{ workspaces, current }` shape; `workspace_switch` updates `current` on valid id; `workspace_switch` returns `isError: true` content block on unknown id.
  - **Verify**: `bun test src/test/workspaces-mcp-tools.test.ts` runs and FAILS — handlers / module do not yet exist.

- [ ] T-11 Implement: `src/mcp/tools/workspaces/{index.ts,handlers.ts,schemas.ts}`; register in `src/mcp/server.ts` (GREEN) (depends: T-10)
  - **Why**: AC-6 (FR-6). Follow `src/mcp/tools/tasks/` structure exactly. `workspace_list` annotated `readOnlyHint: true, destructiveHint: false`; `workspace_switch` annotated `destructiveHint: true`.
  - **Verify**: T-10 tests pass; `bunx tsc --noEmit` clean; MCP tool list shows both new tools.

- [ ] T-12 Refactor: ensure handler logic shares the registry lock path through `setCurrentWorkspaceId` (no new lock paths introduced) (depends: T-11)
  - **Why**: Code quality — a single registry lock entry point; do not let the MCP layer reach around it.
  - **Verify**: Code review: no direct `writeWorkspacesIndex` calls in the MCP module; all writes go through the locked helpers; tests still green.

- [ ] T-13 Write tests: `agent-guidelines.md` snapshot includes the "Workspace registry" section; `addAgentInstructions` outputs reference `workspace_list` / `workspace_switch` and `backlog workspace doctor` (RED) (depends: T-11)
  - **Why**: AC-7 (FR-7).
  - **Verify**: Snapshot / content tests FAIL — section not yet added.

- [ ] T-14 Implement: add "Workspace registry" section to `src/guidelines/agent-guidelines.md`; update any snapshot fixtures (GREEN) (depends: T-13)
  - **Why**: AC-7 (FR-7). Section describes the registry file location, the doctor command, and both new MCP tools. Calls out Cursor-family clients (interpreting AC #6's `.cursorrules` colloquially).
  - **Verify**: T-13 tests pass; running `backlog init` in a fixture produces CLAUDE.md and AGENTS.md containing the new section.

- [ ] T-15 Final review checkpoint (phase gate) (depends: T-14, T-12, T-9, T-4)
  - **Verify**: `bunx tsc --noEmit` + `bun run check .` + `bun test` all green; manual smoke: `backlog workspace doctor` against the dev machine; `backlog mcp` exposes both workspace tools; no regressions in existing workspace tests.

<!-- Status markers: [ ] pending, [→] in-progress, [x] done, [~] skipped -->
<!-- (depends: T-xxx) = dependency -->
<!-- TDD: test tasks (RED) always precede implementation tasks (GREEN) -->
<!-- Coverage target: >= 90% at each phase gate -->
