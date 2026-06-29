/**
 * CLI integration tests for `backlog project list [--plain]` and
 * `backlog project switch <name>`. These operate on global-store projects
 * (discovered by scanning <globalStore>/*), not the local registry.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectsIndex, setCurrentProjectId } from "../utils/projects-index.ts";

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
		// In-process helpers (setCurrentProjectId / readProjectsIndex below)
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
		await setCurrentProjectId("alpha-1", machineConfigDir);

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
		await setCurrentProjectId("alpha-1", machineConfigDir);

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
		await setCurrentProjectId("alpha-1", machineConfigDir);

		const result = await runCli(["project", "switch", "Beta"], env);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Switched to project Beta");

		const index = await readProjectsIndex(machineConfigDir);
		expect(index.current).toBe("beta-2");
	});

	it("switch unknown name: exits 1 with error", async () => {
		await makeSlot(globalStoreDir, "Alpha", "alpha-1");
		const result = await runCli(["project", "switch", "Ghost"], env);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('No project named "Ghost"');
	});
});

describe("backlog project list/switch in remote mode", () => {
	let base: string;
	let cliConfigDir: string;
	let serverConfigDir: string;
	let serverStore: string;
	let server: import("../server/index.ts").BacklogServer;
	const port = 7671;
	let env: NodeJS.ProcessEnv;
	const origMachineConfig = process.env.BACKLOG_MACHINE_CONFIG_DIR;

	beforeEach(async () => {
		base = tmpRoot("remote");
		// The server (in-process) and the CLI subprocess get SEPARATE machine
		// configs so the server lists its own isolated global store, not the dev
		// machine's. The CLI config has backlog_url (remote mode); the server
		// config has a globalStore holding one slot.
		cliConfigDir = join(base, "cli-config");
		serverConfigDir = join(base, "server-config");
		serverStore = join(base, "server-store");
		await mkdir(cliConfigDir, { recursive: true });
		await mkdir(serverConfigDir, { recursive: true });
		await mkdir(serverStore, { recursive: true });
		await makeSlot(serverStore, "RemoteProj", "remoteproj-1");

		await writeFile(join(cliConfigDir, "config.yml"), `backlog_url: http://localhost:${port}\nclient_token: secret\n`);
		await writeFile(join(serverConfigDir, "config.yml"), `globalStore: ${serverStore}\n`);
		env = { BACKLOG_MACHINE_CONFIG_DIR: cliConfigDir, BACKLOG_TOKEN: "secret" };

		// Point THIS process (the server) at the server config + token.
		process.env.BACKLOG_MACHINE_CONFIG_DIR = serverConfigDir;
		process.env.BACKLOG_TOKEN = "secret";
		const { clearMachineConfigCache } = await import("../utils/machine-config.ts");
		clearMachineConfigCache();
		const { BacklogServer } = await import("../server/index.ts");
		server = new BacklogServer(join(serverStore, "RemoteProj"));
		await server.start(port, false);
	});

	afterEach(async () => {
		await server.stop();
		delete process.env.BACKLOG_TOKEN;
		if (origMachineConfig === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = origMachineConfig;
		const { clearMachineConfigCache } = await import("../utils/machine-config.ts");
		clearMachineConfigCache();
		await rm(base, { recursive: true, force: true });
	});

	it("list shows the server's project, not local global-store ones", async () => {
		const result = await runCli(["project", "list", "--plain"], env);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		// The server's single global-store project is listed (name = path basename).
		expect(parsed.projects.some((p: { name: string }) => p.name === "RemoteProj")).toBe(true);
	});

	it("create is blocked in remote mode", async () => {
		const result = await runCli(["project", "create", "Foo"], env);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not supported in remote mode");
	});

	it("delete is blocked in remote mode", async () => {
		const result = await runCli(["project", "delete", "Foo"], env);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not supported in remote mode");
	});
});
