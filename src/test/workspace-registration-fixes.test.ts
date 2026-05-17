import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	mintWorkspaceId,
	readWorkspacesWithIds,
	registerWorkspaceAtPath,
	WorkspaceRegistrationError,
} from "../utils/workspace-registration.ts";
import {
	readWorkspacesIndex,
	removeWorkspaceEntry,
	upsertWorkspaceEntry,
	writeWorkspacesIndex,
} from "../utils/workspaces-index.ts";

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
});

describe("readWorkspacesWithIds batched migration", () => {
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
		await writeWorkspacesIndex({ workspaces: [{ path: a }, { path: b }] });
		const entries = await readWorkspacesWithIds();
		expect(entries.map((e) => e.id)).toEqual(["alpha-deadbeef", "bravo-cafef00d"]);
		// File should now have ids persisted.
		const onDisk = await readWorkspacesIndex();
		expect(onDisk.workspaces.map((e) => e.id)).toEqual(["alpha-deadbeef", "bravo-cafef00d"]);
	});

	it("does not rewrite when nothing needs migrating", async () => {
		const a = join(base, "a");
		await makeProject(a, "Alpha", "alpha-deadbeef");
		await writeWorkspacesIndex({ workspaces: [{ path: a, id: "alpha-deadbeef" }] });
		const before = await readFile(join(base, ".config", "backlog.md", "workspaces.yml"), "utf8");
		await readWorkspacesWithIds();
		const after = await readFile(join(base, ".config", "backlog.md", "workspaces.yml"), "utf8");
		expect(after).toBe(before);
	});
});

describe("upsertWorkspaceEntry concurrency", () => {
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
		await Promise.all(paths.map((p, i) => upsertWorkspaceEntry({ path: p, id: `id-${i}` })));
		const idx = await readWorkspacesIndex();
		expect(idx.workspaces.length).toBe(N);
		const ids = idx.workspaces.map((e) => e.id).sort();
		expect(ids).toEqual(Array.from({ length: N }, (_, i) => `id-${i}`).sort());
	});

	it("removeWorkspaceEntry serializes against upsert", async () => {
		const a = join(base, "a");
		const b = join(base, "b");
		await mkdir(a, { recursive: true });
		await mkdir(b, { recursive: true });
		await upsertWorkspaceEntry({ path: a, id: "a" });
		// Race a remove(a) against an upsert(b) — both should land.
		await Promise.all([removeWorkspaceEntry(a), upsertWorkspaceEntry({ path: b, id: "b" })]);
		const idx = await readWorkspacesIndex();
		const ids = idx.workspaces.map((e) => e.id).sort();
		expect(ids).toEqual(["b"]);
	});
});
