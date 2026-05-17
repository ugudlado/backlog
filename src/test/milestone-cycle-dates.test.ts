import { describe, expect, it } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../index.ts";
import { parseMilestone } from "../markdown/parser.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

/**
 * Cycle dates (BACK-481.4): a milestone with start_date/end_date acts as a
 * time-boxed cycle. There is no setter CLI yet (tracked separately), so this
 * verifies the entity round-trips dates through parse + the rename serialize
 * path without losing them.
 */
describe("Milestone cycle dates round-trip", () => {
	it("preserves start_date/end_date when a dated milestone is renamed", async () => {
		const dir = createUniqueTestDir("test-milestone-cycle-dates");
		try {
			await mkdir(dir, { recursive: true });
			await $`git init -b main`.cwd(dir).quiet();
			await $`git config user.name "Test User"`.cwd(dir).quiet();
			await $`git config user.email test@example.com`.cwd(dir).quiet();

			const core = new Core(dir);
			await initializeTestProject(core, "Cycle Dates Project");

			const milestone = await core.filesystem.createMilestone("Sprint 1");

			// Inject cycle dates directly into the milestone file (no setter API yet).
			const milestonesDir = join(dir, "backlog", "milestones");
			const files = (await readdir(milestonesDir)).filter((f) => f.startsWith(milestone.id));
			expect(files.length).toBe(1);
			const filePath = join(milestonesDir, files[0] as string);
			const original = await readFile(filePath, "utf-8");
			await writeFile(filePath, original.replace("---\n\n", "start_date: 2026-05-01\nend_date: 2026-05-14\n---\n\n"));

			// Sanity: parser reads the injected dates.
			const dated = parseMilestone(await readFile(filePath, "utf-8"));
			expect(dated.startDate).toBe("2026-05-01");
			expect(dated.endDate).toBe("2026-05-14");

			// Rename goes through serializeMilestoneContent; dates must survive.
			const result = await core.filesystem.renameMilestone(milestone.id, "Sprint 1 Renamed");
			expect(result.success).toBe(true);

			const renamedFiles = (await readdir(milestonesDir)).filter((f) => f.startsWith(milestone.id));
			const renamed = parseMilestone(await readFile(join(milestonesDir, renamedFiles[0] as string), "utf-8"));
			expect(renamed.title).toBe("Sprint 1 Renamed");
			expect(renamed.startDate).toBe("2026-05-01");
			expect(renamed.endDate).toBe("2026-05-14");
		} finally {
			await safeCleanup(dir);
		}
	});

	it("updateMilestoneDates sets, preserves, and clears dates", async () => {
		const dir = createUniqueTestDir("test-milestone-set-dates");
		try {
			await mkdir(dir, { recursive: true });
			await $`git init -b main`.cwd(dir).quiet();
			await $`git config user.name "Test User"`.cwd(dir).quiet();
			await $`git config user.email test@example.com`.cwd(dir).quiet();

			const core = new Core(dir);
			await initializeTestProject(core, "Set Dates Project");
			const milestone = await core.filesystem.createMilestone("Sprint X");

			// Set both dates.
			const set = await core.filesystem.updateMilestoneDates(milestone.id, {
				startDate: "2026-06-01",
				endDate: "2026-06-30",
			});
			expect(set.success).toBe(true);
			expect(set.milestone?.startDate).toBe("2026-06-01");
			expect(set.milestone?.endDate).toBe("2026-06-30");

			// undefined leaves a field unchanged; change only end.
			const partial = await core.filesystem.updateMilestoneDates(milestone.id, { endDate: "2026-07-15" });
			expect(partial.milestone?.startDate).toBe("2026-06-01");
			expect(partial.milestone?.endDate).toBe("2026-07-15");

			// null clears.
			const cleared = await core.filesystem.updateMilestoneDates(milestone.id, {
				startDate: null,
				endDate: null,
			});
			expect(cleared.milestone?.startDate).toBeUndefined();
			expect(cleared.milestone?.endDate).toBeUndefined();
		} finally {
			await safeCleanup(dir);
		}
	});
});
