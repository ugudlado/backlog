import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_FILES } from "../constants/index.ts";
import { parseBacklogConfigMetadata } from "./backlog-directory.ts";
import { readMachineConfig } from "./machine-config.ts";

/**
 * A global-store project, discovered by scanning `<globalStore>/*` rather than
 * the workspace registry. The slot directory IS the data directory (flat
 * `config.yml` + `tasks/` inside), so global projects need no registry path —
 * the scan is their source of truth.
 */
export interface GlobalStoreProject {
	id: string;
	name: string;
	/** Absolute path to the slot directory (the data dir). */
	slotPath: string;
}

/**
 * A project name is usable as a global-store slot only if it is a single safe
 * path component: no separators, no `.`/`..` traversal, no NUL. Keying the slot
 * directory by an unsanitized name would let `init "../x"` escape the store.
 */
export function isSafeSlotName(name: string): boolean {
	if (!name || name === "." || name === "..") return false;
	return !/[/\\\0]/.test(name);
}

/**
 * Enumerate global-store projects by scanning the configured globalStore. Each
 * immediate subdirectory with a readable `config.yml` is a project. Returns an
 * empty list when globalStore is unset or unreadable — callers fall back to the
 * registry, so local-mode workspaces are unaffected.
 */
export async function scanGlobalStoreProjects(): Promise<GlobalStoreProject[]> {
	const { globalStore } = readMachineConfig();
	if (!globalStore) return [];

	// withFileTypes gives isDirectory() for free — no per-entry stat.
	const entries = await readdir(globalStore, { withFileTypes: true }).catch(() => []);

	const projects = await Promise.all(
		entries.map(async (dirent) => {
			if (!dirent.isDirectory()) return null;
			const slotPath = join(globalStore, dirent.name);
			try {
				const content = await readFile(join(slotPath, DEFAULT_FILES.CONFIG), "utf8");
				const { id, projectName } = parseBacklogConfigMetadata(content);
				// Prefer the config id/name; fall back to the dir name as a stable key.
				return { id: id ?? dirent.name, name: projectName ?? dirent.name, slotPath };
			} catch {
				// Not a project slot (no readable config.yml) — skip.
				return null;
			}
		}),
	);
	return projects.filter((p): p is GlobalStoreProject => p !== null);
}

/** Find a single global-store project by its scan id, or null. */
export async function findGlobalStoreProject(id: string): Promise<GlobalStoreProject | null> {
	return (await scanGlobalStoreProjects()).find((p) => p.id === id) ?? null;
}
