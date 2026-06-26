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
 *   (d) missing globalStore dir → clean error message
 *   (e) backlog init stores NO registry path; project is scan-discoverable + current
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { readProjectsIndex } from "../utils/projects-index.ts";

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

		// Slot is keyed by project name (not folder name).
		const slotPath = join(globalStoreDir, "E2E Project");
		const slotStat = await stat(join(slotPath, "tasks")).catch(() => null);
		expect(slotStat?.isDirectory()).toBe(true);

		// The code repo is left completely untouched: no in-repo backlog/ dir and
		// no marker (repos are not tagged to projects in the global-store model).
		const backlogStat = await stat(join(repoDir, "backlog")).catch(() => null);
		expect(backlogStat).toBeNull();
		const markerStat = await stat(join(repoDir, "backlog.config.yml")).catch(() => null);
		expect(markerStat).toBeNull();

		const status = await $`git -C ${repoDir} status --porcelain`.text();
		expect(status.trim()).toBe("");
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

		// Verify task file is in external slot (keyed by project name), not in code repo
		const slotTasksDir = join(globalStoreDir, "E2E Project", "tasks");
		const slotTaskFiles = await readdir(slotTasksDir);
		expect(slotTaskFiles.some((f) => f.endsWith(".md"))).toBe(true);

		// Code repo backlog/ should still not exist
		const backlogStat = await stat(join(repoDir, "backlog")).catch(() => null);
		expect(backlogStat).toBeNull();
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

	it("(e) backlog init stores NO registry path; project is scan-discoverable + current", async () => {
		await $`bun run ${CLI_PATH} init "E2E Project" --integration-mode none`
			.cwd(repoDir)
			.env(cliEnv())
			.nothrow()
			.quiet();

		// Global projects carry no registry path — they are found by scanning the
		// global store. So the registry must have no workspace entry for this repo...
		const index = await readProjectsIndex(machineConfigDir);
		const registered = index.projects.some((w) => w.path === repoDir);
		expect(registered).toBe(false);

		// ...the project is discoverable via the global-store scan (point the
		// in-process machine-config reader at the test's isolated dir)...
		const { scanGlobalStoreProjects } = await import("../utils/global-store-scan.ts");
		const { clearMachineConfigCache } = await import("../utils/machine-config.ts");
		process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
		clearMachineConfigCache();
		const scanned = await scanGlobalStoreProjects();
		const hit = scanned.find((p) => p.name === "E2E Project");
		expect(hit).toBeDefined();

		// ...and it is marked current (by the slot's scan id) so it serves on start.
		expect(index.current).toBe(hit?.id);
	});
});
