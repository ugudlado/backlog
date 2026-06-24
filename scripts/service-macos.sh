#!/usr/bin/env bash
# Install the Backlog.md web UI as a launchd service on macOS.
#
# This is a thin wrapper around the built-in `backlog service` command, which
# already writes the LaunchAgent plist (KeepAlive + RunAtLoad) and bootstraps it.
# ponytail: wrapper, not a reimplementation — `backlog service` is the real impl.
#
# Prereqs: `backlog` on PATH and `backlog init` already run in the target repo.
# Usage:
#   scripts/service-macos.sh [PORT]      # PORT defaults to 6420
#
# Uninstall:
#   backlog service uninstall

set -euo pipefail

PORT="${1:-6420}"

command -v backlog >/dev/null || { echo "backlog not found on PATH. Install it: npm i -g backlog.md" >&2; exit 1; }

backlog service start --port "$PORT"
echo
echo "Serving the current workspace on http://localhost:$PORT"
echo "  status: backlog service status"
echo "  logs:   backlog service logs"
