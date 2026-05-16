import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileSystem } from "../file-system/operations.ts";
import type { BacklogConfig, Task } from "../types/index.ts";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;

describe("FileSystem", () => {
	let filesystem: FileSystem;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-backlog");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureBacklogStructure();
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("ensureBacklogStructure", () => {
		it("should create all required directories", async () => {
			const expectedDirs = [
				join(TEST_DIR, "backlog"),
				join(TEST_DIR, "backlog", "tasks"),
				join(TEST_DIR, "backlog", "archive", "tasks"),
				join(TEST_DIR, "backlog", "milestones"),
			];

			for (const dir of expectedDirs) {
				const stats = await stat(dir);
				expect(stats.isDirectory()).toBe(true);
			}
		});
	});

	describe("task operations", () => {
		const sampleTask: Task = {
			id: "task-1",
			title: "Test Task",
			status: "To Do",
			assignee: ["@developer"],
			reporter: "@manager",
			createdDate: "2025-06-03",
			labels: ["test"],
			milestone: "v1.0",
			dependencies: [],
			description: "This is a test task",
		};

		it("should save and load a task", async () => {
			await filesystem.saveTask(sampleTask);

			const loadedTask = await filesystem.loadTask("task-1");
			expect(loadedTask?.id).toBe("TASK-1"); // IDs are normalized to uppercase
			expect(loadedTask?.title).toBe(sampleTask.title);
			expect(loadedTask?.status).toBe(sampleTask.status);
			expect(loadedTask?.description).toBe(sampleTask.description);
		});

		it("should return null for non-existent task", async () => {
			const task = await filesystem.loadTask("non-existent");
			expect(task).toBeNull();
		});

		it("should list all tasks", async () => {
			await filesystem.saveTask(sampleTask);
			await filesystem.saveTask({
				...sampleTask,
				id: "task-2",
				title: "Second Task",
			});

			const tasks = await filesystem.listTasks();
			expect(tasks).toHaveLength(2);
			expect(tasks.map((t) => t.id)).toEqual(["TASK-1", "TASK-2"]); // IDs are normalized to uppercase
		});

		it("should list tasks even when one file has invalid frontmatter", async () => {
			await filesystem.saveTask(sampleTask);
			await filesystem.saveTask({
				...sampleTask,
				id: "task-2",
				title: "Second Task",
			});

			const invalidPath = join(filesystem.tasksDir, "task-99 - invalid.md");
			await Bun.write(
				invalidPath,
				`---
id: task-99
assignee: [@broken
status: To Do
title: Broken Task
---

Invalid content`,
			);

			const tasks = await filesystem.listTasks();
			expect(tasks.map((t) => t.id)).toEqual(["TASK-1", "TASK-2"]); // IDs normalized to uppercase
		});

		it("should sort tasks numerically by ID", async () => {
			// Create tasks with IDs that would sort incorrectly with string comparison
			const taskIds = ["task-2", "task-10", "task-1", "task-20", "task-3"];
			for (const id of taskIds) {
				await filesystem.saveTask({
					...sampleTask,
					id,
					title: `Task ${id}`,
				});
			}

			const tasks = await filesystem.listTasks();
			expect(tasks.map((t) => t.id)).toEqual(["TASK-1", "TASK-2", "TASK-3", "TASK-10", "TASK-20"]); // IDs normalized to uppercase
		});

		it("should sort tasks with decimal IDs correctly", async () => {
			// Create tasks with decimal IDs
			const taskIds = ["task-2.10", "task-2.2", "task-2", "task-1", "task-2.1"];
			for (const id of taskIds) {
				await filesystem.saveTask({
					...sampleTask,
					id,
					title: `Task ${id}`,
				});
			}

			const tasks = await filesystem.listTasks();
			expect(tasks.map((t) => t.id)).toEqual(["TASK-1", "TASK-2", "TASK-2.1", "TASK-2.2", "TASK-2.10"]); // IDs normalized to uppercase
		});

		it("should filter tasks by status and assignee", async () => {
			await filesystem.saveTask({
				...sampleTask,
				id: "task-1",
				status: "To Do",
				assignee: ["alice"],
				title: "Task 1",
			});
			await filesystem.saveTask({
				...sampleTask,
				id: "task-2",
				status: "Done",
				assignee: ["bob"],
				title: "Task 2",
			});
			await filesystem.saveTask({
				...sampleTask,
				id: "task-3",
				status: "To Do",
				assignee: ["bob"],
				title: "Task 3",
			});

			const statusFiltered = await filesystem.listTasks({ status: "to do" });
			expect(statusFiltered.map((t) => t.id)).toEqual(["TASK-1", "TASK-3"]); // IDs normalized to uppercase

			const assigneeFiltered = await filesystem.listTasks({ assignee: "bob" });
			expect(assigneeFiltered.map((t) => t.id)).toEqual(["TASK-2", "TASK-3"]); // IDs normalized to uppercase

			const combinedFiltered = await filesystem.listTasks({ status: "to do", assignee: "bob" });
			expect(combinedFiltered.map((t) => t.id)).toEqual(["TASK-3"]); // IDs normalized to uppercase
		});

		it("should archive a task", async () => {
			await filesystem.saveTask(sampleTask);

			const archived = await filesystem.archiveTask("task-1");
			expect(archived).toBe(true);

			const task = await filesystem.loadTask("task-1");
			expect(task).toBeNull();

			// Check that file exists in archive
			const archiveFiles = await readdir(join(TEST_DIR, "backlog", "archive", "tasks"));
			expect(archiveFiles.some((f) => f.startsWith("task-1"))).toBe(true);
		});
	});

	describe("config operations", () => {
		const sampleConfig: BacklogConfig = {
			projectName: "Test Project",
			defaultAssignee: "@admin",
			defaultStatus: "To Do",
			defaultReporter: undefined,
			statuses: ["To Do", "In Progress", "Done"],
			labels: ["bug", "feature"],
			dateFormat: "yyyy-mm-dd",
		};

		it("should save and load config", async () => {
			await filesystem.saveConfig(sampleConfig);

			const loadedConfig = await filesystem.loadConfig();
			expect(loadedConfig).toEqual(sampleConfig);
		});

		it("should return null for missing config", async () => {
			// Create a fresh filesystem without any config
			const freshFilesystem = new FileSystem(join(TEST_DIR, "fresh"));
			await freshFilesystem.ensureBacklogStructure();

			const config = await freshFilesystem.loadConfig();
			expect(config).toBeNull();
		});

		it("should handle defaultReporter field", async () => {
			const cfg: BacklogConfig = {
				projectName: "Reporter",
				defaultReporter: "@author",
				statuses: ["To Do"],
				labels: [],
				dateFormat: "yyyy-mm-dd",
			};

			await filesystem.saveConfig(cfg);
			const loaded = await filesystem.loadConfig();
			expect(loaded?.defaultReporter).toBe("@author");
		});
	});

	describe("directory accessors", () => {
		it("should provide correct directory paths", () => {
			expect(filesystem.tasksDir).toBe(join(TEST_DIR, "backlog", "tasks"));
			expect(filesystem.archiveTasksDir).toBe(join(TEST_DIR, "backlog", "archive", "tasks"));
		});
	});

	describe("edge cases", () => {
		it("should handle task with task- prefix in id", async () => {
			const taskWithPrefix: Task = {
				id: "task-prefixed",
				title: "Already Prefixed",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Task with task- prefix",
			};

			await filesystem.saveTask(taskWithPrefix);
			const loaded = await filesystem.loadTask("task-prefixed");

			expect(loaded?.id).toBe("TASK-PREFIXED"); // IDs are normalized to uppercase
		});

		it("should handle task without task- prefix in id", async () => {
			// ID without any prefix pattern (no letters-dash)
			const taskWithoutPrefix: Task = {
				id: "123",
				title: "No Prefix",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Task without prefix",
			};

			await filesystem.saveTask(taskWithoutPrefix);
			const loaded = await filesystem.loadTask("task-123");

			// IDs without prefix get the configured (or default) task prefix
			expect(loaded?.id).toBe("TASK-123");
		});

		it("should preserve custom prefix in id", async () => {
			// ID with a custom prefix pattern (letters-something)
			const taskWithCustomPrefix: Task = {
				id: "JIRA-456",
				title: "Custom Prefix",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Task with custom prefix",
			};

			await filesystem.saveTask(taskWithCustomPrefix);
			const loaded = await filesystem.loadTask("jira-456");

			// IDs with existing prefix are preserved (normalized to uppercase)
			expect(loaded?.id).toBe("JIRA-456");
		});

		it("should return empty array when listing tasks in empty directory", async () => {
			const tasks = await filesystem.listTasks();
			expect(tasks).toEqual([]);
		});

		it("should return false when archiving non-existent task", async () => {
			const result = await filesystem.archiveTask("non-existent");
			expect(result).toBe(false);
		});

		it("should handle config with all optional fields", async () => {
			const fullConfig: BacklogConfig = {
				projectName: "Full Project",
				defaultAssignee: "@admin",
				defaultStatus: "To Do",
				defaultReporter: undefined,
				statuses: ["To Do", "In Progress", "Done"],
				labels: ["bug", "feature", "enhancement"],
				dateFormat: "yyyy-mm-dd",
			};

			await filesystem.saveConfig(fullConfig);
			const loaded = await filesystem.loadConfig();

			expect(loaded).toEqual(fullConfig);
		});

		it("should handle config with minimal fields", async () => {
			const minimalConfig: BacklogConfig = {
				projectName: "Minimal Project",
				statuses: ["To Do", "Done"],
				labels: [],
				dateFormat: "yyyy-mm-dd",
			};

			await filesystem.saveConfig(minimalConfig);
			const loaded = await filesystem.loadConfig();

			expect(loaded?.projectName).toBe("Minimal Project");
			expect(loaded?.defaultAssignee).toBeUndefined();
			expect(loaded?.defaultStatus).toBeUndefined();
		});

		it("should sanitize filenames correctly", async () => {
			const taskWithSpecialChars: Task = {
				id: "task-special",
				title: "Task/with\\special:chars?",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Task with special characters in title",
			};

			await filesystem.saveTask(taskWithSpecialChars);
			const loaded = await filesystem.loadTask("task-special");

			expect(loaded?.title).toBe("Task/with\\special:chars?");
		});

		it("should preserve case in filenames", async () => {
			const taskWithMixedCase: Task = {
				id: "task-mixed",
				title: "Fix Task List Ordering",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Task with mixed case title",
			};

			await filesystem.saveTask(taskWithMixedCase);

			// Check that the file exists with preserved case
			const files = await readdir(filesystem.tasksDir);
			const taskFile = files.find((f) => f.startsWith("task-mixed -"));
			expect(taskFile).toBe("task-mixed - Fix-Task-List-Ordering.md");

			// Verify the task can be loaded
			const loaded = await filesystem.loadTask("task-mixed");
			expect(loaded?.title).toBe("Fix Task List Ordering");
		});

		it("should strip punctuation from filenames", async () => {
			const taskWithPunctuation: Task = {
				id: "task-punct",
				title: "Fix the user's login (OAuth)! #1",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Task with punctuation in the title",
			};

			await filesystem.saveTask(taskWithPunctuation);

			const files = await readdir(filesystem.tasksDir);
			const filename = files.find((f) => f.startsWith("task-punct -"));
			expect(filename).toBe("task-punct - Fix-the-users-login-OAuth-1.md");
		});

		it("should load tasks with legacy filenames containing punctuation", async () => {
			const legacyTask: Task = {
				id: "task-legacy",
				title: "Legacy user's login (OAuth)",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Legacy punctuation task",
			};

			await filesystem.saveTask(legacyTask);

			const files = await readdir(filesystem.tasksDir);
			const originalFilename = files.find((f) => f.startsWith("task-legacy -"));
			expect(originalFilename).toBeDefined();

			const legacyFilename = "task-legacy - Legacy-user's-login-(OAuth).md";
			await rename(join(filesystem.tasksDir, originalFilename as string), join(filesystem.tasksDir, legacyFilename));

			const loaded = await filesystem.loadTask("task-legacy");
			expect(loaded?.title).toBe("Legacy user's login (OAuth)");
		});

		it("should sanitize a variety of problematic task titles", async () => {
			const cases: Array<{ id: string; title: string; expected: string }> = [
				{
					id: "task-bad-1",
					title: "Fix the user's login (OAuth)! #1",
					expected: "Fix-the-users-login-OAuth-1",
				},
				{
					id: "task-bad-2",
					title: "Crazy!@#$%^&*()Name",
					expected: "Crazy-Name",
				},
				{
					id: "task-bad-3",
					title: "File with <bad> |chars| and /slashes\\",
					expected: "File-with-bad-chars-and-slashes",
				},
				{
					id: "task-bad-4",
					title: "Tabs\tand\nnewlines",
					expected: "Tabs-and-newlines",
				},
				{
					id: "task-bad-5",
					title: "Edge -- dashes ???",
					expected: "Edge-dashes",
				},
			];

			for (const { id, title, expected } of cases) {
				await filesystem.saveTask({
					id,
					title,
					status: "To Do",
					assignee: [],
					createdDate: "2025-06-07",
					labels: [],
					dependencies: [],
					description: "Sanitization test",
				});

				const files = await readdir(filesystem.tasksDir);
				expect(files).toContain(`${id} - ${expected}.md`);
			}
		});

		it("should avoid double dashes in filenames", async () => {
			const weirdTask: Task = {
				id: "task-dashes",
				title: "Task -- with  -- multiple   dashes",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Check double dashes",
			};

			await filesystem.saveTask(weirdTask);
			const files = await readdir(filesystem.tasksDir);
			const filename = files.find((f) => f.startsWith("task-dashes -"));
			expect(filename).toBeDefined();
			expect(filename?.includes("--")).toBe(false);
		});
	});
});
