/**
 * Tests for the globalStore branch of resolveBacklogDirectory.
 * These tests require real git repos (via git init in temp dirs) to exercise
 * the resolveGitRootSync helper.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initTestGitRepo } from "../test/test-utils.ts";
import { resolveBacklogDirectory } from "./backlog-directory.ts";
import { clearProjectRootCache } from "./find-backlog-root.ts";
import { clearMachineConfigCache } from "./machine-config.ts";

const TMP_BASE = join(import.meta.dir, "__tmp_backlog_dir__");

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

	await initTestGitRepo(repoDir);

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

describe("resolveBacklogDirectory — in-repo (local) resolution", () => {
	it("(a) no machine config → no resolution (regression)", () => {
		const resolution = resolveBacklogDirectory(repoDir);
		expect(resolution.backlogPath).toBeNull();
		expect(resolution.configPath).toBeNull();
		expect(resolution.source).toBeNull();
	});

	it("(b) globalStore set, no in-repo backlog → no resolution (repos are not tagged to projects)", async () => {
		// Model B: a repo with no in-repo backlog/ resolves to nothing even when
		// globalStore is set. Global projects are addressed by name/current,
		// resolved at the CLI layer (resolveCliProjectRoot), not from a repo.
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();

		const resolution = resolveBacklogDirectory(repoDir);

		expect(resolution.backlogPath).toBeNull();
		expect(resolution.configPath).toBeNull();
		expect(resolution.source).toBeNull();
	});

	it("(c) globalStore set BUT local backlog/ exists → local wins", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();

		// Create local backlog with a config
		const localBacklog = join(repoDir, "backlog");
		await mkdir(localBacklog, { recursive: true });
		await writeFile(join(localBacklog, "config.yml"), "project_name: local\n");

		const resolution = resolveBacklogDirectory(repoDir);

		expect(resolution.backlogPath).toBe(localBacklog);
		expect(resolution.source).toBe("backlog");
		// Should NOT point to the global store
		expect(resolution.backlogPath?.startsWith(globalStoreDir)).toBe(false);
	});

	it("(d) globalStore set, projectRoot not in a git repo → returns null result (no globalStore path)", async () => {
		// Use a directory outside any git repo
		const { tmpdir } = await import("node:os");
		const nonGitDir = join(tmpdir(), `backlog-non-git-${Date.now()}`);
		await mkdir(nonGitDir, { recursive: true });

		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();

		try {
			const resolution = resolveBacklogDirectory(nonGitDir);

			expect(resolution.backlogPath).toBeNull();
			expect(resolution.configPath).toBeNull();
			expect(resolution.source).toBeNull();
		} finally {
			await rm(nonGitDir, { recursive: true, force: true });
		}
	});
});
