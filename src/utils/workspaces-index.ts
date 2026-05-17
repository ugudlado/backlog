import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import lockfile from "proper-lockfile";

/**
 * Machine-config directory + cross-process registry lock primitives.
 *
 * The old `workspaces.yml` index model (BACK-462/466) was removed by the
 * workspace-resolution-simplification change. Per-repo workspace files now
 * live in `<machineConfigDir>/workspaces/*.yml` (see `workspace-store.ts`).
 * Only the machine-config-dir resolution and the registry lock survive here,
 * since both are still shared by the new model.
 */

const writeLocks = new Map<string, Promise<void>>();
export async function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const prev = writeLocks.get(filePath) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((r) => {
		release = r;
	});
	writeLocks.set(
		filePath,
		prev.then(() => next),
	);
	await prev;
	try {
		return await fn();
	} finally {
		release();
		if (writeLocks.get(filePath) === next.then(() => undefined)) {
			writeLocks.delete(filePath);
		}
	}
}

// ─── Cross-process registry lock (mirrors withCreateLock in operations.ts) ───
// realpath:false (config dir may not exist yet), fixed stale constant, targets
// the machine config dir rather than a project backlog dir.

const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const REGISTRY_LOCK_STALE_MS = 10_000;
const REGISTRY_LOCK_RETRY_DELAY_MS = 100;

export const REGISTRY_LOCK_ERROR_CODE = "EREGISTRYLOCK";

function createRegistryLockError(message: string, cause?: unknown): Error {
	const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code?: string };
	error.name = "RegistryLockError";
	error.code = REGISTRY_LOCK_ERROR_CODE;
	return error;
}

export function isRegistryLockError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error as Error & { code?: string }).code === REGISTRY_LOCK_ERROR_CODE &&
		error.name === "RegistryLockError"
	);
}

export function getRegistryLockPath(machineConfigDir: string): string {
	return join(machineConfigDir, ".locks", "workspaces");
}

export async function withRegistryLock<T>(
	fn: () => Promise<T>,
	options?: { timeoutMs?: number; machineConfigDir?: string },
): Promise<T> {
	const configDir = getMachineConfigDir(options?.machineConfigDir);
	const locksDir = join(configDir, ".locks");
	const lockPath = getRegistryLockPath(configDir);
	const timeoutMs = options?.timeoutMs ?? REGISTRY_LOCK_TIMEOUT_MS;
	const retryDelayMs = REGISTRY_LOCK_RETRY_DELAY_MS;
	const retries = Math.max(Math.ceil(timeoutMs / retryDelayMs) - 1, 0);

	await mkdir(locksDir, { recursive: true });

	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(configDir, {
			lockfilePath: lockPath,
			realpath: false,
			stale: REGISTRY_LOCK_STALE_MS,
			retries: {
				retries,
				factor: 1,
				minTimeout: retryDelayMs,
				maxTimeout: retryDelayMs,
				randomize: false,
			},
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ELOCKED") {
			throw createRegistryLockError(
				`EREGISTRYLOCK: Registry lock timed out after ${timeoutMs}ms (path: ${lockPath})`,
				error,
			);
		}
		if (code === "ECOMPROMISED") {
			throw createRegistryLockError("Registry lock was interrupted. Please try again.", error);
		}
		throw error;
	}

	try {
		const result = await fn();
		try {
			await release?.();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ELOCKED" || code === "ECOMPROMISED") {
				throw createRegistryLockError("Registry lock release failed.", error);
			}
			throw error;
		}
		return result;
	} catch (error) {
		if (release) {
			try {
				await release();
			} catch {
				// Preserve the original operation error if lock cleanup also fails.
			}
		}
		throw error;
	}
}

/** User-level machine config (BACK-462). */
export const MACHINE_CONFIG_DIR_NAME = "backlog";

/**
 * Resolves the machine-wide config directory. Precedence:
 *   1. explicit `override` argument (callers like `BacklogServer` pass this through),
 *   2. `BACKLOG_MACHINE_CONFIG_DIR` env var,
 *   3. `~/.config/backlog` default.
 */
export function getMachineConfigDir(override?: string): string {
	if (override) {
		return normalize(resolve(override));
	}
	const envOverride = process.env.BACKLOG_MACHINE_CONFIG_DIR?.trim();
	if (envOverride) {
		return normalize(resolve(envOverride));
	}
	return join(homedir(), ".config", MACHINE_CONFIG_DIR_NAME);
}

export async function pathExistsAsDirectory(p: string): Promise<boolean> {
	try {
		const s = await stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}

/** Resolve to absolute normalized path (no trailing sep). */
export function toAbsoluteProjectRoot(p: string): string {
	return normalize(resolve(p));
}
