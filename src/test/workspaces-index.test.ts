import { describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBacklogDirectory } from "../utils/backlog-directory.ts";
import {
	parseProjectsYaml,
	resolveBrowserProjectRoot,
	resolveProjectSelector,
	serializeProjectsYaml,
	toAbsoluteProjectRoot,
	writeProjectsIndex,
} from "../utils/projects-index.ts";

describe("parseProjectsYaml / serializeProjectsYaml", () => {
	it("round-trips workspace entries", () => {
		const original = {
			projects: [{ path: "/tmp/a" }, { path: "/tmp/b space" }],
		};
		const yaml = serializeProjectsYaml(original);
		const parsed = parseProjectsYaml(yaml);
		expect(parsed.projects).toEqual(original.projects);
	});

	it("round-trips the optional `current` pointer", () => {
		const original = {
			projects: [
				{ path: "/tmp/a", id: "abcd1234" },
				{ path: "/tmp/b", id: "ef567890" },
			],
			current: "ef567890",
		};
		const yaml = serializeProjectsYaml(original);
		expect(yaml).toContain("current: ef567890");
		const parsed = parseProjectsYaml(yaml);
		expect(parsed.current).toBe("ef567890");
		expect(parsed.projects).toEqual(original.projects);
	});

	it("omits the `current` line when unset", () => {
		const yaml = serializeProjectsYaml({ projects: [{ path: "/tmp/a" }] });
		expect(yaml).not.toContain("current:");
	});

	it("round-trips the optional `data:` override (absolute + relative)", () => {
		const original = {
			projects: [
				{ path: "/tmp/a", data: "/var/data/a" },
				{ path: "/tmp/b", data: "subdir/backlog" },
				{ path: "/tmp/c" },
			],
		};
		const yaml = serializeProjectsYaml(original);
		expect(yaml).toContain("data: /var/data/a");
		expect(yaml).toContain("data: subdir/backlog");
		const parsed = parseProjectsYaml(yaml);
		expect(parsed.projects).toEqual(original.projects);
	});

	it("omits the entry `data:` line when unset", () => {
		const yaml = serializeProjectsYaml({ projects: [{ path: "/tmp/a" }] });
		// Header comment legitimately mentions `data:`; assert no indented entry line.
		expect(yaml).not.toContain("    data:");
	});

	it("parses `data:` alongside `id:` on an entry", () => {
		const yaml = ["workspaces:", "  - path: /tmp/a", "    data: /var/data/a", "    id: abcd1234", ""].join("\n");
		const parsed = parseProjectsYaml(yaml);
		expect(parsed.projects).toEqual([{ path: "/tmp/a", data: "/var/data/a", id: "abcd1234" }]);
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
		const parsed = parseProjectsYaml(legacy);
		expect(parsed.projects).toEqual([{ path: "/tmp/a" }, { path: "/tmp/b" }]);
		const reserialized = serializeProjectsYaml(parsed);
		expect(reserialized).not.toContain("type:");
	});
});

describe("resolveProjectSelector", () => {
	const entries = [{ path: "/projects/foo" }, { path: "/other/bar" }];

	it("matches absolute path", () => {
		const hit = resolveProjectSelector("/projects/foo", entries);
		expect(hit?.path).toBe("/projects/foo");
	});

	it("matches unique tail directory name", () => {
		const hit = resolveProjectSelector("foo", entries);
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
			await writeProjectsIndex({
				projects: [{ path: root }],
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
