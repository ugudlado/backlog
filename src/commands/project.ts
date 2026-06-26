import * as clack from "@clack/prompts";
import type { Command } from "commander";
import {
	readProjectsIndex,
	setCurrentProjectId,
	withRegistryLock,
	writeProjectsIndex,
} from "../utils/projects-index.ts";
import { applyFixes, scanWorkspaces, type WorkspaceIssue } from "./workspace-doctor.ts";

interface DoctorOptions {
	fix?: boolean;
	yes?: boolean;
}

async function runAction(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

function formatIssue(issue: WorkspaceIssue): string {
	const id = issue.entryId ?? "(no id)";
	const target = issue.kind === "stale-current-pointer" ? `current=${id}` : `${id} ${issue.path}`;
	return `  [${issue.kind}] ${target}`;
}

function pluralEntries(n: number): string {
	return `${n} ${n === 1 ? "entry" : "entries"}`;
}

function pluralIssues(n: number): string {
	return `${n} ${n === 1 ? "issue" : "issues"}`;
}

function printReport(issues: WorkspaceIssue[], totalEntries: number): void {
	if (issues.length === 0) {
		console.log(`Registry healthy — ${pluralEntries(totalEntries)}, no issues.`);
		return;
	}
	console.log(`Found ${pluralIssues(issues.length)} across ${pluralEntries(totalEntries)}:`);
	for (const issue of issues) {
		console.log(formatIssue(issue));
	}
}

async function doDoctor(opts: DoctorOptions): Promise<void> {
	const index = await readProjectsIndex();
	const issues = await scanWorkspaces(index.projects, index.current);

	printReport(issues, index.projects.length);

	if (issues.length === 0) {
		process.exit(0);
	}

	if (!opts.fix) {
		console.log("\nRun with --fix to repair (use --yes to skip the prompt).");
		process.exit(1);
	}

	if (!opts.yes) {
		const result = await clack.confirm({
			message: `Remove ${issues.length} broken entry/entries?`,
			initialValue: false,
		});
		if (clack.isCancel(result) || result !== true) {
			console.log("Aborted — registry left unchanged.");
			process.exit(1);
		}
	}

	await withRegistryLock(async () => {
		const fresh = await readProjectsIndex();
		const freshIssues = await scanWorkspaces(fresh.projects, fresh.current);
		const fixed = applyFixes(fresh.projects, freshIssues, fresh.current);
		const next = { ...fresh, workspaces: fixed.entries };
		if (fixed.current === undefined) {
			delete next.current;
		} else {
			next.current = fixed.current;
		}
		await writeProjectsIndex(next);
	});

	console.log(`Removed/repaired ${pluralIssues(issues.length)}.`);
	process.exit(0);
}

export function registerProjectCommand(program: Command): void {
	const proj = program.command("project").description("list and switch global-store projects");

	proj
		.command("list")
		.description("list all projects in the global store")
		.option("--plain", "emit JSON output")
		.action((opts: { plain?: boolean }) =>
			runAction(async () => {
				const { scanGlobalStoreProjects } = await import("../utils/global-store-scan.ts");
				const index = await readProjectsIndex();
				const projects = await scanGlobalStoreProjects();
				if (opts.plain) {
					console.log(
						JSON.stringify({
							current: index.current ?? null,
							projects: projects.map((p) => ({ id: p.id, name: p.name })),
						}),
					);
					return;
				}
				if (projects.length === 0) {
					console.log("No projects yet. Create one with `backlog init <name>`.");
					return;
				}
				for (const p of projects) {
					const marker = p.id === index.current ? "*" : " ";
					console.log(`${marker} ${p.name}\t${p.id}`);
				}
			}),
		);

	proj
		.command("switch <name>")
		.description("set the current project by name (or id)")
		.action((name: string) =>
			runAction(async () => {
				const { scanGlobalStoreProjects } = await import("../utils/global-store-scan.ts");
				const match = (await scanGlobalStoreProjects()).find((p) => p.name === name || p.id === name);
				if (!match) {
					console.error(`No project named "${name}".`);
					process.exit(1);
				}
				await setCurrentProjectId(match.id);
				console.log(`Switched to project ${match.name}`);
			}),
		);

	proj
		.command("create <name>")
		.description("create a new project in the global store")
		.option("--prefix <prefix>", "custom task prefix, letters only (default: task)")
		.action((name: string, opts: { prefix?: string }) =>
			runAction(async () => {
				let taskPrefix = opts.prefix;
				if (!taskPrefix && process.stdin.isTTY) {
					const entered = await clack.text({
						message: "Task prefix (default: task):",
						validate: (value) => {
							const v = String(value ?? "").trim();
							if (v && !/^[a-zA-Z]+$/.test(v)) return "Task prefix must contain only letters (a-z, A-Z).";
							return undefined;
						},
					});
					if (clack.isCancel(entered)) {
						console.log("Aborted.");
						process.exit(1);
					}
					taskPrefix = String(entered ?? "").trim() || undefined;
				}
				if (taskPrefix && !/^[a-zA-Z]+$/.test(taskPrefix)) {
					console.error("Task prefix must contain only letters (a-z, A-Z).");
					process.exit(1);
				}
				const { createGlobalProject } = await import("../core/init.ts");
				const result = await createGlobalProject(name, taskPrefix);
				if (!result.ok) {
					const msg =
						result.error === "no_global_store"
							? "globalStore is not configured. Set it in ~/.config/backlog/config.yml."
							: result.error === "invalid_name"
								? `Invalid project name: "${name}". It must not contain path separators or '..'.`
								: `A project named "${name}" already exists.`;
					console.error(msg);
					process.exit(1);
				}
				if (result.id) await setCurrentProjectId(result.id);
				console.log(`Created project ${name}`);
			}),
		);

	proj
		.command("delete <name>")
		.description("archive a project (moves its data to the global store's .archive; not destroyed)")
		.action((name: string) =>
			runAction(async () => {
				const { scanGlobalStoreProjects, archiveGlobalStoreProject } = await import("../utils/global-store-scan.ts");
				const match = (await scanGlobalStoreProjects()).find((p) => p.name === name || p.id === name);
				if (!match) {
					console.error(`No project named "${name}".`);
					process.exit(1);
				}
				const dest = await archiveGlobalStoreProject(match.id, Date.now());
				// If the archived project was current, clear the pointer.
				const index = await readProjectsIndex();
				if (index.current === match.id) {
					await setCurrentProjectId(null);
				}
				console.log(`Archived project ${match.name} -> ${dest}`);
			}),
		);

	// Registry maintenance for the local-mode fallback registry (advanced).
	proj
		.command("doctor")
		.description("scan the local-mode registry for drift; --fix to repair")
		.option("--fix", "remove broken/duplicate entries and clear stale current pointer")
		.option("--yes", "skip the confirmation prompt when --fix is supplied")
		.action((opts: DoctorOptions) => runAction(() => doDoctor(opts)));
}
