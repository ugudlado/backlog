import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import type { Core } from "../core/backlog.ts";
import { createUniqueTestDir, initializeGlobalTestProject } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

// Initialize a global-store project, then optionally override statuses/defaultStatus
// via the slot-aware config (no removed keys like check_active_branches/filesystem_only).
async function setupProject(
	testDir: string,
	statuses?: string[],
	defaultStatus?: string,
): Promise<{ projectRoot: string; core: Core; env: Record<string, string> }> {
	await mkdir(testDir, { recursive: true });
	const { projectRoot, core, env } = await initializeGlobalTestProject(testDir, "Test");
	if (statuses || defaultStatus) {
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("Failed to load config");
		if (statuses) config.statuses = statuses;
		if (defaultStatus) config.defaultStatus = defaultStatus;
		await core.filesystem.saveConfig(config);
	}
	return { projectRoot, core, env };
}

describe("CLI task next", () => {
	let testDir: string;
	let projectRoot: string;
	let core: Core;
	let env: Record<string, string>;

	beforeEach(async () => {
		testDir = createUniqueTestDir("cli-task-next");
		({ projectRoot, core, env } = await setupProject(testDir));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("picks the top Ready task and outputs id, title, and status transition", async () => {
		await core.createTaskFromInput({ title: "My Ready Task", status: "Ready" });

		const result = await $`bun ${CLI_PATH} task next`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("My Ready Task");
		expect(output).toContain("Ready");
		expect(output).toContain("In Progress");
		// Should contain the transition arrow
		expect(output).toContain("→");
	});

	it("output contains task id", async () => {
		await core.createTaskFromInput({ title: "Task With ID", status: "Ready" });

		const result = await $`bun ${CLI_PATH} task next`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		// Task ID should appear in output (e.g. TASK-1)
		expect(output).toMatch(/TASK-\d+/);
	});

	it("output contains full task body via formatTaskPlainText", async () => {
		await core.createTaskFromInput({
			title: "Task With Body",
			status: "Ready",
			description: "This is the task description",
		});

		const result = await $`bun ${CLI_PATH} task next`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("This is the task description");
	});

	it("--status picks from a different status lane", async () => {
		await core.createTaskFromInput({ title: "To Do Task", status: "To Do" });
		await core.createTaskFromInput({ title: "Ready Task", status: "Ready" });

		const result = await $`bun ${CLI_PATH} task next --status "To Do"`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("To Do Task");
		expect(output).not.toContain("Ready Task");
	});

	it("--agent @alice strips @ and sets assignee", async () => {
		await core.createTaskFromInput({ title: "Agent Task", status: "Ready" });

		const result = await $`bun ${CLI_PATH} task next --agent @alice`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		// Reload the task from disk to verify assignee was written
		const tasks = await core.fs.listTasks();
		const claimed = tasks.find((t) => t.status === "In Progress");
		expect(claimed?.assignee).toContain("alice");
		expect(claimed?.assignee).not.toContain("@alice");
	});

	it("empty queue exits non-zero with correct message", async () => {
		// No Ready tasks
		await core.createTaskFromInput({ title: "Not-ready task", status: "To Do" });

		const result = await $`bun ${CLI_PATH} task next`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(result.exitCode).not.toBe(0);

		const stderr = result.stderr.toString();
		expect(stderr).toContain('No tasks found with status "Ready"');
	});

	it("invalid --status exits non-zero with valid statuses listed", async () => {
		const result = await $`bun ${CLI_PATH} task next --status "InvalidStatus"`
			.cwd(projectRoot)
			.env(env)
			.nothrow()
			.quiet();
		expect(result.exitCode).not.toBe(0);

		const stderr = result.stderr.toString();
		expect(stderr).toContain("Invalid status");
		expect(stderr).toContain("Valid statuses are");
	});

	it("legacy regression: repo with only 'To Do' status works with --status 'To Do'", async () => {
		// Recreate with legacy config (no Ready/Backlog)
		await rm(testDir, { recursive: true, force: true });
		testDir = createUniqueTestDir("cli-task-next-legacy");
		({ projectRoot, core, env } = await setupProject(testDir, ["To Do", "In Progress", "Done"], "To Do"));

		await core.createTaskFromInput({ title: "Legacy Task", status: "To Do" });

		const result = await $`bun ${CLI_PATH} task next --status "To Do"`.cwd(projectRoot).env(env).nothrow().quiet();
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
		({ projectRoot, core, env } = await setupProject(testDir, ["To Do", "In Progress", "Done"], "To Do"));

		await core.createTaskFromInput({ title: "Legacy Default Task", status: "To Do" });

		// No --status flag: should fall back to defaultStatus (To Do) since Ready isn't configured
		const result = await $`bun ${CLI_PATH} task next`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(result.exitCode).toBe(0);

		const output = result.stdout.toString();
		expect(output).toContain("Legacy Default Task");
	});

	it("legacy regression: empty queue error message uses config.defaultStatus when Ready is not configured", async () => {
		// Bug fix: error message must reflect the actual status used for filtering,
		// not a hardcoded "Ready" fallback.
		await rm(testDir, { recursive: true, force: true });
		testDir = createUniqueTestDir("cli-task-next-legacy-error");
		({ projectRoot, core, env } = await setupProject(testDir, ["To Do", "In Progress", "Done"], "To Do"));

		// No tasks at all — empty queue with legacy config
		const result = await $`bun ${CLI_PATH} task next`.cwd(projectRoot).env(env).nothrow().quiet();
		expect(result.exitCode).not.toBe(0);

		const stderr = result.stderr.toString();
		// Should say "To Do" (the actual defaultStatus), not "Ready"
		expect(stderr).toContain('No tasks found with status "To Do"');
		expect(stderr).not.toContain('"Ready"');
	});
});
