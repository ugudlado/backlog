# Running Backlog as a Service

`backlog server` runs the Web UI in the foreground. This is useful when you want a long-lived local dashboard that starts on boot and restarts on failure.

Projects live in a configured **global store** (`globalStore` in `~/.config/backlog/config.yml`). One server serves all of them — switch between projects from the web UI's project switcher or with `backlog project switch <name>`; you do not run one service per project.

Pick the recipe that matches your OS. The helper scripts set it up in one command:

```bash
scripts/service-macos.sh [PORT]   # macOS (wraps `backlog service`)
scripts/service-linux.sh [PORT]   # Linux / WSL2 (systemd user unit)
```

The manual recipes below give finer control (custom labels, Windows).

## Creating a project without shell access

You don't need a terminal on the box to create a project — a running server can create one for you:

- **Web UI:** on the empty-state screen (or the project switcher), enter a name and click **Create**.
- **API:** the same flow as one call —

  ```bash
  curl -X POST http://localhost:6420/api/projects \
    -H 'Content-Type: application/json' \
    -d '{"name": "My Project"}'
  ```

The server creates `<globalStore>/My Project/` and makes it current. It returns `400` if `globalStore` is unset or the name is unsafe, and `409` if a project with that name already exists.

## macOS (`backlog service`)

After `npm install -g @ugudlado1/backlog`:

```bash
backlog service start              # default port 6420
backlog service start --port 7000  # custom port (re-runnable)
```

Then manage it with:

```bash
backlog service status
backlog service logs       # tails ~/Library/Logs/backlog-md/{out,err}.log
backlog service stop       # stop, leave the plist on disk
backlog service uninstall  # stop and remove the plist
```

`start` writes `~/Library/LaunchAgents/md.backlog.browser.plist`, runs `launchctl bootstrap`, and starts the server with `KeepAlive` and `RunAtLoad`. On start the server serves the current project:

1. The `current` pointer in `~/.config/backlog/projects.yml` (last project selected in the UI), if set
2. Otherwise the first project found by scanning the global store

Create a project first (so the store isn't empty) with `backlog init <name>`. Switching projects in the UI persists the selection, so the next service start picks up the same project.

## Advanced / manual service managers

For finer control, or on Linux/Windows, use the OS-native service manager directly.

### Linux / WSL2 (systemd user unit)

One unit serves every project — it resolves the current project from the global store, so no `WorkingDirectory` is needed. Create `~/.config/systemd/user/backlog.service`:

```ini
[Unit]
Description=Backlog Web UI
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/backlog server --port 6420
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable linger so the unit can start at boot without an active terminal session, then enable the service:

```bash
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now backlog.service

# Check status or follow logs
systemctl --user status backlog
journalctl --user -u backlog -f
```

Adjust the `ExecStart` path to match `which backlog` on your system.

### macOS (launchd LaunchAgent)

Create `~/Library/LaunchAgents/md.backlog.browser.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>md.backlog.browser</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/backlog</string>
    <string>server</string>
    <string>--port</string>
    <string>6420</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/backlog-browser.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/backlog-browser.err.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load -w ~/Library/LaunchAgents/md.backlog.browser.plist
```

Use `/usr/local/bin/backlog` on Intel Macs, or the path returned by `which backlog`. No `WorkingDirectory` is needed — the server resolves the current project from the global store.

### Windows (Task Scheduler or NSSM)

For a setup that runs when you log in, register a Scheduled Task from PowerShell:

```powershell
$action  = New-ScheduledTaskAction -Execute "backlog.exe" `
            -Argument "server --port 6420"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Backlog Browser" -Action $action -Trigger $trigger
```

For a true background service that starts before login and auto-restarts on failure, wrap the command with [NSSM](https://nssm.cc/):

```powershell
nssm install BacklogBrowser "C:\path\to\backlog.exe" "server --port 6420"
nssm start BacklogBrowser
```
