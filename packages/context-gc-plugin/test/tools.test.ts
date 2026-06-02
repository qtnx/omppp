import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { JSON_MEDIA_TYPE, payloadFromContent } from "../src/extract";
import { renderContextGcReport } from "../src/report";
import {
	CONTEXT_GC_CUSTOM_TYPE,
	type ContextGcDelta,
	type ContextKind,
	type ContextRecord,
	type ContextStatus,
} from "../src/schema";
import { type ContextGcStore, getContextGcDbPath, openContextGcStore } from "../src/storage";
import { runContextInventory } from "../src/tools/context-inventory";
import { createContextPinTool, runContextPin } from "../src/tools/context-pin";
import { createContextRecallTool, runContextRecall } from "../src/tools/context-recall";
import {
	createContextDebugTool,
	createContextGlobalStatsTool,
	createContextStatsTool,
	createContextTreeTool,
} from "../src/tools/context-report";
import { createContextUnloadTool, runContextUnload } from "../src/tools/context-unload";

const originalAgentDir = getAgentDir();
let tempDir: string;
let store: ContextGcStore;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-gc-tools-"));
	setAgentDir(tempDir);
	store = openContextGcStore({ dbPath: path.join(tempDir, "context-gc.sqlite") });
});

afterEach(async () => {
	store.close();
	setAgentDir(originalAgentDir);
	await fs.rm(tempDir, { recursive: true, force: true });
});

function insertRecord(input: {
	id: string;
	sessionId?: string;
	text?: string;
	status?: "candidate" | "unloaded" | "pinned";
	tokenEstimate?: number;
	kind?: ContextKind;
	sourcePath?: string;
}): string {
	const payload = store.putPayload("text/plain;charset=utf-8", input.text ?? "alpha\nbeta\ngamma\ndelta\n");
	store.upsertRecord({
		id: input.id,
		sessionId: input.sessionId ?? "session-a",
		sessionFile: path.join(tempDir, "session.jsonl"),
		status: input.status ?? "candidate",
		kind: input.kind ?? "file_read",
		source: { toolName: "read", path: input.sourcePath ?? `${input.id}.txt` },
		payloadHash: payload.hash,
		artifactId: `artifact-${input.id}`,
		sourceUri: null,
		summary: `summary ${input.id}`,
		tokenEstimate: input.tokenEstimate ?? 10,
	});
	return payload.hash;
}

function makeToolContext(entries: unknown[] = []): {
	cwd: string;
	getContextUsage(): undefined;
	sessionManager: {
		getSessionFile(): string;
		getSessionId(): string;
		getBranch(): unknown[];
		getEntries(): unknown[];
	};
} {
	return {
		cwd: tempDir,
		getContextUsage: () => undefined,
		sessionManager: {
			getSessionFile: () => path.join(tempDir, "session.jsonl"),
			getSessionId: () => "session-a",
			getBranch: () => entries,
			getEntries: () => entries,
		},
	};
}

function deltaEntry(delta: ContextGcDelta): unknown {
	return { type: "custom", id: `delta-${delta.id}-${delta.op}`, customType: CONTEXT_GC_CUSTOM_TYPE, data: delta };
}

function makeDelta(op: ContextGcDelta["op"], id: string, summary?: string): ContextGcDelta {
	return {
		op,
		id,
		sessionId: "session-a",
		status: op === "unload" ? "unloaded" : op === "pin" ? "pinned" : "candidate",
		summary,
		createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
	};
}
describe("Context GC tools", () => {
	it("inventories records with filters", async () => {
		insertRecord({ id: "r1" });
		insertRecord({ id: "r2", status: "pinned" });

		const result = await runContextInventory(store, "session-a", { includePinned: false });

		expect(result.records.map(record => record.id)).toEqual(["r1"]);
		expect(result.totalTokens).toBe(10);
	});

	it("unloads same-session records and skips missing, cross-session, and pinned records", async () => {
		insertRecord({ id: "same" });
		insertRecord({ id: "other", sessionId: "session-b" });
		insertRecord({ id: "pinned", status: "pinned" });

		const result = await runContextUnload(store, "session-a", {
			ids: ["same", "other", "pinned", "missing"],
			summary: "short replacement summary",
			reason: "not needed now",
		});

		expect(result.unloaded).toEqual(["same"]);
		expect(result.skipped).toEqual([
			{ id: "other", reason: "cross-session" },
			{ id: "pinned", reason: "pinned" },
			{ id: "missing", reason: "missing" },
		]);
		expect(store.getRecord("same")?.status).toBe("unloaded");
		// The durable DB summary stays the base; the replacement summary is branch-local (delta-only).
		expect(store.getRecord("same")?.summary).toBe("summary same");
	});

	it("keeps the DB summary as the durable base while the unload delta carries the replacement summary", async () => {
		insertRecord({ id: "u1", text: "alpha\nbeta\n" });
		const deltas: ContextGcDelta[] = [];
		const unloadTool = createContextUnloadTool(store, (_type, data) => deltas.push(data));
		const ctx = makeToolContext() as unknown as Parameters<typeof unloadTool.execute>[4];

		await unloadTool.execute(
			"call-x",
			{ ids: ["u1"], summary: "branch-local replacement summary", reason: "done with it" },
			undefined,
			undefined,
			ctx,
		);

		// Only the durable status flips; the DB summary is left untouched as the base.
		expect(store.getRecord("u1")?.status).toBe("unloaded");
		expect(store.getRecord("u1")?.summary).toBe("summary u1");
		// The replacement summary lives only in the appended branch unload delta.
		expect(deltas).toHaveLength(1);
		expect(deltas[0]).toMatchObject({ op: "unload", id: "u1", summary: "branch-local replacement summary" });
	});

	it("recalls the branch-effective summary, falling back to the durable DB summary without an override", async () => {
		insertRecord({ id: "s1", text: "alpha\nbeta\n" });

		// Branch A carries an unload delta whose replacement summary overrides the DB base.
		const branchA = await runContextRecall(
			store,
			"session-a",
			{ id: "s1", mode: "summary", maxBytes: 4096 },
			new Map([["s1", "branch A recall summary"]]),
		);
		expect(branchA.items[0]?.text).toBe("branch A recall summary");

		// Branch B lacks the override and sees the durable DB base summary.
		const branchB = await runContextRecall(store, "session-a", { id: "s1", mode: "summary", maxBytes: 4096 });
		expect(branchB.items[0]?.text).toBe("summary s1");
	});

	it("recalls a bounded range from durable SQLite payloads", async () => {
		insertRecord({ id: "range", text: "line one\nline two\nline three\nline four\n" });

		const result = await runContextRecall(store, "session-a", {
			id: "range",
			mode: "range",
			selector: "2-3",
			maxBytes: 1024,
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.text).toContain("line two");
		expect(result.items[0]?.text).toContain("line three");
		expect(store.getRecord("range")?.recallCount).toBe(1);
	});

	it("registered wrappers use current-session state and return text content", async () => {
		insertRecord({ id: "tool-range", text: "one\ntwo\nthree\nfour\n" });
		const recallTool = createContextRecallTool(store);
		const unloadTool = createContextUnloadTool(store);
		const pinTool = createContextPinTool(store);
		const ctx = makeToolContext() as unknown as Parameters<typeof recallTool.execute>[4];

		const recall = await recallTool.execute(
			"call-1",
			{ id: "tool-range", mode: "range", selector: "2-2", maxBytes: 1024 },
			undefined,
			undefined,
			ctx,
		);
		const recalledText = recall.content[0]?.type === "text" ? recall.content[0].text : "";
		expect(recalledText).toContain("two");
		expect(recalledText).not.toContain("three");

		const pin = await pinTool.execute(
			"call-2",
			{ ids: ["tool-range"], pinned: true, reason: "keep this context" },
			undefined,
			undefined,
			ctx,
		);
		expect(pin.content[0]?.type).toBe("text");
		expect(store.getRecord("tool-range")?.status).toBe("pinned");

		const unload = await unloadTool.execute(
			"call-3",
			{ ids: ["tool-range"], summary: "short replacement summary", reason: "not needed now" },
			undefined,
			undefined,
			ctx,
		);
		const unloadedText = unload.content[0]?.type === "text" ? unload.content[0].text : "";
		expect(unloadedText).toContain("pinned");
		expect(store.getRecord("tool-range")?.status).toBe("pinned");
	});

	it("renders stats, tree, and debug reports from branch-effective records", () => {
		insertRecord({ id: "candidate", tokenEstimate: 11, kind: "tool_result" });
		insertRecord({
			id: "unloaded",
			tokenEstimate: 17,
			kind: "file_read",
			sourcePath: path.join(os.homedir(), "secret.txt"),
		});
		insertRecord({ id: "pinned", tokenEstimate: 5, kind: "skill", status: "pinned" });
		insertRecord({ id: "sibling", tokenEstimate: 99, kind: "browser_output", status: "unloaded" });
		store.incrementRecall("unloaded");
		const ctx = makeToolContext([
			deltaEntry(makeDelta("candidate", "candidate")),
			deltaEntry(makeDelta("unload", "unloaded", "branch summary")),
			deltaEntry(makeDelta("pin", "pinned")),
			deltaEntry(makeDelta("unload", "missing", "missing summary")),
		]);

		const stats = renderContextGcReport({
			agentDir: tempDir,
			cwd: tempDir,
			sessionManager: ctx.sessionManager,
			action: "stats",
		});
		const tree = renderContextGcReport({
			agentDir: tempDir,
			cwd: tempDir,
			sessionManager: ctx.sessionManager,
			action: "tree",
			groupBy: "kind",
			status: "unloaded",
		});
		const debug = renderContextGcReport({
			agentDir: tempDir,
			cwd: tempDir,
			sessionManager: ctx.sessionManager,
			action: "debug",
			includeRecords: true,
			limit: 2,
		});

		expect(stats).toContain(`DB path: ${getContextGcDbPath(tempDir)}`);
		expect(stats).toContain("Current branch records: 3");
		expect(stats).toContain("Estimated active tokens saved: 17 branch-effective unloaded token(s)");
		expect(stats).toContain("- file_read: 1");
		expect(stats).not.toContain("99");
		expect(tree).toContain("file_read:");
		expect(tree).toContain("unloaded [file_read/unloaded, 17 tok");
		expect(tree).toContain("branch summary");
		expect(tree).toContain("source=~/secret.txt");
		expect(tree).not.toContain(os.homedir());
		expect(tree).not.toContain("candidate [");
		expect(debug).toContain("Branch delta count: 4");
		expect(debug).toContain("Missing delta record ids: missing");
		expect(debug).toContain("Raw database aggregate: 4 record(s), 132 token(s)");
		expect(debug).toContain("Records (limit 2):");
	});

	it("renders global stats from durable database records", () => {
		insertRecord({ id: "candidate", tokenEstimate: 11, kind: "tool_result" });
		insertRecord({ id: "unloaded", tokenEstimate: 17, kind: "file_read", status: "unloaded" });
		insertRecord({ id: "pinned", sessionId: "session-b", tokenEstimate: 5, kind: "skill", status: "pinned" });
		store.incrementRecall("unloaded");
		const ctx = makeToolContext([deltaEntry(makeDelta("candidate", "candidate"))]);

		const global = renderContextGcReport({
			agentDir: tempDir,
			cwd: tempDir,
			sessionManager: ctx.sessionManager,
			action: "global",
		});

		expect(global).toContain("Context GC global stats");
		expect(global).toContain("Global sessions: 2");
		expect(global).toContain("Global records: 3");
		expect(global).toContain("Candidate tokens: 11 (1 record(s))");
		expect(global).toContain("Unloaded tokens: 17 (1 record(s))");
		expect(global).toContain("Pinned tokens: 5 (1 record(s))");
		expect(global).toContain("Estimated global tokens saved: 17 unloaded token(s)");
		expect(global).toContain("- file_read: 1 record(s), 17 token(s), 1 recall(s)");
	});

	it("registered global stats tool renders database-wide aggregate", async () => {
		insertRecord({ id: "tool-global", tokenEstimate: 13, status: "unloaded" });
		const ctx = makeToolContext();
		const globalTool = createContextGlobalStatsTool(store);

		const global = await globalTool.execute(
			"global-call",
			{},
			undefined,
			undefined,
			ctx as unknown as Parameters<typeof globalTool.execute>[4],
		);

		const text = global.content[0]?.type === "text" ? global.content[0].text : "";
		expect(text).toContain("Context GC global stats");
		expect(text).toContain("Global records: 1");
		expect(text).toContain("Estimated global tokens saved: 13");
	});

	it("registered report tools render text using active branch state", async () => {
		insertRecord({ id: "tool-stats", tokenEstimate: 13 });
		const ctx = makeToolContext([deltaEntry(makeDelta("unload", "tool-stats", "tool branch summary"))]);
		const statsTool = createContextStatsTool(store);
		const treeTool = createContextTreeTool(store);
		const debugTool = createContextDebugTool(store);

		const stats = await statsTool.execute(
			"stats-call",
			{},
			undefined,
			undefined,
			ctx as unknown as Parameters<typeof statsTool.execute>[4],
		);
		const tree = await treeTool.execute(
			"tree-call",
			{ status: "unloaded", groupBy: "status", limit: 5 },
			undefined,
			undefined,
			ctx as unknown as Parameters<typeof treeTool.execute>[4],
		);
		const debug = await debugTool.execute(
			"debug-call",
			{ includeRecords: true, limit: 5 },
			undefined,
			undefined,
			ctx as unknown as Parameters<typeof debugTool.execute>[4],
		);

		expect(stats.content[0]?.type === "text" ? stats.content[0].text : "").toContain(
			"Estimated active tokens saved: 13",
		);
		expect(tree.content[0]?.type === "text" ? tree.content[0].text : "").toContain("tool branch summary");
		expect(debug.content[0]?.type === "text" ? debug.content[0].text : "").toContain("Branch delta count: 1");
	});

	it("pins and unpins records", async () => {
		insertRecord({ id: "pin-me" });

		const pinned = await runContextPin(store, "session-a", {
			ids: ["pin-me"],
			pinned: true,
			reason: "keep this context",
		});
		expect(pinned.pinned).toEqual(["pin-me"]);
		expect(store.getRecord("pin-me")?.status).toBe("pinned");

		const unpinned = await runContextPin(store, "session-a", {
			ids: ["pin-me"],
			pinned: false,
			reason: "allow unload",
		});
		expect(unpinned.unpinned).toEqual(["pin-me"]);
		expect(store.getRecord("pin-me")?.status).toBe("candidate");
	});

	it("persists image-bearing payloads as structured data and exposes them via raw recall", async () => {
		const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const content = [
			{ type: "text" as const, text: `Screenshot analysis:\n${"detail line\n".repeat(50)}` },
			{ type: "image" as const, data: base64, mimeType: "image/png" },
		];
		const persisted = payloadFromContent(content);

		// The projection flattens images to markers; the stored form keeps the structured JSON.
		expect(persisted.mediaType).toBe(JSON_MEDIA_TYPE);
		expect(persisted.text).toContain("[image:image/png]");
		expect(persisted.text).not.toContain(base64);

		const payload = store.putPayload(persisted.mediaType, persisted.stored, persisted.text);
		expect(payload.mediaType).toBe(JSON_MEDIA_TYPE);
		expect(payload.text).toContain(base64);
		expect(payload.textProjection).toContain("[image:image/png]");
		expect(payload.textProjection).not.toContain(base64);

		store.upsertRecord({
			id: "img",
			sessionId: "session-a",
			sessionFile: null,
			status: "candidate",
			kind: "tool_result",
			source: { toolName: "read" },
			payloadHash: payload.hash,
			summary: "screenshot analysis",
		});

		const raw = await runContextRecall(store, "session-a", { id: "img", mode: "raw", maxBytes: 200_000 });
		expect(raw.items).toHaveLength(1);
		expect(raw.items[0]?.text).toContain('"type":"image"');
		expect(raw.items[0]?.text).toContain(base64);
		expect(raw.items[0]?.text).not.toBe("[image:image/png]");

		// Range recall still works off the plain-text projection.
		const ranged = await runContextRecall(store, "session-a", {
			id: "img",
			mode: "range",
			selector: "1",
			maxBytes: 4096,
		});
		expect(ranged.items[0]?.text).toContain("Screenshot analysis");
		expect(ranged.items[0]?.text).not.toContain(base64);
	});

	it("filters branch-scoped inventory by branch-effective status, ignoring the DB", async () => {
		const make = (id: string, status: ContextStatus, updatedAt: string): ContextRecord =>
			({ id, status, tokenEstimate: 4, updatedAt, kind: "tool_result", source: {} }) as unknown as ContextRecord;
		const branchScoped = [
			make("c1", "candidate", "2026-01-01T00:00:02.000Z"),
			make("p1", "pinned", "2026-01-01T00:00:03.000Z"),
			make("u1", "unloaded", "2026-01-01T00:00:01.000Z"),
		];

		const visible = await runContextInventory(store, "session-a", { includePinned: false }, branchScoped);
		expect(visible.records.map(record => record.id)).toEqual(["c1", "u1"]);

		const unloadedOnly = await runContextInventory(store, "session-a", { status: "unloaded" }, branchScoped);
		expect(unloadedOnly.records.map(record => record.id)).toEqual(["u1"]);
	});
});
