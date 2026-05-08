import * as clack from "@clack/prompts";
import type { Command } from "commander";
import {
	readWorkspacesIndex,
	setCurrentWorkspaceId,
	withRegistryLock,
	writeWorkspacesIndex,
} from "../utils/workspaces-index.ts";
import { applyFixes, scanWorkspaces, type WorkspaceIssue } from "./workspace-doctor.ts";

interface DoctorOptions {
	fix?: boolean;
	yes?: boolean;
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
	const index = await readWorkspacesIndex();
	const issues = await scanWorkspaces(index.workspaces, index.current);

	printReport(issues, index.workspaces.length);

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
		const fresh = await readWorkspacesIndex();
		const freshIssues = await scanWorkspaces(fresh.workspaces, fresh.current);
		const fixed = applyFixes(fresh.workspaces, freshIssues, fresh.current);
		const next = { ...fresh, workspaces: fixed.entries };
		if (fixed.current === undefined) {
			delete next.current;
		} else {
			next.current = fixed.current;
		}
		await writeWorkspacesIndex(next);
	});

	console.log(`Removed/repaired ${pluralIssues(issues.length)}.`);
	process.exit(0);
}

export function registerWorkspaceCommand(program: Command): void {
	const ws = program.command("workspace").description("manage the machine-wide workspace registry");

	ws.command("doctor")
		.description("scan the registry for drift; --fix to repair")
		.option("--fix", "remove broken/duplicate entries and clear stale current pointer")
		.option("--yes", "skip the confirmation prompt when --fix is supplied")
		.action(async (opts: DoctorOptions) => {
			try {
				await doDoctor(opts);
			} catch (err) {
				console.error(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});

	ws.command("list")
		.description("list all registered workspaces")
		.option("--plain", "emit JSON output")
		.action(async (opts: { plain?: boolean }) => {
			try {
				const index = await readWorkspacesIndex();
				if (opts.plain) {
					const payload = {
						current: index.current ?? null,
						workspaces: index.workspaces.map((w) => ({ id: w.id ?? null, path: w.path })),
					};
					console.log(JSON.stringify(payload));
					return;
				}
				if (index.workspaces.length === 0) {
					console.log("No workspaces registered.");
					return;
				}
				for (const w of index.workspaces) {
					const marker = w.id && w.id === index.current ? "*" : " ";
					const id = w.id ?? "(no id)";
					console.log(`${marker} ${id}\t${w.path}`);
				}
			} catch (err) {
				console.error(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});

	ws.command("switch <id>")
		.description("set the current workspace by id")
		.action(async (id: string) => {
			try {
				await setCurrentWorkspaceId(id);
				console.log(`Switched to workspace ${id}`);
			} catch (err) {
				console.error(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}
