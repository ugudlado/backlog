import { resolveBacklogDirectory } from "./backlog-directory.ts";

/**
 * Resolves the Backlog.md project root for the given directory.
 *
 * Resolution is no longer a filesystem walk-up: the new model looks the cwd up
 * against the per-repo workspace registry (deepest `repo:` prefix match, then
 * the `current:` workspace). Returns the matched `repo:` path, or null when no
 * workspace resolves.
 *
 * @param startDir - The directory to resolve from (typically process.cwd())
 * @returns The project root path, or null if no Backlog.md workspace resolves
 */
export async function findBacklogRoot(startDir: string): Promise<string | null> {
	const resolution = resolveBacklogDirectory(startDir);
	return resolution.configPath ? resolution.projectRoot : null;
}

// Cache for the project root within a single CLI execution
let cachedProjectRoot: string | null | undefined;

/**
 * Gets the Backlog.md project root, with caching for performance.
 * Call clearProjectRootCache() to reset the cache if needed.
 */
export async function getProjectRoot(startDir: string): Promise<string | null> {
	if (cachedProjectRoot !== undefined) {
		return cachedProjectRoot;
	}

	cachedProjectRoot = await findBacklogRoot(startDir);
	return cachedProjectRoot;
}

/**
 * Clears the cached project root. Useful for testing.
 */
export function clearProjectRootCache(): void {
	cachedProjectRoot = undefined;
}
