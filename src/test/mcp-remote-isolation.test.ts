import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMcpServer } from "../mcp/server.ts";
import { clearMachineConfigCache } from "../utils/machine-config.ts";
import { isRemoteMode } from "../utils/remote-backend.ts";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

describe("createMcpServer remote config isolation", () => {
	let TEST_DIR: string;
	let machineConfigDir: string;
	const origMachineConfigDir = process.env.BACKLOG_MACHINE_CONFIG_DIR;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-remote-isolation");
		machineConfigDir = join(TEST_DIR, "machine-config");
		await mkdir(machineConfigDir, { recursive: true });
		await mkdir(TEST_DIR, { recursive: true });
		await writeFile(
			join(machineConfigDir, "config.yml"),
			"backlog_url: http://remote.example:6420\nclient_token: test-token\n",
		);
		process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
		clearMachineConfigCache();
	});

	afterEach(async () => {
		clearMachineConfigCache();
		if (origMachineConfigDir === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = origMachineConfigDir;
		await safeCleanup(TEST_DIR);
	});

	it("uses remote mode for standalone MCP when backlog_url is configured", () => {
		expect(isRemoteMode()).toBe(true);
	});

	it("forceLocal keeps embedded MCP on local project files", async () => {
		const { FileSystem } = await import("../file-system/operations.ts");
		const fs = new FileSystem(TEST_DIR);
		await fs.ensureBacklogStructure();
		await fs.saveConfig({
			projectName: "Local MCP Project",
			statuses: ["To Do", "In Progress", "Done"],
			labels: [],
			dateFormat: "YYYY-MM-DD",
		});

		const server = await createMcpServer(TEST_DIR, { forceLocal: true });
		const tools = await server.testInterface.listTools();
		expect(tools.tools.some((tool) => tool.name === "task_create")).toBe(true);
	});
});
