import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src/cli.ts");

/**
 * Priority filtering / sorting against a seeded project. Each test runs in an
 * isolated initialized workspace with three known tasks (one per priority) so
 * assertions test real filter behavior rather than passing vacuously on an
 * empty project (the previous bug: bare `bun run cli` from the repo root).
 */
describe("CLI Priority Filtering", () => {
	let TEST_DIR: string;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-priority-filter");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
		await $`git init -b main`.cwd(TEST_DIR).quiet();
		await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
		await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();
		const core = new Core(TEST_DIR);
		await initializeTestProject(core, "Priority Test", false);

		await $`bun ${CLI_PATH} task create "High task" --priority high`.cwd(TEST_DIR).quiet();
		await $`bun ${CLI_PATH} task create "Medium task" --priority medium`.cwd(TEST_DIR).quiet();
		await $`bun ${CLI_PATH} task create "Low task" --priority low`.cwd(TEST_DIR).quiet();
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	test("--priority high shows only high priority tasks", async () => {
		const result = await $`bun ${CLI_PATH} task list --priority high --plain`.cwd(TEST_DIR).quiet();
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();
		expect(output).toMatch(/\[HIGH\]/);
		expect(output).not.toMatch(/\[MEDIUM\]/);
		expect(output).not.toMatch(/\[LOW\]/);
	});

	test("--priority medium shows only medium priority tasks", async () => {
		const result = await $`bun ${CLI_PATH} task list --priority medium --plain`.cwd(TEST_DIR).quiet();
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();
		expect(output).toMatch(/\[MEDIUM\]/);
		expect(output).not.toMatch(/\[HIGH\]/);
		expect(output).not.toMatch(/\[LOW\]/);
	});

	test("--priority low shows only low priority tasks", async () => {
		const result = await $`bun ${CLI_PATH} task list --priority low --plain`.cwd(TEST_DIR).quiet();
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();
		expect(output).toMatch(/\[LOW\]/);
		expect(output).not.toMatch(/\[HIGH\]/);
		expect(output).not.toMatch(/\[MEDIUM\]/);
	});

	test("--priority invalid shows error", async () => {
		const result = await $`bun ${CLI_PATH} task list --priority invalid --plain`.cwd(TEST_DIR).nothrow().quiet();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Invalid priority: invalid");
		expect(result.stderr.toString()).toContain("Valid values are: high, medium, low");
	});

	test("--priority is case insensitive", async () => {
		const upper = await $`bun ${CLI_PATH} task list --priority HIGH --plain`.cwd(TEST_DIR).quiet();
		const mixed = await $`bun ${CLI_PATH} task list --priority High --plain`.cwd(TEST_DIR).quiet();
		expect(upper.exitCode).toBe(0);
		expect(mixed.exitCode).toBe(0);
		for (const out of [upper.stdout.toString(), mixed.stdout.toString()]) {
			expect(out).toMatch(/\[HIGH\]/);
			expect(out).not.toMatch(/\[MEDIUM\]/);
			expect(out).not.toMatch(/\[LOW\]/);
		}
	});

	test("--sort priority orders high before medium before low", async () => {
		const result = await $`bun ${CLI_PATH} task list --sort priority --plain`.cwd(TEST_DIR).quiet();
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();
		const high = output.indexOf("[HIGH]");
		const medium = output.indexOf("[MEDIUM]");
		const low = output.indexOf("[LOW]");
		expect(high).toBeGreaterThanOrEqual(0);
		expect(medium).toBeGreaterThan(high);
		expect(low).toBeGreaterThan(medium);
	});

	test("--sort id exits successfully", async () => {
		const result = await $`bun ${CLI_PATH} task list --sort id --plain`.cwd(TEST_DIR).quiet();
		expect(result.exitCode).toBe(0);
	});

	test("--sort invalid shows error", async () => {
		const result = await $`bun ${CLI_PATH} task list --sort invalid --plain`.cwd(TEST_DIR).nothrow().quiet();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Invalid sort field: invalid");
		expect(result.stderr.toString()).toContain("Valid values are: priority, id");
	});

	test("priority filter combines with sort", async () => {
		const result = await $`bun ${CLI_PATH} task list --priority high --sort id --plain`.cwd(TEST_DIR).quiet();
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();
		expect(output).toMatch(/\[HIGH\]/);
		expect(output).not.toMatch(/\[MEDIUM\]/);
		expect(output).not.toMatch(/\[LOW\]/);
	});

	test("plain output includes priority indicators", async () => {
		const result = await $`bun ${CLI_PATH} task list --plain`.cwd(TEST_DIR).quiet();
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();
		expect(output).toMatch(/\[HIGH\]/);
		expect(output).toMatch(/\[MEDIUM\]/);
		expect(output).toMatch(/\[LOW\]/);
	});
});
