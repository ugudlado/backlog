import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { getMachineConfigDir } from "./workspaces-index.ts";

/**
 * The deleted `browser-project-bootstrap.test.ts` asserted the machine-config
 * directory precedence (explicit override > env var > default). The bootstrap
 * helper it also tested (`ensureWorkspacesFileExists`) no longer exists, but
 * `getMachineConfigDir` and its precedence contract are still live and still
 * threaded through `BacklogServer`, so that part is rewritten here.
 */

const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;

beforeEach(() => {
	delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
});

afterEach(() => {
	if (origEnv === undefined) {
		delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
	} else {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
	}
});

describe("getMachineConfigDir precedence", () => {
	it("falls back to ~/.config/backlog when nothing is set", () => {
		expect(getMachineConfigDir()).toBe(join(homedir(), ".config", "backlog"));
	});

	it("uses BACKLOG_MACHINE_CONFIG_DIR when no override is passed", () => {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = "/tmp/from-env";
		expect(getMachineConfigDir()).toBe(normalize(resolve("/tmp/from-env")));
	});

	it("explicit override beats env var beats default", () => {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = "/tmp/from-env";
		expect(getMachineConfigDir("/tmp/explicit")).toBe(normalize(resolve("/tmp/explicit")));
	});
});
