import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import type { Core } from "../index.ts";
import type { Task } from "../types/index.ts";
import { createUniqueTestDir, initializeGlobalTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;
let PROJECT_ROOT: string;
let CORE: Core;
let ENV: Record<string, string>;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("CLI parent task id normalization", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-parent-normalization");
		await mkdir(TEST_DIR, { recursive: true });
		({
			projectRoot: PROJECT_ROOT,
			core: CORE,
			env: ENV,
		} = await initializeGlobalTestProject(TEST_DIR, "Normalization Test"));
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	it("should normalize parent task id when creating subtasks", async () => {
		const core = CORE;

		const parent: Task = {
			id: "task-4",
			title: "Parent",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-08",
			labels: [],
			dependencies: [],
		};
		await core.createTask(parent);

		await $`bun run ${CLI_PATH} task create Child --parent 4`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const child = await core.filesystem.loadTask("task-4.1");
		expect(child?.parentTaskId).toBe("TASK-4");
	});
});
