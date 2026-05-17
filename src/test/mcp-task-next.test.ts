import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { McpServer } from "../mcp/server.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import { createUniqueTestDir } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

// Fast setup using the serialized config format that operations.ts parseConfig understands
async function setupTestProject(testDir: string): Promise<void> {
	await mkdir(join(testDir, "backlog", "tasks"), { recursive: true });
	await mkdir(join(testDir, "backlog", "archive", "tasks"), { recursive: true });
	await mkdir(join(testDir, "backlog", "milestones"), { recursive: true });
	await mkdir(join(testDir, "backlog", "completed"), { recursive: true });
	await writeFile(
		join(testDir, "backlog", "config.yml"),
		`project_name: "Test"
default_status: "To Do"
statuses: ["Backlog", "Ready", "To Do", "In Progress", "Done"]
labels: []
date_format: yyyy-mm-dd
check_active_branches: false
filesystem_only: true
`,
	);
}

describe("MCP task_next", () => {
	let testDir: string;
	let server: McpServer;

	beforeEach(async () => {
		testDir = createUniqueTestDir("mcp-task-next");
		await setupTestProject(testDir);
		server = new McpServer(testDir, "Test instructions");

		const config = await server.filesystem.loadConfig();
		if (!config) throw new Error("Failed to load config");
		registerTaskTools(server, config);
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
		await mkdir(join(legacyDir, "backlog", "tasks"), { recursive: true });
		await mkdir(join(legacyDir, "backlog", "archive", "tasks"), { recursive: true });
		await mkdir(join(legacyDir, "backlog", "milestones"), { recursive: true });
		await mkdir(join(legacyDir, "backlog", "completed"), { recursive: true });
		await writeFile(
			join(legacyDir, "backlog", "config.yml"),
			`project_name: "Legacy"
default_status: "To Do"
statuses: ["To Do", "In Progress", "Done"]
labels: []
date_format: yyyy-mm-dd
check_active_branches: false
filesystem_only: true
`,
		);
		const legacyServer = new McpServer(legacyDir, "Test instructions");
		const legacyConfig = await legacyServer.filesystem.loadConfig();
		if (!legacyConfig) throw new Error("Failed to load config");
		registerTaskTools(legacyServer, legacyConfig);

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
		const cliResult = await $`bun ${CLI_PATH} task next`.cwd(testDir).nothrow().quiet();
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
