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

describe("--desc alias functionality", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-desc-alias");
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
		} = await initializeGlobalTestProject(TEST_DIR, "Desc Alias Test Project"));
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should create task with --desc alias", async () => {
		await $`bun ${cliPath} task create "Test --desc alias" --desc "Created with --desc"`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();

		// Check that command succeeded (no exception thrown)
		const output = await $`bun ${cliPath} task 1 --plain`.cwd(PROJECT_ROOT).env(ENV).text();
		expect(output).toContain("Test --desc alias");
		expect(output).toContain("Created with --desc");
	});

	it("should verify task created with --desc has correct description", async () => {
		// Create task with --desc
		await $`bun ${cliPath} task create "Test task" --desc "Description via --desc"`.cwd(PROJECT_ROOT).env(ENV).quiet();

		// Verify the task was created with correct description
		const core = CORE;
		const task = await core.filesystem.loadTask("task-1");

		expect(task).not.toBeNull();
		expect(task?.description).toContain("Description via --desc");
	});

	it("should edit task description with --desc alias", async () => {
		// Create initial task
		const core = CORE;
		await core.createTask({
			id: "task-1",
			title: "Edit test task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-07-04",
			labels: [],
			dependencies: [],
			description: "Original description",
		});

		// Edit with --desc
		await $`bun ${cliPath} task edit 1 --desc "Updated via --desc"`.cwd(PROJECT_ROOT).env(ENV).quiet();

		// Command succeeded without throwing

		// Verify the description was updated
		const updatedTask = await core.filesystem.loadTask("task-1");
		expect(updatedTask?.description).toContain("Updated via --desc");
	});

	it("should show --desc in help text", async () => {
		const result = await $`bun ${cliPath} task create --help`.cwd(PROJECT_ROOT).env(ENV).text();

		expect(result).toContain("-d, --description <text>");
		expect(result).toContain("--desc <text>");
		expect(result).toContain("alias for --description");
	});
});
