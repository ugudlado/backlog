// NO_PROXY support for the spawned binary.
//
// The compiled binary uses Bun's fetch, which honors HTTPS_PROXY/HTTP_PROXY but
// IGNORES NO_PROXY — and reads the proxy once at startup, so it can't be fixed
// from inside the binary. In TLS-intercepting sandboxes (e.g. Claude Code cloud
// sessions) the proxy can't route to a directly-reachable backlog host (e.g. a
// Tailscale Funnel URL) and closes the socket. Standard tooling lets users set
// NO_PROXY to bypass the proxy for specific hosts; this makes the binary honor it.
//
// Strategy: in the shim (which CAN mutate the child env), if the configured
// backlog host matches NO_PROXY, strip the proxy vars before spawn so the binary
// connects directly. Only that host is affected; the proxy stays in force for
// everything else. No-op when NO_PROXY is unset or doesn't match.

const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

/** Resolve the backlog host: BACKLOG_URL env, else backlog_url in the machine config. */
function resolveBacklogHost(env) {
	const fromEnv = env.BACKLOG_URL && env.BACKLOG_URL.trim();
	if (fromEnv) return hostOf(fromEnv);

	const configDir = env.BACKLOG_MACHINE_CONFIG_DIR || join(homedir(), ".config", "backlog");
	let content;
	try {
		content = readFileSync(join(configDir, "config.yml"), "utf8");
	} catch {
		return undefined;
	}
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("#")) continue;
		const m = /^backlog_?url\s*:\s*(.+)$/i.exec(line);
		if (m) return hostOf(stripQuotes(m[1].trim()));
	}
	return undefined;
}

function stripQuotes(s) {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
	return s;
}

function hostOf(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/** True if `host` matches any entry in the NO_PROXY list (exact or domain-suffix). */
function noProxyMatches(host, noProxy) {
	if (!host || !noProxy) return false;
	const h = host.toLowerCase();
	for (let entry of noProxy.split(",")) {
		entry = entry.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*") return true;
		const bare = entry.replace(/^\*?\./, ""); // ".example.com" / "*.example.com" -> "example.com"
		if (h === bare || h.endsWith(`.${bare}`)) return true;
	}
	return false;
}

const PROXY_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

/**
 * Returns a child env: a copy of `env` with proxy vars stripped IFF the backlog
 * host matches NO_PROXY. Otherwise returns `env` unchanged.
 */
function envWithProxyBypass(env = process.env) {
	const noProxy = env.NO_PROXY || env.no_proxy;
	if (!noProxy) return env;
	const host = resolveBacklogHost(env);
	if (!noProxyMatches(host, noProxy)) return env;

	const out = { ...env };
	for (const v of PROXY_VARS) delete out[v];
	return out;
}

module.exports = { envWithProxyBypass, resolveBacklogHost, noProxyMatches };
