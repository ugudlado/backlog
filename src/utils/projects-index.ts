import { existsSync, renameSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import lockfile from "proper-lockfile";

/**
 * In-process serialization for read-modify-write sequences against
 * workspaces.yml. Cross-process safety is provided by the atomic
 * write below (rename(2) is atomic on POSIX); this mutex prevents
 * the same Bun process from racing two `upsertProjectEntry` calls
 * against each other when the web server fields concurrent requests.
 *
 * Keyed by absolute file path so distinct `override` targets (used in
 * tests) don't share a lock.
 */
const writeLocks = new Map<string, Promise<void>>();
async function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
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
// Shape mirrors withCreateLock; diverges intentionally: realpath:false (config dir may not exist yet),
// stale is a fixed constant (no per-call override), and it targets the machine config dir, not a project backlog dir.

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
export const PROJECTS_FILE = "projects.yml";
/** Legacy filename, migrated to PROJECTS_FILE on first access. */
const LEGACY_PROJECTS_FILE = "workspaces.yml";

export interface ProjectsIndex {
	/** The active project's id. Projects are discovered by scanning the global store. */
	current?: string;
}

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

export function getProjectsFilePath(override?: string): string {
	const dir = getMachineConfigDir(override);
	const target = join(dir, PROJECTS_FILE);
	// One-time migration: if only the legacy workspaces.yml exists, rename it.
	// This is a pointer/cache file, so a best-effort rename is safe.
	if (!existsSync(target)) {
		const legacy = join(dir, LEGACY_PROJECTS_FILE);
		if (existsSync(legacy)) {
			try {
				renameSync(legacy, target);
			} catch {
				// If the rename fails, fall through; the file will be recreated.
			}
		}
	}
	return target;
}

/**
 * Minimal YAML reader for projects.yml. Only the `current:` pointer is read;
 * any legacy `projects:`/`workspaces:` list lines from older files are ignored
 * (projects are now discovered by scanning the global store).
 */
export function parseProjectsYaml(content: string): ProjectsIndex {
	const lines = content.split(/\r?\n/);
	let currentId: string | undefined;

	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		if (line.startsWith("current:")) {
			currentId = stripYamlQuotes(line.slice("current:".length).trim()) || undefined;
		}
		// Everything else (legacy projects:/workspaces: list lines) is ignored.
	}
	return currentId ? { current: currentId } : {};
}

function stripYamlQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

/**
 * Writes projects.yml with a stable, comment-header format. Only the active
 * project pointer is persisted; projects are discovered by scanning the store.
 */
export function serializeProjectsYaml(index: ProjectsIndex): string {
	const header = "# Backlog.md machine-wide pointer to the active project.\n";
	const body = index.current ? `current: ${quoteYamlPath(index.current)}\n` : "";
	return `${header}\n${body}`;
}

function quoteYamlPath(p: string): string {
	if (/[#:[\]{}",*?&!%@`|>]/.test(p) || p.includes("\n")) {
		return JSON.stringify(p);
	}
	return p;
}

export async function readProjectsIndex(override?: string): Promise<ProjectsIndex> {
	const filePath = getProjectsFilePath(override);
	try {
		const content = await readFile(filePath, "utf8");
		return parseProjectsYaml(content);
	} catch (e) {
		const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
		if (code === "ENOENT") {
			return {};
		}
		throw e;
	}
}

export async function writeProjectsIndex(index: ProjectsIndex, override?: string): Promise<void> {
	const dir = getMachineConfigDir(override);
	await mkdir(dir, { recursive: true });
	const filePath = getProjectsFilePath(override);
	// Atomic write: a kill mid-write leaves the tmp file behind but never a
	// truncated projects.yml that the parser would silently treat as empty.
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, serializeProjectsYaml(index), "utf8");
	await rename(tmpPath, filePath);
}

/**
 * Ensures `<machine-config-dir>/projects.yml` exists when missing.
 * Idempotent — keeps an existing `current` pointer untouched.
 */
export async function ensureProjectsFileExists(override?: string): Promise<void> {
	const filePath = getProjectsFilePath(override);
	try {
		await readFile(filePath, "utf8");
		return;
	} catch (e) {
		const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
		if (code !== "ENOENT") {
			throw e;
		}
	}
	await writeProjectsIndex({}, override);
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

/**
 * Sets the `current` pointer to the given project id (discovered by scanning
 * the global store). Pass `null` to clear.
 */
export async function setCurrentProjectId(id: string | null, override?: string): Promise<void> {
	const filePath = getProjectsFilePath(override);
	await withRegistryLock(
		async () => {
			await withWriteLock(filePath, async () => {
				const index = await readProjectsIndex(override);
				if (id !== null) {
					const { scanGlobalStoreProjects } = await import("./global-store-scan.ts");
					const isGlobal = (await scanGlobalStoreProjects()).some((p) => p.id === id);
					if (!isGlobal) {
						throw new Error(`No project with id "${id}" in the global store`);
					}
				}
				const next: ProjectsIndex = { ...index };
				if (id) {
					next.current = id;
				} else {
					delete next.current;
				}
				await writeProjectsIndex(next, override);
			});
		},
		{ machineConfigDir: override },
	);
}

export type ResolveCliProjectRootResult =
	| { ok: true; projectRoot: string; dataDir?: string; projectName?: string; viaGlobalCurrent?: boolean }
	| { ok: false; kind: "not_found" };

/**
 * Resolves the Backlog project root from the global store.
 *
 * An explicit `--project <name>` wins; otherwise the `current` pointer (or the
 * first scanned slot). Projects are discovered by scanning <globalStore>/*; the
 * slot is both project root and data dir.
 */
export async function resolveCliProjectRoot(_cwd: string, projectName?: string): Promise<ResolveCliProjectRootResult> {
	const index = await readProjectsIndex();
	const { scanGlobalStoreProjects } = await import("./global-store-scan.ts");
	const scanned = await scanGlobalStoreProjects();
	if (projectName) {
		const slot = scanned.find((p) => p.name === projectName || p.id === projectName);
		if (!slot) {
			return { ok: false, kind: "not_found" };
		}
		return { ok: true, projectRoot: slot.slotPath, dataDir: slot.slotPath };
	}
	if (scanned.length > 0) {
		const slot = scanned.find((p) => p.id === index.current) ?? scanned[0];
		if (slot) {
			return {
				ok: true,
				projectRoot: slot.slotPath,
				dataDir: slot.slotPath,
				projectName: slot.name,
				viaGlobalCurrent: true,
			};
		}
	}

	return { ok: false, kind: "not_found" };
}
