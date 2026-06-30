import { describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBacklogDirectory } from "../utils/backlog-directory.ts";
import { parseProjectsYaml, setCurrentLine, toAbsoluteProjectRoot } from "../utils/projects-index.ts";

describe("parseProjectsYaml", () => {
	it("reads the `current` pointer", () => {
		expect(parseProjectsYaml("current: ef567890\n")).toEqual({ current: "ef567890" });
	});

	it("returns an empty index when `current` is absent", () => {
		expect(parseProjectsYaml("globalStore: /tmp/x\n")).toEqual({});
	});

	it("ignores legacy `projects:`/`workspaces:` list lines (back-compat)", () => {
		const legacy = ["workspaces:", "  - path: /tmp/a", "    id: abcd1234", "current: ef567890", ""].join("\n");
		expect(parseProjectsYaml(legacy)).toEqual({ current: "ef567890" });
	});
});

describe("setCurrentLine", () => {
	const config = ["# Backlog.md machine config", "globalStore: ~/.config/backlog/workspaces", "client_token: abc"].join(
		"\n",
	);

	it("appends `current:` when absent, preserving every other line", () => {
		const out = setCurrentLine(`${config}\n`, "proj-1");
		expect(out).toContain("# Backlog.md machine config");
		expect(out).toContain("globalStore: ~/.config/backlog/workspaces");
		expect(out).toContain("client_token: abc");
		expect(out).toContain("current: proj-1");
		expect(parseProjectsYaml(out)).toEqual({ current: "proj-1" });
	});

	it("replaces an existing `current:` line in place without touching others", () => {
		const withCurrent = `${config}\ncurrent: old-id\n`;
		const out = setCurrentLine(withCurrent, "new-id");
		expect(out).toContain("current: new-id");
		expect(out).not.toContain("old-id");
		expect(out).toContain("client_token: abc");
	});

	it("removes the `current:` line when cleared, leaving the rest intact", () => {
		const withCurrent = `${config}\ncurrent: old-id\n`;
		const out = setCurrentLine(withCurrent, undefined);
		expect(out).not.toContain("current:");
		expect(out).toContain("client_token: abc");
		expect(parseProjectsYaml(out)).toEqual({});
	});

	it("seeds a file from empty content", () => {
		expect(setCurrentLine("", "proj-1")).toBe("current: proj-1\n");
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
