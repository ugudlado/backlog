/**
 * Test for withRegistryLock timeout error.
 *
 * Hold the registry lock manually, then call withRegistryLock with a short
 * timeout — expect EREGISTRYLOCK error code.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { withRegistryLock } from "../utils/projects-index.ts";

const tmpRoot = (label: string) =>
	join(process.cwd(), `tmp-registry-lock-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

// ─── Lock timeout surfaces EREGISTRYLOCK ─────────────────────────────

describe("withRegistryLock timeout error", () => {
	let base: string;
	let machineConfigDir: string;
	let locksDir: string;
	let lockPath: string;
	let releaseFn: (() => Promise<void>) | undefined;
	let prevEnv: string | undefined;

	beforeEach(async () => {
		base = tmpRoot("timeout");
		machineConfigDir = join(base, ".config", "backlog.md");
		locksDir = join(machineConfigDir, ".locks");
		lockPath = join(locksDir, "workspaces");
		await mkdir(locksDir, { recursive: true });
		prevEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
		releaseFn = undefined;
	});

	afterEach(async () => {
		// Release the lock BEFORE cleaning up the tmp dir to avoid ENOENT in proper-lockfile.
		if (releaseFn) {
			try {
				await releaseFn();
			} catch {
				// Ignore errors during test cleanup.
			}
			releaseFn = undefined;
		}
		if (prevEnv === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = prevEnv;
		await rm(base, { recursive: true, force: true });
	});

	it("throws an error with code EREGISTRYLOCK when lock cannot be acquired within timeout", async () => {
		// Manually acquire the lock at the path withRegistryLock will use.
		releaseFn = await lockfile.lock(machineConfigDir, {
			lockfilePath: lockPath,
			realpath: false,
			stale: 10_000,
			retries: 0,
		});

		// Now call withRegistryLock with a very short timeout — it should fail fast.
		let caught: unknown;
		try {
			await withRegistryLock(
				async () => {
					/* noop — should never run */
				},
				{ timeoutMs: 50, machineConfigDir },
			);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(caught).toBeInstanceOf(Error);
		expect((caught as NodeJS.ErrnoException).code).toBe("EREGISTRYLOCK");
		expect((caught as Error).message).toContain("EREGISTRYLOCK");
	});
});
