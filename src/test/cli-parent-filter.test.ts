import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import type { Core } from "../index.ts";
import { createUniqueTestDir, initializeGlobalTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;
let PROJECT_ROOT: string;
let CORE: Core;
let ENV: Record<string, string>;

describe("CLI parent task filtering", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-parent-filter");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		({
			projectRoot: PROJECT_ROOT,
			core: CORE,
			env: ENV,
		} = await initializeGlobalTestProject(TEST_DIR, "Parent Filter Test Project"));
		const core = CORE;

		// Create a parent task
		await core.createTask({
			id: "task-1",
			title: "Parent task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Parent task description",
		});

		// Create child tasks
		await core.createTask({
			id: "task-1.1",
			title: "Child task 1",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Child task 1 description",
			parentTaskId: "task-1",
		});

		await core.createTask({
			id: "task-1.2",
			title: "Child task 2",
			status: "In Progress",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Child task 2 description",
			parentTaskId: "task-1",
		});

		// Create another standalone task
		await core.createTask({
			id: "task-2",
			title: "Standalone task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Standalone task description",
		});
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should filter tasks by parent with full task ID", async () => {
		const result = await $`bun ${cliPath} task list --parent task-1 --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		expect(exitCode).toBe(0);
		// Should contain only child tasks
		expect(result.stdout.toString()).toContain("TASK-1.1 - Child task 1");
		expect(result.stdout.toString()).toContain("TASK-1.2 - Child task 2");
		// Should not contain parent or standalone tasks
		expect(result.stdout.toString()).not.toContain("TASK-1 - Parent task");
		expect(result.stdout.toString()).not.toContain("TASK-2 - Standalone task");
	});

	it("should filter tasks by parent with short task ID", async () => {
		const result = await $`bun ${cliPath} task list --parent 1 --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		expect(exitCode).toBe(0);
		// Should contain only child tasks
		expect(result.stdout.toString()).toContain("TASK-1.1 - Child task 1");
		expect(result.stdout.toString()).toContain("TASK-1.2 - Child task 2");
		// Should not contain parent or standalone tasks
		expect(result.stdout.toString()).not.toContain("TASK-1 - Parent task");
		expect(result.stdout.toString()).not.toContain("TASK-2 - Standalone task");
	});

	it("should show error for non-existent parent task", async () => {
		const result = await $`bun ${cliPath} task list --parent task-999 --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.nothrow()
			.quiet();

		const exitCode = result.exitCode;

		expect(exitCode).toBe(1); // CLI exits with error for non-existent parent
		expect(result.stderr.toString()).toContain("Parent task TASK-999 not found.");
	});

	it("should show message when parent has no children", async () => {
		const result = await $`bun ${cliPath} task list --parent task-2 --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		expect(exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("No child tasks found for parent task TASK-2.");
	});

	it("should work with -p shorthand flag", async () => {
		const result = await $`bun ${cliPath} task list -p task-1 --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		expect(exitCode).toBe(0);
		// Should contain only child tasks
		expect(result.stdout.toString()).toContain("TASK-1.1 - Child task 1");
		expect(result.stdout.toString()).toContain("TASK-1.2 - Child task 2");
	});

	it("should combine parent filter with status filter", async () => {
		const result = await $`bun ${cliPath} task list --parent task-1 --status "To Do" --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		expect(exitCode).toBe(0);
		// Should contain only child task with "To Do" status
		expect(result.stdout.toString()).toContain("TASK-1.1 - Child task 1");
		// Should not contain child task with "In Progress" status
		expect(result.stdout.toString()).not.toContain("TASK-1.2 - Child task 2");
	});
});
