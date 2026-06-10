import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	STREAMING_REVEAL_FRAME_MS,
	StreamingRevealController,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";

function makeUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
}

function textAt(message: AssistantMessage, index: number): string {
	const block = message.content[index];
	if (block?.type !== "text") {
		throw new Error(`Expected text block at index ${index}`);
	}
	return block.text;
}

class RecordingComponent {
	messages: AssistantMessage[] = [];

	updateContent(message: AssistantMessage): void {
		this.messages.push(message);
	}
}

function makeController(options: { smooth?: boolean; hideThinking?: boolean; requestRender?: () => void } = {}) {
	const component = new RecordingComponent();
	const controller = new StreamingRevealController({
		getSmoothStreaming: () => options.smooth ?? true,
		getHideThinkingBlock: () => options.hideThinking ?? false,
		requestRender: options.requestRender ?? (() => {}),
	});
	return { component, controller };
}

describe("streaming reveal deferred target updates", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("defers smooth setTarget rebuilds while the reveal timer is animating", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ requestRender });

		controller.begin(component, makeMessage([{ type: "text", text: "abc" }]));
		const postBeginUpdates = component.messages.length;

		controller.setTarget(makeMessage([{ type: "text", text: "abcdef" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghijkl" }]));

		expect(component.messages).toHaveLength(postBeginUpdates);
		expect(requestRender).not.toHaveBeenCalled();

		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);

		expect(component.messages).toHaveLength(postBeginUpdates + 1);
		expect(textAt(component.messages.at(-1)!, 0)).toBe("abc");
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	test("reveals the full target text after enough throttled ticks", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const targetText = "abcdefghijkl";

		controller.begin(component, makeMessage([{ type: "text", text: "abc" }]));
		controller.setTarget(makeMessage([{ type: "text", text: targetText }]));
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(textAt(component.messages.at(-1)!, 0)).toBe(targetText);
	});

	test("passes unsliced messages through synchronously when smoothing is disabled", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ smooth: false, requestRender });
		const first = makeMessage([{ type: "text", text: "chunk" }]);
		const second = makeMessage([{ type: "text", text: "chunky" }]);

		controller.begin(component, first);
		controller.setTarget(second);
		const updates = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(component.messages[0]).toBe(first);
		expect(component.messages[1]).toBe(second);
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).not.toHaveBeenCalled();
	});

	test("renders fully revealed tool-call boundaries synchronously on begin and setTarget", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const beginMessage = makeMessage([
			{ type: "text", text: "before tool" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		]);
		const beginCase = makeController({ requestRender });

		beginCase.controller.begin(beginCase.component, beginMessage);

		expect(beginCase.component.messages).toHaveLength(1);
		expect(textAt(beginCase.component.messages[0], 0)).toBe("before tool");

		const setTargetCase = makeController({ requestRender });
		const toolTarget = makeMessage([
			{ type: "text", text: "snap now" },
			{ type: "toolCall", id: "call-2", name: "write", arguments: { path: "out.txt" } },
		]);
		setTargetCase.controller.begin(setTargetCase.component, makeMessage([{ type: "text", text: "" }]));
		const beforeToolUpdates = setTargetCase.component.messages.length;

		setTargetCase.controller.setTarget(toolTarget);
		const afterToolUpdates = setTargetCase.component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);

		expect(afterToolUpdates).toBe(beforeToolUpdates + 1);
		expect(textAt(setTargetCase.component.messages.at(-1)!, 0)).toBe("snap now");
		expect(setTargetCase.component.messages).toHaveLength(afterToolUpdates);
		expect(requestRender).not.toHaveBeenCalled();
	});
});
