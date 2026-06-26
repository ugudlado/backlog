import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { McpServer } from "../mcp/server.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import { createUniqueTestDir, initializeGlobalTestProject } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

// Build an MCP server pointed at a global-store slot (slot-aware filesystem), optionally
// overriding statuses/defaultStatus via config.
async function setupServer(
	testDir: string,
	projectName: string,
	statuses?: string[],
	defaultStatus?: string,
): Promise<{ server: McpServer; projectRoot: string; env: Record<string, string> }> {
	await mkdir(testDir, { recursive: true });
	const { projectRoot, env } = await initializeGlobalTestProject(testDir, projectName);
	const server = new McpServer(projectRoot, "Test instructions");
	server.filesystem.setGlobalStoreSlot(projectRoot, projectName);

	const config = await server.filesystem.loadConfig();
	if (!config) throw new Error("Failed to load config");
	if (statuses || defaultStatus) {
		if (statuses) config.statuses = statuses;
		if (defaultStatus) config.defaultStatus = defaultStatus;
		await server.filesystem.saveConfig(config);
	}
	registerTaskTools(server, config);
	return { server, projectRoot, env };
}

describe("MCP task_next", () => {
	let testDir: string;
	let server: McpServer;
	let projectRoot: string;
	let env: Record<string, string>;

	beforeEach(async () => {
		testDir = createUniqueTestDir("mcp-task-next");
		({ server, projectRoot, env } = await setupServer(testDir, "Test"));
	});

	afterEach(async () => {
		try {
			await server.stop();
		} catch {
			// ignore
		}
		await rm(testDir, { recursive: true, force: true });
	});

	it("task_next claims the top Ready task and returns transition info", async () => {
		await server.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "Ready Task", status: "Ready" } },
		});

		const result = await server.testInterface.callTool({
			params: { name: "task_next", arguments: {} },
		});
		expect(result.isError).toBeUndefined();

		const text = getText(result.content);
		expect(text).toContain("Claimed task");
		expect(text).toContain("Ready");
		expect(text).toContain("In Progress");
		expect(text).toContain("→");
	});

	it("task_next flips task status to In Progress", async () => {
		await server.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "Test Task", status: "Ready" } },
		});

		await server.testInterface.callTool({
			params: { name: "task_next", arguments: {} },
		});

		// Verify the task status was flipped
		const task = await server.filesystem.loadTask("task-1");
		expect(task?.status).toBe("In Progress");
	});

	it("task_next with --status picks from specified lane", async () => {
		await server.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "To Do Task", status: "To Do" } },
		});

		const result = await server.testInterface.callTool({
			params: { name: "task_next", arguments: { status: "To Do" } },
		});
		expect(result.isError).toBeUndefined();

		const text = getText(result.content);
		expect(text).toContain("To Do Task");
	});

	it("task_next with agent strips @ and sets assignee", async () => {
		await server.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "Agent Task", status: "Ready" } },
		});

		await server.testInterface.callTool({
			params: { name: "task_next", arguments: { agent: "@alice" } },
		});

		const task = await server.filesystem.loadTask("task-1");
		expect(task?.assignee).toContain("alice");
		expect(task?.assignee).not.toContain("@alice");
	});

	it("task_next returns error when no Ready tasks", async () => {
		const result = await server.testInterface.callTool({
			params: { name: "task_next", arguments: {} },
		});
		expect(result.isError).toBe(true);
		expect(getText(result.content)).toContain('No tasks found with status "Ready"');
	});

	it("task_next returns error for invalid status", async () => {
		const result = await server.testInterface.callTool({
			params: { name: "task_next", arguments: { status: "NonExistentStatus" } },
		});
		expect(result.isError).toBe(true);
		expect(getText(result.content)).toContain("Invalid status");
	});

	it("task_next error message uses config.defaultStatus when Ready is not configured", async () => {
		// Bug fix: on a legacy repo without Ready status, the error must say "To Do"
		// not the hardcoded fallback "Ready".
		const legacyDir = createUniqueTestDir("mcp-task-next-legacy-err");
		const { server: legacyServer } = await setupServer(legacyDir, "Legacy", ["To Do", "In Progress", "Done"], "To Do");

		try {
			// No tasks — empty queue
			const result = await legacyServer.testInterface.callTool({
				params: { name: "task_next", arguments: {} },
			});
			expect(result.isError).toBe(true);
			const text = getText(result.content);
			expect(text).toContain('"To Do"');
			expect(text).not.toContain('"Ready"');
		} finally {
			try {
				await legacyServer.stop();
			} catch {
				// ignore
			}
			await rm(legacyDir, { recursive: true, force: true });
		}
	});

	it("MCP and CLI produce equivalent claim behavior (parity test)", async () => {
		// Create two tasks with same status
		await server.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "Task Alpha", status: "Ready" } },
		});
		await server.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "Task Beta", status: "Ready" } },
		});

		// CLI claims one
		const cliResult = await $`bun ${CLI_PATH} task next`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(cliResult.exitCode).toBe(0);
		const cliOutput = cliResult.stdout.toString();
		expect(cliOutput).toContain("→");
		expect(cliOutput).toContain("In Progress");

		// MCP claims the other (server shares same underlying directory)
		const mcpResult = await server.testInterface.callTool({
			params: { name: "task_next", arguments: {} },
		});
		expect(mcpResult.isError).toBeUndefined();
		const mcpText = getText(mcpResult.content);
		expect(mcpText).toContain("→ In Progress");

		// Both should have claimed different tasks
		const allTasks = await server.filesystem.listTasks();
		const inProgressTasks = allTasks.filter((t) => t.status === "In Progress");
		expect(inProgressTasks.length).toBe(2);

		const claimedIds = new Set(inProgressTasks.map((t) => t.id));
		expect(claimedIds.size).toBe(2);
	});
});
