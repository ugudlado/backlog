/**
 * End-to-end integration tests for globalStore opt-in behavior.
 *
 * Each test runs real CLI subprocesses against a temp git repo with
 * BACKLOG_MACHINE_CONFIG_DIR pointing to a temp dir that holds config.yml
 * with `globalStore: <tempDir>`.
 *
 * These tests verify the full wire-up:
 *   (a) backlog init creates external slot, code repo stays clean
 *   (b) task create/list operate against external slot
 *   (c) git log in code repo shows no new commits even with autoCommit: true
 *   (d) missing globalStore dir → clean error message
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { $ } from "bun";

const TMP_BASE = join(tmpdir(), "backlog-integration-test");
const CLI_PATH = join(import.meta.dir, "..", "cli.ts");

let repoDir: string;
let machineConfigDir: string;
let globalStoreDir: string;

const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

function cliEnv(): Record<string, string> {
	return {
		...process.env,
		BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		// Force non-interactive mode
		CI: "1",
		NO_COLOR: "1",
	} as Record<string, string>;
}

beforeEach(async () => {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	repoDir = join(TMP_BASE, `repo-${id}`);
	machineConfigDir = join(TMP_BASE, `machine-config-${id}`);
	globalStoreDir = join(TMP_BASE, `global-store-${id}`);

	await mkdir(repoDir, { recursive: true });
	await mkdir(machineConfigDir, { recursive: true });
	await mkdir(globalStoreDir, { recursive: true });

	await $`git init ${repoDir}`.quiet();
	await $`git -C ${repoDir} config user.email "test@example.com"`.quiet();
	await $`git -C ${repoDir} config user.name "Test"`.quiet();

	// Resolve symlinks (macOS /tmp -> /private/tmp)
	repoDir = await realpath(repoDir);
	globalStoreDir = await realpath(globalStoreDir);

	await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
});

afterEach(async () => {
	if (origEnv === undefined) {
		delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
	} else {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
	}
	await rm(TMP_BASE, { recursive: true, force: true });
});

describe("globalStore end-to-end integration", () => {
	it("(a) backlog init creates external slot and leaves code repo clean", async () => {
		await $`bun run ${CLI_PATH} init "E2E Project" --integration-mode none`
			.cwd(repoDir)
			.env(cliEnv())
			.nothrow()
			.quiet();

		// Slot should be created in globalStore
		const slotPath = join(globalStoreDir, basename(repoDir));
		const slotStat = await stat(join(slotPath, "tasks")).catch(() => null);
		expect(slotStat?.isDirectory()).toBe(true);

		// Code repo should NOT have backlog/ directory
		const backlogStat = await stat(join(repoDir, "backlog")).catch(() => null);
		expect(backlogStat).toBeNull();

		// git status should be clean (no tracked backlog files)
		const status = await $`git -C ${repoDir} status --porcelain`.text();
		expect(status.includes("backlog")).toBe(false);
	});

	it("(b) task create and list operate against external slot", async () => {
		await $`bun run ${CLI_PATH} init "E2E Project" --integration-mode none`
			.cwd(repoDir)
			.env(cliEnv())
			.nothrow()
			.quiet();

		// Create a task via CLI
		const createResult = await $`bun run ${CLI_PATH} task create "Integration test task" --plain`
			.cwd(repoDir)
			.env(cliEnv())
			.nothrow()
			.text();
		expect(createResult).toContain("Integration test task");

		// List tasks — should find the task
		const listResult = await $`bun run ${CLI_PATH} task list --plain`.cwd(repoDir).env(cliEnv()).nothrow().text();
		expect(listResult).toContain("Integration test task");

		// Verify task file is in external slot, not in code repo
		const slotTasksDir = join(globalStoreDir, basename(repoDir), "tasks");
		const slotTaskFiles = await readdir(slotTasksDir);
		expect(slotTaskFiles.some((f) => f.endsWith(".md"))).toBe(true);

		// Code repo backlog/ should still not exist
		const backlogStat = await stat(join(repoDir, "backlog")).catch(() => null);
		expect(backlogStat).toBeNull();
	});

	it("(c) git log in code repo shows no new commits even with autoCommit: true", async () => {
		await $`bun run ${CLI_PATH} init "E2E Project" --integration-mode none`
			.cwd(repoDir)
			.env(cliEnv())
			.nothrow()
			.quiet();

		// Enable autoCommit in the external slot config
		await $`bun run ${CLI_PATH} config set autoCommit true`.cwd(repoDir).env(cliEnv()).nothrow().quiet();

		// Record git commit count before task creation
		const logBefore = await $`git -C ${repoDir} log --oneline`.nothrow().text();
		const commitCountBefore = logBefore.trim() === "" ? 0 : logBefore.trim().split("\n").length;

		// Create a task (would normally trigger autoCommit in a local-backlog project)
		await $`bun run ${CLI_PATH} task create "AutoCommit test task" --plain`
			.cwd(repoDir)
			.env(cliEnv())
			.nothrow()
			.quiet();

		// Code repo git log should be unchanged
		const logAfter = await $`git -C ${repoDir} log --oneline`.nothrow().text();
		const commitCountAfter = logAfter.trim() === "" ? 0 : logAfter.trim().split("\n").length;

		expect(commitCountAfter).toBe(commitCountBefore);
	});

	it("(d) missing globalStore directory → clean error message", async () => {
		const missingDir = join(TMP_BASE, "does-not-exist");
		const badMachineConfigDir = join(TMP_BASE, `machine-config-bad-${Date.now()}`);
		await mkdir(badMachineConfigDir, { recursive: true });
		await writeFile(join(badMachineConfigDir, "config.yml"), `globalStore: ${missingDir}\n`);

		const badEnv = { ...cliEnv(), BACKLOG_MACHINE_CONFIG_DIR: badMachineConfigDir };
		const result = await $`bun run ${CLI_PATH} init "E2E Project" --integration-mode none`
			.cwd(repoDir)
			.env(badEnv)
			.nothrow();

		const output = result.stdout.toString() + result.stderr.toString();
		expect(output).toMatch(/Global store directory does not exist/i);
	});
});
