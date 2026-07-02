# Backlog.md MCP Implementation

This directory exposes the MCP surface so agents can work with backlog.md without duplicating business logic. It serves
local clients over stdio (`backlog mcp start`) and remote clients over Streamable HTTP via the web server's `/mcp` and
`/projects/:id/mcp` routes.

## What’s included

- `server.ts` / `createMcpServer()` – bootstraps a server that extends `Core` and registers context, task, milestone, and Definition of Done defaults tools (`get_backlog_context`, `get_backlog_instructions`, `task_*`, `milestone_*`, `definition_of_done_defaults_*`) for MCP clients.
- `tools/context/` – the `get_backlog_context` session bootstrap: workflow instructions, project state, and board snapshot in one call, with optional atomic claim of the next ready task.
- `tools/tasks/` – consolidated task tooling that delegates to shared Core helpers (including plan/notes/AC editing).
- `resources/` – lightweight resource adapters for agents.
- `../guidelines/mcp/` – task workflow content surfaced via MCP.

Everything routes through existing Core APIs so the MCP layer stays a protocol wrapper.

## Testing

```bash
bun test src/test/mcp-*.test.ts
```
