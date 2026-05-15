import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { Core } from "../core/backlog.ts";

/**
 * Migrate draft folder files to tasks/ with status: Draft.
 * This is a one-time migration for projects that used the old
 * backlog/drafts/ folder-based draft surface.
 */
async function migrateDraftsToTasks(cwd: string): Promise<void> {
	const core = new Core(cwd);
	const backlogDir = await core.filesystem.getBacklogDir();
	const draftsDir = join(backlogDir, "drafts");
	const tasksDir = join(backlogDir, "tasks");

	// Check if drafts directory exists
	let hasDrafts = false;
	try {
		const s = await stat(draftsDir);
		hasDrafts = s.isDirectory();
	} catch {
		hasDrafts = false;
	}

	if (!hasDrafts) {
		console.log("Nothing to migrate: backlog/drafts/ does not exist.");
		return;
	}

	const entries = await readdir(draftsDir);
	const draftFiles = entries.filter((e) => e.endsWith(".md"));

	if (draftFiles.length === 0) {
		console.log("Nothing to migrate: backlog/drafts/ is empty.");
		await rm(draftsDir, { recursive: true, force: true });
		return;
	}

	await mkdir(tasksDir, { recursive: true });

	let migrated = 0;
	for (const file of draftFiles) {
		const src = join(draftsDir, file);
		// Rename draft-N to task-N in filename if applicable
		const destName = file.replace(/^draft-/, "task-");
		const dest = join(tasksDir, destName);

		// Read, ensure status: Draft is set, write to tasks/
		const content = await Bun.file(src).text();
		const updatedContent = ensureDraftStatus(content);
		await Bun.write(dest, updatedContent);
		migrated++;
	}

	// Remove the drafts directory after migration
	await rm(draftsDir, { recursive: true, force: true });

	console.log(`Migrated ${migrated} draft${migrated === 1 ? "" : "s"} to backlog/tasks/ with status: Draft.`);
}

/**
 * Ensure the markdown frontmatter has status: Draft.
 * If status is missing or different, set it to Draft.
 */
function ensureDraftStatus(content: string): string {
	// Match frontmatter block
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) {
		// No frontmatter — prepend minimal draft frontmatter
		return `---\nstatus: Draft\n---\n\n${content}`;
	}

	const fm = fmMatch[1];
	if (/^status:/m.test(fm)) {
		// Replace existing status value
		return content.replace(/^(status:\s*).*$/m, "$1Draft");
	}

	// Insert status after last frontmatter line
	const updated = content.replace(/^(---\n)([\s\S]*?)(\n---)/, "$1$2\nstatus: Draft$3");
	return updated;
}

/**
 * Archive legacy backlog/docs/, backlog/decisions/, backlog/drafts/ folders
 * into backlog/archive/legacy-<YYYY-MM-DD>/. If the target already exists,
 * suffix with -1, -2, etc. for idempotence.
 */
async function archiveLegacy(cwd: string): Promise<void> {
	const core = new Core(cwd);
	const backlogDir = await core.filesystem.getBacklogDir();

	const legacyDirs = ["docs", "decisions", "drafts"];

	// Collect which legacy dirs exist
	const existing: string[] = [];
	for (const dir of legacyDirs) {
		try {
			const s = await stat(join(backlogDir, dir));
			if (s.isDirectory()) {
				existing.push(dir);
			}
		} catch {
			// not present
		}
	}

	if (existing.length === 0) {
		console.log("Nothing to archive: no legacy backlog/docs/, backlog/decisions/, or backlog/drafts/ found.");
		return;
	}

	// Determine archive target path
	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	const archiveBase = join(backlogDir, "archive");
	let targetName = `legacy-${today}`;
	let targetDir = join(archiveBase, targetName);
	let suffix = 0;
	while (true) {
		try {
			await stat(targetDir);
			// Already exists — try next suffix
			suffix++;
			targetName = `legacy-${today}-${suffix}`;
			targetDir = join(archiveBase, targetName);
		} catch {
			// Does not exist — use this path
			break;
		}
	}

	await mkdir(targetDir, { recursive: true });

	for (const dir of existing) {
		const src = join(backlogDir, dir);
		const dest = join(targetDir, dir);
		await rename(src, dest);
	}

	console.log(`Archived ${existing.join(", ")} to backlog/archive/${targetName}/.`);
}

export function registerMigrateCommand(program: Command): void {
	const migrate = program.command("migrate").description("one-time migration helpers for legacy backlog structures");

	migrate
		.command("drafts-to-tasks")
		.description("move backlog/drafts/ files to backlog/tasks/ with status: Draft")
		.action(async () => {
			try {
				await migrateDraftsToTasks(process.cwd());
			} catch (err) {
				console.error("Migration failed:", err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});

	migrate
		.command("archive-legacy")
		.description("move backlog/docs/, backlog/decisions/, backlog/drafts/ into backlog/archive/legacy-<date>/")
		.action(async () => {
			try {
				await archiveLegacy(process.cwd());
			} catch (err) {
				console.error("Archive failed:", err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}
