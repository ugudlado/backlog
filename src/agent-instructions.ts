import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AGENT_GUIDELINES,
	CLAUDE_AGENT_CONTENT,
	CLAUDE_GUIDELINES,
	CLAUDE_SKILL_CONTENT,
	COPILOT_GUIDELINES,
	GEMINI_GUIDELINES,
	MCP_AGENT_NUDGE,
	README_GUIDELINES,
} from "./constants/index.ts";

export type AgentInstructionFile =
	| "AGENTS.md"
	| "CLAUDE.md"
	| "GEMINI.md"
	| ".github/copilot-instructions.md"
	| "README.md";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadContent(textOrPath: string): Promise<string> {
	if (textOrPath.includes("\n")) return textOrPath;
	try {
		const path = isAbsolute(textOrPath) ? textOrPath : join(__dirname, textOrPath);
		return await Bun.file(path).text();
	} catch {
		return textOrPath;
	}
}

type GuidelineMarkerKind = "default" | "mcp";

/**
 * Gets the appropriate markers for a given file type
 */
function getMarkers(fileName: string, kind: GuidelineMarkerKind = "default"): { start: string; end: string } {
	const label = kind === "mcp" ? "BACKLOG.MD MCP GUIDELINES" : "BACKLOG.MD GUIDELINES";
	if (fileName === ".cursorrules") {
		// .cursorrules doesn't support HTML comments, use markdown-style comments
		return {
			start: `# === ${label} START ===`,
			end: `# === ${label} END ===`,
		};
	}
	// All markdown files support HTML comments
	return {
		start: `<!-- ${label} START -->`,
		end: `<!-- ${label} END -->`,
	};
}

/**
 * Checks if the Backlog.md guidelines are already present in the content
 */
function hasBacklogGuidelines(content: string, fileName: string): boolean {
	const { start } = getMarkers(fileName);
	return content.includes(start);
}

/**
 * Wraps the Backlog.md guidelines with appropriate markers
 */
function wrapWithMarkers(content: string, fileName: string, kind: GuidelineMarkerKind = "default"): string {
	const { start, end } = getMarkers(fileName, kind);
	return `\n${start}\n${content}\n${end}\n`;
}

function stripGuidelineSection(
	content: string,
	fileName: string,
	kind: GuidelineMarkerKind,
): { content: string; removed: boolean; firstIndex?: number } {
	const { start, end } = getMarkers(fileName, kind);
	let removed = false;
	let result = content;
	let firstIndex: number | undefined;

	while (true) {
		const startIndex = result.indexOf(start);
		if (startIndex === -1) {
			break;
		}

		const endIndex = result.indexOf(end, startIndex);
		if (endIndex === -1) {
			break;
		}

		let removalStart = startIndex;
		while (removalStart > 0 && (result[removalStart - 1] === " " || result[removalStart - 1] === "\t")) {
			removalStart -= 1;
		}
		if (removalStart > 0 && result[removalStart - 1] === "\n") {
			removalStart -= 1;
			if (removalStart > 0 && result[removalStart - 1] === "\r") {
				removalStart -= 1;
			}
		} else if (removalStart > 0 && result[removalStart - 1] === "\r") {
			removalStart -= 1;
		}

		let removalEnd = endIndex + end.length;
		if (removalEnd < result.length && result[removalEnd] === "\r") {
			removalEnd += 1;
		}
		if (removalEnd < result.length && result[removalEnd] === "\n") {
			removalEnd += 1;
		}

		if (firstIndex === undefined) {
			firstIndex = removalStart;
		}
		result = result.slice(0, removalStart) + result.slice(removalEnd);
		removed = true;
	}

	return { content: result, removed, firstIndex };
}

/**
 * Removes any Backlog.md guideline block (default + mcp markers) previously
 * injected into the given file. If the file is left empty, it's deleted;
 * otherwise the remaining user content is written back. No-op if absent.
 * Used to migrate CLAUDE.md off the old inject-the-block behavior on re-init.
 */
async function removeGuidelineBlock(filePath: string): Promise<void> {
	if (!existsSync(filePath)) return;
	const fileName = filePath.split(/[\\/]/).pop() ?? "CLAUDE.md";
	let content = process.platform === "win32" ? readFileSync(filePath, "utf-8") : await Bun.file(filePath).text();
	const original = content;
	for (const kind of ["default", "mcp"] as GuidelineMarkerKind[]) {
		const stripped = stripGuidelineSection(content, fileName, kind);
		if (stripped.removed) content = stripped.content;
	}
	if (content === original) return;
	if (content.trim() === "") {
		await rm(filePath, { force: true });
	} else {
		await Bun.write(filePath, content);
	}
}

export async function addAgentInstructions(
	projectRoot: string,
	files: AgentInstructionFile[] = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"],
): Promise<void> {
	const mapping: Record<AgentInstructionFile, string> = {
		"AGENTS.md": AGENT_GUIDELINES,
		"CLAUDE.md": CLAUDE_GUIDELINES,
		"GEMINI.md": GEMINI_GUIDELINES,
		".github/copilot-instructions.md": COPILOT_GUIDELINES,
		"README.md": README_GUIDELINES,
	};

	const paths: string[] = [];
	for (const name of files) {
		// Claude gets the guidelines as an on-demand skill (installed below), not an
		// injected CLAUDE.md block — so it doesn't bloat every prompt. Other agents
		// have no skill mechanism and keep the injected guidelines.
		if (name === "CLAUDE.md") {
			// Migration: an older init injected the block into CLAUDE.md. On re-init,
			// strip it so the user isn't left with both the stale block and the skill.
			await removeGuidelineBlock(join(projectRoot, "CLAUDE.md"));
			continue;
		}

		const content = await loadContent(mapping[name]);
		const filePath = join(projectRoot, name);
		let finalContent = "";

		// Check if file exists first to avoid Windows hanging issue
		if (existsSync(filePath)) {
			try {
				// On Windows, use synchronous read to avoid hanging
				let existing: string;
				if (process.platform === "win32") {
					existing = readFileSync(filePath, "utf-8");
				} else {
					existing = await Bun.file(filePath).text();
				}

				const mcpStripped = stripGuidelineSection(existing, name, "mcp");
				if (mcpStripped.removed) {
					existing = mcpStripped.content;
				}

				// Check if Backlog.md guidelines are already present
				if (hasBacklogGuidelines(existing, name)) {
					// Guidelines already exist, skip this file
					continue;
				}

				// Append Backlog.md guidelines with markers
				if (!existing.endsWith("\n")) existing += "\n";
				finalContent = existing + wrapWithMarkers(content, name);
			} catch (error) {
				console.error(`Error reading existing file ${filePath}:`, error);
				// If we can't read it, just use the new content with markers
				finalContent = wrapWithMarkers(content, name);
			}
		} else {
			// File doesn't exist, create with markers
			finalContent = wrapWithMarkers(content, name);
		}

		await mkdir(dirname(filePath), { recursive: true });
		await Bun.write(filePath, finalContent);
		paths.push(filePath);
	}

	// Claude integration installs the skill bundle (not an injected block, and not
	// the agent — the agent is opt-in via init's separate installClaudeAgent flag).
	if (files.includes("CLAUDE.md")) {
		await installClaudeSkill(projectRoot);
	}
}

export { loadContent as _loadAgentGuideline };

async function readExistingFile(filePath: string): Promise<string> {
	if (process.platform === "win32") {
		return readFileSync(filePath, "utf-8");
	}
	return await Bun.file(filePath).text();
}

export interface EnsureMcpGuidelinesResult {
	changed: boolean;
	created: boolean;
	fileName: AgentInstructionFile;
	filePath: string;
}

export async function ensureMcpGuidelines(
	projectRoot: string,
	fileName: AgentInstructionFile,
): Promise<EnsureMcpGuidelinesResult> {
	const filePath = join(projectRoot, fileName);
	const fileExists = existsSync(filePath);
	let existing = "";
	let original = "";
	let insertIndex: number | null = null;

	if (fileExists) {
		try {
			existing = await readExistingFile(filePath);
			original = existing;
			const cliStripped = stripGuidelineSection(existing, fileName, "default");
			if (cliStripped.removed && cliStripped.firstIndex !== undefined) {
				insertIndex = cliStripped.firstIndex;
			}
			existing = cliStripped.content;
			const mcpStripped = stripGuidelineSection(existing, fileName, "mcp");
			if (mcpStripped.removed && mcpStripped.firstIndex !== undefined) {
				insertIndex = mcpStripped.firstIndex;
			}
			existing = mcpStripped.content;
		} catch (error) {
			console.error(`Error reading existing file ${filePath}:`, error);
			existing = "";
		}
	}

	const nudgeBlock = wrapWithMarkers(MCP_AGENT_NUDGE, fileName, "mcp");
	let nextContent: string;
	if (insertIndex !== null) {
		const normalizedIndex = Math.max(0, Math.min(insertIndex, existing.length));
		nextContent = existing.slice(0, normalizedIndex) + nudgeBlock + existing.slice(normalizedIndex);
	} else {
		nextContent = existing;
		if (nextContent && !nextContent.endsWith("\n")) {
			nextContent += "\n";
		}
		nextContent += nudgeBlock;
	}

	const finalContent = nextContent;
	const changed = !fileExists || finalContent !== original;

	await mkdir(dirname(filePath), { recursive: true });
	if (changed) {
		await Bun.write(filePath, finalContent);
	}

	return { changed, created: !fileExists, fileName, filePath };
}

/** Creates parent directories and writes content to filePath. */
async function writeFile(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await Bun.write(filePath, content);
}

/**
 * Installs the Claude Code backlog agent to the project's .claude/agents directory
 */
export async function installClaudeAgent(projectRoot: string): Promise<void> {
	await writeFile(join(projectRoot, ".claude", "agents", "project-manager-backlog.md"), CLAUDE_AGENT_CONTENT);
}

/**
 * Installs the Claude Code backlog skill bundle to the project's .claude/skills directory.
 * Ships the full command reference as reference.md alongside SKILL.md so the skill is
 * self-contained — it loads on demand and never needs the CLAUDE.md guidelines block.
 */
export async function installClaudeSkill(projectRoot: string): Promise<void> {
	const skillDir = join(projectRoot, ".claude", "skills", "backlog-md");
	await writeFile(join(skillDir, "SKILL.md"), CLAUDE_SKILL_CONTENT);
	await writeFile(join(skillDir, "reference.md"), CLAUDE_GUIDELINES);
}
