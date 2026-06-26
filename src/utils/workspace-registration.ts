import { createHash } from "node:crypto";
import { FileSystem } from "../file-system/operations.ts";
import { setActiveWorkspaceDataDir } from "./active-workspace.ts";
import { resolveBacklogDirectory } from "./backlog-directory.ts";
import {
	type ProjectEntry,
	pathExistsAsDirectory,
	readProjectsIndex,
	toAbsoluteProjectRoot,
	upsertProjectEntry,
	withRegistryLock,
	writeProjectsIndex,
} from "./projects-index.ts";

export class WorkspaceRegistrationError extends Error {
	constructor(
		message: string,
		public readonly code: "not_a_directory" | "no_backlog_config" | "config_load_failed",
	) {
		super(message);
		this.name = "WorkspaceRegistrationError";
	}
}

/**
 * Stable workspace id: <slug>-<8-char-hash-of-projectName>.
 * Deterministic from projectName so the same project gets the same id across
 * machines, clones, and registry rebuilds. 32-bit hash makes collisions
 * negligible for realistic workspace counts; same-name projects still
 * collide by design (re-registering merges into the existing entry).
 */
export function mintWorkspaceId(projectName: string): string {
	const slug = slugify(projectName) || "project";
	const hash = createHash("sha256").update(projectName).digest("hex").slice(0, 8);
	return `${slug}-${hash}`;
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
}

export interface RegisterResult {
	entry: ProjectEntry;
	minted: boolean;
}

/**
 * Shared primitive used by `backlog init`, `workspace add`, the web UI add-form,
 * and CLI auto-discovery. Validates the path is a backlog project, mints +
 * persists an id into the project config if one is missing, and upserts the
 * entry into the machine workspace index.
 */
export async function registerWorkspaceAtPath(
	pathArg: string,
	options?: { machineConfigDir?: string; data?: string },
): Promise<RegisterResult> {
	const abs = toAbsoluteProjectRoot(pathArg);
	if (!(await pathExistsAsDirectory(abs))) {
		throw new WorkspaceRegistrationError(`Not a directory: ${abs}`, "not_a_directory");
	}

	// When a `data:` override is given, the workspace's config lives at
	// `<data>/config.yml` (the same contract FileSystem applies for a
	// data-overridden workspace), not under the repo root. Validate there.
	const dataDir = options?.data ? toAbsoluteProjectRoot(options.data) : null;
	if (dataDir) {
		if (!(await pathExistsAsDirectory(dataDir))) {
			throw new WorkspaceRegistrationError(`Not a directory: ${dataDir}`, "not_a_directory");
		}
		setActiveWorkspaceDataDir(abs, dataDir);
	} else {
		const resolution = resolveBacklogDirectory(abs);
		if (!resolution.configPath) {
			throw new WorkspaceRegistrationError(`No backlog project at ${abs} (missing config).`, "no_backlog_config");
		}
	}

	const fs = new FileSystem(abs);
	const config = await fs.loadConfig();
	if (!config) {
		const where = dataDir ?? abs;
		throw new WorkspaceRegistrationError(`Could not load backlog config at ${where}.`, "config_load_failed");
	}

	let minted = false;
	if (!config.id) {
		config.id = mintWorkspaceId(config.projectName);
		await fs.saveConfig(config);
		minted = true;
	}

	const entry: ProjectEntry = { path: abs, id: config.id };
	if (options?.data) {
		entry.data = options.data;
	}
	await upsertProjectEntry(entry, options?.machineConfigDir);
	return { entry, minted };
}

/**
 * Best-effort id backfill for an existing index entry whose project config
 * has an id but the registry doesn't (or vice-versa). Used during read-time
 * migration. Never throws — bad/missing configs are skipped.
 */
export async function tryReadProjectId(projectRoot: string): Promise<string | null> {
	try {
		const fs = new FileSystem(toAbsoluteProjectRoot(projectRoot));
		const config = await fs.loadConfig();
		return config?.id ?? null;
	} catch {
		return null;
	}
}

/**
 * Reads the workspace index and returns entries with ids. Entries that are
 * missing an id but whose project config already has one get migrated in
 * place. Entries whose project config also lacks an id are left untouched
 * (they'll get one on next explicit register).
 *
 * Migration is batched: one read of every project config followed by a
 * single rewrite of workspaces.yml — never N rewrites.
 */
export async function readProjectsWithIds(machineConfigDir?: string): Promise<ProjectEntry[]> {
	// First pass: unlocked read to check whether migration is needed.
	const index = await readProjectsIndex(machineConfigDir);
	const needsMigration = index.projects.some((e) => !e.id);
	if (!needsMigration) {
		return index.projects;
	}

	// Migration needed: re-read and rewrite inside the registry lock to avoid
	// a lost-update race where two concurrent processes both read the old state
	// and one's write clobbers the other's workspace entries.
	return withRegistryLock(
		async () => {
			const locked = await readProjectsIndex(machineConfigDir);
			const out: ProjectEntry[] = [];
			let mutated = false;
			for (const e of locked.projects) {
				if (e.id) {
					out.push(e);
					continue;
				}
				const projectId = await tryReadProjectId(e.path);
				if (projectId) {
					out.push({ ...e, id: projectId });
					mutated = true;
				} else {
					out.push(e);
				}
			}
			if (mutated) {
				await writeProjectsIndex({ ...locked, projects: out }, machineConfigDir);
			}
			return out;
		},
		{ machineConfigDir },
	);
}
