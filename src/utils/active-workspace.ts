/**
 * Request-scoped active-workspace data-dir override.
 *
 * The CLI resolves the active workspace once per invocation (in
 * `requireProjectRoot`). When the resolved `workspaces.yml` entry carries a
 * `data:` override, the data directory is NOT `<projectRoot>/backlog`. Rather
 * than thread that override through 22 `new Core(...)` call sites, the resolver
 * records it here and `FileSystem` reads it for the matching project root.
 *
 * Scope: a single CLI process handles one command, so a module-scoped value is
 * effectively request-scoped. It is keyed by project root so a stale value can
 * never apply to a different workspace.
 */

import { normalize, resolve } from "node:path";

let activeDataDirByRoot: { projectRoot: string; dataDir: string } | null = null;

function key(projectRoot: string): string {
	return normalize(resolve(projectRoot));
}

/** Record the active workspace's data-dir override (called by the resolver). */
export function setActiveWorkspaceDataDir(projectRoot: string, dataDir: string | undefined): void {
	activeDataDirByRoot = dataDir ? { projectRoot: key(projectRoot), dataDir } : null;
}

/**
 * Data-dir override for `projectRoot`, or null when none was recorded for that
 * exact root. Returns null for any other root so a stale value cannot leak.
 */
export function getActiveWorkspaceDataDir(projectRoot: string): string | null {
	if (!activeDataDirByRoot) {
		return null;
	}
	return activeDataDirByRoot.projectRoot === key(projectRoot) ? activeDataDirByRoot.dataDir : null;
}

/** Test/teardown helper: clear any recorded override. */
export function clearActiveWorkspaceDataDir(): void {
	activeDataDirByRoot = null;
}
