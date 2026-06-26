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
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("task id generation", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-start-id");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
		({ projectRoot: PROJECT_ROOT, core: CORE, env: ENV } = await initializeGlobalTestProject(TEST_DIR, "ID Test"));
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("starts numbering tasks at 1", async () => {
		const result = await $`bun ${CLI_PATH} task create First`.cwd(PROJECT_ROOT).env(ENV).quiet();
		expect(result.exitCode).toBe(0);

		const task = await CORE.filesystem.loadTask("task-1");
		expect(task).not.toBeNull();
		expect(task?.title).toBe("First");
	});
});
