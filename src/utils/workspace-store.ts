import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, normalize, resolve, sep } from "node:path";
import { getMachineConfigDir, withRegistryLock } from "./workspaces-index.ts";

/**
 * Per-repo workspace file model (BACK-486 / workspace-resolution-simplification).
 *
 * Single source of truth: `<machineConfigDir>/workspaces/<name>.yml`. Each file
 * is fully self-contained — it carries `repo:` (the project root), `data:`
 * (where task .md files live) and all inline project settings. The machine
 * `config.yml` holds only `current: <name>`.
 */

const WORKSPACES_DIR_NAME = "workspaces";
const MACHINE_CONFIG_FILENAME = "config.yml";

export interface WorkspaceRecord {
	/** Workspace name == yml basename without extension. */
	name: string;
	/** Absolute path to the per-repo yml file. */
	filePath: string;
	/** Absolute repo path (from `repo:`). */
	repo: string;
	/** Absolute data path (from `data:`). */
	data: string;
}

function stripYamlQuotes(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	return t;
}

/** Read a single top-level scalar key from YAML-ish content. */
function readScalar(content: string, key: string): string | null {
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		if (line.slice(0, colon).trim() !== key) continue;
		const value = stripYamlQuotes(line.slice(colon + 1).trim());
		return value || null;
	}
	return null;
}

function toAbsolute(p: string): string {
	return normalize(resolve(p));
}

export function getWorkspacesDir(machineConfigDir?: string): string {
	return join(getMachineConfigDir(machineConfigDir), WORKSPACES_DIR_NAME);
}

export function getMachineConfigFilePath(machineConfigDir?: string): string {
	return join(getMachineConfigDir(machineConfigDir), MACHINE_CONFIG_FILENAME);
}

/** Derive the default workspace name (yml basename) from a repo path. */
export function workspaceNameForRepo(repo: string): string {
	return basename(toAbsolute(repo)) || "workspace";
}

export function getWorkspaceFilePath(name: string, machineConfigDir?: string): string {
	return join(getWorkspacesDir(machineConfigDir), `${name}.yml`);
}

function parseWorkspaceFile(filePath: string, content: string): WorkspaceRecord | null {
	const repo = readScalar(content, "repo");
	const data = readScalar(content, "data");
	if (!repo || !data) {
		return null;
	}
	return {
		name: basename(filePath).replace(/\.ya?ml$/i, ""),
		filePath,
		repo: toAbsolute(repo),
		data: toAbsolute(data),
	};
}

/** Synchronously scan all per-repo workspace files. Missing dir → []. */
export function scanWorkspacesSync(machineConfigDir?: string): WorkspaceRecord[] {
	const dir = getWorkspacesDir(machineConfigDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: WorkspaceRecord[] = [];
	for (const name of names) {
		if (!/\.ya?ml$/i.test(name)) continue;
		const filePath = join(dir, name);
		try {
			const record = parseWorkspaceFile(filePath, readFileSync(filePath, "utf8"));
			if (record) out.push(record);
		} catch {
			// Skip unreadable/invalid files.
		}
	}
	return out;
}

/** Async variant of {@link scanWorkspacesSync}. */
export async function scanWorkspaces(machineConfigDir?: string): Promise<WorkspaceRecord[]> {
	const dir = getWorkspacesDir(machineConfigDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const out: WorkspaceRecord[] = [];
	for (const name of names) {
		if (!/\.ya?ml$/i.test(name)) continue;
		const filePath = join(dir, name);
		try {
			const record = parseWorkspaceFile(filePath, await readFile(filePath, "utf8"));
			if (record) out.push(record);
		} catch {
			// Skip unreadable/invalid files.
		}
	}
	return out;
}

function isCwdInsideRepo(repo: string, cwd: string): boolean {
	const r = toAbsolute(repo);
	const c = toAbsolute(cwd);
	return c === r || c.startsWith(r + sep);
}

/**
 * Match cwd against workspace `repo:` paths. cwd equals OR is inside `repo:`;
 * the deepest (longest) matching `repo:` wins (git-style).
 */
export function matchWorkspaceByCwd(cwd: string, records: WorkspaceRecord[]): WorkspaceRecord | null {
	let best: WorkspaceRecord | null = null;
	for (const record of records) {
		if (!isCwdInsideRepo(record.repo, cwd)) continue;
		if (!best || record.repo.length > best.repo.length) {
			best = record;
		}
	}
	return best;
}

/** Read the `current:` workspace name from machine `config.yml`, or null. */
export function readCurrentWorkspaceName(machineConfigDir?: string): string | null {
	try {
		const content = readFileSync(getMachineConfigFilePath(machineConfigDir), "utf8");
		return readScalar(content, "current");
	} catch {
		return null;
	}
}

/**
 * Resolve the active workspace for a given cwd:
 *   1. deepest `repo:` prefix match,
 *   2. else the `current:` workspace from config.yml,
 *   3. else null.
 */
export function resolveWorkspace(cwd: string, machineConfigDir?: string): WorkspaceRecord | null {
	const records = scanWorkspacesSync(machineConfigDir);
	const byCwd = matchWorkspaceByCwd(cwd, records);
	if (byCwd) return byCwd;

	const currentName = readCurrentWorkspaceName(machineConfigDir);
	if (currentName) {
		return records.find((r) => r.name === currentName) ?? null;
	}
	return null;
}

function serializeMachineConfig(currentName: string | null): string {
	const header = "# Backlog.md machine config\n# Only key: current — the active workspace name.\n";
	return currentName ? `${header}current: ${currentName}\n` : header;
}

/** Atomically set (or clear with null) the `current:` workspace name. */
export async function setCurrentWorkspaceName(name: string | null, machineConfigDir?: string): Promise<void> {
	await withRegistryLock(
		async () => {
			const configDir = getMachineConfigDir(machineConfigDir);
			await mkdir(configDir, { recursive: true });
			const filePath = getMachineConfigFilePath(machineConfigDir);
			const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
			await writeFile(tmpPath, serializeMachineConfig(name), "utf8");
			await rename(tmpPath, filePath);
		},
		{ machineConfigDir },
	);
}

/** Set `current:` only if it is currently unset (idempotent first-init helper). */
export async function setCurrentWorkspaceNameIfUnset(name: string, machineConfigDir?: string): Promise<void> {
	await withRegistryLock(
		async () => {
			const configDir = getMachineConfigDir(machineConfigDir);
			await mkdir(configDir, { recursive: true });
			const filePath = getMachineConfigFilePath(machineConfigDir);
			let existing: string | null = null;
			try {
				existing = readScalar(await readFile(filePath, "utf8"), "current");
			} catch {
				existing = null;
			}
			if (existing) return;
			const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
			await writeFile(tmpPath, serializeMachineConfig(name), "utf8");
			await rename(tmpPath, filePath);
		},
		{ machineConfigDir },
	);
}

/** Delete a workspace file by name. Returns true if a file was removed. */
export async function removeWorkspaceFile(name: string, machineConfigDir?: string): Promise<boolean> {
	const filePath = getWorkspaceFilePath(name, machineConfigDir);
	try {
		await rm(filePath);
	} catch (e) {
		const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
		if (code === "ENOENT") return false;
		throw e;
	}
	return true;
}
