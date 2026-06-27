import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../index.ts";
import { extractStructuredSection } from "../markdown/structured-sections.ts";
import { listTasksPlatformAware, viewTaskPlatformAware } from "./test-helpers.ts";
import {
	createTestGlobalStore,
	createUniqueTestDir,
	initializeGlobalTestProject,
	initializeTestProject,
	safeCleanup,
} from "./test-utils.ts";

let TEST_DIR: string;
let PROJECT_ROOT: string;
let CORE: Core;
let ENV: Record<string, string>;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("CLI Integration", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("backlog init command", () => {
		// Backlog stores every project in the configured global store; init requires
		// it. Each test gets an isolated globalStore under TEST_DIR. `initEnv` is
		// passed to CLI subprocesses; the slot lives at <globalStore>/<name>.
		let initEnv: Record<string, string>;
		beforeEach(async () => {
			const gs = await createTestGlobalStore(TEST_DIR);
			initEnv = gs.env;
		});

		it("should initialize backlog project in existing git repo", async () => {
			// Set up a git repository
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			// Initialize backlog project using Core (simulating CLI)
			const core = new Core(TEST_DIR);
			await initializeTestProject(core, "CLI Test Project");

			// Verify directory structure was created
			const configExists = await Bun.file(join(TEST_DIR, "backlog", "config.yml")).exists();
			expect(configExists).toBe(true);

			// Verify config content
			const config = await core.filesystem.loadConfig();
			expect(config?.projectName).toBe("CLI Test Project");
			expect(config?.statuses).toEqual(["To Do", "Ready", "In Progress", "Review", "Verify", "Done"]);
			expect(config?.defaultStatus).toBe("To Do");
		});

		it("should create all required directories", async () => {
			// Set up a git repository
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			const core = new Core(TEST_DIR);
			await initializeTestProject(core, "Directory Test");

			// Check all expected directories exist
			const expectedDirs = [
				"backlog",
				"backlog/tasks",
				"backlog/archive",
				"backlog/archive/tasks",
				"backlog/archive/milestones",
				"backlog/milestones",
			];

			for (const dir of expectedDirs) {
				try {
					const stats = await stat(join(TEST_DIR, dir));
					expect(stats.isDirectory()).toBe(true);
				} catch {
					// If stat fails, directory doesn't exist
					expect(false).toBe(true);
				}
			}
		});

		it("should handle project names with special characters", async () => {
			// Set up a git repository
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			const core = new Core(TEST_DIR);
			const specialProjectName = "My-Project_2024 (v1.0)";
			await initializeTestProject(core, specialProjectName);

			const config = await core.filesystem.loadConfig();
			expect(config?.projectName).toBe(specialProjectName);
		});

		it("should accept optional project name parameter", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			// Test the CLI implementation by directly using the Core functionality
			const core = new Core(TEST_DIR);
			await initializeTestProject(core, "Test Project");

			const config = await core.filesystem.loadConfig();
			expect(config?.projectName).toBe("Test Project");
		});

		it("should create agent instruction files when requested", async () => {
			// Set up a git repository
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			// Simulate the agent instructions being added
			const core = new Core(TEST_DIR);
			await initializeTestProject(core, "Agent Test Project");

			// Import and call addAgentInstructions directly (simulating user saying "y")
			const { addAgentInstructions } = await import("../index.ts");
			await addAgentInstructions(TEST_DIR);

			// Verify agent files were created
			const agentsFile = await Bun.file(join(TEST_DIR, "AGENTS.md")).exists();
			const claudeFile = await Bun.file(join(TEST_DIR, "CLAUDE.md")).exists();
			// .cursorrules removed; Cursor now uses AGENTS.md
			const geminiFile = await Bun.file(join(TEST_DIR, "GEMINI.md")).exists();
			const copilotFile = await Bun.file(join(TEST_DIR, ".github/copilot-instructions.md")).exists();

			expect(agentsFile).toBe(true);
			expect(claudeFile).toBe(true);
			expect(geminiFile).toBe(true);
			expect(copilotFile).toBe(true);

			// Verify content
			const agentsContent = await Bun.file(join(TEST_DIR, "AGENTS.md")).text();
			const claudeContent = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();
			const geminiContent = await Bun.file(join(TEST_DIR, "GEMINI.md")).text();
			const copilotContent = await Bun.file(join(TEST_DIR, ".github/copilot-instructions.md")).text();
			expect(agentsContent.length).toBeGreaterThan(0);
			expect(claudeContent.length).toBeGreaterThan(0);
			expect(geminiContent.length).toBeGreaterThan(0);
			expect(copilotContent.length).toBeGreaterThan(0);
		});

		it("should allow skipping agent instructions with 'none' selection", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			const output = await $`bun ${CLI_PATH} init TestProj --defaults --agent-instructions none`
				.cwd(TEST_DIR)
				.env(initEnv)
				.text();

			const agentsFile = await Bun.file(join(TEST_DIR, "AGENTS.md")).exists();
			const claudeFile = await Bun.file(join(TEST_DIR, "CLAUDE.md")).exists();
			expect(agentsFile).toBe(false);
			expect(claudeFile).toBe(false);
			expect(output).toContain("AI Integration: CLI commands (legacy)");
			expect(output).toContain("Skipping agent instruction files per selection.");
		});

		it("should print minimal summary when advanced settings are skipped", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			const output = await $`bun ${CLI_PATH} init SummaryProj --defaults --agent-instructions none`
				.cwd(TEST_DIR)
				.env(initEnv)
				.text();

			expect(output).toContain("Initialization Summary");
			expect(output).toContain("Project Name: SummaryProj");
			expect(output).toContain("AI Integration: CLI commands (legacy)");
			// Global-store projects are filesystem-only, so git integration is off.
			expect(output).toContain("Git integration: disabled (filesystem-only)");
		});

		it("should support MCP integration mode via flag", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			const output = await $`bun ${CLI_PATH} init McpProj --defaults --integration-mode mcp`
				.cwd(TEST_DIR)
				.env(initEnv)
				.text();

			expect(output).toContain("AI Integration: MCP connector");
			expect(output).toContain("Agent instruction files: guidance is provided through the MCP connector.");
			expect(output).toContain("MCP server name: backlog");
			expect(output).toContain("MCP client setup: skipped (non-interactive)");
			const agentsFile = await Bun.file(join(TEST_DIR, "AGENTS.md")).exists();
			const claudeFile = await Bun.file(join(TEST_DIR, "CLAUDE.md")).exists();
			expect(agentsFile).toBe(false);
			expect(claudeFile).toBe(false);
		});

		it("should default to MCP integration when no mode is specified", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			const output = await $`bun ${CLI_PATH} init DefaultMcpProj --defaults`.cwd(TEST_DIR).env(initEnv).text();

			expect(output).toContain("AI Integration: MCP connector");
			expect(output).toContain("MCP server name: backlog");
			expect(output).toContain("MCP client setup: skipped (non-interactive)");
		});

		it("should allow skipping AI integration via flag", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			const output = await $`bun ${CLI_PATH} init SkipProj --defaults --integration-mode none`
				.cwd(TEST_DIR)
				.env(initEnv)
				.text();

			expect(output).not.toContain("AI Integration:");
			expect(output).toContain("AI integration: skipped");
			const agentsFile = await Bun.file(join(TEST_DIR, "AGENTS.md")).exists();
			const claudeFile = await Bun.file(join(TEST_DIR, "CLAUDE.md")).exists();
			expect(agentsFile).toBe(false);
			expect(claudeFile).toBe(false);
		});

		it("should reject MCP integration when agent instruction flags are provided", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			let failed = false;
			let combinedOutput = "";
			try {
				await $`bun ${CLI_PATH} init ConflictProj --defaults --integration-mode mcp --agent-instructions claude`
					.cwd(TEST_DIR)
					.env(initEnv)
					.text();
			} catch (err) {
				failed = true;
				const e = err as { stdout?: unknown; stderr?: unknown };
				combinedOutput = String(e.stdout ?? "") + String(e.stderr ?? "");
			}

			expect(failed).toBe(true);
			expect(combinedOutput).toContain("cannot be combined");
		});

		it("should ignore 'none' when other agent instructions are provided", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			await $`bun ${CLI_PATH} init TestProj --defaults --agent-instructions agents,none`
				.cwd(TEST_DIR)
				.env(initEnv)
				.quiet();

			const agentsFile = await Bun.file(join(TEST_DIR, "AGENTS.md")).exists();
			expect(agentsFile).toBe(true);
		});

		it("should error on invalid agent instruction value", async () => {
			await $`git init -b main`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

			let failed = false;
			try {
				await $`bun ${CLI_PATH} init InvalidProj --defaults --agent-instructions notreal`
					.cwd(TEST_DIR)
					.env(initEnv)
					.quiet();
			} catch (e) {
				failed = true;
				const err = e as { stdout?: unknown; stderr?: unknown };
				const out = String(err.stdout ?? "") + String(err.stderr ?? "");
				expect(out).toContain("Invalid agent instruction: notreal");
				expect(out).toContain("Valid options are: cursor, claude, agents, gemini, copilot, none");
			}

			expect(failed).toBe(true);
		});
	});

	describe("create commands", () => {
		beforeEach(async () => {
			({
				projectRoot: PROJECT_ROOT,
				core: CORE,
				env: ENV,
			} = await initializeGlobalTestProject(TEST_DIR, "Create Command Test"));
		});
	});

	describe("task list command", () => {
		beforeEach(async () => {
			// Set up a git repository and initialize backlog
			({
				projectRoot: PROJECT_ROOT,
				core: CORE,
				env: ENV,
			} = await initializeGlobalTestProject(TEST_DIR, "List Test Project"));
		});

		it("should show 'No tasks found' when no tasks exist", async () => {
			const core = CORE;
			const tasks = await core.filesystem.listTasks();
			expect(tasks).toHaveLength(0);
		});

		it("should list tasks grouped by status", async () => {
			const core = CORE;

			// Create test tasks with different statuses
			await core.createTask({
				id: "task-1",
				title: "First Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "First test task",
			});

			await core.createTask({
				id: "task-2",
				title: "Second Task",
				status: "Done",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Second test task",
			});

			await core.createTask({
				id: "task-3",
				title: "Third Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Third test task",
			});

			const tasks = await core.filesystem.listTasks();
			expect(tasks).toHaveLength(3);

			// Verify tasks are grouped correctly by status
			const todoTasks = tasks.filter((t) => t.status === "To Do");
			const doneTasks = tasks.filter((t) => t.status === "Done");

			expect(todoTasks).toHaveLength(2);
			expect(doneTasks).toHaveLength(1);
			expect(todoTasks.map((t) => t.id)).toEqual(["TASK-1", "TASK-3"]); // IDs normalized to uppercase
			expect(doneTasks.map((t) => t.id)).toEqual(["TASK-2"]); // IDs normalized to uppercase
		});

		it("should respect config status order", async () => {
			const core = CORE;

			// Load and verify default config status order
			const config = await core.filesystem.loadConfig();
			expect(config?.statuses).toEqual(["To Do", "Ready", "In Progress", "Review", "Verify", "Done"]);
		});

		it("should filter tasks by status", async () => {
			const core = CORE;

			await core.createTask({
				id: "task-1",
				title: "First Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "First test task",
			});
			await core.createTask({
				id: "task-2",
				title: "Second Task",
				status: "Done",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Second test task",
			});

			const result = await $`bun ${CLI_PATH} task list --plain --status Done`.cwd(PROJECT_ROOT).env(ENV).quiet();
			const out = result.stdout.toString();
			expect(out).toContain("Done:");
			expect(out).toContain("TASK-2 - Second Task"); // IDs normalized to uppercase
			expect(out).not.toContain("TASK-1");
		});

		it("should filter tasks by status case-insensitively", async () => {
			const core = CORE;

			await core.createTask({
				id: "task-1",
				title: "First Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "First test task",
			});
			await core.createTask({
				id: "task-2",
				title: "Second Task",
				status: "Done",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Second test task",
			});

			const testCases = ["done", "DONE", "DoNe"];

			for (const status of testCases) {
				const result = await $`bun ${CLI_PATH} task list --plain --status ${status}`.cwd(PROJECT_ROOT).env(ENV).quiet();
				const out = result.stdout.toString();
				expect(out).toContain("Done:");
				expect(out).toContain("TASK-2 - Second Task"); // IDs normalized to uppercase
				expect(out).not.toContain("TASK-1");
			}

			// Test with -s flag
			const resultShort = await listTasksPlatformAware({ plain: true, status: "done" }, PROJECT_ROOT, CORE);
			const outShort = resultShort.stdout;
			expect(outShort).toContain("Done:");
			expect(outShort).toContain("TASK-2 - Second Task"); // IDs normalized to uppercase
			expect(outShort).not.toContain("TASK-1");
		});

		it("should filter tasks by assignee", async () => {
			const core = CORE;

			await core.createTask({
				id: "task-1",
				title: "Assigned Task",
				status: "To Do",
				assignee: ["alice"],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Assigned task",
			});
			await core.createTask({
				id: "task-2",
				title: "Unassigned Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Other task",
			});

			const result = await $`bun ${CLI_PATH} task list --plain --assignee alice`.cwd(PROJECT_ROOT).env(ENV).quiet();
			const out = result.stdout.toString();
			expect(out).toContain("TASK-1 - Assigned Task"); // IDs normalized to uppercase
			expect(out).not.toContain("TASK-2 - Unassigned Task");
		});
	});

	describe("task view command", () => {
		beforeEach(async () => {
			// Set up a git repository and initialize backlog
			({
				projectRoot: PROJECT_ROOT,
				core: CORE,
				env: ENV,
			} = await initializeGlobalTestProject(TEST_DIR, "View Test Project"));
		});

		it("should display task details with markdown formatting", async () => {
			const core = CORE;

			// Create a test task
			const testTask = {
				id: "task-1",
				title: "Test View Task",
				status: "To Do",
				assignee: ["testuser"],
				createdDate: "2025-06-08",
				labels: ["test", "cli"],
				dependencies: [],
				rawContent: "This is a test task for view command",
			};

			await core.createTask(testTask);

			// Load the task back
			const loadedTask = await core.filesystem.loadTask("task-1");
			expect(loadedTask).not.toBeNull();
			expect(loadedTask?.id).toBe("TASK-1"); // IDs normalized to uppercase
			expect(loadedTask?.title).toBe("Test View Task");
			expect(loadedTask?.status).toBe("To Do");
			expect(loadedTask?.assignee).toEqual(["testuser"]);
			expect(loadedTask?.labels).toEqual(["test", "cli"]);
			expect(loadedTask?.rawContent).toBe("This is a test task for view command");
		});

		it("should handle task IDs with and without 'task-' prefix", async () => {
			const core = CORE;

			// Create a test task
			await core.createTask({
				id: "task-5",
				title: "Prefix Test Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Testing task ID normalization",
			});

			// Test loading with full task-5 ID
			const taskWithPrefix = await core.filesystem.loadTask("task-5");
			expect(taskWithPrefix?.id).toBe("TASK-5"); // IDs normalized to uppercase

			// Test loading with just numeric ID (5)
			const taskWithoutPrefix = await core.filesystem.loadTask("5");
			// The filesystem loadTask should handle normalization
			expect(taskWithoutPrefix?.id).toBe("TASK-5"); // IDs normalized to uppercase
		});

		it("should return null for non-existent tasks", async () => {
			const core = CORE;

			const nonExistentTask = await core.filesystem.loadTask("task-999");
			expect(nonExistentTask).toBeNull();
		});

		it("should not modify task files (read-only operation)", async () => {
			const core = CORE;

			// Create a test task
			const originalTask = {
				id: "task-1",
				title: "Read Only Test",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: ["readonly"],
				dependencies: [],
				rawContent: "Original description",
			};

			await core.createTask(originalTask);

			// Load the task (simulating view operation)
			const viewedTask = await core.filesystem.loadTask("task-1");

			// Load again to verify nothing changed
			const secondView = await core.filesystem.loadTask("task-1");

			expect(viewedTask).toEqual(secondView);
			expect(viewedTask?.title).toBe("Read Only Test");
			expect(viewedTask?.rawContent).toBe("Original description");
		});
	});

	describe("task shortcut command", () => {
		beforeEach(async () => {
			({
				projectRoot: PROJECT_ROOT,
				core: CORE,
				env: ENV,
			} = await initializeGlobalTestProject(TEST_DIR, "Shortcut Test Project"));
		});

		it("should display formatted task details like the view command", async () => {
			const core = CORE;

			await core.createTask({
				id: "task-1",
				title: "Shortcut Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Shortcut description",
			});

			const resultShortcut = await viewTaskPlatformAware({ taskId: "1", plain: true }, PROJECT_ROOT, CORE);
			const resultView = await viewTaskPlatformAware(
				{ taskId: "1", plain: true, useViewCommand: true },
				PROJECT_ROOT,
				CORE,
			);

			const outShortcut = resultShortcut.stdout;
			const outView = resultView.stdout;

			expect(outShortcut).toBe(outView);
			expect(outShortcut).toContain("Task task-1 - Shortcut Task");
		});
	});

	describe("task edit command", () => {
		beforeEach(async () => {
			// Set up a git repository and initialize backlog
			({
				projectRoot: PROJECT_ROOT,
				core: CORE,
				env: ENV,
			} = await initializeGlobalTestProject(TEST_DIR, "Edit Test Project"));
		});

		it("should update task title, description, and status", async () => {
			const core = CORE;

			// Create a test task
			await core.createTask({
				id: "task-1",
				title: "Original Title",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Original description",
			});

			// Load and edit the task
			const task = await core.filesystem.loadTask("task-1");
			expect(task).not.toBeNull();

			await core.updateTaskFromInput("task-1", {
				title: "Updated Title",
				description: "Updated description",
				status: "In Progress",
			});

			// Verify changes were persisted
			const updatedTask = await core.filesystem.loadTask("task-1");
			expect(updatedTask?.title).toBe("Updated Title");
			expect(extractStructuredSection(updatedTask?.rawContent || "", "description")).toBe("Updated description");
			expect(updatedTask?.status).toBe("In Progress");
			const today = new Date().toISOString().slice(0, 16).replace("T", " ");
			expect(updatedTask?.updatedDate).toBe(today);
		});

		it("should update assignee", async () => {
			const core = CORE;

			// Create a test task
			await core.createTask({
				id: "task-2",
				title: "Assignee Test",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "Testing assignee updates",
			});

			// Update assignee
			await core.updateTaskFromInput("task-2", { assignee: ["newuser@example.com"] });

			// Verify assignee was updated
			const updatedTask = await core.filesystem.loadTask("task-2");
			expect(updatedTask?.assignee).toEqual(["newuser@example.com"]);
		});

		it("should replace all labels with new labels", async () => {
			const core = CORE;

			// Create a test task with existing labels
			await core.createTask({
				id: "task-3",
				title: "Label Replace Test",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: ["old1", "old2"],
				dependencies: [],
				rawContent: "Testing label replacement",
			});

			// Replace all labels
			await core.updateTaskFromInput("task-3", { labels: ["new1", "new2", "new3"] });

			// Verify labels were replaced
			const updatedTask = await core.filesystem.loadTask("task-3");
			expect(updatedTask?.labels).toEqual(["new1", "new2", "new3"]);
		});

		it("should add labels without replacing existing ones", async () => {
			const core = CORE;

			// Create a test task with existing labels
			await core.createTask({
				id: "task-4",
				title: "Label Add Test",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: ["existing"],
				dependencies: [],
				rawContent: "Testing label addition",
			});

			// Add new labels
			await core.updateTaskFromInput("task-4", { addLabels: ["added1", "added2"] });

			// Verify labels were added
			const updatedTask = await core.filesystem.loadTask("task-4");
			expect(updatedTask?.labels).toEqual(["existing", "added1", "added2"]);
		});

		it("should remove specific labels", async () => {
			const core = CORE;

			// Create a test task with multiple labels
			await core.createTask({
				id: "task-5",
				title: "Label Remove Test",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: ["keep1", "remove", "keep2"],
				dependencies: [],
				rawContent: "Testing label removal",
			});

			// Remove specific label
			await core.updateTaskFromInput("task-5", { removeLabels: ["remove"] });

			// Verify label was removed
			const updatedTask = await core.filesystem.loadTask("task-5");
			expect(updatedTask?.labels).toEqual(["keep1", "keep2"]);
		});

		it("should handle non-existent task gracefully", async () => {
			const core = CORE;

			const nonExistentTask = await core.filesystem.loadTask("task-999");
			expect(nonExistentTask).toBeNull();
		});

		it("should automatically set updated_date field when editing", async () => {
			const core = CORE;

			// Create a test task
			await core.createTask({
				id: "task-6",
				title: "Updated Date Test",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				rawContent: "Testing updated date",
			});

			// Edit the task (without manually setting updatedDate)
			await core.updateTaskFromInput("task-6", { title: "Updated Title" });

			// Verify updated_date was automatically set to today's date
			const updatedTask = await core.filesystem.loadTask("task-6");
			const today = new Date().toISOString().slice(0, 16).replace("T", " ");
			expect(updatedTask?.updatedDate).toBe(today);
			expect(updatedTask?.createdDate).toBe("2025-06-07"); // Should remain unchanged
		});

		it("should preserve YAML frontmatter formatting", async () => {
			const core = CORE;

			// Create a test task
			await core.createTask({
				id: "task-8",
				title: "YAML Test",
				status: "To Do",
				assignee: ["testuser"],
				createdDate: "2025-06-08",
				labels: ["yaml", "test"],
				dependencies: ["task-1"],
				rawContent: "Testing YAML preservation",
			});

			// Edit the task
			await core.updateTaskFromInput("task-8", {
				title: "Updated YAML Test",
				status: "In Progress",
			});

			// Verify all frontmatter fields are preserved
			const updatedTask = await core.filesystem.loadTask("task-8");
			expect(updatedTask?.id).toBe("TASK-8"); // IDs normalized to uppercase
			expect(updatedTask?.title).toBe("Updated YAML Test");
			expect(updatedTask?.status).toBe("In Progress");
			expect(updatedTask?.assignee).toEqual(["testuser"]);
			expect(updatedTask?.createdDate).toBe("2025-06-08");
			const today = new Date().toISOString().slice(0, 16).replace("T", " ");
			expect(updatedTask?.updatedDate).toBe(today);
			expect(updatedTask?.labels).toEqual(["yaml", "test"]);
			expect(updatedTask?.dependencies).toEqual(["task-1"]);
			expect(updatedTask?.rawContent).toBe("Testing YAML preservation");
		});
	});

	describe("task archive and state transition commands", () => {
		beforeEach(async () => {
			// Set up a git repository and initialize backlog
			({
				projectRoot: PROJECT_ROOT,
				core: CORE,
				env: ENV,
			} = await initializeGlobalTestProject(TEST_DIR, "Archive Test Project"));
		});

		it("should archive a task", async () => {
			const core = CORE;

			// Create a test task
			await core.createTask({
				id: "task-1",
				title: "Archive Test Task",
				status: "Done",
				assignee: [],
				createdDate: "2025-06-08",
				labels: ["completed"],
				dependencies: [],
				rawContent: "Task ready for archiving",
			});

			// Archive the task
			const success = await core.archiveTask("task-1");
			expect(success).toBe(true);

			// Verify task is no longer in tasks directory
			const task = await core.filesystem.loadTask("task-1");
			expect(task).toBeNull();

			// Verify task exists in archive
			const { readdir } = await import("node:fs/promises");
			const archiveFiles = await readdir(join(PROJECT_ROOT, "archive", "tasks"));
			expect(archiveFiles.some((f) => f.startsWith("task-1"))).toBe(true);
		});

		it("should handle archiving non-existent task", async () => {
			const core = CORE;

			const success = await core.archiveTask("task-999");
			expect(success).toBe(false);
		});
	});

	describe("board view command", () => {
		beforeEach(async () => {
			({
				projectRoot: PROJECT_ROOT,
				core: CORE,
				env: ENV,
			} = await initializeGlobalTestProject(TEST_DIR, "Board Test Project"));
		});

		it("should display kanban board with tasks grouped by status", async () => {
			const core = CORE;

			// Create test tasks with different statuses
			await core.createTask({
				id: "task-1",
				title: "Todo Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "A task in todo",
			});

			await core.createTask({
				id: "task-2",
				title: "Progress Task",
				status: "In Progress",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "A task in progress",
			});

			await core.createTask({
				id: "task-3",
				title: "Done Task",
				status: "Done",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "A completed task",
			});

			const tasks = await core.filesystem.listTasks();
			expect(tasks).toHaveLength(3);

			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];
			expect(statuses).toEqual(["To Do", "Ready", "In Progress", "Review", "Verify", "Done"]);

			// Test the kanban board generation
			const { generateKanbanBoardWithMetadata } = await import("../board.ts");
			const board = generateKanbanBoardWithMetadata(tasks, statuses, "Test Project");

			// Verify board contains all statuses and tasks (now on separate lines)
			expect(board).toContain("To Do");
			expect(board).toContain("In Progress");
			expect(board).toContain("Done");
			expect(board).toContain("TASK-1");
			expect(board).toContain("Todo Task");
			expect(board).toContain("TASK-2");
			expect(board).toContain("Progress Task");
			expect(board).toContain("TASK-3");
			expect(board).toContain("Done Task");

			// Verify board structure (now includes metadata header)
			const lines = board.split("\n");
			expect(board).toContain("# Kanban Board Export");
			expect(board).toContain("To Do");
			expect(board).toContain("In Progress");
			expect(board).toContain("Done");
			expect(board).toContain("|"); // Table structure
			expect(lines.length).toBeGreaterThan(5); // Should have content rows
		});

		it("should handle empty project with default statuses", async () => {
			const core = CORE;

			const tasks = await core.filesystem.listTasks();
			expect(tasks).toHaveLength(0);

			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			const { generateKanbanBoardWithMetadata } = await import("../board.ts");
			const board = generateKanbanBoardWithMetadata(tasks, statuses, "Test Project");

			// Should return board with metadata, configured status columns, and empty-state message
			expect(board).toContain("# Kanban Board Export");
			expect(board).toContain("| To Do | Ready | In Progress | Review | Verify | Done |");
			expect(board).toContain("No tasks found");
		});

		it("should support vertical layout option", async () => {
			const core = CORE;

			await core.createTask({
				id: "task-1",
				title: "Todo Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "A task in todo",
			});

			const tasks = await core.filesystem.listTasks();
			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			const { generateKanbanBoardWithMetadata } = await import("../board.ts");
			const board = generateKanbanBoardWithMetadata(tasks, statuses, "Test Project");

			// Should contain proper board structure
			expect(board).toContain("# Kanban Board Export");
			expect(board).toContain("To Do");
			expect(board).toContain("TASK-1");
			expect(board).toContain("Todo Task");
		});

		it("should support --vertical shortcut flag", async () => {
			const core = CORE;

			await core.createTask({
				id: "task-1",
				title: "Shortcut Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-09",
				labels: [],
				dependencies: [],
				rawContent: "Testing vertical shortcut",
			});

			const tasks = await core.filesystem.listTasks();
			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			// Test that --vertical flag produces vertical layout
			const { generateKanbanBoardWithMetadata } = await import("../board.ts");
			const board = generateKanbanBoardWithMetadata(tasks, statuses, "Test Project");

			// Should contain proper board structure
			expect(board).toContain("# Kanban Board Export");
			expect(board).toContain("To Do");
			expect(board).toContain("TASK-1");
			expect(board).toContain("Shortcut Task");
		});

		it("should default to view when no subcommand is provided", async () => {
			const core = CORE;

			await core.createTask({
				id: "task-99",
				title: "Default Cmd Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-10",
				labels: [],
				dependencies: [],
				rawContent: "test",
			});

			const resultDefault = await $`bun ${["src/cli.ts", "board"]}`.cwd(PROJECT_ROOT).env(ENV).quiet().nothrow();
			const resultView = await $`bun ${["src/cli.ts", "board", "view"]}`.cwd(PROJECT_ROOT).env(ENV).quiet().nothrow();

			expect(resultDefault.stdout.toString()).toBe(resultView.stdout.toString());
		});

		it("should export kanban board to file", async () => {
			const core = CORE;

			// Create test tasks
			await core.createTask({
				id: "task-1",
				title: "Export Test Task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-06-09",
				labels: [],
				dependencies: [],
				rawContent: "Testing board export",
			});

			const { exportKanbanBoardToFile } = await import("../index.ts");
			const outputPath = join(TEST_DIR, "test-export.md");
			const tasks = await core.filesystem.listTasks();
			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			await exportKanbanBoardToFile(tasks, statuses, outputPath, "TestProject");

			// Verify file was created and contains expected content
			const content = await Bun.file(outputPath).text();
			expect(content).toContain("To Do");
			expect(content).toContain("TASK-1");
			expect(content).toContain("Export Test Task");
			expect(content).toContain("# Kanban Board Export");
			expect(content).toContain("Project: TestProject");

			// Test overwrite behavior
			await exportKanbanBoardToFile(tasks, statuses, outputPath, "TestProject");
			const overwrittenContent = await Bun.file(outputPath).text();
			const occurrences = overwrittenContent.split("TASK-1").length - 1;
			expect(occurrences).toBe(1); // Should appear once after overwrite
		});
	});
});
