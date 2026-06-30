import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/**
 * The active-project pointer (`current:`) now lives in the machine config.yml
 * alongside globalStore/backlog_url/tokens, rather than in its own file. On
 * first access the legacy `projects.yml` (and its predecessor `workspaces.yml`)
 * is folded in and removed.
 */
export const PROJECTS_FILE = "config.yml";
/** Legacy standalone pointer files, folded into config.yml on first access. */
const LEGACY_PROJECTS_FILES = ["projects.yml", "workspaces.yml"] as const;

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
	return join(getMachineConfigDir(override), PROJECTS_FILE);
}

/**
 * Best-effort one-time fold-in: if config.yml has no `current:` but a legacy
 * standalone pointer file does, copy that pointer into config.yml and delete
 * the legacy file. Runs on read so existing installs don't lose their active
 * project on upgrade. Failures are swallowed — the pointer is a cache.
 */
function migrateLegacyPointer(dir: string): void {
	const target = join(dir, PROJECTS_FILE);
	let configText = "";
	try {
		configText = readFileSync(target, "utf8");
	} catch {
		// config.yml may not exist yet; treat as empty.
	}
	if (/^\s*current\s*:/m.test(configText)) return; // already has a pointer

	for (const name of LEGACY_PROJECTS_FILES) {
		const legacy = join(dir, name);
		if (!existsSync(legacy)) continue;
		try {
			const legacyCurrent = parseProjectsYaml(readFileSync(legacy, "utf8")).current;
			if (legacyCurrent) {
				writeFileSync(target, setCurrentLine(configText, legacyCurrent), "utf8");
			}
			rmSync(legacy, { force: true });
			return; // first existing legacy file wins
		} catch {
			// Leave the legacy file in place; nothing was lost.
		}
	}
}

/**
 * Minimal YAML reader for the machine config.yml. Only the `current:` pointer is read;
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
 * Surgically sets (or clears) the `current:` pointer in raw config.yml text,
 * leaving every other line — comments, blank lines, unrelated keys — byte-for-byte
 * untouched. Used instead of a parse-and-reserialize so the user's hand-edited
 * machine config (globalStore, tokens, …) survives a project switch.
 *
 * - `id` set: replace an existing top-level `current:` line, or append one.
 * - `id` undefined/empty: remove any existing `current:` line.
 */
export function setCurrentLine(content: string, id: string | undefined): string {
	const currentRe = /^[ \t]*current[ \t]*:.*$/m;
	if (!id) {
		// Drop the line (and a trailing newline) if present.
		return content.replace(/^[ \t]*current[ \t]*:.*(?:\r?\n)?/m, "");
	}
	const line = `current: ${quoteYamlPath(id)}`;
	if (currentRe.test(content)) {
		return content.replace(currentRe, line);
	}
	if (content.length === 0) {
		return `${line}\n`;
	}
	return content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`;
}

function quoteYamlPath(p: string): string {
	if (/[#:[\]{}",*?&!%@`|>]/.test(p) || p.includes("\n")) {
		return JSON.stringify(p);
	}
	return p;
}

export async function readProjectsIndex(override?: string): Promise<ProjectsIndex> {
	const dir = getMachineConfigDir(override);
	migrateLegacyPointer(dir);
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
	// Read-modify-write: preserve every other key/comment in config.yml and only
	// touch the `current:` line. Falls back to empty text if config.yml is absent.
	let existing = "";
	try {
		existing = await readFile(filePath, "utf8");
	} catch (e) {
		const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
		if (code !== "ENOENT") throw e;
	}
	const next = setCurrentLine(existing, index.current);
	if (next === existing) return; // no-op; don't churn the file
	// Atomic write: a kill mid-write leaves the tmp file behind but never a
	// truncated config.yml.
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, next, "utf8");
	await rename(tmpPath, filePath);
}

/**
 * Ensures the machine `config.yml` exists when missing, seeding it with a header
 * comment. Idempotent — an existing config (and any `current:` pointer in it) is
 * left untouched.
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
	const dir = getMachineConfigDir(override);
	await mkdir(dir, { recursive: true });
	await writeFile(filePath, "# Backlog.md machine config\n", "utf8");
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
