import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import type { Core } from "../core/backlog.ts";
import type { Task } from "../types";
import { createUniqueTestDir, initializeGlobalTestProject, safeCleanup } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;

describe("CLI ID Incrementing Behavior", () => {
	let core: Core;
	let PROJECT_ROOT: string;
	let ENV: Record<string, string>;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-incrementing-ids");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
		({
			projectRoot: PROJECT_ROOT,
			core,
			env: ENV,
		} = await initializeGlobalTestProject(TEST_DIR, "ID Incrementing Test"));
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("should increment task IDs correctly", async () => {
		const task1: Task = {
			id: "task-1",
			title: "First Task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
			description: "A test task.",
		};
		await core.createTask(task1);

		const result = await $`bun ${CLI_PATH} task create "Second Task"`.cwd(PROJECT_ROOT).env(ENV).quiet();

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("Created task TASK-2");

		const task2 = await core.filesystem.loadTask("task-2");
		expect(task2).toBeDefined();
		expect(task2?.title).toBe("Second Task");
	});
});
