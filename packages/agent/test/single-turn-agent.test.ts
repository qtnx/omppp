import { describe, expect, it } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { runSingleTurnAgent } from "../src/single-turn";

describe("runSingleTurnAgent", () => {
	it("sends one user message with the supplied system prompt and returns the assistant message plus visible text", async () => {
		const systemPrompt = "You are a senior reviewer. Return one decisive review.";
		const prompt = "Review the attached patch, tests, risks, and verdict in one pass.";
		const mock = createMockModel({
			responses: [
				{
					content: ["Verdict: ", { type: "thinking", thinking: "internal deliberation" }, "ship it."],
					stopReason: "stop",
				},
			],
		});
		const streamContexts: Context[] = [];
		const streamFn: typeof mock.stream = (model, context, options) => {
			streamContexts.push(context);
			return mock.stream(model, context, options);
		};

		const result = await runSingleTurnAgent({
			model: mock.model,
			systemPrompt,
			prompt,
			streamFn,
		});

		expect(streamContexts).toHaveLength(1);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]?.context.systemPrompt).toEqual([systemPrompt]);
		expect(mock.calls[0]?.context.messages).toHaveLength(1);
		expect(mock.calls[0]?.context.messages[0]).toMatchObject({ role: "user", content: prompt });
		expect(result.message).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(result.message.content).toEqual([
			{ type: "text", text: "Verdict: " },
			{ type: "thinking", thinking: "internal deliberation" },
			{ type: "text", text: "ship it." },
		]);
		expect(result.text).toBe("Verdict: ship it.");
	});

	it("returns a tool-call response without making a second model request", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [
						"I need a file before finalizing.",
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
					],
					stopReason: "toolUse",
				},
				{ content: ["This response must never be requested."] },
			],
		});

		const result = await runSingleTurnAgent({
			model: mock.model,
			systemPrompt: "Review once. Do not execute tools.",
			prompt: "Give one review turn for this change.",
			streamFn: mock.stream,
		});

		expect(mock.calls).toHaveLength(1);
		expect(result.message).toMatchObject({ role: "assistant", stopReason: "toolUse" });
		expect(result.message.content).toEqual([
			{ type: "text", text: "I need a file before finalizing." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
		]);
		expect(result.text).toBe("I need a file before finalizing.");
	});

	it("rejects blank prompts and system prompts before calling the model", async () => {
		const cases = [
			{ name: "empty prompt", systemPrompt: "System instructions", prompt: "" },
			{ name: "whitespace prompt", systemPrompt: "System instructions", prompt: " \n\t " },
			{ name: "empty system prompt", systemPrompt: "", prompt: "Comprehensive request" },
			{ name: "whitespace system prompt", systemPrompt: " \n\t ", prompt: "Comprehensive request" },
		];

		for (const testCase of cases) {
			const mock = createMockModel({ responses: [{ content: ["model should not run"] }] });

			await expect(
				runSingleTurnAgent({
					model: mock.model,
					systemPrompt: testCase.systemPrompt,
					prompt: testCase.prompt,
					streamFn: mock.stream,
				}),
			).rejects.toThrow();
			expect(mock.calls, testCase.name).toHaveLength(0);
		}
	});
});
