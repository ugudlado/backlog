#!/usr/bin/env node

// Guarded auto-(re)start of the backlog web UI launchd service on `npm i -g`.
//
// This runs on EVERY install, including CI, Docker, project-dependency installs,
// and other users' machines, so it must stay a strict no-op unless it's clearly
// safe and wanted:
//   - Global installs only (npm_config_global) — never when added as a project
//     dependency, where the postinstall would fire on every `npm install`.
//   - macOS only (the `service` command is launchd-only).
//   - Never in CI / Docker.
//   - If the service is already installed -> restart it so the upgrade takes
//     effect. This is the common "I upgraded and want the new binary" case and
//     must NOT depend on a TTY: npm pipes script stdio, so an interactive
//     `npm i -g` reports no TTY. npm_config_global is the deterministic signal.
//   - If NOT installed, only start it when the user explicitly opts in with
//     BACKLOG_AUTO_SERVICE=1. A fresh install does NOT silently spawn a daemon.
//
// Any failure is swallowed: a postinstall must never break `npm i`.

const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const os = require("node:os");

function skip(reason) {
	// Quiet by default; one line so an interested user can see why nothing happened.
	if (process.env.BACKLOG_DEBUG) console.log(`[backlog postinstall] skipped: ${reason}`);
	process.exit(0);
}

try {
	// Global installs only — a project dependency must never spawn a daemon.
	if (process.env.npm_config_global !== "true") skip("not a global install");
	if (process.platform !== "darwin") skip("not macOS");
	// CI / container: never touch services.
	if (process.env.CI) skip("CI");
	if (existsSync("/.dockerenv")) skip("docker");

	const plist = join(os.homedir(), "Library", "LaunchAgents", "md.backlog.browser.plist");
	const installed = existsSync(plist);

	// Refresh an existing service unconditionally (no TTY/opt-in needed); only a
	// FRESH install requires explicit opt-in to avoid a surprise background daemon.
	if (!installed && process.env.BACKLOG_AUTO_SERVICE !== "1") {
		console.log("backlog: run `backlog service start` to run the web UI as a background service.");
		process.exit(0);
	}

	// `service start` is idempotent — installs if absent, restarts if present,
	// either way the freshly-installed binary is what gets loaded.
	const cli = join(__dirname, "cli.js");
	const entry = existsSync(cli) ? cli : join(__dirname, "cli.cjs"); // cli.js in npm shim, cli.cjs in repo
	const res = spawnSync(process.execPath, [entry, "service", "start"], { stdio: "inherit" });
	if (res.status !== 0) {
		console.log("backlog: could not auto-start the service; run `backlog service start` manually.");
	}
} catch (err) {
	if (process.env.BACKLOG_DEBUG) console.error("[backlog postinstall]", err);
	// Never fail the install.
	process.exit(0);
}
