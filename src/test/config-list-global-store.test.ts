/**
 * Tests for `backlog config list` showing the globalStore key.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { clearProjectRootCache } from "../utils/find-backlog-root.ts";
import { clearMachineConfigCache } from "../utils/machine-config.ts";
import { createUniqueTestDir, initializeGlobalTestProject } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let testDir: string;

beforeEach(async () => {
	testDir = createUniqueTestDir("config-list-global-store");
	await mkdir(testDir, { recursive: true });
	clearMachineConfigCache();
	clearProjectRootCache();
});

afterEach(async () => {
	clearMachineConfigCache();
	clearProjectRootCache();
	await rm(testDir, { recursive: true, force: true });
});

describe("backlog config list — globalStore key", () => {
	it("exits non-zero when no current project is resolvable (empty machine config)", async () => {
		// Project resolution is global-only via the `current` pointer. With an empty
		// machine config (no globalStore, no current project), `config list` cannot
		// resolve a project and must fail before printing any config.
		const machineConfigDir = join(testDir, "machine-config");
		await mkdir(machineConfigDir, { recursive: true });
		await Bun.write(join(machineConfigDir, "config.yml"), "");

		const result = await $`bun run ${CLI_PATH} config list`
			.cwd(tmpdir())
			.env({ ...process.env, BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir })
			.nothrow();

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("No Backlog.md project found");
	});

	it("shows the configured globalStore path when a current project resolves", async () => {
		const { projectRoot, env, globalStoreDir } = await initializeGlobalTestProject(testDir, "Test");

		const result = await $`bun run ${CLI_PATH} config list`.cwd(projectRoot).env(env).nothrow().text();

		// Proves config list actually ran (resolved a project) and printed the machine key.
		expect(result).toContain("projectName:");
		expect(result).toContain(`globalStore: ${globalStoreDir}`);
	});
});
