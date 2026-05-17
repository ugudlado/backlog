/**
 * Tests for the globalStore branch of findBacklogRoot.
 * When globalStore is set and there is no in-repo backlog, findBacklogRoot
 * should return the git repo root (so the Core can be constructed).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { clearProjectRootCache, findBacklogRoot } from "./find-backlog-root.ts";
import { clearMachineConfigCache } from "./machine-config.ts";

// Use OS tmpdir to avoid the walk-up reaching the worktree's own backlog/
const TMP_BASE = join(tmpdir(), "backlog-find-root-test");

let repoDir: string;
let machineConfigDir: string;
let globalStoreDir: string;

const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

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
	// Resolve symlinks (e.g., /tmp → /private/tmp on macOS) so path comparisons work
	repoDir = await realpath(repoDir);

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

describe("findBacklogRoot — globalStore branch", () => {
	it("returns the git root when globalStore is set and no in-repo backlog exists", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		clearProjectRootCache();

		const result = await findBacklogRoot(repoDir);
		expect(result).toBe(repoDir);
	});

	it("returns the git root when called from a subdirectory of the repo", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		clearProjectRootCache();

		const subdir = join(repoDir, "src", "components");
		await mkdir(subdir, { recursive: true });

		const result = await findBacklogRoot(subdir);
		expect(result).toBe(repoDir);
	});

	it("local backlog still wins over globalStore when both exist", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		clearProjectRootCache();

		// Create local backlog with config
		await mkdir(join(repoDir, "backlog"), { recursive: true });
		await writeFile(join(repoDir, "backlog", "config.yml"), "project_name: local\n");

		const result = await findBacklogRoot(repoDir);
		// Should still find repoDir, but via the local backlog path (not globalStore)
		expect(result).toBe(repoDir);
	});

	it("returns null when globalStore not set and no in-repo backlog (existing behavior)", async () => {
		// No machine config written — globalStore not set
		clearProjectRootCache();

		// repoDir has no backlog/ and no globalStore
		const result = await findBacklogRoot(repoDir);
		expect(result).toBeNull();
	});
});
