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

function ensureMacOS(): void {
	if (process.platform !== "darwin") {
		console.error("backlog service: macOS only (uses launchd). For Linux/Windows see SERVICE.md in the project repo.");
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

function doStart(port: number): void {
	const p = paths();
	writePlist(port, p);
	if (isLoaded(p)) {
		launchctl(["bootout", `${p.gui}/${LABEL}`], { allowFail: true });
	}
	launchctl(["bootstrap", p.gui, p.plist]);
	console.log(`Started ${LABEL} on port ${port}.`);
	console.log(`Open http://localhost:${port}`);
	console.log("Tip: create a project with `backlog init <name>` if the UI shows no projects.");
}

function doStop(): void {
	const p = paths();
	launchctl(["bootout", `${p.gui}/${LABEL}`], { allowFail: true });
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

export function registerServiceCommand(program: Command): void {
	const svc = program.command("service").description("manage backlog server as a macOS launchd service");

	svc
		.command("start")
		.description("install (if needed) and start the launchd service")
		.option("-p, --port <port>", "port to serve on", String(DEFAULT_PORT))
		.action((opts: { port: string }) => {
			ensureMacOS();
			const port = Number.parseInt(opts.port, 10);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				console.error(`Invalid --port: ${opts.port}`);
				process.exit(2);
			}
			doStart(port);
		});

	svc
		.command("stop")
		.description("stop the service (plist preserved; use `uninstall` to remove)")
		.action(() => {
			ensureMacOS();
			doStop();
		});

	svc
		.command("uninstall")
		.description("stop and remove the launchd service")
		.action(() => {
			ensureMacOS();
			doUninstall();
		});

	svc
		.command("status")
		.description("show service status")
		.action(() => {
			ensureMacOS();
			doStatus();
		});

	svc
		.command("logs")
		.description("tail service logs")
		.action(() => {
			ensureMacOS();
			doLogs();
		});
}
