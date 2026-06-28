import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearMachineConfigCache, readMachineConfig } from "./machine-config.ts";
import { BACKLOG_TOKEN_ENV, BACKLOG_URL_ENV, getRemoteToken, getRemoteUrl, isRemoteMode } from "./remote-backend.ts";

const TMP_DIR = join(import.meta.dir, "__tmp_machine_config__");

const origEnv = process.env.BACKLOG_MACHINE_CONFIG_DIR;
const origBacklogUrl = process.env[BACKLOG_URL_ENV];
const origBacklogToken = process.env[BACKLOG_TOKEN_ENV];

beforeEach(async () => {
	await mkdir(TMP_DIR, { recursive: true });
	process.env.BACKLOG_MACHINE_CONFIG_DIR = TMP_DIR;
	delete process.env[BACKLOG_URL_ENV];
	delete process.env[BACKLOG_TOKEN_ENV];
	clearMachineConfigCache();
});

afterEach(async () => {
	clearMachineConfigCache();
	if (origEnv === undefined) {
		delete process.env.BACKLOG_MACHINE_CONFIG_DIR;
	} else {
		process.env.BACKLOG_MACHINE_CONFIG_DIR = origEnv;
	}
	if (origBacklogUrl === undefined) {
		delete process.env[BACKLOG_URL_ENV];
	} else {
		process.env[BACKLOG_URL_ENV] = origBacklogUrl;
	}
	if (origBacklogToken === undefined) {
		delete process.env[BACKLOG_TOKEN_ENV];
	} else {
		process.env[BACKLOG_TOKEN_ENV] = origBacklogToken;
	}
	await rm(TMP_DIR, { recursive: true, force: true });
});

const emptyConfig = { globalStore: null, backlogUrl: null, clientToken: null, serverTokens: [] };

describe("readMachineConfig", () => {
	it("returns empty config when config file is absent", () => {
		const config = readMachineConfig(TMP_DIR);
		expect(config).toEqual(emptyConfig);
	});

	it("returns empty config when file exists but has no recognized keys", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "# just a comment\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config).toEqual(emptyConfig);
	});

	it("returns the globalStore path when set to an absolute path", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: /tmp/my-store\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe("/tmp/my-store");
		expect(config.backlogUrl).toBeNull();
		expect(config.clientToken).toBeNull();
	});

	it("expands tilde in globalStore path", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: ~/backlog-store\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe(join(homedir(), "backlog-store"));
	});

	it("returns null globalStore and treats relative path as null (with no throw)", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: relative/path\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBeNull();
	});

	it("parses backlog_url and client_token", async () => {
		await writeFile(
			join(TMP_DIR, "config.yml"),
			"backlog_url: http://server.example:6420/\nclient_token: secret-token\n",
		);
		const config = readMachineConfig(TMP_DIR);
		expect(config.backlogUrl).toBe("http://server.example:6420");
		expect(config.clientToken).toBe("secret-token");
	});

	it("accepts camelCase backlogUrl", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "backlogUrl: https://host/backlog\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.backlogUrl).toBe("https://host/backlog");
	});

	it("parses server_tokens as a YAML block array", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "server_tokens:\n  - alice\n  - bob\n  - ci\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.serverTokens).toEqual(["alice", "bob", "ci"]);
	});

	it("merges singular client_token into serverTokens and dedupes", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "client_token: alice\nserver_tokens:\n  - alice\n  - bob\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.serverTokens).toEqual(["alice", "bob"]);
	});

	it("stops the block array at the next top-level key", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "server_tokens:\n  - alice\nbacklog_url: http://h:6420\n");
		const config = readMachineConfig(TMP_DIR);
		expect(config.serverTokens).toEqual(["alice"]);
		expect(config.backlogUrl).toBe("http://h:6420");
	});

	it("strips YAML quotes from values", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), 'globalStore: "/tmp/quoted-store"\n');
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe("/tmp/quoted-store");
	});

	it("ignores blank lines and comment lines", async () => {
		const content = `
# machine config
# globalStore: /ignored

globalStore: /tmp/real-store
backlog_url: http://localhost:6420
`;
		await writeFile(join(TMP_DIR, "config.yml"), content);
		const config = readMachineConfig(TMP_DIR);
		expect(config.globalStore).toBe("/tmp/real-store");
		expect(config.backlogUrl).toBe("http://localhost:6420");
	});

	it("cache returns same instance until clearMachineConfigCache is called", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: /tmp/store1\n");
		const first = readMachineConfig(TMP_DIR);

		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: /tmp/store2\n");
		const second = readMachineConfig(TMP_DIR);
		expect(second).toBe(first);

		clearMachineConfigCache();
		const third = readMachineConfig(TMP_DIR);
		expect(third.globalStore).toBe("/tmp/store2");
		expect(third).not.toBe(first);
	});

	it("uses BACKLOG_MACHINE_CONFIG_DIR env var when no override is passed", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "globalStore: /tmp/env-store\n");
		const config = readMachineConfig();
		expect(config.globalStore).toBe("/tmp/env-store");
	});
});

describe("remote config resolution", () => {
	it("prefers BACKLOG_URL over machine config", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "backlog_url: http://config-host:6420\n");
		process.env[BACKLOG_URL_ENV] = "http://env-host:6420";
		clearMachineConfigCache();
		expect(getRemoteUrl()).toBe("http://env-host:6420");
	});

	it("falls back to backlog_url from machine config", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "backlog_url: http://config-host:6420/\n");
		clearMachineConfigCache();
		expect(getRemoteUrl()).toBe("http://config-host:6420");
		expect(isRemoteMode()).toBe(true);
	});

	it("prefers BACKLOG_TOKEN over machine config", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "client_token: from-config\n");
		process.env[BACKLOG_TOKEN_ENV] = "from-env";
		clearMachineConfigCache();
		expect(getRemoteToken()).toBe("from-env");
	});

	it("falls back to client_token from machine config", async () => {
		await writeFile(join(TMP_DIR, "config.yml"), "client_token: from-config\n");
		clearMachineConfigCache();
		expect(getRemoteToken()).toBe("from-config");
	});
});
