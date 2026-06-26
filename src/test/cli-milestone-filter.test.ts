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

describe("CLI milestone filtering", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-milestone-filter");
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
		} = await initializeGlobalTestProject(TEST_DIR, "Milestone Filter Test Project"));
		const core = CORE;
		const newMilestone = await core.filesystem.createMilestone("New Milestones UI");

		await core.createTask({
			id: "task-1",
			title: "Milestone task one",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Task in release milestone",
			milestone: "Release-1",
		});

		await core.createTask({
			id: "task-2",
			title: "Milestone task two",
			status: "In Progress",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Task in same milestone with different case",
			milestone: "release-1",
		});

		await core.createTask({
			id: "task-3",
			title: "Other milestone task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Task in different milestone",
			milestone: "Release-2",
		});

		await core.createTask({
			id: "task-4",
			title: "No milestone task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Task without milestone",
		});

		await core.createTask({
			id: "task-5",
			title: "Roadmap milestone task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Task in roadmap milestone",
			milestone: "Roadmap Alpha",
		});

		await core.createTask({
			id: "task-6",
			title: "ID milestone task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-06-18",
			labels: [],
			dependencies: [],
			description: "Task with milestone stored as ID",
			milestone: newMilestone.id,
		});
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - unique directory names prevent conflicts
		}
	});

	it("filters by milestone with case-insensitive matching", async () => {
		const result = await $`bun ${cliPath} task list --milestone RELEASE-1 --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();

		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();

		expect(output).toContain("TASK-1 - Milestone task one");
		expect(output).toContain("TASK-2 - Milestone task two");
		expect(output).not.toContain("TASK-3 - Other milestone task");
		expect(output).not.toContain("TASK-4 - No milestone task");
		expect(output).not.toContain("TASK-5 - Roadmap milestone task");
		expect(output).not.toContain("TASK-6 - ID milestone task");
	});

	it("supports -m shorthand and combines milestone with status filter", async () => {
		const result = await $`bun ${cliPath} task list -m release-1 --status "To Do" --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();

		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();

		expect(output).toContain("TASK-1 - Milestone task one");
		expect(output).not.toContain("TASK-2 - Milestone task two");
		expect(output).not.toContain("TASK-3 - Other milestone task");
		expect(output).not.toContain("TASK-4 - No milestone task");
		expect(output).not.toContain("TASK-5 - Roadmap milestone task");
		expect(output).not.toContain("TASK-6 - ID milestone task");
	});

	it("matches closest milestone for partial and typo inputs", async () => {
		const typoResult = await $`bun ${cliPath} task list --milestone releas-1 --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(typoResult.exitCode).toBe(0);
		const typoOutput = typoResult.stdout.toString();

		expect(typoOutput).toContain("TASK-1 - Milestone task one");
		expect(typoOutput).toContain("TASK-2 - Milestone task two");
		expect(typoOutput).not.toContain("TASK-3 - Other milestone task");
		expect(typoOutput).not.toContain("TASK-4 - No milestone task");
		expect(typoOutput).not.toContain("TASK-5 - Roadmap milestone task");

		const partialResult = await $`bun ${cliPath} task list --milestone roadmp --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(partialResult.exitCode).toBe(0);
		const partialOutput = partialResult.stdout.toString();

		expect(partialOutput).toContain("TASK-5 - Roadmap milestone task");
		expect(partialOutput).not.toContain("TASK-1 - Milestone task one");
		expect(partialOutput).not.toContain("TASK-2 - Milestone task two");
		expect(partialOutput).not.toContain("TASK-3 - Other milestone task");
		expect(partialOutput).not.toContain("TASK-4 - No milestone task");
		expect(partialOutput).not.toContain("TASK-6 - ID milestone task");
	});

	it("matches milestone title when tasks store milestone IDs", async () => {
		const result = await $`bun ${cliPath} task list -m new --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();

		expect(output).toContain("TASK-6 - ID milestone task");
		expect(output).not.toContain("TASK-1 - Milestone task one");
		expect(output).not.toContain("TASK-2 - Milestone task two");
		expect(output).not.toContain("TASK-3 - Other milestone task");
		expect(output).not.toContain("TASK-4 - No milestone task");
		expect(output).not.toContain("TASK-5 - Roadmap milestone task");
	});

	it("preserves existing listing behavior when milestone filter is omitted", async () => {
		const result = await $`bun ${cliPath} task list --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();

		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();

		expect(output).toContain("TASK-1 - Milestone task one");
		expect(output).toContain("TASK-2 - Milestone task two");
		expect(output).toContain("TASK-3 - Other milestone task");
		expect(output).toContain("TASK-4 - No milestone task");
		expect(output).toContain("TASK-5 - Roadmap milestone task");
		expect(output).toContain("TASK-6 - ID milestone task");
	});
});
