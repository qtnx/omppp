import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as core from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { createTools, type ToolSession } from "../index";
import { SuperReviewTool } from "../super-review";

function makeModel(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
		...extra,
	} as Model<Api>;
}

const SUPER_MODEL = makeModel("tnx", "super");

interface SessionOptions {
	cwd?: string;
	apiKey?: string | null;
	sessionId?: string;
}

function makeSession(options: SessionOptions = {}): ToolSession {
	const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
	const modelRegistry = {
		getAvailable: () => [SUPER_MODEL],
		getApiKey: async () => (options.apiKey === undefined ? "test-key" : options.apiKey),
		resolver: () => async () => (options.apiKey === undefined ? "test-key" : options.apiKey),
	} as unknown as ModelRegistry;
	return {
		settings,
		modelRegistry,
		cwd: options.cwd,
		getActiveModelString: () => "p/default",
		getSessionId: () => options.sessionId ?? "super-review-test-session",
	} as unknown as ToolSession;
}

function assistantWithText(text: string): AssistantMessage {
	return assistant({ content: [{ type: "text", text }] });
}

function assistantWithStructuredPayload(payload: Record<string, unknown>): AssistantMessage {
	return assistant({ content: [{ type: "toolCall", id: "tc-respond", name: "respond", arguments: payload }] });
}

function assistant(options: {
	content: AssistantMessage["content"];
	stopReason?: AssistantMessage["stopReason"];
}): AssistantMessage {
	return {
		role: "assistant",
		content: options.content,
		api: "openai-responses",
		provider: "tnx",
		model: "super",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

type InstrumentedCall = [
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	span: { oneshotKind?: string; completeImpl?: unknown },
];

interface InstrumentedSpy {
	mock: {
		calls: unknown[][];
	};
}

async function ensureTmpParent(): Promise<void> {
	const tmpdir = process.env.TMPDIR;
	if (tmpdir) await fs.mkdir(tmpdir, { recursive: true });
}

function instrumentedCallAt(spy: InstrumentedSpy, index: number): InstrumentedCall {
	const rawCall = spy.mock.calls[index];
	if (!rawCall) throw new Error(`missing instrumentedCompleteSimple call ${index}`);
	return rawCall as InstrumentedCall;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function resultVisiblePayload(result: AgentToolResult<unknown>): string {
	return `${resultText(result)}\n${JSON.stringify(result.details ?? null)}`;
}

function promptPayload(context: Context): string {
	return JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools });
}

describe("SuperReviewTool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is reachable through explicit built-in tool creation", async () => {
		const tools = await createTools(makeSession(), ["super_review"]);

		expect(tools.map(tool => tool.name)).toContain("super_review");
	});

	it("sends one toolless super_review model call for a plan review and returns assistant text", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Tighten the exit criteria."));
		const tool = new SuperReviewTool(makeSession());

		const result = await tool.execute("tc-plan", {
			review_type: "plan",
			question: "Should this migration plan ship?",
			content: "Step 1: add tests. Step 2: implement the migration.",
		});

		expect(resultText(result)).toBe("Tighten the exit criteria.");
		expect(completeSpy).toHaveBeenCalledTimes(1);
		const [model, context, options, span] = instrumentedCallAt(completeSpy, 0);
		expect(`${model.provider}/${model.id}`).toBe("tnx/super");
		expect(span.oneshotKind).toBe("super_review");
		expect(options.toolChoice).toBeUndefined();
		expect(context.tools ?? []).toEqual([]);
		const outbound = promptPayload(context);
		expect(outbound).toContain("Should this migration plan ship?");
		expect(outbound).toContain("Step 1: add tests. Step 2: implement the migration.");
		expect(outbound).toContain("plan");
	});

	it("includes an explicit workspace file under an untrusted boundary and reports attachment metadata", async () => {
		await ensureTmpParent();
		using workspace = TempDir.createSync("@super-review-workspace-");
		await Bun.write(path.join(workspace.path(), "plan.md"), "alpha\nbeta\ngamma\n");
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Attachment reviewed."));
		const tool = new SuperReviewTool(makeSession({ cwd: workspace.path() }));

		const result = await tool.execute("tc-file", {
			review_type: "critical_action",
			question: "Is this file-backed action safe?",
			files: [{ path: "plan.md", label: "Plan draft", range: "1-2" }],
		});

		expect(resultText(result)).toBe("Attachment reviewed.");
		const [, context] = instrumentedCallAt(completeSpy, 0);
		const outbound = promptPayload(context);
		expect(outbound).toContain("Plan draft");
		expect(outbound).toContain("plan.md");
		expect(outbound).toContain("alpha");
		expect(outbound).toContain("beta");
		expect(outbound).not.toContain("gamma");
		expect(outbound).toMatch(/untrusted/i);
		expect(outbound).toMatch(/attachment/i);
		const visibleResult = resultVisiblePayload(result);
		expect(visibleResult).toContain("plan.md");
		expect(visibleResult).toMatch(/truncated\W*false|not truncated/i);
		expect(visibleResult).toMatch(/bytes|lines|range/i);
	});

	it("rejects unsafe explicit file attachments before any model call", async () => {
		await ensureTmpParent();
		using workspace = TempDir.createSync("@super-review-unsafe-workspace-");
		using outside = TempDir.createSync("@super-review-outside-");
		await Bun.write(path.join(workspace.path(), "notes.md"), "safe text\n");
		await Bun.write(path.join(workspace.path(), ".env"), "TOKEN=secret\n");
		const outsideFile = path.join(outside.path(), "outside.txt");
		await Bun.write(outsideFile, "outside\n");
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("should not run"));
		const tool = new SuperReviewTool(makeSession({ cwd: workspace.path() }));
		const cases: Array<{ name: string; filePath: string; message: RegExp }> = [
			{ name: "directory", filePath: ".", message: /directory/i },
			{ name: "glob", filePath: "*.md", message: /glob/i },
			{ name: "url", filePath: "https://example.test/plan.md", message: /url|network/i },
			{ name: "outside workspace", filePath: outsideFile, message: /outside|workspace|escapes/i },
			{ name: "secret-like file", filePath: ".env", message: /secret|credential|\.env/i },
		];

		for (const testCase of cases) {
			await expect(
				tool.execute(`tc-unsafe-${testCase.name}`, {
					review_type: "security",
					question: "Review this attachment.",
					files: [{ path: testCase.filePath }],
				}),
			).rejects.toThrow(testCase.message);
		}
		expect(completeSpy).not.toHaveBeenCalled();
	});

	it("forces a single structured respond path when output_schema is provided", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithStructuredPayload({ verdict: "revise", risk: "high" }));
		const tool = new SuperReviewTool(makeSession());

		const result = await tool.execute("tc-structured", {
			review_type: "qa_plan",
			question: "Return a structured QA verdict.",
			output_schema: {
				type: "object",
				properties: {
					verdict: { type: "string" },
					risk: { type: "string" },
				},
				required: ["verdict", "risk"],
			},
		});

		expect(JSON.parse(resultText(result))).toEqual({ verdict: "revise", risk: "high" });
		const [, context, options] = instrumentedCallAt(completeSpy, 0);
		expect(context.tools?.map(toolSpec => toolSpec.name)).toEqual(["respond"]);
		expect(options.toolChoice).toEqual({ type: "tool", name: "respond" });
		expect(resultVisiblePayload(result)).toMatch(/structured|output_schema|schema/i);
	});
});
