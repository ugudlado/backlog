import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;

async function setupWorkspaceWithDrafts(): Promise<void> {
	await mkdir(join(TEST_DIR, "backlog", "tasks"), { recursive: true });
	await mkdir(join(TEST_DIR, "backlog", "drafts"), { recursive: true });
	await Bun.write(join(TEST_DIR, "backlog", "config.yml"), "projectName: Test Project\n");
	await Bun.write(join(TEST_DIR, "backlog", "drafts", "draft-1 - Old Draft.md"), "# Old Draft\n");
}

describe("legacy-folder startup warning", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-legacy-warning");
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	test("(a) warns on stderr when backlog/drafts/ exists and running a non-migrate command", async () => {
		await setupWorkspaceWithDrafts();

		const result = await $`bun ${CLI_PATH} task list`.cwd(TEST_DIR).quiet().nothrow();

		const stderr = result.stderr.toString();
		// Should mention "legacy" or "backlog/drafts"
		const hasWarning = stderr.toLowerCase().includes("legacy") || stderr.includes("backlog/drafts");
		expect(hasWarning).toBe(true);
	});

	test("(b) warning is suppressed when suppressLegacyFolderWarning: true in config", async () => {
		await setupWorkspaceWithDrafts();
		// Overwrite config with suppress flag
		await Bun.write(
			join(TEST_DIR, "backlog", "config.yml"),
			"projectName: Test Project\nsuppressLegacyFolderWarning: true\n",
		);

		const result = await $`bun ${CLI_PATH} task list`.cwd(TEST_DIR).quiet().nothrow();

		const stderr = result.stderr.toString();
		const hasWarning = stderr.toLowerCase().includes("legacy") || stderr.includes("backlog/drafts");
		expect(hasWarning).toBe(false);
	});

	test("(c) warning is absent when running migrate commands", async () => {
		await setupWorkspaceWithDrafts();

		const result = await $`bun ${CLI_PATH} migrate drafts-to-tasks`.cwd(TEST_DIR).quiet().nothrow();

		const stderr = result.stderr.toString();
		const hasWarning = stderr.toLowerCase().includes("legacy") || stderr.includes("backlog/drafts");
		expect(hasWarning).toBe(false);
	});
});
