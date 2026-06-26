import { stat } from "node:fs/promises";
import type { ProjectEntry } from "../utils/projects-index.ts";

export type WorkspaceIssueKind = "missing-path" | "duplicate-path" | "stale-current-pointer";

export interface WorkspaceIssue {
	entryId: string | null;
	path: string;
	kind: WorkspaceIssueKind;
}

async function pathExistsAsDirectory(p: string): Promise<boolean> {
	try {
		const s = await stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Scans workspace entries for three categories of drift:
 *   - missing-path: path does not exist on disk
 *   - duplicate-path: two or more entries share the same path
 *   - stale-current-pointer: current id does not match any entry
 */
export async function scanWorkspaces(entries: ProjectEntry[], current?: string): Promise<WorkspaceIssue[]> {
	const issues: WorkspaceIssue[] = [];

	// Track duplicate paths: accumulate all entries per path
	const pathToEntries = new Map<string, ProjectEntry[]>();
	for (const e of entries) {
		const existing = pathToEntries.get(e.path) ?? [];
		existing.push(e);
		pathToEntries.set(e.path, existing);
	}

	// Detect duplicate-path issues (flag every entry sharing a path)
	for (const [path, group] of pathToEntries) {
		if (group.length > 1) {
			for (const e of group) {
				issues.push({ entryId: e.id ?? null, path, kind: "duplicate-path" });
			}
		}
	}

	// Per-entry checks (run for all entries, including duplicates)
	for (const e of entries) {
		const entryId = e.id ?? null;
		const path = e.path;

		const exists = await pathExistsAsDirectory(path);
		if (!exists) {
			issues.push({ entryId, path, kind: "missing-path" });
		}
	}

	// Check stale current pointer
	if (current !== undefined) {
		const ids = new Set(entries.map((e) => e.id).filter((id): id is string => id !== undefined));
		if (!ids.has(current)) {
			issues.push({ entryId: current ?? null, path: "", kind: "stale-current-pointer" });
		}
	}

	return issues;
}

/**
 * Produces a repaired copy of entries by removing broken entries and
 * deduplicating paths. Returns new arrays — does not mutate inputs.
 *
 * Rules:
 *   - missing-path → remove entry
 *   - duplicate-path → keep first entry that has an id; otherwise keep
 *     the first entry in original order
 *   - stale-current-pointer → clear the current field (return undefined)
 */
export function applyFixes(
	entries: ProjectEntry[],
	issues: WorkspaceIssue[],
	current?: string,
): { entries: ProjectEntry[]; current?: string } {
	// Build a set of paths that should be fully removed
	const removeKinds: WorkspaceIssueKind[] = ["missing-path"];
	const removePaths = new Set<string>();
	for (const issue of issues) {
		if (removeKinds.includes(issue.kind)) {
			removePaths.add(issue.path);
		}
	}

	// Build a set of paths that have duplicate-path issues
	const duplicatedPaths = new Set<string>(issues.filter((i) => i.kind === "duplicate-path").map((i) => i.path));

	// For each duplicated path, pick the canonical entry to keep:
	// prefer entry with id; otherwise first in original order
	const canonicalForPath = new Map<string, ProjectEntry>();
	for (const path of duplicatedPaths) {
		const group = entries.filter((e) => e.path === path && !removePaths.has(e.path));
		if (group.length === 0) {
			continue;
		}
		const withId = group.find((e) => e.id !== undefined);
		const canonical = withId ?? group[0];
		if (canonical) {
			canonicalForPath.set(path, canonical);
		}
	}

	// Build fixed entries list in original order
	const seen = new Set<string>();
	const fixed: ProjectEntry[] = [];
	for (const e of entries) {
		// Skip entries whose paths have hard issues (missing, not-git, no-backlog)
		if (removePaths.has(e.path)) {
			continue;
		}
		// For duplicated paths, only emit the canonical entry once
		if (duplicatedPaths.has(e.path)) {
			if (seen.has(e.path)) {
				continue;
			}
			seen.add(e.path);
			const canonical = canonicalForPath.get(e.path);
			if (canonical) {
				fixed.push(canonical);
			}
			continue;
		}
		fixed.push(e);
	}

	// Handle stale current pointer
	const hasStale = issues.some((i) => i.kind === "stale-current-pointer");
	const newCurrent = hasStale ? undefined : current;

	const result: { entries: ProjectEntry[]; current?: string } = { entries: fixed };
	if (newCurrent !== undefined) {
		result.current = newCurrent;
	}
	return result;
}
