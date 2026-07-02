import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import type { McpServer } from "../mcp/server.ts";
import { registerContextTools } from "../mcp/tools/context/index.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import { createUniqueTestDir, initializeGlobalTestProject } from "./test-utils.ts";

const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

const allText = (content: unknown[] | undefined): string =>
	(content ?? []).map((item) => (item as { text?: string }).text ?? "").join("\n");

describe("MCP get_backlog_context", () => {
	let testDir: string;
	let server: McpServer;

	beforeEach(async () => {
		testDir = createUniqueTestDir("mcp-context");
		await mkdir(testDir, { recursive: true });
		const { projectRoot } = await initializeGlobalTestProject(testDir, "ContextTest");
		const { McpServer } = await import("../mcp/server.ts");
		server = new McpServer(projectRoot, "Test instructions");
		server.filesystem.setGlobalStoreSlot(projectRoot, "ContextTest");
		const config = await server.filesystem.loadConfig();
		if (!config) throw new Error("Failed to load config");
		config.definitionOfDone = ["Tests pass"];
		await server.filesystem.saveConfig(config);
		registerContextTools(server);
		registerTaskTools(server, config);
	});

	afterEach(async () => {
		try {
			await server.stop();
		} catch {}
		await rm(testDir, { recursive: true, force: true });
	});

	it("returns instructions, project summary, and board in one call", async () => {
		await server.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "Board Task", status: "To Do" } },
		});

		const result = await server.testInterface.callTool({
			params: { name: "get_backlog_context", arguments: {} },
		});
		expect(result.isError).toBeUndefined();

		// Section 1: all workflow guides inline
		const instructions = getText(result.content, 0);
		expect(instructions).toContain("Backlog.md Overview (Tools)");
		expect(instructions).toContain("Task Creation");
		expect(instructions).toContain("Task Execution");
		expect(instructions).toContain("Finaliz");

		// Section 2: project state
		const project = getText(result.content, 1);
		expect(project).toContain("Name: ContextTest");
		expect(project).toContain("(default)");
		expect(project).toContain("Tests pass");

		// Section 3: board snapshot
		const board = allText(result.content);
		expect(board).toContain("## Board");
		expect(board).toContain("Board Task");
	});

	it("claim:true atomically claims the next ready task and includes it", async () => {
		await server.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "Claimable Task", status: "Ready" } },
		});

		const result = await server.testInterface.callTool({
			params: { name: "get_backlog_context", arguments: { claim: true, agent: "@test-agent" } },
		});
		expect(result.isError).toBeUndefined();

		const text = allText(result.content);
		expect(text).toContain("## Claimed Task");
		expect(text).toContain("Claimable Task");
		expect(text).toContain("In Progress");

		const view = await server.testInterface.callTool({
			params: { name: "task_view", arguments: { id: "task-1" } },
		});
		expect(allText(view.content)).toContain("@test-agent");
	});

	it("claim:true with nothing claimable returns a note, not an error", async () => {
		const result = await server.testInterface.callTool({
			params: { name: "get_backlog_context", arguments: { claim: true, agent: "@test-agent" } },
		});
		expect(result.isError).toBeUndefined();

		const text = allText(result.content);
		expect(text).toContain("## Claimed Task");
		expect(text).toContain("Nothing was claimed");
	});
});
