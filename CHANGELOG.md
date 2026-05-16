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
