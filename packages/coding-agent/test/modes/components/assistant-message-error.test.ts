import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const originalImageProtocol = TERMINAL.imageProtocol;

const RENDER_WIDTH = 120;

function erroredMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function renderLines(message: AssistantMessage, hideThinkingBlock = false): string[] {
	const component = new AssistantMessageComponent(message, hideThinkingBlock);
	return Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
		.split("\n")
		.map(line => line.trimEnd());
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	setTerminalImageProtocol(null);
});

afterEach(() => {
	vi.useRealTimers();
	setSystemTime();
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
});

describe("AssistantMessageComponent error rendering", () => {
	// A proxy 502 returns its own HTML page as the body; AnthropicApiError folds
	// that whole document into `errorMessage`. The inline transcript render must
	// not faithfully reprint every line, or the scrollback fills with the HTML
	// page's blank lines (the reported "weird terminal state").
	const longLine = "x".repeat(300);
	const body = Array.from({ length: 25 }, (_, i) => `marker-${i} <div>content</div>`).join("\n\n");
	const proxy502 = `${longLine}\n\n${body}`;

	it("drops the blank-line flood from a multi-line HTML error body", () => {
		const lines = renderLines(erroredMessage(proxy502));
		// The body interleaves 25 markers with blank lines (~50 source lines). If
		// blanks leaked through, the rendered block would be dozens of lines tall.
		const blankRun = lines.reduce(
			(acc, line) => {
				const run = line === "" ? acc.run + 1 : 0;
				return { run, max: Math.max(acc.max, run) };
			},
			{ run: 0, max: 0 },
		);
		expect(blankRun.max).toBeLessThanOrEqual(1);
		expect(lines.length).toBeLessThan(15);
	});

	it("clamps the line count of a runaway error body", () => {
		const lines = renderLines(erroredMessage(proxy502));
		const markerLines = lines.filter(line => line.includes("marker-"));
		// MAX_TRANSCRIPT_ERROR_LINES is 8; the first preview line is the long line,
		// so at most 7 markers survive — and the late ones are gone entirely.
		expect(markerLines.length).toBeLessThanOrEqual(8);
		expect(lines.some(line => line.includes("marker-0"))).toBe(true);
		expect(lines.some(line => line.includes("marker-24"))).toBe(false);
	});

	it("width-truncates an overlong error line", () => {
		const lines = renderLines(erroredMessage(proxy502));
		const head = lines.find(line => line.trim().startsWith("Error:"));
		expect(head).toBeDefined();
		// 300 'x' chars must not survive the render width; the line is truncated
		// with an ellipsis well under the 120-col terminal width.
		expect(head?.includes("…")).toBe(true);
		expect(head?.length).toBeLessThan(RENDER_WIDTH);
	});

	it("renders a short single-line error unchanged", () => {
		const lines = renderLines(erroredMessage("overloaded_error: Overloaded"));
		expect(lines.some(line => line.includes("Error: overloaded_error: Overloaded"))).toBe(true);
	});
});

describe("AssistantMessageComponent hidden thinking rendering", () => {
	function thinkingMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Visible answer" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("omits hidden thinking instead of rendering a placeholder", () => {
		const lines = renderLines(thinkingMessage(), true);
		expect(lines.some(line => line.includes("Thinking..."))).toBe(false);
		expect(lines.some(line => line.includes("private reasoning"))).toBe(false);
		expect(lines.some(line => line.includes("Visible answer"))).toBe(true);
	});

	it("still renders thinking when it is not hidden", () => {
		const lines = renderLines(thinkingMessage());
		expect(lines.some(line => line.includes("private reasoning"))).toBe(true);
	});
});

describe("AssistantMessageComponent streaming thinking pulse", () => {
	// The in-flight streaming partial always carries stopReason "stop" (proxy.ts
	// seeds it), so "still streaming" is keyed off the block not yet being
	// finalized — a live component is constructed with no message.
	function streaming(content: AssistantMessage["content"], output = 0): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function liveComponent(message: AssistantMessage, hideThinkingBlock = true): AssistantMessageComponent {
		const component = new AssistantMessageComponent(undefined, hideThinkingBlock);
		component.updateContent(message);
		return component;
	}

	function liveLines(message: AssistantMessage, hideThinkingBlock = true): string[] {
		const component = liveComponent(message, hideThinkingBlock);
		const lines = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
			.split("\n")
			.map(line => line.trimEnd());
		component.dispose();
		return lines;
	}

	function timerCount(): number {
		return (vi as typeof vi & { getTimerCount: () => number }).getTimerCount();
	}

	// First frame of the expanding/shrinking ✻ pulse; deterministic right after updateContent.
	const PULSE = "✻";

	it("shows a timed pulse for an in-flight omitted-display thinking block", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(12_000));
		const component = liveComponent(streaming([{ type: "thinking", thinking: "" }]), false);

		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).toMatch(/thinking… \d+s/);
		expect(timerCount()).toBe(1);
		component.dispose();
	});

	it("does not show the pulse when non-empty thinking is visible", () => {
		vi.useFakeTimers();
		const component = liveComponent(streaming([{ type: "thinking", thinking: "private reasoning" }]), false);

		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).not.toMatch(/thinking… \d+s/);
		expect(plain).toContain("private reasoning");
		expect(timerCount()).toBe(0);
		component.dispose();
	});

	it("shows a timed pulse in place of hidden reasoning while thinking streams", () => {
		vi.useFakeTimers();
		const component = liveComponent(streaming([{ type: "thinking", thinking: "private reasoning" }]));

		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).toContain(PULSE);
		expect(plain).toMatch(/thinking… \d+s/);
		expect(plain).not.toContain("private reasoning");
		expect(timerCount()).toBe(1);
		component.dispose();
	});

	it("does not show a pulse or timer for a born-finalized omitted-display thinking block", () => {
		vi.useFakeTimers();
		const component = new AssistantMessageComponent(streaming([{ type: "thinking", thinking: "" }]), false);

		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).not.toMatch(/thinking… \d+s/);
		expect(plain).not.toMatch(/thought for \d+s/);
		expect(timerCount()).toBe(0);
		component.dispose();
	});

	it("leaves a static thought-duration marker and clears the timer when a tracked phase finalizes", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const component = liveComponent(streaming([{ type: "thinking", thinking: "" }]), false);
		expect(timerCount()).toBe(1);

		setSystemTime(new Date(13_400));
		component.markTranscriptBlockFinalized();
		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).toMatch(/thought for 12s/);
		expect(plain).not.toMatch(/thinking… \d+s/);
		expect(timerCount()).toBe(0);
		component.dispose();
	});

	it("leaves the static marker when hidden thinking hands off to a tool before finalizing", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const component = liveComponent(streaming([{ type: "thinking", thinking: "" }]), false);
		expect(timerCount()).toBe(1);

		component.updateContent(
			streaming([
				{ type: "thinking", thinking: "" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
			]),
		);
		expect(timerCount()).toBe(0);
		expect(Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))).not.toMatch(/thinking… \d+s/);

		setSystemTime(new Date(13_400));
		component.markTranscriptBlockFinalized();
		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).toMatch(/thought for 12s/);
		expect(plain).not.toMatch(/thinking… \d+s/);
		expect(timerCount()).toBe(0);
		component.dispose();
	});

	it("keeps the first finalize's duration when finalize fires again at message_end", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const component = liveComponent(streaming([{ type: "thinking", thinking: "" }]), false);

		// Real tool-call path: event-controller finalizes once when the first
		// toolCall appears mid-stream (thinking phase ends here)...
		setSystemTime(new Date(6_000));
		component.markTranscriptBlockFinalized();
		expect(Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))).toMatch(/thought for 5s/);

		// ...and again at message_end after the tool ran for 30s. The marker must
		// not absorb tool execution time.
		setSystemTime(new Date(36_000));
		component.markTranscriptBlockFinalized();
		const plain = Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		expect(plain).toMatch(/thought for 5s/);
		expect(plain).not.toMatch(/thought for 35s/);
		component.dispose();
	});

	it("drops the pulse once visible text starts streaming", () => {
		const lines = liveLines(
			streaming([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Visible answer" },
			]),
		);
		expect(lines.some(line => line.includes(PULSE))).toBe(false);
		expect(lines.some(line => line.includes("Visible answer"))).toBe(true);
	});

	it("does not show the pulse once a tool call streams", () => {
		const lines = liveLines(
			streaming([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
			]),
		);
		expect(lines.some(line => line.includes(PULSE))).toBe(false);
	});

	it("keeps the pulse across thinking deltas on a reused component, then yields to text", () => {
		// Mirrors live streaming: one component reused across updateContent calls
		// (the fast path early-returns on a stable shape, so the placeholder must
		// persist) until visible text arrives and replaces it.
		const component = new AssistantMessageComponent(undefined, true);
		const rendered = () => Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"));
		component.updateContent(streaming([{ type: "thinking", thinking: "a" }]));
		expect(rendered()).toMatch(/thinking… \d+s/);
		component.updateContent(streaming([{ type: "thinking", thinking: "ab" }]));
		expect(rendered()).toMatch(/thinking… \d+s/);
		component.updateContent(
			streaming([
				{ type: "thinking", thinking: "abc" },
				{ type: "text", text: "Answer" },
			]),
		);
		expect(rendered().includes(PULSE)).toBe(false);
		expect(rendered().includes("Answer")).toBe(true);
		component.dispose();
	});
});
