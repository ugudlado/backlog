import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import type { Core } from "../core/backlog.ts";
import { extractStructuredSection } from "../markdown/structured-sections.ts";
import type { Task } from "../types/index.ts";
import { createUniqueTestDir, initializeGlobalTestProject, safeCleanup } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");
let TEST_DIR: string;
let PROJECT_ROOT: string;
let CORE: Core;
let ENV: Record<string, string>;

describe("Implementation Notes - append", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-notes-append");
		await mkdir(TEST_DIR, { recursive: true });
		({
			projectRoot: PROJECT_ROOT,
			core: CORE,
			env: ENV,
		} = await initializeGlobalTestProject(TEST_DIR, "Append Notes Test Project"));
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR).catch(() => {});
	});

	it("appends to existing Implementation Notes with single blank line", async () => {
		const core = CORE;
		const task: Task = {
			id: "task-1",
			title: "Task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-07-03",
			labels: [],
			dependencies: [],
			description: "Test description",
			implementationNotes: "First block",
		};
		await core.createTask(task);

		const result = await $`bun ${[CLI_PATH, "task", "edit", "1", "--append-notes", "Second block"]}`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(result.exitCode).toBe(0);

		const updatedBody = await core.getTaskContent("task-1");
		expect(extractStructuredSection(updatedBody ?? "", "implementationNotes")).toBe("First block\n\nSecond block");
	});

	it("creates Implementation Notes at correct position when missing (after plan, else AC, else Description)", async () => {
		const core = CORE;
		const t: Task = {
			id: "task-1",
			title: "Planned",
			status: "To Do",
			assignee: [],
			createdDate: "2025-07-03",
			labels: [],
			dependencies: [],
			description: "Desc here",
			acceptanceCriteriaItems: [{ index: 1, text: "A", checked: false }],
			implementationPlan: "1. Do A\n2. Do B",
		};
		await core.createTask(t);

		const res = await $`bun ${[CLI_PATH, "task", "edit", "1", "--append-notes", "Followed plan"]}`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(res.exitCode).toBe(0);

		const body = (await core.getTaskContent("task-1")) ?? "";
		const planIdx = body.indexOf("## Implementation Plan");
		const notesContent = extractStructuredSection(body, "implementationNotes") || "";
		expect(planIdx).toBeGreaterThan(0);
		expect(notesContent).toContain("Followed plan");
	});

	it("supports multiple --append-notes flags in order", async () => {
		const core = CORE;
		const task: Task = {
			id: "task-1",
			title: "Task",
			status: "To Do",
			assignee: [],
			createdDate: "2025-07-03",
			labels: [],
			dependencies: [],
			description: "Some description",
		};
		await core.createTask(task);

		const res = await $`bun ${[CLI_PATH, "task", "edit", "1", "--append-notes", "First", "--append-notes", "Second"]}`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(res.exitCode).toBe(0);

		const updatedBody = await core.getTaskContent("task-1");
		expect(extractStructuredSection(updatedBody ?? "", "implementationNotes")).toBe("First\n\nSecond");
	});

	it("edit --append-notes works and allows combining with --notes", async () => {
		const resOk = await $`bun ${[CLI_PATH, "task", "create", "T", "--plan", "1. A\n2. B"]}`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(resOk.exitCode).toBe(0);

		const res1 = await $`bun ${[CLI_PATH, "task", "edit", "1", "--append-notes", "Alpha", "--append-notes", "Beta"]}`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet();
		expect(res1.exitCode).toBe(0);

		const core = CORE;
		let taskBody = await core.getTaskContent("task-1");
		expect(extractStructuredSection(taskBody ?? "", "implementationNotes")).toBe("Alpha\n\nBeta");

		// Combining --notes (replace) with --append-notes (append) should work
		const combined = await $`bun ${[CLI_PATH, "task", "edit", "1", "--notes", "Y", "--append-notes", "X"]}`
			.cwd(PROJECT_ROOT)
			.env(ENV)
			.quiet()
			.nothrow();
		expect(combined.exitCode).toBe(0);

		taskBody = await core.getTaskContent("task-1");
		expect(extractStructuredSection(taskBody ?? "", "implementationNotes")).toBe("Y\n\nX");
	});
});
