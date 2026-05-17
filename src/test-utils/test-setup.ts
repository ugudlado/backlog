/**
 * Global test setup — preloaded by bunfig.toml before every test file.
 *
 * Redirects BACKLOG_MACHINE_CONFIG_DIR away from ~/.config/backlog so no test
 * can accidentally touch the real workspace registry.
 *
 * Under the per-repo workspace model the resolver reads the shared machine
 * config dir fresh on every call (no in-process cache). If every test shared
 * one dir, a `current:` or workspace yml written (or a registry lock held) by
 * one test would leak into the next — and wiping a shared dir in `beforeEach`
 * races with in-flight async cleanup / lock files from the previous test.
 *
 * Instead, give every test its own unique machine-config dir. The env var is
 * read fresh by `getMachineConfigDir()` on each resolver call and `Core`
 * resolves at construction time (after `beforeEach`), so a per-test dir gives
 * each test a pristine, fully isolated registry with zero shared state.
 *
 * Tests that override the env var themselves (via isolation.ts) still win:
 * their own `beforeEach` runs after this one and points the var elsewhere.
 */

import { beforeEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_MC_BASE = join(tmpdir(), "backlog-test-machine-config");

if (!process.env.BACKLOG_MACHINE_CONFIG_DIR) {
	process.env.BACKLOG_MACHINE_CONFIG_DIR = join(TEST_MC_BASE, "default");
}

let counter = 0;

beforeEach(() => {
	const dir = join(TEST_MC_BASE, `t-${process.pid}-${Date.now()}-${counter++}`);
	mkdirSync(dir, { recursive: true });
	process.env.BACKLOG_MACHINE_CONFIG_DIR = dir;
});
