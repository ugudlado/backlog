/**
 * Tests for `registerWorkspaceAtPath` / `readWorkspacesWithIds` under the
 * per-repo workspace model.
 *
 * A workspace exists iff its `<machineConfigDir>/workspaces/<name>.yml` exists.
 * "Registration" no longer mints ids or writes an index — it just validates
 * that the path is a directory that resolves to a registered workspace and
 * returns its identity (`{ id: <name>, path: <repo> }`). The old
 * `mintWorkspaceId` / `workspaces.yml` index / id-backfill logic was removed by
 * the workspace-resolution-simplification change.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	readWorkspacesWithIds,
	registerWorkspaceAtPath,
	WorkspaceRegistrationError,
} from "../utils/workspace-registration.ts";
import { getWorkspaceFilePath, workspaceNameForRepo } from "../utils/workspace-store.ts";

const tmpRoot = (label: string) =>
	join(process.cwd(), `tmp-ws-fixes-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

/** Creates a repo dir and registers a per-repo workspace yml for it. */
async function makeWorkspace(machineConfigDir: string, repo: string, projectName: string): Promise<string> {
	const absRepo = resolve(repo);
	await mkdir(join(absRepo, "backlog"), { recursive: true });
	const name = workspaceNameForRepo(absRepo);
	await mkdir(join(machineConfigDir, "workspaces"), { recursive: true });
	await writeFile(
		getWorkspaceFilePath(name, machineConfigDir),
		`repo: ${JSON.stringify(absRepo)}\ndata: ${JSON.stringify(join(absRepo, "backlog"))}\nproject_name: "${projectName}"\n`,
		"utf8",
	);
	return name;
}

describe("registerWorkspaceAtPath error codes", () => {
	let base: string;
	let machineConfigDir: string;
	let prev: string | undefined;
	beforeEach(async () => {
		base = tmpRoot("reg");
		machineConfigDir = join(base, ".config", "backlog");
		await mkdir(machineConfigDir, { recursive: true });
		prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
	});
	afterEach(async () => {
		if (prev === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = prev;
		await rm(base, { recursive: true, force: true });
	});

	it("throws not_a_directory for a missing path", async () => {
		const missing = join(base, "missing");
		let caught: unknown;
		try {
			await registerWorkspaceAtPath(missing);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WorkspaceRegistrationError);
		expect((caught as WorkspaceRegistrationError).code).toBe("not_a_directory");
	});

	it("throws no_backlog_config for a directory with no registered workspace", async () => {
		const dir = join(base, "empty");
		await mkdir(dir, { recursive: true });
		let caught: unknown;
		try {
			await registerWorkspaceAtPath(dir);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WorkspaceRegistrationError);
		expect((caught as WorkspaceRegistrationError).code).toBe("no_backlog_config");
	});

	it("returns the workspace identity when a registered workspace resolves at the path", async () => {
		const repo = join(base, "valid");
		const name = await makeWorkspace(machineConfigDir, repo, "Valid Project");
		const result = await registerWorkspaceAtPath(repo);
		expect(result.entry.id).toBe(name);
		expect(result.entry.path).toBe(resolve(repo));
	});
});

describe("readWorkspacesWithIds", () => {
	let base: string;
	let machineConfigDir: string;
	let prev: string | undefined;
	beforeEach(async () => {
		base = tmpRoot("ids");
		machineConfigDir = join(base, ".config", "backlog");
		await mkdir(machineConfigDir, { recursive: true });
		prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
	});
	afterEach(async () => {
		if (prev === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = prev;
		await rm(base, { recursive: true, force: true });
	});

	it("lists every registered workspace as { id (name), path (repo) }", async () => {
		const a = join(base, "alpha");
		const b = join(base, "bravo");
		const nameA = await makeWorkspace(machineConfigDir, a, "Alpha");
		const nameB = await makeWorkspace(machineConfigDir, b, "Bravo");

		const entries = await readWorkspacesWithIds();
		const byId = new Map(entries.map((e) => [e.id, e.path]));
		expect(byId.get(nameA)).toBe(resolve(a));
		expect(byId.get(nameB)).toBe(resolve(b));
		expect(entries).toHaveLength(2);
	});

	it("returns [] when no workspaces are registered", async () => {
		expect(await readWorkspacesWithIds()).toEqual([]);
	});
});
