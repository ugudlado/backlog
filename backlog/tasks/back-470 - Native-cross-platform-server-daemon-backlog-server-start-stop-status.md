---
id: BACK-470
title: >-
  Cross-platform server daemon (Linux systemd + Windows + native
  start/stop/status)
status: To Do
assignee: []
created_date: '2026-05-03 12:40'
updated_date: '2026-05-07 15:45'
labels:
  - cross-platform
  - server
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Now that workspace registry + macOS launchd service shipped (BACK-468), close the platform-parity gap so Linux and Windows users get a first-class persistent server. Two halves: (a) native daemon — backlog server start/stop/status with ~/.config/backlog.md/server.pid sidecar, stale-PID detection, double-start refusal, terminal-close survival; (b) OS-service templates — extend backlog service to emit a systemd user unit (~/.config/systemd/user/backlog.service) on Linux and a Scheduled Task / Windows Service shim on Windows. Keep the existing macOS launchd path untouched. References src/commands/service.ts:34 (currently darwin-only early-return) and the empty Linux/Windows branches in doc-003.
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
- [ ] #12 Linux: 'backlog service install' generates a systemd user unit at ~/.config/systemd/user/backlog.service that calls 'backlog server start --foreground'; documents 'systemctl --user enable --now backlog' to activate
- [ ] #13 Windows: 'backlog service install' registers a Scheduled Task (or Windows Service via nssm-style shim) that calls 'backlog server start --foreground' on user login; 'backlog service uninstall' removes it
- [ ] #14 Linux/Windows daemon survives parent shell exit on each platform; tests cover process detachment per-platform
- [ ] #15 doc-003 lists install/uninstall steps per OS in a single comparison table; macOS launchd path remains unchanged
<!-- AC:END -->
