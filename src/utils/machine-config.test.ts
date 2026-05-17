import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearMachineConfigCache, readMachineConfig } from "./machine-config.ts";

const TMP_DIR = join(import.meta.dir, "__tmp_machine_config__");

// Point all tests at a temp dir so we never touch ~/.config/backlog.md
const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

beforeEach(async () => {
	await mkdir(TMP_DIR, { recursive: true });
	process.env.BACKLOG_MACHINE_CONFIG_DIR = TMP_DIR;
	clearMachineConfigCache();
});

afterEach(async () => {
	clearMachineConfigCache();
	if (origEnv === undefined) {
		delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
	} else {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
	}
	await rm(TMP_DIR, { recursive: true, force: true });
});

describe("readMachineConfig", () => {
	it("returns { globalStore: null } when config file is absent", () => {
		const config = readMachineConfig(TMP_DIR);
		expect(config).toEqual({ globalStore: null });
	});

	it("returns { globalStore: null } when file exists but has no globalStore key", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "# just a comment\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config).toEqual({ globalStore: null });
	});

	it("returns the globalStore path when set to an absolute path", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: /tmp/my-store\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe("/tmp/my-store");
	});

	it("expands tilde in globalStore path", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: ~/backlog-store\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe(join(homedir(), "backlog-store"));
	});

	it("returns { globalStore: null } and treats relative path as null (with no throw)", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: relative/path\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBeNull();
	});

	it("strips YAML quotes from the value", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), 'globalStore: "/tmp/quoted-store"\n');
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe("/tmp/quoted-store");
	});

	it("strips single YAML quotes from the value", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: '/tmp/single-quoted'\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe("/tmp/single-quoted");
	});

	it("ignores blank lines and comment lines", async () => {
		const content = `
# machine config
# globalStore: /ignored

globalStore: /tmp/real-store
`;
		await writeFile(join(TMP_DIR, "config.yml"), content);
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe("/tmp/real-store");
	});

	it("returns { globalStore: null } for a malformed file (no colon)", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "this is not yaml at all\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config).toEqual({ globalStore: null });
	});

	it("cache returns same instance until clearMachineConfigCache is called", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: /tmp/store1\n");
		const first = readMachineConfig(TMP_DIR);

		// Overwrite the file — without clearing cache, should still return old value
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: /tmp/store2\n");
		const second = readMachineConfig(TMP_DIR);
		expect(second).toBe(first); // same reference

		// After clearing cache, should re-read
		clearMachineConfigCache();
		const third = readMachineConfig(TMP_DIR);
		expect(third.globalStore).toBe("/tmp/store2");
		expect(third).not.toBe(first);
	});

	it("uses BACKLOG_MACHINE_CONFIG_DIR env var when no override is passed", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: /tmp/env-store\n");
		// No override passed — relies on env var set in beforeEach
		const config = readMachineConfig();
		expect(config.globalStore).toBe("/tmp/env-store");
	});
});
