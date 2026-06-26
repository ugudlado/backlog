import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	readProjectsIndex,
	removeProjectEntry,
	upsertProjectEntry,
	writeProjectsIndex,
} from "../utils/projects-index.ts";
import {
	mintWorkspaceId,
	readProjectsWithIds,
	registerWorkspaceAtPath,
	WorkspaceRegistrationError,
} from "../utils/workspace-registration.ts";

const tmpRoot = (label: string) =>
	join(process.cwd(), `tmp-ws-fixes-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

async function makeProject(root: string, projectName: string, withId?: string) {
	await mkdir(join(root, "backlog"), { recursive: true });
	const lines = [withId ? `id: "${withId}"` : null, `project_name: "${projectName}"`].filter(Boolean);
	await writeFile(join(root, "backlog", "config.yml"), `${lines.join("\n")}\n`);
}

describe("mintWorkspaceId", () => {
	it("uses an 8-char hex hash for collision resistance", () => {
		const id = mintWorkspaceId("Hello World");
		expect(id).toMatch(/^hello-world-[0-9a-f]{8}$/);
	});

	it("is deterministic across calls (same input → same id)", () => {
		expect(mintWorkspaceId("backlog.md")).toBe(mintWorkspaceId("backlog.md"));
	});

	it("falls back to 'project' slug when name has no usable chars", () => {
		const id = mintWorkspaceId("!!!");
		expect(id.startsWith("project-")).toBe(true);
	});
});

describe("registerWorkspaceAtPath error codes", () => {
	let base: string;
	let prev: string | undefined;
	beforeEach(async () => {
		base = tmpRoot("reg");
		prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = join(base, ".config", "backlog.md");
	});
	afterEach(async () => {
		if (prev === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = prev;
		await rm(base, { recursive: true, force: true });
	});

	it("throws not_a_directory for missing path", async () => {
		const missing = join(base, "missing");
		let caught: unknown;
		try {
			await registerWorkspaceAtPath(missing);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WorkspaceRegistrationError);
		expect((caught as WorkspaceRegistrationError).code).toBe("not_a_directory");
	});

	it("throws no_backlog_config for empty directory", async () => {
		const dir = join(base, "empty");
		await mkdir(dir, { recursive: true });
		let caught: unknown;
		try {
			await registerWorkspaceAtPath(dir);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WorkspaceRegistrationError);
		expect((caught as WorkspaceRegistrationError).code).toBe("no_backlog_config");
	});

	it("mints + persists id when registering a valid project", async () => {
		const dir = join(base, "valid");
		await makeProject(dir, "Valid Project");
		const result = await registerWorkspaceAtPath(dir);
		expect(result.minted).toBe(true);
		expect(result.entry.id).toBe(mintWorkspaceId("Valid Project"));
		const cfg = await readFile(join(dir, "backlog", "config.yml"), "utf8");
		expect(cfg).toContain(`id: "${result.entry.id}"`);
	});

	it("persists an explicit data: override into the workspace index", async () => {
		// The `data:` location IS where config lives (flat config.yml inside
		// it) — registration validates that, mirroring how FileSystem reads a
		// data-overridden workspace. So the config must exist at dataDir.
		const dir = join(base, "with-data");
		await mkdir(dir, { recursive: true });
		const dataDir = join(base, "external-data");
		await mkdir(dataDir, { recursive: true });
		await writeFile(join(dataDir, "config.yml"), `project_name: "Data Override Project"\n`);
		const result = await registerWorkspaceAtPath(dir, { data: dataDir });
		expect(result.entry.data).toBe(dataDir);
		const index = await readProjectsIndex();
		const persisted = index.projects.find((w) => w.id === result.entry.id);
		expect(persisted?.data).toBe(dataDir);
	});

	it("omits data: when no override is given", async () => {
		const dir = join(base, "no-data");
		await makeProject(dir, "No Data Project");
		const result = await registerWorkspaceAtPath(dir);
		expect(result.entry.data).toBeUndefined();
		const index = await readProjectsIndex();
		const persisted = index.projects.find((w) => w.id === result.entry.id);
		expect(persisted?.data).toBeUndefined();
	});
});

describe("readProjectsWithIds batched migration", () => {
	let base: string;
	let prev: string | undefined;
	beforeEach(() => {
		base = tmpRoot("mig");
		prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = join(base, ".config", "backlog.md");
	});
	afterEach(async () => {
		if (prev === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = prev;
		await rm(base, { recursive: true, force: true });
	});

	it("backfills missing ids from project configs in a single rewrite", async () => {
		const a = join(base, "a");
		const b = join(base, "b");
		await makeProject(a, "Alpha", "alpha-deadbeef");
		await makeProject(b, "Bravo", "bravo-cafef00d");
		// Seed registry without ids.
		await writeProjectsIndex({ projects: [{ path: a }, { path: b }] });
		const entries = await readProjectsWithIds();
		expect(entries.map((e) => e.id)).toEqual(["alpha-deadbeef", "bravo-cafef00d"]);
		// File should now have ids persisted.
		const onDisk = await readProjectsIndex();
		expect(onDisk.projects.map((e) => e.id)).toEqual(["alpha-deadbeef", "bravo-cafef00d"]);
	});

	it("does not rewrite when nothing needs migrating", async () => {
		const a = join(base, "a");
		await makeProject(a, "Alpha", "alpha-deadbeef");
		await writeProjectsIndex({ projects: [{ path: a, id: "alpha-deadbeef" }] });
		const before = await readFile(join(base, ".config", "backlog.md", "projects.yml"), "utf8");
		await readProjectsWithIds();
		const after = await readFile(join(base, ".config", "backlog.md", "projects.yml"), "utf8");
		expect(after).toBe(before);
	});
});

describe("upsertProjectEntry concurrency", () => {
	let base: string;
	let prev: string | undefined;
	beforeEach(() => {
		base = tmpRoot("conc");
		prev = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = join(base, ".config", "backlog.md");
	});
	afterEach(async () => {
		if (prev === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = prev;
		await rm(base, { recursive: true, force: true });
	});

	it("preserves all entries under concurrent upserts (in-process lock)", async () => {
		const N = 8;
		const paths = Array.from({ length: N }, (_, i) => join(base, `p${i}`));
		await Promise.all(paths.map((p) => mkdir(p, { recursive: true })));
		await Promise.all(paths.map((p, i) => upsertProjectEntry({ path: p, id: `id-${i}` })));
		const idx = await readProjectsIndex();
		expect(idx.projects.length).toBe(N);
		const ids = idx.projects.map((e) => e.id).sort();
		expect(ids).toEqual(Array.from({ length: N }, (_, i) => `id-${i}`).sort());
	});

	it("removeProjectEntry serializes against upsert", async () => {
		const a = join(base, "a");
		const b = join(base, "b");
		await mkdir(a, { recursive: true });
		await mkdir(b, { recursive: true });
		await upsertProjectEntry({ path: a, id: "a" });
		// Race a remove(a) against an upsert(b) — both should land.
		await Promise.all([removeProjectEntry(a), upsertProjectEntry({ path: b, id: "b" })]);
		const idx = await readProjectsIndex();
		const ids = idx.projects.map((e) => e.id).sort();
		expect(ids).toEqual(["b"]);
	});
});
