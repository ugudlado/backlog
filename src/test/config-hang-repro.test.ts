import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { FileSystem } from "../file-system/operations.ts";
import type { BacklogConfig } from "../types/index.ts";
import { seedTestWorkspace } from "./test-utils.ts";

/**
 * Under the per-repo workspace model the project config IS the per-repo
 * workspace yml (resolved via the machine config dir, isolated per-test by the
 * global preload). The legacy `.backlog`-vs-`backlog` directory precedence was
 * removed by the workspace-resolution-simplification change, so those tests are
 * gone; the surviving concern here is that `loadConfig` does not hang and that
 * `ensureConfigMigrated` still migrates legacy in-config milestones.
 */
describe("Config Loading & Migration", () => {
	const testRoot = "/tmp/test-config-migration";
	const backlogDir = join(testRoot, "backlog");

	beforeEach(async () => {
		await rm(testRoot, { recursive: true, force: true });
		await mkdir(backlogDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testRoot, { recursive: true, force: true });
	});

	it("loads config from the per-repo workspace file without hanging", async () => {
		await seedTestWorkspace(testRoot, {
			configBody: `project_name: "Test Project"
statuses: ["To Do", "In Progress", "Done"]
labels: []
milestones: []
default_status: "To Do"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false
`,
		});

		const fs = new FileSystem(testRoot);

		// This should complete without hanging
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => reject(new Error("Config loading timed out - infinite loop detected!")), 5000);
		});

		const loadedConfig = (await Promise.race([fs.loadConfig(), timeoutPromise])) as BacklogConfig | null;

		expect(loadedConfig).toBeTruthy();
		expect(loadedConfig?.projectName).toBe("Test Project");
	});

	it("migrates legacy config milestones into milestone files and removes config milestones key", async () => {
		await seedTestWorkspace(testRoot, {
			configBody: `project_name: "Legacy Milestones Project"
statuses: ["To Do", "In Progress", "Done"]
labels: []
milestones: ["Release 1", "Release 2"]
default_status: "To Do"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false
`,
		});
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedMilestones = await core.filesystem.listMilestones();
		expect(migratedMilestones.map((milestone) => milestone.title).sort()).toEqual(["Release 1", "Release 2"]);

		const rewrittenConfig = await Bun.file(core.filesystem.configFilePath).text();
		expect(rewrittenConfig).not.toContain("milestones:");
	});

	it("migrates quoted legacy milestone names containing commas", async () => {
		await seedTestWorkspace(testRoot, {
			configBody: `project_name: "Legacy Milestones Project"
statuses: ["To Do", "In Progress", "Done"]
labels: []
milestones: ["Release, Part 1", "Release 2"]
default_status: "To Do"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false
`,
		});
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedMilestones = await core.filesystem.listMilestones();
		expect(migratedMilestones.map((milestone) => milestone.title).sort()).toEqual(["Release 2", "Release, Part 1"]);
	});

	it("migrates multiline legacy milestone list values with comments", async () => {
		await seedTestWorkspace(testRoot, {
			configBody: `project_name: "Legacy Milestones Project"
statuses: ["To Do", "In Progress", "Done"]
labels: []
milestones:
  - "Release 1"
  - Release 2 # comment
  - 'Release #3'
default_status: "To Do"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false
`,
		});
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedMilestones = await core.filesystem.listMilestones();
		expect(migratedMilestones.map((milestone) => milestone.title).sort()).toEqual([
			"Release #3",
			"Release 1",
			"Release 2",
		]);

		const rewrittenConfig = await Bun.file(core.filesystem.configFilePath).text();
		expect(rewrittenConfig).not.toContain("milestones:");
	});

	it("migrates multiline bracketed legacy milestone arrays", async () => {
		await seedTestWorkspace(testRoot, {
			configBody: `project_name: "Legacy Milestones Project"
statuses: ["To Do", "In Progress", "Done"]
labels: []
milestones: [
  "Release 1",
  "Release 2"
]
default_status: "To Do"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false
`,
		});
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedMilestones = await core.filesystem.listMilestones();
		expect(migratedMilestones.map((milestone) => milestone.title).sort()).toEqual(["Release 1", "Release 2"]);
	});

	it("migrates single-quoted legacy milestones with escaped apostrophes", async () => {
		await seedTestWorkspace(testRoot, {
			configBody: `project_name: "Legacy Milestones Project"
statuses: ["To Do", "In Progress", "Done"]
labels: []
milestones:
  - 'Release ''Alpha'''
default_status: "To Do"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false
`,
		});
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedMilestones = await core.filesystem.listMilestones();
		expect(migratedMilestones.map((milestone) => milestone.title)).toEqual(["Release 'Alpha'"]);
	});
});
