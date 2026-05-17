/**
 * RED phase: CLI integration tests for `backlog workspace doctor [--fix] [--yes]`.
 *
 * These tests FAIL until T-8 implements the `workspace` parent command and
 * `doctor` subcommand in src/cli.ts.
 *
 * Expected RED failure reason: CLI exits with "error: unknown command 'workspace'"
 * (Commander.js error for unregistered commands) and a non-zero exit code.
 *
 * Prompt-mock strategy:
 *   There is no cross-process clack mock pattern in this codebase. For the
 *   `--fix` interactive-prompt test we pipe `y\n` to stdin — clack's
 *   ConfirmPrompt emits a "confirm" event on 'y' keypress regardless of TTY
 *   mode. The `--yes` test bypasses the prompt entirely.
 *
 * Fixture strategy:
 *   Each test creates an isolated machineConfigDir via BACKLOG_MACHINE_CONFIG_DIR
 *   and populates it with real workspace entries using `upsertWorkspaceEntry`.
 *   Healthy entries point at real git repos with a `backlog/` subdir.
 *   Broken entries point at paths that do not exist on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { upsertWorkspaceEntry } from "../utils/workspaces-index.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a unique temp directory path (does NOT mkdir). */
function tmpRoot(label: string): string {
	return join(tmpdir(), `ws-doctor-cli-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

/** Creates a real git repo with a backlog/ subdir — a fully healthy workspace. */
async function makeHealthyWorkspace(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await $`git init -b main`.cwd(dir).quiet();
	await $`git config user.email test@example.com`.cwd(dir).quiet();
	await $`git config user.name "Test"`.cwd(dir).quiet();
	await mkdir(join(dir, "backlog"), { recursive: true });
}

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawns the CLI binary with the given args and environment, collecting stdout/stderr.
 * Optionally writes `stdinInput` to the child's stdin before closing it.
 */
async function runCli(args: string[], env: NodeJS.ProcessEnv, stdinInput?: string): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
		env: { ...process.env, NO_COLOR: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
		stdin: stdinInput !== undefined ? "pipe" : "ignore",
	});

	if (stdinInput !== undefined && proc.stdin) {
		proc.stdin.write(stdinInput);
		proc.stdin.end();
	}

	const [exitCode, stdoutText, stderrText] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	return { exitCode, stdout: stdoutText, stderr: stderrText };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("backlog workspace doctor CLI integration", () => {
	let base: string;
	let machineConfigDir: string;

	beforeEach(async () => {
		base = tmpRoot("suite");
		machineConfigDir = join(base, ".config", "backlog.md");
		await mkdir(machineConfigDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	// ── 1. Healthy registry → exit 0 ──────────────────────────────────────────
	it("healthy registry exits 0 and reports no issues", async () => {
		const wsDir = join(base, "healthy-ws");
		await makeHealthyWorkspace(wsDir);
		await upsertWorkspaceEntry({ path: wsDir, id: "ws-healthy" }, machineConfigDir);

		const result = await runCli(["workspace", "doctor"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		// RED: CLI does not yet exist — exits non-zero or prints unknown-command.
		// GREEN assertion: exit 0 + "healthy" or "no issues" message.
		expect(result.exitCode).toBe(0);
		// Output must include a phrase indicating all workspaces are healthy.
		// (The exact phrase is defined in T-8; we assert a reasonable substring.)
		const combined = result.stdout + result.stderr;
		expect(combined.toLowerCase()).toMatch(/healthy|no issues/);
	});

	// ── 2. Broken registry → exit 1 ───────────────────────────────────────────
	it("broken registry exits 1 and reports the missing-path issue", async () => {
		// Register a path that does not exist on disk.
		const missingPath = join(base, "does-not-exist");
		await upsertWorkspaceEntry({ path: missingPath, id: "ws-broken" }, machineConfigDir);

		const result = await runCli(["workspace", "doctor"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		// RED: exits with non-zero (unknown command), but NOT with "missing-path"
		// in output — the right-reason failure is the absence of the issue tag.
		// GREEN assertion: exit 1 + "missing-path" in report.
		expect(result.exitCode).toBe(1);
		const combined = result.stdout + result.stderr;
		// Must include the issue-category tag so we fail for the RIGHT reason in RED.
		expect(combined).toContain("missing-path");
	});

	// ── 3. `--fix` with broken entry, prompt answered YES → prunes, exits 0 ───
	it("--fix prompts for confirmation and prunes broken entries on yes", async () => {
		const missingPath = join(base, "also-gone");
		await upsertWorkspaceEntry({ path: missingPath, id: "ws-to-prune" }, machineConfigDir);

		// Pipe "y\n" so clack's ConfirmPrompt receives a 'y' keypress.
		const result = await runCli(
			["workspace", "doctor", "--fix"],
			{ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir },
			"y\n",
		);

		// RED: unknown command, exits non-zero without pruning anything.
		// GREEN assertion: exits 0 after pruning (no remaining issues).
		expect(result.exitCode).toBe(0);
		// After a successful fix, a summary about removal should appear.
		const combined = result.stdout + result.stderr;
		expect(combined.toLowerCase()).toMatch(/remov|prun|fix/);
	});

	// ── 4. `--yes` flag skips prompt and prunes, exits 0 ─────────────────────
	it("--yes skips prompt and prunes broken entries automatically", async () => {
		const missingPath = join(base, "yet-another-gone");
		await upsertWorkspaceEntry({ path: missingPath, id: "ws-auto-prune" }, machineConfigDir);

		// No stdin input needed — --yes bypasses the prompt entirely.
		const result = await runCli(["workspace", "doctor", "--fix", "--yes"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		// RED: unknown command, exits non-zero.
		// GREEN assertion: exits 0, no interactive prompt required.
		expect(result.exitCode).toBe(0);
		const combined = result.stdout + result.stderr;
		expect(combined.toLowerCase()).toMatch(/remov|prun|fix|healthy/);
	});
});
