import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { atomicWriteFile } from "../file-system/operations.ts";
import { createUniqueTestDir } from "./test-utils.ts";

// Write a minimal backlog config directly to avoid slow initializeProject
async function setupTestProject(testDir: string): Promise<void> {
	await mkdir(join(testDir, "backlog", "tasks"), { recursive: true });
	await mkdir(join(testDir, "backlog", "archive", "tasks"), { recursive: true });
	await mkdir(join(testDir, "backlog", "milestones"), { recursive: true });
	await mkdir(join(testDir, "backlog", "completed"), { recursive: true });
	const config = `projectName: Test
statuses:
  - Backlog
  - Ready
  - To Do
  - In Progress
  - Done
labels: []
defaultStatus: To Do
dateFormat: yyyy-mm-dd
checkActiveBranches: false
filesystemOnly: true
autoCommit: false
`;
	await writeFile(join(testDir, "backlog", "config.yml"), config);
}

describe("atomicWriteFile", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = createUniqueTestDir("atomic-write");
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("writes content to the target file", async () => {
		const filePath = join(testDir, "test.md");
		await atomicWriteFile(filePath, "hello world");
		const content = await readFile(filePath, "utf8");
		expect(content).toBe("hello world");
	});

	it("file exists after the call", async () => {
		const filePath = join(testDir, "test.md");
		await atomicWriteFile(filePath, "content");
		// access() resolves (without throwing) if the file exists
		await expect(access(filePath)).resolves.toBeDefined();
	});

	it("temp file is cleaned up after successful write", async () => {
		const filePath = join(testDir, "test.md");
		await atomicWriteFile(filePath, "content");
		await expect(access(`${filePath}.tmp`)).rejects.toThrow();
	});
});

describe("Core.claimTask", () => {
	let testDir: string;
	let core: Core;

	beforeEach(async () => {
		// Ensure locking is active for all claim tests
		delete process.env.USE_GLOBAL_TASK_ID_LOCK;

		testDir = createUniqueTestDir("claim-task");
		await setupTestProject(testDir);
		core = new Core(testDir);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("picks the top Ready task by sortForPickup order (ordinal ASC when ordinals differ)", async () => {
		// Tasks created sequentially get incrementing ordinals (1000, 2000, 3000).
		// Ordinal is the primary sort key, so ordinal 1000 wins regardless of priority.
		await core.createTaskFromInput({ title: "First created (low pri)", status: "Ready", priority: "low" }, false);
		await core.createTaskFromInput({ title: "Second created (high pri)", status: "Ready", priority: "high" }, false);

		const result = await core.claimTask({ status: "Ready" });
		expect(result).not.toBeNull();
		// Ordinal 1000 was created first, so it should be picked first
		expect(result?.task.title).toBe("First created (low pri)");
	});

	it("returns { task, previousStatus } with previousStatus = Ready", async () => {
		await core.createTaskFromInput({ title: "My task", status: "Ready" }, false);

		const result = await core.claimTask({ status: "Ready" });
		expect(result).not.toBeNull();
		expect(result?.previousStatus).toBe("Ready");
		expect(result?.task.status).toBe("In Progress");
	});

	it("returns null when no tasks have the given status", async () => {
		// Create task with a different status
		await core.createTaskFromInput({ title: "Backlog task", status: "Backlog" }, false);

		const result = await core.claimTask({ status: "Ready" });
		expect(result).toBeNull();
	});

	it("returns null when there are no tasks at all", async () => {
		const result = await core.claimTask({ status: "Ready" });
		expect(result).toBeNull();
	});

	it("strips @ prefix from agent and writes to assignee", async () => {
		await core.createTaskFromInput({ title: "Agent task", status: "Ready" }, false);

		const result = await core.claimTask({ status: "Ready", agent: "@alice" });
		expect(result).not.toBeNull();
		expect(result?.task.assignee).toContain("alice");
		expect(result?.task.assignee).not.toContain("@alice");
	});

	it("handles agent without @ prefix", async () => {
		await core.createTaskFromInput({ title: "Agent task", status: "Ready" }, false);

		const result = await core.claimTask({ status: "Ready", agent: "bob" });
		expect(result).not.toBeNull();
		expect(result?.task.assignee).toContain("bob");
	});

	it("leaves assignee untouched when no agent provided", async () => {
		await core.createTaskFromInput({ title: "No agent task", status: "Ready", assignee: ["existing-person"] }, false);

		const result = await core.claimTask({ status: "Ready" });
		expect(result).not.toBeNull();
		expect(result?.task.assignee).toContain("existing-person");
	});

	it("flips status to In Progress on the persisted file", async () => {
		await core.createTaskFromInput({ title: "Task to claim", status: "Ready" }, false);

		const result = await core.claimTask({ status: "Ready" });
		expect(result).not.toBeNull();

		// Reload from disk to confirm the file was actually written
		const reloaded = await core.fs.loadTask(result!.task.id);
		expect(reloaded?.status).toBe("In Progress");
	});

	it("throws on invalid status", async () => {
		await expect(core.claimTask({ status: "NonExistentStatus" })).rejects.toThrow("Invalid status");
	});

	it("concurrency: two concurrent claimTask calls never both claim the same task", async () => {
		// Create exactly 2 Ready tasks so both callers can potentially succeed
		await core.createTaskFromInput({ title: "Task A", status: "Ready" }, false);
		await core.createTaskFromInput({ title: "Task B", status: "Ready" }, false);

		// Two Core instances pointing at the same repo (separate in-memory state)
		const coreA = new Core(testDir);
		const coreB = new Core(testDir);

		const [resultA, resultB] = await Promise.all([
			coreA.claimTask({ status: "Ready" }),
			coreB.claimTask({ status: "Ready" }),
		]);

		// Both got a task
		expect(resultA).not.toBeNull();
		expect(resultB).not.toBeNull();

		// They claimed different tasks
		expect(resultA!.task.id).not.toBe(resultB!.task.id);
	});

	it("concurrency: when only one Ready task, one caller gets it and the other gets null", async () => {
		await core.createTaskFromInput({ title: "Only task", status: "Ready" }, false);

		const coreA = new Core(testDir);
		const coreB = new Core(testDir);

		const [resultA, resultB] = await Promise.all([
			coreA.claimTask({ status: "Ready" }),
			coreB.claimTask({ status: "Ready" }),
		]);

		const results = [resultA, resultB];
		const nonNull = results.filter((r) => r !== null);
		const nullCount = results.filter((r) => r === null).length;

		expect(nonNull.length).toBe(1);
		expect(nullCount).toBe(1);
	});
});
