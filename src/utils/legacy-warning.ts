import { existsSync } from "node:fs";
import { join } from "node:path";

const LEGACY_DIRS = ["drafts", "docs", "decisions"];

/**
 * Writes a warning to stderr if legacy backlog folders exist and the warning is not suppressed.
 */
export async function warnLegacyFolders(backlogDir: string, suppressedByConfig: boolean): Promise<void> {
	if (suppressedByConfig) return;
	const found = LEGACY_DIRS.filter((d) => existsSync(join(backlogDir, d)));
	if (found.length === 0) return;
	process.stderr.write(
		`Warning: Legacy backlog folders found (${found.map((d) => `backlog/${d}/`).join(", ")}). ` +
			`Run 'backlog migrate drafts-to-tasks' or 'backlog migrate archive-legacy' to migrate them.\n`,
	);
}
