/**
 * Remote backend client for CLI commands when BACKLOG_URL is set.
 *
 * When a user sets BACKLOG_URL=http://myserver:6420, CLI commands proxy
 * requests to the hosted server's REST API instead of reading local files.
 */

import type { SearchPriorityFilter, Task } from "../types/index.ts";

export const BACKLOG_URL_ENV = "BACKLOG_URL";

export function getRemoteUrl(): string | undefined {
	return process.env[BACKLOG_URL_ENV]?.trim().replace(/\/$/, "");
}

export function isRemoteMode(): boolean {
	return Boolean(getRemoteUrl());
}

class RemoteBackendError extends Error {
	constructor(
		message: string,
		public status?: number,
	) {
		super(message);
		this.name = "RemoteBackendError";
	}
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
	const base = getRemoteUrl();
	if (!base) throw new RemoteBackendError("BACKLOG_URL is not set");

	const url = `${base}${path}`;
	let response: Response;
	try {
		response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
	} catch (err) {
		throw new RemoteBackendError(`Could not reach ${url}: ${(err as Error).message}`);
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new RemoteBackendError(
			`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
			response.status,
		);
	}

	return response.json() as Promise<T>;
}

export interface RemoteTaskListOptions {
	status?: string;
	assignee?: string;
	milestone?: string;
	priority?: SearchPriorityFilter;
	parent?: string;
}

export async function remoteTaskList(options: RemoteTaskListOptions = {}): Promise<Task[]> {
	const params = new URLSearchParams();
	if (options.status) params.append("status", options.status);
	if (options.assignee) params.append("assignee", options.assignee);
	if (options.priority) params.append("priority", options.priority);
	if (options.parent) params.append("parent", options.parent);
	// milestone filtering is client-side in the local path; pass it through for server filtering
	if (options.milestone) params.append("milestone", options.milestone);

	const qs = params.toString();
	return apiFetch<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
}
