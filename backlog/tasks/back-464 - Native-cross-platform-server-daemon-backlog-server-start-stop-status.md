---
id: BACK-464
title: Native cross-platform server daemon (backlog server start/stop/status)
status: To Do
assignee: []
created_date: '2026-05-03 12:40'
labels: []
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a native daemon to Backlog.md so users without Homebrew (Linux, CI, Docker, source installs) can run the web UI as a background service. Ships a 'backlog server' command group with start/stop/status subcommands, a JSON PID sidecar at ~/.config/backlog.md/server.pid, optional config at ~/.config/backlog.md/server.yml, stale-PID detection, double-start refusal, and terminal-close survival. Lower priority than BACK-463 (Homebrew covers most macOS users); revisit when Linux/non-brew demand materializes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 'backlog server start' launches BacklogServer in the background for the current workspace (same project resolution as 'backlog browser' uses today); the parent CLI process exits immediately after the child is confirmed running
- [ ] #2 'backlog server stop' reads the PID file, sends SIGTERM, waits for clean shutdown, and removes the PID file
- [ ] #3 'backlog server status' reports port, uptime, PID, and the project path being served (or a clear 'not running' message)
- [ ] #4 Daemon writes its state (PID, port, start time, project path) to ~/.config/backlog.md/server.pid; the directory is created on first run if missing
- [ ] #5 Daemon reads optional config from ~/.config/backlog.md/server.yml (port, host); CLI flags to 'server start' override config values
- [ ] #6 Stale server.pid files (process no longer alive, e.g. crashed or killed externally) are detected via kill(pid, 0) and cleaned up automatically when 'server start' runs
- [ ] #7 'server start' refuses to spawn a second daemon if one is already running; prints the existing port and exits non-zero
- [ ] #8 Daemon survives terminal close (parent shell exit) on macOS and Linux; child stdio is redirected so it does not write to the dead terminal
- [ ] #9 'backlog server start --foreground' runs BacklogServer in the current process (no spawn, no PID file, no detach); SIGTERM/SIGINT cleanly stop it. This is the form OS service managers (launchd, systemd) invoke when users prefer them over the native daemon.
- [ ] #10 Tests cover lifecycle (start/stop/status), stale-PID cleanup, double-start refusal, stop-when-not-running, foreground mode in-process behavior, and terminal-close survival
- [ ] #11 doc-003 is updated to lead with 'backlog server start/stop/status' alongside the Homebrew section from BACK-463; both paths coexist
<!-- AC:END -->
