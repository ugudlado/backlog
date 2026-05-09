import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	_loadAgentGuideline,
	AGENT_GUIDELINES,
	addAgentInstructions,
	CLAUDE_GUIDELINES,
	COPILOT_GUIDELINES,
	ensureMcpGuidelines,
	GEMINI_GUIDELINES,
	README_GUIDELINES,
} from "../index.ts";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;

describe("addAgentInstructions", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-agent-instructions");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("creates guideline files when none exist", async () => {
		await addAgentInstructions(TEST_DIR);
		const agents = await Bun.file(join(TEST_DIR, "AGENTS.md")).text();
		const claude = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();
		const gemini = await Bun.file(join(TEST_DIR, "GEMINI.md")).text();
		const copilot = await Bun.file(join(TEST_DIR, ".github/copilot-instructions.md")).text();

		// Check that files contain the markers and content
		expect(agents).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(agents).toContain("<!-- BACKLOG.MD GUIDELINES END -->");
		expect(agents).toContain(await _loadAgentGuideline(AGENT_GUIDELINES));

		expect(claude).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(claude).toContain("<!-- BACKLOG.MD GUIDELINES END -->");
		expect(claude).toContain(await _loadAgentGuideline(CLAUDE_GUIDELINES));

		expect(gemini).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(gemini).toContain("<!-- BACKLOG.MD GUIDELINES END -->");
		expect(gemini).toContain(await _loadAgentGuideline(GEMINI_GUIDELINES));

		expect(copilot).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(copilot).toContain("<!-- BACKLOG.MD GUIDELINES END -->");
		expect(copilot).toContain(await _loadAgentGuideline(COPILOT_GUIDELINES));
	});

	it("appends guideline files when they already exist", async () => {
		await Bun.write(join(TEST_DIR, "AGENTS.md"), "Existing\n");
		await addAgentInstructions(TEST_DIR);
		const agents = await Bun.file(join(TEST_DIR, "AGENTS.md")).text();
		expect(agents.startsWith("Existing\n")).toBe(true);
		expect(agents).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(agents).toContain("<!-- BACKLOG.MD GUIDELINES END -->");
		expect(agents).toContain(await _loadAgentGuideline(AGENT_GUIDELINES));
	});

	it("creates only selected files", async () => {
		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md", "README.md"]);

		const agentsExists = await Bun.file(join(TEST_DIR, "AGENTS.md")).exists();
		const claudeExists = await Bun.file(join(TEST_DIR, "CLAUDE.md")).exists();
		const geminiExists = await Bun.file(join(TEST_DIR, "GEMINI.md")).exists();
		const copilotExists = await Bun.file(join(TEST_DIR, ".github/copilot-instructions.md")).exists();
		const readme = await Bun.file(join(TEST_DIR, "README.md")).text();

		expect(agentsExists).toBe(true);
		expect(claudeExists).toBe(false);
		expect(geminiExists).toBe(false);
		expect(copilotExists).toBe(false);
		expect(readme).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(readme).toContain("<!-- BACKLOG.MD GUIDELINES END -->");
		expect(readme).toContain(await _loadAgentGuideline(README_GUIDELINES));
	});

	it("loads guideline content from file paths", async () => {
		const pathGuideline = join(__dirname, "../guidelines/agent-guidelines.md");
		const content = await _loadAgentGuideline(pathGuideline);
		expect(content).toContain("# Instructions for the usage of Backlog.md CLI Tool");
	});

	it("does not duplicate content when run multiple times (idempotent)", async () => {
		// First run
		await addAgentInstructions(TEST_DIR);
		const firstRun = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();

		// Second run - should not duplicate content
		await addAgentInstructions(TEST_DIR);
		const secondRun = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();

		expect(firstRun).toBe(secondRun);
	});

	it("preserves existing content and adds Backlog.md content only once", async () => {
		const existingContent = "# My Existing Claude Instructions\n\nThis is my custom content.\n";
		await Bun.write(join(TEST_DIR, "CLAUDE.md"), existingContent);

		// First run
		await addAgentInstructions(TEST_DIR, undefined, ["CLAUDE.md"]);
		const firstRun = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();

		// Second run - should not duplicate Backlog.md content
		await addAgentInstructions(TEST_DIR, undefined, ["CLAUDE.md"]);
		const secondRun = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();

		expect(firstRun).toBe(secondRun);
		expect(firstRun).toContain(existingContent);
		expect(firstRun).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(firstRun).toContain("<!-- BACKLOG.MD GUIDELINES END -->");

		// Count occurrences of the marker to ensure it's only there once
		const startMarkerCount = (firstRun.match(/<!-- BACKLOG\.MD GUIDELINES START -->/g) || []).length;
		const endMarkerCount = (firstRun.match(/<!-- BACKLOG\.MD GUIDELINES END -->/g) || []).length;
		expect(startMarkerCount).toBe(1);
		expect(endMarkerCount).toBe(1);
	});

	it("handles different file types with appropriate markers", async () => {
		const existingContent = "existing content\n";

		// Test AGENTS.md (markdown with HTML comments)
		await Bun.write(join(TEST_DIR, "AGENTS.md"), existingContent);
		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const agentsContent = await Bun.file(join(TEST_DIR, "AGENTS.md")).text();
		expect(agentsContent).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(agentsContent).toContain("<!-- BACKLOG.MD GUIDELINES END -->");
	});

	it("replaces CLI guidelines with MCP nudge when switching modes", async () => {
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const cliBlock = [
			"Preface content",
			"<!-- BACKLOG.MD GUIDELINES START -->",
			"CLI instructions here",
			"<!-- BACKLOG.MD GUIDELINES END -->",
			"Footer line",
			"",
		].join("\n");
		await Bun.write(agentsPath, cliBlock);

		await ensureMcpGuidelines(TEST_DIR, "AGENTS.md");
		const updated = await Bun.file(agentsPath).text();

		expect(updated).not.toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(updated).not.toContain("<!-- BACKLOG.MD GUIDELINES END -->");
		expect(updated).toContain("<!-- BACKLOG.MD MCP GUIDELINES START -->");
		expect(updated).toContain("<!-- BACKLOG.MD MCP GUIDELINES END -->");
		expect(updated).toContain("Preface content");
		expect(updated).toContain("Footer line");
	});

	// BACK-431 / issue #595: multi-line input guidance must lead with forms that pass
	// the tree-sitter AST walkers used by Claude Code, Codex, and similar agent sandboxes.
	// ANSI-C strings ($'...'), command substitutions ($(...)), and heredocs are rejected
	// outright; the section must lead with safe alternatives so headless agent runs do
	// not waste tokens cycling through rejections before falling back.
	it("agent guidelines lead multi-line input with sandbox-safe forms (BACK-431/#595)", async () => {
		const guideline = await _loadAgentGuideline(AGENT_GUIDELINES);
		const sectionMatch = guideline.match(/### Multi[‑-]line Input[\s\S]*?(?=\n### |\n## |$)/);
		expect(sectionMatch).not.toBeNull();
		const section = sectionMatch?.[0] ?? "";
		// Must mention --append-* as a primary safe approach.
		expect(section).toMatch(/--append-/);
		// Must mention real-newlines-in-quotes as a primary safe approach.
		expect(section).toMatch(/[Rr]eal newlines/);
		// Must call out that ANSI-C / command-substitution forms are sandbox-rejected.
		expect(section).toMatch(/sandbox|tree[\s-]sitter|reject/i);
		// Issue #595 must be linked so future readers can find the rationale.
		expect(section).toMatch(/#595|issues\/595/);
		// The safe alternatives must appear before the shell-specific shorthand list.
		const appendIdx = section.search(/--append-/);
		const ansiCIdx = section.search(/\$'/);
		expect(appendIdx).toBeGreaterThan(-1);
		expect(ansiCIdx).toBeGreaterThan(appendIdx);
	});

	// BACK-431 / issue #595: option help text must not advertise shell forms that AI
	// agent sandboxes reject. Help text is what `--help` surfaces and what agents echo
	// when reasoning about how to call the CLI.
	it("CLI option help does not advertise sandbox-rejected shell forms (BACK-431/#595)", async () => {
		const cliPath = join(__dirname, "../cli.ts");
		const cliText = await Bun.file(cliPath).text();
		const helpLines = cliText.split("\n").filter((line) => line.includes("multi-line"));
		expect(helpLines.length).toBeGreaterThan(0);
		for (const line of helpLines) {
			expect(line).not.toMatch(/\$'/); // no ANSI-C quoting in help strings
			expect(line).not.toMatch(/\$\(printf/); // no command-substitution-with-printf in help strings
		}
	});

	it("replaces MCP nudge with CLI guidelines when switching modes", async () => {
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const mcpBlock = [
			"Header",
			"<!-- BACKLOG.MD MCP GUIDELINES START -->",
			"MCP reminder here",
			"<!-- BACKLOG.MD MCP GUIDELINES END -->",
			"",
		].join("\n");
		await Bun.write(agentsPath, mcpBlock);

		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const updated = await Bun.file(agentsPath).text();

		expect(updated).toContain("<!-- BACKLOG.MD GUIDELINES START -->");
		expect(updated).toContain("<!-- BACKLOG.MD GUIDELINES END -->");
		expect(updated).not.toContain("<!-- BACKLOG.MD MCP GUIDELINES START -->");
		expect(updated).not.toContain("<!-- BACKLOG.MD MCP GUIDELINES END -->");
		expect(updated).toContain("Header");
	});
});

describe("agent-guidelines.md workspace registry section", () => {
	it("guideline file documents the registry, doctor command, and CLI commands", async () => {
		const path = join(__dirname, "../guidelines/agent-guidelines.md");
		const content = await Bun.file(path).text();

		// Section heading + key surfaces.
		expect(content).toContain("## Workspace Registry");
		expect(content).toContain("workspaces.yml");
		expect(content).toContain("backlog workspace doctor");
		expect(content).toContain("backlog workspace list");
		expect(content).toContain("backlog workspace switch");
	});

	it("addAgentInstructions emits the registry section into CLAUDE.md and AGENTS.md", async () => {
		const dir = createUniqueTestDir("test-agent-instructions-registry");
		await mkdir(dir, { recursive: true });
		try {
			await addAgentInstructions(dir, undefined, ["CLAUDE.md", "AGENTS.md"]);
			for (const name of ["CLAUDE.md", "AGENTS.md"]) {
				const text = await Bun.file(join(dir, name)).text();
				expect(text).toContain("## Workspace Registry");
				expect(text).toContain("backlog workspace list");
				expect(text).toContain("backlog workspace switch");
				expect(text).toContain("backlog workspace doctor");
			}
		} finally {
			await safeCleanup(dir);
		}
	});
});

// T-1: RED tests — agent-guidelines.md server/service docs, decision tree, agents-update mention
// These assertions FAIL until T-2 adds the content to agent-guidelines.md (FR-1, FR-2, FR-3).

describe("agent-guidelines.md server & service section (FR-1)", () => {
	it("guideline source documents backlog server and backlog service subcommands", async () => {
		const path = join(__dirname, "../guidelines/agent-guidelines.md");
		const content = await Bun.file(path).text();

		// Section heading
		expect(content).toContain("## Server & Service");

		// backlog service subcommands (FR-1)
		expect(content).toContain("backlog service start");
		expect(content).toContain("backlog service stop");
		expect(content).toContain("backlog service status");
		expect(content).toContain("backlog service logs");
		expect(content).toContain("backlog service uninstall");
	});

	it("addAgentInstructions renders server & service section into CLAUDE.md and AGENTS.md", async () => {
		const dir = createUniqueTestDir("test-agent-instructions-server");
		await mkdir(dir, { recursive: true });
		try {
			await addAgentInstructions(dir, undefined, ["CLAUDE.md", "AGENTS.md"]);
			for (const name of ["CLAUDE.md", "AGENTS.md"]) {
				const text = await Bun.file(join(dir, name)).text();
				expect(text).toContain("## Server & Service");
				expect(text).toContain("backlog service start");
				expect(text).toContain("backlog service status");
			}
		} finally {
			await safeCleanup(dir);
		}
	});
});

describe("agent-guidelines.md workspace decision tree (FR-2)", () => {
	it("guideline source contains the 'How do I find the right project?' decision tree", async () => {
		const path = join(__dirname, "../guidelines/agent-guidelines.md");
		const content = await Bun.file(path).text();

		// Decision-tree marker phrase (FR-2)
		expect(content).toContain("How do I find the right project?");
	});
});

describe("agent-guidelines.md agents-update mention (FR-3)", () => {
	it("guideline source mentions backlog agents --update-instructions as the refresh command", async () => {
		const path = join(__dirname, "../guidelines/agent-guidelines.md");
		const content = await Bun.file(path).text();

		// refresh command mention (FR-3)
		expect(content).toContain("backlog agents --update-instructions");
	});

	it("addAgentInstructions renders the agents-update mention into CLAUDE.md and AGENTS.md", async () => {
		const dir = createUniqueTestDir("test-agent-instructions-update");
		await mkdir(dir, { recursive: true });
		try {
			await addAgentInstructions(dir, undefined, ["CLAUDE.md", "AGENTS.md"]);
			for (const name of ["CLAUDE.md", "AGENTS.md"]) {
				const text = await Bun.file(join(dir, name)).text();
				expect(text).toContain("backlog agents --update-instructions");
			}
		} finally {
			await safeCleanup(dir);
		}
	});
});
