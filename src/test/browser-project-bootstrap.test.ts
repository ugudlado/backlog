import { describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	ensureWorkspacesFileExists,
	getMachineConfigDir,
	getWorkspacesFilePath,
	readWorkspacesIndex,
	upsertWorkspaceEntry,
	writeWorkspacesIndex,
} from "../utils/workspaces-index.ts";

describe("ensureWorkspacesFileExists", () => {
	it("creates an empty workspaces.yml when missing", async () => {
		const base = join(process.cwd(), `tmp-ensure-ws-${Date.now()}`);
		const prevMachine = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = join(base, ".config", "backlog.md");
		try {
			await ensureWorkspacesFileExists();
			const content = await readFile(getWorkspacesFilePath(), "utf8");
			expect(content).toContain("workspaces:");
			const parsed = await readWorkspacesIndex();
			expect(parsed.workspaces).toEqual([]);
		} finally {
			if (prevMachine === undefined) {
				delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
			} else {
				process.env.BACKLOG_MACHINE_CONFIG_DIR = prevMachine;
			}
			await rm(base, { recursive: true, force: true });
		}
	});

	it("leaves existing entries alone (idempotent)", async () => {
		const base = join(process.cwd(), `tmp-ensure-ws-idem-${Date.now()}`);
		const prevMachine = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = join(base, ".config", "backlog.md");
		try {
			await mkdir(process.env.BACKLOG_MACHINE_CONFIG_DIR, { recursive: true });
			await writeWorkspacesIndex({ workspaces: [{ path: "/some/repo" }] });
			await ensureWorkspacesFileExists();
			const parsed = await readWorkspacesIndex();
			expect(parsed.workspaces).toEqual([{ path: "/some/repo" }]);
		} finally {
			if (prevMachine === undefined) {
				delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
			} else {
				process.env.BACKLOG_MACHINE_CONFIG_DIR = prevMachine;
			}
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("machine-config-dir override precedence", () => {
	it("explicit override beats env var beats default", () => {
		const prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		try {
			process.env.BACKLOG_MACHINE_CONFIG_DIR = "/from/env";
			expect(getMachineConfigDir("/from/explicit")).toBe("/from/explicit");
			expect(getMachineConfigDir()).toBe("/from/env");
			delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
			expect(getMachineConfigDir()).toMatch(/\.config\/backlog\.md$/);
		} finally {
			if (prev === undefined) {
				delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
			} else {
				process.env.BACKLOG_MACHINE_CONFIG_DIR = prev;
			}
		}
	});

	it("override threads through write/read/upsert without touching env or default paths", async () => {
		const base = join(process.cwd(), `tmp-override-thread-${Date.now()}`);
		const overrideDir = join(base, "config-override");
		const prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		// Set env to a wildly different path to prove the explicit override wins.
		process.env.BACKLOG_MACHINE_CONFIG_DIR = join(base, "config-from-env");
		try {
			await mkdir(overrideDir, { recursive: true });
			await ensureWorkspacesFileExists(overrideDir);
			await upsertWorkspaceEntry({ path: "/projects/alpha" }, overrideDir);

			// File landed under the override, not the env path.
			const overrideFile = await readFile(getWorkspacesFilePath(overrideDir), "utf8");
			expect(overrideFile).toContain("/projects/alpha");

			// Env path was never touched.
			const envFilePath = getWorkspacesFilePath();
			expect(readFile(envFilePath, "utf8")).rejects.toThrow();

			// Read with override returns the entry; read without override goes to env path → empty.
			const overrideRead = await readWorkspacesIndex(overrideDir);
			expect(overrideRead.workspaces).toEqual([{ path: "/projects/alpha" }]);
			const envRead = await readWorkspacesIndex();
			expect(envRead.workspaces).toEqual([]);
		} finally {
			if (prev === undefined) {
				delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
			} else {
				process.env.BACKLOG_MACHINE_CONFIG_DIR = prev;
			}
			await rm(base, { recursive: true, force: true });
		}
	});
});
