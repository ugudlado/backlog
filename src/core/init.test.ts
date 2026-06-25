/**
 * Tests for globalStore-aware init behavior.
 * When globalStore is set in machine config, initializeProject should:
 * - Create backlog structure in <globalStore>/<basename(gitRoot)>/
 * - NOT create backlog/ in the code repo
 * - Skip git staging for the code repo
 * - Error if globalStore dir does not exist
 * - Error if slot already exists and is non-empty
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { $ } from "bun";
import { clearProjectRootCache } from "../utils/find-backlog-root.ts";
import { clearMachineConfigCache } from "../utils/machine-config.ts";
import { Core } from "./backlog.ts";
import { type InitializeProjectOptions, initializeProject } from "./init.ts";

const TMP_BASE = join(tmpdir(), "backlog-init-test");

let repoDir: string;
let machineConfigDir: string;
let globalStoreDir: string;

const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

async function initGitRepo(dir: string): Promise<void> {
	await $`git init ${dir}`.quiet();
	await $`git -C ${dir} config user.email "test@example.com"`.quiet();
	await $`git -C ${dir} config user.name "Test"`.quiet();
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

function makeInitOptions(overrides: Partial<InitializeProjectOptions> = {}): InitializeProjectOptions {
	return {
		projectName: "Test Project",
		integrationMode: "none",
		...overrides,
	};
}

beforeEach(async () => {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	repoDir = join(TMP_BASE, `repo-${id}`);
	machineConfigDir = join(TMP_BASE, `machine-config-${id}`);
	globalStoreDir = join(TMP_BASE, `global-store-${id}`);

	await mkdir(repoDir, { recursive: true });
	await mkdir(machineConfigDir, { recursive: true });
	await mkdir(globalStoreDir, { recursive: true });

	await initGitRepo(repoDir);
	// Resolve symlinks for macOS
	repoDir = await realpath(repoDir);
	globalStoreDir = await realpath(globalStoreDir);

	process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
	clearMachineConfigCache();
	clearProjectRootCache();
});

afterEach(async () => {
	clearMachineConfigCache();
	clearProjectRootCache();
	if (origEnv === undefined) {
		delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
	} else {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
	}
	await rm(TMP_BASE, { recursive: true, force: true });
});

describe("initializeProject — globalStore branch", () => {
	it("(a) creates backlog structure in <globalStore>/<basename(gitRoot)>/", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		clearProjectRootCache();

		const core = new Core(repoDir);
		await initializeProject(core, makeInitOptions());

		const slotName = basename(repoDir);
		const expectedSlot = join(globalStoreDir, slotName);
		const tasksDir = join(expectedSlot, "tasks");

		expect(await dirExists(expectedSlot)).toBe(true);
		expect(await dirExists(tasksDir)).toBe(true);
	});

	it("(b) does NOT create backlog/ directory in the code repo", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		clearProjectRootCache();

		const core = new Core(repoDir);
		await initializeProject(core, makeInitOptions());

		const localBacklog = join(repoDir, "backlog");
		expect(await dirExists(localBacklog)).toBe(false);
	});

	it("(c) global init writes only the repo-root marker, no in-repo backlog/ dir", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		clearProjectRootCache();

		const core = new Core(repoDir);
		await initializeProject(core, makeInitOptions());

		// The repo is self-describing via a backlog.config.yml marker, but task
		// data lives in the global store — so no in-repo backlog/ dir is created.
		const status = await $`git -C ${repoDir} status --porcelain`.text();
		expect(status.includes("backlog/")).toBe(false);
		expect(status.includes("backlog.config.yml")).toBe(true);
	});

	it("(d) throws when slot already exists and is non-empty", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		clearProjectRootCache();

		// Pre-populate the slot
		const slotName = basename(repoDir);
		const existingSlot = join(globalStoreDir, slotName);
		await mkdir(join(existingSlot, "tasks"), { recursive: true });
		await writeFile(join(existingSlot, "tasks", "task-1.md"), "# Task 1\n");

		const core = new Core(repoDir);
		await expect(initializeProject(core, makeInitOptions())).rejects.toThrow(/Global store slot already exists/);
	});

	it("(e) throws when globalStore directory does not exist", async () => {
		const missingStoreDir = join(TMP_BASE, "does-not-exist");
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${missingStoreDir}\n`);
		clearMachineConfigCache();
		clearProjectRootCache();

		const core = new Core(repoDir);
		await expect(initializeProject(core, makeInitOptions())).rejects.toThrow(/Global store directory does not exist/);
	});
});
