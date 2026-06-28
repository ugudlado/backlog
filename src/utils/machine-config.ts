import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getMachineConfigDir } from "./projects-index.ts";

export interface MachineConfig {
	globalStore: string | null;
	backlogUrl: string | null;
	/** Token this machine sends to a remote server (config key: `client_token`). */
	clientToken: string | null;
	/** Tokens the embedded server accepts (config key: `server_tokens`). Includes clientToken if set. */
	serverTokens: string[];
}

const MACHINE_CONFIG_FILENAME = "config.yml";

const EMPTY_MACHINE_CONFIG: MachineConfig = {
	globalStore: null,
	backlogUrl: null,
	clientToken: null,
	serverTokens: [],
};

/** Module-level cache keyed by resolved override string. */
const cache = new Map<string, MachineConfig>();

function stripYamlQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

function parseBacklogUrl(raw: string): string | null {
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			console.warn(`[backlog] machine config: backlog_url must use http or https (got: ${raw}). Ignoring.`);
			return null;
		}
		return raw.replace(/\/$/, "");
	} catch {
		console.warn(`[backlog] machine config: backlog_url must be a valid http(s) URL (got: ${raw}). Ignoring.`);
		return null;
	}
}

/** Returns the `- item` value if the line is a YAML block-list entry, else null. */
function parseListItem(rawLine: string): string | null {
	const trimmed = rawLine.trim();
	if (!trimmed.startsWith("- ") && trimmed !== "-") return null;
	return stripYamlQuotes(trimmed.slice(1).trim());
}

function parseMachineConfigYaml(content: string): MachineConfig {
	let globalStore: string | null = null;
	let backlogUrl: string | null = null;
	let clientToken: string | null = null;
	let serverTokens: string[] = [];

	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (!line || line.startsWith("#")) continue;

		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const key = line.slice(0, colonIdx).trim();
		const raw = stripYamlQuotes(line.slice(colonIdx + 1).trim());

		// Block array: key with empty value, items follow as `- item` lines.
		if (key === "server_tokens" && !raw) {
			const items: string[] = [];
			while (i + 1 < lines.length) {
				const next = lines[i + 1] ?? "";
				if (!next.trim() || next.trim().startsWith("#")) {
					i++;
					continue;
				}
				const item = parseListItem(next);
				if (item === null) break; // next top-level key
				if (item) items.push(item);
				i++;
			}
			serverTokens = items;
			continue;
		}

		if (!raw) continue;

		if (key === "globalStore") {
			const expanded = expandHome(raw);
			if (!isAbsolute(expanded)) {
				console.warn(`[backlog] machine config: globalStore must be an absolute path (got: ${raw}). Ignoring.`);
				continue;
			}
			globalStore = expanded;
			continue;
		}

		if (key === "backlog_url" || key === "backlogUrl") {
			backlogUrl = parseBacklogUrl(raw);
			continue;
		}

		if (key === "client_token") {
			clientToken = raw;
		}
	}

	// The client token is always an accepted server token; dedupe in case it's also listed.
	const accepted = clientToken ? [clientToken, ...serverTokens] : serverTokens;
	return { globalStore, backlogUrl, clientToken, serverTokens: [...new Set(accepted)] };
}

/**
 * Reads the machine-level config file (`config.yml` inside the machine config dir).
 * Results are cached per override value until `clearMachineConfigCache()` is called.
 *
 * @param override - Optional path override (same semantics as getMachineConfigDir).
 *                   In tests, use BACKLOG_MACHINE_CONFIG_DIR env var or pass the temp dir directly.
 */
export function readMachineConfig(override?: string): MachineConfig {
	const cacheKey = override ?? "<default>";
	const cached = cache.get(cacheKey);
	if (cached) return cached;

	const configDir = getMachineConfigDir(override);
	const configPath = join(configDir, MACHINE_CONFIG_FILENAME);

	let content: string;
	try {
		content = readFileSync(configPath, "utf8");
	} catch {
		const result = { ...EMPTY_MACHINE_CONFIG };
		cache.set(cacheKey, result);
		return result;
	}

	const result = parseMachineConfigYaml(content);
	cache.set(cacheKey, result);
	return result;
}

/**
 * Clears the machine config cache. Must be called in tests when the
 * BACKLOG_MACHINE_CONFIG_DIR env var or the config file content changes.
 */
export function clearMachineConfigCache(): void {
	cache.clear();
}
