/**
 * Remote backend client for CLI commands when BACKLOG_URL is set.
 *
 * When a user sets BACKLOG_URL=http://myserver:6420, CLI commands proxy
 * requests to the hosted server's REST API instead of reading local files.
 *
 * Auth: set BACKLOG_TOKEN=<bearer-token> to authenticate against a server
 * that requires it. The token is sent as `Authorization: Bearer <token>`.
 */

import type { SearchPriorityFilter, Task, TaskUpdateInput } from "../types/index.ts";

export const BACKLOG_URL_ENV = "BACKLOG_URL";
export const BACKLOG_TOKEN_ENV = "BACKLOG_TOKEN";

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

function authHeaders(): Record<string, string> {
	const token = process.env[BACKLOG_TOKEN_ENV]?.trim();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
	const base = getRemoteUrl();
	if (!base) throw new RemoteBackendError("BACKLOG_URL is not set");

	const url = `${base}${path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			...options,
			headers: { "Content-Type": "application/json", ...authHeaders(), ...options.headers },
		});
	} catch (err) {
		throw new RemoteBackendError(`Could not reach ${url}: ${(err as Error).message}`);
	}

	if (response.status === 401) {
		throw new RemoteBackendError("Authentication required. Set BACKLOG_TOKEN=<token> to authenticate.", 401);
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

async function apiFetchVoid(path: string, options: RequestInit = {}): Promise<void> {
	await apiFetch<unknown>(path, options);
}

// ─── Task list ────────────────────────────────────────────────────────────────

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
	if (options.milestone) params.append("milestone", options.milestone);

	const qs = params.toString();
	return apiFetch<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
}

// ─── Task view ────────────────────────────────────────────────────────────────

export async function remoteTaskView(taskId: string): Promise<Task> {
	return apiFetch<Task>(`/api/task/${encodeURIComponent(taskId)}`);
}

// ─── Task create ──────────────────────────────────────────────────────────────

export interface RemoteTaskCreateOptions {
	title: string;
	description?: string;
	status?: string;
	priority?: string;
	assignee?: string;
	labels?: string[];
	milestone?: string;
	parentTaskId?: string;
	dependencies?: string[];
	references?: string[];
	acceptanceCriteria?: string[];
	plan?: string;
	notes?: string;
}

export async function remoteTaskCreate(options: RemoteTaskCreateOptions): Promise<Task> {
	const acceptanceCriteriaItems = (options.acceptanceCriteria ?? []).map((text) => ({ text, checked: false }));
	return apiFetch<Task>("/api/tasks", {
		method: "POST",
		body: JSON.stringify({
			title: options.title,
			description: options.description,
			status: options.status,
			priority: options.priority,
			assignee: options.assignee,
			labels: options.labels,
			milestone: options.milestone,
			parentTaskId: options.parentTaskId,
			dependencies: options.dependencies,
			references: options.references,
			acceptanceCriteriaItems,
			implementationPlan: options.plan,
			implementationNotes: options.notes,
		}),
	});
}

// ─── Task edit ────────────────────────────────────────────────────────────────

export async function remoteTaskEdit(taskId: string, updates: TaskUpdateInput): Promise<Task> {
	return apiFetch<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, {
		method: "PUT",
		body: JSON.stringify(updates),
	});
}

// ─── Task complete ────────────────────────────────────────────────────────────

export async function remoteTaskComplete(taskId: string): Promise<void> {
	return apiFetchVoid(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: "POST" });
}

// ─── Task archive ─────────────────────────────────────────────────────────────

export async function remoteTaskArchive(taskId: string): Promise<void> {
	return apiFetchVoid(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}
