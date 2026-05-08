/**
 * RED phase: CLI integration tests for `backlog workspace list [--plain]`
 * and `backlog workspace switch <id>`.
 *
 * These tests FAIL until T-2 implements the `list` and `switch` subcommands
 * in src/commands/workspace.ts.
 *
 * Expected RED failure reason: CLI exits with "error: unknown command 'list'" /
 * "error: unknown command 'switch'" (Commander.js error for unregistered
 * subcommands) and a non-zero exit code.
 *
 * Fixture strategy:
 *   Each test creates an isolated machineConfigDir via BACKLOG_MACHINE_CONFIG_DIR
 *   and populates it with real workspace entries using `upsertWorkspaceEntry` /
 *   `setCurrentWorkspaceId`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspacesIndex, setCurrentWorkspaceId, upsertWorkspaceEntry } from "../utils/workspaces-index.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a unique temp directory path (does NOT mkdir). */
function tmpRoot(label: string): string {
	return join(tmpdir(), `ws-list-switch-cli-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawns the CLI binary with the given args and environment, collecting stdout/stderr.
 */
async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
		env: { ...process.env, NO_COLOR: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});

	const [exitCode, stdoutText, stderrText] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	return { exitCode, stdout: stdoutText, stderr: stderrText };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("backlog workspace list + switch CLI integration", () => {
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

	// ── 1. list with two entries: both ids present, current marked with * ──────
	it("list with two entries: stdout contains both ids; current is marked *; exits 0", async () => {
		const wsAPath = join(base, "workspace-a");
		const wsBPath = join(base, "workspace-b");
		await upsertWorkspaceEntry({ path: wsAPath, id: "ws-a" }, machineConfigDir);
		await upsertWorkspaceEntry({ path: wsBPath, id: "ws-b" }, machineConfigDir);
		await setCurrentWorkspaceId("ws-a", machineConfigDir);

		const result = await runCli(["workspace", "list"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("ws-a");
		expect(result.stdout).toContain("ws-b");
		// The current entry must be preceded by *
		expect(result.stdout).toMatch(/^\*\s+ws-a\b/m);
		// The non-current entry must NOT be preceded by *
		expect(result.stdout).toMatch(/^ +ws-b\b/m);
	});

	// ── 2. list --plain populated: stdout parses as valid JSON ────────────────
	it("list --plain with two entries: stdout is JSON matching upserted data", async () => {
		const wsAPath = join(base, "workspace-a");
		const wsBPath = join(base, "workspace-b");
		await upsertWorkspaceEntry({ path: wsAPath, id: "ws-a" }, machineConfigDir);
		await upsertWorkspaceEntry({ path: wsBPath, id: "ws-b" }, machineConfigDir);
		await setCurrentWorkspaceId("ws-a", machineConfigDir);

		const result = await runCli(["workspace", "list", "--plain"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);

		const parsed = JSON.parse(result.stdout.trim()) as {
			current: string | null;
			workspaces: Array<{ id: string | null; path: string }>;
		};
		expect(parsed.current).toBe("ws-a");
		expect(parsed.workspaces).toHaveLength(2);

		// Both entries must appear (order may vary — sort by id)
		const sorted = [...parsed.workspaces].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
		expect(sorted[0]).toEqual({ id: "ws-a", path: wsAPath });
		expect(sorted[1]).toEqual({ id: "ws-b", path: wsBPath });
	});

	// ── 3. list on empty registry: exits 0, output mentions "No workspaces" ───
	it("list on empty registry: exits 0 and output mentions no workspaces", async () => {
		// machineConfigDir exists but workspaces.yml does not — readWorkspacesIndex handles that.
		const result = await runCli(["workspace", "list"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/no workspaces/i);
	});

	// ── 4. list --plain on empty registry: exits 0, stdout is {"current":null,"workspaces":[]} ──
	it("list --plain on empty registry: exits 0 and emits empty JSON", async () => {
		const result = await runCli(["workspace", "list", "--plain"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);

		const parsed = JSON.parse(result.stdout.trim()) as unknown;
		expect(parsed).toEqual({ current: null, workspaces: [] });
	});

	// ── 5. switch <known-id>: exits 0, confirmation in stdout, current updates ─
	it("switch known-id: exits 0, stdout contains confirmation, registry current updates", async () => {
		const wsAPath = join(base, "workspace-a");
		const wsBPath = join(base, "workspace-b");
		await upsertWorkspaceEntry({ path: wsAPath, id: "ws-a" }, machineConfigDir);
		await upsertWorkspaceEntry({ path: wsBPath, id: "ws-b" }, machineConfigDir);
		await setCurrentWorkspaceId("ws-a", machineConfigDir);

		const result = await runCli(["workspace", "switch", "ws-b"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Switched to workspace ws-b");

		// Verify registry was updated
		const index = await readWorkspacesIndex(machineConfigDir);
		expect(index.current).toBe("ws-b");
	});

	// ── 6. switch <unknown-id>: exits 1, stderr contains error message ─────────
	it("switch unknown-id: exits 1 and stderr contains no-workspace error", async () => {
		const wsAPath = join(base, "workspace-a");
		await upsertWorkspaceEntry({ path: wsAPath, id: "ws-a" }, machineConfigDir);

		const result = await runCli(["workspace", "switch", "nonexistent"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('No workspace with id "nonexistent" in registry');
	});
});
