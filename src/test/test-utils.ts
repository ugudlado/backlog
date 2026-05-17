/**
 * Test utilities for creating isolated test environments
 * Designed to handle Windows-specific file system quirks and prevent parallel test interference
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Core } from "../core/backlog.ts";
import { initializeProject as initializeProjectShared } from "../core/init.ts";

/**
 * Creates a unique test directory name to avoid conflicts in parallel execution
 * All test directories are created under tmp/ to keep the root directory clean
 */
export function createUniqueTestDir(prefix: string): string {
	const uuid = randomUUID().slice(0, 8); // Short UUID for readability
	const timestamp = Date.now().toString(36); // Base36 timestamp
	const pid = process.pid.toString(36); // Process ID for additional uniqueness
	return join(process.cwd(), "tmp", `${prefix}-${timestamp}-${pid}-${uuid}`);
}

/**
 * Sleep utility for tests that need to wait
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry utility for operations that might fail intermittently
 * Particularly useful for Windows file operations
 */
export async function retry<T>(fn: () => Promise<T>, maxAttempts = 3, delay = 100): Promise<T> {
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;
			if (attempt < maxAttempts) {
				await sleep(delay * attempt); // Exponential backoff
			}
		}
	}

	throw lastError || new Error("Retry failed");
}

/**
 * Windows-safe directory cleanup with retry logic
 * Windows can have file locking issues that prevent immediate deletion
 */
export async function safeCleanup(dir: string): Promise<void> {
	await retry(
		async () => {
			await rm(dir, { recursive: true, force: true });
		},
		5,
		50,
	); // More attempts for cleanup
}

/**
 * Detects if we're running on Windows (useful for conditional test behavior)
 */
export function isWindows(): boolean {
	return process.platform === "win32";
}

/**
 * Gets appropriate timeout for the current platform
 * Windows operations tend to be slower due to file system overhead
 */
export function getPlatformTimeout(baseTimeout = 5000): number {
	return isWindows() ? baseTimeout * 2 : baseTimeout;
}

/**
 * Gets the exit code from a spawnSync result, handling Windows quirks
 * On Windows, result.status can be undefined even for successful processes
 */
export function getExitCode(result: { status: number | null; error?: Error }): number {
	return result.status ?? (result.error ? 1 : 0);
}

/**
 * Shared test helper for project initialization.
 * Uses the same init path as CLI/web and optionally mirrors the legacy auto-commit behavior
 * needed by tests that assert against the post-init commit state.
 */
export async function initializeTestProject(
	core: Core,
	projectName: string,
	autoCommit = false,
	backlogDirectory?: string,
): Promise<void> {
	// Per the workspace-resolution-simplification model, `backlogDirectory`
	// (formerly backlog/.backlog/custom) maps to the workspace `data:` dir.
	await initializeProjectShared(core, {
		projectName,
		dataDir: backlogDirectory,
		integrationMode: "none",
		advancedConfig: {
			autoCommit: false,
		},
	});

	if (autoCommit) {
		// Under the per-repo workspace model the project config lives in the
		// machine config dir, not the repo, so `<repo>/<data>/` may contain only
		// empty dirs after init — git tracks no empty dirs, so a commit would be
		// empty and fail. Drop a `.gitkeep` so there is always something to stage
		// (mirrors the "post-init commit exists" state these tests assert).
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(core.filesystem.backlogDir, ".gitkeep"), "");
		const repoRoot = await core.gitOps.stageBacklogDirectory(core.filesystem.backlogDir);
		// Re-initialising the same repo produces no repo-tracked change under the
		// new model (config lives outside the repo, .gitkeep is already tracked),
		// so a commit would be empty and fail. Only commit if something is staged.
		const cwd = repoRoot ?? core.filesystem.rootDir;
		const staged = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd });
		if (staged.exitCode !== 0) {
			await core.gitOps.commitChanges(`backlog: Initialize backlog project: ${projectName}`, repoRoot);
		}
	}
}

/**
 * Low-level helper for tests that hand-roll a `backlog/` dir + `config.yml`
 * instead of going through {@link initializeTestProject}. Writes the per-repo
 * workspace yml so `resolveBacklogDirectory(repoPath)` resolves under the new
 * single-source-of-truth model.
 *
 * Writes into the active `BACKLOG_MACHINE_CONFIG_DIR` (the global test preload
 * isolates this away from the real `~/.config/backlog`).
 */
export async function seedTestWorkspace(
	repoPath: string,
	opts?: { data?: string; name?: string; projectName?: string; configBody?: string },
): Promise<string> {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const { resolve } = await import("node:path");
	const { getWorkspaceFilePath, workspaceNameForRepo, getWorkspacesDir } = await import("../utils/workspace-store.ts");
	const absRepo = resolve(repoPath);
	const data = resolve(opts?.data ?? join(absRepo, "backlog"));
	const name = (opts?.name ?? workspaceNameForRepo(absRepo)).replace(/\.ya?ml$/i, "");
	await mkdir(getWorkspacesDir(), { recursive: true });
	const filePath = getWorkspaceFilePath(name);
	// `repo:`/`data:` are the resolver's source of truth; the rest of the file
	// IS the project config (parsed by operations.ts parseConfig, which ignores
	// the repo/data keys). Tests that hand-roll a config pass it via configBody.
	const header = `repo: ${JSON.stringify(absRepo)}\ndata: ${JSON.stringify(data)}\n`;
	const body = opts?.configBody ?? `project_name: "${opts?.projectName ?? name}"\n`;
	await writeFile(filePath, header + (body.endsWith("\n") ? body : `${body}\n`), "utf8");
	return filePath;
}
