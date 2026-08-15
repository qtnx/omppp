import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as core from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, ImageContent, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Shape } from "@oh-my-pi/snapcompact";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createTools, type ToolSession } from "../../src/tools";
import { SuperReviewTool } from "../../src/tools/super-review";

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
const FABLE_MODEL = makeModel("anthropic", "claude-fable-5", { api: "anthropic-messages" });
const SOL_MODEL = makeModel("openai-codex", "gpt-5.6-sol");

interface SessionOptions {
	cwd?: string;
	apiKey?: string | null;
	apiKeys?: Record<string, string | null>;
	sessionId?: string;
	model?: Model<Api>;
	models?: Model<Api>[];
	superReviewRole?: string;
}

function makeSession(options: SessionOptions = {}): ToolSession {
	const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
	if (options.superReviewRole) settings.setModelRole("super_review", options.superReviewRole);
	const models = options.models ?? [options.model ?? SUPER_MODEL];
	const resolveKey = (model?: Model<Api>): string | null => {
		if (model) {
			const specific = options.apiKeys?.[`${model.provider}/${model.id}`];
			if (specific !== undefined) return specific;
		}
		return options.apiKey === undefined ? "test-key" : options.apiKey;
	};
	const modelRegistry = {
		getAvailable: () => models,
		getApiKey: async (model: Model<Api>) => resolveKey(model),
		resolver: (model: Model<Api>) => async () => resolveKey(model),
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

function assistant(options: {
	content: AssistantMessage["content"];
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
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
		errorMessage: options.errorMessage,
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

async function resolveRequestApiKey(options: SimpleStreamOptions): Promise<string | undefined> {
	const resolver = options.apiKey;
	if (typeof resolver !== "function")
		throw new Error("expected instrumentedCompleteSimple apiKey option to be a resolver");
	return await resolver({ lastChance: false, error: undefined });
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

function messageBlocks(context: Context, index = 0): NonNullable<Context["messages"][number]["content"]> {
	const message = context.messages[index];
	if (!message) throw new Error(`missing context message ${index}`);
	return message.content;
}
type MessageBlock = Exclude<NonNullable<Context["messages"][number]["content"]>, string>[number];

function imageBlocks(context: Context): Extract<MessageBlock, { type: "image" }>[] {
	const blocks = messageBlocks(context);
	if (!Array.isArray(blocks)) return [];
	return Array.from(blocks).filter(
		(block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image",
	);
}

function textPayload(context: Context): string {
	const blocks = messageBlocks(context);
	if (typeof blocks === "string") return blocks;
	return Array.from(blocks)
		.filter((block): block is Extract<MessageBlock, { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join("\n");
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
		expect(options.maxTokens).toBe(8192);
		expect(options.toolChoice).toBeUndefined();
		expect(context.tools ?? []).toEqual([]);
		const outbound = promptPayload(context);
		expect(outbound).toContain("Should this migration plan ship?");
		expect(outbound).toContain("Step 1: add tests. Step 2: implement the migration.");
		expect(outbound).toContain("plan");
	});

	it("keeps the resolved provider endpoint and uses the registry key instead of the auth gateway", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Native review complete."));
		const tool = new SuperReviewTool(makeSession({ apiKey: "local-upstream-key" }));

		const result = await tool.execute("tc-native", {
			review_type: "plan",
			question: "Should this use the native provider?",
			content: "Do not rewrite tnx/super through the dead auth gateway.",
		});

		expect(resultText(result)).toBe("Native review complete.");
		expect(completeSpy).toHaveBeenCalledTimes(1);
		const [model, , options] = instrumentedCallAt(completeSpy, 0);
		expect(`${model.provider}/${model.id}`).toBe("tnx/super");
		expect(model.baseUrl).toBe("https://example.test/v1");
		expect(await resolveRequestApiKey(options)).toBe("local-upstream-key");
	});

	it("prefers anthropic/claude-fable-5 from the default chain when it is available and authenticated", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Fable review complete."));
		const tool = new SuperReviewTool(
			makeSession({
				models: [FABLE_MODEL, SUPER_MODEL, SOL_MODEL],
			}),
		);

		const result = await tool.execute("tc-default-fable", {
			review_type: "plan",
			question: "Which default model should run?",
			content: "All three fallback models are available.",
		});

		expect(resultText(result)).toBe("Fable review complete.");
		const [model] = instrumentedCallAt(completeSpy, 0);
		expect(`${model.provider}/${model.id}`).toBe("anthropic/claude-fable-5");
	});

	it("uses the configured modelRoles.super_review override instead of the default chain", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Override review complete."));
		const tool = new SuperReviewTool(
			makeSession({
				models: [FABLE_MODEL, SUPER_MODEL, SOL_MODEL],
				superReviewRole: "openai-codex/gpt-5.6-sol:high",
			}),
		);

		const result = await tool.execute("tc-override", {
			review_type: "plan",
			question: "Should the override win?",
			content: "modelRoles.super_review points at gpt-5.6-sol.",
		});

		expect(resultText(result)).toBe("Override review complete.");
		const [model] = instrumentedCallAt(completeSpy, 0);
		expect(`${model.provider}/${model.id}`).toBe("openai-codex/gpt-5.6-sol");
	});

	it("falls back through the default super_review chain to the first authenticated available model", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Fallback review complete."));
		const tool = new SuperReviewTool(
			makeSession({
				models: [FABLE_MODEL, SUPER_MODEL, SOL_MODEL],
				apiKeys: {
					"anthropic/claude-fable-5": null,
					"tnx/super": "tnx-key",
					"openai-codex/gpt-5.6-sol": "sol-key",
				},
			}),
		);

		const result = await tool.execute("tc-fallback", {
			review_type: "architecture",
			question: "Which fallback should run?",
			content: "Fable is unauthenticated; tnx/super should win.",
		});

		expect(resultText(result)).toBe("Fallback review complete.");
		const [model, , options] = instrumentedCallAt(completeSpy, 0);
		expect(`${model.provider}/${model.id}`).toBe("tnx/super");
		expect(await resolveRequestApiKey(options)).toBe("tnx-key");
	});

	it("retries the authenticated default chain after a runtime provider error and reports the successful model", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValueOnce(
				assistant({
					content: [],
					stopReason: "error",
					errorMessage: "Provider returned HTTP 402 after reducing the output cap",
				}),
			)
			.mockResolvedValueOnce(assistantWithText("TNX review complete."));
		const tool = new SuperReviewTool(
			makeSession({
				models: [FABLE_MODEL, SUPER_MODEL, SOL_MODEL],
			}),
		);

		const result = await tool.execute("tc-runtime-fallback", {
			review_type: "plan",
			question: "Does runtime provider failure retry the configured chain?",
			content: "The first provider rejects the request after output-cap reduction.",
		});

		expect(resultText(result)).toBe("TNX review complete.");
		expect(resultVisiblePayload(result)).toContain('"model":"tnx/super"');
		expect(completeSpy).toHaveBeenCalledTimes(2);
		for (const index of [0, 1]) {
			const [model, , options] = instrumentedCallAt(completeSpy, index);
			expect(`${model.provider}/${model.id}`).toBe(index === 0 ? "anthropic/claude-fable-5" : "tnx/super");
			expect(options.maxTokens).toBe(8192);
		}
	});

	it("reports every authenticated default-chain provider failure after runtime exhaustion", async () => {
		const failures = ["Provider HTTP 402", "TNX provider timeout", "Codex upstream unavailable"] as const;
		const completeSpy = vi.spyOn(core, "instrumentedCompleteSimple").mockImplementation(async () => {
			const errorMessage = failures[completeSpy.mock.calls.length - 1];
			return assistant({ content: [], stopReason: "error", errorMessage });
		});
		const tool = new SuperReviewTool(
			makeSession({
				models: [FABLE_MODEL, SUPER_MODEL, SOL_MODEL],
			}),
		);

		await expect(
			tool.execute("tc-runtime-exhaustion", {
				review_type: "critical_action",
				question: "Does chain exhaustion report each provider failure?",
				content: "Each authenticated candidate returns a distinct error.",
			}),
		).rejects.toThrow(
			/anthropic\/claude-fable-5: Provider HTTP 402; tnx\/super: TNX provider timeout; openai-codex\/gpt-5\.6-sol: Codex upstream unavailable/,
		);

		expect(completeSpy).toHaveBeenCalledTimes(3);
		expect(
			[0, 1, 2].map(index => {
				const [model] = instrumentedCallAt(completeSpy, index);
				return `${model.provider}/${model.id}`;
			}),
		).toEqual(["anthropic/claude-fable-5", "tnx/super", "openai-codex/gpt-5.6-sol"]);
	});

	it("throws when no configured or default super_review candidate is available", async () => {
		const tool = new SuperReviewTool(makeSession({ models: [makeModel("openai", "gpt-4o")] }));

		await expect(
			tool.execute("tc-missing", {
				review_type: "other",
				question: "Can this run without a review model?",
			}),
		).rejects.toThrow(/could not resolve a model/);
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

	it("packs large inline content into snapcompact images for a vision-capable super model", async () => {
		const reviewType = "plan";
		const question = "Should this large review packet ship?";
		const largeContent = `BEGIN_LARGE_REVIEW_PAYLOAD\n${"audit-lane\n".repeat(2000)}END_LARGE_REVIEW_PAYLOAD`;
		const frame: ImageContent = { type: "image", data: "ZmFrZS1zbmFwY29tcGFjdC1mcmFtZQ==", mimeType: "image/png" };
		const shape = { frameTokenEstimate: 1 } as Shape;
		vi.spyOn(snapcompact, "resolveShape").mockReturnValue(shape);
		vi.spyOn(snapcompact, "frames").mockReturnValue(1);
		const renderManySpy = vi.spyOn(snapcompact, "renderMany").mockResolvedValue([frame]);
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Ship it after tightening the rollback gate."));
		const visionSuper = makeModel("tnx", "super", { input: ["text", "image"] });
		const tool = new SuperReviewTool(makeSession({ model: visionSuper }));

		const result = await tool.execute("tc-snapcompact-large-inline", {
			review_type: reviewType,
			question,
			content: largeContent,
		});

		expect(resultText(result)).toBe("Ship it after tightening the rollback gate.");
		expect(renderManySpy).toHaveBeenCalledTimes(1);
		const renderedInput = renderManySpy.mock.calls[0]?.[0] as string | undefined;
		expect(renderedInput).toContain(largeContent);
		expect(renderedInput).not.toContain(question);
		const [, context, options] = instrumentedCallAt(completeSpy, 0);
		expect(imageBlocks(context)).toEqual([frame]);
		const outbound = promptPayload(context);
		expect(outbound).toContain(question);
		expect(outbound).toContain(reviewType);
		expect(outbound.toLowerCase()).toContain("snapcompact");
		expect(outbound).not.toContain(largeContent);
		expect(textPayload(context)).not.toContain(largeContent);
		expect(context.tools ?? []).toEqual([]);
		expect(options.toolChoice).toBeUndefined();
	});

	it("packs large file attachment body into snapcompact images while keeping metadata textual", async () => {
		await ensureTmpParent();
		using workspace = TempDir.createSync("@super-review-large-file-workspace-");
		const reviewType = "critical_action";
		const question = "Can this live reviewer question stay textual?";
		const range = "1-2002";
		const attachmentBody = `BEGIN_ATTACHMENT_PAYLOAD\n${"packet-lane\n".repeat(2000)}END_ATTACHMENT_PAYLOAD`;
		await Bun.write(path.join(workspace.path(), "packet.txt"), attachmentBody);
		const frame: ImageContent = { type: "image", data: "ZmFrZS1sYXJnZS1maWxlLWZyYW1l", mimeType: "image/png" };
		const shape = { frameTokenEstimate: 1 } as Shape;
		vi.spyOn(snapcompact, "resolveShape").mockReturnValue(shape);
		vi.spyOn(snapcompact, "frames").mockReturnValue(1);
		const renderManySpy = vi.spyOn(snapcompact, "renderMany").mockResolvedValue([frame]);
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Attachment frame reviewed."));
		const visionSuper = makeModel("tnx", "super", { input: ["text", "image"] });
		const tool = new SuperReviewTool(makeSession({ cwd: workspace.path(), model: visionSuper }));

		const result = await tool.execute("tc-snapcompact-large-file-attachment", {
			review_type: reviewType,
			question,
			files: [{ path: "packet.txt", label: "Evidence packet", range }],
		});

		expect(resultText(result)).toBe("Attachment frame reviewed.");
		expect(renderManySpy).toHaveBeenCalledTimes(1);
		const renderedInput = renderManySpy.mock.calls[0]?.[0] as string | undefined;
		expect(renderedInput).toContain(attachmentBody);
		expect(renderedInput).toContain("Attachment: Evidence packet (packet.txt) range 1-2002");
		expect(renderedInput).toContain('<untrusted-attachment path="packet.txt" label="Evidence packet" range="1-2002"');
		expect(renderedInput).toContain('bytes="');
		expect(renderedInput).toContain('lines="2002"');
		expect(renderedInput).not.toContain(question);
		const [, context, options] = instrumentedCallAt(completeSpy, 0);
		expect(imageBlocks(context)).toEqual([frame]);
		const outbound = textPayload(context);
		expect(outbound).toContain(question);
		expect(outbound).toContain(reviewType);
		expect(outbound).toContain("packet.txt");
		expect(outbound).toContain("Evidence packet");
		expect(outbound).toContain('range="1-2002"');
		expect(outbound).toContain('bytes="');
		expect(outbound).toContain('lines="2002"');
		expect(outbound).not.toContain(attachmentBody);
		expect(outbound).not.toContain("BEGIN_ATTACHMENT_PAYLOAD");
		expect(outbound).not.toContain("packet-lane");
		expect(outbound).not.toContain("END_ATTACHMENT_PAYLOAD");
		expect(context.tools ?? []).toEqual([]);
		expect(options.toolChoice).toBeUndefined();
	});

	it("keeps inline content as plain text when the super model cannot use snapcompact profitably", async () => {
		const largeContent = `BEGIN_NON_VISION_REVIEW_PAYLOAD\n${"fallback-lane\n".repeat(2000)}END_NON_VISION_REVIEW_PAYLOAD`;
		const smallContent = "Small packet should stay readable as text.";
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Plain text review complete."));
		const cases: Array<{ name: string; model: Model<Api>; content: string }> = [
			{ name: "non-vision large content", model: SUPER_MODEL, content: largeContent },
			{
				name: "vision small content",
				model: makeModel("tnx", "super", { input: ["text", "image"] }),
				content: smallContent,
			},
		];

		for (let index = 0; index < cases.length; index++) {
			const testCase = cases[index];
			const tool = new SuperReviewTool(makeSession({ model: testCase.model }));

			const result = await tool.execute(`tc-snapcompact-fallback-${index}`, {
				review_type: "qa_plan",
				question: `Should this ${testCase.name} stay textual?`,
				content: testCase.content,
			});

			expect(resultText(result)).toBe("Plain text review complete.");
			const [, context] = instrumentedCallAt(completeSpy, index);
			expect(imageBlocks(context)).toEqual([]);
			const text = textPayload(context);
			expect(text).toContain(`Should this ${testCase.name} stay textual?`);
			expect(text).toContain(testCase.content);
		}
	});

	it("accepts adversarial review type and sends adversarial instructions", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Probe the rollback path."));
		const tool = new SuperReviewTool(makeSession());

		const result = await tool.execute("tc-adversarial", {
			review_type: "adversarial",
			question: "Can this plan survive attack review?",
			content: "Plan: switch advisor tiers, then verify consult escalation.",
		});

		expect(resultText(result)).toBe("Probe the rollback path.");
		const [, context] = instrumentedCallAt(completeSpy, 0);
		const outbound = promptPayload(context);
		expect(outbound).toContain("adversarial");
		expect(outbound).toContain("Can this plan survive attack review?");
		expect(outbound).toContain("switch advisor tiers");
		expect(outbound).toContain("attack the submitted plan");
		expect(outbound).toContain("false assumptions");
	});

	it("keeps all documented review types accepted", async () => {
		const completeSpy = vi.spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(assistantWithText("accepted"));
		const tool = new SuperReviewTool(makeSession());
		const reviewTypes = [
			"plan",
			"critical_action",
			"qa_plan",
			"architecture",
			"security",
			"adversarial",
			"other",
		] as const;

		for (const reviewType of reviewTypes) {
			const result = await tool.execute(`tc-review-type-${reviewType}`, {
				review_type: reviewType,
				question: `Accept ${reviewType}?`,
			});
			expect(resultText(result)).toBe("accepted");
		}
		expect(completeSpy).toHaveBeenCalledTimes(reviewTypes.length);
	});

	it("rejects unknown review types before any model call", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("should not run"));
		const tool = new SuperReviewTool(makeSession());

		await expect(
			tool.execute("tc-review-type-invalid", {
				review_type: "tone_polish" as never,
				question: "Should invalid review types run?",
			}),
		).rejects.toThrow(/review_type|tone_polish|invalid/i);
		expect(completeSpy).not.toHaveBeenCalled();
	});

	it("keeps super_review text-only when legacy output_schema is present", async () => {
		const completeSpy = vi
			.spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValue(assistantWithText("Use the simpler rollback gate."));
		const tool = new SuperReviewTool(makeSession());

		const result = await tool.execute("tc-legacy-schema-text", {
			review_type: "qa_plan",
			question: "Should this rollback plan ship?",
			output_schema: {
				type: "object",
				properties: {
					verdict: { type: "string" },
					risk: { type: "string" },
				},
				required: ["verdict", "risk"],
			},
		});

		expect(resultText(result)).toBe("Use the simpler rollback gate.");
		const [, context, options] = instrumentedCallAt(completeSpy, 0);
		expect(context.tools ?? []).toEqual([]);
		expect(options.toolChoice).toBeUndefined();
	});
});
