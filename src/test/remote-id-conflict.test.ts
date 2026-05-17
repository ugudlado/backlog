import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../index.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;
let REMOTE_DIR: string;
let LOCAL_DIR: string;
// This suite uses beforeAll, but the global test preload rotates
// BACKLOG_MACHINE_CONFIG_DIR before every test. Pin a stable per-suite machine
// config dir so the workspace registered in beforeAll survives into the tests.
let SUITE_MC_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

async function initRepo(dir: string) {
	await $`git init -b main`.cwd(dir).quiet();
	await $`git config user.name Test`.cwd(dir).quiet();
	await $`git config user.email test@example.com`.cwd(dir).quiet();
}

describe("next id across remote branches", () => {
	beforeAll(async () => {
		TEST_DIR = createUniqueTestDir("test-remote-id");
		REMOTE_DIR = join(TEST_DIR, "remote.git");
		LOCAL_DIR = join(TEST_DIR, "local");
		SUITE_MC_DIR = join(TEST_DIR, ".machine-config");
		await mkdir(SUITE_MC_DIR, { recursive: true });
		process.env.BACKLOG_MACHINE_CONFIG_DIR = SUITE_MC_DIR;
		await mkdir(REMOTE_DIR, { recursive: true });
		await $`git init --bare -b main`.cwd(REMOTE_DIR).quiet();
		await mkdir(LOCAL_DIR, { recursive: true });
		await initRepo(LOCAL_DIR);
		await $`git remote add origin ${REMOTE_DIR}`.cwd(LOCAL_DIR).quiet();

		const core = new Core(LOCAL_DIR);
		await initializeTestProject(core, "Remote Test", true);
		await core.ensureConfigMigrated();
		await $`git branch -M main`.cwd(LOCAL_DIR).quiet();
		await $`git push -u origin main`.cwd(LOCAL_DIR).quiet();

		await $`git checkout -b feature`.cwd(LOCAL_DIR).quiet();
		await core.createTask(
			{
				id: "task-1",
				title: "Remote Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "",
			},
			true,
		);
		await $`git push -u origin feature`.cwd(LOCAL_DIR).quiet();
		await $`git checkout main`.cwd(LOCAL_DIR).quiet();
	});

	afterAll(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	it("uses id after highest remote task", async () => {
		// The preload rotated the env var before this test; restore the suite's
		// pinned machine config dir so the workspace from beforeAll resolves.
		process.env.BACKLOG_MACHINE_CONFIG_DIR = SUITE_MC_DIR;
		const result = await $`bun ${CLI_PATH} task create "Local Task"`
			.cwd(LOCAL_DIR)
			.env({ ...process.env, BACKLOG_MACHINE_CONFIG_DIR: SUITE_MC_DIR })
			.quiet();
		expect(result.stdout.toString()).toContain("Created task TASK-2");
		const core = new Core(LOCAL_DIR);
		const task = await core.filesystem.loadTask("task-2");
		expect(task).not.toBeNull();
	});
});
