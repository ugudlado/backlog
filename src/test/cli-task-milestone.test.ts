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

describe("CLI task milestone assignment", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-task-milestone");
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
		} = await initializeGlobalTestProject(TEST_DIR, "CLI Milestone Assignment Project"));
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - unique directory names prevent conflicts
		}
	});

	it("creates tasks with milestone titles resolved to canonical milestone IDs", async () => {
		const core = CORE;
		const milestone = await core.filesystem.createMilestone("Release CLI");

		const result = await $`bun ${cliPath} task create "Milestone create task" --milestone "Release CLI" --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain(`Milestone: ${milestone.id}`);

		const task = await core.filesystem.loadTask("task-1");
		expect(task?.milestone).toBe(milestone.id);
	});

	it("edits and clears task milestones from the CLI", async () => {
		const core = CORE;
		const first = await core.filesystem.createMilestone("Release Alpha");
		const second = await core.filesystem.createMilestone("Release Beta");

		const create = await $`bun ${cliPath} task create "Milestone edit task" --milestone ${first.id}`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(create.exitCode).toBe(0);

		const edit = await $`bun ${cliPath} task edit 1 --milestone "Release Beta" --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(edit.exitCode).toBe(0);
		expect(edit.stdout.toString()).toContain(`Milestone: ${second.id}`);

		const updated = await core.filesystem.loadTask("task-1");
		expect(updated?.milestone).toBe(second.id);

		const clear = await $`bun ${cliPath} task edit 1 --clear-milestone --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();
		expect(clear.exitCode).toBe(0);
		expect(clear.stdout.toString()).not.toContain("Milestone:");

		const cleared = await core.filesystem.loadTask("task-1");
		expect(cleared?.milestone).toBeUndefined();
	});

	it("rejects conflicting milestone edit flags", async () => {
		const core = CORE;
		await core.filesystem.createMilestone("Release CLI");
		await $`bun ${cliPath} task create "Conflicting milestone flags"`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const result = await $`bun ${cliPath} task edit 1 --milestone "Release CLI" --clear-milestone`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet()
			.nothrow();

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Cannot use --milestone and --clear-milestone together.");
	});

	it("shows milestone create and edit flags in help output", async () => {
		const createHelp = await $`bun ${cliPath} task create --help`.cwd(PROJECT_ROOT).env(ENV).quiet();
		const editHelp = await $`bun ${cliPath} task edit --help`.cwd(PROJECT_ROOT).env(ENV).quiet();

		expect(createHelp.stdout.toString()).toContain("-m, --milestone <milestone>");
		expect(editHelp.stdout.toString()).toContain("-m, --milestone <milestone>");
		expect(editHelp.stdout.toString()).toContain("--clear-milestone");
	});
});
