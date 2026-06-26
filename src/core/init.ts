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

export type CreateGlobalProjectError = "no_global_store" | "invalid_name" | "already_exists";

export interface CreateGlobalProjectResult {
	ok: boolean;
	error?: CreateGlobalProjectError;
	/** Scan id of the created project (slot dir name), when ok. */
	id?: string;
	slotPath?: string;
}

/**
 * Create a new global-store project by name: a flat slot at
 * `<globalStore>/<name>/` (config.yml + tasks/). Shared by the CLI
 * (`project create` / `init <name>`) and the server (POST /api/projects).
 * Does NOT set the current pointer — callers decide that.
 */
export async function createGlobalProject(name: string, taskPrefix?: string): Promise<CreateGlobalProjectResult> {
	const { join } = await import("node:path");
	const { readMachineConfig } = await import("../utils/machine-config.ts");
	const { isSafeSlotName } = await import("../utils/backlog-directory.ts");
	const { pathExistsAsDirectory } = await import("../utils/projects-index.ts");
	const { Core } = await import("./backlog.ts");

	const { globalStore } = readMachineConfig();
	if (!globalStore) return { ok: false, error: "no_global_store" };
	if (!isSafeSlotName(name)) return { ok: false, error: "invalid_name" };

	const slotPath = join(globalStore, name);
	if (await pathExistsAsDirectory(slotPath)) return { ok: false, error: "already_exists" };

	const core = new Core(slotPath);
	core.filesystem.setGlobalStoreSlot(slotPath, name);
	await initializeProject(core, {
		projectName: name,
		integrationMode: "none",
		...(taskPrefix ? { advancedConfig: { taskPrefix } } : {}),
	});

	const { scanGlobalStoreProjects } = await import("../utils/global-store-scan.ts");
	const created = (await scanGlobalStoreProjects()).find((p) => p.slotPath === slotPath);
	return { ok: true, id: created?.id, slotPath };
}

export type IntegrationMode = "mcp" | "cli" | "none";
export type McpClient = "claude" | "codex" | "gemini" | "kiro" | "guide";

export interface InitializeProjectOptions {
	projectName: string;
	integrationMode: IntegrationMode;
	mcpClients?: McpClient[];
	agentInstructions?: AgentInstructionFile[];
	installClaudeAgent?: boolean;
	advancedConfig?: {
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
	} = options;

	const isReInitialization = !!existingConfig;
	const projectRoot = core.filesystem.rootDir;

	const normalizedAdvancedConfig = advancedConfig;
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
		defaultPort: normalizedAdvancedConfig.defaultPort ?? existingConfig?.defaultPort ?? d.defaultPort,
		autoOpenBrowser: normalizedAdvancedConfig.autoOpenBrowser ?? existingConfig?.autoOpenBrowser ?? d.autoOpenBrowser,
		// Preserve existing prefixes on re-init, or use custom prefix if provided during first init
		prefixes: existingConfig?.prefixes || {
			task: normalizedAdvancedConfig.taskPrefix || "task",
		},
	};
	const config: BacklogConfig = {
		...baseConfig,
		...(existingConfig ?? {}),
		projectName,
		defaultPort: normalizedAdvancedConfig.defaultPort ?? existingConfig?.defaultPort ?? d.defaultPort,
		autoOpenBrowser: normalizedAdvancedConfig.autoOpenBrowser ?? existingConfig?.autoOpenBrowser ?? d.autoOpenBrowser,
		prefixes: existingConfig?.prefixes || {
			task: normalizedAdvancedConfig.taskPrefix || "task",
		},
		...(hasDefinitionOfDoneOverride && Array.isArray(normalizedAdvancedConfig.definitionOfDone)
			? { definitionOfDone: [...normalizedAdvancedConfig.definitionOfDone] }
			: {}),
	};
	// Preserve all non-init-managed fields, but allow init-managed optional fields to be explicitly cleared.
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
		// Non-slot init: used by the in-process test harness. Creates the default
		// `backlog/` + folder-config layout. (Production init always sets a
		// global-store slot and takes the branch above.)
		core.filesystem.setBacklogDirectory("backlog");
		core.filesystem.setConfigLocation("folder");
		await core.filesystem.ensureBacklogStructure();
		await core.filesystem.saveConfig(config);
		await core.ensureConfigLoaded();
	}

	// Global-store projects are discovered by scanning <globalStore>/* (the slot
	// IS the source of truth). Mark the new project current so it becomes active.
	// Best-effort: if the home directory isn't writable (sandboxed envs,
	// read-only setups), init still succeeds.
	if (core.filesystem.isGlobalStoreSlot()) {
		try {
			// Use the SAME id the global-store scan reports: the slot's config id if
			// present, else the slot dir name. Keeping these in sync lets the
			// persisted `current` pointer match a scanned project across restarts.
			const cfgId = (await core.filesystem.loadConfig())?.id;
			const id = cfgId ?? basename(core.filesystem.backlogDir);
			const { setCurrentProjectId } = await import("../utils/projects-index.ts");
			await setCurrentProjectId(id);
		} catch (err) {
			console.warn(`Warning: could not set current project pointer: ${(err as Error).message}`);
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
