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

async function setupLegacyWorkspace(): Promise<void> {
	await mkdir(join(TEST_DIR, "backlog", "tasks"), { recursive: true });
	await mkdir(join(TEST_DIR, "backlog", "docs"), { recursive: true });
	await mkdir(join(TEST_DIR, "backlog", "decisions"), { recursive: true });
	await mkdir(join(TEST_DIR, "backlog", "drafts"), { recursive: true });
	await Bun.write(join(TEST_DIR, "backlog", "config.yml"), "projectName: Test Project\n");

	await Bun.write(join(TEST_DIR, "backlog", "docs", "doc-1 - Setup Guide.md"), "# Setup Guide\n");
	await Bun.write(join(TEST_DIR, "backlog", "decisions", "dec-1 - Use TypeScript.md"), "# Use TypeScript\n");
	await Bun.write(join(TEST_DIR, "backlog", "drafts", "draft-1 - Draft Task.md"), "# Draft Task\n");
}

describe("migrate archive-legacy", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-archive-legacy");
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	test("archives docs/, decisions/, drafts/ into archive/legacy-<date>/", async () => {
		await setupLegacyWorkspace();

		const result = await $`bun ${CLI_PATH} migrate archive-legacy`.cwd(TEST_DIR).quiet().nothrow();

		expect(result.exitCode).toBe(0);

		const today = new Date().toISOString().slice(0, 10);
		const archiveLegacyDir = join(TEST_DIR, "backlog", "archive", `legacy-${today}`);

		// Archive dirs should exist with files
		expect(await pathExists(join(archiveLegacyDir, "docs"))).toBe(true);
		expect(await pathExists(join(archiveLegacyDir, "decisions"))).toBe(true);
		expect(await pathExists(join(archiveLegacyDir, "drafts"))).toBe(true);

		const docsFiles = await readdir(join(archiveLegacyDir, "docs"));
		expect(docsFiles.length).toBe(1);
		const decisionsFiles = await readdir(join(archiveLegacyDir, "decisions"));
		expect(decisionsFiles.length).toBe(1);
		const draftsFiles = await readdir(join(archiveLegacyDir, "drafts"));
		expect(draftsFiles.length).toBe(1);

		// Source dirs should be removed
		expect(await pathExists(join(TEST_DIR, "backlog", "docs"))).toBe(false);
		expect(await pathExists(join(TEST_DIR, "backlog", "decisions"))).toBe(false);
		expect(await pathExists(join(TEST_DIR, "backlog", "drafts"))).toBe(false);
	});

	test("second run with no legacy dirs prints nothing-to-archive and exits 0", async () => {
		await setupLegacyWorkspace();

		// First run: archive everything
		await $`bun ${CLI_PATH} migrate archive-legacy`.cwd(TEST_DIR).quiet().nothrow();

		// Second run: nothing to archive
		const result = await $`bun ${CLI_PATH} migrate archive-legacy`.cwd(TEST_DIR).quiet().nothrow();

		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(output.toLowerCase()).toContain("nothing to archive");
	});
});
