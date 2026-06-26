/**
 * Global-store projects live outside any code repo, so git integration is
 * skipped. The gate is keyed on path geometry (project root under the machine
 * global store), so it fires on the RESOLVE path too — not only when a slot is
 * created. This guards the footgun: a global store sitting inside a git repo
 * (e.g. ~/.config as a dotfiles repo) must NOT cause backlog to commit into it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { FileSystem } from "../file-system/operations.ts";
import { GitOperations } from "../git/operations.ts";
import { clearMachineConfigCache } from "../utils/machine-config.ts";

const TMP_BASE = join(tmpdir(), "backlog-global-store-gate-test");
const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

let globalStore: string;
let machineConfigDir: string;

beforeEach(async () => {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	machineConfigDir = join(TMP_BASE, `machine-${id}`);
	globalStore = join(TMP_BASE, `store-${id}`);
	await mkdir(machineConfigDir, { recursive: true });
	await mkdir(globalStore, { recursive: true });
	// The store is itself inside a git repo — the exact footgun the gate prevents.
	await $`git init ${globalStore}`.quiet();
	await Bun.write(join(machineConfigDir, "config.yml"), `globalStore: ${globalStore}\n`);
	process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
	clearMachineConfigCache();
});

afterEach(async () => {
	clearMachineConfigCache();
	if (origEnv === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
	else process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
	await rm(TMP_BASE, { recursive: true, force: true });
});

describe("global-store git gate (path geometry, resolve path)", () => {
	it("isGlobalStoreSlot() is true for a project root under the global store, without setGlobalStoreSlot", () => {
		const slotPath = join(globalStore, "my-project");
		const fs = new FileSystem(slotPath);
		// No setGlobalStoreSlot() call — this mirrors the resolve path.
		expect(fs.isGlobalStoreSlot()).toBe(true);
	});

	it("git.isRepository() returns false for a global-store slot even though the dir is inside a git repo", async () => {
		const slotPath = join(globalStore, "my-project");
		await mkdir(slotPath, { recursive: true });
		const fs = new FileSystem(slotPath);
		const git = new GitOperations(slotPath, () => fs.isGlobalStoreSlot());
		expect(await git.isRepository()).toBe(false);
	});

	it("isGlobalStoreSlot() is false for a project root outside the global store", () => {
		const outside = join(TMP_BASE, "elsewhere");
		const fs = new FileSystem(outside);
		expect(fs.isGlobalStoreSlot()).toBe(false);
	});
});
