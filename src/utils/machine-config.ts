import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getMachineConfigDir } from "./workspaces-index.ts";

export interface MachineConfig {
	globalStore: string | null;
}

const MACHINE_CONFIG_FILENAME = "config.yml";

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

function parseMachineConfigYaml(content: string): MachineConfig {
	let globalStore: string | null = null;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const key = line.slice(0, colonIdx).trim();
		if (key !== "globalStore") continue;

		const raw = stripYamlQuotes(line.slice(colonIdx + 1).trim());
		if (!raw) continue;

		const expanded = expandHome(raw);
		if (!isAbsolute(expanded)) {
			console.warn(`[backlog] machine config: globalStore must be an absolute path (got: ${raw}). Ignoring.`);
			continue;
		}

		globalStore = expanded;
		break;
	}

	return { globalStore };
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
		const result: MachineConfig = { globalStore: null };
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
