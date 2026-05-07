---
id: BACK-469
title: Homebrew service support (brew services start backlog-md)
status: Done
assignee:
  - '@claude'
created_date: '2026-05-03 11:37'
updated_date: '2026-05-03 13:00'
labels: []
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Document Homebrew service support so users on macOS can run the Backlog.md web UI as a long-lived background service via 'brew services start backlog-md'. Ships as a documentation-only change in this repo: doc-003 gains a copyable Ruby 'service do ... end' block that points at the existing 'backlog browser --no-open' command (which already runs the server in the foreground — the form launchd needs). The actual formula edit lives in the upstream Homebrew tap and is tracked as a follow-up. Native cross-platform daemon support ('backlog server start/stop/status') is captured separately in BACK-464.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 doc-003 (Running Backlog.md as a Service) leads with a 'Homebrew (macOS)' section containing a copyable Ruby 'service do ... end' block that invokes 'backlog browser --no-open' on the configured port; readers can paste it into the formula or a tap to enable 'brew services start backlog-md'
- [x] #2 doc-003 includes the user-side commands ('brew services start | stop | restart | list backlog-md') and explains that launchd handles PID, logs, restart-on-crash, and start-on-login automatically
- [x] #3 doc-003 keeps the existing OS-service-manager content (manual systemd / launchd plists for non-brew users) but moves it under a clearly-labeled 'Advanced / non-Homebrew' subsection
- [x] #4 Filing the formula PR against the upstream Homebrew tap is recorded as a follow-up (linked from doc-003 or the BACK-463 final summary); not blocking the BACK-463 PR
- [x] #5 No source-code changes in this repo — verified by 'git diff main -- src/' showing zero hits when the BACK-463 PR is opened
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added Homebrew service support to doc-003 so macOS users can run the Backlog.md web UI under launchd via `brew services start backlog-md`.

Changes:
- `backlog/docs/doc-003 - Running-Backlog-Browser-as-a-Service.md` now leads with a "Homebrew (macOS)" section containing a copyable Ruby `service do ... end` block invoking `backlog browser --no-open --port 6420`, plus the four `brew services start|stop|restart|list backlog-md` commands and a note that launchd handles PID, logs, restart-on-crash, and start-on-login.
- Existing systemd / macOS launchd plist / Windows recipes are demoted under "Advanced / non-Homebrew (manual service managers)" — preserved, not deleted.
- Cross-reference to BACK-464 (native cross-platform daemon) recorded inline.

Why Homebrew-only: `backlog browser --no-open` already runs the server in the foreground — exactly the shape `brew services` (launchd) needs. Shipping the Ruby block in doc-003 covers ~80% of macOS users at near-zero implementation cost. The full native daemon (`backlog server start/stop/status`, PID file, foreground/detached modes, cross-platform signal handling) is deferred to BACK-464.

Scope: documentation-only. AC-5 verified — `git diff main -- src/` is empty.

Follow-up (non-blocking, AC-4): file the formula PR against the upstream Homebrew tap so end users get the `service` block by default.

Tests: N/A (no source changes; rg-based content checks in tasks.md T-1 Verify line all pass).

## Superseded (2026-05-07)

The Homebrew route was abandoned in favor of a native `backlog service` CLI subcommand (macOS launchd, see `src/commands/service.ts`). Reasons: BACK-466 removed the `--global` workspace flag the Homebrew formula depended on; the upstream tap PR (AC-4) was never filed; and `npm i -g backlog.md && backlog service install` is a shorter path with no formula maintenance burden. Removed in the same change: `Formula/`, `spec/external/`, `verify.sh`, the doc-003 "Homebrew (macOS)" section, and `brew install backlog-md` references in README.
<!-- SECTION:FINAL_SUMMARY:END -->
