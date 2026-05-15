# Changelog

## Unreleased — BACK-476: Remove Drafts, Docs, and Decisions Surfaces

### Breaking Changes

**Removed CLI commands:**
- `backlog draft` — replaced by `backlog task create --draft` (writes to `tasks/` with `status: Draft`)
- `backlog doc` — documentation surface removed
- `backlog decision` — decisions surface removed

Running any of these commands now prints a deprecation message and exits non-zero.

**Removed MCP tools:**
- `document_list`
- `document_view`
- `document_create`
- `document_update`
- `document_search`

**Changed behavior:**
- `backlog task create --draft` now writes directly to `backlog/tasks/` with `status: Draft` instead of routing to `backlog/drafts/`.
- The `--type` option has been removed from `backlog search` (only tasks are indexed).

**Removed:**
- `backlog search --type` option

### New Features

**Migration commands:**
- `backlog migrate drafts-to-tasks` — moves files from `backlog/drafts/` to `backlog/tasks/` with `status: Draft`, then removes `backlog/drafts/`.
- `backlog migrate archive-legacy` — moves `backlog/docs/`, `backlog/decisions/`, and `backlog/drafts/` into `backlog/archive/legacy-<YYYY-MM-DD>/`.

**Startup warning:**
- When legacy folders (`backlog/drafts/`, `backlog/docs/`, `backlog/decisions/`) are detected on any non-migrate command, a warning is printed to stderr suggesting migration.
- Set `suppressLegacyFolderWarning: true` in `backlog/config.yml` to silence this warning.

**New config option:**
- `suppressLegacyFolderWarning` (boolean) — suppresses the startup warning about legacy backlog folders when set to `true`.
