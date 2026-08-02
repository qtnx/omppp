import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createKanbanServer,
	isTailnetAddress,
	type KanbanClientAssets,
	type KanbanServerHandle,
} from "@oh-my-pi/pi-coding-agent/kanban/server";
import { KanbanStore } from "@oh-my-pi/pi-coding-agent/kanban/store";
import type { KanbanActivity } from "@oh-my-pi/pi-coding-agent/kanban/types";

const CLIENT_ASSETS: KanbanClientAssets = {
	"/": {
		body: '<!doctype html><link rel="manifest" href="/manifest.webmanifest" /><script src="/app.js"></script>',
		contentType: "text/html; charset=utf-8",
		cacheControl: "no-cache",
	},
	"/app.js": { body: "globalThis.kanbanLoaded = true;", contentType: "text/javascript; charset=utf-8" },
	"/manifest.webmanifest": {
		body: JSON.stringify({ name: "OMPx Session Kanban", start_url: "/kanban/", scope: "/kanban/" }),
		contentType: "application/manifest+json; charset=utf-8",
	},
};

interface ServerHarness {
	root: string;
	dbPath: string;
	store: KanbanStore;
	handle: KanbanServerHandle;
	closed: boolean;
}

const harnesses: ServerHarness[] = [];

async function createHarness(dbPath?: string): Promise<ServerHarness> {
	const root = dbPath ? path.dirname(dbPath) : await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-server-"));
	if (!dbPath) await fs.mkdir(root, { recursive: true });
	const resolvedDbPath = dbPath ?? path.join(root, "kanban.db");
	const store = KanbanStore.open(resolvedDbPath);
	const handle = createKanbanServer({
		store,
		assets: CLIENT_ASSETS,
		boardId: "session-a",
		port: 0,
	});
	const harness = { root, dbPath: resolvedDbPath, store, handle, closed: false };
	harnesses.push(harness);
	return harness;
}

async function closeHarness(harness: ServerHarness, removeRoot = true): Promise<void> {
	if (!harness.closed) {
		harness.closed = true;
		await harness.handle.stop();
		harness.store.close();
	}
	if (removeRoot) await fs.rm(harness.root, { recursive: true, force: true });
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await closeHarness(harness);
});

function url(harness: ServerHarness, route: string): string {
	return `${harness.handle.localUrl.slice(0, -1)}${route}`;
}

function origin(harness: ServerHarness): string {
	return harness.handle.localUrl.slice(0, -1);
}

async function boardCookie(harness: ServerHarness, boardId = "session-a"): Promise<string> {
	const response = await fetch(url(harness, `/kanban/${encodeURIComponent(boardId)}`), { redirect: "manual" });
	expect(response.status).toBe(200);
	const setCookie = response.headers.get("set-cookie");
	expect(setCookie).not.toBeNull();
	return setCookie!.split(";", 1)[0]!;
}

function mutationHeaders(
	harness: ServerHarness,
	cookie: string,
	options: { key?: string; origin?: string; kanbanHeader?: string } = {},
): Headers {
	const headers = new Headers({
		Cookie: cookie,
		Origin: options.origin ?? origin(harness),
		"Content-Type": "application/json",
		"X-OMPx-Kanban": options.kanbanHeader ?? "1",
	});
	if (options.key) headers.set("Idempotency-Key", options.key);
	return headers;
}

async function createTask(
	harness: ServerHarness,
	cookie: string,
	key: string,
	title = "Server task",
): Promise<Response> {
	return await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
		method: "POST",
		headers: mutationHeaders(harness, cookie, { key }),
		body: JSON.stringify({ title, status: "backlog", priority: "high" }),
	});
}

async function parseTaskResponse(response: Response): Promise<{ id: string; version: number }> {
	const payload: unknown = await response.json();
	if (
		!payload ||
		typeof payload !== "object" ||
		!("data" in payload) ||
		!payload.data ||
		typeof payload.data !== "object" ||
		!("id" in payload.data) ||
		typeof payload.data.id !== "string" ||
		!("version" in payload.data) ||
		typeof payload.data.version !== "number"
	) {
		throw new Error("Task response was malformed");
	}
	return { id: payload.data.id, version: payload.data.version };
}

async function readSseFrame(
	// Structural: bun-types and node:stream/web disagree on the reader type
	// (`readMany`), and fetch() can bind to either depending on lib order.
	reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
): Promise<{ event: KanbanActivity; remainder: string }> {
	const decoder = new TextDecoder();
	let received = "";
	while (true) {
		while (!received.includes("\n\n")) {
			const result = await reader.read();
			if (result.done) throw new Error(`SSE closed before a frame arrived: ${received}`);
			received += decoder.decode(result.value, { stream: true });
		}
		const boundary = received.indexOf("\n\n");
		const frame = received.slice(0, boundary);
		received = received.slice(boundary + 2);
		const data = frame
			.split("\n")
			.filter(line => line.startsWith("data: "))
			.map(line => line.slice(6))
			.join("\n");
		if (data.length === 0) continue;
		const parsed: unknown = JSON.parse(data);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!("id" in parsed) ||
			typeof parsed.id !== "string" ||
			!("cursor" in parsed) ||
			typeof parsed.cursor !== "number" ||
			!("boardId" in parsed) ||
			typeof parsed.boardId !== "string" ||
			!("type" in parsed) ||
			typeof parsed.type !== "string" ||
			!("createdAt" in parsed) ||
			typeof parsed.createdAt !== "string" ||
			!("data" in parsed) ||
			!parsed.data ||
			typeof parsed.data !== "object"
		) {
			throw new Error("SSE data frame was malformed");
		}
		const event = parsed as KanbanActivity;
		return { event, remainder: received };
	}
}

describe("Kanban server", () => {
	it("serves the offline root shell and board-specific install manifest", async () => {
		const harness = await createHarness();
		const root = await fetch(url(harness, "/"));
		expect(root.status).toBe(200);
		expect(await root.text()).toContain("/manifest.webmanifest");

		const fallback = await fetch(url(harness, "/kanban/"), { redirect: "manual" });
		expect(fallback.status).toBe(307);
		expect(fallback.headers.get("location")).toBe("/kanban/session-a");

		const board = await fetch(url(harness, "/kanban/session-a"));
		expect(board.status).toBe(200);
		expect(await board.text()).toContain("/kanban/session-a/manifest.webmanifest");
		const setCookie = board.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).not.toContain("session-a");

		const manifest = await fetch(url(harness, "/kanban/session-a/manifest.webmanifest"));
		expect(manifest.status).toBe(200);
		expect(await manifest.json()).toMatchObject({ start_url: "/kanban/session-a", scope: "/kanban/" });
		expect(manifest.headers.get("cache-control")).toBe("no-store");

		const foreignBoard = await fetch(url(harness, "/kanban/some-other-project"));
		expect(foreignBoard.status).toBe(404);
		expect(foreignBoard.headers.get("set-cookie")).toBeNull();
	});

	it("enforces Host, capability cookie, same Origin, mutation header, and board boundaries", async () => {
		const harness = await createHarness();
		const cookie = await boardCookie(harness);
		const foreignBoardApi = await fetch(url(harness, "/api/v1/boards/some-other-project/board"));
		expect(foreignBoardApi.status).toBe(404);
		expect(await foreignBoardApi.json()).toEqual({ error: { code: "not_found", message: "Board not found" } });

		const wrongHost = await fetch(url(harness, "/kanban/session-a"), {
			headers: { Host: "attacker.invalid" },
		});
		expect(wrongHost.status).toBe(403);
		expect(wrongHost.headers.get("access-control-allow-origin")).toBeNull();

		const noCookie = await fetch(url(harness, "/api/v1/boards/session-a/board"));
		expect(noCookie.status).toBe(401);

		const missingHeader = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers: mutationHeaders(harness, cookie, { key: "missing-header", kanbanHeader: "0" }),
			body: JSON.stringify({ title: "Rejected", status: "backlog", priority: "medium" }),
		});
		expect(missingHeader.status).toBe(403);

		const wrongOrigin = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers: mutationHeaders(harness, cookie, { key: "wrong-origin", origin: "http://attacker.invalid" }),
			body: JSON.stringify({ title: "Rejected", status: "backlog", priority: "medium" }),
		});
		expect(wrongOrigin.status).toBe(403);

		const createdResponse = await createTask(harness, cookie, "accepted");
		expect(createdResponse.status).toBe(201);
		const created = await parseTaskResponse(createdResponse);

		const check = new Database(harness.dbPath, { readonly: true });
		try {
			expect(check.prepare("SELECT title FROM kanban_tasks WHERE id = ?").get(created.id)).toEqual({
				title: "Server task",
			});
			expect(check.prepare("SELECT COUNT(*) AS count FROM kanban_tasks").get()).toEqual({ count: 1 });
			expect(check.prepare("SELECT COUNT(*) AS count FROM kanban_activity").get()).toEqual({ count: 1 });
			expect(check.prepare("SELECT COUNT(*) AS count FROM kanban_idempotency").get()).toEqual({ count: 1 });
		} finally {
			check.close();
		}
	});

	it("lists registered board sessions only with a capability cookie", async () => {
		const harness = await createHarness();
		harness.store.upsertSession("session-a", "session-a", "swift-otter");
		harness.store.upsertSession("session-a", "session-b", "quiet-raven");

		const unauthorized = await fetch(url(harness, "/api/v1/boards/session-a/sessions"));
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toEqual({
			error: { code: "unauthorized", message: "Kanban capability is missing or invalid" },
		});

		const authorized = await fetch(url(harness, "/api/v1/boards/session-a/sessions"), {
			headers: { Cookie: await boardCookie(harness) },
		});
		expect(authorized.status).toBe(200);
		const sessions = (await authorized.json()) as { data: unknown[] };
		expect(sessions).toEqual({
			data: expect.arrayContaining([
				{
					sessionId: "session-a",
					name: "swift-otter",
					createdAt: expect.any(String),
					lastSeenAt: expect.any(String),
				},
				{
					sessionId: "session-b",
					name: "quiet-raven",
					createdAt: expect.any(String),
					lastSeenAt: expect.any(String),
				},
			]),
		});
		expect(sessions.data).toHaveLength(2);
	});

	it("replays exact idempotent status/body and rejects malformed or oversized writes unchanged", async () => {
		const harness = await createHarness();
		const cookie = await boardCookie(harness);
		const first = await createTask(harness, cookie, "same-key", "Canonical HTTP");
		const firstText = await first.text();
		expect(first.status).toBe(201);
		const replay = await createTask(harness, cookie, "same-key", "Canonical HTTP");
		expect(replay.status).toBe(201);
		expect(await replay.text()).toBe(firstText);

		const reused = await createTask(harness, cookie, "same-key", "Different HTTP");
		expect(reused.status).toBe(422);
		expect(await reused.json()).toEqual({
			error: { code: "idempotency_key_reused", message: "Idempotency key was already used for a different request" },
		});

		const malformed = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers: mutationHeaders(harness, cookie, { key: "malformed" }),
			body: "{",
		});
		expect(malformed.status).toBe(400);

		const identityField = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers: mutationHeaders(harness, cookie, { key: "identity" }),
			body: JSON.stringify({ id: "chosen", title: "Rejected", status: "backlog", priority: "medium" }),
		});
		expect(identityField.status).toBe(422);

		const invalidDate = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers: mutationHeaders(harness, cookie, { key: "invalid-date" }),
			body: JSON.stringify({
				title: "Rejected date",
				status: "backlog",
				priority: "medium",
				dueAt: "2026-02-30T10:00:00Z",
			}),
		});
		expect(invalidDate.status).toBe(422);

		const oversized = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers: mutationHeaders(harness, cookie, { key: "oversized" }),
			body: JSON.stringify({
				title: "Too large",
				status: "backlog",
				priority: "medium",
				description: "x".repeat(70_000),
			}),
		});
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toEqual({
			error: { code: "payload_too_large", message: "JSON body exceeds 64 KiB" },
		});

		const oversizedBytes = new TextEncoder().encode(
			JSON.stringify({
				title: "Too large streamed",
				status: "backlog",
				priority: "medium",
				description: "x".repeat(70_000),
			}),
		);
		const oversizedStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(oversizedBytes.subarray(0, 32_768));
				controller.enqueue(oversizedBytes.subarray(32_768));
				controller.close();
			},
		});
		const streamedOversized = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers: mutationHeaders(harness, cookie, { key: "oversized-stream" }),
			body: oversizedStream,
		});
		expect(streamedOversized.status).toBe(413);
		expect(await streamedOversized.json()).toEqual({
			error: { code: "payload_too_large", message: "JSON body exceeds 64 KiB" },
		});

		const db = new Database(harness.dbPath, { readonly: true });
		try {
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_tasks").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_activity").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_outbox").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_idempotency").get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it("streams replay and live cursors, cleans up readers, and replays after restart", async () => {
		const harness = await createHarness();
		let cookie = await boardCookie(harness);
		const createdResponse = await createTask(harness, cookie, "sse-task", "SSE task");
		const task = await parseTaskResponse(createdResponse);

		const replayResponse = await fetch(url(harness, "/api/v1/boards/session-a/events?cursor=0"), {
			headers: { Cookie: cookie },
			signal: AbortSignal.timeout(3_000),
		});
		expect(replayResponse.status).toBe(200);
		expect(replayResponse.headers.get("cache-control")).toBe("no-store");
		const replayReader = replayResponse.body!.getReader();
		const replay = await readSseFrame(replayReader);
		expect(replay.event).toMatchObject({ boardId: "session-a", taskId: task.id, type: "task.created" });
		await replayReader.cancel();

		const liveResponse = await fetch(url(harness, `/api/v1/boards/session-a/events?cursor=${replay.event.cursor}`), {
			headers: { Cookie: cookie },
			signal: AbortSignal.timeout(3_000),
		});
		const liveReader = liveResponse.body!.getReader();
		const commentResponse = await fetch(
			url(harness, `/api/v1/boards/session-a/tasks/${encodeURIComponent(task.id)}/comments`),
			{
				method: "POST",
				headers: mutationHeaders(harness, cookie, { key: "sse-comment" }),
				body: JSON.stringify({ author: "owner", body: "Live event" }),
			},
		);
		expect(commentResponse.status).toBe(201);
		const live = await readSseFrame(liveReader);
		expect(live.event).toMatchObject({ boardId: "session-a", taskId: task.id, type: "comment.created" });
		expect(live.event.cursor).toBeGreaterThan(replay.event.cursor);
		await liveReader.cancel();

		await closeHarness(harness, false);
		const restarted = await createHarness(harness.dbPath);
		cookie = await boardCookie(restarted);
		const restartedResponse = await fetch(url(restarted, "/api/v1/boards/session-a/events?cursor=0"), {
			headers: { Cookie: cookie },
			signal: AbortSignal.timeout(3_000),
		});
		const restartedReader = restartedResponse.body!.getReader();
		const restartedEvent = await readSseFrame(restartedReader);
		expect(restartedEvent.event.id).toBe(replay.event.id);
		await restartedReader.cancel();

		const db = new Database(restarted.dbPath, { readonly: true });
		try {
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_activity").get()).toEqual({ count: 2 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_outbox").get()).toEqual({ count: 2 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_idempotency").get()).toEqual({ count: 2 });
		} finally {
			db.close();
		}
	});
	it("recognizes only Tailscale CGNAT and ULA peer address ranges", () => {
		for (const address of [
			"100.64.0.1",
			"100.75.161.60",
			"100.127.255.254",
			"fd7a:115c:a1e0::4b01:a188",
			"::ffff:100.100.1.1",
		]) {
			expect(isTailnetAddress(address)).toBe(true);
		}
		for (const address of [
			undefined,
			"100.63.255.255",
			"100.128.0.1",
			"99.64.0.1",
			"192.168.1.5",
			"127.0.0.1",
			"fd00::1",
		]) {
			expect(isTailnetAddress(address)).toBe(false);
		}
	});

	it("pairs loopback peers with an allowed Host on the live server port", async () => {
		const harness = await createHarness();
		const localhost = `localhost:${harness.handle.port}`;
		const board = await fetch(url(harness, "/kanban/session-a"), { headers: { Host: localhost } });
		expect(board.status).toBe(200);

		const foreignHost = await fetch(url(harness, "/kanban/session-a"), {
			headers: { Host: `evil.example:${harness.handle.port}` },
		});
		expect(foreignHost.status).toBe(403);
		expect(await foreignHost.json()).toEqual({ error: { code: "forbidden", message: "Forbidden" } });

		const wrongPort = await fetch(url(harness, "/kanban/session-a"), {
			headers: { Host: `127.0.0.1:${harness.handle.port + 1}` },
		});
		expect(wrongPort.status).toBe(403);
		expect(await wrongPort.json()).toEqual({ error: { code: "forbidden", message: "Forbidden" } });
	});

	it("derives mutation Origin from the same allowed Host without writing foreign-origin tasks", async () => {
		const harness = await createHarness();
		const cookie = await boardCookie(harness);
		const host = `localhost:${harness.handle.port}`;
		const readTaskCount = async (): Promise<number> => {
			const response = await fetch(url(harness, "/api/v1/boards/session-a/board"), {
				headers: { Cookie: cookie, Host: host },
			});
			expect(response.status).toBe(200);
			const payload: unknown = await response.json();
			if (
				!payload ||
				typeof payload !== "object" ||
				!("data" in payload) ||
				!payload.data ||
				typeof payload.data !== "object" ||
				!("tasks" in payload.data) ||
				!Array.isArray(payload.data.tasks)
			) {
				throw new Error("Board response was malformed");
			}
			return payload.data.tasks.length;
		};
		const headers = mutationHeaders(harness, cookie, { key: "localhost-origin", origin: `http://${host}` });
		headers.set("Host", host);
		const created = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "Localhost origin", status: "backlog", priority: "high" }),
		});
		expect(created.status).toBe(201);

		expect(await readTaskCount()).toBe(1);

		const foreignOriginHeaders = mutationHeaders(harness, cookie, {
			key: "foreign-origin",
			origin: `http://127.0.0.1:${harness.handle.port}`,
		});
		foreignOriginHeaders.set("Host", host);
		const foreignOrigin = await fetch(url(harness, "/api/v1/boards/session-a/tasks"), {
			method: "POST",
			headers: foreignOriginHeaders,
			body: JSON.stringify({ title: "Rejected foreign origin", status: "backlog", priority: "high" }),
		});
		expect(foreignOrigin.status).toBe(403);
		expect(await foreignOrigin.json()).toEqual({
			error: { code: "forbidden", message: "Mutation Origin is not allowed" },
		});

		expect(await readTaskCount()).toBe(1);
	});
});
