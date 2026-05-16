import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

test("EntityType.Draft|Document|Decision absent from non-test src/", async () => {
	// Exclude test files — these may have legacy fixture references that are harmless
	const result =
		await Bun.$`grep -r "EntityType\\.Draft\\|EntityType\\.Document\\|EntityType\\.Decision" ${SRC} --include="*.ts" -l --exclude-dir="test"`
			.text()
			.catch(() => "");
	expect(result.trim()).toBe("");
});

test("Deleted utility files are absent", () => {
	expect(existsSync(join(SRC, "utils/document-id.ts"))).toBe(false);
	expect(existsSync(join(SRC, "utils/document-path.ts"))).toBe(false);
	expect(existsSync(join(SRC, "mcp/tools/documents"))).toBe(false);
	expect(existsSync(join(SRC, "core/prefix-migration.ts"))).toBe(false);
});

test("No /api/docs|decisions|drafts route literals in server", async () => {
	const result = await Bun.$`grep -E "/api/(docs|decisions|drafts)" ${SRC}/server/index.ts`.text().catch(() => "");
	expect(result.trim()).toBe("");
});

test("DEFAULT_DIRECTORIES has no DRAFTS|DOCS|DECISIONS keys", async () => {
	const result = await Bun.$`grep -E "DRAFTS|DOCS|DECISIONS" ${SRC}/constants/index.ts`.text().catch(() => "");
	expect(result.trim()).toBe("");
});
