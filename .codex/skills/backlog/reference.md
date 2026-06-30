# backlog — extended reference

`SKILL.md` has the rules, workflow, and gotchas. **Flags are documented by the
CLI itself** — run `backlog <command> --help` (e.g. `backlog task create
--help`, `backlog task edit --help`, `backlog search --help`). Don't memorize a
flag table that drifts; ask the binary.

This file holds the one thing `--help` doesn't show: the shape of a task file.

## Task file format (read-only)

This is what you'll *see* in `backlog/tasks/task-<id> - <title>.md`. **Never
edit it by hand** — every field has a CLI flag (`backlog task edit --help`).

```markdown
---
id: task-42
title: Add GraphQL resolver
status: To Do
assignee: [@sara]
labels: [backend, api]
modified_files:
  - src/server/api.ts
---

## Description
Brief explanation of the task purpose.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 First criterion
- [x] #2 Second criterion (completed)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Tests pass
<!-- DOD:END -->

## Implementation Plan
1. Research approach
2. Implement solution

## Implementation Notes
Progress notes captured during implementation.

## Final Summary
PR-style summary of what was implemented.
```

The `<!-- AC:BEGIN -->` / `<!-- DOD:BEGIN -->` markers are managed by the CLI —
the `--check-ac`/`--check-dod` index flags operate on the numbered items inside
them. Don't touch the markers or renumber by hand.

## Common issues

| Problem              | Fix                                                          |
|----------------------|--------------------------------------------------------------|
| Task not found       | `backlog task list --plain` for the right ID                 |
| AC won't check       | `backlog task 42 --plain` to see the correct AC index        |
| Changes not saving   | You're editing files — use the CLI                           |
| Metadata out of sync | Re-edit via CLI: `backlog task edit 42 -s <current-status>`  |
