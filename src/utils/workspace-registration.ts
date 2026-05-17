import { FileSystem } from "../file-system/operations.ts";
import {
	getWorkspaceFilePath,
	scanWorkspaces,
	type WorkspaceRecord,
	workspaceNameForRepo,
} from "./workspace-store.ts";
import { pathExistsAsDirectory, toAbsoluteProjectRoot } from "./workspaces-index.ts";

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
 * Workspace identity for the web UI / server API. The per-repo file model uses
 * the workspace **name** (yml basename) as the stable id; `path` is the repo.
 */
export interface WorkspaceListEntry {
	id: string;
	path: string;
}

export interface RegisterResult {
	entry: WorkspaceListEntry;
}

/**
 * Registers an already-initialized backlog project. Under the per-repo model a
 * workspace exists iff its yml file exists, so "register" just validates the
 * path resolves to a workspace and returns its identity. Auto-init for
 * never-initialized paths is handled by the server (it calls `initializeProject`).
 */
export async function registerWorkspaceAtPath(pathArg: string): Promise<RegisterResult> {
	const abs = toAbsoluteProjectRoot(pathArg);
	if (!(await pathExistsAsDirectory(abs))) {
		throw new WorkspaceRegistrationError(`Not a directory: ${abs}`, "not_a_directory");
	}

	const records = await scanWorkspaces();
	const match = records.find((r) => toAbsoluteProjectRoot(r.repo) === abs);
	if (!match) {
		throw new WorkspaceRegistrationError(`No backlog project at ${abs} (missing config).`, "no_backlog_config");
	}

	const fs = new FileSystem(abs);
	const config = await fs.loadConfig();
	if (!config) {
		throw new WorkspaceRegistrationError(`Could not load backlog config at ${abs}.`, "config_load_failed");
	}

	return { entry: { id: match.name, path: match.repo } };
}

/** All registered workspaces as `{ id (name), path (repo) }` entries. */
export async function readWorkspacesWithIds(): Promise<WorkspaceListEntry[]> {
	const records = await scanWorkspaces();
	return records.map((r: WorkspaceRecord) => ({ id: r.name, path: r.repo }));
}

export { getWorkspaceFilePath, workspaceNameForRepo };
