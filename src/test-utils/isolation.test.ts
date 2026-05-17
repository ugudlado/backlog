import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readMachineConfig } from "../utils/machine-config.ts";
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
	it("creates an isolated machine config dir with no globalStore", async () => {
		const setup = await setupMachineConfig();
		try {
			const cfg = readMachineConfig();
			expect(cfg.globalStore).toBeNull();
			expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(setup.machineConfigDir);
		} finally {
			await setup.cleanup();
		}
	});

	it("creates a globalStore temp dir when globalStore: true", async () => {
		const setup = await setupMachineConfig({ globalStore: true });
		try {
			expect(setup.globalStoreDir).not.toBeNull();
			const cfg = readMachineConfig();
			expect(cfg.globalStore).toBe(setup.globalStoreDir);
		} finally {
			await setup.cleanup();
		}
	});

	it("uses a specific globalStore path when passed as string", async () => {
		const setup = await setupMachineConfig({ globalStore: "/tmp/my-custom-store" });
		try {
			const cfg = readMachineConfig();
			expect(cfg.globalStore).toBe("/tmp/my-custom-store");
		} finally {
			await setup.cleanup();
		}
	});

	it("cleanup restores env and invalidates cache", async () => {
		const prevDir = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		const setup = await setupMachineConfig({ globalStore: true });
		expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(setup.machineConfigDir);
		await setup.cleanup();
		expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(prevDir);
		// After cleanup the cache should be clear, so no stale globalStore
		const cfg = readMachineConfig();
		// Either null (no real config) or whatever the real config says — just
		// ensure it's NOT pointing at the now-deleted temp dir
		expect(cfg.globalStore).not.toBe(setup.globalStoreDir);
	});

	describe("beforeEach / afterEach pattern", () => {
		let setup: Awaited<ReturnType<typeof setupMachineConfig>>;

		beforeEach(async () => {
			setup = await setupMachineConfig({ globalStore: true });
		});

		afterEach(async () => {
			await setup.cleanup();
		});

		it("each test gets an isolated machine config", () => {
			expect(process.env.BACKLOG_MACHINE_CONFIG_DIR).toBe(setup.machineConfigDir);
			expect(readMachineConfig().globalStore).toBe(setup.globalStoreDir);
		});

		it("second test also isolated", () => {
			const cfg = readMachineConfig();
			expect(cfg.globalStore).toBe(setup.globalStoreDir);
			expect(cfg.globalStore).toContain("backlog-test-");
		});
	});
});
