import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBacklogDirectory } from "./backlog-directory.ts";
import {
	getWorkspaceFilePath,
	matchWorkspaceByCwd,
	readCurrentWorkspaceName,
	resolveWorkspace,
	scanWorkspacesSync,
	setCurrentWorkspaceName,
	workspaceNameForRepo,
} from "./workspace-store.ts";

const TMP_BASE = join(import.meta.dir, "__tmp_workspace_store__");

let machineConfigDir: string;
let reposBase: string;
const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

async function writeWorkspace(name: string, repo: string, data: string, extra = ""): Promise<void> {
	await mkdir(join(machineConfigDir, "workspaces"), { recursive: true });
	await writeFile(
		getWorkspaceFilePath(name),
		`repo: ${repo}\ndata: ${data}\nproject_name: "${name}"\n${extra}`,
		"utf8",
	);
}

beforeEach(async () => {
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	machineConfigDir = join(TMP_BASE, `machine-config-${id}`);
	reposBase = join(TMP_BASE, `repos-${id}`);
	await mkdir(machineConfigDir, { recursive: true });
	await mkdir(reposBase, { recursive: true });
	process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
});

afterEach(async () => {
	if (origEnv === undefined) {
		delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
	} else {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
	}
	await rm(TMP_BASE, { recursive: true, force: true });
});

describe("scanWorkspacesSync", () => {
	it("returns [] when the workspaces dir is missing", () => {
		expect(scanWorkspacesSync()).toEqual([]);
	});

	it("parses repo/data from each yml file and skips invalid ones", async () => {
		await writeWorkspace("alpha", join(reposBase, "alpha"), join(reposBase, "alpha", "backlog"));
		await mkdir(join(machineConfigDir, "workspaces"), { recursive: true });
		await writeFile(getWorkspaceFilePath("broken"), "project_name: nope\n", "utf8");

		const records = scanWorkspacesSync();
		expect(records).toHaveLength(1);
		expect(records[0]?.name).toBe("alpha");
		expect(records[0]?.repo).toBe(join(reposBase, "alpha"));
		expect(records[0]?.data).toBe(join(reposBase, "alpha", "backlog"));
	});
});

describe("matchWorkspaceByCwd", () => {
	it("matches when cwd equals repo and when cwd is inside repo", () => {
		const records = [
			{ name: "a", filePath: "/x/a.yml", repo: "/repos/a", data: "/repos/a/backlog" },
			{ name: "b", filePath: "/x/b.yml", repo: "/repos/b", data: "/repos/b/backlog" },
		];
		expect(matchWorkspaceByCwd("/repos/a", records)?.name).toBe("a");
		expect(matchWorkspaceByCwd("/repos/a/src/deep", records)?.name).toBe("a");
		expect(matchWorkspaceByCwd("/elsewhere", records)).toBeNull();
	});

	it("deepest repo wins (git-style nested repos)", () => {
		const records = [
			{ name: "outer", filePath: "/x/outer.yml", repo: "/repos/mono", data: "/repos/mono/backlog" },
			{ name: "inner", filePath: "/x/inner.yml", repo: "/repos/mono/pkg", data: "/repos/mono/pkg/backlog" },
		];
		expect(matchWorkspaceByCwd("/repos/mono/pkg/src", records)?.name).toBe("inner");
		expect(matchWorkspaceByCwd("/repos/mono/other", records)?.name).toBe("outer");
	});

	it("does not match a sibling whose name is a string prefix", () => {
		const records = [{ name: "a", filePath: "/x/a.yml", repo: "/repos/app", data: "/repos/app/backlog" }];
		expect(matchWorkspaceByCwd("/repos/app-extra", records)).toBeNull();
	});
});

describe("resolveWorkspace", () => {
	it("prefers a cwd prefix match over current", async () => {
		await writeWorkspace("alpha", join(reposBase, "alpha"), join(reposBase, "alpha", "backlog"));
		await writeWorkspace("beta", join(reposBase, "beta"), join(reposBase, "beta", "backlog"));
		await setCurrentWorkspaceName("beta");

		const r = resolveWorkspace(join(reposBase, "alpha", "sub"));
		expect(r?.name).toBe("alpha");
	});

	it("falls back to current when cwd matches nothing", async () => {
		await writeWorkspace("beta", join(reposBase, "beta"), join(reposBase, "beta", "backlog"));
		await setCurrentWorkspaceName("beta");

		const r = resolveWorkspace(join(reposBase, "unrelated"));
		expect(r?.name).toBe("beta");
	});

	it("returns null when neither cwd nor current resolve", async () => {
		await writeWorkspace("beta", join(reposBase, "beta"), join(reposBase, "beta", "backlog"));
		expect(resolveWorkspace(join(reposBase, "unrelated"))).toBeNull();
	});
});

describe("readCurrentWorkspaceName / setCurrentWorkspaceName", () => {
	it("round-trips current via config.yml", async () => {
		expect(readCurrentWorkspaceName()).toBeNull();
		await setCurrentWorkspaceName("gamma");
		expect(readCurrentWorkspaceName()).toBe("gamma");
		await setCurrentWorkspaceName(null);
		expect(readCurrentWorkspaceName()).toBeNull();
	});
});

describe("resolveBacklogDirectory (new model)", () => {
	it("maps the matched workspace into the legacy resolution shape", async () => {
		const repo = join(reposBase, "alpha");
		const data = join(repo, "backlog");
		await writeWorkspace("alpha", repo, data);

		const res = resolveBacklogDirectory(join(repo, "src"));
		expect(res.projectRoot).toBe(repo);
		expect(res.backlogPath).toBe(data);
		expect(res.configPath).toBe(getWorkspaceFilePath("alpha"));
		expect(res.backlogDir).toBe("backlog");
		expect(res.configSource).toBe("folder");
		expect(res.source).toBe("custom");
		expect(res.rootConfigExists).toBe(false);
	});

	it("returns all-null when no workspace resolves (no throw)", () => {
		const res = resolveBacklogDirectory(join(reposBase, "nope"));
		expect(res.backlogPath).toBeNull();
		expect(res.configPath).toBeNull();
		expect(res.source).toBeNull();
	});
});

describe("workspaceNameForRepo", () => {
	it("uses the repo basename", () => {
		expect(workspaceNameForRepo("/Users/me/code/backlog.md")).toBe("backlog.md");
	});
});

describe("init smoke: initializeProject → resolveBacklogDirectory round-trips", () => {
	it("writes a per-repo yml that resolves back to the repo", async () => {
		const { Core } = await import("../core/backlog.ts");
		const { initializeProject } = await import("../core/init.ts");
		const repoDir = join(reposBase, "smoke-repo");
		await mkdir(repoDir, { recursive: true });

		const core = new Core(repoDir);
		await initializeProject(core, {
			projectName: "smoke",
			integrationMode: "none",
			existingConfig: null,
		});

		const res = resolveBacklogDirectory(repoDir);
		expect(res.backlogPath).toBe(join(repoDir, "backlog"));
		expect(res.configPath).toBe(getWorkspaceFilePath(workspaceNameForRepo(repoDir)));
		expect(res.projectRoot).toBe(repoDir);

		// Re-init must preserve a custom data dir written on first init.
		const customRepo = join(reposBase, "custom-data-repo");
		await mkdir(customRepo, { recursive: true });
		const customCore = new Core(customRepo);
		await initializeProject(customCore, {
			projectName: "custom",
			dataDir: ".backlog",
			integrationMode: "none",
			existingConfig: null,
		});
		expect(resolveBacklogDirectory(customRepo).backlogPath).toBe(join(customRepo, ".backlog"));
		const reCore = new Core(customRepo);
		const existing = await reCore.filesystem.loadConfig();
		await initializeProject(reCore, {
			projectName: "custom",
			integrationMode: "none",
			existingConfig: existing,
		});
		expect(resolveBacklogDirectory(customRepo).backlogPath).toBe(join(customRepo, ".backlog"));
	});

	it("rejects a workspace name that already maps to a different repo", async () => {
		const { Core } = await import("../core/backlog.ts");
		const { initializeProject } = await import("../core/init.ts");

		const repoA = join(reposBase, "shared-name");
		await mkdir(repoA, { recursive: true });
		await initializeProject(new Core(repoA), {
			projectName: "shared",
			integrationMode: "none",
			existingConfig: null,
		});

		// A different repo whose basename collides with the first workspace name.
		const repoB = join(reposBase, "other", "shared-name");
		await mkdir(repoB, { recursive: true });
		await expect(
			initializeProject(new Core(repoB), {
				projectName: "shared",
				integrationMode: "none",
				existingConfig: null,
			}),
		).rejects.toThrow(/already maps to a different repo/);

		// `--name` (workspaceName) override disambiguates and succeeds.
		await initializeProject(new Core(repoB), {
			projectName: "shared",
			workspaceName: "shared-name-2",
			integrationMode: "none",
			existingConfig: null,
		});
		expect(resolveBacklogDirectory(repoB).configPath).toBe(getWorkspaceFilePath("shared-name-2"));
	});
});
