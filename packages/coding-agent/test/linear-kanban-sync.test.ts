import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	getKanbanModelApi,
	setKanbanBoardForker,
	startKanbanBoard,
	stopKanbanBoard,
} from "../src/kanban";
import {
	getLinearIntegrationStatus,
	startLinearIntegration,
	stopLinearIntegration,
	syncLinearIntegration,
} from "../src/linear/runtime";
import { MCPManager } from "../src/mcp/manager";
import type { MCPServerConnection, MCPToolDefinition } from "../src/mcp/types";
import type {
	KanbanCustomMessagePayload,
	KanbanForkedAgent,
	KanbanForkRequest,
	KanbanPromptOptions,
	KanbanSessionPort,
} from "../src/kanban/runtime";
import { YieldQueue } from "../src/session/yield-queue";

class TestSession implements KanbanSessionPort {
	isDisposed = false;
	readonly yieldQueue = new YieldQueue({
		isStreaming: () => false,
		injectIdle: async () => {},
		scheduleIdleFlush: () => {},
	});
	readonly forks: string[] = [];
	readonly forwarded: string[] = [];
	readonly notices: string[] = [];
	readonly #durableListeners = new Set<(eventIds: readonly string[]) => void>();
	readonly agent: KanbanForkedAgent = {
		id: "linear-worker",
		settled: Promise.withResolvers<void>().promise,
		send: async work => {
			this.forwarded.push(work);
			return true;
		},
		cancel: () => {},
	};

	constructor(readonly sessionId: string) {}

	get isStreaming(): boolean {
		return false;
	}

	async promptCustomMessage(_message: KanbanCustomMessagePayload, _options: KanbanPromptOptions): Promise<void> {}

	emitNotice(_level: "info" | "warning" | "error", message: string): void {
		this.notices.push(message);
	}

	async forkBoardAgent(request: KanbanForkRequest): Promise<KanbanForkedAgent> {
		this.forks.push(request.work);
		return this.agent;
	}

	onKanbanEventsDurable(listener: (eventIds: readonly string[]) => void): () => void {
		this.#durableListeners.add(listener);
		return () => this.#durableListeners.delete(listener);
	}

	setKanbanBriefing(_section: string | null): void {}

	hasDurableKanbanEvent(_eventId: string): boolean {
		return false;
	}
}

interface LinearFixture {
	issues: unknown;
	comments: unknown;
	calls: Array<{ name: string; args: Record<string, unknown> }>;
}

function installLinearMcp(
	fixture: LinearFixture,
	tools: readonly string[] = ["list_issues", "list_comments"],
	startDisconnected = false,
): { connectCalls: number; connectedConfigs: Array<Record<string, unknown>> } {
	let connected = !startDisconnected;
	const installed = { connectCalls: 0, connectedConfigs: [] as Array<Record<string, unknown>> };
	const connection = {
		capabilities: { tools: {} },
		tools: tools.map(name => ({ name, description: name, inputSchema: { type: "object" } }) as MCPToolDefinition),
		transport: {
			request: async (_method: string, params?: Record<string, unknown>) => {
				const name = String(params?.name ?? "");
				const args = (params?.arguments ?? {}) as Record<string, unknown>;
				fixture.calls.push({ name, args });
				if (name === "list_issues") return { content: [{ type: "text", text: JSON.stringify(fixture.issues) }] };
				if (name === "list_comments") return { content: [{ type: "text", text: JSON.stringify(fixture.comments) }] };
				throw new Error(`Unexpected MCP tool ${name}`);
			},
		},
	} as unknown as MCPServerConnection;
	MCPManager.setInstance({
		getConnection: (name: string) => (connected && name === "linear" ? connection : undefined),
		connectServers: async (configs: Record<string, unknown>) => {
			installed.connectCalls++;
			installed.connectedConfigs.push(configs);
			connected = true;
			return { errors: new Map<string, string>() };
		},
		waitForConnection: async () => connection,
	} as unknown as MCPManager);
	return installed;
}

const sessions: TestSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		await stopLinearIntegration(session.sessionId);
		await stopKanbanBoard(session);
	}
	MCPManager.resetForTests();
});

async function startSession(id: string): Promise<TestSession> {
	const session = new TestSession(id);
	setKanbanBoardForker(session, async request => await session.forkBoardAgent(request));
	sessions.push(session);
	await startKanbanBoard(session);
	return session;
}

describe("Linear Kanban sync", () => {
	it("imports a matched issue with its initial comments and forwards later comments to its live worker", async () => {
		const issueId = crypto.randomUUID();
		const title = `Ship Linear sync ${issueId}`;
		const fixture: LinearFixture = {
			issues: [
				{
					id: issueId,
					identifier: "ENG-1",
					title,
					description: "Implement the adapter",
					url: "https://linear.app/acme/issue/ENG-1",
					priority: 2,
					updatedAt: "2026-08-21T12:00:00.000Z",
				},
			],
			comments: [{ id: "comment-1", body: "Start with the durable path.", user: { name: "Ada" } }],
			calls: [],
		};
		installLinearMcp(fixture);
		const session = await startSession(`linear-sync-comments-${crypto.randomUUID()}`);

		const started = await startLinearIntegration(session, ["In Progress"]);
		expect(started).toEqual({ statuses: ["In Progress"], imported: 1 });
		const initialForks = session.forks.filter(work => work.includes(title));
		expect(initialForks).toHaveLength(1);
		expect(initialForks[0]).toContain("Start with the durable path.");
		expect(initialForks[0]).toContain('"status": "ready"');
		expect(fixture.calls[0]?.args).toEqual({ assignee: "me", state: "In Progress", limit: 250 });

		fixture.comments = [
			{ id: "comment-1", body: "Start with the durable path.", user: { name: "Ada" } },
			{ id: "comment-2", body: "Also preserve the event cursor.", user: { name: "Ada" } },
		];
		await syncLinearIntegration(session.sessionId);
		expect(session.forwarded).toHaveLength(1);
		expect(session.forwarded[0]).toContain("Also preserve the event cursor.");
	});

	it("does not mutate or redeliver unchanged remote issues", async () => {
		const issueId = crypto.randomUUID();
		const title = `No-op ${issueId}`;
		const fixture: LinearFixture = {
			issues: [{ id: issueId, identifier: "ENG-2", title, updatedAt: "2026-08-21T12:00:00.000Z" }],
			comments: [],
			calls: [],
		};
		installLinearMcp(fixture);
		const session = await startSession(`linear-sync-noop-${crypto.randomUUID()}`);
		await startLinearIntegration(session, ["Todo"]);
		const api = getKanbanModelApi(session.sessionId)!;
		const task = api.store.getBoard(api.boardId).tasks.find(candidate => candidate.labels.includes(`linear:${issueId}`))!;
		const before = task.version;
		const initialForks = session.forks.filter(work => work.includes(title));
		expect(initialForks).toHaveLength(1);

		expect(await syncLinearIntegration(session.sessionId)).toEqual({ imported: 0, updated: 0, comments: 0 });
		expect(api.store.getTask(api.boardId, task.id).version).toBe(before);
		expect(session.forks.filter(work => work.includes(title))).toEqual(initialForks);
	});

	it("maps Linear numeric and urgent priorities to Kanban priorities", async () => {
		const issueIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
		const fixture: LinearFixture = {
			issues: [
				{ id: issueIds[0], identifier: "ENG-P1", title: `Urgent ${issueIds[0]}`, priority: 1, updatedAt: "2026-08-21T12:00:00.000Z" },
				{ id: issueIds[1], identifier: "ENG-P4", title: `Low ${issueIds[1]}`, priority: 4, updatedAt: "2026-08-21T12:00:00.000Z" },
				{ id: issueIds[2], identifier: "ENG-PS", title: `String ${issueIds[2]}`, priority: "urgent", updatedAt: "2026-08-21T12:00:00.000Z" },
			],
			comments: [],
			calls: [],
		};
		installLinearMcp(fixture);
		const session = await startSession(`linear-sync-priority-${crypto.randomUUID()}`);
		await startLinearIntegration(session, ["Todo"]);
		const api = getKanbanModelApi(session.sessionId)!;
		const tasks = api.store.getBoard(api.boardId).tasks;
		expect(tasks.find(task => task.labels.includes(`linear:${issueIds[0]}`))?.priority).toBe("highest");
		expect(tasks.find(task => task.labels.includes(`linear:${issueIds[1]}`))?.priority).toBe("low");
		expect(tasks.find(task => task.labels.includes(`linear:${issueIds[2]}`))?.priority).toBe("highest");
	});

	it("connects the configured Linear MCP server once when the session has no connection", async () => {
		const issueId = crypto.randomUUID();
		const fixture: LinearFixture = {
			issues: [{ id: issueId, identifier: "ENG-CONNECT", title: `Connect ${issueId}`, updatedAt: "2026-08-21T12:00:00.000Z" }],
			comments: [],
			calls: [],
		};
		const mcp = installLinearMcp(fixture, ["list_issues", "list_comments"], true);
		const session = await startSession(`linear-sync-connect-${crypto.randomUUID()}`);
		await startLinearIntegration(session, ["Todo"]);
		expect(mcp.connectCalls).toBe(1);
		expect(mcp.connectedConfigs).toEqual([{ linear: { type: "http", url: "https://mcp.linear.app/mcp" } }]);
		expect(fixture.calls.some(call => call.name === "list_issues")).toBe(true);
	});

	it("surfaces unavailable tools and malformed MCP responses", async () => {
		const fixture: LinearFixture = { issues: [], comments: [], calls: [] };
		installLinearMcp(fixture, ["list_issues"]);
		const session = await startSession(`linear-sync-errors-${crypto.randomUUID()}`);
		await expect(startLinearIntegration(session, ["Todo"])).rejects.toThrow("list_comments");
		expect(getLinearIntegrationStatus(session.sessionId)).toBeNull();

		installLinearMcp({ ...fixture, issues: [{ id: "bad" }] });
		await expect(startLinearIntegration(session, ["Todo"])).rejects.toThrow("malformed");
	});

	it("stops polling ownership after disposal", async () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		try {
			const issueId = crypto.randomUUID();
			const fixture: LinearFixture = {
				issues: [{ id: issueId, identifier: "ENG-3", title: "Stop", updatedAt: "2026-08-21T12:00:00.000Z" }],
				comments: [],
				calls: [],
			};
			installLinearMcp(fixture);
			const session = await startSession(`linear-sync-stop-${crypto.randomUUID()}`);
			await startLinearIntegration(session, ["Todo"]);
			const poll = setIntervalSpy.mock.calls.findLast(([, interval]) => interval === 30_000)?.[0] as (() => void) | undefined;
			expect(poll).toBeDefined();
			const callsBeforeStop = fixture.calls.length;
			expect(await stopLinearIntegration(session.sessionId)).toBe(true);
			poll?.();
			await Promise.resolve();
			expect(fixture.calls).toHaveLength(callsBeforeStop);
		} finally {
			setIntervalSpy.mockRestore();
			clearIntervalSpy.mockRestore();
		}
	});
});
