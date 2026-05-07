---
id: BACK-472
title: Agent-instruction refresh + Claude Code Skill packaging for fork capabilities
status: To Do
assignee: []
created_date: '2026-05-07 15:45'
labels:
  - agents
  - docs
  - mcp
dependencies: []
priority: medium
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The fork shipped backlog server, backlog service, backlog workspace, and the workspace registry — but src/agent-instructions.ts and the generated CLAUDE.md / AGENTS.md / .cursorrules templates copied into user repos still describe the pre-fork single-repo model. Agents running 'backlog init' in any user repo never learn about the new surfaces. This task updates the shipped instruction templates to describe the new commands + registry mental model (decision tree: cwd has project? -> registry? -> empty registry?), and packages a Claude Code Skill so 'claude /skill add backlog-md' onboards agents without bespoke per-host wiring. Subsumes BACK-349 (Publish Backlog.md as an Agent Skill). Depends on the registry hardening task landing first so the instructions describe a stable surface.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/agent-instructions.ts templates document backlog server, backlog service, backlog workspace commands and when to use each
- [ ] #2 Templates include the 'how do I find the right project?' decision tree referencing workspaces.yml and the workspace_list MCP tool
- [ ] #3 A Claude Code Skill bundle ships under skills/backlog-md/ with SKILL.md, capability description, and usage examples
- [ ] #4 MCP server advertises workflow/overview resource that mentions the registry and persistent server (or links to the doc that does)
- [ ] #5 Existing BACK-349 acceptance criteria are reviewed and either folded in or explicitly deferred
- [ ] #6 bunx tsc --noEmit, bun run check ., bun test all green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 bunx tsc --noEmit passes when TypeScript touched
- [ ] #2 bun run check . passes when formatting/linting touched
- [ ] #3 bun test (or scoped test) passes
<!-- DOD:END -->
