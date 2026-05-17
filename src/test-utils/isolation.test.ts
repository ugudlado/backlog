import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stat } from "node:fs/promises";
import { setupMachineConfig, withEnvVars } from "./isolation.ts";

describe("withEnvVars", () => {
	it("sets and restores env vars", () => {
		const prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		const restore = withEnvVars({ BACKLOG_MACHINE_CONFIG_DIR: "/tmp/test-isolation" });
		expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe("/tmp/test-isolation");
		restore();
		expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(prev);
	});

	it("restores undefined when key was not set", () => {
		const prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		const restore = withEnvVars({ BACKLOG_MACHINE_CONFIG_DIR: "/tmp/test-isolation" });
		expect(process.env.BACKLOG_MACHINE_CONFIG_DIR!).toBe("/tmp/test-isolation");
		restore();
		expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).not.toBeDefined();
		// Restore original for other tests
		if (prev !== undefined) process.env.BACKLOG_MACHINE_CONFIG_DIR = prev;
	});
});

describe("setupMachineConfig", () => {
	it("creates an isolated machine config dir and points the env var at it", async () => {
		const setup = await setupMachineConfig();
		try {
			expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(setup.machineConfigDir);
			const s = await stat(setup.machineConfigDir);
			expect(s.isDirectory()).toBe(true);
		} finally {
			await setup.cleanup();
		}
	});

	it("cleanup restores env and removes the temp dir", async () => {
		const prevDir = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		const setup = await setupMachineConfig();
		expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(setup.machineConfigDir);
		await setup.cleanup();
		expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(prevDir);
		await expect(stat(setup.machineConfigDir)).rejects.toThrow();
	});

	describe("beforeEach / afterEach pattern", () => {
		let setup: Awaited<ReturnType<typeof setupMachineConfig>>;

		beforeEach(async () => {
			setup = await setupMachineConfig();
		});

		afterEach(async () => {
			await setup.cleanup();
		});

		it("each test gets an isolated machine config", () => {
			expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(setup.machineConfigDir);
			expect(setup.machineConfigDir).toContain("backlog-test-");
		});

		it("second test also isolated", () => {
			expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(setup.machineConfigDir);
			expect(setup.machineConfigDir).toContain("backlog-test-");
		});
	});
});
