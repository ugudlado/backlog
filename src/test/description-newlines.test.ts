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

describe("CLI description newline handling", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-desc-newlines");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {}
		await mkdir(TEST_DIR, { recursive: true });

		({
			projectRoot: PROJECT_ROOT,
			core: CORE,
			env: ENV,
		} = await initializeGlobalTestProject(TEST_DIR, "Desc Newlines Test Project"));
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {}
	});

	it("should preserve literal newlines when creating task", async () => {
		const desc = "First line\nSecond line\n\nThird paragraph";
		await $`bun ${[cliPath, "task", "create", "Multi-line", "--desc", desc]}`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const core = CORE;
		const body = await core.getTaskContent("task-1");
		expect(body).toContain(desc);
	});

	it("should preserve literal newlines when editing task", async () => {
		const core = CORE;
		await core.createTask({
			id: "task-1",
			title: "Edit me",
			status: "To Do",
			assignee: [],
			createdDate: "2025-07-04",
			labels: [],
			dependencies: [],
			description: "Original",
		});

		const desc = "First line\nSecond line\n\nThird paragraph";
		await $`bun ${[cliPath, "task", "edit", "1", "--desc", desc]}`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const updatedBody = await core.getTaskContent("task-1");
		expect(updatedBody).toContain(desc);
	});

	it("should not interpret \\n sequences as newlines", async () => {
		const literal = "First line\\nSecond line";
		await $`bun ${[cliPath, "task", "create", "Literal", "--desc", literal]}`.cwd(PROJECT_ROOT).env(ENV).quiet();

		const core = CORE;
		const body = await core.getTaskContent("task-1");
		expect(body).toContain("First line\\nSecond line");
	});
});
