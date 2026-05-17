/**
 * Tests for BACK-477: `backlog init` store-mode (global vs local) selection.
 *
 * Test strategy:
 *  - Subprocess tests (via `runCli`) for cases that exit before prompting:
 *    mutual exclusion, --global without config, re-init guard, no-globalStore,
 *    and help text.
 *  - Unit tests on the exported `resolveStoreMode` helper for prompt behavior,
 *    since clack.select cannot be driven cross-process.
 *
 * The `resolveStoreMode` helper is extracted from `src/cli.ts` into
 * `src/utils/store-mode.ts` for testability.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");
const TMP_BASE = join(tmpdir(), "backlog-store-mode-test");

// ─── Subprocess helper ─────────────────────────────────────────────────────────

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
		env: { ...process.env, NO_COLOR: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		cwd,
	});

	const [exitCode, stdoutText, stderrText] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	return { exitCode, stdout: stdoutText, stderr: stderrText };
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

let repoDir: string;
let machineConfigDir: string;
let globalStoreDir: string;

async function initGitRepo(dir: string): Promise<void> {
	await $`git init ${dir}`.quiet();
	await $`git -C ${dir} config user.email "test@example.com"`.quiet();
	await $`git -C ${dir} config user.name "Test"`.quiet();
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
	repoDir = await realpath(repoDir);
	globalStoreDir = await realpath(globalStoreDir);
});

afterEach(async () => {
	await rm(TMP_BASE, { recursive: true, force: true });
});

// ─── T-1: Flag parsing and mutual exclusion ────────────────────────────────────

describe("backlog init store-mode — flag validation (subprocess)", () => {
	it("--global --local together exits 1 with mutual-exclusion message", async () => {
		const result = await runCli(
			["init", "TestProject", "--global", "--local", "--integration-mode", "none", "--agent-instructions", "none"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir },
			repoDir,
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Cannot use --global and --local together.");
	});

	it("--global without globalStore configured exits 1 with FR-6 message", async () => {
		// No config.yml written — no globalStore configured. Run in repoDir (fresh git repo, not initialized).
		const result = await runCli(
			["init", "TestProject", "--global", "--integration-mode", "none", "--agent-instructions", "none"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir, HOME: repoDir },
			repoDir,
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("--global requires globalStore to be set in machine config");
	});

	it("--global is recognized by commander (no 'unknown option' error)", async () => {
		// With globalStore configured, --global should NOT produce unknown-option error
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		const result = await runCli(
			["init", "TestProject", "--global", "--integration-mode", "none", "--agent-instructions", "none"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir, HOME: repoDir },
			repoDir,
		);
		// Should NOT contain "unknown option" — may fail for other reasons, but not parsing
		const combined = result.stdout + result.stderr;
		expect(combined).not.toContain("unknown option");
		expect(combined).not.toContain("error: unknown option '--global'");
	});

	it("--local is recognized by commander (no 'unknown option' error)", async () => {
		const result = await runCli(
			["init", "TestProject", "--local", "--integration-mode", "none", "--agent-instructions", "none"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir, HOME: repoDir },
			repoDir,
		);
		const combined = result.stdout + result.stderr;
		expect(combined).not.toContain("unknown option");
		expect(combined).not.toContain("error: unknown option '--local'");
	});
});

// ─── T-3: Prompt behavior tests (unit tests on resolveStoreMode helper) ────────

describe("resolveStoreMode helper", () => {
	it("is exported from src/utils/store-mode.ts", async () => {
		const mod = await import("./utils/store-mode.ts");
		expect(typeof mod.resolveStoreMode).toBe("function");
	});

	it("when --global flag: returns 'global' without prompting", async () => {
		const { resolveStoreMode } = await import("./utils/store-mode.ts");
		const selectMock = mock(() => Promise.resolve("local")); // would be wrong if called
		const result = await resolveStoreMode({
			globalFlag: true,
			localFlag: false,
			globalStoreConfigured: true,
			isReInitialization: false,
			selectFn: selectMock,
		});
		expect(result).toBe("global");
		expect(selectMock).not.toHaveBeenCalled();
	});

	it("when --local flag: returns 'local' without prompting", async () => {
		const { resolveStoreMode } = await import("./utils/store-mode.ts");
		const selectMock = mock(() => Promise.resolve("global")); // would be wrong if called
		const result = await resolveStoreMode({
			globalFlag: false,
			localFlag: true,
			globalStoreConfigured: true,
			isReInitialization: false,
			selectFn: selectMock,
		});
		expect(result).toBe("local");
		expect(selectMock).not.toHaveBeenCalled();
	});

	it("when globalStore configured, no flag, first init: calls selectFn with default 'global'", async () => {
		const { resolveStoreMode } = await import("./utils/store-mode.ts");
		let capturedOpts: { initialValue?: string } | undefined;
		const selectMock = mock((opts: { initialValue?: string }) => {
			capturedOpts = opts;
			return Promise.resolve("global");
		});
		const result = await resolveStoreMode({
			globalFlag: false,
			localFlag: false,
			globalStoreConfigured: true,
			isReInitialization: false,
			selectFn: selectMock,
		});
		expect(selectMock).toHaveBeenCalledTimes(1);
		expect(capturedOpts?.initialValue).toBe("global");
		expect(result).toBe("global");
	});

	it("when globalStore configured and user picks 'local': returns 'local'", async () => {
		const { resolveStoreMode } = await import("./utils/store-mode.ts");
		const selectMock = mock(() => Promise.resolve("local"));
		const result = await resolveStoreMode({
			globalFlag: false,
			localFlag: false,
			globalStoreConfigured: true,
			isReInitialization: false,
			selectFn: selectMock,
		});
		expect(result).toBe("local");
	});

	it("when globalStore configured and user picks 'global': returns 'global'", async () => {
		const { resolveStoreMode } = await import("./utils/store-mode.ts");
		const selectMock = mock(() => Promise.resolve("global"));
		const result = await resolveStoreMode({
			globalFlag: false,
			localFlag: false,
			globalStoreConfigured: true,
			isReInitialization: false,
			selectFn: selectMock,
		});
		expect(result).toBe("global");
	});

	it("when no globalStore configured, no flag: returns undefined without prompting", async () => {
		const { resolveStoreMode } = await import("./utils/store-mode.ts");
		const selectMock = mock(() => Promise.resolve("global"));
		const result = await resolveStoreMode({
			globalFlag: false,
			localFlag: false,
			globalStoreConfigured: false,
			isReInitialization: false,
			selectFn: selectMock,
		});
		expect(result).toBeUndefined();
		expect(selectMock).not.toHaveBeenCalled();
	});
});

// ─── T-5: --local flag skips prompt and forces local in the CLI ───────────────

describe("backlog init --local (subprocess)", () => {
	it("--local with globalStore configured creates backlog/ in repo, no globalStore slot", async () => {
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);

		const result = await runCli(
			["init", "TestProject", "--local", "--integration-mode", "mcp", "--defaults"],
			{
				BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
				HOME: repoDir,
			},
			repoDir,
		);

		// Should succeed
		expect(result.exitCode).toBe(0);

		// backlog/ must exist in repo
		const { stat } = await import("node:fs/promises");
		const backlogInRepo = join(repoDir, "backlog");
		const s = await stat(backlogInRepo).catch(() => null);
		expect(s?.isDirectory()).toBe(true);

		// No slot should be created in globalStore
		const { readdir } = await import("node:fs/promises");
		const globalSlots = await readdir(globalStoreDir).catch(() => []);
		expect(globalSlots.length).toBe(0);
	});
});

// ─── T-6: Integration — no-globalStore path, re-init guard, help text ─────────

describe("backlog init store-mode — integration (subprocess)", () => {
	it("AC-5: no globalStore configured, no flag → no prompt, backlog/ created", async () => {
		// No config.yml — globalStore not configured
		const result = await runCli(
			["init", "TestProject", "--integration-mode", "mcp", "--defaults"],
			{
				BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
				HOME: repoDir,
			},
			repoDir,
		);
		expect(result.exitCode).toBe(0);

		const { stat } = await import("node:fs/promises");
		const s = await stat(join(repoDir, "backlog")).catch(() => null);
		expect(s?.isDirectory()).toBe(true);
	});

	it("AC-7: re-init + --global exits 1 with re-init guard message", async () => {
		// Initialize first (use --integration-mode mcp --defaults to avoid prompt conflicts)
		await runCli(
			["init", "TestProject", "--integration-mode", "mcp", "--defaults"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir, HOME: repoDir },
			repoDir,
		);

		// Re-init with --global (globalStore configured so no --global-without-config guard fires)
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		const result = await runCli(
			["init", "TestProject", "--global", "--integration-mode", "mcp", "--defaults"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir, HOME: repoDir },
			repoDir,
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("store mode is fixed after initialization");
	});

	it("AC-7: re-init + --local exits 1 with re-init guard message", async () => {
		// Initialize first
		await runCli(
			["init", "TestProject", "--integration-mode", "mcp", "--defaults"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir, HOME: repoDir },
			repoDir,
		);

		// Re-init with --local
		const result = await runCli(
			["init", "TestProject", "--local", "--integration-mode", "mcp", "--defaults"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir, HOME: repoDir },
			repoDir,
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("store mode is fixed after initialization");
	});

	it("AC-9: backlog init --help contains --global and --local entries", async () => {
		const result = await runCli(["init", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("--global");
		expect(result.stdout).toContain("--local");
	});
});
