import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import type { Core } from "../index.ts";
import { createUniqueTestDir, initializeGlobalTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;
let PROJECT_ROOT: string;
let CORE: Core;
let ENV: Record<string, string>;

describe("CLI search command", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-search");
		await mkdir(TEST_DIR, { recursive: true });

		({
			projectRoot: PROJECT_ROOT,
			core: CORE,
			env: ENV,
		} = await initializeGlobalTestProject(TEST_DIR, "Search Command Project"));

		const core = CORE;
		await core.createTask({
			id: "task-1",
			title: "Central search integration",
			status: "To Do",
			assignee: ["@codex"],
			createdDate: "2025-09-18",
			labels: ["search"],
			dependencies: [],
			rawContent: "Implements central search module",
			description: "Implements central search module",
			modifiedFiles: ["src/web/App.tsx"],
		});

		await core.createTask({
			id: "task-2",
			title: "High priority follow-up",
			status: "In Progress",
			assignee: ["@codex"],
			createdDate: "2025-09-18",
			labels: ["search"],
			dependencies: [],
			rawContent: "Follow-up work",
			description: "Follow-up work",
			priority: "high",
			modifiedFiles: ["src/core/search-service.ts"],
		});
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	it("returns matching tasks in plain output", async () => {
		const result = await $`bun ${cliPath} search central --plain`.cwd(PROJECT_ROOT).env(ENV).quiet();

		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain("Tasks:");
		expect(stdout).toContain("TASK-1 - Central search integration");
	});

	it("honors status and priority filters for task results", async () => {
		const statusResult = await $`bun ${cliPath} search follow-up --status "In Progress" --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(statusResult.exitCode).toBe(0);
		const statusStdout = statusResult.stdout.toString();
		expect(statusStdout).toContain("TASK-2 - High priority follow-up");
		expect(statusStdout).not.toContain("TASK-1 - Central search integration");

		const priorityResult = await $`bun ${cliPath} search follow-up --priority high --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(priorityResult.exitCode).toBe(0);
		const priorityStdout = priorityResult.stdout.toString();
		expect(priorityStdout).toContain("TASK-2 - High priority follow-up");
	});

	it("applies result limit", async () => {
		const result = await $`bun ${cliPath} search search --plain --limit 1`.cwd(PROJECT_ROOT).env(ENV).quiet();
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		const taskMatches = stdout.match(/TASK-\d+ -/g) || [];
		expect(taskMatches.length).toBeLessThanOrEqual(1);
	});

	it("finds tasks by modified file path", async () => {
		const queryResult = await $`bun ${cliPath} search --modified-file "src/web/App.tsx" --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(queryResult.exitCode).toBe(0);
		const queryStdout = queryResult.stdout.toString();
		expect(queryStdout).toContain("TASK-1 - Central search integration");

		const filterResult = await $`bun ${cliPath} search --modified-file core/search-service --plain`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(filterResult.exitCode).toBe(0);
		const filterStdout = filterResult.stdout.toString();
		expect(filterStdout).toContain("TASK-2 - High priority follow-up");
		expect(filterStdout).not.toContain("TASK-1 - Central search integration");
		expect(filterStdout).not.toContain("Documents:");
	});
});
