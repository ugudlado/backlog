#!/usr/bin/env node

import { join, resolve } from "node:path";
import { stdin as input } from "node:process";
import { createInterface } from "node:readline/promises";
import * as clack from "@clack/prompts";
import { $, spawn } from "bun";
import { Command } from "commander";
import { runAdvancedConfigWizard } from "./commands/advanced-config-wizard.ts";
import { registerMcpCommand } from "./commands/mcp.ts";
import { registerProjectCommand } from "./commands/project.ts";
import { registerServiceCommand } from "./commands/service.ts";
import { pickTaskForEditWizard, runTaskCreateWizard, runTaskEditWizard } from "./commands/task-wizard.ts";
import { initializeProject } from "./core/init.ts";
import { buildMilestoneBuckets, collectArchivedMilestoneKeys, milestoneKey } from "./core/milestones.ts";
import { formatTaskPlainText } from "./formatters/task-plain-text.ts";
import {
	type AgentInstructionFile,
	Core,
	type EnsureMcpGuidelinesResult,
	ensureMcpGuidelines,
	exportKanbanBoardToFile,
	updateReadmeWithBoard,
} from "./index.ts";
import {
	type BacklogConfig,
	isLocalEditableTask,
	type Milestone,
	type SearchPriorityFilter,
	type SearchResult,
	type Task,
	type TaskListFilter,
	type TaskSearchResult,
} from "./types/index.ts";
import type { TaskEditArgs } from "./types/task-edit-args.ts";
import { createLoadingScreen } from "./ui/loading.ts";
import { viewTaskEnhanced } from "./ui/task-viewer-with-search.ts";
import { type AgentSelectionValue, processAgentSelection } from "./utils/agent-selection.ts";
import { findBacklogRoot } from "./utils/find-backlog-root.ts";
import { readMachineConfig } from "./utils/machine-config.ts";
import { createMilestoneFilterValueResolver, resolveClosestMilestoneFilterValue } from "./utils/milestone-filter.ts";
import { resolveMilestoneInputForStorage } from "./utils/milestone-storage.ts";
import { hasAnyPrefix } from "./utils/prefix-config.ts";
import {
	isRemoteMode,
	remoteSearch,
	remoteTaskArchive,
	remoteTaskCreate,
	remoteTaskEdit,
	remoteTaskList,
	remoteTaskNext,
	remoteTaskView,
} from "./utils/remote-backend.ts";
import { type RuntimeCwdResolution, resolveRuntimeCwd } from "./utils/runtime-cwd.ts";
import { formatValidStatuses, getCanonicalStatus, getValidStatuses } from "./utils/status.ts";
import {
	normalizeDependencies,
	parseDelimitedStringList,
	parsePositiveIndexList,
	processAcceptanceCriteriaOptions,
	toStringArray,
} from "./utils/task-builders.ts";
import { buildTaskUpdateInput } from "./utils/task-edit-builder.ts";
import { normalizeTaskId, taskIdsEqual } from "./utils/task-path.ts";
import { sortTasks } from "./utils/task-sorting.ts";
import { getVersion } from "./utils/version.ts";

type IntegrationMode = "mcp" | "cli" | "none";

function normalizeIntegrationOption(value: string): IntegrationMode | null {
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "mcp" ||
		normalized === "connector" ||
		normalized === "model-context-protocol" ||
		normalized === "model_context_protocol"
	) {
		return "mcp";
	}
	if (
		normalized === "cli" ||
		normalized === "legacy" ||
		normalized === "commands" ||
		normalized === "command" ||
		normalized === "instructions" ||
		normalized === "instruction" ||
		normalized === "agent" ||
		normalized === "agents"
	) {
		return "cli";
	}
	if (
		normalized === "none" ||
		normalized === "skip" ||
		normalized === "manual" ||
		normalized === "later" ||
		normalized === "no" ||
		normalized === "off"
	) {
		return "none";
	}
	return null;
}

// Always use "backlog" as the global MCP server name so fallback mode works when the project isn't initialized.
const MCP_SERVER_NAME = "backlog";

const MCP_CLIENT_INSTRUCTION_MAP: Record<string, AgentInstructionFile> = {
	claude: "CLAUDE.md",
	codex: "AGENTS.md",
	gemini: "GEMINI.md",
	kiro: "AGENTS.md",
	guide: "AGENTS.md",
};

async function openUrlInBrowser(url: string): Promise<void> {
	let cmd: string[];
	if (process.platform === "darwin") {
		cmd = ["open", url];
	} else if (process.platform === "win32") {
		cmd = ["cmd", "/c", "start", "", url];
	} else {
		cmd = ["xdg-open", url];
	}
	try {
		await $`${cmd}`.quiet();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`  ⚠️  Unable to open browser automatically (${message}). Please visit ${url}`);
	}
}

async function runMcpClientCommand(label: string, command: string, args: string[]): Promise<string> {
	console.log(`    Configuring ${label}...`);
	try {
		const child = spawn({
			cmd: [command, ...args],
			stdout: "inherit",
			stderr: "inherit",
		});
		await child.exited;
		console.log(`    ✓ Added Backlog MCP server to ${label}`);
		return label;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`    ⚠️ Unable to configure ${label} automatically (${message}).`);
		console.warn(`       Run manually: ${command} ${args.join(" ")}`);
		return `${label} (manual setup required)`;
	}
}

// Helper function for accumulating multiple CLI option values
function createMultiValueAccumulator() {
	return (value: string, previous: string | string[]) => {
		const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
		return [...soFar, value];
	};
}

function printMissingRequiredArgument(argumentName: string): void {
	console.error(`error: missing required argument '${argumentName}'`);
	process.exitCode = 1;
}

function hasCreateFieldFlags(options: Record<string, unknown>): boolean {
	return Boolean(
		options.description !== undefined ||
			options.desc !== undefined ||
			options.assignee !== undefined ||
			options.status !== undefined ||
			options.labels !== undefined ||
			options.priority !== undefined ||
			options.ordinal !== undefined ||
			options.milestone !== undefined ||
			options.plain ||
			options.ac !== undefined ||
			options.acceptanceCriteria !== undefined ||
			options.dod !== undefined ||
			options.dodDefaults === false ||
			options.plan !== undefined ||
			options.notes !== undefined ||
			options.finalSummary !== undefined ||
			options.draft ||
			options.parent !== undefined ||
			options.dependsOn !== undefined ||
			options.dep !== undefined ||
			options.ref !== undefined ||
			options.doc !== undefined ||
			options.modifiedFile !== undefined,
	);
}

function hasEditFieldFlags(options: Record<string, unknown>): boolean {
	return Boolean(
		options.title !== undefined ||
			options.description !== undefined ||
			options.desc !== undefined ||
			options.assignee !== undefined ||
			options.status !== undefined ||
			options.label !== undefined ||
			options.priority !== undefined ||
			options.ordinal !== undefined ||
			options.milestone !== undefined ||
			options.clearMilestone ||
			options.plain ||
			options.addLabel !== undefined ||
			options.removeLabel !== undefined ||
			options.ac !== undefined ||
			options.dod !== undefined ||
			options.removeAc !== undefined ||
			options.removeDod !== undefined ||
			options.checkAc !== undefined ||
			options.checkDod !== undefined ||
			options.uncheckAc !== undefined ||
			options.uncheckDod !== undefined ||
			options.acceptanceCriteria !== undefined ||
			options.plan !== undefined ||
			options.notes !== undefined ||
			options.finalSummary !== undefined ||
			options.appendNotes !== undefined ||
			options.appendFinalSummary !== undefined ||
			options.clearFinalSummary ||
			options.dependsOn !== undefined ||
			options.dep !== undefined ||
			options.ref !== undefined ||
			options.doc !== undefined ||
			options.modifiedFile !== undefined,
	);
}

// Builds TaskEditArgs from CLI options without requiring Core (used by remote mode).
// Skips milestone resolution and status validation — the server handles those.
function buildCliEditArgs(taskId: string, options: Record<string, unknown>): TaskEditArgs & { id: string } {
	const labelValues = parseDelimitedStringList(options.label as string | undefined) ?? [];
	const addLabelValues = parseDelimitedStringList(options.addLabel as string | undefined) ?? [];
	const removeLabelValues = parseDelimitedStringList(options.removeLabel as string | undefined) ?? [];
	const assigneeValues = parseDelimitedStringList(options.assignee as string | undefined) ?? [];
	const normalizedReferences = parseDelimitedStringList(options.ref as string | undefined);
	const normalizedDocumentation = parseDelimitedStringList(options.doc as string | undefined);
	const normalizedModifiedFiles = parseDelimitedStringList(options.modifiedFile as string | undefined);
	const notesAppendValues = toStringArray(options.appendNotes);
	const finalSummaryAppendValues = toStringArray(options.appendFinalSummary);
	const combinedDeps = [...toStringArray(options.dependsOn), ...toStringArray(options.dep)];
	const dependencyValues = combinedDeps.length > 0 ? normalizeDependencies(combinedDeps) : undefined;
	const acceptanceAdditions = processAcceptanceCriteriaOptions(
		options as Parameters<typeof processAcceptanceCriteriaOptions>[0],
	);
	const dodAdditions = toStringArray(options.dod)
		.map((v) => String(v).trim())
		.filter(Boolean);
	const removeCriteria = parsePositiveIndexList(options.removeAc as string[] | undefined);
	const checkCriteria = parsePositiveIndexList(options.checkAc as string[] | undefined);
	const uncheckCriteria = parsePositiveIndexList(options.uncheckAc as string[] | undefined);
	const removeDod = parsePositiveIndexList(options.removeDod as string[] | undefined);
	const checkDod = parsePositiveIndexList(options.checkDod as string[] | undefined);
	const uncheckDod = parsePositiveIndexList(options.uncheckDod as string[] | undefined);

	const args: TaskEditArgs & { id: string } = { id: normalizeTaskId(taskId) };
	if (options.title) args.title = String(options.title);
	const desc = options.description ?? options.desc;
	if (desc !== undefined) args.description = String(desc);
	if (options.status) args.status = String(options.status);
	if (options.priority) {
		const p = String(options.priority).toLowerCase();
		if (p === "high" || p === "medium" || p === "low") args.priority = p;
	}
	if (options.ordinal !== undefined) args.ordinal = Number(options.ordinal);
	if (typeof options.milestone === "string") args.milestone = options.milestone;
	else if (options.clearMilestone) args.milestone = null;
	if (labelValues.length > 0) args.labels = labelValues;
	if (addLabelValues.length > 0) args.addLabels = addLabelValues;
	if (removeLabelValues.length > 0) args.removeLabels = removeLabelValues;
	if (assigneeValues.length > 0) args.assignee = assigneeValues;
	if (dependencyValues?.length) args.dependencies = dependencyValues;
	if (normalizedReferences?.length) args.references = normalizedReferences;
	if (normalizedDocumentation?.length) args.documentation = normalizedDocumentation;
	if (normalizedModifiedFiles?.length) args.modifiedFiles = normalizedModifiedFiles;
	if (typeof options.plan === "string") args.planSet = options.plan;
	if (typeof options.notes === "string") args.notesSet = options.notes;
	if (notesAppendValues.length > 0) args.notesAppend = notesAppendValues;
	if (typeof options.finalSummary === "string") args.finalSummary = options.finalSummary;
	if (finalSummaryAppendValues.length > 0) args.finalSummaryAppend = finalSummaryAppendValues;
	if (options.clearFinalSummary) args.finalSummaryClear = true;
	if (acceptanceAdditions.length > 0) args.acceptanceCriteriaAdd = acceptanceAdditions;
	if (removeCriteria.length > 0) args.acceptanceCriteriaRemove = removeCriteria;
	if (checkCriteria.length > 0) args.acceptanceCriteriaCheck = checkCriteria;
	if (uncheckCriteria.length > 0) args.acceptanceCriteriaUncheck = uncheckCriteria;
	if (dodAdditions.length > 0) args.definitionOfDoneAdd = dodAdditions;
	if (removeDod.length > 0) args.definitionOfDoneRemove = removeDod;
	if (checkDod.length > 0) args.definitionOfDoneCheck = checkDod;
	if (uncheckDod.length > 0) args.definitionOfDoneUncheck = uncheckDod;
	return args;
}

async function resolveCliMilestoneInput(core: Core, milestone: string): Promise<string> {
	const [activeMilestones, archivedMilestones] = await Promise.all([
		core.filesystem.listMilestones(),
		core.filesystem.listArchivedMilestones(),
	]);
	return resolveMilestoneInputForStorage(milestone, activeMilestones, archivedMilestones);
}

// Helper function to process multiple AC operations
/**
 * Processes --ac and --acceptance-criteria options to extract acceptance criteria
 * Handles both single values and arrays from multi-value accumulators
 */
function getDefaultAdvancedConfig(existingConfig?: BacklogConfig | null): Partial<BacklogConfig> {
	return {
		definitionOfDone: existingConfig?.definitionOfDone ? [...existingConfig.definitionOfDone] : undefined,
		defaultPort: existingConfig?.defaultPort ?? 6420,
		autoOpenBrowser: existingConfig?.autoOpenBrowser ?? true,
	};
}

/**
 * Resolves the Backlog.md project root from the current working directory.
 * Walks up the directory tree to find backlog/ or backlog.json, with git root fallback.
 * Exits with error message if no Backlog.md project is found.
 */
/**
 * Project root resolver for `backlog server` (no --project flag).
 *
 * Order: workspaces.yml `current` id → first registered workspace → walk-up
 * from CWD. The first two cover the launchd / background-service case where
 * CWD is `/`; the walk-up matches the interactive `cd ~/repo && backlog server`
 * usage.
 */
async function resolveServerProjectRoot(): Promise<string> {
	const { readProjectsIndex } = await import("./utils/projects-index.ts");
	const { setActiveWorkspaceDataDir } = await import("./utils/active-workspace.ts");
	const index = await readProjectsIndex();

	// Projects are discovered by scanning <globalStore>/*. Bootstrap onto the
	// current (or first) scanned slot so the daemon serves a project even when
	// CWD is `/` (systemd WorkingDirectory). The slot is both project root and
	// data dir.
	const { scanGlobalStoreProjects } = await import("./utils/global-store-scan.ts");
	const scanned = await scanGlobalStoreProjects();
	const slot = scanned.find((p) => p.id === index.current) ?? scanned[0];
	if (slot) {
		setActiveWorkspaceDataDir(slot.slotPath, slot.slotPath);
		return slot.slotPath;
	}
	return await requireProjectRoot();
}

async function requireProjectRoot(): Promise<string> {
	let runtimeCwd: RuntimeCwdResolution;
	try {
		runtimeCwd = await resolveRuntimeCwd();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	}

	const { resolveCliProjectRoot } = await import("./utils/projects-index.ts");
	const { setActiveWorkspaceDataDir } = await import("./utils/active-workspace.ts");
	const { isSafeSlotName } = await import("./utils/backlog-directory.ts");
	const projectName = program.opts().project as string | undefined;
	if (projectName && !isSafeSlotName(projectName)) {
		console.error(`Invalid --project name: "${projectName}". It must not contain path separators or '..'.`);
		process.exit(1);
	}
	const resolved = await resolveCliProjectRoot(runtimeCwd.cwd, projectName);
	if (!resolved.ok) {
		console.error("No Backlog project found. Run `backlog init` to initialize.");
		process.exit(1);
	}
	// When the cwd is not a Backlog.md project, resolution falls back to the
	// global `current` project. Surface which one so the user isn't surprised by
	// data from an unrelated project (only when they didn't pass --project).
	if (resolved.viaGlobalCurrent && !projectName) {
		console.error(
			`Using global project "${resolved.projectName}" (current directory is not a Backlog project). ` +
				"Switch with `backlog project switch <name>` or pass `--project <name>`.",
		);
	}
	setActiveWorkspaceDataDir(resolved.projectRoot, resolved.dataDir);
	return resolved.projectRoot;
}

/**
 * Run an interactive TUI that supports in-view project switching, reloading
 * against the chosen project until the user quits.
 *
 * `run` receives a fresh `Core` for the active project and returns the project
 * to switch to (or null to quit). The initial root comes from
 * `requireProjectRoot()`; subsequent iterations are driven purely off the
 * picked project's slot path, so the stale `--project`/cwd is never re-read.
 */
async function runWithProjectSwitch(
	initialRoot: string,
	run: (core: Core) => Promise<import("./utils/global-store-scan.ts").GlobalStoreProject | null>,
): Promise<void> {
	const { setActiveWorkspaceDataDir } = await import("./utils/active-workspace.ts");
	const { setCurrentProjectId } = await import("./utils/projects-index.ts");
	let root = initialRoot;
	let switchTo: import("./utils/global-store-scan.ts").GlobalStoreProject | null = null;
	do {
		if (switchTo) {
			setActiveWorkspaceDataDir(switchTo.slotPath, switchTo.slotPath);
			await setCurrentProjectId(switchTo.id);
			root = switchTo.slotPath;
		}
		switchTo = await run(new Core(root));
	} while (switchTo);
}

// Windows color fix
if (process.platform === "win32") {
	const term = process.env.TERM;
	if (!term || /^(xterm|dumb|ansi|vt100)$/i.test(term)) {
		process.env.TERM = "xterm-256color";
	}
}

// Auto-plain fallback for commands that otherwise launch interactive UIs.
// Require both stdin and stdout to be TTY before attempting an interactive experience.
const hasInteractiveTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const shouldAutoPlain = !hasInteractiveTTY;
const plainFlagInArgv = process.argv.includes("--plain");

function isPlainRequested(options?: { plain?: boolean }): boolean {
	return Boolean(options?.plain || plainFlagInArgv);
}

// Temporarily isolate BUN_OPTIONS during CLI parsing to prevent conflicts
// Save the original value so it's available for subsequent commands
const originalBunOptions = process.env.BUN_OPTIONS;
if (process.env.BUN_OPTIONS) {
	delete process.env.BUN_OPTIONS;
}

// Get version from package.json
const version = await getVersion();

// Bare-run splash screen handling (before Commander parses commands)
// Show a welcome splash when invoked without subcommands, unless help/version requested
try {
	let rawArgs = process.argv.slice(2);
	// Some package managers (e.g., Bun global shims) may inject the resolved
	// binary path as the first non-node argument. Strip it if detected.
	if (rawArgs.length > 0) {
		const first = rawArgs[0];
		if (
			typeof first === "string" &&
			/node_modules[\\/]+backlog\.md-(darwin|linux|windows)-[^\\/]+[\\/]+backlog(\.exe)?$/.test(first)
		) {
			rawArgs = rawArgs.slice(1);
		}
	}
	const wantsHelp = rawArgs.includes("-h") || rawArgs.includes("--help");
	const wantsVersion = rawArgs.includes("-v") || rawArgs.includes("--version");
	// Treat only --plain as allowed flag for splash; any other args means use normal CLI parsing
	const onlyPlain = rawArgs.length === 1 && rawArgs[0] === "--plain";
	const isBare = rawArgs.length === 0 || onlyPlain;
	if (isBare && !wantsHelp && !wantsVersion) {
		const isTTY = !!process.stdout.isTTY;
		const forcePlain = rawArgs.includes("--plain");
		const noColor = !!process.env.NO_COLOR || !isTTY;

		let initialized = false;
		try {
			const runtimeCwd = await resolveRuntimeCwd();
			const projectRoot = await findBacklogRoot(runtimeCwd.cwd);
			if (projectRoot) {
				const core = new Core(projectRoot);
				const cfg = await core.filesystem.loadConfig();
				initialized = !!cfg;
			}
		} catch {
			initialized = false;
		}

		const { printSplash } = await import("./ui/splash.ts");
		// Auto-fallback to plain when non-TTY, or explicit --plain, or if terminal very narrow
		const termWidth = Math.max(0, Number(process.stdout.columns || 0));
		const autoPlain = !isTTY || (termWidth > 0 && termWidth < 60);
		await printSplash({
			version,
			initialized,
			plain: forcePlain || autoPlain,
			color: !noColor,
		});
		// Ensure we don't enter Commander command parsing
		process.exit(0);
	}
} catch {
	// Fall through to normal CLI parsing on any splash error
}

function getMcpStartCwdOverrideFromArgv(argv = process.argv): string | undefined {
	const args = argv.slice(2);
	const mcpIndex = args.indexOf("mcp");
	if (mcpIndex < 0 || args[mcpIndex + 1] !== "start") {
		return undefined;
	}

	for (let i = mcpIndex + 2; i < args.length; i++) {
		const arg = args[i];
		if (!arg) {
			continue;
		}
		if (arg === "--cwd") {
			const next = args[i + 1]?.trim();
			return next || undefined;
		}
		if (arg?.startsWith("--cwd=")) {
			const value = arg.slice("--cwd=".length).trim();
			return value || undefined;
		}
	}

	return undefined;
}

// Global config migration - run before any command processing
// Only run if we're in a backlog project (skip for init, help, version)
const shouldRunMigration =
	!process.argv.includes("init") &&
	!process.argv.includes("--help") &&
	!process.argv.includes("-h") &&
	!process.argv.includes("--version") &&
	!process.argv.includes("-v") &&
	process.argv.length > 2; // Ensure we have actual commands

if (shouldRunMigration) {
	try {
		const runtimeCwd = await resolveRuntimeCwd({ cwd: getMcpStartCwdOverrideFromArgv() });
		const projectRoot = await findBacklogRoot(runtimeCwd.cwd);
		if (projectRoot) {
			const core = new Core(projectRoot);

			// Only migrate if config already exists (project is already initialized)
			const config = await core.filesystem.loadConfig();
			if (config) {
				await core.ensureConfigMigrated();
			}
		}
	} catch (_error) {
		// Silently ignore migration errors - project might not be initialized yet
	}
}

const program = new Command();
program
	.name("backlog")
	.description("Backlog - Project management CLI")
	.version(version, "-v, --version", "display version number")
	.option("--project <name>", "operate on the named global-store project (overrides the current selection)");

program
	.command("init [projectName]")
	.description("initialize backlog project in the current directory")
	.option(
		"--agent-instructions <instructions>",
		"comma-separated agent instructions to create. Valid: claude, agents, gemini, copilot, cursor (alias of agents), none. Use 'none' to skip; when combined with others, 'none' is ignored.",
	)
	.option("--install-claude-agent <boolean>", "install Claude Code agent (default: false)")
	.option("--integration-mode <mode>", "choose how AI tools connect to Backlog (mcp, cli, or none)")
	.option("--task-prefix <prefix>", "custom task prefix, letters only (default: task)")
	.option("--defaults", "use default values for all prompts")
	.action(
		async (
			projectName: string | undefined,
			options: {
				agentInstructions?: string;
				installClaudeAgent?: string;
				integrationMode?: string;
				taskPrefix?: string;
				defaults?: boolean;
			},
		) => {
			try {
				// init command uses process.cwd() directly - it initializes in the current directory
				const cwd = process.cwd();
				// Tasks live in the global store (~/.config/...), not the repo, so the
				// cwd's git status is irrelevant to where data goes. We don't init or
				// require git here.
				const core = new Core(cwd);

				// Check if project is already initialized and load existing config
				const existingConfig = await core.filesystem.loadConfig();
				const isReInitialization = !!existingConfig;

				if (isReInitialization) {
					console.log(
						"Existing backlog project detected. Current configuration will be preserved where not specified.",
					);
				}

				// Backlog stores every project's tasks in the configured global store
				// (`globalStore` in ~/.config/backlog/config.yml). It is required.
				const machineConfig = readMachineConfig();
				if (!machineConfig.globalStore) {
					console.error(
						"globalStore is not configured. Set it once in ~/.config/backlog/config.yml, e.g.:\n" +
							"  globalStore: ~/.config/backlog/workspaces\n" +
							"Then re-run `backlog init`.",
					);
					process.exit(1);
				}

				// Helper function to parse boolean strings
				const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
					if (value === undefined) return defaultValue;
					return value.toLowerCase() === "true" || value === "1";
				};

				function abortInitialization(message = "Aborting initialization.") {
					clack.cancel(message);
					process.exitCode = 1;
				}
				function cancelInitialization(message = "Initialization cancelled.") {
					clack.cancel(message);
				}

				// Non-interactive mode when any flag is provided or --defaults is used
				const isNonInteractive = !!(
					options.agentInstructions ||
					options.defaults ||
					options.installClaudeAgent ||
					options.integrationMode ||
					options.taskPrefix
				);

				// Get project name
				let name = projectName;
				if (!name) {
					const defaultName = existingConfig?.projectName || "";
					const promptMessage = isReInitialization && defaultName ? `Project name (${defaultName}):` : "Project name:";
					const enteredName = await clack.text({
						message: promptMessage,
						defaultValue: isReInitialization && defaultName ? defaultName : undefined,
						validate: (value) => {
							if (!isReInitialization || !defaultName) {
								if (!String(value ?? "").trim()) {
									return "Project name is required.";
								}
							}
							return undefined;
						},
					});
					if (clack.isCancel(enteredName)) {
						abortInitialization();
						return;
					}
					name = String(enteredName ?? "").trim();
					// Use existing name if nothing entered during re-init
					if (!name && isReInitialization && defaultName) {
						name = defaultName;
					}
					if (!name) {
						abortInitialization();
						return;
					}
				}

				// Get task prefix (first-time init only, preserved on re-init)
				let taskPrefix = options.taskPrefix;
				if (!taskPrefix && !isNonInteractive && !isReInitialization) {
					const enteredPrefix = await clack.text({
						message: "Task prefix (default: task):",
						validate: (value) => {
							const normalized = String(value ?? "").trim();
							if (!normalized) {
								return undefined;
							}
							if (!/^[a-zA-Z]+$/.test(normalized)) {
								return "Task prefix must contain only letters (a-z, A-Z).";
							}
							return undefined;
						},
					});
					if (clack.isCancel(enteredPrefix)) {
						abortInitialization();
						return;
					}
					taskPrefix = String(enteredPrefix ?? "").trim();
				}
				// Validate task prefix if provided
				if (taskPrefix && !/^[a-zA-Z]+$/.test(taskPrefix)) {
					console.error("Task prefix must contain only letters (a-z, A-Z).");
					process.exit(1);
				}

				const defaultAdvancedConfig = getDefaultAdvancedConfig(existingConfig);
				const applyAdvancedOptionOverrides = (): Partial<BacklogConfig> => ({
					...defaultAdvancedConfig,
				});

				const integrationOption = options.integrationMode
					? normalizeIntegrationOption(options.integrationMode)
					: undefined;
				if (options.integrationMode && !integrationOption) {
					console.error(`Invalid integration mode: ${options.integrationMode}. Valid options are: mcp, cli, none`);
					process.exit(1);
				}

				let integrationMode: IntegrationMode | null = integrationOption ?? (isNonInteractive ? "mcp" : null);
				const mcpServerName = MCP_SERVER_NAME;
				type AgentSelection = AgentSelectionValue;
				let agentFiles: AgentInstructionFile[] = [];
				let agentInstructionsSkipped = false;
				let mcpClientSetupSummary: string | undefined;
				const mcpGuideUrl = "https://github.com/MrLesk/Backlog.md#-mcp-integration-model-context-protocol";

				if (
					!integrationOption &&
					integrationMode === "mcp" &&
					(options.agentInstructions || options.installClaudeAgent)
				) {
					integrationMode = "cli";
				}

				if (integrationMode === "mcp" && (options.agentInstructions || options.installClaudeAgent)) {
					console.error(
						"The MCP connector option cannot be combined with --agent-instructions or --install-claude-agent.",
					);
					process.exit(1);
				}

				if (integrationMode === "none" && (options.agentInstructions || options.installClaudeAgent)) {
					console.error(
						"Skipping AI integration cannot be combined with --agent-instructions or --install-claude-agent.",
					);
					process.exit(1);
				}

				let integrationTipShown = false;
				mainSelection: while (true) {
					if (integrationMode === null) {
						if (!integrationTipShown) {
							clack.note("MCP connector is recommended for AI tool integration.", "AI setup tip");
							integrationTipShown = true;
						}
						const integrationPrompt = await clack.select({
							message: "How would you like your AI tools to connect to Backlog?",
							initialValue: "mcp",
							options: [
								{
									label: "via MCP connector (recommended for Claude Code, Codex, Gemini CLI, Kiro, Cursor, etc.)",
									value: "mcp",
								},
								{
									label: "via CLI commands (broader compatibility)",
									value: "cli",
								},
								{
									label: "Skip for now (I am not using Backlog with AI tools)",
									value: "none",
								},
							],
						});

						if (clack.isCancel(integrationPrompt)) {
							cancelInitialization();
							return;
						}

						const selectedMode = integrationPrompt ? normalizeIntegrationOption(String(integrationPrompt)) : null;
						integrationMode = selectedMode ?? "mcp";
						console.log("");
					}

					if (integrationMode === "cli") {
						if (options.agentInstructions) {
							const nameMap: Record<string, AgentSelection> = {
								cursor: "AGENTS.md",
								claude: "CLAUDE.md",
								agents: "AGENTS.md",
								gemini: "GEMINI.md",
								copilot: ".github/copilot-instructions.md",
								none: "none",
								"CLAUDE.md": "CLAUDE.md",
								"AGENTS.md": "AGENTS.md",
								"GEMINI.md": "GEMINI.md",
								".github/copilot-instructions.md": ".github/copilot-instructions.md",
							};

							const requestedInstructions = options.agentInstructions.split(",").map((f) => f.trim().toLowerCase());
							const mappedFiles: AgentSelection[] = [];

							for (const instruction of requestedInstructions) {
								const mappedFile = nameMap[instruction];
								if (!mappedFile) {
									console.error(`Invalid agent instruction: ${instruction}`);
									console.error("Valid options are: cursor, claude, agents, gemini, copilot, none");
									process.exit(1);
								}
								mappedFiles.push(mappedFile);
							}

							const { files, needsRetry, skipped } = processAgentSelection({ selected: mappedFiles });
							if (needsRetry) {
								console.error("Please select at least one agent instruction file before continuing.");
								process.exit(1);
							}
							agentFiles = files;
							agentInstructionsSkipped = skipped;
						} else if (isNonInteractive) {
							agentFiles = [];
						} else {
							while (true) {
								const response = await clack.multiselect({
									message: "Select instruction files for CLI-based AI tools (space toggles selections; enter accepts)",
									options: [
										{ label: "CLAUDE.md — Claude Code", value: "CLAUDE.md" },
										{
											label: "AGENTS.md — Codex, Cursor, Zed, Warp, Aider, RooCode, etc.",
											value: "AGENTS.md",
										},
										{ label: "GEMINI.md — Google Gemini Code Assist CLI", value: "GEMINI.md" },
										{
											label: "Copilot instructions — GitHub Copilot",
											value: ".github/copilot-instructions.md",
										},
									],
									required: false,
								});

								if (clack.isCancel(response)) {
									integrationMode = null;
									console.log("");
									continue mainSelection;
								}

								const selected = Array.isArray(response) ? (response as AgentSelection[]) : [];
								const { files, needsRetry, skipped } = processAgentSelection({ selected });
								if (needsRetry) {
									console.log("Please select at least one agent instruction file before continuing.");
									continue;
								}
								agentFiles = files;
								agentInstructionsSkipped = skipped;
								break;
							}
						}

						break;
					}

					if (integrationMode === "mcp") {
						if (isNonInteractive) {
							mcpClientSetupSummary = "skipped (non-interactive)";
							break;
						}

						console.log(`  MCP server name: ${mcpServerName}`);
						while (true) {
							const clientResponse = await clack.multiselect({
								message: "Which AI tools should we configure right now? (space toggles items; enter confirms)",
								options: [
									{ label: "Claude Code", value: "claude" },
									{ label: "OpenAI Codex", value: "codex" },
									{ label: "Gemini CLI", value: "gemini" },
									{ label: "Kiro", value: "kiro" },
									{ label: "Other (open setup guide)", value: "guide" },
								],
								required: true,
							});

							if (clack.isCancel(clientResponse)) {
								integrationMode = null;
								console.log("");
								continue mainSelection;
							}

							const selectedClients = Array.isArray(clientResponse) ? clientResponse : [];
							if (selectedClients.length === 0) {
								console.log("Please select at least one AI tool before continuing.");
								continue;
							}

							const results: string[] = [];
							const mcpGuidelineUpdates: EnsureMcpGuidelinesResult[] = [];
							const recordGuidelinesForClient = async (clientKey: string) => {
								const instructionFile = MCP_CLIENT_INSTRUCTION_MAP[clientKey];
								if (!instructionFile) {
									return;
								}
								const nudgeResult = await ensureMcpGuidelines(cwd, instructionFile);
								if (nudgeResult.changed) {
									mcpGuidelineUpdates.push(nudgeResult);
								}
							};
							const uniq = (values: string[]) => [...new Set(values)];

							for (const client of selectedClients) {
								if (client === "claude") {
									const result = await runMcpClientCommand("Claude Code", "claude", [
										"mcp",
										"add",
										"-s",
										"user",
										mcpServerName,
										"--",
										"backlog",
										"mcp",
										"start",
									]);
									results.push(result);
									await recordGuidelinesForClient(client);
									continue;
								}
								if (client === "codex") {
									const result = await runMcpClientCommand("OpenAI Codex", "codex", [
										"mcp",
										"add",
										mcpServerName,
										"backlog",
										"mcp",
										"start",
									]);
									results.push(result);
									await recordGuidelinesForClient(client);
									continue;
								}
								if (client === "gemini") {
									const result = await runMcpClientCommand("Gemini CLI", "gemini", [
										"mcp",
										"add",
										"-s",
										"user",
										mcpServerName,
										"backlog",
										"mcp",
										"start",
									]);
									results.push(result);
									await recordGuidelinesForClient(client);
									continue;
								}
								if (client === "kiro") {
									const result = await runMcpClientCommand("Kiro", "kiro-cli", [
										"mcp",
										"add",
										"--scope",
										"global",
										"--name",
										mcpServerName,
										"--command",
										"backlog",
										"--args",
										"mcp,start",
									]);
									results.push(result);
									await recordGuidelinesForClient(client);
									continue;
								}
								if (client === "guide") {
									console.log("    Opening MCP setup guide in your browser...");
									await openUrlInBrowser(mcpGuideUrl);
									results.push("Setup guide opened");
									await recordGuidelinesForClient(client);
								}
							}

							if (mcpGuidelineUpdates.length > 0) {
								const createdFiles = uniq(
									mcpGuidelineUpdates.filter((entry) => entry.created).map((entry) => entry.fileName),
								);
								const updatedFiles = uniq(
									mcpGuidelineUpdates.filter((entry) => !entry.created).map((entry) => entry.fileName),
								);
								if (createdFiles.length > 0) {
									console.log(`    Created MCP reminder file(s): ${createdFiles.join(", ")}`);
								}
								if (updatedFiles.length > 0) {
									console.log(`    Added MCP reminder to ${updatedFiles.join(", ")}`);
								}
							}

							mcpClientSetupSummary = results.join(", ");
							break;
						}

						break;
					}

					if (integrationMode === "none") {
						agentFiles = [];
						agentInstructionsSkipped = false;
						break;
					}
				}

				let advancedConfig: Partial<BacklogConfig> = { ...defaultAdvancedConfig };
				let installClaudeAgentSelection = false;

				if (isNonInteractive) {
					advancedConfig = applyAdvancedOptionOverrides();
					installClaudeAgentSelection =
						integrationMode === "cli" ? parseBoolean(options.installClaudeAgent, false) : false;
				} else {
					const advancedPrompt = await clack.confirm({
						message: "Configure advanced settings now? (Runs the advanced backlog config wizard)",
						initialValue: false,
					});
					if (clack.isCancel(advancedPrompt)) {
						abortInitialization();
						return;
					}

					if (advancedPrompt) {
						const wizardResult = await runAdvancedConfigWizard({
							existingConfig,
							cancelMessage: "Aborting initialization.",
							includeClaudePrompt: integrationMode === "cli",
						});
						advancedConfig = { ...defaultAdvancedConfig, ...wizardResult.config };
						installClaudeAgentSelection = integrationMode === "cli" ? wizardResult.installClaudeAgent : false;
					}
				}
				// Point the filesystem at the global-store slot, keyed by project name
				// (so a repo can be named independently of its directory). Validate the
				// name is a safe single path component — without this, `init "../x"`
				// would escape the global store (path traversal at a trust boundary).
				{
					const { isSafeSlotName } = await import("./utils/backlog-directory.ts");
					if (!isSafeSlotName(name)) {
						console.error(
							`Invalid project name: "${name}". ` +
								"It must not contain path separators or '..' (it names a directory in the global store).",
						);
						process.exit(1);
					}
					core.filesystem.setGlobalStoreSlot(join(machineConfig.globalStore, name), name);
				}

				// Call shared core init function
				const initResult = await initializeProject(core, {
					projectName: name,
					integrationMode: integrationMode || "none",
					mcpClients: [], // MCP clients are handled separately in CLI with interactive prompts
					agentInstructions: agentFiles,
					installClaudeAgent: installClaudeAgentSelection,
					advancedConfig: {
						definitionOfDone: advancedConfig.definitionOfDone,
						defaultPort: advancedConfig.defaultPort,
						autoOpenBrowser: advancedConfig.autoOpenBrowser,
						taskPrefix: taskPrefix || undefined,
					},
					existingConfig,
				});

				const config = initResult.config;

				// Show configuration summary
				const supportsColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
				const colorize = (code: string, value: string): string =>
					supportsColor ? `\u001B[${code}m${value}\u001B[0m` : value;
				const label = (value: string): string => colorize("1;36", value);
				const good = (value: string): string => colorize("32", value);
				const bad = (value: string): string => colorize("31", value);
				const muted = (value: string): string => colorize("2", value);
				const boolValue = (value: boolean): string => (value ? good("true") : bad("false"));
				const summaryLines: string[] = [`${label("Project Name:")} ${colorize("1", config.projectName)}`];
				summaryLines.push(`${label("Store:")} ${muted(core.filesystem.backlogDir)}`);
				// Global-store projects live outside git, so integration is always off.
				summaryLines.push(`${label("Git integration:")} ${muted("disabled (filesystem-only)")}`);
				if (integrationMode === "cli") {
					summaryLines.push(`${label("AI Integration:")} ${muted("CLI commands (legacy)")}`);
					if (agentFiles.length > 0) {
						summaryLines.push(`${label("Agent instructions:")} ${agentFiles.join(", ")}`);
					} else if (agentInstructionsSkipped) {
						summaryLines.push(`${label("Agent instructions:")} ${muted("skipped")}`);
					} else {
						summaryLines.push(`${label("Agent instructions:")} ${muted("none")}`);
					}
				} else if (integrationMode === "mcp") {
					summaryLines.push(`${label("AI Integration:")} ${good("MCP connector")}`);
					summaryLines.push(
						`${label("Agent instruction files:")} ${muted("guidance is provided through the MCP connector.")}`,
					);
					summaryLines.push(`${label("MCP server name:")} ${mcpServerName}`);
					summaryLines.push(`${label("MCP client setup:")} ${mcpClientSetupSummary ?? muted("skipped")}`);
				} else {
					summaryLines.push(`${label("AI integration:")} ${muted("skipped (configure later via `backlog init`)")}`);
				}
				summaryLines.push(label("Advanced settings:"));
				summaryLines.push(`  ${label("Web UI port:")} ${String(config.defaultPort)}`);
				summaryLines.push(`  ${label("Auto open browser:")} ${boolValue(Boolean(config.autoOpenBrowser))}`);
				summaryLines.push(
					`  ${label("Definition of Done defaults:")} ${
						(config.definitionOfDone ?? []).length > 0 ? config.definitionOfDone?.join(" | ") : muted("none")
					}`,
				);
				clack.note(summaryLines.join("\n"), "Initialization Summary");

				// Log init result
				if (initResult.isReInitialization) {
					clack.outro(`Updated backlog project configuration: ${name}`);
				} else {
					clack.outro(`Initialized backlog project: ${name}`);
				}

				// Log agent files result from shared init
				if (integrationMode === "cli") {
					if (initResult.mcpResults?.agentFiles) {
						clack.log.info(initResult.mcpResults.agentFiles);
					} else if (agentInstructionsSkipped) {
						clack.log.info("Skipping agent instruction files per selection.");
					}
				}

				// Log Claude agent result from shared init
				if (integrationMode === "cli" && initResult.mcpResults?.claudeAgent) {
					clack.log.info(`Claude Code Backlog agent ${initResult.mcpResults.claudeAgent}`);
				}
			} catch (err) {
				console.error("Failed to initialize project", err);
				process.exitCode = 1;
			}
		},
	);

const taskCmd = program.command("task").aliases(["tasks"]);

taskCmd
	.command("create [title]")
	.option("-d, --description <text>", "task description (multi-line: include real newlines inside the quoted string)")
	.option("--desc <text>", "alias for --description")
	.option("-a, --assignee <assignee>")
	.option("-s, --status <status>")
	.option("-l, --labels <labels>")
	.option("--priority <priority>", "set task priority (high, medium, low)")
	.option("--plain", "use plain text output after creating")
	.option("--ac <criteria>", "add acceptance criteria (can be used multiple times)", createMultiValueAccumulator())
	.option(
		"--acceptance-criteria <criteria>",
		"add acceptance criteria (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option("--dod <item>", "add Definition of Done item (can be used multiple times)", createMultiValueAccumulator())
	.option("--no-dod-defaults", "disable Definition of Done defaults")
	.option("--plan <text>", "add implementation plan")
	.option("--notes <text>", "add implementation notes")
	.option("--final-summary <text>", "add final summary")
	.option("--ordinal <number>", "set task ordinal for custom ordering")
	.option("-m, --milestone <milestone>", "assign task to milestone by ID or title")

	.option("-p, --parent <taskId>", "specify parent task ID")
	.option(
		"--depends-on <taskIds>",
		"specify task dependencies (comma-separated or use multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
			return [...soFar, value];
		},
	)
	.option("--dep <taskIds>", "specify task dependencies (shortcut for --depends-on)", (value, previous) => {
		const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
		return [...soFar, value];
	})
	.option("--ref <reference>", "add reference URL or file path (can be used multiple times)", (value, previous) => {
		const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
		return [...soFar, value];
	})
	.option(
		"--modified-file <path>",
		"add modified file path from project root (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
			return [...soFar, value];
		},
	)
	.option(
		"--doc <documentation>",
		"add documentation URL or file path (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
			return [...soFar, value];
		},
	)
	.action(async (title: string | undefined, options) => {
		const shouldUseWizard = hasInteractiveTTY && title === undefined && !hasCreateFieldFlags(options);
		if (!shouldUseWizard && (title === undefined || title.trim().length === 0)) {
			printMissingRequiredArgument("title");
			return;
		}

		if (isRemoteMode() && !shouldUseWizard && title) {
			const labels = options.labels
				? String(options.labels)
						.split(",")
						.map((l: string) => l.trim())
				: undefined;
			const task = await remoteTaskCreate({
				title: title.trim(),
				description: options.description ?? options.desc,
				status: options.status,
				priority: options.priority,
				assignee: options.assignee,
				labels,
				milestone: options.milestone,
				parentTaskId: options.parent,
				dependencies: options.dependsOn ?? options.dep,
				references: options.ref,
				acceptanceCriteria: options.ac ?? options.acceptanceCriteria,
				plan: options.plan,
				notes: options.notes,
			}).catch((err: Error) => {
				console.error(`Remote error: ${err.message}`);
				process.exitCode = 1;
				return null;
			});
			if (!task) return;
			console.log(`Created task ${task.id}`);
			if (isPlainRequested(options)) console.log(formatTaskPlainText(task));
			return;
		}

		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		await core.ensureConfigLoaded();

		if (shouldUseWizard) {
			const statuses = await getValidStatuses(core);
			const wizardInput = await runTaskCreateWizard({ statuses });
			if (!wizardInput) {
				clack.cancel("Task create cancelled.");
				return;
			}
			try {
				const { task, filePath } = await core.createTaskFromInput(wizardInput);
				console.log(`Created task ${task.id}`);
				if (filePath) {
					console.log(`File: ${filePath}`);
				}
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			}
			return;
		}

		const usePlainOutput = isPlainRequested(options);
		let ordinalValue: number | undefined;

		if (options.ordinal !== undefined) {
			const parsed = Number(options.ordinal);
			if (!Number.isFinite(parsed) || parsed < 0) {
				console.error(`Invalid ordinal: ${options.ordinal}. Must be a non-negative number.`);
				process.exitCode = 1;
				return;
			}
			ordinalValue = parsed;
		}

		try {
			const criteria = processAcceptanceCriteriaOptions(options);
			const milestone =
				typeof options.milestone === "string" ? await resolveCliMilestoneInput(core, options.milestone) : undefined;
			const { task, filePath } = await core.createTaskFromInput({
				title: title ?? "",
				description: options.description || options.desc ? String(options.description || options.desc) : undefined,
				status: options.status ? String(options.status) : undefined,
				assignee: options.assignee ? [String(options.assignee)] : undefined,
				labels: options.labels
					? String(options.labels)
							.split(",")
							.map((label: string) => label.trim())
							.filter(Boolean)
					: undefined,
				dependencies:
					options.dependsOn || options.dep ? normalizeDependencies(options.dependsOn || options.dep) : undefined,
				references: parseDelimitedStringList(options.ref),
				documentation: parseDelimitedStringList(options.doc),
				modifiedFiles: parseDelimitedStringList(options.modifiedFile),
				parentTaskId: options.parent ? String(options.parent) : undefined,
				priority: options.priority ? (String(options.priority).toLowerCase() as "high" | "medium" | "low") : undefined,
				...(ordinalValue !== undefined ? { ordinal: ordinalValue } : {}),
				milestone,
				implementationPlan: options.plan ? String(options.plan) : undefined,
				implementationNotes: options.notes ? String(options.notes) : undefined,
				finalSummary: options.finalSummary ? String(options.finalSummary) : undefined,
				acceptanceCriteria: criteria.map((text) => ({ text, checked: false })),
				definitionOfDoneAdd: toStringArray(options.dod),
				disableDefinitionOfDoneDefaults: options.dodDefaults === false,
			});

			if (usePlainOutput) {
				console.log(formatTaskPlainText(task, { filePathOverride: filePath }));
				return;
			}

			console.log(`Created task ${task.id}`);
			console.log(`File: ${filePath}`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	});

program
	.command("search [query]")
	.description("search tasks using the shared index")
	.option("--status <status>", "filter task results by status")
	.option("--priority <priority>", "filter task results by priority (high, medium, low)")
	.option(
		"--modified-file <path>",
		"filter task results by modified file path substring",
		createMultiValueAccumulator(),
	)
	.option("--limit <number>", "limit total results returned")
	.option("--plain", "print plain text output instead of interactive UI")
	.action(async (query: string | undefined, options) => {
		if (isRemoteMode()) {
			const modifiedFileFilters = parseDelimitedStringList(options.modifiedFile);
			let limit: number | undefined;
			if (options.limit !== undefined) {
				const parsed = Number.parseInt(String(options.limit), 10);
				if (Number.isNaN(parsed) || parsed <= 0) {
					console.error("--limit must be a positive integer");
					process.exitCode = 1;
					return;
				}
				limit = parsed;
			}

			const searchResults = await remoteSearch({
				query: query ?? "",
				status: options.status,
				priority: options.priority as SearchPriorityFilter | undefined,
				modifiedFiles: modifiedFileFilters,
				limit,
			}).catch((err: Error) => {
				console.error(`Remote error: ${err.message}`);
				process.exitCode = 1;
				return null;
			});
			if (!searchResults) return;

			const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
			if (usePlainOutput) {
				printSearchResults(searchResults);
				return;
			}

			console.log("Remote search requires --plain output.");
			printSearchResults(searchResults);
			return;
		}

		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const searchService = await core.getSearchService();
		const contentStore = await core.getContentStore();
		const cleanup = () => {
			searchService.dispose();
			contentStore.dispose();
		};

		const modifiedFileFilters = parseDelimitedStringList(options.modifiedFile);

		const filters: { status?: string; priority?: SearchPriorityFilter; modifiedFiles?: string[] } = {};
		if (options.status) {
			filters.status = options.status;
		}
		if (options.priority) {
			const priorityLower = String(options.priority).toLowerCase();
			const validPriorities: SearchPriorityFilter[] = ["high", "medium", "low"];
			if (!validPriorities.includes(priorityLower as SearchPriorityFilter)) {
				console.error("Invalid priority. Valid values: high, medium, low");
				cleanup();
				process.exitCode = 1;
				return;
			}
			filters.priority = priorityLower as SearchPriorityFilter;
		}
		if (modifiedFileFilters?.length) {
			filters.modifiedFiles = modifiedFileFilters;
		}

		let limit: number | undefined;
		if (options.limit !== undefined) {
			const parsed = Number.parseInt(String(options.limit), 10);
			if (Number.isNaN(parsed) || parsed <= 0) {
				console.error("--limit must be a positive integer");
				cleanup();
				process.exitCode = 1;
				return;
			}
			limit = parsed;
		}

		const searchResults = searchService.search({
			query: query ?? "",
			limit,
			filters,
		});

		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			printSearchResults(searchResults);
			cleanup();
			return;
		}

		const taskResults = searchResults.filter(isTaskSearchResult);
		const searchResultTasks = taskResults.map((result) => result.task);

		const allTasks = (await core.queryTasks()).filter(
			(task) => task.id && task.id.trim() !== "" && hasAnyPrefix(task.id),
		);

		// If no tasks exist at all, show plain text results
		if (allTasks.length === 0) {
			printSearchResults(searchResults);
			cleanup();
			return;
		}

		const hasModifiedFileFilter = Boolean(modifiedFileFilters?.length);
		const interactiveTasks = hasModifiedFileFilter ? searchResultTasks : allTasks;
		if (interactiveTasks.length === 0) {
			printSearchResults(searchResults);
			cleanup();
			return;
		}

		// Use the first search result as the selected task, or first available task if no results
		const firstTask = searchResultTasks[0] || interactiveTasks[0];
		const priorityFilter = filters.priority ? filters.priority : undefined;
		const statusFilter = filters.status;
		const { runUnifiedView } = await import("./ui/unified-view.ts");

		// On a project switch we drop the (project-A-specific) search and show the
		// new project's full task list.
		let firstProject = true;
		await runWithProjectSwitch(cwd, async (nextCore) => {
			if (firstProject) {
				firstProject = false;
				return await runUnifiedView({
					core: nextCore,
					initialView: "task-list",
					selectedTask: firstTask,
					tasks: interactiveTasks,
					filter: {
						title: query ? `Search: ${query}` : "Search",
						filterDescription: buildSearchFilterDescription({
							status: statusFilter,
							priority: priorityFilter,
							query: query ?? "",
							modifiedFiles: modifiedFileFilters ?? [],
						}),
						status: statusFilter,
						priority: priorityFilter,
						searchQuery: query ?? "", // Pre-populate search with the query
					},
				});
			}
			return await runUnifiedView({ core: nextCore, initialView: "task-list" });
		});
		cleanup();
	});

function buildSearchFilterDescription(filters: {
	status?: string;
	priority?: SearchPriorityFilter;
	query?: string;
	modifiedFiles?: string[];
}): string {
	const parts: string[] = [];
	if (filters.query) {
		parts.push(`Query: ${filters.query}`);
	}
	if (filters.status) {
		parts.push(`Status: ${filters.status}`);
	}
	if (filters.priority) {
		parts.push(`Priority: ${filters.priority}`);
	}
	if (filters.modifiedFiles?.length) {
		parts.push(`Modified files: ${filters.modifiedFiles.join(", ")}`);
	}
	return parts.join(" • ");
}

function printSearchResults(results: SearchResult[]): void {
	if (results.length === 0) {
		console.log("No results found.");
		return;
	}

	const tasks = results.filter(isTaskSearchResult);
	const localTasks = tasks.filter((t) => isLocalEditableTask(t.task));

	if (localTasks.length === 0) {
		console.log("No results found.");
		return;
	}

	console.log("Tasks:");
	for (const taskResult of localTasks) {
		const { task } = taskResult;
		const scoreText = formatScore(taskResult.score);
		const statusText = task.status ? ` (${task.status})` : "";
		const priorityText = task.priority ? ` [${task.priority.toUpperCase()}]` : "";
		console.log(`  ${task.id} - ${task.title}${statusText}${priorityText}${scoreText}`);
	}
}

function formatScore(score: number | null): string {
	if (score === null || score === undefined) {
		return "";
	}
	// Invert score so higher is better (Fuse.js uses 0=perfect match, 1=no match)
	const invertedScore = 1 - score;
	return ` [score ${invertedScore.toFixed(3)}]`;
}

function isTaskSearchResult(result: SearchResult): result is TaskSearchResult {
	return result.type === "task";
}

taskCmd
	.command("list")
	.description("list tasks grouped by status")
	.option("-s, --status <status>", "filter tasks by status (case-insensitive)")
	.option("-a, --assignee <assignee>", "filter tasks by assignee")
	.option("-m, --milestone <milestone>", "filter tasks by milestone (closest match, case-insensitive)")
	.option("-p, --parent <taskId>", "filter tasks by parent task ID")
	.option("--priority <priority>", "filter tasks by priority (high, medium, low)")
	.option("--sort <field>", "sort tasks by field (priority, id)")
	.option("--plain", "use plain text output instead of interactive UI")
	.action(async (options) => {
		if (isRemoteMode()) {
			const tasks = await remoteTaskList({
				status: options.status,
				assignee: options.assignee,
				milestone: options.milestone,
				priority: options.priority,
				parent: options.parent,
			}).catch((err: Error) => {
				console.error(`Remote error: ${err.message}`);
				process.exitCode = 1;
				return null;
			});
			if (!tasks) return;
			if (tasks.length === 0) {
				console.log("No tasks found.");
				return;
			}
			const sorted = options.sort ? sortTasks(tasks, options.sort.toLowerCase()) : sortTasks(tasks, "priority");
			const groups = new Map<string, Task[]>();
			for (const task of sorted) {
				const status = (task.status || "No Status").trim();
				const list = groups.get(status) ?? [];
				list.push(task);
				groups.set(status, list);
			}
			for (const [status, list] of groups) {
				console.log(`${status}:`);
				for (const t of list) {
					const pri = t.priority ? `[${t.priority.toUpperCase()}] ` : "";
					console.log(`  ${pri}${t.id} - ${t.title}`);
				}
			}
			return;
		}
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const cleanup = () => {
			core.disposeSearchService();
			core.disposeContentStore();
		};
		const baseFilters: TaskListFilter = {};
		if (options.status) {
			baseFilters.status = options.status;
		}
		if (options.assignee) {
			baseFilters.assignee = options.assignee;
		}
		if (options.milestone) {
			baseFilters.milestone = options.milestone;
		}
		if (options.priority) {
			const priorityLower = options.priority.toLowerCase();
			const validPriorities = ["high", "medium", "low"] as const;
			if (!validPriorities.includes(priorityLower as (typeof validPriorities)[number])) {
				console.error(`Invalid priority: ${options.priority}. Valid values are: high, medium, low`);
				process.exitCode = 1;
				cleanup();
				return;
			}
			baseFilters.priority = priorityLower as (typeof validPriorities)[number];
		}

		let parentId: string | undefined;
		if (options.parent) {
			const parentInput = String(options.parent);
			parentId = normalizeTaskId(parentInput);
			baseFilters.parentTaskId = parentInput;
		}

		if (options.sort) {
			const validSortFields = ["priority", "id"];
			const sortField = options.sort.toLowerCase();
			if (!validSortFields.includes(sortField)) {
				console.error(`Invalid sort field: ${options.sort}. Valid values are: priority, id`);
				process.exitCode = 1;
				cleanup();
				return;
			}
		}

		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			const tasks = await core.queryTasks({ filters: baseFilters, includeCrossBranch: false });
			const config = await core.filesystem.loadConfig();

			if (parentId) {
				const parentExists = (await core.queryTasks({ includeCrossBranch: false })).some((task) =>
					taskIdsEqual(parentId, task.id),
				);
				if (!parentExists) {
					console.error(`Parent task ${parentId} not found.`);
					process.exitCode = 1;
					cleanup();
					return;
				}
			}

			let sortedTasks = tasks;
			if (options.sort) {
				const validSortFields = ["priority", "id"];
				const sortField = options.sort.toLowerCase();
				if (!validSortFields.includes(sortField)) {
					console.error(`Invalid sort field: ${options.sort}. Valid values are: priority, id`);
					process.exitCode = 1;
					cleanup();
					return;
				}
				sortedTasks = sortTasks(tasks, sortField);
			} else {
				sortedTasks = sortTasks(tasks, "priority");
			}

			let filtered = sortedTasks;
			if (parentId) {
				filtered = filtered.filter((task) => task.parentTaskId && taskIdsEqual(parentId, task.parentTaskId));
			}

			if (filtered.length === 0) {
				if (options.parent) {
					const canonicalParent = normalizeTaskId(String(options.parent));
					console.log(`No child tasks found for parent task ${canonicalParent}.`);
				} else {
					console.log("No tasks found.");
				}
				cleanup();
				return;
			}

			if (options.sort && options.sort.toLowerCase() === "priority") {
				const sortedByPriority = sortTasks(filtered, "priority");
				console.log("Tasks (sorted by priority):");
				for (const t of sortedByPriority) {
					const priorityIndicator = t.priority ? `[${t.priority.toUpperCase()}] ` : "";
					const statusIndicator = t.status ? ` (${t.status})` : "";
					console.log(`  ${priorityIndicator}${t.id} - ${t.title}${statusIndicator}`);
				}
				cleanup();
				return;
			}

			const canonicalByLower = new Map<string, string>();
			const statuses = config?.statuses || [];
			for (const status of statuses) {
				canonicalByLower.set(status.toLowerCase(), status);
			}

			const groups = new Map<string, Task[]>();
			for (const task of filtered) {
				const rawStatus = (task.status || "").trim();
				const canonicalStatus = canonicalByLower.get(rawStatus.toLowerCase()) || rawStatus;
				const list = groups.get(canonicalStatus) || [];
				list.push(task);
				groups.set(canonicalStatus, list);
			}

			const orderedStatuses = [
				...statuses.filter((status) => groups.has(status)),
				...Array.from(groups.keys()).filter((status) => !statuses.includes(status)),
			];

			for (const status of orderedStatuses) {
				const list = groups.get(status);
				if (!list) continue;
				let sortedList = list;
				if (options.sort) {
					sortedList = sortTasks(list, options.sort.toLowerCase());
				}
				console.log(`${status || "No Status"}:`);
				sortedList.forEach((task) => {
					const priorityIndicator = task.priority ? `[${task.priority.toUpperCase()}] ` : "";
					console.log(`  ${priorityIndicator}${task.id} - ${task.title}`);
				});
				console.log();
			}
			cleanup();
			return;
		}

		let filterDescription = "";
		let title = "Tasks";
		const activeFilters: string[] = [];
		if (options.status) activeFilters.push(`Status: ${options.status}`);
		if (options.assignee) activeFilters.push(`Assignee: ${options.assignee}`);
		if (options.parent) {
			activeFilters.push(`Parent: ${normalizeTaskId(String(options.parent))}`);
		}
		if (options.milestone) activeFilters.push(`Milestone: ${options.milestone}`);
		if (options.priority) activeFilters.push(`Priority: ${options.priority}`);
		if (options.sort) activeFilters.push(`Sort: ${options.sort}`);

		if (activeFilters.length > 0) {
			filterDescription = activeFilters.join(", ");
			title = `Tasks (${activeFilters.join(" • ")})`;
		}
		const initialUnifiedFilter: {
			status?: string;
			assignee?: string;
			milestone?: string;
			priority?: string;
			sort?: string;
			title?: string;
			filterDescription?: string;
			parentTaskId?: string;
		} = {
			status: options.status,
			assignee: options.assignee,
			milestone: options.milestone,
			priority: options.priority,
			sort: options.sort,
			title,
			filterDescription,
			parentTaskId: parentId,
		};

		const { runUnifiedView } = await import("./ui/unified-view.ts");
		const interactiveLoaderFilters: TaskListFilter = {};
		if (options.assignee) {
			interactiveLoaderFilters.assignee = options.assignee;
		}
		if (parentId) {
			interactiveLoaderFilters.parentTaskId = parentId;
		}
		// `core` is shadowed by the per-project instance so the loader reloads
		// against whichever project is active after a switch.
		await runWithProjectSwitch(cwd, async (core) =>
			runUnifiedView({
				core,
				initialView: "task-list",
				tasksLoader: async (updateProgress) => {
					updateProgress("Loading configuration...");
					const config = await core.filesystem.loadConfig();

					// Use loadTasks with progress callback for consistent loading experience
					// This populates the ContentStore, so subsequent queryTasks calls are fast
					await core.loadTasks((msg) => {
						updateProgress(msg);
					});

					// Now query with filters - this will use the already-populated ContentStore
					updateProgress("Applying filters...");
					const [tasks, allTasksForParentCheck] = await Promise.all([
						core.queryTasks({
							filters: Object.keys(interactiveLoaderFilters).length > 0 ? interactiveLoaderFilters : undefined,
						}),
						parentId ? core.queryTasks() : Promise.resolve(undefined),
					]);

					if (parentId && allTasksForParentCheck) {
						const parentExists = allTasksForParentCheck.some((task) => taskIdsEqual(parentId, task.id));
						if (!parentExists) {
							throw new Error(`Parent task ${parentId} not found.`);
						}
					}

					let sortedTasks = tasks;
					if (options.sort) {
						const validSortFields = ["priority", "id"];
						const sortField = options.sort.toLowerCase();
						if (!validSortFields.includes(sortField)) {
							throw new Error(`Invalid sort field: ${options.sort}. Valid values are: priority, id`);
						}
						sortedTasks = sortTasks(tasks, sortField);
					} else {
						sortedTasks = sortTasks(tasks, "priority");
					}

					let filtered = sortedTasks;
					if (parentId) {
						filtered = filtered.filter((task) => task.parentTaskId && taskIdsEqual(parentId, task.parentTaskId));
					}

					if (options.milestone && filtered.length > 0) {
						const [activeMilestones, archivedMilestones] = await Promise.all([
							core.filesystem.listMilestones(),
							core.filesystem.listArchivedMilestones(),
						]);
						const resolveMilestoneFilterValue = createMilestoneFilterValueResolver([
							...activeMilestones,
							...archivedMilestones,
						]);
						const resolvedMilestone = resolveClosestMilestoneFilterValue(
							options.milestone,
							filtered.map((task) => resolveMilestoneFilterValue(task.milestone ?? "")),
						);
						if (resolvedMilestone) {
							initialUnifiedFilter.milestone = resolvedMilestone;
						}
					}

					return {
						tasks: filtered,
						statuses: config?.statuses || [],
					};
				},
				filter: initialUnifiedFilter,
			}),
		);
		cleanup();
	});

taskCmd
	.command("edit [taskId]")
	.description("edit an existing task")
	.option("-t, --title <title>")
	.option("-d, --description <text>", "task description (multi-line: include real newlines inside the quoted string)")
	.option("--desc <text>", "alias for --description")
	.option("-a, --assignee <assignee>")
	.option("-s, --status <status>")
	.option("-l, --label <labels>")
	.option("--priority <priority>", "set task priority (high, medium, low)")
	.option("--ordinal <number>", "set task ordinal for custom ordering")
	.option("-m, --milestone <milestone>", "assign task to milestone by ID or title")
	.option("--clear-milestone", "clear task milestone assignment")
	.option("--plain", "use plain text output after editing")
	.option("--add-label <label>")
	.option("--remove-label <label>")
	.option("--ac <criteria>", "add acceptance criteria (can be used multiple times)", createMultiValueAccumulator())
	.option("--dod <item>", "add Definition of Done item (can be used multiple times)", createMultiValueAccumulator())
	.option(
		"--remove-ac <index>",
		"remove acceptance criterion by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--remove-dod <index>",
		"remove Definition of Done item by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--check-ac <index>",
		"check acceptance criterion by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--check-dod <index>",
		"check Definition of Done item by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--uncheck-ac <index>",
		"uncheck acceptance criterion by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--uncheck-dod <index>",
		"uncheck Definition of Done item by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option("--acceptance-criteria <criteria>", "set acceptance criteria (comma-separated or use multiple times)")
	.option("--plan <text>", "set implementation plan")
	.option("--notes <text>", "set implementation notes (replaces existing)")
	.option("--final-summary <text>", "set final summary (replaces existing)")
	.option(
		"--append-notes <text>",
		"append to implementation notes (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--append-final-summary <text>",
		"append to final summary (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option("--clear-final-summary", "remove final summary")
	.option(
		"--depends-on <taskIds>",
		"set task dependencies (comma-separated or use multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
			return [...soFar, value];
		},
	)
	.option("--dep <taskIds>", "set task dependencies (shortcut for --depends-on)", (value, previous) => {
		const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
		return [...soFar, value];
	})
	.option("--ref <reference>", "set references (can be used multiple times)", (value, previous) => {
		const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
		return [...soFar, value];
	})
	.option(
		"--modified-file <path>",
		"set modified file paths from project root (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
			return [...soFar, value];
		},
	)
	.option("--doc <documentation>", "set documentation (can be used multiple times)", (value, previous) => {
		const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
		return [...soFar, value];
	})
	.action(async (taskId: string | undefined, options) => {
		const shouldUseWizard = hasInteractiveTTY && !hasEditFieldFlags(options);
		if (!shouldUseWizard && !taskId) {
			printMissingRequiredArgument("taskId");
			return;
		}

		if (isRemoteMode() && !shouldUseWizard && taskId) {
			const editArgs = buildCliEditArgs(taskId, options);
			const updateInput = buildTaskUpdateInput(editArgs);
			const task = await remoteTaskEdit(taskId, updateInput).catch((err: Error) => {
				console.error(`Remote error: ${err.message}`);
				process.exitCode = 1;
				return null;
			});
			if (!task) return;
			if (isPlainRequested(options)) {
				console.log(formatTaskPlainText(task));
			} else {
				console.log(`Updated task ${task.id}`);
			}
			return;
		}

		const cwd = await requireProjectRoot();
		const core = new Core(cwd);

		if (shouldUseWizard) {
			let selectedTaskId = taskId ? normalizeTaskId(taskId) : undefined;
			if (!selectedTaskId) {
				const localTasks = await core.queryTasks({ includeCrossBranch: false });
				const taskOptions = localTasks.map((candidate) => ({
					id: candidate.id,
					title: candidate.title,
				}));
				if (taskOptions.length === 0) {
					console.log("No tasks found.");
					return;
				}
				selectedTaskId = await pickTaskForEditWizard({ tasks: taskOptions });
				if (!selectedTaskId) {
					clack.cancel("Task edit cancelled.");
					return;
				}
			}

			const existingTaskForWizard = await core.loadTaskById(selectedTaskId);
			if (!existingTaskForWizard) {
				console.error(`Task ${selectedTaskId} not found.`);
				process.exitCode = 1;
				return;
			}

			const statuses = await getValidStatuses(core);
			const wizardInput = await runTaskEditWizard({ task: existingTaskForWizard, statuses });
			if (!wizardInput) {
				clack.cancel("Task edit cancelled.");
				return;
			}

			try {
				const updatedTask = await core.editTask(existingTaskForWizard.id, wizardInput);
				console.log(`Updated task ${updatedTask.id}`);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			}
			return;
		}

		const canonicalId = normalizeTaskId(taskId ?? "");
		const existingTask = await core.loadTaskById(canonicalId);

		if (!existingTask) {
			console.error(`Task ${taskId} not found.`);
			process.exitCode = 1;
			return;
		}

		let canonicalStatus: string | undefined;
		if (options.status) {
			const canonical = await getCanonicalStatus(String(options.status), core);
			if (!canonical) {
				const configuredStatuses = await getValidStatuses(core);
				console.error(
					`Invalid status: ${options.status}. Valid statuses are: ${formatValidStatuses(configuredStatuses)}`,
				);
				process.exitCode = 1;
				return;
			}
			canonicalStatus = canonical;
		}

		let normalizedPriority: "high" | "medium" | "low" | undefined;
		if (options.priority) {
			const priority = String(options.priority).toLowerCase();
			const validPriorities = ["high", "medium", "low"] as const;
			if (!validPriorities.includes(priority as (typeof validPriorities)[number])) {
				console.error(`Invalid priority: ${priority}. Valid values are: high, medium, low`);
				process.exitCode = 1;
				return;
			}
			normalizedPriority = priority as "high" | "medium" | "low";
		}

		let ordinalValue: number | undefined;
		if (options.ordinal !== undefined) {
			const parsed = Number(options.ordinal);
			if (Number.isNaN(parsed) || parsed < 0) {
				console.error(`Invalid ordinal: ${options.ordinal}. Must be a non-negative number.`);
				process.exitCode = 1;
				return;
			}
			ordinalValue = parsed;
		}

		if (options.milestone !== undefined && options.clearMilestone) {
			console.error("Cannot use --milestone and --clear-milestone together.");
			process.exitCode = 1;
			return;
		}

		let milestoneValue: string | null | undefined;
		if (typeof options.milestone === "string") {
			milestoneValue = await resolveCliMilestoneInput(core, options.milestone);
		} else if (options.clearMilestone) {
			milestoneValue = null;
		}

		let removeCriteria: number[] | undefined;
		let checkCriteria: number[] | undefined;
		let uncheckCriteria: number[] | undefined;
		let removeDod: number[] | undefined;
		let checkDod: number[] | undefined;
		let uncheckDod: number[] | undefined;

		try {
			const removes = parsePositiveIndexList(options.removeAc);
			if (removes.length > 0) {
				removeCriteria = removes;
			}
			const checks = parsePositiveIndexList(options.checkAc);
			if (checks.length > 0) {
				checkCriteria = checks;
			}
			const unchecks = parsePositiveIndexList(options.uncheckAc);
			if (unchecks.length > 0) {
				uncheckCriteria = unchecks;
			}
			const dodRemoves = parsePositiveIndexList(options.removeDod);
			if (dodRemoves.length > 0) {
				removeDod = dodRemoves;
			}
			const dodChecks = parsePositiveIndexList(options.checkDod);
			if (dodChecks.length > 0) {
				checkDod = dodChecks;
			}
			const dodUnchecks = parsePositiveIndexList(options.uncheckDod);
			if (dodUnchecks.length > 0) {
				uncheckDod = dodUnchecks;
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
			return;
		}

		const labelValues = parseDelimitedStringList(options.label) ?? [];
		const addLabelValues = parseDelimitedStringList(options.addLabel) ?? [];
		const removeLabelValues = parseDelimitedStringList(options.removeLabel) ?? [];
		const assigneeValues = parseDelimitedStringList(options.assignee) ?? [];
		const acceptanceAdditions = processAcceptanceCriteriaOptions(options);
		const definitionOfDoneAdditions = toStringArray(options.dod)
			.map((value) => String(value).trim())
			.filter((value) => value.length > 0);

		const combinedDependencies = [...toStringArray(options.dependsOn), ...toStringArray(options.dep)];
		const dependencyValues = combinedDependencies.length > 0 ? normalizeDependencies(combinedDependencies) : undefined;

		const normalizedReferences = parseDelimitedStringList(options.ref);
		const normalizedDocumentation = parseDelimitedStringList(options.doc);
		const normalizedModifiedFiles = parseDelimitedStringList(options.modifiedFile);

		const notesAppendValues = toStringArray(options.appendNotes);
		const finalSummaryAppendValues = toStringArray(options.appendFinalSummary);

		const editArgs: TaskEditArgs = {};
		if (options.title) {
			editArgs.title = String(options.title);
		}
		const descriptionOption = options.description ?? options.desc;
		if (descriptionOption !== undefined) {
			editArgs.description = String(descriptionOption);
		}
		if (canonicalStatus) {
			editArgs.status = canonicalStatus;
		}
		if (normalizedPriority) {
			editArgs.priority = normalizedPriority;
		}
		if (ordinalValue !== undefined) {
			editArgs.ordinal = ordinalValue;
		}
		if (milestoneValue !== undefined) {
			editArgs.milestone = milestoneValue;
		}
		if (labelValues.length > 0) {
			editArgs.labels = labelValues;
		}
		if (addLabelValues.length > 0) {
			editArgs.addLabels = addLabelValues;
		}
		if (removeLabelValues.length > 0) {
			editArgs.removeLabels = removeLabelValues;
		}
		if (assigneeValues.length > 0) {
			editArgs.assignee = assigneeValues;
		}
		if (dependencyValues && dependencyValues.length > 0) {
			editArgs.dependencies = dependencyValues;
		}
		if (normalizedReferences && normalizedReferences.length > 0) {
			editArgs.references = normalizedReferences;
		}
		if (normalizedDocumentation && normalizedDocumentation.length > 0) {
			editArgs.documentation = normalizedDocumentation;
		}
		if (normalizedModifiedFiles && normalizedModifiedFiles.length > 0) {
			editArgs.modifiedFiles = normalizedModifiedFiles;
		}
		if (typeof options.plan === "string") {
			editArgs.planSet = String(options.plan);
		}
		if (typeof options.notes === "string") {
			editArgs.notesSet = String(options.notes);
		}
		if (notesAppendValues.length > 0) {
			editArgs.notesAppend = notesAppendValues;
		}
		if (typeof options.finalSummary === "string") {
			editArgs.finalSummary = String(options.finalSummary);
		}
		if (finalSummaryAppendValues.length > 0) {
			editArgs.finalSummaryAppend = finalSummaryAppendValues;
		}
		if (options.clearFinalSummary) {
			editArgs.finalSummaryClear = true;
		}
		if (acceptanceAdditions.length > 0) {
			editArgs.acceptanceCriteriaAdd = acceptanceAdditions;
		}
		if (removeCriteria) {
			editArgs.acceptanceCriteriaRemove = removeCriteria;
		}
		if (checkCriteria) {
			editArgs.acceptanceCriteriaCheck = checkCriteria;
		}
		if (uncheckCriteria) {
			editArgs.acceptanceCriteriaUncheck = uncheckCriteria;
		}
		if (definitionOfDoneAdditions.length > 0) {
			editArgs.definitionOfDoneAdd = definitionOfDoneAdditions;
		}
		if (removeDod) {
			editArgs.definitionOfDoneRemove = removeDod;
		}
		if (checkDod) {
			editArgs.definitionOfDoneCheck = checkDod;
		}
		if (uncheckDod) {
			editArgs.definitionOfDoneUncheck = uncheckDod;
		}

		let updatedTask: Task;
		try {
			const updateInput = buildTaskUpdateInput(editArgs);
			updatedTask = await core.editTask(canonicalId, updateInput);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
			return;
		}

		const usePlainOutput = isPlainRequested(options);
		if (usePlainOutput) {
			console.log(formatTaskPlainText(updatedTask));
			return;
		}

		console.log(`Updated task ${updatedTask.id}`);
	});

// Note: Implementation notes appending is handled via `task edit --append-notes` only.

taskCmd
	.command("view <taskId>")
	.description("display task details")
	.option("--plain", "use plain text output instead of interactive UI")
	.action(async (taskId: string, options) => {
		if (isRemoteMode()) {
			const task = await remoteTaskView(taskId).catch((err: Error) => {
				console.error(`Remote error: ${err.message}`);
				process.exitCode = 1;
				return null;
			});
			if (!task) return;
			console.log(formatTaskPlainText(task));
			return;
		}
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const localTasks = await core.fs.listTasks();
		const task = await core.getTaskWithSubtasks(taskId, localTasks);
		if (!task) {
			console.error(`Task ${taskId} not found.`);
			return;
		}

		const allTasks = localTasks.some((candidate) => taskIdsEqual(task.id, candidate.id))
			? localTasks
			: [...localTasks, task];

		// Plain text output for non-interactive environments
		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			console.log(formatTaskPlainText(task));
			return;
		}

		// Use enhanced task viewer with detail focus
		await viewTaskEnhanced(task, { startWithDetailFocus: true, core, tasks: allTasks });
	});

taskCmd
	.command("archive <taskId>")
	.description("archive a task")
	.action(async (taskId: string) => {
		if (isRemoteMode()) {
			await remoteTaskArchive(taskId).catch((err: Error) => {
				console.error(`Remote error: ${err.message}`);
				process.exitCode = 1;
				return;
			});
			console.log(`Archived task ${taskId}`);
			return;
		}
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const success = await core.archiveTask(taskId);
		if (success) {
			console.log(`Archived task ${taskId}`);
		} else {
			console.error(`Task ${taskId} not found.`);
		}
	});

taskCmd
	.command("demote <taskId>")
	.description("(removed) move task back to drafts")
	.action(() => {
		console.error(
			"The 'task demote' command has been removed. Use 'backlog task edit <id> --status <status>' instead.",
		);
		process.exit(2);
	});

taskCmd
	.command("next")
	.description("atomically claim the next ready task")
	.option("--status <name>", "status lane to pick from (default: Ready)")
	.option("--agent <handle>", "assign the claimed task to this handle")
	.action(async (options: { status?: string; agent?: string }) => {
		if (isRemoteMode()) {
			try {
				const result = await remoteTaskNext({ status: options.status, agent: options.agent });
				if (!result) {
					console.error(`No tasks found with status "${options.status ?? "Ready"}".`);
					process.exit(1);
				}
				const { task, previousStatus } = result;
				console.log(`${task.id} — ${task.title}`);
				console.log(`${previousStatus} → In Progress`);
				console.log("");
				console.log(formatTaskPlainText(task));
			} catch (err) {
				console.error(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
			return;
		}

		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			const result = await core.claimTask({ status: options.status, agent: options.agent });
			if (!result) {
				const displayStatus = await core.resolveClaimStatus(options.status);
				console.error(`No tasks found with status "${displayStatus}".`);
				process.exit(1);
			}
			const { task, previousStatus } = result;
			console.log(`${task.id} — ${task.title}`);
			console.log(`${previousStatus} → In Progress`);
			console.log("");
			console.log(formatTaskPlainText(task));
		} catch (err) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	});

taskCmd
	.argument("[taskId]")
	.option("--plain", "use plain text output")
	.action(async (taskId: string | undefined, options: { plain?: boolean }) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);

		// Don't handle commands that should be handled by specific command handlers
		const reservedCommands = ["create", "list", "edit", "view", "archive", "demote", "next"];
		if (taskId && reservedCommands.includes(taskId)) {
			console.error(`Unknown command: ${taskId}`);
			taskCmd.help();
			return;
		}

		// Handle single task view only
		if (!taskId) {
			taskCmd.help();
			return;
		}

		const localTasks = await core.fs.listTasks();
		const task = await core.getTaskWithSubtasks(taskId, localTasks);
		if (!task) {
			console.error(`Task ${taskId} not found.`);
			return;
		}

		const allTasks = localTasks.some((candidate) => taskIdsEqual(task.id, candidate.id))
			? localTasks
			: [...localTasks, task];

		// Plain text output for non-interactive environments
		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			console.log(formatTaskPlainText(task));
			return;
		}

		// Use unified view with detail focus and Tab switching support.
		// The first project shows the requested task; after a project switch we
		// fall back to the new project's task list (the id has no counterpart).
		const { runUnifiedView } = await import("./ui/unified-view.ts");
		let firstProject = true;
		await runWithProjectSwitch(cwd, async (nextCore) => {
			if (firstProject) {
				firstProject = false;
				return await runUnifiedView({
					core: nextCore,
					initialView: "task-detail",
					selectedTask: task,
					tasks: allTasks,
				});
			}
			return await runUnifiedView({ core: nextCore, initialView: "task-list" });
		});
	});

const milestoneCmd = program.command("milestone").aliases(["milestones"]);

milestoneCmd
	.command("list")
	.description("list milestones with completion status")
	.option("--show-completed", "show completed milestones")
	.option("--plain", "use plain text output")
	.action(async (options: { showCompleted?: boolean; plain?: boolean }) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		await core.ensureConfigLoaded();

		const [tasks, milestones, archivedMilestones, config] = await Promise.all([
			core.queryTasks({ includeCrossBranch: false }),
			core.filesystem.listMilestones(),
			core.filesystem.listArchivedMilestones(),
			core.filesystem.loadConfig(),
		]);

		const statuses = config?.statuses ?? ["To Do", "In Progress", "Done"];
		const archivedMilestoneIds = collectArchivedMilestoneKeys(archivedMilestones, milestones);
		const buckets = buildMilestoneBuckets(tasks, milestones, statuses, { archivedMilestoneIds, archivedMilestones });
		const active = buckets.filter((bucket) => !bucket.isNoMilestone && !bucket.isCompleted);
		const completed = buckets.filter((bucket) => !bucket.isNoMilestone && bucket.isCompleted);

		const formatBucket = (bucket: (typeof buckets)[number]) => {
			const id = bucket.milestone ?? bucket.label;
			const label = bucket.label;
			return `  ${id}: ${label} (${bucket.doneCount}/${bucket.total} done)`;
		};

		console.log(`Active milestones (${active.length}):`);
		if (active.length === 0) {
			console.log("  (none)");
		} else {
			for (const bucket of active) {
				console.log(formatBucket(bucket));
			}
		}

		console.log(`\nCompleted milestones (${completed.length}):`);
		if (completed.length === 0) {
			console.log("  (none)");
		} else if (options.showCompleted || process.argv.includes("--show-completed")) {
			for (const bucket of completed) {
				console.log(formatBucket(bucket));
			}
		} else {
			console.log("  (collapsed, use --show-completed to list)");
		}
	});

milestoneCmd
	.command("archive <name>")
	.description("archive a milestone by id or title")
	.action(async (name: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const result = await core.archiveMilestone(name);

		if (!result.success) {
			console.error(`Milestone "${name}" not found.`);
			process.exitCode = 1;
			return;
		}

		const label = result.milestone?.title ?? name;
		const id = result.milestone?.id;
		console.log(`Archived milestone "${label}"${id ? ` (${id})` : ""}.`);
	});

const boardCmd = program.command("board");

function addBoardOptions(cmd: Command) {
	return cmd
		.option("-l, --layout <layout>", "board layout (horizontal|vertical)", "horizontal")
		.option("--vertical", "use vertical layout (shortcut for --layout vertical)")
		.option("-m, --milestones", "group tasks by milestone");
}

async function handleBoardView(options: { layout?: string; vertical?: boolean; milestones?: boolean }) {
	const cwd = await requireProjectRoot();
	const { runUnifiedView } = await import("./ui/unified-view.ts");
	await runWithProjectSwitch(cwd, async (core) => {
		const config = await core.filesystem.loadConfig();
		const statuses = config?.statuses || [];

		// Use unified view for Tab switching support
		return await runUnifiedView({
			core,
			initialView: "kanban",
			milestoneMode: options.milestones,
			tasksLoader: async (updateProgress) => {
				const [tasks, milestoneEntities, archivedMilestones] = await Promise.all([
					core.loadTasks((msg) => {
						updateProgress(msg);
					}),
					core.filesystem.listMilestones(),
					core.filesystem.listArchivedMilestones(),
				]);
				const resolveMilestoneAlias = (value?: string): string => {
					const normalized = (value ?? "").trim();
					if (!normalized) {
						return "";
					}
					const key = normalized.toLowerCase();
					const looksLikeMilestoneId = /^\d+$/.test(normalized) || /^m-\d+$/i.test(normalized);
					const canonicalInputId = looksLikeMilestoneId
						? `m-${String(Number.parseInt(normalized.replace(/^m-/i, ""), 10))}`
						: null;
					const aliasKeys = new Set<string>([key]);
					if (/^\d+$/.test(normalized)) {
						const numericAlias = String(Number.parseInt(normalized, 10));
						aliasKeys.add(numericAlias);
						aliasKeys.add(`m-${numericAlias}`);
					} else {
						const idMatch = normalized.match(/^m-(\d+)$/i);
						if (idMatch?.[1]) {
							const numericAlias = String(Number.parseInt(idMatch[1], 10));
							aliasKeys.add(numericAlias);
							aliasKeys.add(`m-${numericAlias}`);
						}
					}
					const idMatchesAlias = (milestoneId: string): boolean => {
						const idKey = milestoneId.trim().toLowerCase();
						if (aliasKeys.has(idKey)) {
							return true;
						}
						const idMatch = milestoneId.trim().match(/^m-(\d+)$/i);
						if (!idMatch?.[1]) {
							return false;
						}
						const numericAlias = String(Number.parseInt(idMatch[1], 10));
						return aliasKeys.has(numericAlias) || aliasKeys.has(`m-${numericAlias}`);
					};
					const findIdMatch = (milestones: Milestone[]): Milestone | undefined => {
						const rawExactMatch = milestones.find((milestone) => milestone.id.trim().toLowerCase() === key);
						if (rawExactMatch) {
							return rawExactMatch;
						}
						if (canonicalInputId) {
							const canonicalRawMatch = milestones.find(
								(milestone) => milestone.id.trim().toLowerCase() === canonicalInputId,
							);
							if (canonicalRawMatch) {
								return canonicalRawMatch;
							}
						}
						return milestones.find((milestone) => idMatchesAlias(milestone.id));
					};

					const activeIdMatch = findIdMatch(milestoneEntities);
					if (activeIdMatch) {
						return activeIdMatch.id;
					}
					if (looksLikeMilestoneId) {
						const archivedIdMatch = findIdMatch(archivedMilestones);
						if (archivedIdMatch) {
							return archivedIdMatch.id;
						}
					}
					const activeTitleMatches = milestoneEntities.filter(
						(milestone) => milestone.title.trim().toLowerCase() === key,
					);
					if (activeTitleMatches.length === 1) {
						return activeTitleMatches[0]?.id ?? normalized;
					}
					if (activeTitleMatches.length > 1) {
						return normalized;
					}
					const archivedIdMatch = findIdMatch(archivedMilestones);
					if (archivedIdMatch) {
						return archivedIdMatch.id;
					}
					const archivedTitleMatches = archivedMilestones.filter(
						(milestone) => milestone.title.trim().toLowerCase() === key,
					);
					if (archivedTitleMatches.length === 1) {
						return archivedTitleMatches[0]?.id ?? normalized;
					}
					return normalized;
				};
				const archivedKeys = new Set(collectArchivedMilestoneKeys(archivedMilestones, milestoneEntities));
				const normalizedTasks =
					archivedKeys.size > 0
						? tasks.map((task) => {
								const key = milestoneKey(resolveMilestoneAlias(task.milestone));
								if (!key || !archivedKeys.has(key)) {
									return task;
								}
								return { ...task, milestone: undefined };
							})
						: tasks;
				return {
					tasks: normalizedTasks.map((t) => ({ ...t, status: t.status || "" })),
					statuses,
				};
			},
		});
	});
}

addBoardOptions(boardCmd).description("display tasks in a Kanban board").action(handleBoardView);

addBoardOptions(boardCmd.command("view").description("display tasks in a Kanban board")).action(handleBoardView);

boardCmd
	.command("export [filename]")
	.description("export kanban board to markdown file")
	.option("--force", "overwrite existing file without confirmation")
	.option("--readme", "export to README.md with markers")
	.option("--export-version <version>", "version to include in the export")
	.action(async (filename, options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const config = await core.filesystem.loadConfig();
		const statuses = config?.statuses || [];

		// Load tasks with progress tracking
		const loadingScreen = await createLoadingScreen("Loading tasks for export");

		let finalTasks: Task[];
		try {
			// Use the shared Core method for loading board tasks
			finalTasks = await core.loadTasks((msg) => {
				loadingScreen?.update(msg);
			});

			loadingScreen?.update(`Total tasks: ${finalTasks.length}`);

			// Close loading screen before export
			loadingScreen?.close();

			// Get project name from config or use directory name
			const { basename } = await import("node:path");
			const projectName = config?.projectName || basename(cwd);

			if (options.readme) {
				// Use version from option if provided, otherwise use the CLI version
				const exportVersion = options.exportVersion || version;
				await updateReadmeWithBoard(finalTasks, statuses, projectName, exportVersion);
				console.log("Updated README.md with Kanban board.");
			} else {
				// Use filename argument or default to Backlog.md
				const outputFile = filename || "Backlog.md";
				const outputPath = join(cwd, outputFile as string);

				// Check if file exists and handle overwrite confirmation
				const fileExists = await Bun.file(outputPath).exists();
				if (fileExists && !options.force) {
					const rl = createInterface({ input });
					try {
						const answer = await rl.question(`File "${outputPath}" already exists. Overwrite? (y/N): `);
						if (!answer.toLowerCase().startsWith("y")) {
							console.log("Export cancelled.");
							return;
						}
					} finally {
						rl.close();
					}
				}

				await exportKanbanBoardToFile(finalTasks, statuses, outputPath, projectName, options.force || !fileExists);
				console.log(`Exported board to ${outputPath}`);
			}
		} catch (error) {
			loadingScreen?.close();
			throw error;
		}
	});

// Server: long-running web UI process (used by `backlog service`, dev, scripts)
async function runServer(options: { port?: string; project?: string; open?: boolean }): Promise<void> {
	let cwd: string;
	if (options.project) {
		cwd = resolve(options.project);
		const found = await findBacklogRoot(cwd);
		if (!found || found !== cwd) {
			console.error(`--project must point at a Backlog project root (got: ${cwd})`);
			process.exit(1);
		}
	} else {
		cwd = await resolveServerProjectRoot();
	}
	const { BacklogServer } = await import("./server/index.ts");
	const server = new BacklogServer(cwd);

	const core = new Core(cwd);
	const config = await core.filesystem.loadConfig();
	const defaultPort = config?.defaultPort ?? 6420;

	const port = Number.parseInt(options.port || process.env.PORT || defaultPort.toString(), 10);
	if (Number.isNaN(port) || port < 1 || port > 65535) {
		console.error("Invalid port number. Must be between 1 and 65535.");
		process.exit(1);
	}

	await server.start(port, options.open === true);

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`\nReceived ${signal}. Shutting down server...`);
		try {
			const stopPromise = server.stop();
			const timeout = new Promise<void>((r) => setTimeout(r, 1500));
			await Promise.race([stopPromise, timeout]);
		} finally {
			process.exit(0);
		}
	};

	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
	process.once("SIGQUIT", () => void shutdown("SIGQUIT"));
}

program
	.command("server")
	.description("run the web UI server in the foreground (press Ctrl+C to stop)")
	.option("-p, --port <port>", "port to listen on")
	.option("--project <path>", "project root to serve (default: walk up from cwd)")
	.option("--open", "open the UI in a browser after start")
	.action(async (options) => {
		try {
			await runServer(options);
		} catch (err) {
			console.error("Failed to start server", err);
			process.exitCode = 1;
		}
	});

// Deprecated alias: `backlog browser` → `backlog server --open`
program
	.command("browser", { hidden: true })
	.description("[deprecated] alias for `backlog server --open`")
	.option("-p, --port <port>", "port to listen on")
	.option("--project <path>", "project root to serve")
	.option("--no-open", "don't automatically open browser")
	.action(async (options) => {
		console.error("Note: `backlog browser` is deprecated; use `backlog server --open` instead.");
		try {
			await runServer({ port: options.port, project: options.project, open: options.open !== false });
		} catch (err) {
			console.error("Failed to start server", err);
			process.exitCode = 1;
		}
	});

// MCP command group
registerMcpCommand(program);

// Service command group (macOS launchd)
registerServiceCommand(program);

// Workspace registry command group
registerProjectCommand(program);

program.parseAsync(process.argv).finally(() => {
	// Restore BUN_OPTIONS after CLI parsing completes so it's available for subsequent commands
	if (originalBunOptions) {
		process.env.BUN_OPTIONS = originalBunOptions;
	}
});
