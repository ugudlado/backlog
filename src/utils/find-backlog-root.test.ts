import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearProjectRootCache, findBacklogRoot, getProjectRoot } from "./find-backlog-root.ts";
import { getWorkspaceFilePath, setCurrentWorkspaceName } from "./workspace-store.ts";

/**
 * `findBacklogRoot` is still exported and still resolves the project root, but
 * the implementation changed: it no longer walks the filesystem looking for a
 * `backlog/` folder or `backlog.config.yml`. It now delegates to
 * `resolveBacklogDirectory` (deepest `repo:` prefix match, then the `current:`
 * workspace) and returns the matched `repo:` path, or null when nothing
 * resolves. These tests assert that new contract.
 */

const TMP_BASE = join(import.meta.dir, "__tmp_find_backlog_root__");

let machineConfigDir: string;
let reposBase: string;
const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

async function writeWorkspace(name: string, repo: string, data: string): Promise<void> {
	await mkdir(join(machineConfigDir, "workspaces"), { recursive: true });
	await writeFile(getWorkspaceFilePath(name), `repo: ${repo}\ndata: ${data}\nproject_name: "${name}"\n`, "utf8");
}

beforeEach(async () => {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	machineConfigDir = join(TMP_BASE, `machine-config-${id}`);
	reposBase = join(TMP_BASE, `repos-${id}`);
	await mkdir(machineConfigDir, { recursive: true });
	await mkdir(reposBase, { recursive: true });
	process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
	clearProjectRootCache();
});

afterEach(async () => {
	clearProjectRootCache();
	if (origEnv === undefined) {
		delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
	} else {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
	}
	await rm(TMP_BASE, { recursive: true, force: true });
});

describe("findBacklogRoot (workspace resolution)", () => {
	it("returns the repo root when cwd is the registered repo", async () => {
		const repo = join(reposBase, "alpha");
		await writeWorkspace("alpha", repo, join(repo, "backlog"));
		expect(await findBacklogRoot(repo)).toBe(repo);
	});

	it("returns the repo root when called from a subdirectory of the repo", async () => {
		const repo = join(reposBase, "alpha");
		await writeWorkspace("alpha", repo, join(repo, "backlog"));
		expect(await findBacklogRoot(join(repo, "src", "deep"))).toBe(repo);
	});

	it("deepest repo wins for nested workspaces", async () => {
		const outer = join(reposBase, "mono");
		const inner = join(outer, "pkg");
		await writeWorkspace("outer", outer, join(outer, "backlog"));
		await writeWorkspace("inner", inner, join(inner, "backlog"));
		expect(await findBacklogRoot(join(inner, "src"))).toBe(inner);
		expect(await findBacklogRoot(join(outer, "other"))).toBe(outer);
	});

	it("falls back to the current workspace when cwd matches nothing", async () => {
		const repo = join(reposBase, "beta");
		await writeWorkspace("beta", repo, join(repo, "backlog"));
		await setCurrentWorkspaceName("beta");
		expect(await findBacklogRoot(join(reposBase, "unrelated"))).toBe(repo);
	});

	it("returns null when neither cwd nor current resolve", async () => {
		await writeWorkspace("beta", join(reposBase, "beta"), join(reposBase, "beta", "backlog"));
		expect(await findBacklogRoot(join(reposBase, "unrelated"))).toBeNull();
	});
});

describe("getProjectRoot / clearProjectRootCache", () => {
	it("caches the resolved root until the cache is cleared", async () => {
		const repo = join(reposBase, "alpha");
		await writeWorkspace("alpha", repo, join(repo, "backlog"));

		expect(await getProjectRoot(repo)).toBe(repo);

		// Remove the workspace; cached value must persist until cleared.
		await rm(join(machineConfigDir, "workspaces"), { recursive: true, force: true });
		expect(await getProjectRoot(repo)).toBe(repo);

		clearProjectRootCache();
		expect(await getProjectRoot(repo)).toBeNull();
	});
});
