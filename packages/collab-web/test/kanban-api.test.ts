import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KanbanApi } from "../src/kanban/api";

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const idempotencyKeyPattern = /^[\x21-\x7e]{1,256}$/;

function restoreCrypto() {
	if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
	else Reflect.deleteProperty(globalThis, "crypto");
}

function setCrypto(crypto: Crypto | undefined) {
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: crypto,
	});
}

function taskResponse() {
	return Response.json({
		data: {
			id: "task-1",
			boardId: "session-1",
			status: "backlog",
			position: 0,
			shortId: 1,
			title: "Ship native board",
			description: null,
			assignee: null,
			labels: [],
			dueAt: null,
			priority: "medium",
			commentCount: 0,
			version: 1,
			createdAt: "2026-08-01T12:00:00.000Z",
			updatedAt: "2026-08-01T12:00:00.000Z",
		},
	});
}

function createApi(keys: string[]) {
	return new KanbanApi("session-1", async (_input, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		keys.push(headers["Idempotency-Key"] ?? "");
		return taskResponse();
	});
}

const draft = { title: "Ship native board", status: "backlog" as const, priority: "medium" as const };

beforeEach(restoreCrypto);
afterEach(restoreCrypto);

describe("Kanban API idempotency keys", () => {
	test("sends an ASCII idempotency key when randomUUID is available", async () => {
		setCrypto({ randomUUID: () => "secure-context-key" } as unknown as Crypto);
		const keys: string[] = [];

		await createApi(keys).createTask(draft);

		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(idempotencyKeyPattern);
	});

	test("uses getRandomValues for distinct mutation keys when randomUUID is unavailable", async () => {
		const crypto = globalThis.crypto;
		if (!crypto?.getRandomValues) throw new Error("Test runtime lacks crypto.getRandomValues");
		setCrypto({ getRandomValues: crypto.getRandomValues.bind(crypto) } as unknown as Crypto);
		const keys: string[] = [];
		const api = createApi(keys);

		await api.createTask(draft);
		await api.createTask(draft);

		expect(keys).toHaveLength(2);
		expect(keys[0]).toMatch(idempotencyKeyPattern);
		expect(keys[1]).toMatch(idempotencyKeyPattern);
		expect(keys[0]).not.toBe(keys[1]);
	});

	test("rejects mutations without crypto before sending a request", async () => {
		setCrypto(undefined);
		const keys: string[] = [];

		await expect(createApi(keys).createTask(draft)).rejects.toMatchObject({ code: "crypto_unavailable" });
		expect(keys).toEqual([]);
	});
});
