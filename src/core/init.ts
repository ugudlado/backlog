import { isAbsolute, join } from "node:path";
import { spawn } from "bun";
import {
	type AgentInstructionFile,
	addAgentInstructions,
	ensureMcpGuidelines,
	installClaudeAgent,
} from "../agent-instructions.ts";
import { DEFAULT_INIT_CONFIG, DEFAULT_STATUSES } from "../constants/index.ts";
import type { BacklogConfig } from "../types/index.ts";
import {
	getWorkspaceFilePath,
	scanWorkspacesSync,
	setCurrentWorkspaceNameIfUnset,
	workspaceNameForRepo,
} from "../utils/workspace-store.ts";
import { toAbsoluteProjectRoot } from "../utils/workspaces-index.ts";
import type { Core } from "./backlog.ts";

export const MCP_SERVER_NAME = "backlog";
export const MCP_GUIDE_URL = "https://github.com/MrLesk/Backlog.md#-mcp-integration-model-context-protocol";

export type IntegrationMode = "mcp" | "cli" | "none";
export type McpClient = "claude" | "codex" | "gemini" | "kiro" | "guide";

export interface InitializeProjectOptions {
	projectName: string;
	/** Absolute or project-relative data dir override (`--data`). Defaults to `<repo>/backlog`. */
	dataDir?: string;
	/** Workspace file basename override (`--name`) for basename clashes. Defaults to repo basename. */
	workspaceName?: string;
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
		autoCommit?: boolean;
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
	const effectiveFilesystemOnly = filesystemOnly || existingConfig?.filesystemOnly === true;
	const normalizedAdvancedConfig = effectiveFilesystemOnly
		? {
				...advancedConfig,
				checkActiveBranches: false,
				remoteOperations: false,
				bypassGitHooks: false,
				autoCommit: false,
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
		autoCommit: normalizedAdvancedConfig.autoCommit ?? existingConfig?.autoCommit ?? d.autoCommit,
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
		autoCommit: normalizedAdvancedConfig.autoCommit ?? existingConfig?.autoCommit ?? d.autoCommit,
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

	if (isReInitialization) {
		// The FileSystem constructor already resolved to the existing per-repo
		// workspace yml (preserving its `repo:`/`data:`). Just rewrite settings;
		// `--data` is rejected for re-init upstream, and `current:` is left as-is.
		await core.filesystem.saveConfig(config);
	} else {
		// Resolve the absolute data dir: `--data` override (absolute kept as-is,
		// relative resolved against the repo) else `<repo>/backlog`.
		const dataDir = options.dataDir?.trim();
		const dataPath = dataDir
			? isAbsolute(dataDir)
				? dataDir
				: join(projectRoot, dataDir)
			: join(projectRoot, "backlog");

		// Workspace file basename: `--name` override else repo basename.
		const workspaceName = (options.workspaceName?.trim() || workspaceNameForRepo(projectRoot)).replace(
			/\.ya?ml$/i,
			"",
		);
		const workspaceFilePath = getWorkspaceFilePath(workspaceName);

		// Basename clash: a workspace file with this name already exists for a
		// DIFFERENT repo. Same repo → idempotent re-init (overwrite the file).
		const existing = scanWorkspacesSync().find((w) => w.name === workspaceName);
		if (existing && toAbsoluteProjectRoot(existing.repo) !== toAbsoluteProjectRoot(projectRoot)) {
			throw new Error(
				`Workspace name "${workspaceName}" already maps to a different repo (${existing.repo}). ` +
					`Re-run with --name <unique> to disambiguate.`,
			);
		}

		// The per-repo yml IS the config file. Point the FileSystem at the
		// explicit workspace paths before saving so resolution + future saves
		// are coherent.
		core.filesystem.setWorkspacePaths(
			toAbsoluteProjectRoot(projectRoot),
			toAbsoluteProjectRoot(dataPath),
			workspaceFilePath,
		);
		await core.filesystem.ensureBacklogStructure();
		await core.filesystem.saveConfig(config);
		core.filesystem.invalidateConfigCache();
		await core.ensureConfigLoaded();

		// Mark this workspace current if nothing is set yet. Best-effort: a
		// read-only home (sandboxed envs) must not fail init.
		try {
			await setCurrentWorkspaceNameIfUnset(workspaceName);
		} catch (err) {
			console.warn(`Warning: could not set current workspace: ${(err as Error).message}`);
		}
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
			await addAgentInstructions(projectRoot, core.gitOps, agentInstructions, config.autoCommit);
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
