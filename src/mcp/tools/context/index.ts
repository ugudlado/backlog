import type { BacklogConfig } from "../../../types/index.ts";
import { isRemoteMode, remoteGetConfig } from "../../../utils/remote-backend.ts";
import { BacklogToolError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult, McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { WORKFLOW_GUIDES } from "../../workflow-guides.ts";
import { TaskHandlers } from "../tasks/handlers.ts";

const contextSchema: JsonSchema = {
	type: "object",
	properties: {
		claim: {
			type: "boolean",
			description: "Atomically claim the next ready task and include its full content in the response",
		},
		agent: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "Agent name to assign when claiming (e.g. @claude)",
		},
	},
	required: [],
	additionalProperties: false,
};

function formatInstructions(): string {
	return WORKFLOW_GUIDES.map((guide) => guide.toolText ?? guide.resourceText).join("\n\n---\n\n");
}

async function formatProjectSummary(server: McpServer): Promise<string> {
	let config: BacklogConfig | null;
	let milestoneNames: string[] = [];
	if (isRemoteMode()) {
		config = await remoteGetConfig();
	} else {
		config = await server.filesystem.loadConfig();
		milestoneNames = (await server.filesystem.listMilestones()).map((m) => m.title);
	}
	if (!config) {
		return "## Project\n\nNo project config found.";
	}

	const lines: string[] = ["## Project", "", `Name: ${config.projectName}`];
	const statuses = (config.statuses ?? []).map((status) =>
		status === config.defaultStatus ? `${status} (default)` : status,
	);
	lines.push(`Statuses: ${statuses.join(", ")}`);
	if (milestoneNames.length > 0) {
		lines.push(`Milestones: ${milestoneNames.join(", ")}`);
	}
	const dod = config.definitionOfDone ?? [];
	if (dod.length > 0) {
		lines.push("", "Definition of Done defaults:", ...dod.map((item) => `- ${item}`));
	}
	return lines.join("\n");
}

function createContextTool(server: McpServer): McpToolHandler {
	const handlers = new TaskHandlers(server);

	return createSimpleValidatedTool(
		{
			name: "get_backlog_context",
			description:
				"Session bootstrap: returns the full Backlog.md workflow instructions, project state (statuses, milestones, Definition of Done defaults), and the current task board in a single call. Call this first, at the start of each session. Pass claim=true (with agent) to also atomically claim the next ready task.",
			inputSchema: contextSchema,
			annotations: { title: "Backlog Context", destructiveHint: false },
		},
		contextSchema,
		async (input: { claim?: boolean; agent?: string }) => {
			const content: CallToolResult["content"] = [
				{ type: "text", text: formatInstructions() },
				{ type: "text", text: await formatProjectSummary(server) },
			];

			const board = await handlers.listTasks({});
			const boardText = board.content
				.map((item) => (item as { text?: string }).text ?? "")
				.filter(Boolean)
				.join("\n\n");
			content.push({ type: "text", text: `## Board\n\n${boardText}` });

			if (input.claim) {
				try {
					const claimed = await handlers.nextTask({ agent: input.agent });
					content.push({ type: "text", text: "## Claimed Task" }, ...claimed.content);
				} catch (error) {
					if (error instanceof BacklogToolError && error.message.includes("No tasks found")) {
						content.push({ type: "text", text: `## Claimed Task\n\n${error.message} Nothing was claimed.` });
					} else {
						throw error;
					}
				}
			}

			return { content };
		},
	);
}

export function registerContextTools(server: McpServer): void {
	server.addTool(createContextTool(server));
}
