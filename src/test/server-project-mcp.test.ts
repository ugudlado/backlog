import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { $ } from "bun";
import { BacklogServer } from "../server/index.ts";
import { clearActiveWorkspaceDataDir } from "../utils/active-workspace.ts";
import { clearMachineConfigCache } from "../utils/machine-config.ts";
import { createTestGlobalStore, createUniqueTestDir } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");
const PORT = 7663;
const BASE = `http://localhost:${PORT}`;
const TOKEN = "project-mcp-secret";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

async function mcpClient(path: string): Promise<Client> {
	const client = new Client({ name: "test-agent", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), {
			requestInit: { headers: AUTH },
		}),
	);
	return client;
}

const resultText = (result: unknown): string =>
	(((result as { content?: unknown }).content ?? []) as Array<{ text?: string }>)
		.map((item) => item.text ?? "")
		.join("\n");

// Two global-store projects served by one BacklogServer. Each /projects/:id/mcp
// endpoint must operate on its own project without touching the other or the
// server's current project.
describe("server project-scoped MCP endpoint", () => {
	let testDir: string;
	let server: BacklogServer;
	let alphaSlot: string;

	beforeAll(async () => {
		testDir = createUniqueTestDir("server-project-mcp");
		const { machineConfigDir, globalStoreDir, env } = await createTestGlobalStore(testDir);
		process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
		clearMachineConfigCache();
		clearActiveWorkspaceDataDir();

		for (const name of ["alpha", "beta"]) {
			const res = await $`bun ${[CLI_PATH, "project", "create", name]}`.env(env).quiet().nothrow();
			if (res.exitCode !== 0) throw new Error(`project create failed: ${res.stderr.toString()}`);
		}
		alphaSlot = join(globalStoreDir, "alpha");

		process.env.BACKLOG_TOKEN = TOKEN;
		server = new BacklogServer(alphaSlot);
		await server.start(PORT, false);
	});

	afterAll(async () => {
		await server.stop();
		delete process.env.BACKLOG_TOKEN;
		// Leave BACKLOG_MACHINE_CONFIG_DIR pointing at the (deleted) test dir —
		// deleting it would un-isolate later test files onto the real machine
		// config (see src/test-utils/test-setup.ts).
		clearMachineConfigCache();
		clearActiveWorkspaceDataDir();
		await rm(testDir, { recursive: true, force: true });
	});

	it("rejects requests without a token", async () => {
		const res = await fetch(`${BASE}/projects/alpha/mcp`, { method: "POST" });
		expect(res.status).toBe(401);
	});

	it("returns 404 for an unknown project id", async () => {
		const res = await fetch(`${BASE}/projects/no-such-project/mcp`, {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(res.status).toBe(404);
	});

	it("isolates concurrent agents on different projects", async () => {
		const alpha = await mcpClient("/projects/alpha/mcp");
		const beta = await mcpClient("/projects/beta/mcp");

		await alpha.callTool({ name: "task_create", arguments: { title: "Alpha only task" } });
		await beta.callTool({ name: "task_create", arguments: { title: "Beta only task" } });

		const alphaList = resultText(await alpha.callTool({ name: "task_list", arguments: {} }));
		const betaList = resultText(await beta.callTool({ name: "task_list", arguments: {} }));

		expect(alphaList).toContain("Alpha only task");
		expect(alphaList).not.toContain("Beta only task");
		expect(betaList).toContain("Beta only task");
		expect(betaList).not.toContain("Alpha only task");

		// The current-project pointer must be untouched by scoped MCP traffic.
		const projects = (await (await fetch(`${BASE}/api/projects`, { headers: AUTH })).json()) as {
			currentId: string | null;
		};
		expect(projects.currentId).toBe("alpha");

		await alpha.close();
		await beta.close();
	});

	it("serves the bootstrap context tool per project", async () => {
		const beta = await mcpClient("/projects/beta/mcp");
		const context = resultText(await beta.callTool({ name: "get_backlog_context", arguments: {} }));
		expect(context).toContain("Backlog.md Overview (Tools)");
		expect(context).toContain("Name: beta");
		expect(context).toContain("Beta only task");
		await beta.close();
	});
});
