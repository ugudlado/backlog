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
			// Skip non-dirs and dot-dirs (e.g. `.archive` for soft-deleted projects).
			if (!dirent.isDirectory() || dirent.name.startsWith(".")) return null;
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

/**
 * Soft-delete a global-store project: move its slot to `<globalStore>/.archive/`
 * instead of deleting data. The `.archive` dir is skipped by the scan, so the
 * project disappears from listings but its tasks remain recoverable on disk.
 * Returns the archived path, or null if the project was not found.
 */
export async function archiveGlobalStoreProject(id: string, timestamp: number): Promise<string | null> {
	const project = await findGlobalStoreProject(id);
	if (!project) return null;
	const { globalStore } = readMachineConfig();
	if (!globalStore) return null;
	const { mkdir, rename } = await import("node:fs/promises");
	const archiveDir = join(globalStore, ".archive");
	await mkdir(archiveDir, { recursive: true });
	// Suffix with a timestamp so re-archiving a same-named project never clobbers.
	const dest = join(archiveDir, `${project.name}-${timestamp}`);
	await rename(project.slotPath, dest);
	return dest;
}
