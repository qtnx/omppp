/**
 * `conversationAwaitsAssistant` decides whether a session resumed after a macOS
 * sandbox relaunch should auto-continue the model's interrupted turn. The
 * load-bearing contract: the model owes a response iff the LLM-visible tail
 * (user/assistant/toolResult) is NOT an assistant message. A `sandbox` tool
 * relaunch interrupts the turn right after the tool result, so the resumed
 * conversation ends in `toolResult` → must continue. A `/add-dir` issued between
 * turns leaves a completed assistant tail → must NOT continue.
 */
import { describe, expect, it } from "bun:test";
import { conversationAwaitsAssistant } from "../src/session/agent-session";

// The helper reads only `.role`; build role-only messages and cast to its param.
type Msgs = Parameters<typeof conversationAwaitsAssistant>[0];
const conv = (...roles: string[]): Msgs => roles.map(role => ({ role })) as unknown as Msgs;

describe("conversationAwaitsAssistant", () => {
	it("empty conversation does not await an assistant turn", () => {
		expect(conversationAwaitsAssistant(conv())).toBe(false);
	});

	it("a completed turn (assistant tail) does not await", () => {
		expect(conversationAwaitsAssistant(conv("user", "assistant"))).toBe(false);
	});

	it("interrupted right after a tool result (the sandbox mid-turn case) awaits", () => {
		expect(conversationAwaitsAssistant(conv("user", "assistant", "toolResult"))).toBe(true);
	});

	it("tool result already answered by the assistant does not await", () => {
		expect(conversationAwaitsAssistant(conv("user", "assistant", "toolResult", "assistant"))).toBe(false);
	});

	it("a bare unanswered user message awaits", () => {
		expect(conversationAwaitsAssistant(conv("user"))).toBe(true);
	});

	it("skips trailing non-turn roles and still sees a completed assistant tail", () => {
		// developer/custom messages are filtered out of the LLM request, so a
		// trailing one after an assistant turn must NOT trigger a continuation.
		expect(conversationAwaitsAssistant(conv("user", "assistant", "developer"))).toBe(false);
		expect(conversationAwaitsAssistant(conv("user", "assistant", "custom"))).toBe(false);
	});

	it("skips trailing non-turn roles and still sees an unanswered tool result", () => {
		expect(conversationAwaitsAssistant(conv("user", "assistant", "toolResult", "developer"))).toBe(true);
		expect(conversationAwaitsAssistant(conv("user", "assistant", "toolResult", "custom", "developer"))).toBe(true);
	});
});
