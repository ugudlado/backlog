#!/usr/bin/env bash
# Install the Backlog.md web UI as a systemd *user* service on Linux/WSL2.
#
# Prereqs: `backlog` on PATH and `backlog init` already run in the target repo.
# Usage:
#   scripts/service-linux.sh [REPO_DIR] [PORT]
#   REPO_DIR  defaults to the current directory
#   PORT      defaults to 6420
#
# Uninstall:
#   systemctl --user disable --now backlog.service && rm ~/.config/systemd/user/backlog.service

set -euo pipefail

REPO_DIR="$(cd "${1:-$PWD}" && pwd)"   # absolute; fails loudly if it doesn't exist
PORT="${2:-6420}"

# systemd has no $PATH, so ExecStart must be absolute.
BACKLOG_BIN="$(command -v backlog || true)"
[ -n "$BACKLOG_BIN" ] || { echo "backlog not found on PATH. Install it: npm i -g backlog.md" >&2; exit 1; }

# A repo is "init'd" when backlog/config.yml exists. Warn, don't block — the
# server can still resolve via the workspace registry's 'current' pointer.
[ -f "$REPO_DIR/backlog/config.yml" ] || echo "warn: no backlog/config.yml in $REPO_DIR — run 'backlog init' there first" >&2

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/backlog.service"
mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=Backlog.md Web UI
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$BACKLOG_BIN server --port $PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Linger lets the user unit run at boot without an active login session.
# Needs sudo; skip gracefully if unavailable (service still works while logged in).
sudo loginctl enable-linger "$USER" 2>/dev/null || echo "warn: could not enable linger; service runs only while you're logged in" >&2

systemctl --user daemon-reload
systemctl --user enable --now backlog.service

echo
echo "Started. Serving $REPO_DIR on http://localhost:$PORT"
echo "  status: systemctl --user status backlog"
echo "  logs:   journalctl --user -u backlog -f"
