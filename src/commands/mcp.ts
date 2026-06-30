/**
 * MCP Command Group - Model Context Protocol CLI commands.
 *
 * This simplified command set focuses on the stdio transport, which is the
 * only supported transport for Backlog.md's local MCP integration.
 */

import { spawn } from "bun";
import type { Command } from "commander";
import { createMcpServer } from "../mcp/server.ts";
import { findBacklogRoot } from "../utils/find-backlog-root.ts";
import { isRemoteMode } from "../utils/remote-backend.ts";
import { resolveRuntimeCwd } from "../utils/runtime-cwd.ts";

type StartOptions = {
	debug?: boolean;
	cwd?: string;
};

/** Always "backlog" so fallback mode works when a project isn't selected. */
const MCP_SERVER_NAME = "backlog";

/** The `<tool> mcp add ...` invocation that registers the backlog MCP server with each client. */
const MCP_CLIENTS: Record<string, { label: string; command: string; args: string[] }> = {
	claude: {
		label: "Claude Code",
		command: "claude",
		args: ["mcp", "add", "-s", "user", MCP_SERVER_NAME, "--", "backlog", "mcp", "start"],
	},
	codex: { label: "OpenAI Codex", command: "codex", args: ["mcp", "add", MCP_SERVER_NAME, "backlog", "mcp", "start"] },
	gemini: {
		label: "Gemini CLI",
		command: "gemini",
		args: ["mcp", "add", "-s", "user", MCP_SERVER_NAME, "backlog", "mcp", "start"],
	},
	kiro: {
		label: "Kiro",
		command: "kiro-cli",
		args: ["mcp", "add", "--scope", "global", "--name", MCP_SERVER_NAME, "--command", "backlog", "--args", "mcp,start"],
	},
};

/**
 * Register MCP command group with CLI program.
 *
 * @param program - Commander program instance
 */
export function registerMcpCommand(program: Command): void {
	const mcpCmd = program.command("mcp");
	registerStartCommand(mcpCmd);
	registerInstallCommand(mcpCmd);
}

/**
 * Register 'mcp install <client>' — wire the backlog MCP server into an AI tool.
 * Once-per-machine setup, independent of any project.
 */
function registerInstallCommand(mcpCmd: Command): void {
	mcpCmd
		.command("install <client>")
		.description(`register the backlog MCP server with an AI tool (${Object.keys(MCP_CLIENTS).join(", ")})`)
		.action(async (client: string) => {
			const entry = MCP_CLIENTS[client.toLowerCase()];
			if (!entry) {
				console.error(`Unknown client "${client}". Valid clients: ${Object.keys(MCP_CLIENTS).join(", ")}.`);
				process.exit(1);
			}
			console.log(`Configuring ${entry.label}...`);
			try {
				await spawn({ cmd: [entry.command, ...entry.args], stdout: "inherit", stderr: "inherit" }).exited;
				console.log(`✓ Added backlog MCP server to ${entry.label}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`⚠️ Unable to configure ${entry.label} automatically (${message}).`);
				console.warn(`   Run manually: ${entry.command} ${entry.args.join(" ")}`);
				process.exit(1);
			}
		});
}

/**
 * Register 'mcp start' command for stdio transport.
 */
function registerStartCommand(mcpCmd: Command): void {
	mcpCmd
		.command("start")
		.description("Start the MCP server using stdio transport")
		.option("-d, --debug", "Enable debug logging", false)
		.option("--cwd <path>", "Directory to resolve Backlog root from (overrides BACKLOG_CWD)")
		.action(async (options: StartOptions) => {
			try {
				const runtimeCwd = await resolveRuntimeCwd({ cwd: options.cwd });
				let projectRoot = runtimeCwd.cwd;
				if (!isRemoteMode()) {
					projectRoot = (await findBacklogRoot(runtimeCwd.cwd)) ?? runtimeCwd.cwd;
				}
				const server = await createMcpServer(projectRoot, { debug: options.debug });

				await server.connect();
				await server.start();

				if (options.debug) {
					if (runtimeCwd.source !== "process") {
						console.error(`Using MCP start directory from ${runtimeCwd.sourceLabel}: ${runtimeCwd.cwd}`);
					}
					console.error("Backlog.md MCP server started (stdio transport)");
				}

				let shutdownTriggered = false;
				const shutdown = async (signal: string) => {
					if (shutdownTriggered) {
						return;
					}
					shutdownTriggered = true;
					if (options.debug) {
						console.error(`Received ${signal}, shutting down MCP server...`);
					}

					try {
						await server.stop();
						process.exit(0);
					} catch (error) {
						console.error("Error during MCP server shutdown:", error);
						process.exit(1);
					}
				};

				const handleStdioClose = () => shutdown("stdio");
				process.stdin.once("end", handleStdioClose);
				process.stdin.once("close", handleStdioClose);

				const handlePipeError = (error: unknown) => {
					const code =
						error && typeof error === "object" && "code" in error
							? String((error as { code?: string }).code ?? "")
							: "";
					if (code === "EPIPE") {
						void shutdown("EPIPE");
					}
				};
				process.stdout.once("error", handlePipeError);
				process.stderr.once("error", handlePipeError);

				process.once("SIGINT", () => shutdown("SIGINT"));
				process.once("SIGTERM", () => shutdown("SIGTERM"));
				if (process.platform !== "win32") {
					process.once("SIGHUP", () => shutdown("SIGHUP"));
					process.once("SIGPIPE", () => shutdown("SIGPIPE"));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Failed to start MCP server: ${message}`);
				process.exit(1);
			}
		});
}
