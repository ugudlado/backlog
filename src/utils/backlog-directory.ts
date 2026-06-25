import { readFileSync, statSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { DEFAULT_DIRECTORIES, DEFAULT_FILES } from "../constants/index.ts";
import { getActiveWorkspaceDataDir } from "./active-workspace.ts";
import { readMachineConfig } from "./machine-config.ts";

export type BacklogDirectorySource = "backlog" | ".backlog" | "custom";
export type BacklogConfigSource = "folder" | "root";

/**
 * A project name is usable as a global-store slot only if it is a single safe
 * path component AND safe to write into the YAML marker: no path separators,
 * no `.`/`..` traversal, no NUL, and no quote/newline/backslash that could
 * break out of the quoted marker value. Keying or writing an unsanitized name
 * would let `init "../x"` escape the store or corrupt the marker.
 */
export function isSafeSlotName(name: string): boolean {
	if (!name || name === "." || name === "..") return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is exactly what we reject
	return !/[/\\\0"\r\n]/.test(name);
}

export interface BacklogDirectoryResolution {
	projectRoot: string;
	backlogDir: string | null;
	backlogPath: string | null;
	source: BacklogDirectorySource | null;
	configPath: string | null;
	configSource: BacklogConfigSource | null;
	rootConfigPath: string;
	rootConfigExists: boolean;
}

export interface BacklogConfigMetadata {
	projectName: string | null;
	backlogDirectory: string | null;
	id: string | null;
	/** Marker that this project's tasks live in the global store. */
	store: "global" | null;
}

function directoryExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Parse the handful of scalar keys Backlog reads out of a `config.yml` /
 * `backlog.config.yml`. Shared by resolution, the global-store scan, and the
 * registry guard so there is one line-parser, not three.
 */
export function parseBacklogConfigMetadata(content: string): BacklogConfigMetadata {
	let projectName: string | null = null;
	let backlogDirectory: string | null = null;
	let id: string | null = null;
	let store: "global" | null = null;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) {
			continue;
		}
		const key = line.slice(0, colonIndex).trim();
		const value = line
			.slice(colonIndex + 1)
			.trim()
			.replace(/^['"]|['"]$/g, "");
		if ((key === "project_name" || key === "projectName") && value) {
			projectName = value;
		} else if (key === "backlog_directory" || key === "backlogDirectory") {
			backlogDirectory = normalizeProjectBacklogDirectory(value);
		} else if (key === "id" && value) {
			id = value;
		} else if (key === "store" && value === "global") {
			store = "global";
		}
	}
	return { projectName, backlogDirectory, id, store };
}

function readRootBacklogConfigMetadata(rootConfigPath: string): BacklogConfigMetadata | null {
	if (!fileExists(rootConfigPath)) {
		return null;
	}
	try {
		const metadata = parseBacklogConfigMetadata(readFileSync(rootConfigPath, "utf8"));
		return metadata.projectName ? metadata : null;
	} catch {
		return null;
	}
}

function resolveFolderConfigPath(backlogPath: string): string | null {
	const primary = join(backlogPath, DEFAULT_FILES.CONFIG);
	if (fileExists(primary)) {
		return primary;
	}
	const alternate = join(backlogPath, DEFAULT_FILES.CONFIG_YAML);
	return fileExists(alternate) ? alternate : null;
}

function resolveBuiltInBacklogDirectory(projectRoot: string): {
	backlogDir: string;
	backlogPath: string;
	source: "backlog" | ".backlog";
} | null {
	const defaultBacklogPath = join(projectRoot, DEFAULT_DIRECTORIES.BACKLOG);
	const hiddenBacklogPath = join(projectRoot, DEFAULT_DIRECTORIES.HIDDEN_BACKLOG);
	const defaultBacklogExists = directoryExists(defaultBacklogPath);
	const hiddenBacklogExists = directoryExists(hiddenBacklogPath);
	const defaultConfigPath = defaultBacklogExists ? resolveFolderConfigPath(defaultBacklogPath) : null;
	const hiddenConfigPath = hiddenBacklogExists ? resolveFolderConfigPath(hiddenBacklogPath) : null;

	if (defaultConfigPath) {
		return {
			backlogDir: DEFAULT_DIRECTORIES.BACKLOG,
			backlogPath: defaultBacklogPath,
			source: "backlog",
		};
	}

	if (hiddenConfigPath) {
		return {
			backlogDir: DEFAULT_DIRECTORIES.HIDDEN_BACKLOG,
			backlogPath: hiddenBacklogPath,
			source: ".backlog",
		};
	}

	if (defaultBacklogExists) {
		return {
			backlogDir: DEFAULT_DIRECTORIES.BACKLOG,
			backlogPath: defaultBacklogPath,
			source: "backlog",
		};
	}

	if (hiddenBacklogExists) {
		return {
			backlogDir: DEFAULT_DIRECTORIES.HIDDEN_BACKLOG,
			backlogPath: hiddenBacklogPath,
			source: ".backlog",
		};
	}

	return null;
}

/** Synchronously resolves the git repository root for the given directory. Returns null if not in a git repo. */
function resolveGitRootSync(cwd: string): string | null {
	try {
		const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
			cwd,
			stderr: "ignore",
		});
		if (r.exitCode !== 0) return null;
		const out = new TextDecoder().decode(r.stdout).trim();
		return out || null;
	} catch {
		return null;
	}
}

/**
 * Tries to resolve backlog directory via the globalStore machine config.
 * Only resolves when `projectRoot` is the git repository root (not a subdirectory),
 * so that `findBacklogRoot`'s walk-up correctly terminates at the git root.
 * Returns null if globalStore is not set, not in a git repo, or projectRoot is not the git root.
 */
function resolveGlobalStoreBacklogDirectory(
	projectRoot: string,
	rootConfigPath: string,
	rootConfigExists: boolean,
	explicitSlot?: string,
): BacklogDirectoryResolution | null {
	const machine = readMachineConfig();
	if (!machine.globalStore) return null;

	// An explicit slot comes from a repo-root marker (`store: global` +
	// `project_name`). The marker is an on-disk file that may be hand-edited or
	// crafted, so validate it as a safe single path component before joining it
	// into the store path — never trust it to be traversal-free.
	let slot: string;
	if (explicitSlot) {
		if (!isSafeSlotName(explicitSlot)) return null;
		slot = explicitSlot;
	} else {
		const gitRoot = resolveGitRootSync(projectRoot);
		if (!gitRoot) return null;

		// Only resolve when the caller is asking about the git root itself,
		// not a subdirectory inside it. This ensures findBacklogRoot's walk-up
		// terminates at the correct level.
		if (gitRoot !== projectRoot) return null;

		slot = basename(gitRoot);
	}
	const backlogPath = join(machine.globalStore, slot);
	const configPath = join(backlogPath, DEFAULT_FILES.CONFIG);
	return {
		projectRoot,
		backlogDir: slot,
		backlogPath,
		source: "custom",
		configPath,
		configSource: "folder",
		rootConfigPath,
		rootConfigExists,
	};
}

export function normalizeProjectBacklogDirectory(value: string | null | undefined): string | null {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) {
		return null;
	}
	if (/^(?:[a-zA-Z]:)?[\\/]/.test(trimmed)) {
		return null;
	}

	const normalized = normalize(trimmed).replace(/\\/g, "/").replace(/\/+$/g, "");
	if (!normalized || normalized === ".") {
		return null;
	}
	if (normalized === ".." || normalized.startsWith("../")) {
		return null;
	}
	return normalized;
}

export function resolveBacklogDirectory(projectRoot: string): BacklogDirectoryResolution {
	const rootConfigPath = join(projectRoot, DEFAULT_FILES.ROOT_CONFIG);
	const rootConfigExists = fileExists(rootConfigPath);

	// A `workspaces.yml` entry `data:` override (recorded by whichever path
	// resolved the active workspace) wins over every project-root-relative
	// rule below. Centralising the read here means every consumer of this
	// resolver — FileSystem ctor, invalidateConfigCache, registration,
	// server, init — honours the override without each having to remember.
	// The data dir IS the backlog dir, with `config.yml` flat inside it.
	const dataDirOverride = getActiveWorkspaceDataDir(projectRoot);
	if (dataDirOverride) {
		return {
			projectRoot,
			backlogDir: dataDirOverride,
			backlogPath: dataDirOverride,
			source: "custom",
			configPath: join(dataDirOverride, DEFAULT_FILES.CONFIG),
			configSource: "folder",
			rootConfigPath,
			rootConfigExists,
		};
	}

	if (rootConfigExists) {
		const metadata = readRootBacklogConfigMetadata(rootConfigPath);
		// A repo-root marker that declares `store: global` is self-describing:
		// its task data lives in the global-store slot named after the project,
		// independent of any registry path. The marker's project_name IS the
		// slot, so a repo can be named independently of its directory.
		if (metadata?.store === "global" && metadata.projectName) {
			const resolved = resolveGlobalStoreBacklogDirectory(
				projectRoot,
				rootConfigPath,
				rootConfigExists,
				metadata.projectName,
			);
			if (resolved) return resolved;
		}
		const configuredBacklogDir = metadata?.backlogDirectory ?? null;
		if (metadata && configuredBacklogDir) {
			const configuredBacklogPath = join(projectRoot, configuredBacklogDir);
			const configuredSource: BacklogDirectorySource =
				configuredBacklogDir === DEFAULT_DIRECTORIES.BACKLOG
					? "backlog"
					: configuredBacklogDir === DEFAULT_DIRECTORIES.HIDDEN_BACKLOG
						? ".backlog"
						: "custom";
			return {
				projectRoot,
				backlogDir: configuredBacklogDir,
				backlogPath: configuredBacklogPath,
				source: configuredSource,
				configPath: rootConfigPath,
				configSource: "root",
				rootConfigPath,
				rootConfigExists,
			};
		}

		if (metadata) {
			const builtIn = resolveBuiltInBacklogDirectory(projectRoot);
			if (builtIn) {
				return {
					projectRoot,
					backlogDir: builtIn.backlogDir,
					backlogPath: builtIn.backlogPath,
					source: builtIn.source,
					configPath: rootConfigPath,
					configSource: "root",
					rootConfigPath,
					rootConfigExists,
				};
			}

			return (
				resolveGlobalStoreBacklogDirectory(projectRoot, rootConfigPath, rootConfigExists) ?? {
					projectRoot,
					backlogDir: null,
					backlogPath: null,
					source: null,
					configPath: null,
					configSource: null,
					rootConfigPath,
					rootConfigExists,
				}
			);
		}
	}

	const builtIn = resolveBuiltInBacklogDirectory(projectRoot);
	if (!builtIn) {
		return (
			resolveGlobalStoreBacklogDirectory(projectRoot, rootConfigPath, rootConfigExists) ?? {
				projectRoot,
				backlogDir: null,
				backlogPath: null,
				source: null,
				configPath: null,
				configSource: null,
				rootConfigPath,
				rootConfigExists,
			}
		);
	}

	const folderConfigPath = resolveFolderConfigPath(builtIn.backlogPath);
	return {
		projectRoot,
		backlogDir: builtIn.backlogDir,
		backlogPath: builtIn.backlogPath,
		source: builtIn.source,
		configPath: folderConfigPath,
		configSource: folderConfigPath ? "folder" : null,
		rootConfigPath,
		rootConfigExists,
	};
}
