import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { handleWorkspaceList, handleWorkspaceSwitch, type WorkspaceSwitchArgs } from "./handlers.ts";
import { workspaceListSchema, workspaceSwitchSchema } from "./schemas.ts";

export function registerWorkspaceTools(server: McpServer): void {
	const listTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "workspace_list",
			description: "List Backlog.md workspaces registered on this machine and identify the current one.",
			inputSchema: workspaceListSchema,
			annotations: { title: "List Workspaces", readOnlyHint: true, destructiveHint: false },
		},
		workspaceListSchema,
		async () => handleWorkspaceList(),
	);

	const switchTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "workspace_switch",
			description: "Switch the machine-wide current workspace pointer to the given registered workspace id.",
			inputSchema: workspaceSwitchSchema,
			annotations: { title: "Switch Workspace", destructiveHint: true },
		},
		workspaceSwitchSchema,
		async (input) => handleWorkspaceSwitch(input as WorkspaceSwitchArgs),
	);

	server.addTool(listTool);
	server.addTool(switchTool);
}

export { workspaceListSchema, workspaceSwitchSchema } from "./schemas.ts";
