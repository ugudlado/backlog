import { describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBacklogDirectory } from "../utils/backlog-directory.ts";
import { parseProjectsYaml, serializeProjectsYaml, toAbsoluteProjectRoot } from "../utils/projects-index.ts";

describe("parseProjectsYaml / serializeProjectsYaml", () => {
	it("round-trips the `current` pointer", () => {
		const yaml = serializeProjectsYaml({ current: "ef567890" });
		expect(yaml).toContain("current: ef567890");
		expect(parseProjectsYaml(yaml)).toEqual({ current: "ef567890" });
	});

	it("omits the `current` line when unset and round-trips the empty index", () => {
		const yaml = serializeProjectsYaml({});
		expect(yaml).not.toContain("current:");
		expect(parseProjectsYaml(yaml)).toEqual({});
	});

	it("ignores legacy `projects:`/`workspaces:` list lines (back-compat)", () => {
		const legacy = ["workspaces:", "  - path: /tmp/a", "    id: abcd1234", "current: ef567890", ""].join("\n");
		expect(parseProjectsYaml(legacy)).toEqual({ current: "ef567890" });
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
