import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeSlotName, scanGlobalStoreProjects } from "./global-store-scan.ts";
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

	it("discovers slots with a readable config.yml; skips non-projects", async () => {
		await mkdir(join(store, "Alpha"), { recursive: true });
		await writeFile(join(store, "Alpha", "config.yml"), `id: "alpha-1234"\nproject_name: "Alpha"\n`);
		// A bare dir with no config.yml is not a project.
		await mkdir(join(store, "not-a-project"), { recursive: true });
		// A slot without an id falls back to the dir name.
		await mkdir(join(store, "Beta"), { recursive: true });
		await writeFile(join(store, "Beta", "config.yml"), `project_name: "Beta"\n`);

		const projects = await scanGlobalStoreProjects();
		const byName = Object.fromEntries(projects.map((p) => [p.name, p]));
		expect(Object.keys(byName).sort()).toEqual(["Alpha", "Beta"]);
		expect(byName.Alpha?.id).toBe("alpha-1234");
		expect(byName.Beta?.id).toBe("Beta"); // dir-name fallback
	});
});
