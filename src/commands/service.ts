import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";

const LABEL = "md.backlog.browser";
const DEFAULT_PORT = 6420;

type Paths = {
	plistDir: string;
	plist: string;
	logDir: string;
	outLog: string;
	errLog: string;
	gui: string;
};

function paths(): Paths {
	const home = homedir();
	const plistDir = join(home, "Library", "LaunchAgents");
	const logDir = join(home, "Library", "Logs", "backlog-md");
	return {
		plistDir,
		plist: join(plistDir, `${LABEL}.plist`),
		logDir,
		outLog: join(logDir, "out.log"),
		errLog: join(logDir, "err.log"),
		gui: `gui/${process.getuid?.() ?? ""}`,
	};
}

function ensureSupportedOS(): void {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		console.error("backlog service: macOS (launchd) and Linux (systemd) only. For Windows see SERVICE.md.");
		process.exit(1);
	}
}

function launchctl(args: string[], { allowFail = false }: { allowFail?: boolean } = {}): number {
	const r = spawnSync("launchctl", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
	const status = r.status ?? 1;
	if (status !== 0 && !allowFail) {
		if (r.stderr) process.stderr.write(r.stderr);
		process.exit(status);
	}
	return status;
}

function renderPlist(bin: string, port: number, p: Paths): string {
	const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bin)}</string>
    <string>server</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(p.outLog)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(p.errLog)}</string>
</dict>
</plist>
`;
}

function resolveBacklogBin(): string {
	// Prefer the `backlog` on PATH (`command -v`) — that's the npm shim in
	// <npm-prefix>/bin, a STABLE path that survives `npm i -g` (npm rewrites the
	// shim's target, not the shim itself). process.execPath points into
	// node_modules (the platform binary, or `bun` in dev) and can move on
	// upgrade, so only trust it when it literally ends in `/backlog`.
	const exe = process.execPath;
	if (exe?.endsWith("/backlog")) return exe;
	const which = spawnSync("/bin/sh", ["-c", "command -v backlog"], { encoding: "utf8" });
	const found = which.stdout?.trim();
	if (found) return found;
	console.error("Could not locate the `backlog` binary. Install it with: npm install -g backlog.md");
	process.exit(1);
}

function isLoaded(p: Paths): boolean {
	const r = spawnSync("launchctl", ["print", `${p.gui}/${LABEL}`], { stdio: ["ignore", "ignore", "ignore"] });
	return r.status === 0;
}

function writePlist(port: number, p: Paths): void {
	mkdirSync(p.plistDir, { recursive: true });
	mkdirSync(p.logDir, { recursive: true });
	writeFileSync(p.plist, renderPlist(resolveBacklogBin(), port, p));
}

// `launchctl bootout` returns once the teardown is *queued*, not once the job
// is gone. Bootstrapping immediately after races that teardown and fails with
// "Bootstrap failed: 5: Input/output error". Boot out, then poll until the job
// actually leaves the domain before the caller bootstraps again.
function bootoutAndWait(p: Paths): void {
	if (!isLoaded(p)) return;
	launchctl(["bootout", `${p.gui}/${LABEL}`], { allowFail: true });
	// ponytail: 2s/50ms busy-wait is plenty for a single launchd job; bump only if it ever times out.
	const deadline = Date.now() + 2000;
	while (isLoaded(p) && Date.now() < deadline) {
		spawnSync("sleep", ["0.05"]); // sync pause without an event loop
	}
}

function doStart(port: number): void {
	const p = paths();
	writePlist(port, p);
	bootoutAndWait(p);
	launchctl(["bootstrap", p.gui, p.plist]);
	console.log(`Started ${LABEL} on port ${port}.`);
	console.log(`Open http://localhost:${port}`);
	console.log("Tip: create a project with `backlog project create <name>` if the UI shows no projects.");
}

function doStop(): void {
	const p = paths();
	bootoutAndWait(p);
	console.log(`Stopped ${LABEL}.`);
}

function doUninstall(): void {
	const p = paths();
	launchctl(["bootout", `${p.gui}/${LABEL}`], { allowFail: true });
	rmSync(p.plist, { force: true });
	console.log(`Uninstalled ${LABEL}.`);
}

function doStatus(): void {
	const p = paths();
	const r = spawnSync("launchctl", ["print", `${p.gui}/${LABEL}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (r.status !== 0) {
		console.log(`${LABEL}: not loaded (run \`backlog service start\`)`);
		return;
	}

	// launchd prints several contradictory `state = ...` lines (domain
	// membership, scheduling) even when no process is alive. The only
	// reliable liveness signal is a `pid = N` line: launchd emits it only
	// while the job is actually executing. Derive one truthful status from
	// the PID, then show the supporting detail lines.
	const pidMatch = r.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
	const pid = pidMatch ? Number(pidMatch[1]) : null;
	const alive =
		pid !== null &&
		(() => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		})();

	if (alive) {
		console.log(`${LABEL}: running (pid ${pid})`);
	} else {
		console.log(`${LABEL}: loaded but not running (no live process — check \`backlog service logs\`)`);
	}

	for (const line of r.stdout.split("\n")) {
		if (/^\s*(pid|program|last exit code)\s*=/.test(line)) console.log(`  ${line.trim()}`);
	}
}

function doLogs(): void {
	const p = paths();
	console.log(`stdout: ${p.outLog}`);
	console.log(`stderr: ${p.errLog}`);
	const r = spawnSync("tail", ["-n", "50", "-F", p.outLog, p.errLog], { stdio: "inherit" });
	process.exit(r.status ?? 0);
}

// ---------------------------------------------------------------------------
// Linux: systemd user unit. One unit serves every project (it resolves the
// current project from the global store), so no WorkingDirectory is needed.
// ExecStart embeds the resolved binary path — written here so it can never
// drift from where the binary actually lives (the bug that bites hand-authored
// units). `npm i -g` updates that path in place; a node-version change is the
// only thing that needs a re-run of `service start` to rewrite ExecStart.
// ---------------------------------------------------------------------------

const SYSTEMD_UNIT = "backlog.service";

function systemdUnitPath(): string {
	return join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}

function systemctlUser(args: string[], { allowFail = false }: { allowFail?: boolean } = {}): number {
	const r = spawnSync("systemctl", ["--user", ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
	const status = r.status ?? 1;
	if (status !== 0 && !allowFail) {
		if (r.stderr) process.stderr.write(r.stderr);
		process.exit(status);
	}
	return status;
}

export function renderUnit(bin: string, port: number): string {
	return `[Unit]
Description=Backlog Web UI
After=network.target

[Service]
Type=simple
ExecStart=${bin} server --port ${port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function writeUnit(port: number): void {
	const unitPath = systemdUnitPath();
	mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
	writeFileSync(unitPath, renderUnit(resolveBacklogBin(), port));
	systemctlUser(["daemon-reload"]);
}

function doStartLinux(port: number): void {
	writeUnit(port);
	// enable --now installs the WantedBy symlink and (re)starts in one step;
	// rewriting the unit + daemon-reload above means restart picks up the new
	// ExecStart, so this doubles as the restart path.
	systemctlUser(["enable", "--now", SYSTEMD_UNIT]);
	systemctlUser(["restart", SYSTEMD_UNIT]);
	console.log(`Started ${SYSTEMD_UNIT} on port ${port}.`);
	console.log(`Open http://localhost:${port}`);
	console.log(
		"Tip: enable lingering (`sudo loginctl enable-linger $USER`) so it starts at boot without a login session.",
	);
	console.log("Tip: create a project with `backlog project create <name>` if the UI shows no projects.");
}

function doStopLinux(): void {
	systemctlUser(["stop", SYSTEMD_UNIT], { allowFail: true });
	console.log(`Stopped ${SYSTEMD_UNIT}.`);
}

function doUninstallLinux(): void {
	systemctlUser(["disable", "--now", SYSTEMD_UNIT], { allowFail: true });
	rmSync(systemdUnitPath(), { force: true });
	systemctlUser(["daemon-reload"], { allowFail: true });
	console.log(`Uninstalled ${SYSTEMD_UNIT}.`);
}

function doStatusLinux(): void {
	// is-active gives the one-word truth; status adds the detail lines.
	const active = spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], { encoding: "utf8" });
	const state = active.stdout?.trim() || "unknown";
	if (state !== "active") {
		console.log(`${SYSTEMD_UNIT}: ${state} (run \`backlog service start\`)`);
		return;
	}
	console.log(`${SYSTEMD_UNIT}: running`);
	spawnSync("systemctl", ["--user", "status", SYSTEMD_UNIT, "--no-pager", "-n", "0"], { stdio: "inherit" });
}

function doLogsLinux(): void {
	const r = spawnSync("journalctl", ["--user", "-u", SYSTEMD_UNIT, "-n", "50", "-f"], { stdio: "inherit" });
	process.exit(r.status ?? 0);
}

const isLinux = process.platform === "linux";

function parsePortOrExit(raw: string): number {
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`Invalid --port: ${raw}`);
		process.exit(2);
	}
	return port;
}

export function registerServiceCommand(program: Command): void {
	const svc = program
		.command("service")
		.description("manage backlog server as a background service (macOS launchd / Linux systemd)");

	svc
		.command("start")
		.description("install (if needed) and start the service")
		.option("-p, --port <port>", "port to serve on", String(DEFAULT_PORT))
		.action((opts: { port: string }) => {
			ensureSupportedOS();
			const port = parsePortOrExit(opts.port);
			isLinux ? doStartLinux(port) : doStart(port);
		});

	svc
		.command("restart")
		.description("restart the service (picks up an upgraded binary)")
		.option("-p, --port <port>", "port to serve on", String(DEFAULT_PORT))
		.action((opts: { port: string }) => {
			ensureSupportedOS();
			const port = parsePortOrExit(opts.port);
			isLinux ? doStartLinux(port) : doStart(port);
		});

	svc
		.command("stop")
		.description("stop the service (unit preserved; use `uninstall` to remove)")
		.action(() => {
			ensureSupportedOS();
			isLinux ? doStopLinux() : doStop();
		});

	svc
		.command("uninstall")
		.description("stop and remove the service")
		.action(() => {
			ensureSupportedOS();
			isLinux ? doUninstallLinux() : doUninstall();
		});

	svc
		.command("status")
		.description("show service status")
		.action(() => {
			ensureSupportedOS();
			isLinux ? doStatusLinux() : doStatus();
		});

	svc
		.command("logs")
		.description("tail service logs")
		.action(() => {
			ensureSupportedOS();
			isLinux ? doLogsLinux() : doLogs();
		});
}
