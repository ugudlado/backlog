import { describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBacklogDirectory } from "../utils/backlog-directory.ts";
import {
	parseWorkspacesYaml,
	resolveBrowserProjectRoot,
	resolveWorkspaceSelector,
	serializeWorkspacesYaml,
	toAbsoluteProjectRoot,
	writeWorkspacesIndex,
} from "../utils/workspaces-index.ts";

describe("parseWorkspacesYaml / serializeWorkspacesYaml", () => {
	it("round-trips workspace entries", () => {
		const original = {
			workspaces: [{ path: "/tmp/a" }, { path: "/tmp/b space" }],
		};
		const yaml = serializeWorkspacesYaml(original);
		const parsed = parseWorkspacesYaml(yaml);
		expect(parsed.workspaces).toEqual(original.workspaces);
	});

	it("round-trips the optional `current` pointer", () => {
		const original = {
			workspaces: [
				{ path: "/tmp/a", id: "abcd1234" },
				{ path: "/tmp/b", id: "ef567890" },
			],
			current: "ef567890",
		};
		const yaml = serializeWorkspacesYaml(original);
		expect(yaml).toContain("current: ef567890");
		const parsed = parseWorkspacesYaml(yaml);
		expect(parsed.current).toBe("ef567890");
		expect(parsed.workspaces).toEqual(original.workspaces);
	});

	it("omits the `current` line when unset", () => {
		const yaml = serializeWorkspacesYaml({ workspaces: [{ path: "/tmp/a" }] });
		expect(yaml).not.toContain("current:");
	});

	it("accepts and discards legacy `type:` lines (back-compat)", () => {
		const legacy = [
			"workspaces:",
			"  - path: /tmp/a",
			"    type: repo",
			"  - path: /tmp/b",
			"    type: global",
			"",
		].join("\n");
		const parsed = parseWorkspacesYaml(legacy);
		expect(parsed.workspaces).toEqual([{ path: "/tmp/a" }, { path: "/tmp/b" }]);
		const reserialized = serializeWorkspacesYaml(parsed);
		expect(reserialized).not.toContain("type:");
	});
});

describe("resolveWorkspaceSelector", () => {
	const entries = [{ path: "/projects/foo" }, { path: "/other/bar" }];

	it("matches absolute path", () => {
		const hit = resolveWorkspaceSelector("/projects/foo", entries);
		expect(hit?.path).toBe("/projects/foo");
	});

	it("matches unique tail directory name", () => {
		const hit = resolveWorkspaceSelector("foo", entries);
		expect(hit?.path).toBe("/projects/foo");
	});
});

describe("resolveBacklogDirectory with temp project", () => {
	it("detects standard backlog layout", async () => {
		const root = join(process.cwd(), `tmp-proj-${Date.now()}`);
		await mkdir(join(root, "backlog", "tasks"), { recursive: true });
		await writeFile(join(root, "backlog", "config.yml"), "projectName: T\n");
		const r = resolveBacklogDirectory(root);
		expect(r.configPath).not.toBeNull();
		expect(toAbsoluteProjectRoot(root)).toBeTruthy();
		await rm(root, { recursive: true, force: true });
	});
});

describe("resolveBrowserProjectRoot", () => {
	it("resolves cwd under a registered workspace but does not walk up for unregistered projects", async () => {
		const base = join(process.cwd(), `tmp-ws-browser-${Date.now()}`);
		const prevMachine = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = join(base, ".config", "backlog.md");
		const root = join(base, "proj");
		await mkdir(join(root, "backlog", "tasks"), { recursive: true });
		await writeFile(join(root, "backlog", "config.yml"), "projectName: Reg\n");
		try {
			await writeWorkspacesIndex({
				workspaces: [{ path: root }],
			});
			const sub = join(root, "apps", "web");
			await mkdir(sub, { recursive: true });
			const hit = await resolveBrowserProjectRoot(sub);
			expect(hit).toEqual({ ok: true, projectRoot: toAbsoluteProjectRoot(root) });

			const unregistered = join(base, "other");
			await mkdir(join(unregistered, "backlog", "tasks"), { recursive: true });
			await writeFile(join(unregistered, "backlog", "config.yml"), "projectName: X\n");
			const miss = await resolveBrowserProjectRoot(join(unregistered, "src"));
			expect(miss).toEqual({ ok: false, kind: "not_found" });
		} finally {
			if (prevMachine === undefined) {
				delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
			} else {
				process.env.BACKLOG_MACHINE_CONFIG_DIR = prevMachine;
			}
			await rm(base, { recursive: true, force: true });
		}
	});
});
