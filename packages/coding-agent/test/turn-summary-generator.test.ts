import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { type Api, getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import { collectTurnSummaryContext, generateTurnSummary } from "../src/utils/turn-summary-generator";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as never;
}

function asMessages(messages: unknown[]): readonly AgentMessage[] {
	return messages as readonly AgentMessage[];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("collectTurnSummaryContext", () => {
	it("distills the latest turn into request, final reply, and deduped tool names", () => {
		const ctx = collectTurnSummaryContext(
			asMessages([
				{ role: "user", content: "An older, unrelated request" },
				{ role: "assistant", content: [{ type: "text", text: "old answer" }], stopReason: "stop" },
				{ role: "user", content: "Fix the auth bug" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Looking into it" },
						{ type: "toolCall", id: "1", name: "read", arguments: {} },
						{ type: "toolCall", id: "2", name: "edit", arguments: {} },
					],
					stopReason: "toolUse",
				},
				{ role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "…" }] },
				{ role: "toolResult", toolCallId: "2", toolName: "edit", content: [{ type: "text", text: "ok" }] },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "3", name: "edit", arguments: {} },
						{ type: "text", text: "Fixed token rotation and added tests" },
					],
					stopReason: "stop",
				},
			]),
		);

		expect(ctx).toBeDefined();
		// Turn boundary is the LAST user prompt — the earlier turn is excluded.
		expect(ctx?.request).toBe("Fix the auth bug");
		// Response is the latest non-empty assistant text in the turn.
		expect(ctx?.response).toBe("Fixed token rotation and added tests");
		// Tools are deduped and kept in first-use order across the whole turn.
		expect(ctx?.tools).toEqual(["read", "edit"]);
	});

	it("returns undefined for a pure conversational turn that used no tools", () => {
		const ctx = collectTurnSummaryContext(
			asMessages([
				{ role: "user", content: "What does this function do?" },
				{ role: "assistant", content: [{ type: "text", text: "It validates input." }], stopReason: "stop" },
			]),
		);
		expect(ctx).toBeUndefined();
	});

	it("caps the number of distinct tool names", () => {
		const blocks = Array.from({ length: 20 }, (_, i) => ({
			type: "toolCall",
			id: String(i),
			name: `tool${i}`,
			arguments: {},
		}));
		const ctx = collectTurnSummaryContext(
			asMessages([
				{ role: "user", content: "do many things" },
				{ role: "assistant", content: blocks, stopReason: "toolUse" },
			]),
		);
		expect(ctx?.tools.length).toBe(12);
	});

	it("returns undefined when there is no user message to anchor the turn", () => {
		const ctx = collectTurnSummaryContext(
			asMessages([
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "1", name: "edit", arguments: {} }],
					stopReason: "toolUse",
				},
			]),
		);
		expect(ctx).toBeUndefined();
	});
});

describe("generateTurnSummary", () => {
	const context = { request: "Fix the auth bug", response: "Fixed it", tools: ["edit", "bash"] } as const;

	it("returns the cleaned summary from a forced set_summary tool call", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-summary",
					name: "set_summary",
					arguments: { summary: '"Fixed OAuth token rotation."' },
				},
			],
		} as never);

		const summary = await generateTurnSummary(context, createRegistry(model), createSettings(model));

		// Wrapping quotes and trailing punctuation are stripped.
		expect(summary).toBe("Fixed OAuth token rotation");
		expect(spy.mock.calls[0]?.[1]).toMatchObject({
			tools: [expect.objectContaining({ name: "set_summary" })],
		});
		expect(spy.mock.calls[0]?.[2]).toMatchObject({
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_summary" },
		});
	});

	it("falls back to text content when no set_summary tool call is returned", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Investigated build failure, no changes made" }],
		} as never);

		const summary = await generateTurnSummary(context, createRegistry(model), createSettings(model));

		expect(summary).toBe("Investigated build failure, no changes made");
	});

	it("returns null when no summary model is available", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const registry = { getAvailable: () => [], getApiKey: async () => "k" } as never;

		const summary = await generateTurnSummary(context, registry, createSettings(model));

		expect(summary).toBeNull();
	});

	it("returns null when the model call ends in error", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			content: [],
			errorMessage: "boom",
		} as never);

		const summary = await generateTurnSummary(context, createRegistry(model), createSettings(model));

		expect(summary).toBeNull();
	});
});
