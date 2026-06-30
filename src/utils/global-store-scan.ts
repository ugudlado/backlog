import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readMachineConfig } from "./machine-config.ts";

/**
 * A global-store project, discovered by scanning `<globalStore>/*`. The folder
 * name IS the project — its `tasks/` are rendered directly. No per-project
 * config file is required; `id` and `name` are the folder name.
 */
export interface GlobalStoreProject {
	id: string;
	name: string;
	/** Absolute path to the slot directory (the data dir). */
	slotPath: string;
}

/**
 * Enumerate global-store projects by scanning the configured globalStore. Every
 * immediate subdirectory (except dot-dirs like `.archive`) is a project, keyed
 * by its folder name. Returns an empty list when globalStore is unset or
 * unreadable — callers fall back to the registry, so local-mode is unaffected.
 */
export async function scanGlobalStoreProjects(): Promise<GlobalStoreProject[]> {
	const { globalStore } = readMachineConfig();
	if (!globalStore) return [];

	// withFileTypes gives isDirectory() for free — no per-entry stat.
	const entries = await readdir(globalStore, { withFileTypes: true }).catch(() => []);

	return entries
		.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
		.map((dirent) => ({ id: dirent.name, name: dirent.name, slotPath: join(globalStore, dirent.name) }));
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
