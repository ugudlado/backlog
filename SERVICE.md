# Running Backlog.md as a Service

`backlog server` runs the Web UI in the foreground. This is useful when you want a long-lived local dashboard that starts on boot and restarts on failure.

Pick the recipe that matches your OS. For the common single-project case, the helper scripts do it in one command (run from your repo, after `backlog init`):

```bash
scripts/service-macos.sh [PORT]            # macOS (wraps `backlog service`)
scripts/service-linux.sh [REPO_DIR] [PORT] # Linux / WSL2 (systemd user unit)
```

The manual recipes below give finer control (custom labels, multiple projects, Windows).

## Initializing a repo without shell access

You don't need a terminal on the box to set up a project — a running server can init and register one for you. The path is **server-side** (the repo must already exist on the machine running the server):

- **Web UI:** open the workspace switcher → "Add workspace" → enter the repo's absolute path. If it has no `backlog/` directory yet, the server inits it (filesystem-only when the path isn't a git repo), registers it, and you can switch to it.
- **API:** the same flow as one call —

  ```bash
  curl -X POST http://localhost:6420/api/workspaces \
    -H 'Content-Type: application/json' \
    -d '{"path": "/srv/repos/my-project"}'
  ```

Auto-init only happens when there is no `backlog/` at all; a directory with a broken/unparseable config returns an error instead of being overwritten. This path uses default settings (no MCP or agent-instruction wiring) — for the full wizard, run `backlog init` in the repo directly.

> [!NOTE]
> Running more than one Backlog project on the same machine? Each project needs its own service name and its own port. The examples below use `<project>` as a placeholder. Replace it with a short slug per project, such as `work` or `personal`, and assign distinct ports, such as `6420` and `6421`.

## macOS (`backlog service`)

After `npm install -g backlog.md`:

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

`start` writes `~/Library/LaunchAgents/md.backlog.browser.plist`, runs `launchctl bootstrap`, and starts the server with `KeepAlive` and `RunAtLoad`. The server picks its project from the machine-wide registry (`~/.config/backlog.md/workspaces.yml`):

1. The `current` pointer (last workspace selected in the UI), if set
2. Otherwise the first registered workspace
3. Otherwise the server falls back to walk-up from CWD (which fails for the launchd-managed case where CWD is `/`)

Register a project before opening the UI by running `backlog init` inside the project directory — it creates the project layout, registers it in the machine-wide index, and marks it as current. Switching workspaces in the UI persists the selection so the next service start picks up the same project.

## Advanced / manual service managers

For finer control, or on Linux/Windows, use the OS-native service manager directly.

### Linux / WSL2 (systemd user unit)

Create `~/.config/systemd/user/backlog-browser-<project>.service`, for example `backlog-browser-work.service`:

```ini
[Unit]
Description=Backlog.md Browser (<project>)
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/your/project
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
systemctl --user enable --now backlog-browser-<project>.service

# Check status or follow logs
systemctl --user status backlog-browser-<project>
journalctl --user -u backlog-browser-<project> -f
```

Adjust the `ExecStart` path to match `which backlog` on your system. For users with many projects, a systemd [template unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#Description) such as `backlog-browser@.service` with `%i` can reduce repetition.

### macOS (launchd LaunchAgent)

Create `~/Library/LaunchAgents/md.backlog.browser.<project>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>md.backlog.browser.&lt;project&gt;</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/backlog</string>
    <string>server</string>
    <string>--port</string>
    <string>6420</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/your/project</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/backlog-browser-&lt;project&gt;.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/backlog-browser-&lt;project&gt;.err.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load -w ~/Library/LaunchAgents/md.backlog.browser.<project>.plist
```

Use `/usr/local/bin/backlog` on Intel Macs, or the path returned by `which backlog`. The `Label` must be unique per project because launchd refuses to load two agents with the same label.

### Windows (Task Scheduler or NSSM)

For a setup that runs when you log in, register a Scheduled Task from PowerShell:

```powershell
$action  = New-ScheduledTaskAction -Execute "backlog.exe" `
            -Argument "server --port 6420" `
            -WorkingDirectory "C:\path\to\your\project"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Backlog Browser (<project>)" -Action $action -Trigger $trigger
```

For a true background service that starts before login and auto-restarts on failure, wrap the command with [NSSM](https://nssm.cc/):

```powershell
nssm install BacklogBrowser_<project> "C:\path\to\backlog.exe" "server --port 6420"
nssm set BacklogBrowser_<project> AppDirectory "C:\path\to\your\project"
nssm start BacklogBrowser_<project>
```

Both `TaskName` and the NSSM service name must be unique per project.
