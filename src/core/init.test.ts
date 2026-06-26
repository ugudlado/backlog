/**
 * Tests for global-store init: when the FileSystem is pointed at a slot via
 * setGlobalStoreSlot, initializeProject creates a flat <globalStore>/<name>/
 * (config.yml + tasks/ at the root), leaving any code repo untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
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

describe("initializeProject — global-store creation", () => {
	// Projects are global-store entities keyed by name (no repo tagging). The
	// slot is set explicitly via setGlobalStoreSlot: the slot is both project
	// root and data dir, with a flat config.yml + tasks/.
	function makeGlobalCore(name: string): { core: Core; slotPath: string } {
		const slotPath = join(globalStoreDir, name);
		const core = new Core(slotPath);
		core.filesystem.setGlobalStoreSlot(slotPath, name);
		return { core, slotPath };
	}

	it("(a) creates a flat slot at <globalStore>/<projectName>/", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		const { core, slotPath } = makeGlobalCore("Alpha");
		await initializeProject(core, makeInitOptions({ projectName: "Alpha", filesystemOnly: true }));

		expect(await dirExists(slotPath)).toBe(true);
		expect(await dirExists(join(slotPath, "tasks"))).toBe(true);
		// Flat layout: config.yml at the slot root, no nested backlog/ dir.
		expect(await fileExists(join(slotPath, "config.yml"))).toBe(true);
		expect(await dirExists(join(slotPath, "backlog"))).toBe(false);
	});

	it("(b) writes no repo-root marker (projects are not tagged to repos)", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		clearMachineConfigCache();
		const { core } = makeGlobalCore("Beta");
		await initializeProject(core, makeInitOptions({ projectName: "Beta", filesystemOnly: true }));

		// The code repo is left completely untouched.
		const status = await $`git -C ${repoDir} status --porcelain`.text();
		expect(status.trim()).toBe("");
	});
});
