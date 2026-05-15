import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function setupDraftsWorkspace(): Promise<void> {
	// Init a minimal local backlog workspace
	await mkdir(join(TEST_DIR, "backlog", "tasks"), { recursive: true });
	await mkdir(join(TEST_DIR, "backlog", "drafts"), { recursive: true });
	await Bun.write(join(TEST_DIR, "backlog", "config.yml"), "projectName: Test Project\n");

	// Write three draft fixture files
	await Bun.write(
		join(TEST_DIR, "backlog", "drafts", "draft-1 - Spike GraphQL.md"),
		`---
id: draft-1
title: Spike GraphQL
status: Draft
---

Draft content for GraphQL spike.
`,
	);
	await Bun.write(
		join(TEST_DIR, "backlog", "drafts", "draft-2 - Evaluate Redis.md"),
		`---
id: draft-2
title: Evaluate Redis
status: Draft
---

Draft content for Redis evaluation.
`,
	);
	await Bun.write(
		join(TEST_DIR, "backlog", "drafts", "draft-3 - Design API.md"),
		`---
id: draft-3
title: Design API
status: Draft
---

Draft content for API design.
`,
	);
}

describe("migrate drafts-to-tasks", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-migrate-drafts");
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	test("moves draft files to tasks/ with status: Draft", async () => {
		await setupDraftsWorkspace();

		const result = await $`bun ${CLI_PATH} migrate drafts-to-tasks`.cwd(TEST_DIR).quiet().nothrow();

		expect(result.exitCode).toBe(0);

		// Each draft should appear in backlog/tasks/
		const taskFiles = await readdir(join(TEST_DIR, "backlog", "tasks"));
		expect(taskFiles.length).toBe(3);

		// drafts/ directory should be removed
		expect(await pathExists(join(TEST_DIR, "backlog", "drafts"))).toBe(false);

		// Verify tasks have status: Draft
		const taskContent = await Bun.file(join(TEST_DIR, "backlog", "tasks", taskFiles[0] as string)).text();
		expect(taskContent).toContain("status: Draft");
	});

	test("prints nothing-to-migrate and exits 0 when drafts/ absent", async () => {
		await setupDraftsWorkspace();

		// First run: migrate
		await $`bun ${CLI_PATH} migrate drafts-to-tasks`.cwd(TEST_DIR).quiet().nothrow();

		// Second run: nothing to migrate
		const result = await $`bun ${CLI_PATH} migrate drafts-to-tasks`.cwd(TEST_DIR).quiet().nothrow();

		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(output.toLowerCase()).toContain("nothing to migrate");
	});
});
