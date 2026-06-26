import { existsSync, renameSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { resolveBacklogDirectory } from "./backlog-directory.ts";
import { findBacklogRoot } from "./find-backlog-root.ts";

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

export interface ProjectEntry {
	path: string;
	/**
	 * Optional override for where this workspace's `backlog/` data lives.
	 * Absolute, or relative to `path`. When unset, data resolves to
	 * `<path>/backlog/` as before.
	 */
	data?: string;
	id?: string;
}

export interface ProjectsIndex {
	projects: ProjectEntry[];
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

function isProjectEntry(value: unknown): value is ProjectEntry {
	if (!value || typeof value !== "object") {
		return false;
	}
	const o = value as Record<string, unknown>;
	return typeof o.path === "string";
}

/**
 * Minimal YAML reader for projects.yml (list of path objects).
 * Legacy `type:` field is accepted but discarded (back-compat with pre-BACK-466 files).
 */
export function parseProjectsYaml(content: string): ProjectsIndex {
	const lines = content.split(/\r?\n/);
	const projects: ProjectEntry[] = [];
	let inList = false;
	let current: Partial<ProjectEntry> | null = null;
	let currentId: string | undefined;

	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		if (!inList && line.startsWith("current:")) {
			currentId = stripYamlQuotes(line.slice("current:".length).trim()) || undefined;
			continue;
		}
		// Accept both the current `projects:` key and the legacy `workspaces:`
		// key (files migrated from before the rename still carry the old key).
		if (line.startsWith("projects:") || line.startsWith("workspaces:")) {
			inList = true;
			continue;
		}
		if (!inList) {
			continue;
		}
		if (line.startsWith("- ")) {
			if (isProjectEntry(current)) {
				projects.push(toEntry(current));
			}
			current = {};
			const rest = line.slice(2).trim();
			const pathMatch = /^path:\s*(.+)$/.exec(rest);
			if (pathMatch?.[1]) {
				current.path = stripYamlQuotes(pathMatch[1].trim());
			}
			const idMatch = /^id:\s*(.+)$/.exec(rest);
			if (idMatch?.[1]) {
				current.id = stripYamlQuotes(idMatch[1].trim());
			}
			const dataMatch = /^data:\s*(.+)$/.exec(rest);
			if (dataMatch?.[1]) {
				current.data = stripYamlQuotes(dataMatch[1].trim());
			}
			continue;
		}
		if (line.startsWith("path:")) {
			if (!current) {
				current = {};
			}
			current.path = stripYamlQuotes(line.slice("path:".length).trim());
			continue;
		}
		if (line.startsWith("data:")) {
			if (!current) {
				current = {};
			}
			current.data = stripYamlQuotes(line.slice("data:".length).trim());
			continue;
		}
		if (line.startsWith("id:")) {
			if (!current) {
				current = {};
			}
			current.id = stripYamlQuotes(line.slice("id:".length).trim());
		}
		// Legacy `type:` lines are intentionally ignored (back-compat).
	}
	if (isProjectEntry(current)) {
		projects.push(toEntry(current));
	}
	const out: ProjectsIndex = { projects };
	if (currentId) {
		out.current = currentId;
	}
	return out;
}

function toEntry(c: Partial<ProjectEntry>): ProjectEntry {
	const e: ProjectEntry = { path: c.path as string };
	if (c.data) {
		e.data = c.data;
	}
	if (c.id) {
		e.id = c.id;
	}
	return e;
}

function stripYamlQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

/**
 * Writes projects.yml with a stable, comment-header format.
 */
export function serializeProjectsYaml(index: ProjectsIndex): string {
	const header = `# Backlog.md workspace index (machine-wide)
# path: project root. data: optional override for where backlog/ data lives
# (absolute or relative to path; defaults to <path>/backlog when unset).
`;
	const bodyLines: string[] = [];
	if (index.current) {
		bodyLines.push(`current: ${quoteYamlPath(index.current)}`);
	}
	bodyLines.push("projects:");
	for (const w of index.projects) {
		bodyLines.push(`  - path: ${quoteYamlPath(w.path)}`);
		if (w.data) {
			bodyLines.push(`    data: ${quoteYamlPath(w.data)}`);
		}
		if (w.id) {
			bodyLines.push(`    id: ${quoteYamlPath(w.id)}`);
		}
	}
	return `${header}\n${bodyLines.join("\n")}\n`;
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
			return { projects: [] };
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
 * Ensures `<machine-config-dir>/projects.yml` exists with an empty projects
 * list when missing. Idempotent — keeps existing entries untouched.
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
	await writeProjectsIndex({ projects: [] }, override);
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

function pathIsUnderAncestor(ancestor: string, descendant: string): boolean {
	const a = normalize(resolve(ancestor)) + sep;
	const d = normalize(resolve(descendant));
	return d === a.slice(0, -1) || d.startsWith(a);
}

function backlogConfiguredAtProjectRoot(projectRoot: string): boolean {
	const r = resolveBacklogDirectory(projectRoot);
	return Boolean(r.configPath);
}

/**
 * An entry is a usable backlog project if config resolves at its project
 * root, OR — for a `data:` entry — at the data location (where config lives
 * for a data-overridden workspace). Without this, cwd matching would reject
 * every `data:` workspace because `<repo>/backlog` is intentionally absent.
 */
function entryHasBacklogConfig(e: ProjectEntry): boolean {
	if (e.data) {
		const dataDir = isAbsolute(e.data) ? e.data : resolve(toAbsoluteProjectRoot(e.path), e.data);
		return existsSync(join(dataDir, "config.yml"));
	}
	return backlogConfiguredAtProjectRoot(toAbsoluteProjectRoot(e.path));
}

export function findProjectsMatchingCwd(cwd: string, entries: ProjectEntry[]): ProjectEntry[] {
	const matches: ProjectEntry[] = [];
	const absCwd = normalize(resolve(cwd));
	for (const e of entries) {
		const root = toAbsoluteProjectRoot(e.path);
		if (pathIsUnderAncestor(root, absCwd) && entryHasBacklogConfig(e)) {
			matches.push(e);
		}
	}
	return matches;
}

/**
 * Match a path or short label to an index entry: absolute path, or unique basename / relative match.
 */
export function resolveProjectSelector(selector: string, entries: ProjectEntry[]): ProjectEntry | null {
	const trimmed = selector.trim();
	if (!trimmed) {
		return null;
	}
	const abs = normalize(resolve(trimmed));
	const direct = entries.find((e) => toAbsoluteProjectRoot(e.path) === abs);
	if (direct) {
		return direct;
	}
	const byTail = entries.filter((e) => {
		const base = e.path.split(/[/\\]/).filter(Boolean).pop();
		return base === trimmed;
	});
	if (byTail.length === 1) {
		return byTail[0] ?? null;
	}
	const relCandidates = entries.filter((e) => {
		try {
			const rel = relative(toAbsoluteProjectRoot(e.path), abs);
			return rel === "" || (!rel.startsWith("..") && !normalize(rel).startsWith(".."));
		} catch {
			return false;
		}
	});
	if (relCandidates.length === 1) {
		return relCandidates[0] ?? null;
	}
	return null;
}

export async function upsertProjectEntry(entry: ProjectEntry, override?: string): Promise<void> {
	const filePath = getProjectsFilePath(override);
	await withRegistryLock(
		async () => {
			await withWriteLock(filePath, async () => {
				const index = await readProjectsIndex(override);
				const absPath = toAbsoluteProjectRoot(entry.path);
				const existing = index.projects.find((e) => toAbsoluteProjectRoot(e.path) === absPath);
				// Preserve an existing `data:` override unless the caller explicitly
				// sets one. Spread order alone would only do this by accident of the
				// caller omitting `data` — make it intentional.
				const merged: ProjectEntry = { ...existing, ...entry, path: absPath };
				if (entry.data === undefined && existing?.data !== undefined) {
					merged.data = existing.data;
				}
				const next = index.projects.filter((e) => toAbsoluteProjectRoot(e.path) !== absPath);
				next.push(merged);
				next.sort((a, b) => a.path.localeCompare(b.path));
				await writeProjectsIndex({ ...index, projects: next }, override);
			});
		},
		{ machineConfigDir: override },
	);
}

/**
 * Sets the `current` pointer to the given workspace id. The id must already
 * exist in the index — caller is responsible for ensuring the entry was
 * upserted first. Pass `null` to clear.
 */
export async function setCurrentProjectId(id: string | null, override?: string): Promise<void> {
	const filePath = getProjectsFilePath(override);
	await withRegistryLock(
		async () => {
			await withWriteLock(filePath, async () => {
				const index = await readProjectsIndex(override);
				if (id !== null && !index.projects.some((e) => e.id === id)) {
					// Not a registry (local-mode) workspace — allow it only if it is a
					// global-store project (discovered by scanning <globalStore>/*),
					// which legitimately has no registry entry.
					const { scanGlobalStoreProjects } = await import("./global-store-scan.ts");
					const isGlobal = (await scanGlobalStoreProjects()).some((p) => p.id === id);
					if (!isGlobal) {
						throw new Error(`No workspace with id "${id}" in registry`);
					}
				}
				const next: ProjectsIndex = { ...index, projects: index.projects };
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

export async function removeProjectEntry(projectRoot: string, override?: string): Promise<boolean> {
	const filePath = getProjectsFilePath(override);
	return withRegistryLock(
		async () => {
			return withWriteLock(filePath, async () => {
				const index = await readProjectsIndex(override);
				const absPath = toAbsoluteProjectRoot(projectRoot);
				const filtered = index.projects.filter((e) => toAbsoluteProjectRoot(e.path) !== absPath);
				if (filtered.length === index.projects.length) {
					return false;
				}
				const removed = index.projects.find((e) => toAbsoluteProjectRoot(e.path) === absPath);
				const next: ProjectsIndex = { ...index, projects: filtered };
				if (next.current && removed?.id && next.current === removed.id) {
					delete next.current;
				}
				await writeProjectsIndex(next, override);
				return true;
			});
		},
		{ machineConfigDir: override },
	);
}

export async function autoRegisterDiscoveredRepo(projectRoot: string): Promise<void> {
	if (!backlogConfiguredAtProjectRoot(projectRoot)) {
		return;
	}
	// Dynamic import to avoid a static cycle (workspace-registration imports from this file).
	const { registerWorkspaceAtPath } = await import("./workspace-registration.ts");
	try {
		await registerWorkspaceAtPath(projectRoot);
	} catch {
		// Best-effort during legacy walk-up; skip silently if the project config
		// can't be loaded — the entry can still be registered explicitly later.
	}
}

export type ResolveCliProjectRootResult =
	| { ok: true; projectRoot: string; dataDir?: string }
	| { ok: false; kind: "not_found" }
	| { ok: false; kind: "ambiguous"; paths: string[] };

/**
 * Resolve an entry's `data:` override to an absolute data directory.
 * Absolute → used as-is. Relative → resolved against the project root.
 * Unset → undefined (consumer falls back to `<projectRoot>/backlog`).
 */
function resolveEntryDataDir(entry: ProjectEntry, projectRoot: string): string | undefined {
	if (!entry.data) {
		return undefined;
	}
	return normalize(isAbsolute(entry.data) ? entry.data : resolve(projectRoot, entry.data));
}

function resolveRegisteredWorkspacesOnly(cwd: string, index: ProjectsIndex): ResolveCliProjectRootResult {
	const cwdMatches = findProjectsMatchingCwd(cwd, index.projects);
	if (cwdMatches.length > 1) {
		return {
			ok: false,
			kind: "ambiguous",
			paths: cwdMatches.map((e) => toAbsoluteProjectRoot(e.path)),
		};
	}
	if (cwdMatches.length === 1) {
		const only = cwdMatches[0];
		if (!only) {
			return { ok: false, kind: "not_found" };
		}
		const root = toAbsoluteProjectRoot(only.path);
		return { ok: true, projectRoot: root, dataDir: resolveEntryDataDir(only, root) };
	}

	return { ok: false, kind: "not_found" };
}

/**
 * Web UI startup: project root comes only from the machine workspace index.
 * Legacy walk-up and global workspace fallback are intentionally omitted — see
 * `backlog browser` for registration/init.
 */
export async function resolveBrowserProjectRoot(cwd: string): Promise<ResolveCliProjectRootResult> {
	const index = await readProjectsIndex();
	return resolveRegisteredWorkspacesOnly(cwd, index);
}

/**
 * Resolves the Backlog project root for CLI commands.
 *
 * Order: cwd-registered match(es) → legacy walk-up discovery (with auto-register).
 * (BACK-466 removed the `type: global` fallback along with the `--global` flag.)
 */
export async function resolveCliProjectRoot(cwd: string, projectName?: string): Promise<ResolveCliProjectRootResult> {
	const index = await readProjectsIndex();

	// Global-store resolution (the primary model): an explicit `--project <name>`
	// wins, else the `current` pointer. The slot is both project root and data
	// dir. Repos are not tagged to projects — selection is by name/current.
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
			return { ok: true, projectRoot: slot.slotPath, dataDir: slot.slotPath };
		}
	}

	// Fallback: in-repo (local-mode) resolution via cwd match or walk-up. Kept so
	// local projects and the existing test suite keep working when no global
	// store is configured.
	const registered = resolveRegisteredWorkspacesOnly(cwd, index);
	if (registered.ok || registered.kind === "ambiguous") {
		return registered;
	}

	const legacy = await findBacklogRoot(cwd);
	if (legacy) {
		await autoRegisterDiscoveredRepo(legacy);
		return { ok: true, projectRoot: toAbsoluteProjectRoot(legacy) };
	}

	return { ok: false, kind: "not_found" };
}
