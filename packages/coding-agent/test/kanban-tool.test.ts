import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as kanban from "@oh-my-pi/pi-coding-agent/kanban/index";
import type { KanbanModelApi } from "@oh-my-pi/pi-coding-agent/kanban/runtime";
import { KanbanStore } from "@oh-my-pi/pi-coding-agent/kanban/store";
import type { KanbanToolDetails } from "@oh-my-pi/pi-coding-agent/kanban/tool";
import { KanbanTool } from "@oh-my-pi/pi-coding-agent/kanban/tool";
import type { KanbanActivity } from "@oh-my-pi/pi-coding-agent/kanban/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const SESSION_ID = "kanban-tool-session";
const BOARD_ID = "kanban-tool-project";
const roots: string[] = [];
const openStores: KanbanStore[] = [];

function requireDetails(result: AgentToolResult<KanbanToolDetails>): KanbanToolDetails {
	expect(result.details).toBeDefined();
	if (result.details === undefined) {
		throw new Error("expected Kanban tool result details");
	}
	return result.details;
}

function taskCreate(title: string, status: "backlog" | "ready" | "in_progress" = "backlog") {
	return {
		title,
		status,
		priority: "medium" as const,
		description: null,
		assignee: null,
		labels: [] as string[],
		dueAt: null,
	};
}

async function createHarness(): Promise<{
	store: KanbanStore;
	tool: KanbanTool;
	published: Array<KanbanActivity | null | undefined>;
	api: KanbanModelApi;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-tool-"));
	roots.push(root);
	const store = KanbanStore.open(path.join(root, "kanban.db"));
	openStores.push(store);

	const published: Array<KanbanActivity | null | undefined> = [];
	const api: KanbanModelApi = {
		boardId: BOARD_ID,
		sessionName: "swift-otter",
		store,
		publish(activity) {
			published.push(activity);
		},
	};

	vi.spyOn(kanban, "getKanbanModelApi").mockReturnValue(api);

	const session = {
		cwd: root,
		hasUI: false,
		getSessionId: () => SESSION_ID,
	} as ToolSession;
	return { store, tool: new KanbanTool(session), published, api };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const store of openStores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("KanbanTool", () => {
	it("creates and reads a task from the model API board rather than the session id", async () => {
		const { store, tool, published } = await createHarness();
		const title = "Ship kanban tool round trip";

		const created = await tool.execute("call-create", {
			op: "create",
			task: taskCreate(title),
		});
		const createdDetails = requireDetails(created);
		const taskId = createdDetails.taskId;
		expect(createdDetails.task?.title).toBe(title);
		expect(taskId).toBe(createdDetails.task?.id);
		expect(taskId).toBeDefined();
		if (taskId === undefined) {
			throw new Error("expected created taskId");
		}

		const board = await tool.execute("call-board", { op: "board" });
		const boardDetails = requireDetails(board);
		const boardTasks = boardDetails.board?.tasks ?? [];
		expect(boardTasks.some(task => task.id === taskId && task.title === title)).toBe(true);
		expect(JSON.stringify(board.content)).toContain(title);

		const stored = store.getTask(BOARD_ID, taskId);
		expect(stored.title).toBe(title);
		expect(stored.id).toBe(taskId);

		expect(published).toHaveLength(1);
		expect(published[0]).not.toBeNull();
		expect(published[0]?.type).toBe("task.created");
	});

	it("creates a minimal task through the real store and publishes task.created once", async () => {
		const { store, tool, published } = await createHarness();

		const created = await tool.execute("call-minimal-create", {
			op: "create",
			task: { title: "Tool proof task", status: "backlog", priority: "high" },
		});
		const taskId = requireDetails(created).taskId;
		expect(taskId).toBeDefined();
		if (taskId === undefined) {
			throw new Error("expected created taskId");
		}

		const stored = store.getTask(BOARD_ID, taskId);
		expect(stored).toMatchObject({ id: taskId, title: "Tool proof task", status: "backlog", priority: "high" });
		expect(published).toHaveLength(1);
		expect(published[0]?.type).toBe("task.created");
	});

	it("moves a task through the real store and publishes task.moved once", async () => {
		const { store, tool, published } = await createHarness();
		const seeded = await tool.execute("call-move-seed", {
			op: "create",
			task: taskCreate("Move proof task"),
		});
		const taskId = requireDetails(seeded).taskId;
		expect(taskId).toBeDefined();
		if (taskId === undefined) {
			throw new Error("expected created taskId");
		}
		published.length = 0;

		await tool.execute("call-minimal-move", {
			op: "move",
			taskId,
			move: { expectedVersion: 1, status: "ready", index: 0 },
		});

		expect(store.getTask(BOARD_ID, taskId)).toMatchObject({ id: taskId, status: "ready", version: 2 });
		expect(published).toHaveLength(1);
		expect(published[0]?.type).toBe("task.moved");
	});

	it("comments through the real store and publishes comment.created once", async () => {
		const { store, tool, published } = await createHarness();
		const seeded = await tool.execute("call-comment-seed", {
			op: "create",
			task: taskCreate("Comment proof task"),
		});
		const taskId = requireDetails(seeded).taskId;
		expect(taskId).toBeDefined();
		if (taskId === undefined) {
			throw new Error("expected created taskId");
		}
		published.length = 0;

		const commented = await tool.execute("call-minimal-comment", {
			op: "comment",
			taskId,
			comment: { author: "Tool proof", body: "Regression coverage" },
		});
		const commentId = requireDetails(commented).comment?.id;
		expect(commentId).toBeDefined();
		if (commentId === undefined) {
			throw new Error("expected commentId");
		}

		expect(store.listComments(BOARD_ID, taskId)).toContainEqual(
			expect.objectContaining({ id: commentId, author: "Tool proof", body: "Regression coverage" }),
		);
		expect(published).toHaveLength(1);
		expect(published[0]?.type).toBe("comment.created");
	});

	it("surfaces version_conflict ToolError and skips publish on stale mutation", async () => {
		const { tool, published } = await createHarness();

		const created = await tool.execute("call-create", {
			op: "create",
			task: taskCreate("Conflict probe"),
		});
		const createdDetails = requireDetails(created);
		const taskId = createdDetails.taskId;
		expect(taskId).toBeDefined();
		if (taskId === undefined) {
			throw new Error("expected created taskId");
		}
		expect(createdDetails.task?.version).toBe(1);

		const moved = await tool.execute("call-move", {
			op: "move",
			taskId,
			move: { expectedVersion: 1, status: "ready", index: 0 },
		});
		expect(requireDetails(moved).task?.version).toBe(2);
		expect(published).toHaveLength(2);

		const publishCountBeforeStale = published.length;
		let error: unknown;
		try {
			await tool.execute("call-stale-move", {
				op: "move",
				taskId,
				move: { expectedVersion: 1, status: "in_progress", index: 0 },
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(ToolError);
		const message = (error as ToolError).message;
		expect(message).toContain("version_conflict");
		expect(message).toContain("The resource changed since it was loaded");
		expect(message).toMatch(/[Rr]e-read/);
		expect(message).toMatch(/current version/i);
		expect(published).toHaveLength(publishCountBeforeStale);
	});
	it("mounts using the provider session id and reads its shared board", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-tool-"));
		roots.push(root);
		const store = KanbanStore.open(path.join(root, "kanban.db"));
		openStores.push(store);
		const providerId = "provider-id";
		const boardId = "provider-project-board";
		const input = taskCreate("Provider board task");
		const seeded = store.createTask(boardId, input, {
			key: "provider-board-seed",
			method: "POST",
			route: `/api/v1/boards/${boardId}/tasks`,
			body: input,
		});
		const observedLookupIds: string[] = [];
		const api: KanbanModelApi = {
			boardId,
			sessionName: "swift-otter",
			store,
			publish() {},
		};
		vi.spyOn(kanban, "getKanbanModelApi").mockImplementation(sessionId => {
			observedLookupIds.push(sessionId);
			return sessionId === providerId ? api : null;
		});
		const session = {
			cwd: root,
			hasUI: false,
			getSessionId: () => "manager-id",
			getKanbanSessionId: () => providerId,
		} as ToolSession;

		const tool = KanbanTool.createIf(session);
		expect(tool).not.toBeNull();
		if (tool === null) throw new Error("expected Kanban tool to mount");

		const result = await tool.execute("call-provider-board", { op: "board" });
		expect(requireDetails(result).board?.tasks).toEqual([
			expect.objectContaining({ id: seeded.data.id, title: "Provider board task" }),
		]);
		expect(observedLookupIds).toEqual([providerId, providerId]);
	});

	it("falls back to the session-manager id and reads its shared board", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-tool-"));
		roots.push(root);
		const store = KanbanStore.open(path.join(root, "kanban.db"));
		openStores.push(store);
		const managerId = "manager-id";
		const boardId = "manager-project-board";
		const input = taskCreate("Manager board task");
		const seeded = store.createTask(boardId, input, {
			key: "manager-board-seed",
			method: "POST",
			route: `/api/v1/boards/${boardId}/tasks`,
			body: input,
		});
		const observedLookupIds: string[] = [];
		const api: KanbanModelApi = {
			boardId,
			sessionName: "swift-otter",
			store,
			publish() {},
		};
		vi.spyOn(kanban, "getKanbanModelApi").mockImplementation(sessionId => {
			observedLookupIds.push(sessionId);
			return sessionId === managerId ? api : null;
		});
		const session = {
			cwd: root,
			hasUI: false,
			getSessionId: () => managerId,
		} as ToolSession;

		const tool = KanbanTool.createIf(session);
		expect(tool).not.toBeNull();
		if (tool === null) throw new Error("expected Kanban tool to mount");

		const result = await tool.execute("call-manager-board", { op: "board" });
		expect(requireDetails(result).board?.tasks).toEqual([
			expect.objectContaining({ id: seeded.data.id, title: "Manager board task" }),
		]);
		expect(observedLookupIds).toEqual([managerId, managerId]);
	});
});
