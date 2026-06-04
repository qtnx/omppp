import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import contextGcExtension from "../src/extension";
import { openContextGcStore } from "../src/storage";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalAgentDir = getAgentDir();
let tempDir: string;
let session: FakeSession;
let capturedArtifacts: Array<{ content: string; toolType: string }>;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-gc-extension-"));
	setAgentDir(tempDir);
	session = { entries: [], leafId: null, counter: 0 };
	capturedArtifacts = [];
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	if (originalCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalCodingAgentDir;
	await fs.rm(tempDir, { recursive: true, force: true });
});

interface RegisteredToolLike {
	name: string;
}

/** A minimal, realistic session: appended custom entries form the active branch path. */
interface FakeEntry {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
	message?: unknown;
	content?: unknown;
	display?: unknown;
	timestamp?: unknown;
}

interface FakeSession {
	entries: FakeEntry[];
	leafId: string | null;
	counter: number;
}

interface FakePi {
	labels: string[];
	tools: RegisteredToolLike[];
	handlers: Map<string, unknown[]>;
	deltas: unknown[];
	setLabel(label: string): void;
	registerTool(tool: RegisteredToolLike): void;
	on(event: string, handler: unknown): void;
	appendEntry(customType: string, data: unknown): void;
	sendMessage(message: unknown, options?: unknown): void;
}

interface FakeContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

interface FakeContext {
	cwd: string;
	getContextUsage(): FakeContextUsage | undefined;
	sessionManager: {
		getSessionFile(): string;
		getSessionId(): string;
		getBranch(): FakeEntry[];
		getEntries(): FakeEntry[];
		saveArtifact(content: string, toolType: string): Promise<string>;
	};
}

interface ContextEventLike {
	type: "context";
	messages: unknown[];
}

interface ToolResultEventLike {
	type: "tool_result";
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
	isError: boolean;
}

type ContextHandler = (event: ContextEventLike, ctx: FakeContext) => Promise<{ messages: unknown[] } | undefined>;
type ToolResultHandler = (event: ToolResultEventLike, ctx: FakeContext) => Promise<void>;
type BeforeAgentStartHandler = (
	event: { type: "before_agent_start"; prompt: string; systemPrompt: string[] },
	ctx: FakeContext,
) => { message?: unknown; systemPrompt?: string[] } | undefined;

function appendCustomEntry(customType: string, data: unknown): void {
	const id = `e${session.counter++}`;
	session.entries.push({ type: "custom", id, parentId: session.leafId, customType, data });
	session.leafId = id;
}

function createFakePi(): FakePi {
	return {
		labels: [],
		tools: [],
		handlers: new Map(),
		deltas: [],
		setLabel(label: string): void {
			this.labels.push(label);
		},
		registerTool(tool: RegisteredToolLike): void {
			this.tools.push(tool);
		},
		on(event: string, handler: unknown): void {
			const handlers = this.handlers.get(event) ?? [];
			handlers.push(handler);
			this.handlers.set(event, handlers);
		},
		appendEntry(customType: string, data: unknown): void {
			this.deltas.push({ customType, data });
			appendCustomEntry(customType, data);
		},
		sendMessage(_message: unknown, _options?: unknown): void {},
	};
}

function createFakeContext(contextUsage?: FakeContextUsage): FakeContext {
	return {
		cwd: tempDir,
		getContextUsage: () => contextUsage,
		sessionManager: {
			getSessionFile: () => path.join(tempDir, "session.jsonl"),
			getSessionId: () => "session-a",
			getBranch: () => session.entries,
			getEntries: () => session.entries,
			saveArtifact: async (content: string, toolType: string) => {
				capturedArtifacts.push({ content, toolType });
				return `artifact-${toolType}`;
			},
		},
	};
}

function reminderContent(result: { message?: unknown } | undefined): string | undefined {
	const message = result?.message;
	if (!message || typeof message !== "object" || !("content" in message)) return undefined;
	const content = (message as { content?: unknown }).content;
	return typeof content === "string" ? content : undefined;
}

function getHandler<T>(fakePi: FakePi, event: string): T | undefined {
	return fakePi.handlers.get(event)?.[0] as T | undefined;
}

function shutdown(fakePi: FakePi): void {
	const handler = fakePi.handlers.get("session_shutdown")?.[0];
	if (typeof handler === "function") handler();
}

describe("contextGcExtension", () => {
	it("registers all Context GC tools and lifecycle handlers", () => {
		const fakePi = createFakePi();

		contextGcExtension(fakePi as unknown as ExtensionAPI);

		expect(fakePi.labels).toEqual(["Context GC"]);
		expect(fakePi.tools.map(tool => tool.name).sort()).toEqual([
			"context_debug",
			"context_global_stats",
			"context_inventory",
			"context_pin",
			"context_recall",
			"context_stats",
			"context_tree",
			"context_unload",
		]);
		expect(fakePi.handlers.has("tool_result")).toBe(true);
		expect(fakePi.handlers.has("context")).toBe(true);
		expect(fakePi.handlers.has("before_agent_start")).toBe(true);
		expect(fakePi.handlers.has("session_shutdown")).toBe(true);

		shutdown(fakePi);
	});

	it("collects large tool results with artifact ids and compact deltas", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const toolResultHandler = getHandler<ToolResultHandler>(fakePi, "tool_result");
		expect(toolResultHandler).toBeDefined();
		if (!toolResultHandler) return;
		const largeText = "large tool payload\n".repeat(3_000);

		await toolResultHandler(
			{
				type: "tool_result",
				toolName: "read",
				toolCallId: "call-1",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: largeText }],
				isError: false,
			},
			createFakeContext(),
		);

		expect(fakePi.deltas).toHaveLength(1);
		expect(fakePi.deltas[0]).toMatchObject({
			customType: "context-gc",
			data: { op: "candidate", id: expect.stringContaining("call-1") },
		});
		shutdown(fakePi);
	});

	it("deduplicates repeated large custom-message inventory across context events", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const largeText = `large custom payload ${tempDir}\n`.repeat(3_000);
		const event: ContextEventLike = {
			type: "context",
			messages: [{ role: "custom", customType: "large-custom", content: largeText, display: false }],
		};

		await contextHandler(event, createFakeContext());
		await contextHandler(event, createFakeContext());

		expect(fakePi.deltas).toHaveLength(1);
		shutdown(fakePi);
	});

	it("appends a candidate delta when an existing DB record appears on a new branch", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const largeText = `branch-local custom payload ${tempDir}\n`.repeat(3_000);
		const event: ContextEventLike = {
			type: "context",
			messages: [{ role: "custom", customType: "large-custom", content: largeText, display: false }],
		};

		await contextHandler(event, createFakeContext());
		const firstDelta = fakePi.deltas[0] as { data: { id: string } };
		const inspect = openContextGcStore({ dbPath: path.join(getAgentDir(), "context-gc.sqlite") });
		try {
			inspect.setStatus(firstDelta.data.id, "unloaded", "sibling branch summary");
		} finally {
			inspect.close();
		}
		session.entries = [];
		session.leafId = null;
		await contextHandler(event, createFakeContext());

		expect(fakePi.deltas).toHaveLength(2);
		expect(fakePi.deltas[1]).toMatchObject({
			customType: "context-gc",
			data: { op: "candidate", id: firstDelta.data.id, status: "candidate" },
		});
		shutdown(fakePi);
	});

	it("collects large file mention messages and emits candidate deltas", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const largeText = "large mentioned file payload\n".repeat(3_000);
		await contextHandler(
			{
				type: "context",
				messages: [
					{
						role: "fileMention",
						files: [{ path: "src/large.ts", content: largeText, lineCount: 3_000, byteSize: largeText.length }],
						timestamp: 1,
					},
				],
			},
			createFakeContext(),
		);

		expect(fakePi.deltas).toHaveLength(1);
		expect(fakePi.deltas[0]).toMatchObject({
			customType: "context-gc",
			data: { op: "candidate", id: expect.stringContaining("file-mention") },
		});
		shutdown(fakePi);
	});

	it("inventories large bash executions and ignores excluded ones", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const output = "bash output line\n".repeat(3_000);
		await contextHandler(
			{
				type: "context",
				messages: [
					{ role: "bashExecution", command: "make build", output, exitCode: 0, timestamp: 1 },
					{
						role: "bashExecution",
						command: "secret",
						output,
						exitCode: 0,
						excludeFromContext: true,
						timestamp: 2,
					},
				],
			},
			createFakeContext(),
		);

		expect(fakePi.deltas).toHaveLength(1);
		expect(fakePi.deltas[0]).toMatchObject({
			customType: "context-gc",
			data: { op: "candidate", id: expect.stringContaining("bash:") },
		});
		shutdown(fakePi);
	});

	it("inventories large python executions and projects them when unloaded", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const output = "python output\n".repeat(3_000);
		const pythonMessage = { role: "pythonExecution", code: "print('hi')", output, exitCode: 0, timestamp: 1 };

		await contextHandler({ type: "context", messages: [pythonMessage] }, createFakeContext());

		expect(fakePi.deltas).toHaveLength(1);
		const delta = fakePi.deltas[0] as { data: { id: string } };
		expect(delta.data.id).toContain("python:");

		// Unloading via a branch delta must project the message into a recall placeholder.
		appendCustomEntry("context-gc", { ...delta.data, op: "unload", status: "unloaded" });
		const projected = await contextHandler({ type: "context", messages: [pythonMessage] }, createFakeContext());
		const first = projected?.messages?.[0] as {
			role?: string;
			customType?: string;
			content?: Array<{ text: string }>;
		};
		expect(first?.role).toBe("custom");
		expect(first?.customType).toBe("context-gc-projected");
		expect(first?.content?.[0]?.text).toContain("Context unloaded:");
		expect(first?.content?.[0]?.text).not.toContain(output);
		shutdown(fakePi);
	});

	it("does not inventory Context GC inspection tool results as unload candidates", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const toolResultHandler = getHandler<ToolResultHandler>(fakePi, "tool_result");
		const beforeHandler = getHandler<BeforeAgentStartHandler>(fakePi, "before_agent_start");
		expect(toolResultHandler).toBeDefined();
		expect(beforeHandler).toBeDefined();
		if (!toolResultHandler || !beforeHandler) return;

		const largeText = "Context GC inventory row\n".repeat(40_000);
		await toolResultHandler(
			{
				type: "tool_result",
				toolName: "context_inventory",
				toolCallId: "call-inventory-large",
				input: { status: "candidate", includePinned: false, limit: 200 },
				content: [{ type: "text", text: largeText }],
				isError: false,
			},
			createFakeContext(),
		);

		expect(fakePi.deltas).toHaveLength(0);
		const result = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: ["base"] },
			createFakeContext({ tokens: 75_000, contextWindow: 100_000, percent: 75 }),
		);
		expect(result?.message).toBeUndefined();
		expect(result?.systemPrompt).toEqual(["base", expect.stringContaining("context_unload")]);
		shutdown(fakePi);
	});

	it("compacts stale Context GC inspection outputs through the context projection hook", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const projected = await contextHandler(
			{
				type: "context",
				messages: [
					{
						role: "toolResult",
						toolCallId: "call_inventory_before",
						toolName: "context_inventory",
						content: [{ type: "text", text: "large inventory before cleanup" }],
						details: { records: ["large inventory before cleanup"] },
					},
					{
						role: "toolResult",
						toolCallId: "call_unload",
						toolName: "context_unload",
						content: [{ type: "text", text: "Context GC unloaded 1 record(s)." }],
						isError: false,
					},
					{
						role: "toolResult",
						toolCallId: "call_inventory_after",
						toolName: "context_inventory",
						content: [{ type: "text", text: "fresh inventory after cleanup" }],
					},
				],
			},
			createFakeContext(),
		);

		const before = projected?.messages?.[0] as Record<string, unknown> & { content?: Array<{ text: string }> };
		const after = projected?.messages?.[2] as Record<string, unknown> & { content?: Array<{ text: string }> };
		expect(before.toolCallId).toBe("call_inventory_before");
		expect(before.content?.[0]?.text).toBe("Context GC inspection output removed after context_unload.");
		expect(before.details).toBeUndefined();
		expect(after.content?.[0]?.text).toBe("fresh inventory after cleanup");
		shutdown(fakePi);
	});

	it("persists image-bearing tool results as structured JSON through the extension", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const toolResultHandler = getHandler<ToolResultHandler>(fakePi, "tool_result");
		expect(toolResultHandler).toBeDefined();
		if (!toolResultHandler) return;

		const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const largeText = "image tool analysis line\n".repeat(3_000);
		await toolResultHandler(
			{
				type: "tool_result",
				toolName: "read",
				toolCallId: "img-1",
				input: { path: "screenshot.png" },
				content: [
					{ type: "text", text: largeText },
					{ type: "image", data: base64, mimeType: "image/png" },
				],
				isError: false,
			},
			createFakeContext(),
		);
		shutdown(fakePi);

		const inspect = openContextGcStore({ dbPath: path.join(getAgentDir(), "context-gc.sqlite") });
		try {
			const record = inspect
				.listRecords({ sessionId: "session-a", includePinned: true })
				.find(candidate => candidate.id.includes("img-1"));
			expect(record).toBeDefined();
			const payload = record ? inspect.getPayload(record.payloadHash) : null;
			expect(payload?.mediaType).toBe("application/json;charset=utf-8");
			expect(payload?.text).toContain(base64);
			expect(payload?.textProjection).toContain("[image:image/png]");
			expect(payload?.textProjection).not.toContain(base64);
		} finally {
			inspect.close();
		}
	});

	it("saves image-bearing payloads as lossless JSON artifacts, not the [image:*] projection", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const toolResultHandler = getHandler<ToolResultHandler>(fakePi, "tool_result");
		expect(toolResultHandler).toBeDefined();
		if (!toolResultHandler) return;

		const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const largeText = "image artifact analysis line\n".repeat(3_000);
		await toolResultHandler(
			{
				type: "tool_result",
				toolName: "read",
				toolCallId: "img-artifact-1",
				input: { path: "screenshot.png" },
				content: [
					{ type: "text", text: largeText },
					{ type: "image", data: base64, mimeType: "image/png" },
				],
				isError: false,
			},
			createFakeContext(),
		);
		shutdown(fakePi);

		expect(capturedArtifacts).toHaveLength(1);
		const artifact = capturedArtifacts[0];
		// The recall handle surfaced in the placeholder must hold the lossless content, never the
		// flattened "[image:*]" projection that drops the image bytes.
		expect(artifact.content).toContain(base64);
		expect(artifact.content).not.toContain("[image:image/png]");
		expect(JSON.parse(artifact.content)).toEqual([
			{ type: "text", text: largeText },
			{ type: "image", data: base64, mimeType: "image/png" },
		]);
	});

	it("injects a hidden reminder before agent start when candidate inventory is large", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		const beforeHandler = getHandler<BeforeAgentStartHandler>(fakePi, "before_agent_start");
		expect(contextHandler).toBeDefined();
		expect(beforeHandler).toBeDefined();
		if (!contextHandler || !beforeHandler) return;

		const largeText = "large reminder payload\n".repeat(40_000);
		await contextHandler(
			{
				type: "context",
				messages: [{ role: "custom", customType: "large-custom", content: largeText, display: false }],
			},
			createFakeContext(),
		);
		const result = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: [] },
			createFakeContext(),
		);

		expect(result).toMatchObject({
			message: { customType: "context-gc", display: false, details: { kind: "reminder" } },
			systemPrompt: [expect.stringContaining("context_unload")],
		});
		const content = reminderContent(result);
		expect(content).toContain("Context GC:");
		expect(content).not.toContain("Context usage:");
		shutdown(fakePi);
	});

	it("keeps unload reminders compact instead of enumerating candidate records", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const toolResultHandler = getHandler<ToolResultHandler>(fakePi, "tool_result");
		const beforeHandler = getHandler<BeforeAgentStartHandler>(fakePi, "before_agent_start");
		expect(toolResultHandler).toBeDefined();
		expect(beforeHandler).toBeDefined();
		if (!toolResultHandler || !beforeHandler) return;

		const largeText = "large reminder tool payload\n".repeat(40_000);
		await toolResultHandler(
			{
				type: "tool_result",
				toolName: "read",
				toolCallId: "call-reminder-1",
				input: { path: "src/large.ts" },
				content: [{ type: "text", text: largeText }],
				isError: false,
			},
			createFakeContext(),
		);
		const result = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: [] },
			createFakeContext(),
		);

		const content = reminderContent(result) ?? "";
		expect(content).toContain("Context GC:");
		expect(content).toContain("estimated tokens are eligible to unload");
		expect(content).toContain("context_inventory");
		expect(content).toContain("context_unload");
		expect(content).toContain("tool calls, file reads, searches");
		expect(content).toContain("context_pin");
		expect(content).not.toContain("call-reminder-1");
		expect(content).not.toContain("tool:session-a:");
		expect(content).not.toContain("large reminder tool payload");
		expect(content).not.toMatch(/\n(?:[-*]|\d+\.)\s/);
		shutdown(fakePi);
	});

	it("appends Context GC tool guidance to the per-turn system prompt", () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const beforeHandler = getHandler<BeforeAgentStartHandler>(fakePi, "before_agent_start");
		expect(beforeHandler).toBeDefined();
		if (!beforeHandler) return;

		const first = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: ["base prompt"] },
			createFakeContext(),
		);
		expect(first?.message).toBeUndefined();
		expect(first?.systemPrompt).toEqual(["base prompt", expect.stringContaining("context_unload")]);

		const mentionOnly = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: ["Existing mention of [Context GC]."] },
			createFakeContext(),
		);
		expect(mentionOnly?.systemPrompt).toEqual([
			"Existing mention of [Context GC].",
			expect.stringContaining("context_unload"),
		]);

		const second = beforeHandler(
			{
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: first?.systemPrompt ?? [],
			},
			createFakeContext(),
		);
		expect(second).toBeUndefined();
		shutdown(fakePi);
	});

	it("suppresses unload reminders until context usage is above fifty percent", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		const beforeHandler = getHandler<BeforeAgentStartHandler>(fakePi, "before_agent_start");
		expect(contextHandler).toBeDefined();
		expect(beforeHandler).toBeDefined();
		if (!contextHandler || !beforeHandler) return;

		const largeText = "large reminder payload\n".repeat(40_000);
		await contextHandler(
			{
				type: "context",
				messages: [{ role: "custom", customType: "large-custom", content: largeText, display: false }],
			},
			createFakeContext(),
		);

		const below = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: ["base"] },
			createFakeContext({ tokens: 49_900, contextWindow: 100_000, percent: 49.9 }),
		);
		expect(below?.message).toBeUndefined();
		expect(below?.systemPrompt).toEqual(["base", expect.stringContaining("context_unload")]);

		const atThreshold = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: ["base"] },
			createFakeContext({ tokens: 50_000, contextWindow: 100_000, percent: 50 }),
		);
		expect(atThreshold?.message).toBeUndefined();
		expect(atThreshold?.systemPrompt).toEqual(["base", expect.stringContaining("context_unload")]);

		const above = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: ["base"] },
			createFakeContext({ tokens: 50_100, contextWindow: 100_000, percent: 50.1 }),
		);
		expect(above?.message).toMatchObject({
			customType: "context-gc",
			display: false,
			details: { kind: "reminder" },
		});
		expect(reminderContent(above)).toContain("Context usage: 50100/100000 tokens (50.1%).");
		const unknown = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: ["base"] },
			createFakeContext({ tokens: null, contextWindow: 100_000, percent: null }),
		);
		expect(unknown?.message).toMatchObject({
			customType: "context-gc",
			display: false,
			details: { kind: "reminder" },
		});
		expect(reminderContent(unknown) ?? "").not.toContain("Context usage:");

		const missingUsage = beforeHandler(
			{ type: "before_agent_start", prompt: "continue", systemPrompt: ["base"] },
			createFakeContext(),
		);
		expect(missingUsage?.message).toMatchObject({
			customType: "context-gc",
			display: false,
			details: { kind: "reminder" },
		});
		expect(reminderContent(missingUsage) ?? "").not.toContain("Context usage:");
		expect(above?.systemPrompt).toEqual(["base", expect.stringContaining("context_unload")]);
		shutdown(fakePi);
	});

	it("binds duplicate same-payload custom inventory to distinct stable entry ids", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const shared = "duplicate custom payload\n".repeat(3_000);
		const msg1 = { role: "custom", customType: "tool-output", content: shared, display: false };
		const msg2 = { role: "custom", customType: "tool-output", content: shared, display: false };
		session.entries.push({ type: "message", id: "dup-1", parentId: session.leafId, message: msg1 });
		session.leafId = "dup-1";
		session.entries.push({ type: "message", id: "dup-2", parentId: session.leafId, message: msg2 });
		session.leafId = "dup-2";

		await contextHandler({ type: "context", messages: [msg1, msg2] }, createFakeContext());

		const ids = (fakePi.deltas as Array<{ data: { id: string } }>).map(delta => delta.data.id);
		const hash = Bun.SHA256.hash(shared, "hex");
		expect(ids).toContain(`custom:session-a:dup-1:${hash}`);
		expect(ids).toContain(`custom:session-a:dup-2:${hash}`);
		shutdown(fakePi);
	});

	it("binds duplicate same-payload custom_message inventory to distinct stable entry ids", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const shared = "duplicate custom payload\n".repeat(3_000);
		const msg1 = { role: "custom", customType: "tool-output", content: shared, display: false };
		const msg2 = { role: "custom", customType: "tool-output", content: shared, display: false };
		session.entries.push({
			type: "custom_message",
			id: "dup-1",
			parentId: session.leafId,
			customType: "tool-output",
			content: shared,
			display: false,
			timestamp: new Date().toISOString(),
		});
		session.leafId = "dup-1";
		session.entries.push({
			type: "custom_message",
			id: "dup-2",
			parentId: session.leafId,
			customType: "tool-output",
			content: shared,
			display: false,
			timestamp: new Date().toISOString(),
		});
		session.leafId = "dup-2";

		await contextHandler({ type: "context", messages: [msg1, msg2] }, createFakeContext());

		const ids = (fakePi.deltas as Array<{ data: { id: string } }>).map(delta => delta.data.id);
		const hash = Bun.SHA256.hash(shared, "hex");
		expect(ids).toContain(`custom:session-a:dup-1:${hash}`);
		expect(ids).toContain(`custom:session-a:dup-2:${hash}`);
		expect(ids).not.toContain(`custom:session-a:tool-output:${hash}`);
		shutdown(fakePi);
	});

	it("prefers live message entryId over same-payload branch scan during inventory", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		const shared = "compacted duplicate custom payload\n".repeat(3_000);
		session.entries.push({
			type: "custom_message",
			id: "older-hidden",
			parentId: session.leafId,
			customType: "tool-output",
			content: shared,
			display: false,
			timestamp: new Date().toISOString(),
		});
		session.leafId = "older-hidden";
		const liveMessage = {
			role: "custom",
			entryId: "live-after-compaction",
			customType: "tool-output",
			content: shared,
			display: false,
		};

		await contextHandler({ type: "context", messages: [liveMessage] }, createFakeContext());

		const hash = Bun.SHA256.hash(shared, "hex");
		const recordId = `custom:session-a:live-after-compaction:${hash}`;
		expect((fakePi.deltas as Array<{ data: { id: string } }>).map(delta => delta.data.id)).toContain(recordId);
		expect((fakePi.deltas as Array<{ data: { id: string } }>).map(delta => delta.data.id)).not.toContain(
			`custom:session-a:older-hidden:${hash}`,
		);

		appendCustomEntry("context-gc", {
			...(fakePi.deltas[0] as { data: Record<string, unknown> }).data,
			op: "unload",
			status: "unloaded",
		});
		const projected = await contextHandler({ type: "context", messages: [liveMessage] }, createFakeContext());
		const projectedMessage = projected?.messages?.[0] as { content?: Array<{ text?: string }> };
		expect(projectedMessage?.content?.[0]?.text).toContain(`Context unloaded: ${recordId}`);
		expect(projectedMessage?.content?.[0]?.text).not.toContain(shared);
		shutdown(fakePi);
	});

	it("resolves image-bearing custom entry ids by stored-payload hash, not the lossy text projection", async () => {
		const fakePi = createFakePi();
		contextGcExtension(fakePi as unknown as ExtensionAPI);
		const contextHandler = getHandler<ContextHandler>(fakePi, "context");
		expect(contextHandler).toBeDefined();
		if (!contextHandler) return;

		// Two image-bearing custom messages with an identical text projection (same caption, same
		// "[image:image/png]" marker) but different image bytes -> identical projection hash, distinct
		// stored-payload hashes.
		const caption = "shared vision caption line\n".repeat(3_000);
		const msg1 = {
			role: "custom",
			customType: "vision",
			content: [
				{ type: "text", text: caption },
				{ type: "image", data: "AAAAAAAA", mimeType: "image/png" },
			],
			display: false,
		};
		const msg2 = {
			role: "custom",
			customType: "vision",
			content: [
				{ type: "text", text: caption },
				{ type: "image", data: "BBBBBBBB", mimeType: "image/png" },
			],
			display: false,
		};
		// Register both as stable branch message entries so entry-id recovery has targets.
		session.entries.push({ type: "message", id: "msg-1", parentId: session.leafId, message: msg1 });
		session.leafId = "msg-1";
		session.entries.push({ type: "message", id: "msg-2", parentId: session.leafId, message: msg2 });
		session.leafId = "msg-2";

		await contextHandler({ type: "context", messages: [msg1, msg2] }, createFakeContext());

		const ids = (fakePi.deltas as Array<{ data: { id: string } }>).map(delta => delta.data.id);
		const hash1 = Bun.SHA256.hash(JSON.stringify(msg1.content), "hex");
		const hash2 = Bun.SHA256.hash(JSON.stringify(msg2.content), "hex");
		// Each occurrence binds to its own entry id paired with its own stored-payload hash.
		expect(ids).toContain(`custom:session-a:msg-1:${hash1}`);
		expect(ids).toContain(`custom:session-a:msg-2:${hash2}`);
		// A lossy text-projection hash would have aliased msg2 onto entry msg-1.
		expect(ids).not.toContain(`custom:session-a:msg-1:${hash2}`);
		shutdown(fakePi);
	});
});
