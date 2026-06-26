#!/usr/bin/env bash
# Install the Backlog.md web UI as a systemd *user* service on Linux/WSL2.
#
# One service serves every project — it resolves the current project from the
# configured global store, so no project/repo dir is needed.
#
# Prereqs: `backlog` on PATH, `globalStore` set in ~/.config/backlog/config.yml,
# and at least one project created (`backlog init <name>`).
# Usage:
#   scripts/service-linux.sh [PORT]      # PORT defaults to 6420
#
# Uninstall:
#   systemctl --user disable --now backlog.service && rm ~/.config/systemd/user/backlog.service

set -euo pipefail

PORT="${1:-6420}"

# systemd has no $PATH, so ExecStart must be absolute.
BACKLOG_BIN="$(command -v backlog || true)"
[ -n "$BACKLOG_BIN" ] || { echo "backlog not found on PATH. Install it: npm i -g backlog.md" >&2; exit 1; }

# Warn (don't block) if there are no projects yet to serve.
"$BACKLOG_BIN" project list --plain 2>/dev/null | grep -q '"projects":\[{' \
  || echo "warn: no projects found — create one with 'backlog init <name>'" >&2

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/backlog.service"
mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=Backlog.md Web UI
After=network.target

[Service]
Type=simple
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
echo "Started on http://localhost:$PORT (serving the current project)"
echo "  status: systemctl --user status backlog"
echo "  logs:   journalctl --user -u backlog -f"
