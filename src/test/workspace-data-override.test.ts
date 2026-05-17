import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "../file-system/operations.ts";
import {
	clearActiveWorkspaceDataDir,
	getActiveWorkspaceDataDir,
	setActiveWorkspaceDataDir,
} from "../utils/active-workspace.ts";

describe("active-workspace data-dir override", () => {
	afterEach(() => clearActiveWorkspaceDataDir());

	it("returns the override only for the exact project root", () => {
		setActiveWorkspaceDataDir("/repo/a", "/data/a");
		expect(getActiveWorkspaceDataDir("/repo/a")).toBe("/data/a");
		// A different root must never see a stale override.
		expect(getActiveWorkspaceDataDir("/repo/b")).toBeNull();
	});

	it("clears the override when data dir is undefined", () => {
		setActiveWorkspaceDataDir("/repo/a", "/data/a");
		setActiveWorkspaceDataDir("/repo/a", undefined);
		expect(getActiveWorkspaceDataDir("/repo/a")).toBeNull();
	});

	it("FileSystem points its backlog dir at the override when set", () => {
		const root = mkdtempSync(join(tmpdir(), "ws-override-root-"));
		const dataDir = mkdtempSync(join(tmpdir(), "ws-override-data-"));
		try {
			setActiveWorkspaceDataDir(root, dataDir);
			const fs = new FileSystem(root);
			// Data dir is the override, not <root>/backlog.
			expect((fs as unknown as { resolvedBacklogDir: string }).resolvedBacklogDir).toBe(dataDir);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("FileSystem falls back to <root>/backlog when no override", () => {
		const root = mkdtempSync(join(tmpdir(), "ws-nooverride-"));
		try {
			const fs = new FileSystem(root);
			expect((fs as unknown as { resolvedBacklogDir: string }).resolvedBacklogDir).toBe(join(root, "backlog"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
