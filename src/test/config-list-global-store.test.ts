/**
 * Tests for `backlog config list` showing the globalStore key.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { initializeProject } from "../core/init.ts";
import { clearProjectRootCache } from "../utils/find-backlog-root.ts";
import { clearMachineConfigCache } from "../utils/machine-config.ts";

const TMP_BASE = join(tmpdir(), "backlog-config-list-test");
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let repoDir: string;
let machineConfigDir: string;

const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

beforeEach(async () => {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	repoDir = join(TMP_BASE, `repo-${id}`);
	machineConfigDir = join(TMP_BASE, `machine-config-${id}`);

	await mkdir(repoDir, { recursive: true });
	await mkdir(machineConfigDir, { recursive: true });

	await $`git init ${repoDir}`.quiet();
	await $`git -C ${repoDir} config user.email "test@example.com"`.quiet();
	await $`git -C ${repoDir} config user.name "Test"`.quiet();

	// Initialize a local backlog so config list works
	process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
	clearMachineConfigCache();
	clearProjectRootCache();

	const core = new Core(repoDir);
	await initializeProject(core, { projectName: "Test", integrationMode: "none" });

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

describe("backlog config list — globalStore key", () => {
	it("shows 'globalStore: (not set)' when no machine config is set", async () => {
		const result = await $`bun run ${CLI_PATH} config list`
			.cwd(repoDir)
			.env({ ...process.env, BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir })
			.nothrow()
			.text();

		expect(result).toContain("globalStore: (not set)");
	});

	it("shows 'globalStore: /tmp/store' when machine config has globalStore set", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), "globalStore: /tmp/store\n");
		clearMachineConfigCache();

		const result = await $`bun run ${CLI_PATH} config list`
			.cwd(repoDir)
			.env({ ...process.env, BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir })
			.nothrow()
			.text();

		expect(result).toContain("globalStore: /tmp/store");
	});
});
