/**
 * RED phase: tests for scanWorkspaces and applyFixes in workspace-doctor.ts.
 *
 * These tests FAIL until T-6 implements src/commands/workspace-doctor.ts.
 *
 * Design contract (design.md):
 *   scanWorkspaces(entries: WorkspaceEntry[], current?: string): Promise<WorkspaceIssue[]>
 *   applyFixes(entries: WorkspaceEntry[], issues: WorkspaceIssue[], current?: string): { entries: WorkspaceEntry[]; current?: string }
 *
 *   WorkspaceIssue = { entryId: string | null; path: string; kind: WorkspaceIssueKind }
 *   WorkspaceIssueKind = "missing-path" | "not-git-repo" | "no-backlog-dir" | "duplicate-path" | "stale-current-pointer"
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFixes, scanWorkspaces } from "../commands/workspace-doctor.ts";
import type { WorkspaceEntry } from "../utils/workspaces-index.ts";

const tmpRoot = (label: string) =>
	join(tmpdir(), `ws-doctor-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

/** Creates a real git repo (needed for git-traversal tests). */
async function makeGitRepo(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const proc = Bun.spawn(["git", "init", dir], { stdout: "pipe", stderr: "pipe" });
	await proc.exited;
}

/** Creates a directory with .git and backlog/ — fully healthy fixture. */
async function makeHealthyWorkspace(dir: string): Promise<void> {
	await makeGitRepo(dir);
	await mkdir(join(dir, "backlog"), { recursive: true });
}

// ─── Group 1: scanWorkspaces returns issue tags ────────────────────────────────

describe("scanWorkspaces issue detection", () => {
	let base: string;

	beforeEach(() => {
		base = tmpRoot("scan");
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it("flags missing-path when entry path does not exist on disk", async () => {
		const missingPath = join(base, "does-not-exist");
		const entries: WorkspaceEntry[] = [{ path: missingPath, id: "ws-missing" }];
		const issues = await scanWorkspaces(entries);
		expect(issues.some((i) => i.kind === "missing-path" && i.entryId === "ws-missing")).toBe(true);
	});

	it("flags not-git-repo when path exists but has no .git", async () => {
		const dir = join(base, "not-git");
		await mkdir(dir, { recursive: true });
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-not-git" }];
		const issues = await scanWorkspaces(entries);
		expect(issues.some((i) => i.kind === "not-git-repo" && i.entryId === "ws-not-git")).toBe(true);
	});

	it("flags no-backlog-dir when path is a git repo but has no backlog/ subdir", async () => {
		const dir = join(base, "git-no-backlog");
		await makeGitRepo(dir);
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-no-backlog" }];
		const issues = await scanWorkspaces(entries);
		expect(issues.some((i) => i.kind === "no-backlog-dir" && i.entryId === "ws-no-backlog")).toBe(true);
	});

	it("flags duplicate-path on both entries when two entries share the same path", async () => {
		const dir = join(base, "shared");
		await makeHealthyWorkspace(dir);
		// one entry has an id, one doesn't
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-dup-with-id" }, { path: dir }];
		const issues = await scanWorkspaces(entries);
		const dupIssues = issues.filter((i) => i.kind === "duplicate-path" && i.path === dir);
		// Both entries for that path should be flagged
		expect(dupIssues.length).toBeGreaterThanOrEqual(2);
	});

	it("flags stale-current-pointer when current points to an id not in entries", async () => {
		const dir = join(base, "healthy");
		await makeHealthyWorkspace(dir);
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-real" }];
		const issues = await scanWorkspaces(entries, "ws-nonexistent");
		expect(issues.some((i) => i.kind === "stale-current-pointer")).toBe(true);
	});

	it("returns no issues for a healthy entry (git repo with backlog/)", async () => {
		const dir = join(base, "healthy");
		await makeHealthyWorkspace(dir);
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-ok" }];
		const issues = await scanWorkspaces(entries);
		expect(issues).toEqual([]);
	});

	it("returns no issues when current pointer matches an entry id", async () => {
		const dir = join(base, "healthy2");
		await makeHealthyWorkspace(dir);
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-ok" }];
		const issues = await scanWorkspaces(entries, "ws-ok");
		expect(issues).toEqual([]);
	});
});

// ─── Group 2: applyFixes mutates registry correctly ───────────────────────────

describe("applyFixes registry repair", () => {
	let base: string;

	beforeEach(() => {
		base = tmpRoot("fix");
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it("preserves healthy entries untouched", async () => {
		const dir = join(base, "healthy");
		await makeHealthyWorkspace(dir);
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-ok" }];
		const issues = await scanWorkspaces(entries);
		const { entries: fixed } = applyFixes(entries, issues);
		expect(fixed.some((e) => e.path === dir && e.id === "ws-ok")).toBe(true);
	});

	it("removes missing-path entries", async () => {
		const missing = join(base, "no-exist");
		const entries: WorkspaceEntry[] = [{ path: missing, id: "ws-missing" }];
		const issues = await scanWorkspaces(entries);
		const { entries: fixed } = applyFixes(entries, issues);
		expect(fixed.some((e) => e.path === missing)).toBe(false);
	});

	it("removes not-git-repo entries", async () => {
		const dir = join(base, "not-git");
		await mkdir(dir, { recursive: true });
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-not-git" }];
		const issues = await scanWorkspaces(entries);
		const { entries: fixed } = applyFixes(entries, issues);
		expect(fixed.some((e) => e.path === dir)).toBe(false);
	});

	it("removes no-backlog-dir entries", async () => {
		const dir = join(base, "git-only");
		await makeGitRepo(dir);
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-no-backlog" }];
		const issues = await scanWorkspaces(entries);
		const { entries: fixed } = applyFixes(entries, issues);
		expect(fixed.some((e) => e.path === dir)).toBe(false);
	});

	it("deduplicates duplicate-path: keeps entry with id, removes entry without", async () => {
		const dir = join(base, "dup");
		await makeHealthyWorkspace(dir);
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-dup-id" }, { path: dir }];
		const issues = await scanWorkspaces(entries);
		const { entries: fixed } = applyFixes(entries, issues);
		const forPath = fixed.filter((e) => e.path === dir);
		// Only one entry for that path should remain
		expect(forPath.length).toBe(1);
		// The one with an id should be kept
		expect(forPath[0]?.id).toBe("ws-dup-id");
	});

	it("deduplicates duplicate-path: first-wins when neither has id", async () => {
		const dir = join(base, "dup-no-id");
		await makeHealthyWorkspace(dir);
		const entries: WorkspaceEntry[] = [{ path: dir }, { path: dir }];
		const issues = await scanWorkspaces(entries);
		const { entries: fixed } = applyFixes(entries, issues);
		const forPath = fixed.filter((e) => e.path === dir);
		expect(forPath.length).toBe(1);
	});

	it("clears current field when current is a stale pointer", async () => {
		const dir = join(base, "healthy");
		await makeHealthyWorkspace(dir);
		const entries: WorkspaceEntry[] = [{ path: dir, id: "ws-real" }];
		const issues = await scanWorkspaces(entries, "ws-ghost");
		const { current } = applyFixes(entries, issues, "ws-ghost");
		expect(current).toBeUndefined();
	});

	it("scanWorkspaces on the fixed state returns no issues (round-trip)", async () => {
		// Set up a broken registry: missing path, duplicate, stale current
		const healthy = join(base, "healthy");
		const missing = join(base, "gone");
		const dup = join(base, "dup");
		await makeHealthyWorkspace(healthy);
		await makeHealthyWorkspace(dup);

		const entries: WorkspaceEntry[] = [
			{ path: healthy, id: "ws-healthy" },
			{ path: missing, id: "ws-missing" },
			{ path: dup, id: "ws-dup-a" },
			{ path: dup },
		];
		const staleCurrent = "ws-ghost";

		const issues = await scanWorkspaces(entries, staleCurrent);
		const { entries: fixed, current: fixedCurrent } = applyFixes(entries, issues, staleCurrent);

		// After applyFixes, a fresh scan should find zero issues
		const issuesAfter = await scanWorkspaces(fixed, fixedCurrent);
		expect(issuesAfter).toEqual([]);
	});
});
