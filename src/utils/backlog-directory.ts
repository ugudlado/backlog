import { basename, join, normalize } from "node:path";
import { DEFAULT_FILES } from "../constants/index.ts";
import { resolveWorkspace } from "./workspace-store.ts";

export type BacklogDirectorySource = "backlog" | ".backlog" | "custom";
export type BacklogConfigSource = "folder" | "root";

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

/**
 * Project-relative backlog directory normalizer (still used by init's
 * `--data` validation path). Rejects absolute paths and parent traversal.
 */
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

/**
 * Resolves the backlog data/config for a given cwd (or project root) using the
 * per-repo workspace files in the machine config dir.
 *
 * Resolution order (see `workspace-store.resolveWorkspace`):
 *   1. deepest `repo:` prefix match against cwd,
 *   2. else the `current:` workspace from machine config.yml,
 *   3. else an all-null resolution (callers surface the error).
 *
 * The shape stays compatible with the legacy folder/root model so existing
 * consumers keep working:
 *   - `backlogPath`  = workspace `data:` path (absolute),
 *   - `configPath`   = the per-repo yml file (it now holds settings inline),
 *   - `backlogDir`   = basename of `data` (cosmetic only),
 *   - `configSource` = "folder", `source` = "custom",
 *   - `projectRoot`  = the matched `repo:` path,
 *   - `rootConfigPath`/`rootConfigExists` retained for shape compat.
 */
export function resolveBacklogDirectory(projectRoot: string): BacklogDirectoryResolution {
	const rootConfigPath = join(projectRoot, DEFAULT_FILES.ROOT_CONFIG);
	const workspace = resolveWorkspace(projectRoot);

	if (!workspace) {
		return {
			projectRoot,
			backlogDir: null,
			backlogPath: null,
			source: null,
			configPath: null,
			configSource: null,
			rootConfigPath,
			rootConfigExists: false,
		};
	}

	return {
		projectRoot: workspace.repo,
		backlogDir: basename(workspace.data),
		backlogPath: workspace.data,
		source: "custom",
		configPath: workspace.filePath,
		configSource: "folder",
		rootConfigPath,
		rootConfigExists: false,
	};
}
