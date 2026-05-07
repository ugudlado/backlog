---
id: BACK-465
title: Verify Homebrew service block works end-to-end via local tap
status: Done
assignee: []
created_date: '2026-05-03 19:17'
updated_date: '2026-05-03 22:16'
labels: []
dependencies:
  - BACK-462
references:
  - backlog/docs/doc-003 - Running-Backlog-Browser-as-a-Service.md
  - spec/changes/archive/2026-05-03-back-463-persistent-server-daemon/spec.md
priority: high
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
BACK-463 shipped the Ruby `service do` block in doc-003 but only verified its textual presence — the block was never installed via a real Homebrew formula and `brew services start backlog-md` was never run against a live launchd. This task covers building the formula in a local tap (`brew tap-new $USER/local`), pointing it at the locally-built backlog binary, and confirming the full lifecycle works on macOS before the upstream Homebrew tap PR (AC-4 of BACK-463) is filed. Outcome: either the block in doc-003 is confirmed correct, or it gets patched based on what `brew install` / `brew services` actually accept.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Local tap created (`brew tap-new $USER/local`) with a `backlog-md.rb` formula whose `service do` block matches the snippet in `backlog/docs/doc-003 - Running-Backlog-Browser-as-a-Service.md` verbatim
- [x] #2 `brew install --build-from-source $USER/local/backlog-md` succeeds and `brew style` / `brew audit --strict` pass on the formula
- [x] #3 `brew services start backlog-md` launches the server under launchd; `brew services list` shows status `started`; the configured port (6420) responds to a basic HTTP probe (e.g. `curl -s http://localhost:6420` returns the UI HTML)
- [x] #4 Log files appear at the paths declared in the `service do` block (`var/log/backlog-md.log` and `var/log/backlog-md.err.log` under $(brew --prefix)/var/) and contain server output
- [x] #5 `brew services stop backlog-md` cleanly stops the process; PID is reaped; restart via `brew services restart` works
- [x] #6 If any step above requires changing the Ruby block, doc-003 is updated to match the verified working version and the change is committed (otherwise: a one-line note added to BACK-463 final summary or this task confirming the published block is correct as-is)
- [x] #7 Result documented: either (a) the formula and a copy of the working backlog-md.rb are checked into this repo at `spec/external/backlog-md.rb` for the upstream tap PR (AC-4 of BACK-463), or (b) a clear written explanation in this task's final summary of why we are not checking it in
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Design clarifications (2026-05-04, deferred until BACK-462 ships)

Before execution, two design decisions need finalization (raised during initial autopilot run, paused per user request):

**1. Source for `--build-from-source` — worktree HEAD, not published 1.44.0 npm tarball.**

The formula will build from worktree HEAD instead of reusing the upstream homebrew-core npm pattern. Open sub-questions:
- (a) `head: "https://github.com/MrLesk/Backlog.md.git", branch: "main"` — verifies upstream main; portable; PR-ready, OR
- (b) `head: "file:///<local worktree>", branch: "<feature-branch>"` — verifies exact worktree state; not portable.
- Build steps likely need to switch from `std_npm_args` to `bun install && bun run build && bin.install "dist/backlog"` (or equivalent) — the npm tarball pattern won't apply to a HEAD checkout.
- Pick (a) or (b) when starting; (a) is the upstream-tap-PR scenario, (b) is for verifying worktree-only changes.

**2. Drop `working_dir` from the `service do` block entirely.**

Current doc-003 has `working_dir var` which resolves to `/opt/homebrew/var` (Homebrew system dir, no `backlog/` project). Decision: drop the `working_dir` line entirely from both the formula AND from doc-003 (so AC-1 verbatim-match still holds).
- Users wanting a project-specific working dir should use the manual launchd plist block already in doc-003, where `WorkingDirectory=/path/to/your/project` is editable.
- This becomes a design-time doc-003 patch, not a post-verification fix.

**3. Add OQ-5 caveat paragraph to doc-003.**

One-paragraph note explaining `brew services` runs a single launchd plist; multi-project users should use the manual launchd block.

**Execution model: Option B (user-runs-verify.sh).**
Agent ships `spec/external/backlog-md.rb` + `verify.sh` only. User runs `brew tap-new`, `brew install --build-from-source`, `brew services start/stop/restart`, `curl`. No agent runs `brew` or system-modifying commands.

**Dependency: BACK-462 (multi-repo workspaces) ships first** — verify against the post-workspaces binary, not pre-workspaces HEAD.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
BACK-465 complete: backlog-md-local formula, verify.sh, doc-003 aligned; user verify all PASS.

## Superseded (2026-05-07)

The Homebrew route was abandoned in favor of a native `backlog service` CLI subcommand (see BACK-463 superseded note). The verified formula (`spec/external/backlog-md-local.rb`) and `verify.sh` were deleted in the same change. The verification this task performed remains valid as historical record but the artifacts no longer ship.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 bunx tsc --noEmit passes when TypeScript touched
- [ ] #2 bun run check . passes when formatting/linting touched
- [ ] #3 bun test (or scoped test) passes
<!-- DOD:END -->
