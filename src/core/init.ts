import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { spawn } from "bun";
import {
	type AgentInstructionFile,
	addAgentInstructions,
	ensureMcpGuidelines,
	installClaudeAgent,
} from "../agent-instructions.ts";
import { DEFAULT_INIT_CONFIG, DEFAULT_STATUSES } from "../constants/index.ts";
import type { BacklogConfig } from "../types/index.ts";
import { normalizeProjectBacklogDirectory } from "../utils/backlog-directory.ts";
import { readMachineConfig } from "../utils/machine-config.ts";
import type { Core } from "./backlog.ts";

async function dirExistsAndNonEmpty(path: string): Promise<boolean> {
	try {
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(path);
		return entries.length > 0;
	} catch {
		return false;
	}
}

async function ensureGlobalStoreExists(globalStore: string): Promise<void> {
	try {
		const s = await stat(globalStore);
		if (!s.isDirectory()) {
			throw new Error(`Global store directory does not exist: ${globalStore}`);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Global store directory does not exist: ${globalStore}`);
		}
		throw err;
	}
}

export const MCP_SERVER_NAME = "backlog";
export const MCP_GUIDE_URL = "https://github.com/MrLesk/Backlog.md#-mcp-integration-model-context-protocol";

export type IntegrationMode = "mcp" | "cli" | "none";
export type McpClient = "claude" | "codex" | "gemini" | "kiro" | "guide";

export interface InitializeProjectOptions {
	projectName: string;
	/**
	 * Optional `data:` override recorded in the machine workspace index, for
	 * when this workspace's task data lives outside `<projectRoot>/backlog`.
	 */
	workspaceDataDir?: string;
	backlogDirectory?: string;
	backlogDirectorySource?: "backlog" | ".backlog" | "custom";
	configLocation?: "folder" | "root";
	integrationMode: IntegrationMode;
	mcpClients?: McpClient[];
	agentInstructions?: AgentInstructionFile[];
	installClaudeAgent?: boolean;
	filesystemOnly?: boolean;
	advancedConfig?: {
		checkActiveBranches?: boolean;
		remoteOperations?: boolean;
		activeBranchDays?: number;
		bypassGitHooks?: boolean;
		zeroPaddedIds?: number;
		defaultEditor?: string;
		definitionOfDone?: string[];
		defaultPort?: number;
		autoOpenBrowser?: boolean;
		/** Custom task prefix (e.g., "JIRA"). Only set during first init, read-only after. */
		taskPrefix?: string;
	};
	/** Existing config for re-initialization */
	existingConfig?: BacklogConfig | null;
}

export interface InitializeProjectResult {
	success: boolean;
	projectName: string;
	isReInitialization: boolean;
	config: BacklogConfig;
	mcpResults?: Record<string, string>;
}

async function runMcpClientCommand(label: string, command: string, args: string[]): Promise<string> {
	try {
		const child = spawn({
			cmd: [command, ...args],
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await child.exited;
		if (exitCode !== 0) {
			throw new Error(`Command exited with code ${exitCode}`);
		}
		return `Added Backlog MCP server to ${label}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Unable to configure ${label} automatically (${message}). Run manually: ${command} ${args.join(" ")}`,
		);
	}
}

/**
 * Core initialization logic shared between CLI and browser.
 * Both CLI and browser validate input before calling this function.
 */
export async function initializeProject(
	core: Core,
	options: InitializeProjectOptions,
): Promise<InitializeProjectResult> {
	const {
		projectName,
		integrationMode,
		mcpClients = [],
		agentInstructions = [],
		installClaudeAgent: installClaudeAgentFlag = false,
		advancedConfig = {},
		existingConfig,
		filesystemOnly = false,
	} = options;

	const isReInitialization = !!existingConfig;
	const projectRoot = core.filesystem.rootDir;

	// When `--workspace-data <path>` is given, that path IS the workspace:
	// config + tasks are created there, not under <projectRoot>/backlog.
	// Record the override and create the directory up front so every
	// subsequent resolve (structure creation, saveConfig, registration)
	// — all centralised through resolveBacklogDirectory — targets it.
	let workspaceDataDir: string | undefined;
	if (options.workspaceDataDir) {
		const { setActiveWorkspaceDataDir } = await import("../utils/active-workspace.ts");
		const { resolve: resolvePath } = await import("node:path");
		const { mkdir } = await import("node:fs/promises");
		// Normalise so the index entry and the resolver agree on the path.
		workspaceDataDir = resolvePath(options.workspaceDataDir);
		await mkdir(workspaceDataDir, { recursive: true });
		setActiveWorkspaceDataDir(projectRoot, workspaceDataDir);
		core.filesystem.invalidateConfigCache();
	}

	const effectiveFilesystemOnly = filesystemOnly || existingConfig?.filesystemOnly === true;
	const normalizedAdvancedConfig = effectiveFilesystemOnly
		? {
				...advancedConfig,
				checkActiveBranches: false,
				remoteOperations: false,
				bypassGitHooks: false,
			}
		: advancedConfig;
	const hasDefaultEditorOverride = Object.hasOwn(normalizedAdvancedConfig, "defaultEditor");
	const hasZeroPaddedIdsOverride = Object.hasOwn(normalizedAdvancedConfig, "zeroPaddedIds");
	const hasDefinitionOfDoneOverride = Object.hasOwn(normalizedAdvancedConfig, "definitionOfDone");

	// Build config, preserving existing values for re-initialization.
	// Re-init should be idempotent for fields that init does not explicitly manage.
	const d = DEFAULT_INIT_CONFIG;
	const baseConfig: BacklogConfig = {
		projectName,
		statuses: [...DEFAULT_STATUSES],
		labels: [],
		defaultStatus: "To Do",
		dateFormat: "yyyy-mm-dd",
		maxColumnWidth: 20,
		filesystemOnly: effectiveFilesystemOnly || d.filesystemOnly,
		remoteOperations:
			normalizedAdvancedConfig.remoteOperations ?? existingConfig?.remoteOperations ?? d.remoteOperations,
		bypassGitHooks: normalizedAdvancedConfig.bypassGitHooks ?? existingConfig?.bypassGitHooks ?? d.bypassGitHooks,
		checkActiveBranches:
			normalizedAdvancedConfig.checkActiveBranches ?? existingConfig?.checkActiveBranches ?? d.checkActiveBranches,
		activeBranchDays:
			normalizedAdvancedConfig.activeBranchDays ?? existingConfig?.activeBranchDays ?? d.activeBranchDays,
		defaultPort: normalizedAdvancedConfig.defaultPort ?? existingConfig?.defaultPort ?? d.defaultPort,
		autoOpenBrowser: normalizedAdvancedConfig.autoOpenBrowser ?? existingConfig?.autoOpenBrowser ?? d.autoOpenBrowser,
		taskResolutionStrategy: existingConfig?.taskResolutionStrategy || "most_recent",
		// Preserve existing prefixes on re-init, or use custom prefix if provided during first init
		prefixes: existingConfig?.prefixes || {
			task: normalizedAdvancedConfig.taskPrefix || "task",
		},
	};
	const config: BacklogConfig = {
		...baseConfig,
		...(existingConfig ?? {}),
		projectName,
		filesystemOnly: effectiveFilesystemOnly || d.filesystemOnly,
		remoteOperations:
			normalizedAdvancedConfig.remoteOperations ?? existingConfig?.remoteOperations ?? d.remoteOperations,
		bypassGitHooks: normalizedAdvancedConfig.bypassGitHooks ?? existingConfig?.bypassGitHooks ?? d.bypassGitHooks,
		checkActiveBranches:
			normalizedAdvancedConfig.checkActiveBranches ?? existingConfig?.checkActiveBranches ?? d.checkActiveBranches,
		activeBranchDays:
			normalizedAdvancedConfig.activeBranchDays ?? existingConfig?.activeBranchDays ?? d.activeBranchDays,
		defaultPort: normalizedAdvancedConfig.defaultPort ?? existingConfig?.defaultPort ?? d.defaultPort,
		autoOpenBrowser: normalizedAdvancedConfig.autoOpenBrowser ?? existingConfig?.autoOpenBrowser ?? d.autoOpenBrowser,
		prefixes: existingConfig?.prefixes || {
			task: normalizedAdvancedConfig.taskPrefix || "task",
		},
		...(hasDefaultEditorOverride && normalizedAdvancedConfig.defaultEditor
			? { defaultEditor: normalizedAdvancedConfig.defaultEditor }
			: {}),
		...(hasZeroPaddedIdsOverride &&
		typeof normalizedAdvancedConfig.zeroPaddedIds === "number" &&
		normalizedAdvancedConfig.zeroPaddedIds > 0
			? { zeroPaddedIds: normalizedAdvancedConfig.zeroPaddedIds }
			: {}),
		...(hasDefinitionOfDoneOverride && Array.isArray(normalizedAdvancedConfig.definitionOfDone)
			? { definitionOfDone: [...normalizedAdvancedConfig.definitionOfDone] }
			: {}),
	};
	// Preserve all non-init-managed fields, but allow init-managed optional fields to be explicitly cleared.
	if (hasDefaultEditorOverride && !normalizedAdvancedConfig.defaultEditor) {
		delete config.defaultEditor;
	}
	if (
		hasZeroPaddedIdsOverride &&
		!(typeof normalizedAdvancedConfig.zeroPaddedIds === "number" && normalizedAdvancedConfig.zeroPaddedIds > 0)
	) {
		delete config.zeroPaddedIds;
	}
	if (hasDefinitionOfDoneOverride && !Array.isArray(normalizedAdvancedConfig.definitionOfDone)) {
		delete config.definitionOfDone;
	}

	// Create structure and save config (id minted + workspace registered after save).
	if (isReInitialization) {
		await core.filesystem.saveConfig(config);
	} else if (core.filesystem.isGlobalStoreSlot()) {
		// Global-store branch: the caller pointed the FS at a flat slot via
		// setGlobalStoreSlot. Validate preconditions and create the structure.
		const machine = readMachineConfig();
		if (machine.globalStore) {
			await ensureGlobalStoreExists(machine.globalStore);
		}
		const slotPath = core.filesystem.backlogDir;
		if (await dirExistsAndNonEmpty(slotPath)) {
			throw new Error(`Global store slot already exists and is not empty: ${slotPath}. Refusing to overwrite.`);
		}
		await core.filesystem.ensureBacklogStructure();
		await core.filesystem.saveConfig(config);
		await core.ensureConfigLoaded();
		// No repo-root marker: projects are global-store entities addressed by
		// name (current pointer / --project), not tagged to repos. The scan finds
		// the slot via <globalStore>/<name>/config.yml.
	} else {
		const normalizedBacklogDirectory = normalizeProjectBacklogDirectory(options.backlogDirectory);
		const inferredBacklogDirectorySource = normalizedBacklogDirectory
			? normalizedBacklogDirectory === ".backlog"
				? ".backlog"
				: normalizedBacklogDirectory === "backlog"
					? "backlog"
					: "custom"
			: undefined;
		if (
			options.backlogDirectorySource &&
			inferredBacklogDirectorySource &&
			options.backlogDirectorySource !== inferredBacklogDirectorySource
		) {
			throw new Error("Backlog directory source and backlog directory value must agree.");
		}
		const effectiveBacklogDirectorySource = options.backlogDirectorySource ?? inferredBacklogDirectorySource;
		if (effectiveBacklogDirectorySource === "custom" && !normalizedBacklogDirectory) {
			throw new Error("Backlog directory must be a valid project-relative path.");
		}
		const effectiveConfigLocation =
			options.configLocation ?? (effectiveBacklogDirectorySource === "custom" ? "root" : "folder");
		if (effectiveBacklogDirectorySource === "custom" && effectiveConfigLocation !== "root") {
			throw new Error("Custom backlog directories require root config discovery.");
		}
		const selectedBacklogDirectory =
			normalizedBacklogDirectory ??
			(effectiveBacklogDirectorySource === ".backlog"
				? ".backlog"
				: effectiveBacklogDirectorySource === "backlog"
					? "backlog"
					: "backlog");
		core.filesystem.setBacklogDirectory(selectedBacklogDirectory);
		core.filesystem.setConfigLocation(effectiveConfigLocation);
		await core.filesystem.ensureBacklogStructure();
		await core.filesystem.saveConfig(config);
		await core.ensureConfigLoaded();
	}

	// Register the workspace in the machine-wide index and mark it current.
	// Mints + persists a stable id into the project config if missing.
	// Best-effort: if the home directory isn't writable (sandboxed envs,
	// read-only setups), init still succeeds.
	//
	// Global-store projects are discovered by scanning <globalStore>/* (the slot
	// IS the source of truth), so they do NOT get a registry path. We set the
	// current pointer to the new project's id so it becomes active. Local-mode
	// projects keep their registry path, which is their only address.
	const isGlobalStore = core.filesystem.isGlobalStoreSlot();
	try {
		if (isGlobalStore) {
			// Mark the new project current using the SAME id the global-store scan
			// reports: the slot's config id if present, else the slot dir name.
			// Keeping these in sync lets the persisted `current` pointer match a
			// scanned project across restarts.
			const cfgId = (await core.filesystem.loadConfig())?.id;
			const id = cfgId ?? basename(core.filesystem.backlogDir);
			const { setCurrentWorkspaceId } = await import("../utils/workspaces-index.ts");
			await setCurrentWorkspaceId(id);
		} else {
			const { registerWorkspaceAtPath } = await import("../utils/workspace-registration.ts");
			const { entry } = await registerWorkspaceAtPath(projectRoot, { data: workspaceDataDir });
			if (entry.id) {
				const { setCurrentWorkspaceId } = await import("../utils/workspaces-index.ts");
				await setCurrentWorkspaceId(entry.id);
			}
		}
	} catch (err) {
		console.warn(`Warning: could not register workspace in machine index: ${(err as Error).message}`);
	}

	const mcpResults: Record<string, string> = {};

	// Handle MCP integration
	if (integrationMode === "mcp" && mcpClients.length > 0) {
		for (const client of mcpClients) {
			try {
				if (client === "claude") {
					const result = await runMcpClientCommand("Claude Code", "claude", [
						"mcp",
						"add",
						"-s",
						"user",
						MCP_SERVER_NAME,
						"--",
						"backlog",
						"mcp",
						"start",
					]);
					mcpResults.claude = result;
					await ensureMcpGuidelines(projectRoot, "CLAUDE.md");
				} else if (client === "codex") {
					const result = await runMcpClientCommand("OpenAI Codex", "codex", [
						"mcp",
						"add",
						MCP_SERVER_NAME,
						"backlog",
						"mcp",
						"start",
					]);
					mcpResults.codex = result;
					await ensureMcpGuidelines(projectRoot, "AGENTS.md");
				} else if (client === "gemini") {
					const result = await runMcpClientCommand("Gemini CLI", "gemini", [
						"mcp",
						"add",
						"-s",
						"user",
						MCP_SERVER_NAME,
						"backlog",
						"mcp",
						"start",
					]);
					mcpResults.gemini = result;
					await ensureMcpGuidelines(projectRoot, "GEMINI.md");
				} else if (client === "kiro") {
					const result = await runMcpClientCommand("Kiro", "kiro-cli", [
						"mcp",
						"add",
						"--scope",
						"global",
						"--name",
						MCP_SERVER_NAME,
						"--command",
						"backlog",
						"--args",
						"mcp,start",
					]);
					mcpResults.kiro = result;
					await ensureMcpGuidelines(projectRoot, "AGENTS.md");
				} else if (client === "guide") {
					mcpResults.guide = `Setup guide: ${MCP_GUIDE_URL}`;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				mcpResults[client] = `Failed: ${message}`;
			}
		}
	}

	// Handle CLI integration - agent instruction files
	if (integrationMode === "cli" && agentInstructions.length > 0) {
		try {
			await addAgentInstructions(projectRoot, agentInstructions);
			mcpResults.agentFiles = `Created: ${agentInstructions.join(", ")}`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			mcpResults.agentFiles = `Failed: ${message}`;
		}
	}

	// Handle Claude agent installation
	if (integrationMode === "cli" && installClaudeAgentFlag) {
		try {
			await installClaudeAgent(projectRoot);
			mcpResults.claudeAgent = "Installed to .claude/agents/";
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			mcpResults.claudeAgent = `Failed: ${message}`;
		}
	}

	return {
		success: true,
		projectName,
		isReInitialization,
		config,
		mcpResults: Object.keys(mcpResults).length > 0 ? mcpResults : undefined,
	};
}
