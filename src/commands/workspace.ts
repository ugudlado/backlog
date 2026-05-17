import type { Command } from "commander";
import {
	getWorkspaceFilePath,
	readCurrentWorkspaceName,
	scanWorkspaces,
	setCurrentWorkspaceName,
} from "../utils/workspace-store.ts";

async function runAction(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

async function useWorkspace(name: string): Promise<void> {
	const records = await scanWorkspaces();
	if (!records.some((r) => r.name === name)) {
		const known = records.map((r) => r.name).join(", ") || "(none)";
		throw new Error(`No workspace named "${name}". Known workspaces: ${known}`);
	}
	await setCurrentWorkspaceName(name);
	console.log(`Switched to workspace ${name}`);
}

export function registerWorkspaceCommand(program: Command): void {
	const ws = program.command("workspace").description("manage the machine-wide workspace registry");

	ws.command("list")
		.description("list all registered workspaces")
		.option("--plain", "emit JSON output")
		.action((opts: { plain?: boolean }) =>
			runAction(async () => {
				const records = await scanWorkspaces();
				const current = readCurrentWorkspaceName();
				if (opts.plain) {
					console.log(
						JSON.stringify({
							current: current ?? null,
							workspaces: records.map((r) => ({
								name: r.name,
								repo: r.repo,
								data: r.data,
								file: getWorkspaceFilePath(r.name),
							})),
						}),
					);
					return;
				}
				if (records.length === 0) {
					console.log("No workspaces registered.");
					return;
				}
				for (const r of records) {
					const marker = r.name === current ? "*" : " ";
					console.log(`${marker} ${r.name}\t${r.repo}`);
				}
			}),
		);

	ws.command("use <name>")
		.description("set the current workspace by name")
		.action((name: string) => runAction(() => useWorkspace(name)));

	// Backward-compatible alias for the pre-simplification `workspace switch`.
	ws.command("switch <name>")
		.description("alias of `workspace use`")
		.action((name: string) => runAction(() => useWorkspace(name)));
}
