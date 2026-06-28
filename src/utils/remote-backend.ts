/**
 * Remote backend client for CLI and MCP when a remote server URL is configured.
 *
 * Resolution order (first match wins):
 *   URL:   BACKLOG_URL env var → backlog_url in ~/.config/backlog/config.yml
 *   Token: BACKLOG_TOKEN env var → backlog_token in ~/.config/backlog/config.yml
 *
 * When configured, commands proxy requests to the hosted server's REST API
 * instead of reading local files.
 */

import type { BacklogConfig, SearchPriorityFilter, SearchResult, Task, TaskUpdateInput } from "../types/index.ts";
import { readMachineConfig } from "./machine-config.ts";

export const BACKLOG_URL_ENV = "BACKLOG_URL";
export const BACKLOG_TOKEN_ENV = "BACKLOG_TOKEN";

function normalizeRemoteUrl(url: string | null | undefined): string | undefined {
	const trimmed = url?.trim();
	if (!trimmed) return undefined;
	return trimmed.replace(/\/$/, "");
}

export function getRemoteUrl(): string | undefined {
	const fromEnv = normalizeRemoteUrl(process.env[BACKLOG_URL_ENV]);
	if (fromEnv) return fromEnv;

	const config = readMachineConfig();
	return normalizeRemoteUrl(config.backlogUrl);
}

export function getRemoteToken(): string | undefined {
	const fromEnv = process.env[BACKLOG_TOKEN_ENV]?.trim();
	if (fromEnv) return fromEnv;

	const config = readMachineConfig();
	return config.backlogToken?.trim() || undefined;
}

export function isRemoteMode(): boolean {
	return Boolean(getRemoteUrl());
}

export class RemoteBackendError extends Error {
	constructor(
		message: string,
		public status?: number,
	) {
		super(message);
		this.name = "RemoteBackendError";
	}
}

function authHeaders(): Record<string, string> {
	const token = getRemoteToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
	const base = getRemoteUrl();
	if (!base) {
		throw new RemoteBackendError(
			"Remote server URL is not configured. Set backlog_url in ~/.config/backlog/config.yml or BACKLOG_URL.",
		);
	}

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
		throw new RemoteBackendError(
			"Authentication required. Set backlog_token in ~/.config/backlog/config.yml or BACKLOG_TOKEN.",
			401,
		);
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

// ─── Config ───────────────────────────────────────────────────────────────────

export async function remoteGetConfig(): Promise<BacklogConfig> {
	return apiFetch<BacklogConfig>("/api/config");
}

export async function remoteGetStatuses(): Promise<string[]> {
	return apiFetch<string[]>("/api/statuses");
}

// ─── Task list ────────────────────────────────────────────────────────────────

export interface RemoteTaskListOptions {
	status?: string;
	assignee?: string;
	milestone?: string;
	priority?: SearchPriorityFilter;
	parent?: string;
	labels?: string[];
}

export async function remoteTaskList(options: RemoteTaskListOptions = {}): Promise<Task[]> {
	const params = new URLSearchParams();
	if (options.status) params.append("status", options.status);
	if (options.assignee) params.append("assignee", options.assignee);
	if (options.priority) params.append("priority", options.priority);
	if (options.parent) params.append("parent", options.parent);
	if (options.milestone) params.append("milestone", options.milestone);
	for (const label of options.labels ?? []) {
		params.append("label", label);
	}

	const qs = params.toString();
	return apiFetch<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
}

// ─── Task search ──────────────────────────────────────────────────────────────

export interface RemoteSearchOptions {
	query?: string;
	status?: string | string[];
	priority?: SearchPriorityFilter | SearchPriorityFilter[];
	modifiedFiles?: string[];
	limit?: number;
}

export async function remoteSearch(options: RemoteSearchOptions = {}): Promise<SearchResult[]> {
	const params = new URLSearchParams();
	if (options.query) params.append("query", options.query);
	if (options.limit !== undefined) params.append("limit", String(options.limit));

	const statuses = Array.isArray(options.status) ? options.status : options.status ? [options.status] : [];
	for (const status of statuses) {
		params.append("status", status);
	}

	const priorities = Array.isArray(options.priority) ? options.priority : options.priority ? [options.priority] : [];
	for (const priority of priorities) {
		params.append("priority", priority);
	}

	for (const modifiedFile of options.modifiedFiles ?? []) {
		params.append("modifiedFile", modifiedFile);
	}

	const qs = params.toString();
	return apiFetch<SearchResult[]>(`/api/search${qs ? `?${qs}` : ""}`);
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
	assignee?: string | string[];
	labels?: string[];
	milestone?: string;
	parentTaskId?: string;
	dependencies?: string[];
	references?: string[];
	documentation?: string[];
	modifiedFiles?: string[];
	acceptanceCriteria?: string[];
	definitionOfDoneAdd?: string[];
	disableDefinitionOfDoneDefaults?: boolean;
	plan?: string;
	notes?: string;
	finalSummary?: string;
}

export async function remoteTaskCreate(options: RemoteTaskCreateOptions): Promise<Task> {
	const acceptanceCriteriaItems = (options.acceptanceCriteria ?? []).map((text) => ({ text, checked: false }));
	const assignee = options.assignee
		? Array.isArray(options.assignee)
			? options.assignee
			: [options.assignee]
		: undefined;

	return apiFetch<Task>("/api/tasks", {
		method: "POST",
		body: JSON.stringify({
			title: options.title,
			description: options.description,
			status: options.status,
			priority: options.priority,
			assignee,
			labels: options.labels,
			milestone: options.milestone,
			parentTaskId: options.parentTaskId,
			dependencies: options.dependencies,
			references: options.references,
			documentation: options.documentation,
			modifiedFiles: options.modifiedFiles,
			acceptanceCriteriaItems,
			definitionOfDoneAdd: options.definitionOfDoneAdd,
			disableDefinitionOfDoneDefaults: options.disableDefinitionOfDoneDefaults,
			implementationPlan: options.plan,
			implementationNotes: options.notes,
			finalSummary: options.finalSummary,
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

// ─── Task archive / complete / next ───────────────────────────────────────────

export async function remoteTaskArchive(taskId: string): Promise<void> {
	return apiFetchVoid(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

export async function remoteTaskComplete(taskId: string): Promise<void> {
	return apiFetchVoid(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: "POST" });
}

export interface RemoteTaskNextOptions {
	status?: string;
	agent?: string;
}

export interface RemoteTaskNextResult {
	task: Task;
	previousStatus: string;
}

export async function remoteTaskNext(options: RemoteTaskNextOptions = {}): Promise<RemoteTaskNextResult | null> {
	const claimStatus = options.status ?? "Ready";
	const candidates = await remoteTaskList({ status: claimStatus });
	if (candidates.length === 0) {
		return null;
	}

	const candidate = candidates[0];
	if (!candidate) {
		return null;
	}

	const previousStatus = candidate.status ?? claimStatus;
	const updates: TaskUpdateInput = { status: "In Progress" };
	if (options.agent) {
		updates.assignee = [options.agent];
	}

	const task = await remoteTaskEdit(candidate.id, updates);
	return { task, previousStatus };
}
