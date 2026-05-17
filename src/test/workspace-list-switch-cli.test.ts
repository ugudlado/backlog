/**
 * CLI integration tests for `backlog workspace list [--plain]` and
 * `backlog workspace use|switch <name>` under the per-repo workspace model.
 *
 * A workspace exists iff its `<machineConfigDir>/workspaces/<name>.yml` file
 * exists; the workspace name is the yml basename. `current:` lives in
 * `<machineConfigDir>/config.yml` and is set via `workspace use`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkspaceFilePath, readCurrentWorkspaceName, setCurrentWorkspaceName } from "../utils/workspace-store.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

/** Creates a unique temp directory path (does NOT mkdir). */
function tmpRoot(label: string): string {
	return join(tmpdir(), `ws-list-switch-cli-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

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

/** Writes a per-repo workspace yml under the isolated machine config dir. */
async function seedWorkspace(machineConfigDir: string, name: string, repo: string, data: string): Promise<void> {
	await mkdir(join(machineConfigDir, "workspaces"), { recursive: true });
	await writeFile(
		getWorkspaceFilePath(name, machineConfigDir),
		`repo: ${JSON.stringify(repo)}\ndata: ${JSON.stringify(data)}\nproject_name: "${name}"\n`,
		"utf8",
	);
}

describe("backlog workspace list + use CLI integration", () => {
	let base: string;
	let machineConfigDir: string;

	beforeEach(async () => {
		base = tmpRoot("suite");
		machineConfigDir = join(base, ".config", "backlog");
		await mkdir(machineConfigDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it("list with two entries: stdout contains both names; current is marked *; exits 0", async () => {
		const wsARepo = join(base, "workspace-a");
		const wsBRepo = join(base, "workspace-b");
		await seedWorkspace(machineConfigDir, "ws-a", wsARepo, join(wsARepo, "backlog"));
		await seedWorkspace(machineConfigDir, "ws-b", wsBRepo, join(wsBRepo, "backlog"));
		await setCurrentWorkspaceName("ws-a", machineConfigDir);

		const result = await runCli(["workspace", "list"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("ws-a");
		expect(result.stdout).toContain("ws-b");
		// The current entry must be preceded by *
		expect(result.stdout).toMatch(/^\*\s+ws-a\b/m);
		// The non-current entry must be preceded by a space marker, not *
		expect(result.stdout).toMatch(/^ +ws-b\b/m);
	});

	it("list --plain with two entries: stdout is JSON matching seeded data", async () => {
		const wsARepo = join(base, "workspace-a");
		const wsBRepo = join(base, "workspace-b");
		await seedWorkspace(machineConfigDir, "ws-a", wsARepo, join(wsARepo, "backlog"));
		await seedWorkspace(machineConfigDir, "ws-b", wsBRepo, join(wsBRepo, "backlog"));
		await setCurrentWorkspaceName("ws-a", machineConfigDir);

		const result = await runCli(["workspace", "list", "--plain"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);

		const parsed = JSON.parse(result.stdout.trim()) as {
			current: string | null;
			workspaces: Array<{ name: string; repo: string; data: string; file: string }>;
		};
		expect(parsed.current).toBe("ws-a");
		expect(parsed.workspaces).toHaveLength(2);

		const sorted = [...parsed.workspaces].sort((a, b) => a.name.localeCompare(b.name));
		expect(sorted[0]?.name).toBe("ws-a");
		expect(sorted[0]?.repo).toBe(wsARepo);
		expect(sorted[1]?.name).toBe("ws-b");
		expect(sorted[1]?.repo).toBe(wsBRepo);
	});

	it("list on empty registry: exits 0 and output mentions no workspaces", async () => {
		const result = await runCli(["workspace", "list"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/no workspaces/i);
	});

	it("list --plain on empty registry: exits 0 and emits empty JSON", async () => {
		const result = await runCli(["workspace", "list", "--plain"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);

		const parsed = JSON.parse(result.stdout.trim()) as unknown;
		expect(parsed).toEqual({ current: null, workspaces: [] });
	});

	it("use known name: exits 0, stdout confirms, config.yml current updates", async () => {
		const wsARepo = join(base, "workspace-a");
		const wsBRepo = join(base, "workspace-b");
		await seedWorkspace(machineConfigDir, "ws-a", wsARepo, join(wsARepo, "backlog"));
		await seedWorkspace(machineConfigDir, "ws-b", wsBRepo, join(wsBRepo, "backlog"));
		await setCurrentWorkspaceName("ws-a", machineConfigDir);

		const result = await runCli(["workspace", "use", "ws-b"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Switched to workspace ws-b");
		expect(readCurrentWorkspaceName(machineConfigDir)).toBe("ws-b");
	});

	it("switch alias behaves like use", async () => {
		const wsARepo = join(base, "workspace-a");
		const wsBRepo = join(base, "workspace-b");
		await seedWorkspace(machineConfigDir, "ws-a", wsARepo, join(wsARepo, "backlog"));
		await seedWorkspace(machineConfigDir, "ws-b", wsBRepo, join(wsBRepo, "backlog"));
		await setCurrentWorkspaceName("ws-a", machineConfigDir);

		const result = await runCli(["workspace", "switch", "ws-b"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(0);
		expect(readCurrentWorkspaceName(machineConfigDir)).toBe("ws-b");
	});

	it("use unknown name: exits 1 and stderr contains a no-workspace error", async () => {
		const wsARepo = join(base, "workspace-a");
		await seedWorkspace(machineConfigDir, "ws-a", wsARepo, join(wsARepo, "backlog"));

		const result = await runCli(["workspace", "use", "nonexistent"], {
			BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('No workspace named "nonexistent"');
	});
});
