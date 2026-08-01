import { describe, expect, test } from "bun:test";
import { KanbanApi, KanbanApiError } from "../src/kanban/api";
import { calculateMoveDestination } from "../src/kanban/reorder";
import {
	applyRealtimeEvent,
	classifyMutationFailure,
	createRealtimeState,
	parseKanbanEvent,
} from "../src/kanban/state";
import type { KanbanActivity, KanbanTask } from "../src/kanban/types";

const CREATED_AT = "2026-08-01T12:00:00.000Z";

function activity(cursor: number): KanbanActivity {
	return {
		id: `event-${cursor}`,
		cursor,
		sessionId: "session-1",
		taskId: "task-1",
		type: "task.updated",
		createdAt: CREATED_AT,
		data: {},
	};
}

function task(overrides: Partial<KanbanTask>): KanbanTask {
	return {
		id: "task-1",
		sessionId: "session-1",
		status: "ready",
		position: 0,
		title: "Ship native board",
		description: null,
		assignee: null,
		labels: [],
		dueAt: null,
		repo: null,
		worktree: null,
		branch: null,
		acceptanceCriteria: [],
		blockerReason: null,
		priority: "medium",
		version: 1,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		...overrides,
	};
}

describe("Kanban realtime state", () => {
	test("accepts newer cursors once and ignores replayed or out-of-order events", () => {
		const initial = createRealtimeState(4);
		const afterNew = applyRealtimeEvent(initial, activity(7));
		const afterReplay = applyRealtimeEvent(afterNew, activity(7));
		const afterOld = applyRealtimeEvent(afterReplay, activity(5));

		expect(afterNew).toEqual({ cursor: 7, activity: [activity(7)], reloadRequired: true });
		expect(afterReplay).toBe(afterNew);
		expect(afterOld).toBe(afterNew);
	});

	test("rejects malformed events before they can advance the cursor", () => {
		expect(() => parseKanbanEvent({ ...activity(1), cursor: -1 })).toThrow(
			"Kanban event cursor must be a nonnegative integer",
		);
		expect(() => parseKanbanEvent({ ...activity(1), type: "task.executed" })).toThrow("Kanban event type is invalid");
	});
});

describe("Kanban mutation safety", () => {
	test("calls the browser default fetch with the global receiver", async () => {
		const originalFetch = globalThis.fetch;
		let receiver: unknown;
		globalThis.fetch = function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
			receiver = this;
			return Promise.resolve(Response.json({ data: { tasks: [], activity: [], cursor: 0 } }));
		} as unknown as typeof globalThis.fetch;

		try {
			const api = new KanbanApi("session-1");
			expect(await api.loadBoard()).toEqual({ tasks: [], activity: [], cursor: 0 });
			expect(receiver).toBe(globalThis);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("blocks writes while disconnected without calling fetch", async () => {
		let calls = 0;
		const api = new KanbanApi(
			"session-1",
			async () => {
				calls += 1;
				return new Response(null, { status: 204 });
			},
			() => "disconnected",
		);

		await expect(
			api.createTask({
				title: "Never queued",
				status: "backlog",
				priority: "medium",
			}),
		).rejects.toMatchObject({ code: "disconnected" });
		expect(calls).toBe(0);
	});

	test("classifies a stale write as a conflict that requires an authoritative reload", () => {
		const failure = new KanbanApiError(409, "version_conflict", "This task changed elsewhere.");

		expect(classifyMutationFailure(failure)).toEqual({
			kind: "conflict",
			reloadRequired: true,
			announcement: "This task changed elsewhere. The latest board has been loaded.",
		});
	});
});

describe("Kanban reorder calculation", () => {
	test("removes the moving task before clamping its dense target index", () => {
		const tasks = [
			task({ id: "a", status: "ready", position: 0 }),
			task({ id: "b", status: "ready", position: 1 }),
			task({ id: "c", status: "ready", position: 2 }),
			task({ id: "d", status: "review", position: 0 }),
		];

		expect(calculateMoveDestination(tasks, "b", "ready", 3)).toEqual({ status: "ready", index: 2 });
		expect(calculateMoveDestination(tasks, "b", "review", 9)).toEqual({ status: "review", index: 1 });
		expect(() => calculateMoveDestination(tasks, "missing", "done", 0)).toThrow("Unknown Kanban task: missing");
	});
});
