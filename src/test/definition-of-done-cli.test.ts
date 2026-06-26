import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import type { Core } from "../core/backlog.ts";
import { createUniqueTestDir, initializeGlobalTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;
let PROJECT_ROOT: string;
let CORE: Core;
let ENV: Record<string, string>;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("Definition of Done CLI", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-definition-of-done-cli");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		({
			projectRoot: PROJECT_ROOT,
			core: CORE,
			env: ENV,
		} = await initializeGlobalTestProject(TEST_DIR, "DoD CLI Project"));
		const config = await CORE.filesystem.loadConfig();
		if (config) {
			config.definitionOfDone = ["Run tests", "Update docs"];
			await CORE.filesystem.saveConfig(config);
		}
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("creates task with Definition of Done defaults", async () => {
		const result = await $`bun ${CLI_PATH} task create "DoD defaults task"`.cwd(PROJECT_ROOT).env(ENV).quiet();
		expect(result.exitCode).toBe(0);

		const core = CORE;
		const task = await core.filesystem.loadTask("task-1");
		expect(task).not.toBeNull();
		const body = task?.rawContent ?? "";
		expect(body).toContain("## Definition of Done");
		expect(body).toContain("- [ ] #1 Run tests");
		expect(body).toContain("- [ ] #2 Update docs");
	});

	it("disables Definition of Done defaults when --no-dod-defaults is used", async () => {
		const result = await $`bun ${CLI_PATH} task create "DoD no defaults" --no-dod-defaults`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(result.exitCode).toBe(0);

		const core = CORE;
		const task = await core.filesystem.loadTask("task-1");
		const body = task?.rawContent ?? "";
		expect(body).not.toContain("## Definition of Done");
	});

	it("appends Definition of Done items with --dod", async () => {
		const result = await $`bun ${CLI_PATH} task create "DoD add" --dod "Ship notes" --dod "Sync roadmap"`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(result.exitCode).toBe(0);

		const core = CORE;
		const task = await core.filesystem.loadTask("task-1");
		const body = task?.rawContent ?? "";
		expect(body).toContain("- [ ] #1 Run tests");
		expect(body).toContain("- [ ] #2 Update docs");
		expect(body).toContain("- [ ] #3 Ship notes");
		expect(body).toContain("- [ ] #4 Sync roadmap");
	});

	it("edits Definition of Done items with check/uncheck/remove", async () => {
		await $`bun ${CLI_PATH} task create "DoD edit"`.cwd(PROJECT_ROOT).env(ENV).quiet();

		let editResult = await $`bun ${CLI_PATH} task edit 1 --check-dod 2`.cwd(PROJECT_ROOT).env(ENV).quiet();
		expect(editResult.exitCode).toBe(0);

		const core = CORE;
		let task = await core.filesystem.loadTask("task-1");
		let body = task?.rawContent ?? "";
		expect(body).toContain("- [x] #2 Update docs");

		editResult = await $`bun ${CLI_PATH} task edit 1 --remove-dod 1`.cwd(PROJECT_ROOT).env(ENV).quiet();
		expect(editResult.exitCode).toBe(0);

		task = await core.filesystem.loadTask("task-1");
		body = task?.rawContent ?? "";
		expect(body).not.toContain("Run tests");
		expect(body).toContain("- [x] #1 Update docs");

		editResult = await $`bun ${CLI_PATH} task edit 1 --uncheck-dod 1`.cwd(PROJECT_ROOT).env(ENV).quiet();
		expect(editResult.exitCode).toBe(0);

		task = await core.filesystem.loadTask("task-1");
		body = task?.rawContent ?? "";
		expect(body).toContain("- [ ] #1 Update docs");
	});
});
