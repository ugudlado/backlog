/**
 * Helpers for in-process test isolation.
 *
 * Usage (beforeEach / afterEach):
 *
 *   let cleanup: () => void;
 *
 *   beforeEach(async () => {
 *     cleanup = await setupMachineConfig({ globalStore: myDir });
 *   });
 *
 *   afterEach(() => cleanup());
 *
 * Or for a single test:
 *
 *   await using env = withEnvVars({ BACKLOG_MACHINE_CONFIG_DIR: dir });
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	/** globalStore directory (only set when globalStore was configured). */
	globalStoreDir: string | null;
	/** Remove temp dirs and restore env. */
	cleanup: () => Promise<void>;
}

/**
 * Creates a temp machine config dir (and optional globalStore dir), writes
 * config.yml, sets BACKLOG_MACHINE_CONFIG_DIR, and clears the cache.
 *
 * Returns dirs and an async cleanup that deletes temp dirs and restores env.
 *
 * @example
 *   let setup: MachineConfigSetup;
 *   beforeEach(async () => { setup = await setupMachineConfig({ globalStore: true }); });
 *   afterEach(async () => { await setup.cleanup(); });
 */
export async function setupMachineConfig(options?: {
	/** Pass true to create a temp globalStore dir; pass a string to use a specific path. */
	globalStore?: boolean | string;
}): Promise<MachineConfigSetup> {
	const base = await mkdtemp(join(tmpdir(), "backlog-test-"));
	const machineConfigDir = join(base, "machine-config");
	await mkdir(machineConfigDir, { recursive: true });

	let globalStoreDir: string | null = null;
	let configContent = "";

	if (options?.globalStore) {
		if (typeof options.globalStore === "string") {
			globalStoreDir = options.globalStore;
		} else {
			globalStoreDir = join(base, "global-store");
			await mkdir(globalStoreDir, { recursive: true });
		}
		configContent = `globalStore: ${globalStoreDir}\n`;
	}

	await writeFile(join(machineConfigDir, "config.yml"), configContent);

	const restoreEnv = withEnvVars({ BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir });

	return {
		machineConfigDir,
		globalStoreDir,
		cleanup: async () => {
			restoreEnv();
			await rm(base, { recursive: true, force: true });
		},
	};
}
