import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

// In remote mode every task command targets the remote server's current
// project; --project is resolved locally and would silently hit the wrong
// project. The CLI must refuse loudly instead.
describe("CLI --project in remote mode", () => {
	it("fails loudly instead of silently targeting the remote current project", async () => {
		const res = await $`bun ${[CLI_PATH, "task", "list", "--project", "alpha", "--plain"]}`
			.env({ ...process.env, BACKLOG_URL: "http://127.0.0.1:1" } as Record<string, string>)
			.quiet()
			.nothrow();

		expect(res.exitCode).toBe(1);
		expect(res.stderr.toString()).toContain("--project is not supported in remote mode");
	});
});
