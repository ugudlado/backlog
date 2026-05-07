import { readWorkspacesIndex, setCurrentWorkspaceId } from "../../../utils/workspaces-index.ts";
import { BacklogToolError } from "../../errors/mcp-errors.ts";
import type { CallToolResult } from "../../types.ts";

export type WorkspaceSwitchArgs = { id: string };

function jsonResult(data: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
	};
}

export async function handleWorkspaceList(): Promise<CallToolResult> {
	const index = await readWorkspacesIndex();
	const current = index.current ?? null;
	const workspaces = index.workspaces
		.filter((e) => e.id !== undefined)
		.map((e) => ({
			id: e.id as string,
			path: e.path,
			isCurrent: current !== null && e.id === current,
		}));
	return jsonResult({ workspaces, current });
}

export async function handleWorkspaceSwitch(args: WorkspaceSwitchArgs): Promise<CallToolResult> {
	const index = await readWorkspacesIndex();
	const entry = index.workspaces.find((e) => e.id === args.id);
	if (!entry) {
		throw new BacklogToolError(`No workspace with id "${args.id}" in registry`, "NOT_FOUND");
	}
	await setCurrentWorkspaceId(args.id);
	return jsonResult({ id: args.id, path: entry.path });
}
