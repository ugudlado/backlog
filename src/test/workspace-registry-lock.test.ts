/**
 * Tests for `withRegistryLock` cross-process serialisation and timeout error.
 *
 * Under the per-repo workspace model `withRegistryLock` guards the only
 * mutating machine-config write — `setCurrentWorkspaceName` (the atomic
 * write-temp + rename of `config.yml`).
 *
 * Test 1: Two child Bun processes each set `current:` repeatedly against a
 * shared BACKLOG_MACHINE_CONFIG_DIR. With the lock, every write is serialised
 * so `config.yml` is never torn — the final `current:` is exactly one of the
 * values written, and the file always parses.
 *
 * Test 2: Hold the registry lock manually, then call withRegistryLock with a
 * short timeout — expect the EREGISTRYLOCK error code.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { readCurrentWorkspaceName } from "../utils/workspace-store.ts";
import { withRegistryLock } from "../utils/workspaces-index.ts";

const tmpRoot = (label: string) =>
	join(process.cwd(), `tmp-registry-lock-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

// ─── Test 1: Cross-process concurrent writers ────────────────────────────────

describe("withRegistryLock cross-process serialisation", () => {
	let base: string;
	let machineConfigDir: string;
	let prevEnv: string | undefined;

	beforeEach(async () => {
		base = tmpRoot("race");
		machineConfigDir = join(base, ".config", "backlog");
		await mkdir(machineConfigDir, { recursive: true });
		prevEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;
		process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
	});

	afterEach(async () => {
		if (prevEnv === undefined) delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
		else process.env.BACKLOG_MACHINE_CONFIG_DIR = prevEnv;
		await rm(base, { recursive: true, force: true });
	});

	it("serialises concurrent setCurrentWorkspaceName writes without corrupting config.yml", async () => {
		const childANames = ["a0", "a1", "a2", "a3", "a4"];
		const childBNames = ["b0", "b1", "b2", "b3", "b4"];

		// Each child sets `current:` to each of its names in sequence. Without
		// cross-process locking the temp-write + rename of two processes can
		// interleave and leave a torn/empty config.yml; with withRegistryLock
		// every write is atomic and serialised.
		const childScript = (names: string[]) => `
import { setCurrentWorkspaceName } from ${JSON.stringify(join(process.cwd(), "src/utils/workspace-store.ts"))};
const names = ${JSON.stringify(names)};
for (const name of names) {
  await setCurrentWorkspaceName(name);
}
`;

		const procA = Bun.spawn(["bun", "-e", childScript(childANames)], {
			env: { ...process.env, BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir },
			stdout: "pipe",
			stderr: "pipe",
		});

		const procB = Bun.spawn(["bun", "-e", childScript(childBNames)], {
			env: { ...process.env, BACKLOG_MACHINE_CONFIG_DIR: machineConfigDir },
			stdout: "pipe",
			stderr: "pipe",
		});

		const [exitA, exitB] = await Promise.all([procA.exited, procB.exited]);

		if (exitA !== 0) {
			const stderr = await new Response(procA.stderr).text();
			throw new Error(`Child A exited with code ${exitA}: ${stderr}`);
		}
		if (exitB !== 0) {
			const stderr = await new Response(procB.stderr).text();
			throw new Error(`Child B exited with code ${exitB}: ${stderr}`);
		}

		// config.yml must parse and hold exactly one of the written names — no
		// torn write, no empty/null result.
		const current = readCurrentWorkspaceName(machineConfigDir);
		expect(current).not.toBeNull();
		expect([...childANames, ...childBNames]).toContain(current as string);
	}, 30_000); // Allow up to 30 s for child process startup overhead.
});

// ─── Test 2: Lock timeout surfaces EREGISTRYLOCK ─────────────────────────────

describe("withRegistryLock timeout error", () => {
	let base: string;
	let machineConfigDir: string;
	let locksDir: string;
	let lockPath: string;
	let releaseFn: (() => Promise<void>) | undefined;
	let prevEnv: string | undefined;

	beforeEach(async () => {
		base = tmpRoot("timeout");
		machineConfigDir = join(base, ".config", "backlog");
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
