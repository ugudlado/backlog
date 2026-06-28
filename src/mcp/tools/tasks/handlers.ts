import { basename, join } from "node:path";
import { isCreateLockError } from "../../../file-system/operations.ts";
import {
	isLocalEditableTask,
	type SearchPriorityFilter,
	type Task,
	type TaskListFilter,
} from "../../../types/index.ts";
import type { TaskEditArgs, TaskEditRequest } from "../../../types/task-edit-args.ts";
import { resolveMilestoneInputForStorage } from "../../../utils/milestone-storage.ts";
import {
	isRemoteMode,
	RemoteBackendError,
	remoteGetConfig,
	remoteSearch,
	remoteTaskArchive,
	remoteTaskComplete,
	remoteTaskCreate,
	remoteTaskEdit,
	remoteTaskList,
	remoteTaskNext,
	remoteTaskView,
} from "../../../utils/remote-backend.ts";
import { buildTaskUpdateInput } from "../../../utils/task-edit-builder.ts";
import { createTaskSearchIndex } from "../../../utils/task-search.ts";
import { sortByOrdinalAndPriority } from "../../../utils/task-sorting.ts";
import { BacklogToolError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { formatTaskCallResult } from "../../utils/task-response.ts";

export type TaskCreateArgs = {
	title: string;
	description?: string;
	labels?: string[];
	assignee?: string[];
	priority?: "high" | "medium" | "low";
	ordinal?: number;
	status?: string;
	milestone?: string;
	parentTaskId?: string;
	acceptanceCriteria?: string[];
	definitionOfDoneAdd?: string[];
	disableDefinitionOfDoneDefaults?: boolean;
	dependencies?: string[];
	references?: string[];
	documentation?: string[];
	modifiedFiles?: string[];
	finalSummary?: string;
};

export type TaskListArgs = {
	status?: string;
	assignee?: string;
	milestone?: string;
	labels?: string[];
	search?: string;
	limit?: number;
};

export type TaskSearchArgs = {
	query?: string;
	status?: string;
	priority?: SearchPriorityFilter;
	modifiedFiles?: string[];
	limit?: number;
};

export class TaskHandlers {
	constructor(private readonly core: McpServer) {}

	private wrapRemoteError(error: unknown): never {
		if (error instanceof RemoteBackendError) {
			const code = error.status === 401 ? "OPERATION_FAILED" : "OPERATION_FAILED";
			throw new BacklogToolError(error.message, code);
		}
		throw error;
	}

	private async loadRemoteConfig() {
		try {
			return await remoteGetConfig();
		} catch (error) {
			this.wrapRemoteError(error);
		}
	}

	private async resolveMilestoneInput(milestone: string): Promise<string> {
		const [activeMilestones, archivedMilestones] = await Promise.all([
			this.core.filesystem.listMilestones(),
			this.core.filesystem.listArchivedMilestones(),
		]);
		return resolveMilestoneInputForStorage(milestone, activeMilestones, archivedMilestones);
	}

	private isDoneStatus(status?: string | null): boolean {
		const normalized = (status ?? "").trim().toLowerCase();
		return normalized.includes("done") || normalized.includes("complete");
	}

	private formatTaskSummaryLine(task: Task, options: { includeStatus?: boolean } = {}): string {
		const priorityIndicator = task.priority ? `[${task.priority.toUpperCase()}] ` : "";
		const status = task.status || (task.source === "completed" ? "Done" : "");
		const statusText = options.includeStatus && status ? ` (${status})` : "";
		return `  ${priorityIndicator}${task.id} - ${task.title}${statusText}`;
	}

	private async loadTaskOrThrow(id: string): Promise<Task> {
		if (isRemoteMode()) {
			try {
				return await remoteTaskView(id);
			} catch (error) {
				this.wrapRemoteError(error);
			}
		}

		const task = await this.core.getTask(id);
		if (!task) {
			throw new BacklogToolError(`Task not found: ${id}`, "TASK_NOT_FOUND");
		}
		return task;
	}

	private formatGroupedTaskList(
		tasks: Task[],
		statuses: string[],
		limit?: number,
	): Array<{ type: "text"; text: string }> {
		const canonicalByLower = new Map<string, string>();
		for (const status of statuses) {
			canonicalByLower.set(status.toLowerCase(), status);
		}

		const grouped = new Map<string, Task[]>();
		for (const task of tasks) {
			const rawStatus = (task.status ?? "").trim();
			const canonicalStatus = canonicalByLower.get(rawStatus.toLowerCase()) ?? rawStatus;
			const bucketKey = canonicalStatus || "";
			const existing = grouped.get(bucketKey) ?? [];
			existing.push(task);
			grouped.set(bucketKey, existing);
		}

		const orderedStatuses = [
			...statuses.filter((status) => grouped.has(status)),
			...Array.from(grouped.keys()).filter((status) => !statuses.includes(status)),
		];

		const contentItems: Array<{ type: "text"; text: string }> = [];
		let remaining = typeof limit === "number" && limit >= 0 ? limit : undefined;
		for (const status of orderedStatuses) {
			const bucket = grouped.get(status) ?? [];
			const sortedBucket = sortByOrdinalAndPriority(bucket);
			const limitedBucket = remaining !== undefined ? sortedBucket.slice(0, remaining) : sortedBucket;
			if (remaining !== undefined) {
				remaining -= limitedBucket.length;
			}
			if (limitedBucket.length === 0) {
				continue;
			}
			const sectionLines: string[] = [`${status || "No Status"}:`];
			for (const task of limitedBucket) {
				sectionLines.push(this.formatTaskSummaryLine(task));
			}
			contentItems.push({
				type: "text",
				text: sectionLines.join("\n"),
			});
		}

		return contentItems;
	}

	async createTask(args: TaskCreateArgs): Promise<CallToolResult> {
		if (isRemoteMode()) {
			try {
				const createdTask = await remoteTaskCreate({
					title: args.title,
					description: args.description,
					status: args.status,
					priority: args.priority,
					assignee: args.assignee,
					labels: args.labels,
					milestone: args.milestone,
					parentTaskId: args.parentTaskId,
					dependencies: args.dependencies,
					references: args.references,
					documentation: args.documentation,
					modifiedFiles: args.modifiedFiles,
					acceptanceCriteria: args.acceptanceCriteria,
					definitionOfDoneAdd: args.definitionOfDoneAdd,
					disableDefinitionOfDoneDefaults: args.disableDefinitionOfDoneDefaults,
					finalSummary: args.finalSummary,
				});
				return await formatTaskCallResult(createdTask);
			} catch (error) {
				this.wrapRemoteError(error);
			}
		}

		try {
			const rawOrdinal = (args as { ordinal?: unknown }).ordinal;
			if (rawOrdinal === null) {
				throw new BacklogToolError("Ordinal must be a non-negative number.", "VALIDATION_ERROR");
			}

			const acceptanceCriteria =
				args.acceptanceCriteria
					?.map((text) => String(text).trim())
					.filter((text) => text.length > 0)
					.map((text) => ({ text, checked: false })) ?? undefined;

			const milestone =
				typeof args.milestone === "string" ? await this.resolveMilestoneInput(args.milestone) : undefined;

			const { task: createdTask } = await this.core.createTaskFromInput({
				title: args.title,
				description: args.description,
				status: args.status,
				priority: args.priority,
				...(typeof rawOrdinal === "number" ? { ordinal: rawOrdinal } : {}),
				milestone,
				labels: args.labels,
				assignee: args.assignee,
				dependencies: args.dependencies,
				references: args.references,
				documentation: args.documentation,
				modifiedFiles: args.modifiedFiles,
				parentTaskId: args.parentTaskId,
				finalSummary: args.finalSummary,
				acceptanceCriteria,
				definitionOfDoneAdd: args.definitionOfDoneAdd,
				disableDefinitionOfDoneDefaults: args.disableDefinitionOfDoneDefaults,
			});

			return await formatTaskCallResult(createdTask);
		} catch (error) {
			if (isCreateLockError(error)) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			if (error instanceof Error) {
				throw new BacklogToolError(error.message, "VALIDATION_ERROR");
			}
			throw new BacklogToolError(String(error), "VALIDATION_ERROR");
		}
	}

	async listTasks(args: TaskListArgs = {}): Promise<CallToolResult> {
		if (isRemoteMode()) {
			try {
				const config = await this.loadRemoteConfig();
				const tasks = await remoteTaskList({
					status: args.status,
					assignee: args.assignee,
					milestone: args.milestone,
					labels: args.labels,
				});

				let filtered = tasks;
				if (args.search?.trim()) {
					const query = args.search.trim().toLowerCase();
					filtered = filtered.filter(
						(task) =>
							task.title.toLowerCase().includes(query) || (task.description ?? "").toLowerCase().includes(query),
					);
				}

				if (filtered.length === 0) {
					return { content: [{ type: "text", text: "No tasks found." }] };
				}

				const contentItems = this.formatGroupedTaskList(filtered, config.statuses ?? [], args.limit);
				if (contentItems.length === 0) {
					return { content: [{ type: "text", text: "No tasks found." }] };
				}

				return { content: contentItems };
			} catch (error) {
				this.wrapRemoteError(error);
			}
		}

		const filters: TaskListFilter = {};
		if (args.status) {
			filters.status = args.status;
		}
		if (args.assignee) {
			filters.assignee = args.assignee;
		}
		if (args.milestone) {
			filters.milestone = args.milestone;
		}

		const tasks = await this.core.queryTasks({
			query: args.search,
			filters: Object.keys(filters).length > 0 ? filters : undefined,
			includeCrossBranch: false,
		});

		let filteredByLabels = tasks.filter((task) => isLocalEditableTask(task));
		const labelFilters = args.labels ?? [];
		if (labelFilters.length > 0) {
			filteredByLabels = filteredByLabels.filter((task) => {
				const taskLabels = task.labels ?? [];
				return labelFilters.every((label) => taskLabels.includes(label));
			});
		}

		if (filteredByLabels.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No tasks found.",
					},
				],
			};
		}

		const config = await this.core.filesystem.loadConfig();
		const contentItems = this.formatGroupedTaskList(filteredByLabels, config?.statuses ?? [], args.limit);

		if (contentItems.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No tasks found.",
					},
				],
			};
		}

		return {
			content: contentItems,
		};
	}

	async searchTasks(args: TaskSearchArgs): Promise<CallToolResult> {
		const query = args.query?.trim() ?? "";
		const modifiedFiles = args.modifiedFiles?.map((file) => file.trim()).filter((file) => file.length > 0);
		if (!query && (!modifiedFiles || modifiedFiles.length === 0)) {
			throw new BacklogToolError("Search query or modifiedFiles filter is required", "VALIDATION_ERROR");
		}

		if (isRemoteMode()) {
			try {
				const results = await remoteSearch({
					query,
					status: args.status,
					priority: args.priority,
					modifiedFiles,
					limit: args.limit,
				});
				const taskResults = results.filter((result) => result.type === "task").map((result) => result.task);
				if (taskResults.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No tasks found for "${query || modifiedFiles?.join(", ")}".`,
							},
						],
					};
				}

				const lines: string[] = ["Tasks:"];
				for (const task of taskResults) {
					lines.push(this.formatTaskSummaryLine(task, { includeStatus: true }));
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
				};
			} catch (error) {
				this.wrapRemoteError(error);
			}
		}

		const tasks = await this.core.loadTasks(undefined, undefined, { includeCompleted: true });
		const searchIndex = createTaskSearchIndex(tasks);
		let taskMatches = searchIndex.search({
			query,
			status: args.status,
			priority: args.priority,
			modifiedFiles,
		});
		if (typeof args.limit === "number" && args.limit >= 0) {
			taskMatches = taskMatches.slice(0, args.limit);
		}

		const taskResults = taskMatches.filter((task) => isLocalEditableTask(task));
		if (taskResults.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No tasks found for "${query || modifiedFiles?.join(", ")}".`,
					},
				],
			};
		}

		const lines: string[] = ["Tasks:"];
		for (const task of taskResults) {
			lines.push(this.formatTaskSummaryLine(task, { includeStatus: true }));
		}

		return {
			content: [
				{
					type: "text",
					text: lines.join("\n"),
				},
			],
		};
	}

	async viewTask(args: { id: string }): Promise<CallToolResult> {
		if (isRemoteMode()) {
			try {
				const task = await remoteTaskView(args.id);
				return await formatTaskCallResult(task);
			} catch (error) {
				this.wrapRemoteError(error);
			}
		}

		const task = await this.core.getTaskWithSubtasks(args.id);
		if (!task) {
			throw new BacklogToolError(`Task not found: ${args.id}`, "TASK_NOT_FOUND");
		}
		return await formatTaskCallResult(task);
	}

	async archiveTask(args: { id: string }): Promise<CallToolResult> {
		if (isRemoteMode()) {
			try {
				const task = await this.loadTaskOrThrow(args.id);
				if (this.isDoneStatus(task.status)) {
					throw new BacklogToolError(
						`Task ${task.id} is Done. Done tasks should be completed (moved to the completed folder), not archived. Use task_complete instead.`,
						"VALIDATION_ERROR",
					);
				}
				await remoteTaskArchive(task.id);
				return await formatTaskCallResult(task);
			} catch (error) {
				if (error instanceof BacklogToolError) {
					throw error;
				}
				this.wrapRemoteError(error);
			}
		}

		const task = await this.loadTaskOrThrow(args.id);

		if (!isLocalEditableTask(task)) {
			throw new BacklogToolError(`Cannot archive task from another branch: ${task.id}`, "VALIDATION_ERROR");
		}

		if (this.isDoneStatus(task.status)) {
			throw new BacklogToolError(
				`Task ${task.id} is Done. Done tasks should be completed (moved to the completed folder), not archived. Use task_complete instead.`,
				"VALIDATION_ERROR",
			);
		}

		const success = await this.core.archiveTask(task.id);
		if (!success) {
			throw new BacklogToolError(`Failed to archive task: ${args.id}`, "OPERATION_FAILED");
		}

		const refreshed = (await this.core.getTask(task.id)) ?? task;
		return await formatTaskCallResult(refreshed);
	}

	async completeTask(args: { id: string }): Promise<CallToolResult> {
		if (isRemoteMode()) {
			try {
				const task = await this.loadTaskOrThrow(args.id);
				if (!this.isDoneStatus(task.status)) {
					throw new BacklogToolError(
						`Task ${task.id} is not Done. Set status to "Done" with task_edit before completing it.`,
						"VALIDATION_ERROR",
					);
				}
				await remoteTaskComplete(task.id);
				return await formatTaskCallResult(task, [`Completed task ${task.id}.`]);
			} catch (error) {
				if (error instanceof BacklogToolError) {
					throw error;
				}
				this.wrapRemoteError(error);
			}
		}

		const task = await this.loadTaskOrThrow(args.id);

		if (!isLocalEditableTask(task)) {
			throw new BacklogToolError(`Cannot complete task from another branch: ${task.id}`, "VALIDATION_ERROR");
		}

		if (!this.isDoneStatus(task.status)) {
			throw new BacklogToolError(
				`Task ${task.id} is not Done. Set status to "Done" with task_edit before completing it.`,
				"VALIDATION_ERROR",
			);
		}

		const filePath = task.filePath ?? null;
		const completedFilePath = filePath ? join(this.core.filesystem.completedDir, basename(filePath)) : undefined;

		const success = await this.core.completeTask(task.id);
		if (!success) {
			throw new BacklogToolError(`Failed to complete task: ${args.id}`, "OPERATION_FAILED");
		}

		return await formatTaskCallResult(task, [`Completed task ${task.id}.`], {
			filePathOverride: completedFilePath,
		});
	}

	async demoteTask(args: { id: string }): Promise<CallToolResult> {
		const task = await this.loadTaskOrThrow(args.id);
		let success: boolean;
		try {
			success = await this.core.demoteTask(task.id);
		} catch (error) {
			if (isCreateLockError(error)) {
				throw new BacklogToolError(error.message, "OPERATION_FAILED");
			}
			throw error;
		}
		if (!success) {
			throw new BacklogToolError(`Failed to demote task: ${args.id}`, "OPERATION_FAILED");
		}

		const refreshed = (await this.core.getTask(task.id)) ?? task;
		return await formatTaskCallResult(refreshed);
	}

	async editTask(args: TaskEditRequest): Promise<CallToolResult> {
		if (isRemoteMode()) {
			try {
				const rawOrdinal = (args as { ordinal?: unknown }).ordinal;
				if (rawOrdinal === null) {
					throw new BacklogToolError("Ordinal must be a non-negative number.", "VALIDATION_ERROR");
				}

				const updateInput = buildTaskUpdateInput(args);
				const updatedTask = await remoteTaskEdit(args.id, updateInput);
				return await formatTaskCallResult(updatedTask);
			} catch (error) {
				if (error instanceof BacklogToolError) {
					throw error;
				}
				this.wrapRemoteError(error);
			}
		}

		try {
			const rawOrdinal = (args as { ordinal?: unknown }).ordinal;
			if (rawOrdinal === null) {
				throw new BacklogToolError("Ordinal must be a non-negative number.", "VALIDATION_ERROR");
			}

			const updateInput = buildTaskUpdateInput(args);
			if (typeof updateInput.milestone === "string") {
				updateInput.milestone = await this.resolveMilestoneInput(updateInput.milestone);
			}
			const updatedTask = await this.core.editTask(args.id, updateInput);
			return await formatTaskCallResult(updatedTask);
		} catch (error) {
			if (error instanceof Error) {
				throw new BacklogToolError(error.message, "VALIDATION_ERROR");
			}
			throw new BacklogToolError(String(error), "VALIDATION_ERROR");
		}
	}

	async nextTask(args: { status?: string; agent?: string }): Promise<CallToolResult> {
		if (isRemoteMode()) {
			try {
				const result = await remoteTaskNext({ status: args.status, agent: args.agent });
				if (!result) {
					const displayStatus = args.status ?? "Ready";
					throw new BacklogToolError(`No tasks found with status "${displayStatus}".`, "OPERATION_FAILED");
				}
				const { task, previousStatus } = result;
				return await formatTaskCallResult(task, [`Claimed task ${task.id}.`, `${previousStatus} → In Progress`]);
			} catch (error) {
				if (error instanceof BacklogToolError) {
					throw error;
				}
				this.wrapRemoteError(error);
			}
		}

		let result: Awaited<ReturnType<typeof this.core.claimTask>>;
		try {
			result = await this.core.claimTask({ status: args.status, agent: args.agent });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = message.startsWith("Invalid status") ? "VALIDATION_ERROR" : "OPERATION_FAILED";
			throw new BacklogToolError(message, code);
		}

		if (!result) {
			const displayStatus = await this.core.resolveClaimStatus(args.status);
			throw new BacklogToolError(`No tasks found with status "${displayStatus}".`, "OPERATION_FAILED");
		}

		const { task, previousStatus } = result;
		return await formatTaskCallResult(task, [`Claimed task ${task.id}.`, `${previousStatus} → In Progress`]);
	}
}

export type { TaskEditArgs, TaskEditRequest };
