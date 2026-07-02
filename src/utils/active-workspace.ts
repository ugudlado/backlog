/**
 * Active-workspace data-dir overrides, keyed by project root.
 *
 * The CLI resolves the active workspace once per invocation (in
 * `requireProjectRoot`). When the resolved `workspaces.yml` entry carries a
 * `data:` override, the data directory is NOT `<projectRoot>/backlog`. Rather
 * than thread that override through 22 `new Core(...)` call sites, the resolver
 * records it here and `FileSystem` reads it for the matching project root.
 *
 * Keyed by project root so a stale value can never apply to a different
 * workspace. A map (rather than a single value) lets a long-lived server hold
 * overrides for several project roots at once — e.g. the per-project MCP
 * endpoints, where each global-store slot is its own root and data dir.
 */

import { normalize, resolve } from "node:path";

const activeDataDirByRoot = new Map<string, string>();

function key(projectRoot: string): string {
	return normalize(resolve(projectRoot));
}

/** Record the active workspace's data-dir override (called by the resolver). */
export function setActiveWorkspaceDataDir(projectRoot: string, dataDir: string | undefined): void {
	if (dataDir) {
		activeDataDirByRoot.set(key(projectRoot), dataDir);
	} else {
		activeDataDirByRoot.delete(key(projectRoot));
	}
}

/**
 * Data-dir override for `projectRoot`, or null when none was recorded for that
 * exact root. Returns null for any other root so a stale value cannot leak.
 */
export function getActiveWorkspaceDataDir(projectRoot: string): string | null {
	return activeDataDirByRoot.get(key(projectRoot)) ?? null;
}

/** Test/teardown helper: clear all recorded overrides. */
export function clearActiveWorkspaceDataDir(): void {
	activeDataDirByRoot.clear();
}
