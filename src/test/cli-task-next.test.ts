import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { createUniqueTestDir, seedTestWorkspace } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

// Fast setup: write minimal config directly rather than calling initializeProject.
// Config must use the format that operations.ts parseConfig understands:
// - snake_case keys (project_name, default_status, check_active_branches, etc.)
// - statuses and labels as inline arrays: statuses: ["A", "B"]
async function setupProject(testDir: string, statuses?: string[], defaultStatus?: string): Promise<void> {
	await mkdir(join(testDir, "backlog", "tasks"), { recursive: true });
	await mkdir(join(testDir, "backlog", "archive", "tasks"), { recursive: true });
	await mkdir(join(testDir, "backlog", "milestones"), { recursive: true });
	await mkdir(join(testDir, "backlog", "completed"), { recursive: true });
	const effectiveStatuses = statuses ?? ["Backlog", "Ready", "To Do", "In Progress", "Done"];
	const effectiveDefault = defaultStatus ?? "To Do";
	const statusList = effectiveStatuses.map((s) => `"${s}"`).join(", ");
	const config = `project_name: "Test"
default_status: "${effectiveDefault}"
statuses: [${statusList}]
labels: []
date_format: yyyy-mm-dd
check_active_branches: false
filesystem_only: true
auto_commit: false
`;
	await seedTestWorkspace(testDir, { configBody: config });
}

describe("CLI task next", () => {
	let testDir: string;
	let core: Core;

	beforeEach(async () => {
		testDir = createUniqueTestDir("cli-task-next");
		await setupProject(testDir);
		core = new Core(testDir);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("picks the top Ready task and outputs id, title, and status transition", async () => {
		await core.createTaskFromInput({ title: "My Ready Task", status: "Ready" }, false);

		const result = await $`bun ${CLI_PATH} task next`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("My Ready Task");
		expect(output).toContain("Ready");
		expect(output).toContain("In Progress");
		// Should contain the transition arrow
		expect(output).toContain("→");
	});

	it("output contains task id", async () => {
		await core.createTaskFromInput({ title: "Task With ID", status: "Ready" }, false);

		const result = await $`bun ${CLI_PATH} task next`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		// Task ID should appear in output (e.g. TASK-1)
		expect(output).toMatch(/TASK-\d+/);
	});

	it("output contains full task body via formatTaskPlainText", async () => {
		await core.createTaskFromInput(
			{
				title: "Task With Body",
				status: "Ready",
				description: "This is the task description",
			},
			false,
		);

		const result = await $`bun ${CLI_PATH} task next`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("This is the task description");
	});

	it("--status picks from a different status lane", async () => {
		await core.createTaskFromInput({ title: "To Do Task", status: "To Do" }, false);
		await core.createTaskFromInput({ title: "Ready Task", status: "Ready" }, false);

		const result = await $`bun ${CLI_PATH} task next --status "To Do"`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("To Do Task");
		expect(output).not.toContain("Ready Task");
	});

	it("--agent @alice strips @ and sets assignee", async () => {
		await core.createTaskFromInput({ title: "Agent Task", status: "Ready" }, false);

		const result = await $`bun ${CLI_PATH} task next --agent @alice`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		// Reload the task from disk to verify assignee was written
		const tasks = await core.fs.listTasks();
		const claimed = tasks.find((t) => t.status === "In Progress");
		expect(claimed?.assignee).toContain("alice");
		expect(claimed?.assignee).not.toContain("@alice");
	});

	it("empty queue exits non-zero with correct message", async () => {
		// No Ready tasks
		await core.createTaskFromInput({ title: "Backlog task", status: "Backlog" }, false);

		const result = await $`bun ${CLI_PATH} task next`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).not.toBe(0);

		const stderr = result.stderr.toString();
		expect(stderr).toContain('No tasks found with status "Ready"');
	});

	it("invalid --status exits non-zero with valid statuses listed", async () => {
		const result = await $`bun ${CLI_PATH} task next --status "InvalidStatus"`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).not.toBe(0);

		const stderr = result.stderr.toString();
		expect(stderr).toContain("Invalid status");
		expect(stderr).toContain("Valid statuses are");
	});

	it("legacy regression: repo with only 'To Do' status works with --status 'To Do'", async () => {
		// Recreate with legacy config (no Ready/Backlog)
		await rm(testDir, { recursive: true, force: true });
		testDir = createUniqueTestDir("cli-task-next-legacy");
		await setupProject(testDir, ["To Do", "In Progress", "Done"], "To Do");
		core = new Core(testDir);

		await core.createTaskFromInput({ title: "Legacy Task", status: "To Do" }, false);

		const result = await $`bun ${CLI_PATH} task next --status "To Do"`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("Legacy Task");
		expect(output).toContain("To Do");
		expect(output).toContain("In Progress");
	});

	it("legacy regression: repo with only 'To Do' status, no --status flag, uses default status", async () => {
		// In a legacy repo with defaultStatus=To Do and no Ready status, the default should be To Do
		await rm(testDir, { recursive: true, force: true });
		testDir = createUniqueTestDir("cli-task-next-legacy-default");
		await setupProject(testDir, ["To Do", "In Progress", "Done"], "To Do");
		core = new Core(testDir);

		await core.createTaskFromInput({ title: "Legacy Default Task", status: "To Do" }, false);

		// No --status flag: should fall back to defaultStatus (To Do) since Ready isn't configured
		const result = await $`bun ${CLI_PATH} task next`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("Legacy Default Task");
	});

	it("legacy regression: empty queue error message uses config.defaultStatus when Ready is not configured", async () => {
		// Bug fix: error message must reflect the actual status used for filtering,
		// not a hardcoded "Ready" fallback.
		await rm(testDir, { recursive: true, force: true });
		testDir = createUniqueTestDir("cli-task-next-legacy-error");
		await setupProject(testDir, ["To Do", "In Progress", "Done"], "To Do");
		core = new Core(testDir);

		// No tasks at all — empty queue with legacy config
		const result = await $`bun ${CLI_PATH} task next`.cwd(testDir).nothrow().quiet();
		expect(result.exitCode).not.toBe(0);

		const stderr = result.stderr.toString();
		// Should say "To Do" (the actual defaultStatus), not "Ready"
		expect(stderr).toContain('No tasks found with status "To Do"');
		expect(stderr).not.toContain('"Ready"');
	});
});
