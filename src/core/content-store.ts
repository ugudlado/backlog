import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { FileSystem } from "../file-system/operations.ts";
import { parseTask } from "../markdown/parser.ts";
import type { Task, TaskListFilter } from "../types/index.ts";
import { normalizeTaskId, normalizeTaskIdentity, taskIdsEqual } from "../utils/task-path.ts";
import { sortByTaskId } from "../utils/task-sorting.ts";

interface ContentSnapshot {
	tasks: Task[];
}

type ContentStoreEventType = "ready" | "tasks";

export type ContentStoreEvent =
	| { type: "ready"; snapshot: ContentSnapshot; version: number }
	| { type: "tasks"; tasks: Task[]; snapshot: ContentSnapshot; version: number };

export type ContentStoreListener = (event: ContentStoreEvent) => void;

interface WatchHandle {
	stop(): void;
}

export class ContentStore {
	private initialized = false;
	private initializing: Promise<void> | null = null;
	private version = 0;

	private readonly tasks = new Map<string, Task>();

	private cachedTasks: Task[] = [];

	private readonly listeners = new Set<ContentStoreListener>();
	private readonly watchers: WatchHandle[] = [];
	private restoreFilesystemPatch?: () => void;
	private chainTail: Promise<void> = Promise.resolve();
	private watchersInitialized = false;
	private configWatcherActive = false;

	private attachWatcherErrorHandler(watcher: FSWatcher, context: string): void {
		watcher.on("error", (error) => {
			if (process.env.DEBUG) {
				console.warn(`Watcher error (${context})`, error);
			}
		});
	}

	constructor(
		private readonly filesystem: FileSystem,
		private readonly taskLoader?: () => Promise<Task[]>,
		private readonly enableWatchers = false,
	) {
		this.patchFilesystem();
	}

	subscribe(listener: ContentStoreListener): () => void {
		this.listeners.add(listener);

		if (this.initialized) {
			listener({ type: "ready", snapshot: this.getSnapshot(), version: this.version });
		} else {
			void this.ensureInitialized();
		}

		return () => {
			this.listeners.delete(listener);
		};
	}

	async ensureInitialized(): Promise<ContentSnapshot> {
		if (this.initialized) {
			return this.getSnapshot();
		}

		if (!this.initializing) {
			this.initializing = this.loadInitialData().catch((error) => {
				this.initializing = null;
				throw error;
			});
		}

		await this.initializing;
		return this.getSnapshot();
	}

	getTasks(filter?: TaskListFilter): Task[] {
		if (!this.initialized) {
			throw new Error("ContentStore not initialized. Call ensureInitialized() first.");
		}

		let tasks = this.cachedTasks;
		if (filter?.status) {
			const statusLower = filter.status.toLowerCase();
			tasks = tasks.filter((task) => task.status.toLowerCase() === statusLower);
		}
		if (filter?.assignee) {
			const assignee = filter.assignee;
			tasks = tasks.filter((task) => task.assignee.includes(assignee));
		}
		if (filter?.priority) {
			const priority = filter.priority.toLowerCase();
			tasks = tasks.filter((task) => (task.priority ?? "").toLowerCase() === priority);
		}
		if (filter?.parentTaskId) {
			const parentFilter = filter.parentTaskId;
			tasks = tasks.filter((task) => task.parentTaskId && taskIdsEqual(parentFilter, task.parentTaskId));
		}

		return tasks.slice();
	}

	upsertTask(task: Task): void {
		if (!this.initialized) {
			return;
		}
		this.tasks.set(task.id, task);
		this.cachedTasks = sortByTaskId(Array.from(this.tasks.values()));
		this.notify("tasks");
	}

	getSnapshot(): ContentSnapshot {
		return {
			tasks: this.cachedTasks.slice(),
		};
	}

	dispose(): void {
		if (this.restoreFilesystemPatch) {
			this.restoreFilesystemPatch();
			this.restoreFilesystemPatch = undefined;
		}
		for (const watcher of this.watchers) {
			try {
				watcher.stop();
			} catch {
				// Ignore watcher shutdown errors
			}
		}
		this.watchers.length = 0;
		this.watchersInitialized = false;
	}

	private emit(event: ContentStoreEvent): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	private notify(type: ContentStoreEventType): void {
		this.version += 1;
		const snapshot = this.getSnapshot();

		if (type === "tasks") {
			this.emit({ type, tasks: snapshot.tasks, snapshot, version: this.version });
			return;
		}

		this.emit({ type: "ready", snapshot, version: this.version });
	}

	private async loadInitialData(): Promise<void> {
		await this.filesystem.ensureBacklogStructure();

		const tasks = await this.loadTasksWithLoader();

		this.replaceTasks(tasks);

		this.initialized = true;
		if (this.enableWatchers) {
			await this.setupWatchers();
		}
		this.notify("ready");
	}

	private async setupWatchers(): Promise<void> {
		if (this.watchersInitialized) return;
		this.watchersInitialized = true;

		try {
			this.watchers.push(this.createTaskWatcher());
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to initialize task watcher", error);
			}
		}

		try {
			const configWatcher = this.createConfigWatcher();
			if (configWatcher) {
				this.watchers.push(configWatcher);
				this.configWatcherActive = true;
			}
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to initialize config watcher", error);
			}
		}
	}

	/**
	 * Retry setting up the config watcher after initialization.
	 * Called when the config file is created after the server started.
	 */
	ensureConfigWatcher(): void {
		if (this.configWatcherActive) {
			return;
		}
		try {
			const configWatcher = this.createConfigWatcher();
			if (configWatcher) {
				this.watchers.push(configWatcher);
				this.configWatcherActive = true;
			}
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to setup config watcher after init", error);
			}
		}
	}

	private createConfigWatcher(): WatchHandle | null {
		const configPath = this.filesystem.configFilePath;
		try {
			const watcher: FSWatcher = watch(configPath, (eventType) => {
				if (eventType !== "change" && eventType !== "rename") {
					return;
				}
				this.enqueue(async () => {
					this.filesystem.invalidateConfigCache();
					this.notify("tasks");
				});
			});
			this.attachWatcherErrorHandler(watcher, "config");

			return {
				stop() {
					watcher.close();
				},
			};
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to watch config file", error);
			}
			return null;
		}
	}

	private createTaskWatcher(): WatchHandle {
		const tasksDir = this.filesystem.tasksDir;
		const watcher: FSWatcher = watch(tasksDir, { recursive: false }, (eventType, filename) => {
			const file = this.normalizeFilename(filename);
			// Accept any prefix pattern (task-, jira-, etc.) followed by ID and ending in .md
			if (!file || !/^[a-zA-Z]+-/.test(file) || !file.endsWith(".md")) {
				this.enqueue(async () => {
					await this.refreshTasksFromDisk();
				});
				return;
			}

			this.enqueue(async () => {
				const [taskId] = file.split(" ");
				if (!taskId) return;
				const normalizedTaskId = normalizeTaskId(taskId);

				const fullPath = join(tasksDir, file);
				const exists = await Bun.file(fullPath).exists();

				if (!exists) {
					if (this.tasks.delete(normalizedTaskId)) {
						this.cachedTasks = sortByTaskId(Array.from(this.tasks.values()));
						this.notify("tasks");
					}
					return;
				}

				if (eventType === "rename" && exists) {
					await this.refreshTasksFromDisk();
					return;
				}

				const previous = this.tasks.get(normalizedTaskId);
				const task = await this.retryRead(
					async () => {
						const stillExists = await Bun.file(fullPath).exists();
						if (!stillExists) {
							return null;
						}
						const content = await Bun.file(fullPath).text();
						return normalizeTaskIdentity(parseTask(content));
					},
					(result) => {
						if (!result) {
							return false;
						}
						if (!taskIdsEqual(result.id, normalizedTaskId)) {
							return false;
						}
						if (!previous) {
							return true;
						}
						return this.hasTaskChanged(previous, result);
					},
				);
				if (!task) {
					await this.refreshTasksFromDisk(normalizedTaskId, previous);
					return;
				}

				this.tasks.set(task.id, task);
				this.cachedTasks = sortByTaskId(Array.from(this.tasks.values()));
				this.notify("tasks");
			});
		});
		this.attachWatcherErrorHandler(watcher, "tasks");

		return {
			stop() {
				watcher.close();
			},
		};
	}

	private normalizeFilename(value: string | Buffer | null | undefined): string | null {
		if (typeof value === "string") {
			return value;
		}
		if (value instanceof Buffer) {
			return value.toString();
		}
		return null;
	}

	private replaceTasks(tasks: Task[]): void {
		this.tasks.clear();
		for (const task of tasks) {
			this.tasks.set(task.id, task);
		}
		this.cachedTasks = sortByTaskId(Array.from(this.tasks.values()));
	}

	private patchFilesystem(): void {
		if (this.restoreFilesystemPatch) {
			return;
		}

		const originalSaveTask = this.filesystem.saveTask;

		this.filesystem.saveTask = (async (task: Task): Promise<string> => {
			const result = await originalSaveTask.call(this.filesystem, task);
			await this.handleTaskWrite(task.id);
			return result;
		}) as FileSystem["saveTask"];

		this.restoreFilesystemPatch = () => {
			this.filesystem.saveTask = originalSaveTask;
		};
	}

	private async handleTaskWrite(taskId: string): Promise<void> {
		if (!this.initialized) {
			return;
		}
		await this.updateTaskFromDisk(taskId);
	}

	private hasTaskChanged(previous: Task, next: Task): boolean {
		return JSON.stringify(previous) !== JSON.stringify(next);
	}

	private async refreshTasksFromDisk(expectedId?: string, previous?: Task): Promise<void> {
		const tasks = await this.retryRead(
			async () => this.loadTasksWithLoader(),
			(expected) => {
				if (!expectedId) {
					return true;
				}
				const match = expected.find((task) => taskIdsEqual(task.id, expectedId));
				if (!match) {
					return false;
				}
				if (previous && !this.hasTaskChanged(previous, match)) {
					return false;
				}
				return true;
			},
		);
		if (!tasks) {
			return;
		}
		this.replaceTasks(tasks);
		this.notify("tasks");
	}

	private async updateTaskFromDisk(taskId: string): Promise<void> {
		const normalizedTaskId = normalizeTaskId(taskId);
		const previous = this.tasks.get(normalizedTaskId);
		const task = await this.retryRead(
			async () => this.filesystem.loadTask(taskId),
			(result) => result !== null && (!previous || this.hasTaskChanged(previous, result)),
		);
		if (!task) {
			return;
		}
		this.tasks.set(task.id, task);
		this.cachedTasks = sortByTaskId(Array.from(this.tasks.values()));
		this.notify("tasks");
	}

	private async retryRead<T>(
		loader: () => Promise<T>,
		isValid: (result: T) => boolean = (value) => value !== null && value !== undefined,
		attempts = 12,
		delayMs = 75,
	): Promise<T | null> {
		let lastError: unknown = null;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				const result = await loader();
				if (isValid(result)) {
					return result;
				}
			} catch (error) {
				lastError = error;
			}
			if (attempt < attempts) {
				await this.delay(delayMs * attempt);
			}
		}

		if (lastError && process.env.DEBUG) {
			console.error("ContentStore retryRead exhausted attempts", lastError);
		}
		return null;
	}

	private async delay(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	private enqueue(fn: () => Promise<void>): void {
		this.chainTail = this.chainTail
			.then(() => fn())
			.catch((error) => {
				if (process.env.DEBUG) {
					console.error("ContentStore update failed", error);
				}
			});
	}

	private async loadTasksWithLoader(): Promise<Task[]> {
		if (this.taskLoader) {
			return await this.taskLoader();
		}
		return await this.filesystem.listTasks();
	}
}

export type { ContentSnapshot };
