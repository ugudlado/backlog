/**
 * RED phase: MCP `workspace_list` and `workspace_switch` tool tests.
 *
 * Tests fail until T-11 lands `src/mcp/tools/workspaces/{index,handlers,schemas}.ts`
 * and registers them on the MCP server.
 *
 * Each test uses an isolated `BACKLOG_MACHINE_CONFIG_DIR` to avoid mutating the
 * developer's real registry, and seeds workspace entries via `upsertWorkspaceEntry`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { McpServer } from "../mcp/server.ts";
// T-11 will export this:
import { registerWorkspaceTools } from "../mcp/tools/workspaces/index.ts";
import { readWorkspacesIndex, setCurrentWorkspaceId, upsertWorkspaceEntry } from "../utils/workspaces-index.ts";

const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

let TEST_DIR: string;
let MACHINE_CONFIG_DIR: string;
let server: McpServer;
let savedConfigDirEnv: string | undefined;

async function makeWorkspace(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await $`git init -b main`.cwd(dir).quiet();
	await $`git config user.email test@example.com`.cwd(dir).quiet();
	await $`git config user.name "Test"`.cwd(dir).quiet();
	await mkdir(join(dir, "backlog"), { recursive: true });
}

describe("MCP workspace tools", () => {
	beforeEach(async () => {
		const base = join(tmpdir(), `mcp-workspaces-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		TEST_DIR = join(base, "project");
		MACHINE_CONFIG_DIR = join(base, ".config", "backlog.md");
		await mkdir(MACHINE_CONFIG_DIR, { recursive: true });
		await makeWorkspace(TEST_DIR);

		// Point all registry helpers at the isolated config dir for the test process.
		savedConfigDirEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = MACHINE_CONFIG_DIR;

		server = new McpServer(TEST_DIR, "Test instructions");
		await server.filesystem.ensureBacklogStructure();

		registerWorkspaceTools(server);
	});

	afterEach(async () => {
		try {
			await server.stop();
		} catch {
			// ignore
		}
		if (savedConfigDirEnv === undefined) {
			delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		} else {
			process.env.BACKLOG_MACHINE_CONFIG_DIR = savedConfigDirEnv;
		}
		try {
			const base = join(MACHINE_CONFIG_DIR, "..", "..");
			await rm(base, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("workspace_list returns entries with isCurrent flag and current pointer", async () => {
		await upsertWorkspaceEntry({ id: "ws-a", path: TEST_DIR }, MACHINE_CONFIG_DIR);

		const otherDir = join(MACHINE_CONFIG_DIR, "..", "other-ws");
		await makeWorkspace(otherDir);
		await upsertWorkspaceEntry({ id: "ws-b", path: otherDir }, MACHINE_CONFIG_DIR);
		await setCurrentWorkspaceId("ws-a", MACHINE_CONFIG_DIR);

		const result = await server.testInterface.callTool({
			params: { name: "workspace_list", arguments: {} },
		});

		expect(result.isError).toBeFalsy();
		const text = getText(result.content);
		const parsed = JSON.parse(text) as {
			workspaces: Array<{ id: string; path: string; isCurrent: boolean }>;
			current: string | null;
		};
		expect(parsed.current).toBe("ws-a");
		expect(parsed.workspaces).toHaveLength(2);
		const wsA = parsed.workspaces.find((w) => w.id === "ws-a");
		expect(wsA?.isCurrent).toBe(true);
		const wsB = parsed.workspaces.find((w) => w.id === "ws-b");
		expect(wsB?.isCurrent).toBe(false);
	});

	it("workspace_switch updates the current pointer for a known id", async () => {
		await upsertWorkspaceEntry({ id: "ws-a", path: TEST_DIR }, MACHINE_CONFIG_DIR);
		const otherDir = join(MACHINE_CONFIG_DIR, "..", "other-ws-switch");
		await makeWorkspace(otherDir);
		await upsertWorkspaceEntry({ id: "ws-b", path: otherDir }, MACHINE_CONFIG_DIR);
		await setCurrentWorkspaceId("ws-a", MACHINE_CONFIG_DIR);

		const result = await server.testInterface.callTool({
			params: { name: "workspace_switch", arguments: { id: "ws-b" } },
		});

		expect(result.isError).toBeFalsy();
		const text = getText(result.content);
		const parsed = JSON.parse(text) as { id: string; path: string };
		expect(parsed.id).toBe("ws-b");
		expect(parsed.path).toBe(otherDir);

		const index = await readWorkspacesIndex(MACHINE_CONFIG_DIR);
		expect(index.current).toBe("ws-b");
	});

	it("workspace_switch returns isError for an unknown id", async () => {
		await upsertWorkspaceEntry({ id: "ws-a", path: TEST_DIR }, MACHINE_CONFIG_DIR);

		const result = await server.testInterface.callTool({
			params: { name: "workspace_switch", arguments: { id: "ws-does-not-exist" } },
		});

		expect(result.isError).toBe(true);
		expect(getText(result.content)).toContain("ws-does-not-exist");
	});
});
