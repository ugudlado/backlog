import { describe, expect, test } from "bun:test";
import { sortForPickup } from "../utils/task-sorting.ts";

// createdDate comparison: lexicographic string comparison of ISO-like format
// ("yyyy-mm-dd HH:mm" or "yyyy-mm-dd"). This is correct because the format is
// consistently zero-padded. Missing dates sort LAST so well-formed tasks are preferred.

type PickupTask = {
	id: string;
	ordinal?: number;
	priority?: "high" | "medium" | "low";
	createdDate?: string;
};

describe("sortForPickup", () => {
	test("tasks with ordinal come before tasks without ordinal", () => {
		const tasks: PickupTask[] = [{ id: "task-3" }, { id: "task-1", ordinal: 2 }, { id: "task-2", ordinal: 1 }];
		const sorted = sortForPickup(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["task-2", "task-1", "task-3"]);
	});

	test("tasks with same ordinal are sorted by ordinal ASC", () => {
		const tasks: PickupTask[] = [
			{ id: "task-1", ordinal: 30 },
			{ id: "task-2", ordinal: 10 },
			{ id: "task-3", ordinal: 20 },
		];
		const sorted = sortForPickup(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["task-2", "task-3", "task-1"]);
	});

	test("tasks with equal ordinals are sorted by priority DESC", () => {
		const tasks: PickupTask[] = [
			{ id: "task-1", ordinal: 1, priority: "low" },
			{ id: "task-2", ordinal: 1, priority: "high" },
			{ id: "task-3", ordinal: 1, priority: "medium" },
		];
		const sorted = sortForPickup(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["task-2", "task-3", "task-1"]);
	});

	test("priority DESC: high > medium > low > undefined", () => {
		const tasks: PickupTask[] = [
			{ id: "task-1" },
			{ id: "task-2", priority: "low" },
			{ id: "task-3", priority: "high" },
			{ id: "task-4", priority: "medium" },
		];
		const sorted = sortForPickup(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["task-3", "task-4", "task-2", "task-1"]);
	});

	test("tasks with equal priority are sorted by createdDate ASC (oldest first)", () => {
		const tasks: PickupTask[] = [
			{ id: "task-1", priority: "medium", createdDate: "2024-03-01" },
			{ id: "task-2", priority: "medium", createdDate: "2024-01-01" },
			{ id: "task-3", priority: "medium", createdDate: "2024-02-01" },
		];
		const sorted = sortForPickup(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["task-2", "task-3", "task-1"]);
	});

	test("tasks without createdDate sort after tasks with createdDate", () => {
		const tasks: PickupTask[] = [
			{ id: "task-1", priority: "high" },
			{ id: "task-2", priority: "high", createdDate: "2024-01-01" },
			{ id: "task-3", priority: "high", createdDate: "2024-02-01" },
		];
		const sorted = sortForPickup(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["task-2", "task-3", "task-1"]);
	});

	test("task id is the final stable tiebreaker (ASC) when all else equal", () => {
		const tasks: PickupTask[] = [
			{ id: "task-10", priority: "high", createdDate: "2024-01-01" },
			{ id: "task-2", priority: "high", createdDate: "2024-01-01" },
			{ id: "task-5", priority: "high", createdDate: "2024-01-01" },
		];
		const sorted = sortForPickup(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["task-2", "task-5", "task-10"]);
	});

	test("combined ordering: ordinal > priority > createdDate > id", () => {
		const tasks: PickupTask[] = [
			// No ordinal, medium priority, old date → should come after all with ordinal
			{ id: "task-5", priority: "medium", createdDate: "2020-01-01" },
			// Ordinal 1, no priority → ordinal wins, but lower priority
			{ id: "task-3", ordinal: 1 },
			// Ordinal 1, high priority → ordinal 1 wins, then priority
			{ id: "task-1", ordinal: 1, priority: "high" },
			// Ordinal 2 → comes after ordinal 1 tasks
			{ id: "task-2", ordinal: 2, priority: "high" },
			// No ordinal, high priority, old date → after ordinal tasks
			{ id: "task-4", priority: "high", createdDate: "2020-01-01" },
		];
		const sorted = sortForPickup(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["task-1", "task-3", "task-2", "task-4", "task-5"]);
	});

	test("returns new array, does not mutate original", () => {
		const tasks: PickupTask[] = [
			{ id: "task-2", priority: "low" },
			{ id: "task-1", priority: "high" },
		];
		const original = [...tasks];
		sortForPickup(tasks);
		expect(tasks).toEqual(original);
	});

	test("handles empty array", () => {
		expect(sortForPickup([])).toEqual([]);
	});

	test("handles single element", () => {
		const tasks: PickupTask[] = [{ id: "task-1", priority: "high" }];
		const sorted = sortForPickup(tasks);
		expect(sorted).toEqual(tasks);
	});
});
