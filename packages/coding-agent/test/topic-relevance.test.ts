import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { assessTopicRelevance } from "../src/utils/topic-relevance";

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

function createRegistry(model: Model<Api> | undefined, apiKey: string | undefined = "test-key") {
	return {
		getAvailable: () => (model ? [model] : []),
		getApiKey: async () => apiKey,
	} as never;
}

function toolCallResponse(related: boolean) {
	return {
		stopReason: "stop",
		content: [{ type: "toolCall", id: "call-relevance", name: "assess_relevance", arguments: { related } }],
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("assessTopicRelevance", () => {
	it("maps related:false to an 'unrelated' verdict and forces the assess tool", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const mock = vi.spyOn(ai, "completeSimple").mockResolvedValue(toolCallResponse(false));

		const verdict = await assessTopicRelevance(
			"Set up the billing webhook",
			"Title: refactor parser\nRecent requests:\n- fix the tokenizer",
			createRegistry(model),
			createSettings(model),
		);

		expect(verdict).toBe("unrelated");
		expect(mock.mock.calls[0]?.[1]).toMatchObject({
			tools: [expect.objectContaining({ name: "assess_relevance" })],
		});
		const options = mock.mock.calls[0]?.[2] as
			| { toolChoice?: unknown; disableReasoning?: boolean; signal?: AbortSignal }
			| undefined;
		expect(options).toMatchObject({
			disableReasoning: true,
			toolChoice: { type: "tool", name: "assess_relevance" },
		});
		// A hard timeout signal is always attached so a hung classifier can't stall a turn.
		expect(options?.signal).toBeInstanceOf(AbortSignal);
	});

	it("maps related:true to a 'related' verdict", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue(toolCallResponse(true));

		const verdict = await assessTopicRelevance(
			"keep going on the parser",
			"Title: refactor parser",
			createRegistry(model),
			createSettings(model),
		);

		expect(verdict).toBe("related");
	});

	it("fails open (null) when the model omits the assess_relevance tool call", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "I think they are related" }],
		} as never);

		const verdict = await assessTopicRelevance("anything", "digest", createRegistry(model), createSettings(model));

		expect(verdict).toBeNull();
	});

	it("fails open (null) when the classifier errors", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "boom",
			content: [],
		} as never);

		const verdict = await assessTopicRelevance("anything", "digest", createRegistry(model), createSettings(model));

		expect(verdict).toBeNull();
	});

	it("fails open (null) without invoking the model when none is available", async () => {
		const mock = vi.spyOn(ai, "completeSimple");

		const verdict = await assessTopicRelevance(
			"anything",
			"digest",
			createRegistry(undefined),
			createSettings(getModelOrThrow("claude-sonnet-4-5")),
		);

		expect(verdict).toBeNull();
		expect(mock).not.toHaveBeenCalled();
	});

	it("fails open (null) without invoking the model when no API key resolves", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const mock = vi.spyOn(ai, "completeSimple");

		const noKeyRegistry = { getAvailable: () => [model], getApiKey: async () => undefined } as never;
		const verdict = await assessTopicRelevance("anything", "digest", noKeyRegistry, createSettings(model));

		expect(verdict).toBeNull();
		expect(mock).not.toHaveBeenCalled();
	});
});
