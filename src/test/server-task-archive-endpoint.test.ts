import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BacklogServer } from "../server/index.ts";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

const PORT = 7664;
const BASE = `http://localhost:${PORT}`;

async function createTask(title: string, status = "To Do"): Promise<string> {
	const res = await fetch(`${BASE}/api/tasks`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, status }),
	});
	expect(res.ok).toBe(true);
	const task = (await res.json()) as { id: string };
	return task.id;
}

async function listedIds(): Promise<string[]> {
	const res = await fetch(`${BASE}/api/tasks`);
	const tasks = (await res.json()) as Array<{ id: string }>;
	return tasks.map((task) => task.id);
}

// DELETE /api/tasks/:id and POST /api/tasks/:id/complete move files out of the
// tasks dir. The list must reflect that immediately (explicit store eviction),
// and failures must be distinguishable: 404 unknown id vs 500 archive failure.
describe("server task archive/complete endpoints", () => {
	let testDir: string;
	let server: BacklogServer;

	beforeAll(async () => {
		testDir = createUniqueTestDir("server-task-archive");
		await mkdir(join(testDir, "backlog"), { recursive: true });
		await writeFile(
			join(testDir, "backlog", "config.yml"),
			'projectName: Archive Endpoint\nstatuses: ["To Do", "In Progress", "Done"]\n',
		);
		server = new BacklogServer(testDir);
		await server.start(PORT, false);
	});

	afterAll(async () => {
		await server.stop();
		await safeCleanup(testDir);
	});

	it("archives a task and evicts it from the list immediately", async () => {
		const id = await createTask("Archive me");
		expect(await listedIds()).toContain(id);

		const res = await fetch(`${BASE}/api/tasks/${id}`, { method: "DELETE" });
		expect(res.status).toBe(200);

		expect(await listedIds()).not.toContain(id);

		// Task is gone from the tasks dir, so a second archive is a 404
		const again = await fetch(`${BASE}/api/tasks/${id}`, { method: "DELETE" });
		expect(again.status).toBe(404);
	});

	it("returns 404 for an unknown task id", async () => {
		const res = await fetch(`${BASE}/api/tasks/task-9999`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});

	it("completes a Done task and evicts it from the list immediately", async () => {
		const id = await createTask("Complete me", "Done");
		expect(await listedIds()).toContain(id);

		const res = await fetch(`${BASE}/api/tasks/${id}/complete`, { method: "POST" });
		expect(res.status).toBe(200);

		expect(await listedIds()).not.toContain(id);
	});
});
