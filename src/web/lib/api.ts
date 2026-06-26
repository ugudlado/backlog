import type { TaskStatistics } from "../../core/statistics.ts";
import type {
	BacklogConfig,
	Milestone,
	SearchPriorityFilter,
	SearchResult,
	SearchResultType,
	Task,
	TaskStatus,
} from "../../types/index.ts";

const API_BASE = "/api";

export interface ReorderTaskPayload {
	taskId: string;
	targetStatus: string;
	orderedTaskIds: string[];
	targetMilestone?: string | null;
}

export interface InitializationStatus {
	initialized: boolean;
	projectPath: string;
	backlogDirectory?: string | null;
	backlogDirectorySource?: "backlog" | ".backlog" | "custom" | null;
	configLocation?: "folder" | "root" | null;
	rootConfigPath?: string | null;
}

export interface Workspace {
	id: string;
	path: string;
}

export interface WorkspacesResponse {
	workspaces: Workspace[];
	currentId: string | null;
}

export interface AddWorkspaceResponse extends WorkspacesResponse {
	/** Id minted (or matched) for the path the caller just added; null if the server couldn't resolve it. */
	addedId: string | null;
}

// Enhanced error types for better error handling
export class ApiError extends Error {
	constructor(
		message: string,
		public status?: number,
		public code?: string,
		public data?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}

	static fromResponse(response: Response, data?: unknown): ApiError {
		const message = ApiError.extractMessage(response, data);
		const code = ApiError.extractCode(response, data);
		return new ApiError(message, response.status, code, data);
	}

	private static extractMessage(response: Response, data?: unknown): string {
		if (typeof data === "string" && data.trim().length > 0) {
			return data.trim();
		}
		if (data && typeof data === "object") {
			const maybeMessage = (data as { message?: unknown }).message;
			if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
				return maybeMessage.trim();
			}
			const maybeError = (data as { error?: unknown }).error;
			if (typeof maybeError === "string" && maybeError.trim().length > 0) {
				return maybeError.trim();
			}
		}
		return `HTTP ${response.status}: ${response.statusText}`;
	}

	private static extractCode(response: Response, data?: unknown): string {
		if (data && typeof data === "object") {
			const maybeCode = (data as { code?: unknown }).code;
			if (typeof maybeCode === "string" && maybeCode.trim().length > 0) {
				return maybeCode.trim();
			}
		}
		return response.statusText;
	}
}

export class NetworkError extends Error {
	constructor(message = "Network request failed") {
		super(message);
		this.name = "NetworkError";
	}
}

// Request configuration interface
interface RequestConfig {
	retries?: number;
	timeout?: number;
	Headers?: Record<string, string>;
}

// Default configuration
const DEFAULT_CONFIG: RequestConfig = {
	retries: 3,
	timeout: 10000,
};

export class ApiClient {
	private config: RequestConfig;

	constructor(config: RequestConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	// Enhanced fetch with retry logic and better error handling
	private async fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
		const { retries = 3, timeout = 10000 } = this.config;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				// Add timeout to the request
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), timeout);

				const response = await fetch(url, {
					...options,
					signal: controller.signal,
					headers: {
						"Content-Type": "application/json",
						...options.headers,
					},
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					let errorData: unknown = null;
					try {
						errorData = await response.json();
					} catch {
						// Ignore JSON parse errors for error data
					}
					throw ApiError.fromResponse(response, errorData);
				}

				return response;
			} catch (error) {
				lastError = error as Error;

				// Don't retry on client errors (4xx) or specific cases
				if (error instanceof ApiError && error.status && error.status >= 400 && error.status < 500) {
					throw error;
				}

				// For network errors or server errors, retry with exponential backoff
				if (attempt < retries) {
					const delay = Math.min(1000 * 2 ** attempt, 10000);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		// If we get here, all retries failed
		if (lastError instanceof ApiError) {
			throw lastError;
		}
		throw new NetworkError(`Request failed after ${retries + 1} attempts: ${lastError?.message}`);
	}

	// Helper method for JSON responses
	private async fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
		const response = await this.fetchWithRetry(url, options);
		return response.json();
	}
	async fetchTasks(options?: {
		status?: string;
		assignee?: string;
		parent?: string;
		priority?: SearchPriorityFilter;
		labels?: string[];
		crossBranch?: boolean;
	}): Promise<Task[]> {
		const params = new URLSearchParams();
		if (options?.status) params.append("status", options.status);
		if (options?.assignee) params.append("assignee", options.assignee);
		if (options?.parent) params.append("parent", options.parent);
		if (options?.priority) params.append("priority", options.priority);
		if (options?.labels) {
			for (const label of options.labels) {
				if (label && label.trim().length > 0) {
					params.append("label", label.trim());
				}
			}
		}
		// Default to true for cross-branch loading to match TUI behavior
		if (options?.crossBranch !== false) params.append("crossBranch", "true");

		const url = `${API_BASE}/tasks${params.toString() ? `?${params.toString()}` : ""}`;
		return this.fetchJson<Task[]>(url);
	}

	async search(
		options: {
			query?: string;
			types?: SearchResultType[];
			status?: string | string[];
			priority?: SearchPriorityFilter | SearchPriorityFilter[];
			assignee?: string | string[];
			labels?: string[];
			modifiedFiles?: string[];
			limit?: number;
		} = {},
	): Promise<SearchResult[]> {
		const params = new URLSearchParams();
		if (options.query) {
			params.set("query", options.query);
		}
		if (options.types && options.types.length > 0) {
			for (const type of options.types) {
				params.append("type", type);
			}
		}
		if (options.status) {
			const statuses = Array.isArray(options.status) ? options.status : [options.status];
			for (const status of statuses) {
				params.append("status", status);
			}
		}
		if (options.priority) {
			const priorities = Array.isArray(options.priority) ? options.priority : [options.priority];
			for (const priority of priorities) {
				params.append("priority", priority);
			}
		}
		if (options.assignee) {
			const assignees = Array.isArray(options.assignee) ? options.assignee : [options.assignee];
			for (const assignee of assignees) {
				if (assignee && assignee.trim().length > 0) {
					params.append("assignee", assignee.trim());
				}
			}
		}
		if (options.labels) {
			for (const label of options.labels) {
				if (label && label.trim().length > 0) {
					params.append("label", label.trim());
				}
			}
		}
		if (options.modifiedFiles) {
			for (const file of options.modifiedFiles) {
				if (file && file.trim().length > 0) {
					params.append("modifiedFile", file.trim());
				}
			}
		}
		if (options.limit !== undefined) {
			params.set("limit", String(options.limit));
		}

		const url = `${API_BASE}/search${params.toString() ? `?${params.toString()}` : ""}`;
		return this.fetchJson<SearchResult[]>(url);
	}

	async fetchTask(id: string): Promise<Task> {
		return this.fetchJson<Task>(`${API_BASE}/task/${id}`);
	}

	async createTask(task: Omit<Task, "id" | "createdDate">): Promise<Task> {
		return this.fetchJson<Task>(`${API_BASE}/tasks`, {
			method: "POST",
			body: JSON.stringify(task),
		});
	}

	async updateTask(
		id: string,
		updates: Omit<Partial<Task>, "milestone"> & { milestone?: string | null },
	): Promise<Task> {
		return this.fetchJson<Task>(`${API_BASE}/tasks/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
	}

	async reorderTask(payload: ReorderTaskPayload): Promise<{ success: boolean; task: Task }> {
		return this.fetchJson<{ success: boolean; task: Task }>(`${API_BASE}/tasks/reorder`, {
			method: "POST",
			body: JSON.stringify(payload),
		});
	}

	async archiveTask(id: string): Promise<void> {
		await this.fetchWithRetry(`${API_BASE}/tasks/${id}`, {
			method: "DELETE",
		});
	}

	async completeTask(id: string): Promise<void> {
		await this.fetchWithRetry(`${API_BASE}/tasks/${id}/complete`, {
			method: "POST",
		});
	}

	async getCleanupPreview(age: number): Promise<{
		count: number;
		tasks: Array<{ id: string; title: string; updatedDate?: string; createdDate: string }>;
	}> {
		return this.fetchJson<{
			count: number;
			tasks: Array<{ id: string; title: string; updatedDate?: string; createdDate: string }>;
		}>(`${API_BASE}/tasks/cleanup?age=${age}`);
	}

	async executeCleanup(
		age: number,
	): Promise<{ success: boolean; movedCount: number; totalCount: number; message: string; failedTasks?: string[] }> {
		return this.fetchJson<{
			success: boolean;
			movedCount: number;
			totalCount: number;
			message: string;
			failedTasks?: string[];
		}>(`${API_BASE}/tasks/cleanup/execute`, {
			method: "POST",
			body: JSON.stringify({ age }),
		});
	}

	async updateTaskStatus(id: string, status: TaskStatus): Promise<Task> {
		return this.updateTask(id, { status });
	}

	async fetchStatuses(): Promise<string[]> {
		const response = await fetch(`${API_BASE}/statuses`);
		if (!response.ok) {
			throw new Error("Failed to fetch statuses");
		}
		return response.json();
	}

	async fetchConfig(): Promise<BacklogConfig> {
		const response = await fetch(`${API_BASE}/config`);
		if (!response.ok) {
			throw new Error("Failed to fetch config");
		}
		return response.json();
	}

	async updateConfig(config: BacklogConfig): Promise<BacklogConfig> {
		const response = await fetch(`${API_BASE}/config`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(config),
		});
		if (!response.ok) {
			throw new Error("Failed to update config");
		}
		return response.json();
	}

	async fetchMilestones(): Promise<Milestone[]> {
		const response = await fetch(`${API_BASE}/milestones`);
		if (!response.ok) {
			throw new Error("Failed to fetch milestones");
		}
		return response.json();
	}

	async fetchArchivedMilestones(): Promise<Milestone[]> {
		const response = await fetch(`${API_BASE}/milestones/archived`);
		if (!response.ok) {
			throw new Error("Failed to fetch archived milestones");
		}
		return response.json();
	}

	async fetchMilestone(id: string): Promise<Milestone> {
		const response = await fetch(`${API_BASE}/milestones/${encodeURIComponent(id)}`);
		if (!response.ok) {
			throw new Error("Failed to fetch milestone");
		}
		return response.json();
	}

	async createMilestone(
		title: string,
		description?: string,
		dates?: { startDate?: string | null; endDate?: string | null },
	): Promise<Milestone> {
		const response = await fetch(`${API_BASE}/milestones`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title, description, ...(dates ?? {}) }),
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || "Failed to create milestone");
		}
		return response.json();
	}

	async updateMilestone(
		id: string,
		title: string,
		dates?: { startDate?: string | null; endDate?: string | null },
	): Promise<{ success: boolean; milestone?: Milestone | null; message?: string }> {
		const response = await fetch(`${API_BASE}/milestones/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title, ...(dates ?? {}) }),
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || "Failed to update milestone");
		}
		return response.json();
	}

	async removeMilestone(
		id: string,
		options: { taskHandling?: "clear" | "keep" | "reassign"; reassignTo?: string } = {},
	): Promise<{ success: boolean; message?: string }> {
		const response = await fetch(`${API_BASE}/milestones/${encodeURIComponent(id)}`, {
			method: "DELETE",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(options),
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || "Failed to remove milestone");
		}
		return response.json();
	}

	async archiveMilestone(id: string): Promise<{ success: boolean; milestone?: Milestone | null }> {
		const response = await fetch(`${API_BASE}/milestones/${encodeURIComponent(id)}/archive`, {
			method: "POST",
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || "Failed to archive milestone");
		}
		return response.json();
	}

	async fetchStatistics(): Promise<
		TaskStatistics & { statusCounts: Record<string, number>; priorityCounts: Record<string, number> }
	> {
		return this.fetchJson<
			TaskStatistics & { statusCounts: Record<string, number>; priorityCounts: Record<string, number> }
		>(`${API_BASE}/statistics`);
	}

	async checkStatus(): Promise<InitializationStatus> {
		return this.fetchJson<InitializationStatus>(`${API_BASE}/status`);
	}

	async fetchWorkspaces(): Promise<WorkspacesResponse> {
		return this.fetchJson<WorkspacesResponse>(`${API_BASE}/workspaces`);
	}

	/** Create a new global-store project by name. */
	async createProject(name: string): Promise<AddWorkspaceResponse> {
		return this.fetchJson<AddWorkspaceResponse>(`${API_BASE}/workspaces`, {
			method: "POST",
			body: JSON.stringify({ name }),
		});
	}

	async setCurrentWorkspace(id: string): Promise<{ ok: boolean }> {
		return this.fetchJson<{ ok: boolean }>(`${API_BASE}/workspaces/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ current: true }),
		});
	}

	async deleteWorkspace(id: string): Promise<WorkspacesResponse> {
		return this.fetchJson<WorkspacesResponse>(`${API_BASE}/workspaces/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	}

	async initializeProject(options: {
		projectName: string;
		backlogDirectory?: string;
		backlogDirectorySource?: "backlog" | ".backlog" | "custom";
		configLocation?: "folder" | "root";
		integrationMode: "mcp" | "cli" | "none";
		mcpClients?: ("claude" | "codex" | "gemini" | "kiro" | "guide")[];
		agentInstructions?: ("CLAUDE.md" | "AGENTS.md" | "GEMINI.md" | ".github/copilot-instructions.md")[];
		installClaudeAgent?: boolean;
		filesystemOnly?: boolean;
		advancedConfig?: {
			checkActiveBranches?: boolean;
			remoteOperations?: boolean;
			activeBranchDays?: number;
			bypassGitHooks?: boolean;
			zeroPaddedIds?: number;
			taskPrefix?: string;
			defaultEditor?: string;
			defaultPort?: number;
			autoOpenBrowser?: boolean;
		};
	}): Promise<{ success: boolean; projectName: string; mcpResults?: Record<string, string> }> {
		return this.fetchJson<{ success: boolean; projectName: string; mcpResults?: Record<string, string> }>(
			`${API_BASE}/init`,
			{
				method: "POST",
				body: JSON.stringify(options),
			},
		);
	}
}

export const apiClient = new ApiClient();
