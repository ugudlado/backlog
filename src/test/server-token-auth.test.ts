import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklogServer } from "../server/index.ts";

// Validates that both the Bearer header and the ?token= query param authenticate
// (the query param is required because browser WebSockets can't set headers),
// and that a bad/absent token is rejected.
describe("server token auth", () => {
	let server: BacklogServer;
	const port = 7659;
	const base = `http://localhost:${port}`;

	beforeAll(async () => {
		const dir = await mkdtemp(join(tmpdir(), "auth-"));
		await mkdir(join(dir, "backlog"), { recursive: true });
		await writeFile(join(dir, "backlog", "config.yml"), "projectName: T\n");
		process.env.BACKLOG_TOKEN = "secret123";
		server = new BacklogServer(dir);
		await server.start(port, false);
	});

	afterAll(async () => {
		await server.stop();
		delete process.env.BACKLOG_TOKEN;
	});

	it("rejects no token", async () => {
		expect((await fetch(`${base}/api/config`)).status).toBe(401);
	});
	it("rejects wrong token", async () => {
		expect((await fetch(`${base}/api/config`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
	});
	it("accepts Bearer header", async () => {
		expect((await fetch(`${base}/api/config`, { headers: { Authorization: "Bearer secret123" } })).status).toBe(200);
	});
	it("accepts ?token= query param (for WebSocket)", async () => {
		expect((await fetch(`${base}/api/config?token=secret123`)).status).toBe(200);
	});
});
