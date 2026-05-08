---
id: BACK-474
title: >-
  Drop MCP workspace tools; expose workspace registry via CLI subcommands
  instead
status: To Do
assignee: []
created_date: '2026-05-08 07:23'
labels:
  - registry
  - cli
  - follow-up
dependencies:
  - BACK-471
priority: medium
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
BACK-471 shipped MCP `workspace_list` / `workspace_switch` tools alongside the existing CLI/Web/HTTP-service surfaces. We've decided agents should shell out to `backlog workspace` instead of having a parallel MCP surface for the registry — the persistent HTTP service already covers the long-running daemon use case, and keeping a separate MCP tool surface for the registry duplicates the contract.

This ticket removes the MCP module and expands the CLI to give agents the operations they need.

## Scope

1. **Remove MCP workspace tools**
   - Delete `src/mcp/tools/workspaces/{index,handlers,schemas}.ts`
   - Drop the two `registerWorkspaceTools()` calls and import from `src/mcp/server.ts`
   - Remove `workspace_list` / `workspace_switch` from the snapshot in `src/test/mcp-server.test.ts`
   - Delete `src/test/workspaces-mcp-tools.test.ts`

2. **Add CLI subcommands** so agents have a structured surface to call
   - `backlog workspace list [--plain]` — print registered workspaces + current-id marker. `--plain` emits machine-readable text (or JSON) suitable for agent consumption.
   - `backlog workspace switch <id>` — set the machine-wide current pointer; error on unknown id.
   - Both go through the existing locked helpers (`readWorkspacesIndex`, `setCurrentWorkspaceId`) — no new lock paths.

3. **Rewrite the agent-guidelines `Workspace Registry` section**
   - Drop the `workspace_list` / `workspace_switch` MCP-tool block.
   - Keep the registry-overview + `backlog workspace doctor` description.
   - Direct agents to call `backlog workspace list --plain` and `backlog workspace switch <id>` from the shell, alongside the existing CLI patterns.

## Why

- Single contract: registry mutation goes through the CLI (and through it, the locked helpers). MCP tools were a parallel contract for the same data.
- Agents already shell out to `backlog` for every other write operation (task create/edit/etc go through MCP `task_*` because there's structured input — the registry has trivial inputs, so CLI is fine).
- Less surface to keep in sync when the registry schema changes.

## Acceptance Criteria

- [ ] No `registerWorkspaceTools` references remain in `src/mcp/server.ts` or anywhere else
- [ ] `backlog workspace list` prints registered workspaces with the current one marked; `--plain` emits a stable machine-readable form
- [ ] `backlog workspace switch <id>` updates `current` and exits 0; unknown id exits non-zero with a clear message
- [ ] Agent-guidelines `Workspace Registry` section no longer mentions MCP tools, instead documents the new CLI subcommands
- [ ] `bun test`, `bunx tsc --noEmit`, `bun run check .` all green

## Notes

- Follow-up to BACK-471. The locking, doctor command, and registry schema from BACK-471 stay as-is.
- Out of scope: changing how the HTTP service exposes the registry; adding `workspace add`/`remove` CLI subcommands (Web UI + auto-register cover those today).
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 bunx tsc --noEmit passes when TypeScript touched
- [ ] #2 bun run check . passes when formatting/linting touched
- [ ] #3 bun test (or scoped test) passes
<!-- DOD:END -->
