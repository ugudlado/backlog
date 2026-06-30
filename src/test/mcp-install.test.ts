import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("backlog mcp install", () => {
	it("rejects an unknown client with a clear error and exit 1", async () => {
		const res = await $`bun ${[CLI_PATH, "mcp", "install", "bogus"]}`.quiet().nothrow();
		expect(res.exitCode).toBe(1);
		expect(res.stderr.toString()).toContain('Unknown client "bogus"');
		// Lists the valid clients so the user can self-correct.
		expect(res.stderr.toString()).toContain("claude");
	});

	it("lists the supported clients in --help", async () => {
		const res = await $`bun ${[CLI_PATH, "mcp", "install", "--help"]}`.quiet().nothrow();
		expect(res.exitCode).toBe(0);
		const out = res.stdout.toString();
		for (const client of ["claude", "codex", "gemini", "kiro"]) {
			expect(out).toContain(client);
		}
	});
});
