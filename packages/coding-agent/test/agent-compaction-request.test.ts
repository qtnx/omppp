import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AgentSession,
	type AgentSessionEvent,
	detectUserCompactIntent,
	stripUserCompactIntent,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CompactTool } from "@oh-my-pi/pi-coding-agent/tools/compact";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("agent-requested compaction", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-compact-request-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-compact-request-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		session = createSession({ "compaction.keepRecentTokens": 1 });
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		await session.dispose();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(settings: Record<string, unknown> = {}): AgentSession {
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		return new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(settings),
			modelRegistry,
		});
	}

	function seedCompactableHistory(): void {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old request" }],
			timestamp: Date.now() - 4,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "old response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: usage(24),
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "recent request" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "recent response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: usage(32),
			timestamp: Date.now() - 1,
		});
	}

	function usage(totalTokens: number): AssistantMessage["usage"] {
		return {
			input: totalTokens,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: totalTokens + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function assistant(stopReason: AssistantMessage["stopReason"] = "stop", totalTokens = 120): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason,
			usage: usage(totalTokens),
			timestamp: Date.now(),
		};
	}

	function shortCircuitCompaction(): void {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	async function driveTurn(message: AssistantMessage): Promise<void> {
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		await Promise.resolve();
		await session.waitForIdle();
		await Promise.resolve();
	}

	async function driveTurnAndWaitForCompaction(message: AssistantMessage): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "auto_compaction_end") resolve();
		});
		try {
			session.agent.emitExternalEvent({ type: "message_end", message });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
			await promise;
			await session.waitForIdle();
		} finally {
			unsubscribe();
		}
	}

	it("deduplicates an agent compaction request within the current turn", () => {
		seedCompactableHistory();

		expect(session.requestCompactionFromAgent("boundary reached")).toEqual({ status: "scheduled" });
		expect(session.requestCompactionFromAgent("same boundary")).toEqual({ status: "already-scheduled" });
	});

	it("rejects agent compaction requests when strategy is off", async () => {
		await session.dispose();
		session = createSession({ "compaction.strategy": "off" });
		seedCompactableHistory();

		const result = session.requestCompactionFromAgent("boundary reached");

		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") expect(result.detail).toContain("strategy is set to off");
	});

	it("rejects agent compaction requests when there is nothing to compact", () => {
		const result = session.requestCompactionFromAgent("fresh session");

		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") expect(result.detail).toContain("nothing to compact");
	});

	it("consumes a scheduled request once at turn end", async () => {
		seedCompactableHistory();
		shortCircuitCompaction();

		expect(session.requestCompactionFromAgent("boundary reached")).toEqual({ status: "scheduled" });
		await driveTurnAndWaitForCompaction(assistant("stop"));
		await driveTurn(assistant("stop"));

		const starts = events.filter(event => event.type === "auto_compaction_start" && event.reason === "requested");
		expect(starts).toHaveLength(1);
	});

	it("drops a scheduled request on an aborted turn", async () => {
		seedCompactableHistory();
		shortCircuitCompaction();

		expect(session.requestCompactionFromAgent("boundary reached")).toEqual({ status: "scheduled" });
		await driveTurn(assistant("aborted"));
		await driveTurn(assistant("stop"));

		expect(events.some(event => event.type === "auto_compaction_start" && event.reason === "requested")).toBe(false);
	});

	it("runs requested compaction even when ordinary threshold compaction is disabled", async () => {
		await session.dispose();
		session = createSession({
			"compaction.enabled": false,
			"compaction.strategy": "context-full",
			"compaction.keepRecentTokens": 1,
		});
		session.subscribe(event => events.push(event));
		seedCompactableHistory();
		shortCircuitCompaction();

		await driveTurn(assistant("stop", 190_000));
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);

		expect(session.requestCompactionFromAgent("explicit boundary")).toEqual({ status: "scheduled" });
		await driveTurnAndWaitForCompaction(assistant("stop"));

		expect(
			events.filter(event => event.type === "auto_compaction_start" && event.reason === "requested"),
		).toHaveLength(1);
	});

	it("strips the consumed compact instruction from the prompt and appends a performed notice", async () => {
		seedCompactableHistory();
		shortCircuitCompaction();
		// Pre-prompt #checkCompaction only runs when agent state holds an assistant message.
		session.agent.replaceMessages([assistant("stop")]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("compact đi rồi tiếp tục việc còn lại");

		expect(
			events.filter(event => event.type === "auto_compaction_start" && event.reason === "requested"),
		).toHaveLength(1);

		const arg = promptSpy.mock.calls[0]?.[0];
		const sent = (Array.isArray(arg) ? arg : [arg]) as Array<{
			role: string;
			customType?: string;
			content: string | Array<{ type: string; text?: string }>;
		}>;
		const userMessage = sent.find(message => message.role === "user");
		expect(userMessage).toBeDefined();
		const textBlock = Array.isArray(userMessage?.content)
			? userMessage.content.find(block => block.type === "text")
			: undefined;
		expect(textBlock?.text).toBe("rồi tiếp tục việc còn lại");
		expect(
			sent.some(message => message.role === "custom" && message.customType === "compaction-performed-notice"),
		).toBe(true);
	});
});

describe("CompactTool agent request bridge", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function toolSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated(),
			...overrides,
		} as unknown as ToolSession;
	}

	it("is unavailable without a requestable compaction session", () => {
		expect(
			CompactTool.createIf(
				toolSession({
					settings: Settings.isolated({ "compaction.strategy": "off" }),
					requestCompaction: () => ({ status: "scheduled" }),
				}),
			),
		).toBeNull();
		expect(CompactTool.createIf(toolSession())).toBeNull();
		expect(CompactTool.createIf(toolSession({ requestCompaction: () => ({ status: "scheduled" }) }))).toBeInstanceOf(
			CompactTool,
		);
	});

	it("maps request outcomes to tool results", async () => {
		const unavailable = new CompactTool(
			toolSession({ requestCompaction: () => ({ status: "unavailable", detail: "nothing useful" }) }),
		);
		await expect(unavailable.execute("call-1", { reason: "boundary" })).rejects.toThrow(ToolError);
		await expect(unavailable.execute("call-1", { reason: "boundary" })).rejects.toThrow("nothing useful");

		const scheduled = new CompactTool(toolSession({ requestCompaction: () => ({ status: "scheduled" }) }));
		const result = await scheduled.execute("call-2", { reason: "boundary" });
		const first = result.content[0];
		if (first?.type !== "text") throw new Error(`expected text content, got ${first?.type}`);
		expect(first.text).toContain("runs automatically when this turn ends");
	});
});

describe("system prompt compaction guidance", () => {
	it("includes the Context Compaction section only when the compact tool is available", async () => {
		const emptyTree = { rootPath: "/tmp", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };
		const base = { cwd: "/tmp", contextFiles: [], skills: [], rules: [], workspaceTree: emptyTree };

		const withCompact = await buildSystemPrompt({ ...base, toolNames: ["read", "compact", "context_unload"] });
		const withCompactText = withCompact.systemPrompt.join("\n\n");
		expect(withCompactText).toContain("# Context Compaction");
		expect(withCompactText).toContain("LAST action of the turn");
		// Mid-task scope split is rendered when context GC tools coexist.
		expect(withCompactText).toContain("`context_unload` instead");

		const withoutCompact = await buildSystemPrompt({ ...base, toolNames: ["read", "context_unload"] });
		expect(withoutCompact.systemPrompt.join("\n\n")).not.toContain("# Context Compaction");
	});
});

describe("detectUserCompactIntent", () => {
	it("triggers on imperative compact instructions", () => {
		const imperatives = [
			"compact",
			"/compact",
			"compact!",
			"compact đi",
			"compact ngay đi",
			"compact giùm tao",
			"hãy compact",
			"làm ơn compact giúp",
			"please compact",
			"pls compact",
			"run compact",
			"compact now",
			"compact the context",
		];
		for (const text of imperatives) {
			expect(detectUserCompactIntent(text), text).toBe(true);
		}
	});

	it("ignores questions and discussion about compaction", () => {
		const mentions = [
			"mày có thực hiện compact trước khi trả lời đâu?",
			"phần consider thực hiện compact có vẻ chưa hoạt động ?",
			"trong cái phần checkCompaction luôn check tin nhắn có từ compact hoặc intent user bảo compact thì thực hiện compact",
			"compaction strategy nào tốt nhất",
			"tool compact hoạt động chưa",
			"the compact tool schedules compaction at the next turn boundary",
			"",
		];
		for (const text of mentions) {
			expect(detectUserCompactIntent(text), text).toBe(false);
		}
	});
});

describe("stripUserCompactIntent", () => {
	it("removes the consumed instruction and keeps the rest of the request", () => {
		const cases: [string, string][] = [
			["compact", ""],
			["/compact", ""],
			["compact!", ""],
			["hãy compact", ""],
			["compact đi rồi fix bug X", "rồi fix bug X"],
			["please compact then continue the review", "then continue the review"],
			["compact now and rerun the tests", "and rerun the tests"],
		];
		for (const [input, expected] of cases) {
			expect(stripUserCompactIntent(input), input).toBe(expected);
		}
	});

	it("leaves non-imperative text untouched", () => {
		const texts = ["the compact tool schedules compaction", "compaction strategy nào tốt nhất"];
		for (const text of texts) {
			expect(stripUserCompactIntent(text), text).toBe(text);
		}
	});
});
