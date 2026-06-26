/**
 * CLI integration tests for `backlog project list [--plain]` and
 * `backlog project switch <name>`. These operate on global-store projects
 * (discovered by scanning <globalStore>/*), not the local registry.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspacesIndex, setCurrentWorkspaceId } from "../utils/workspaces-index.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

function tmpRoot(label: string): string {
	return join(tmpdir(), `project-list-switch-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

/** Create a global-store project slot (flat config.yml + tasks/) with a given id. */
async function makeSlot(globalStoreDir: string, name: string, id: string): Promise<void> {
	const slot = join(globalStoreDir, name);
	await mkdir(join(slot, "tasks"), { recursive: true });
	await writeFile(join(slot, "config.yml"), `id: "${id}"\nproject_name: "${name}"\nstatuses: ["To Do", "Done"]\n`);
}

describe("backlog project list + switch CLI integration", () => {
	let base: string;
	let machineConfigDir: string;
	let globalStoreDir: string;
	let env: NodeJS.ProcessEnv;
	const origMachineConfig = process.env.BACKLOG_MACHINE_CONFIG_DIR;

	beforeEach(async () => {
		base = tmpRoot("suite");
		machineConfigDir = join(base, ".config", "backlog");
		globalStoreDir = join(base, "store");
		await mkdir(machineConfigDir, { recursive: true });
		await mkdir(globalStoreDir, { recursive: true });
		await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
		env = { BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir };
		// In-process helpers (setCurrentWorkspaceId / readWorkspacesIndex below)
		// read the machine config from this env var, so point it at the test dir.
		process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
		const { clearMachineConfigCache } = await import("../utils/machine-config.ts");
		clearMachineConfigCache();
	});

	afterEach(async () => {
		if (origMachineConfig === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = origMachineConfig;
		const { clearMachineConfigCache } = await import("../utils/machine-config.ts");
		clearMachineConfigCache();
		await rm(base, { recursive: true, force: true });
	});

	it("list shows both projects; current is marked *; exits 0", async () => {
		await makeSlot(globalStoreDir, "Alpha", "alpha-1");
		await makeSlot(globalStoreDir, "Beta", "beta-2");
		await setCurrentWorkspaceId("alpha-1", machineConfigDir);

		const result = await runCli(["project", "list"], env);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Alpha");
		expect(result.stdout).toContain("Beta");
		expect(result.stdout).toMatch(/^\*\s+Alpha\b/m);
		expect(result.stdout).toMatch(/^ +Beta\b/m);
	});

	it("list --plain emits JSON of the scanned projects", async () => {
		await makeSlot(globalStoreDir, "Alpha", "alpha-1");
		await makeSlot(globalStoreDir, "Beta", "beta-2");
		await setCurrentWorkspaceId("alpha-1", machineConfigDir);

		const result = await runCli(["project", "list", "--plain"], env);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout.trim()) as {
			current: string | null;
			projects: Array<{ id: string; name: string }>;
		};
		expect(parsed.current).toBe("alpha-1");
		const sorted = [...parsed.projects].sort((a, b) => a.id.localeCompare(b.id));
		expect(sorted).toEqual([
			{ id: "alpha-1", name: "Alpha" },
			{ id: "beta-2", name: "Beta" },
		]);
	});

	it("list with no projects: exits 0 and suggests init", async () => {
		const result = await runCli(["project", "list"], env);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/no projects/i);
	});

	it("switch by name: exits 0, confirms, current updates", async () => {
		await makeSlot(globalStoreDir, "Alpha", "alpha-1");
		await makeSlot(globalStoreDir, "Beta", "beta-2");
		await setCurrentWorkspaceId("alpha-1", machineConfigDir);

		const result = await runCli(["project", "switch", "Beta"], env);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Switched to project Beta");

		const index = await readWorkspacesIndex(machineConfigDir);
		expect(index.current).toBe("beta-2");
	});

	it("switch unknown name: exits 1 with error", async () => {
		await makeSlot(globalStoreDir, "Alpha", "alpha-1");
		const result = await runCli(["project", "switch", "Ghost"], env);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('No project named "Ghost"');
	});
});
