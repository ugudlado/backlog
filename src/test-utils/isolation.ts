/**
 * Helpers for in-process test isolation.
 *
 * Usage (beforeEach / afterEach):
 *
 *   let cleanup: () => void;
 *
 *   beforeEach(async () => {
 *     cleanup = await setupMachineConfig();
 *   });
 *
 *   afterEach(() => cleanup());
 *
 * Or for a single test:
 *
 *   await using env = withEnvVars({ BACKLOG_MACHINE_CONFIG_DIR: dir });
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMachineConfigCache } from "../utils/machine-config.ts";

/**
 * Temporarily overrides one or more environment variables for the duration of
 * a test, restoring the original values on cleanup.
 *
 * Returns a cleanup function — call it in afterEach or use `await using`.
 */
export function withEnvVars(vars: Record<string, string | undefined>): () => void {
	const saved: Record<string, string | undefined> = {};

	for (const [key, value] of Object.entries(vars)) {
		saved[key] = process.env[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	clearMachineConfigCache();

	return () => {
		for (const [key, orig] of Object.entries(saved)) {
			if (orig === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = orig;
			}
		}
		clearMachineConfigCache();
	};
}

export interface MachineConfigSetup {
	/** Directory that BACKLOG_MACHINE_CONFIG_DIR points to. */
	machineConfigDir: string;
	/** Remove temp dirs and restore env. */
	cleanup: () => Promise<void>;
}

/**
 * Creates an isolated temp machine config dir, points
 * BACKLOG_MACHINE_CONFIG_DIR at it, and returns an async cleanup that deletes
 * the temp dir and restores env.
 *
 * The per-repo workspace model has no machine-level settings to seed (only
 * `current:`, which tests write via `setCurrentWorkspaceName`), so this just
 * provides an empty isolated registry.
 *
 * @example
 *   let setup: MachineConfigSetup;
 *   beforeEach(async () => { setup = await setupMachineConfig(); });
 *   afterEach(async () => { await setup.cleanup(); });
 */
export async function setupMachineConfig(): Promise<MachineConfigSetup> {
	const base = await mkdtemp(join(tmpdir(), "backlog-test-"));
	const machineConfigDir = join(base, "machine-config");
	await mkdir(machineConfigDir, { recursive: true });

	const restoreEnv = withEnvVars({ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir });

	return {
		machineConfigDir,
		cleanup: async () => {
			restoreEnv();
			await rm(base, { recursive: true, force: true });
		},
	};
}
