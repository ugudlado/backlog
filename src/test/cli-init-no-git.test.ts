import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { initializeProject } from "../core/init.ts";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function initFilesystemOnlyProject(projectName = "No Git Project"): Promise<Core> {
	const result = await $`bun ${CLI_PATH} init ${projectName} --no-git --defaults --local --integration-mode none`
		.cwd(TEST_DIR)
		.quiet();
	expect(result.exitCode).toBe(0);
	return new Core(TEST_DIR);
}

describe("CLI init without Git", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-init-no-git");
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("initializes a filesystem-only project without creating a Git repository", async () => {
		const result =
			await $`bun ${CLI_PATH} init "Filesystem Project" --no-git --defaults --local --integration-mode none`
				.cwd(TEST_DIR)
				.quiet();

		expect(result.exitCode).toBe(0);
		expect(await pathExists(join(TEST_DIR, ".git"))).toBe(false);

		const core = new Core(TEST_DIR);
		const config = await core.filesystem.loadConfig();

		expect(config?.projectName).toBe("Filesystem Project");
		expect(config?.checkActiveBranches).toBe(false);
		expect(config?.remoteOperations).toBe(false);
		expect(config?.bypassGitHooks).toBe(false);
		expect(config?.filesystemOnly).toBe(true);
		expect(result.stdout.toString()).toContain("Git integration: disabled (filesystem-only)");
	});

	test("shared init enforces Git-disabled config when filesystemOnly is requested", async () => {
		const core = new Core(TEST_DIR);

		await initializeProject(core, {
			projectName: "Core Filesystem Project",
			integrationMode: "none",
			filesystemOnly: true,
			advancedConfig: {
				checkActiveBranches: true,
				remoteOperations: true,
				bypassGitHooks: true,
			},
		});

		const config = await core.filesystem.loadConfig();

		expect(config?.checkActiveBranches).toBe(false);
		expect(config?.remoteOperations).toBe(false);
		expect(config?.bypassGitHooks).toBe(false);
		expect(config?.filesystemOnly).toBe(true);
		expect(await pathExists(join(TEST_DIR, ".git"))).toBe(false);
	});

	test("local task and milestone flows work without Git", async () => {
		const core = await initFilesystemOnlyProject();

		expect(await core.gitOps.listAllBranches()).toEqual([]);
		expect(await core.gitOps.listRecentBranches(30)).toEqual([]);
		expect(await core.gitOps.hasAnyRemote()).toBe(false);

		const taskResult = await $`bun ${CLI_PATH} task create "No Git Task" --plain`.cwd(TEST_DIR).quiet();
		expect(taskResult.exitCode).toBe(0);
		expect(taskResult.stdout.toString()).toContain("Task TASK-1 - No Git Task");

		const milestone = await core.filesystem.createMilestone("No Git Milestone");
		const archiveMilestoneResult = await core.archiveMilestone(milestone.id);
		expect(archiveMilestoneResult.success).toBe(true);

		const tasks = await core.loadTasks();
		const archivedMilestones = await core.filesystem.listArchivedMilestones();

		expect(tasks.map((task) => task.title)).toContain("No Git Task");
		expect(archivedMilestones.map((item) => item.title)).toContain("No Git Milestone");
		expect(await core.gitOps.getStatus()).toBe("");
	});

	test("init scaffolds only tasks, milestones, archive, completed — no drafts/docs/decisions dirs", async () => {
		const core = new Core(TEST_DIR);
		await initializeProject(core, {
			projectName: "Structure Test",
			integrationMode: "none",
			filesystemOnly: true,
		});

		const backlogDir = join(TEST_DIR, "backlog");
		expect(await pathExists(join(backlogDir, "tasks"))).toBe(true);
		expect(await pathExists(join(backlogDir, "milestones"))).toBe(true);
		expect(await pathExists(join(backlogDir, "archive"))).toBe(true);
		expect(await pathExists(join(backlogDir, "completed"))).toBe(true);
		expect(await pathExists(join(backlogDir, "config.yml"))).toBe(true);
		// Removed surfaces must not be scaffolded
		expect(await pathExists(join(backlogDir, "drafts"))).toBe(false);
		expect(await pathExists(join(backlogDir, "docs"))).toBe(false);
		expect(await pathExists(join(backlogDir, "decisions"))).toBe(false);
		expect(await pathExists(join(backlogDir, "archive", "drafts"))).toBe(false);
	});

	test("filesystem-only mode ignores stale Git branches before explicit config loading", async () => {
		await $`git init -b main`.cwd(TEST_DIR).quiet();
		await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();
		await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
		await Bun.write(join(TEST_DIR, "README.md"), "parent repo\n");
		await $`git add README.md`.cwd(TEST_DIR).quiet();
		await $`git commit -m initial`.cwd(TEST_DIR).quiet();

		await $`git checkout -b stale-backlog`.cwd(TEST_DIR).quiet();
		await mkdir(join(TEST_DIR, "backlog", "docs"), { recursive: true });
		await mkdir(join(TEST_DIR, "backlog", "decisions"), { recursive: true });
		await Bun.write(join(TEST_DIR, "backlog", "docs", "doc-8 - stale.md"), "# stale\n");
		await Bun.write(join(TEST_DIR, "backlog", "decisions", "decision-8 - stale.md"), "# stale\n");
		await $`git add backlog`.cwd(TEST_DIR).quiet();
		await $`git commit -m "add stale backlog ids"`.cwd(TEST_DIR).quiet();
		await $`git checkout main`.cwd(TEST_DIR).quiet();

		const core = await initFilesystemOnlyProject("Nested No Git Project");

		expect(await core.gitOps.listAllBranches()).toEqual([]);
		expect(await core.gitOps.listRecentBranches(30)).toEqual([]);

		const taskResult = await $`bun ${CLI_PATH} task create "Fresh Task" --plain`.cwd(TEST_DIR).quiet();
		expect(taskResult.exitCode).toBe(0);
		expect(taskResult.stdout.toString()).toContain("Task TASK-1 - Fresh Task");
	});
});
