import * as clack from "@clack/prompts";
import type { Command } from "commander";
import { readProjectsIndex, setCurrentProjectId } from "../utils/projects-index.ts";
import { isRemoteMode, remoteListProjects, remoteSetCurrentProject } from "../utils/remote-backend.ts";

async function runAction(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

export function registerProjectCommand(program: Command): void {
	const proj = program.command("project").description("list and switch global-store projects");

	proj
		.command("list")
		.description("list all projects in the global store")
		.option("--plain", "emit JSON output")
		.action((opts: { plain?: boolean }) =>
			runAction(async () => {
				// Remote mode: list the server's projects, mirroring task commands.
				const { projects, current } = isRemoteMode()
					? await remoteListProjects().then((r) => ({ projects: r.projects, current: r.currentId }))
					: await (async () => {
							const { scanGlobalStoreProjects } = await import("../utils/global-store-scan.ts");
							const index = await readProjectsIndex();
							return { projects: await scanGlobalStoreProjects(), current: index.current ?? null };
						})();

				if (opts.plain) {
					console.log(
						JSON.stringify({
							current: current ?? null,
							projects: projects.map((p) => ({ id: p.id, name: p.name })),
						}),
					);
					return;
				}
				if (projects.length === 0) {
					console.log("No projects yet. Create one with `backlog project create <name>`.");
					return;
				}
				for (const p of projects) {
					const marker = p.id === current ? "*" : " ";
					console.log(`${marker} ${p.name}\t${p.id}`);
				}
			}),
		);

	proj
		.command("switch <name>")
		.description("set the current project by name (or id)")
		.action((name: string) =>
			runAction(async () => {
				// Remote mode: switch the server's current project, mirroring task commands.
				if (isRemoteMode()) {
					const { projects } = await remoteListProjects();
					const match = projects.find((p) => p.name === name || p.id === name);
					if (!match) {
						console.error(`No project named "${name}".`);
						process.exit(1);
					}
					await remoteSetCurrentProject(match.id);
					console.log(`Switched to project ${match.name}`);
					return;
				}
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
				if (isRemoteMode()) {
					console.error("`project create` is not supported in remote mode. Create projects on the server directly.");
					process.exit(1);
				}
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
				if (isRemoteMode()) {
					console.error("`project delete` is not supported in remote mode. Manage projects on the server directly.");
					process.exit(1);
				}
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
}
