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
 * Initialize a git repo for tests without copying husky hooks from the dev environment.
 */
export async function initTestGitRepo(target: string | { cwd: string; branch?: string }): Promise<void> {
	const { mkdirSync } = await import("node:fs");
	const { $ } = await import("bun");
	const env = { ...process.env, HUSKY: "0" };
	const templateDir = join(process.cwd(), "tmp", "empty-git-template");
	mkdirSync(templateDir, { recursive: true });

	if (typeof target === "string") {
		await $`git init --template=${templateDir} -b main ${target}`.env(env).quiet();
		await $`git -C ${target} config user.email test@example.com`.env(env).quiet();
		await $`git -C ${target} config user.name Test`.env(env).quiet();
		return;
	}

	const branch = target.branch ?? "main";
	await $`git init --template=${templateDir} -b ${branch}`.cwd(target.cwd).env(env).quiet();
	await $`git config user.email test@example.com`.cwd(target.cwd).env(env).quiet();
	await $`git config user.name Test`.cwd(target.cwd).env(env).quiet();
}

/**
 * Backlog stores tasks in a configured global store. Tests that run `backlog
 * init` need one. This writes an isolated machine-config dir with `globalStore`
 * set under `parentDir` and returns the dir plus an env object to pass to CLI
 * subprocesses (`.env(globalStoreEnv(...))`). For in-process callers, set
 * `process.env.BACKLOG_MACHINE_CONFIG_DIR` to the returned dir.
 */
export async function createTestGlobalStore(
	parentDir: string,
): Promise<{ machineConfigDir: string; globalStoreDir: string; env: Record<string, string> }> {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const machineConfigDir = join(parentDir, ".bl-machine-config");
	const globalStoreDir = join(parentDir, ".bl-global-store");
	await mkdir(machineConfigDir, { recursive: true });
	await mkdir(globalStoreDir, { recursive: true });
	await writeFile(join(machineConfigDir, "config.yml"), `globalStore: ${globalStoreDir}\n`);
	return {
		machineConfigDir,
		globalStoreDir,
		env: { ...process.env, BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir } as Record<string, string>,
	};
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
 * Shared test helper for in-process project initialization (default `backlog/`
 * layout). Uses the same init path as CLI/web.
 */
export async function initializeTestProject(core: Core, projectName: string): Promise<void> {
	await initializeProjectShared(core, {
		projectName,
		integrationMode: "none",
	});
}

/**
 * Sets up an isolated global store under `parentDir`, creates a project slot in
 * it, and marks it current. This is how CLI subprocess tests get a project the
 * `backlog` binary can resolve (projects are discovered by scanning the global
 * store; resolution keys off the `current` pointer).
 *
 * Returns:
 *  - `projectRoot`: the slot path — use as `.cwd()` for the CLI subprocess.
 *  - `core`: a slot-aware `Core` for in-process assertions. A plain
 *    `new Core(projectRoot)` would resolve `<slot>/backlog/`, but a global-store
 *    slot stores tasks flat at `<slot>/tasks/`, so callers MUST use this `core`
 *    (it has `setGlobalStoreSlot` applied) rather than constructing their own.
 *  - `env`: pass to the subprocess via `.env(env)` so it reads the isolated
 *    machine config (globalStore + current pointer) instead of the real one.
 *  - `machineConfigDir` / `globalStoreDir`: for tests that need the paths.
 *
 * IMPORTANT: also sets `process.env.BACKLOG_MACHINE_CONFIG_DIR` so in-process
 * readers in the same test resolve against the isolated config.
 */
export async function initializeGlobalTestProject(
	parentDir: string,
	projectName: string,
): Promise<{
	projectRoot: string;
	core: Core;
	env: Record<string, string>;
	machineConfigDir: string;
	globalStoreDir: string;
}> {
	const { $ } = await import("bun");
	const { Core } = await import("../core/backlog.ts");
	const { clearMachineConfigCache } = await import("../utils/machine-config.ts");
	const { machineConfigDir, globalStoreDir, env } = await createTestGlobalStore(parentDir);

	// Point in-process readers at the isolated machine config and drop any cached
	// reading of the real/default config so globalStore resolves to our temp dir.
	process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
	clearMachineConfigCache();

	// Run the real CLI init so the slot is created and made current EXACTLY as in
	// production (a global-store slot named by the project name). The slot is both
	// project root and data dir; subsequent CLI commands resolve it via `current`.
	const CLI_PATH = join(process.cwd(), "src", "cli.ts");
	const res = await $`bun ${[CLI_PATH, "init", projectName, "--defaults"]}`.env(env).quiet().nothrow();
	if (res.exitCode !== 0) {
		throw new Error(`Test global init failed: ${res.stderr.toString() || res.stdout.toString()}`);
	}
	const slotPath = join(globalStoreDir, projectName);

	// A slot-aware Core: tasks live flat at <slot>/tasks/, not <slot>/backlog/.
	const core = new Core(slotPath);
	core.filesystem.setGlobalStoreSlot(slotPath, projectName);

	return { projectRoot: slotPath, core, env, machineConfigDir, globalStoreDir };
}
