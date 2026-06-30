import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeSlotName } from "./backlog-directory.ts";
import { scanGlobalStoreProjects } from "./global-store-scan.ts";
import { clearMachineConfigCache } from "./machine-config.ts";

describe("isSafeSlotName", () => {
	it("accepts plain names and names with spaces", () => {
		expect(isSafeSlotName("Alpha")).toBe(true);
		expect(isSafeSlotName("Two Words")).toBe(true);
	});

	it("rejects traversal and separators", () => {
		expect(isSafeSlotName("..")).toBe(false);
		expect(isSafeSlotName(".")).toBe(false);
		expect(isSafeSlotName("")).toBe(false);
		expect(isSafeSlotName("../escaped")).toBe(false);
		expect(isSafeSlotName("a/b")).toBe(false);
		expect(isSafeSlotName("a\\b")).toBe(false);
		// YAML-marker-breaking characters
		expect(isSafeSlotName('a"b')).toBe(false);
		expect(isSafeSlotName("a\nb")).toBe(false);
		expect(isSafeSlotName("a\rb")).toBe(false);
	});
});

describe("scanGlobalStoreProjects", () => {
	let base: string;
	let store: string;
	const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

	beforeEach(async () => {
		base = await mkdtemp(join(tmpdir(), "gstore-scan-"));
		store = join(base, "store");
		const cfgDir = join(base, "cfg");
		await mkdir(store, { recursive: true });
		await mkdir(cfgDir, { recursive: true });
		await writeFile(join(cfgDir, "config.yml"), `globalStore: ${store}\n`);
		process.env.BACKLOG_MACHINE_CONFIG_DIR = cfgDir;
		clearMachineConfigCache();
	});

	afterEach(async () => {
		if (origEnv === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
		clearMachineConfigCache();
		await rm(base, { recursive: true, force: true });
	});

	it("returns [] when globalStore is unset", async () => {
		await writeFile(join(base, "cfg", "config.yml"), "");
		clearMachineConfigCache();
		expect(await scanGlobalStoreProjects()).toEqual([]);
	});

	it("treats every folder as a project keyed by its name; no config.yml needed", async () => {
		// Folders with tasks, with a config, and bare — all are projects.
		await mkdir(join(store, "Alpha", "tasks"), { recursive: true });
		await mkdir(join(store, "Beta"), { recursive: true });
		await writeFile(join(store, "Beta", "config.yml"), `project_name: "ignored"\n`);
		await mkdir(join(store, "Gamma"), { recursive: true });
		// Dot-dirs (e.g. soft-deleted) are excluded.
		await mkdir(join(store, ".archive"), { recursive: true });

		const projects = await scanGlobalStoreProjects();
		const byName = Object.fromEntries(projects.map((p) => [p.name, p]));
		expect(Object.keys(byName).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
		// id and name are the folder name — config.yml contents are not read.
		expect(byName.Beta?.id).toBe("Beta");
		expect(byName.Alpha?.slotPath).toBe(join(store, "Alpha"));
	});
});
