import { createHash } from "node:crypto";
import { FileSystem } from "../file-system/operations.ts";
import { resolveBacklogDirectory } from "./backlog-directory.ts";
import {
	pathExistsAsDirectory,
	readWorkspacesIndex,
	toAbsoluteProjectRoot,
	upsertWorkspaceEntry,
	type WorkspaceEntry,
	withRegistryLock,
	writeWorkspacesIndex,
} from "./workspaces-index.ts";

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
	entry: WorkspaceEntry;
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
	options?: { machineConfigDir?: string },
): Promise<RegisterResult> {
	const abs = toAbsoluteProjectRoot(pathArg);
	if (!(await pathExistsAsDirectory(abs))) {
		throw new WorkspaceRegistrationError(`Not a directory: ${abs}`, "not_a_directory");
	}
	const resolution = resolveBacklogDirectory(abs);
	if (!resolution.configPath) {
		throw new WorkspaceRegistrationError(`No backlog project at ${abs} (missing config).`, "no_backlog_config");
	}

	const fs = new FileSystem(abs);
	const config = await fs.loadConfig();
	if (!config) {
		throw new WorkspaceRegistrationError(`Could not load backlog config at ${abs}.`, "config_load_failed");
	}

	let minted = false;
	if (!config.id) {
		config.id = mintWorkspaceId(config.projectName);
		await fs.saveConfig(config);
		minted = true;
	}

	const entry: WorkspaceEntry = { path: abs, id: config.id };
	await upsertWorkspaceEntry(entry, options?.machineConfigDir);
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
export async function readWorkspacesWithIds(machineConfigDir?: string): Promise<WorkspaceEntry[]> {
	// First pass: unlocked read to check whether migration is needed.
	const index = await readWorkspacesIndex(machineConfigDir);
	const needsMigration = index.workspaces.some((e) => !e.id);
	if (!needsMigration) {
		return index.workspaces;
	}

	// Migration needed: re-read and rewrite inside the registry lock to avoid
	// a lost-update race where two concurrent processes both read the old state
	// and one's write clobbers the other's workspace entries.
	return withRegistryLock(
		async () => {
			const locked = await readWorkspacesIndex(machineConfigDir);
			const out: WorkspaceEntry[] = [];
			let mutated = false;
			for (const e of locked.workspaces) {
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
				await writeWorkspacesIndex({ ...locked, workspaces: out }, machineConfigDir);
			}
			return out;
		},
		{ machineConfigDir },
	);
}
