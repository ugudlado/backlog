# Advanced Configuration

For getting started, see [README.md](README.md#-configuration).

There is no `backlog config` CLI command. Project configuration is edited in one of two ways:

- **Web UI Settings page** — run `backlog server` and open Settings.
- **Editing the project config file directly** — `backlog/config.yml`, or `backlog.config.yml` at the project root when using root config discovery.

A subset of options can also be set during `backlog init` when you opt into advanced settings.

## Project Configuration Options

These keys live in the project config file (`backlog/config.yml` or root `backlog.config.yml`).

| Key                     | Purpose                                              | Default                      |
|-------------------------|------------------------------------------------------|------------------------------|
| `projectName`           | Project identifier                                   | (set at init)                |
| `defaultStatus`         | First column / default status for new tasks          | `To Do`                      |
| `statuses`              | Board columns                                        | `[To Do, In Progress, Done]` |
| `labels`                | Known labels                                         | `[]`                         |
| `definitionOfDone`      | Default DoD checklist items for new tasks            | `(not set)`                  |
| `dateFormat`            | Date/time format                                     | `yyyy-mm-dd hh:mm`           |
| `maxColumnWidth`        | Max column width in board/list views                 | `(unset)`                    |
| `autoOpenBrowser`       | Open browser automatically when the server starts    | `true`                       |
| `defaultPort`           | Web UI port                                          | `6420`                       |
| `prefixes`              | ID prefix for tasks (read-only after init)           | `{ task: "task" }`           |
| `onStatusChange`        | Shell command to run on status change                | `(disabled)`                 |

## Detailed Notes

> **Status Change Callbacks**: Set `onStatusChange` to run a shell command whenever a task's status changes. Available variables: `$TASK_ID`, `$OLD_STATUS`, `$NEW_STATUS`, `$TASK_TITLE`. Per-task override via `onStatusChange` in task frontmatter. Example: `'if [ "$NEW_STATUS" = "In Progress" ]; then claude "Task $TASK_ID ($TASK_TITLE) has been assigned to you. Please implement it." & fi'`

> **Date/Time Support**: Backlog supports datetime precision for all dates. New items automatically include time (YYYY-MM-DD HH:mm format in UTC), while existing date-only entries remain unchanged for backward compatibility.

## Machine-level config (`~/.config/backlog/config.yml`)

Some settings live outside any project and apply across all repositories on the machine. Create or edit `~/.config/backlog/config.yml` directly.

**`globalStore`** — redirect all backlog storage to a single external directory instead of creating a `backlog/` folder inside each code repo:

```yaml
# ~/.config/backlog/config.yml
globalStore: /path/to/my/backlog-store
```

When `globalStore` is set:
- `backlog init` creates `<globalStore>/<repo-basename>/` instead of `<repo>/backlog/`.
- All task reads and writes go to the external slot — the code repo is never touched.
- The `globalStore` directory must exist before running `backlog init`. Backlog will not create it.
- If a local `backlog/` or `.backlog/` folder already exists in the repo, it wins and the global store is ignored for that project.

**`backlog_url` / `client_token`** — point the CLI and MCP at a remote Backlog server instead of local files:

```yaml
# ~/.config/backlog/config.yml
globalStore: ~/.config/backlog/workspaces
backlog_url: http://your-server:6420
client_token: your-secret-token   # optional; required when the server sets BACKLOG_TOKEN
```

When `backlog_url` is set, `backlog task list`, `backlog search`, `backlog mcp start`, and other supported commands proxy to the server's REST API. Environment variables override config for one-off use:

| Setting | Config key | Env override |
|---------|------------|--------------|
| Server URL | `backlog_url` | `BACKLOG_URL` |
| Auth token (client sends) | `client_token` | `BACKLOG_TOKEN` |

**`server_tokens`** — when this machine *runs* the server (web UI / REST API), the tokens it will accept. Any client presenting one of these is authorized. `client_token` is automatically accepted too, and `BACKLOG_TOKEN` is added at runtime:

```yaml
# ~/.config/backlog/config.yml
server_tokens:
  - your-secret-token
  - another-clients-token
```

To override the config directory path (useful in tests or CI), set the `BACKLOG_MACHINE_CONFIG_DIR` environment variable.
