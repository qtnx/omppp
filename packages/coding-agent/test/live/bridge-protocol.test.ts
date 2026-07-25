import { describe, expect, it } from "bun:test";
import {
	BridgeFrameDecoder,
	encodeBridgeFrame,
	isLiveBridgeClientFrame,
	isLiveBridgeServerFrame,
	LIVE_BRIDGE_PROTO,
	type LiveBridgeClientFrame,
	type LiveBridgeServerFrame,
} from "../../src/live/bridge-protocol";

function collect(): { frames: unknown[]; decoder: BridgeFrameDecoder } {
	const frames: unknown[] = [];
	const decoder = new BridgeFrameDecoder(frame => frames.push(frame));
	return { frames, decoder };
}

describe("bridge-protocol encode", () => {
	it("exposes protocol version 1", () => {
		expect(LIVE_BRIDGE_PROTO).toBe(1);
	});

	it("encodes a frame as compact JSON followed by a single newline", () => {
		const line = encodeBridgeFrame({ t: "delegate", id: "d1", text: "hi" });
		expect(line).toBe('{"t":"delegate","id":"d1","text":"hi"}\n');
		expect(line.endsWith("\n")).toBe(true);
		expect(line).not.toContain("\n{");
	});

	it("round-trips every encoded frame back through the decoder", () => {
		const { frames, decoder } = collect();
		decoder.push(encodeBridgeFrame({ t: "hello", proto: LIVE_BRIDGE_PROTO, sessionId: "s1" }));
		decoder.push(
			encodeBridgeFrame({ t: "welcome", proto: 1, sessionId: "s1", cwd: "/w", username: "u", firstName: "F" }),
		);
		expect(frames).toEqual([
			{ t: "hello", proto: 1, sessionId: "s1" },
			{ t: "welcome", proto: 1, sessionId: "s1", cwd: "/w", username: "u", firstName: "F" },
		]);
	});
});

describe("BridgeFrameDecoder streaming", () => {
	it("reassembles a frame split across three push calls", () => {
		const { frames, decoder } = collect();
		const line = encodeBridgeFrame({ t: "transcript", role: "user", turn: 2, text: "hello there", final: true });
		const a = line.slice(0, 5);
		const b = line.slice(5, 20);
		const c = line.slice(20);
		decoder.push(a);
		expect(frames).toHaveLength(0);
		decoder.push(b);
		expect(frames).toHaveLength(0);
		decoder.push(c);
		expect(frames).toEqual([{ t: "transcript", role: "user", turn: 2, text: "hello there", final: true }]);
	});

	it("emits both frames when two arrive in one chunk", () => {
		const { frames, decoder } = collect();
		decoder.push(`${encodeBridgeFrame({ t: "auth-request" })}${encodeBridgeFrame({ t: "bye" })}`);
		expect(frames).toEqual([{ t: "auth-request" }, { t: "bye" }]);
	});

	it("ignores blank lines between frames", () => {
		const { frames, decoder } = collect();
		decoder.push(`\n\n${encodeBridgeFrame({ t: "bye" })}\n   \n`);
		expect(frames).toEqual([{ t: "bye" }]);
	});

	it("skips a non-JSON MOTD banner, yields the frame, and retains the banner as preamble", () => {
		const { frames, decoder } = collect();
		decoder.push("Welcome to remote-host\nLast login: Sat Jul 25\n");
		decoder.push(encodeBridgeFrame({ t: "delegation-end", delegationId: "d9" }));
		expect(frames).toEqual([{ t: "delegation-end", delegationId: "d9" }]);
		expect(decoder.preamble).toBe("Welcome to remote-host\nLast login: Sat Jul 25");
	});

	it("parses CRLF-terminated lines", () => {
		const { frames, decoder } = collect();
		decoder.push(`${JSON.stringify({ t: "bye" })}\r\n${JSON.stringify({ t: "auth-request" })}\r\n`);
		expect(frames).toEqual([{ t: "bye" }, { t: "auth-request" }]);
	});

	it("decodes Uint8Array chunks including a multibyte char split across chunks", () => {
		const { frames, decoder } = collect();
		const bytes = new TextEncoder().encode(encodeBridgeFrame({ t: "context", delegationId: "d1", text: "café" }));
		const split = 3;
		decoder.push(bytes.slice(0, split));
		decoder.push(bytes.slice(split));
		expect(frames).toEqual([{ t: "context", delegationId: "d1", text: "café" }]);
	});

	it("throws once the in-flight line buffer exceeds 1 MB without a newline", () => {
		const { decoder } = collect();
		expect(() => decoder.push("x".repeat(1_048_577))).toThrow(/line buffer exceeded/);
	});
});

describe("frame guards", () => {
	it("accepts every valid client frame variant", () => {
		const valid: LiveBridgeClientFrame[] = [
			{ t: "hello", proto: 1 },
			{ t: "hello", proto: 1, sessionId: "s" },
			{ t: "delegate", id: "d", text: "t" },
			{ t: "phase", phase: "listening" },
			{ t: "transcript", role: "assistant", turn: 0, text: "", final: false },
			{ t: "auth-request" },
			{ t: "bye" },
		];
		for (const frame of valid) expect(isLiveBridgeClientFrame(frame)).toBe(true);
	});

	it("accepts every valid server frame variant", () => {
		const valid: LiveBridgeServerFrame[] = [
			{ t: "welcome", proto: 1, sessionId: "s", cwd: "/w", username: "u", firstName: "F" },
			{ t: "welcome", proto: 1, sessionId: "s", cwd: "/w", username: "u", firstName: "F", title: "T" },
			{ t: "context", delegationId: "d", text: "t" },
			{ t: "context", delegationId: "d", text: "t", kind: "commentary" },
			{ t: "delegation-end", delegationId: "d" },
			{ t: "auth-grant", accessToken: "a", expiresAt: 1 },
			{ t: "auth-grant", accessToken: "a", accountId: "acc", expiresAt: 1 },
			{ t: "error", message: "boom" },
		];
		for (const frame of valid) expect(isLiveBridgeServerFrame(frame)).toBe(true);
	});

	it("rejects valid JSON that is not a known frame", () => {
		const notFrames: unknown[] = [
			{ t: "unknown-kind", foo: 1 },
			{ t: "phase", phase: "dancing" },
			{ t: "transcript", role: "user", turn: "2", text: "x", final: true },
			{ t: "delegate", id: "d" },
			{ t: "hello", proto: "1" },
			{ foo: "bar" },
			42,
			"just a string",
			null,
			[{ t: "bye" }],
		];
		for (const value of notFrames) {
			expect(isLiveBridgeClientFrame(value)).toBe(false);
			expect(isLiveBridgeServerFrame(value)).toBe(false);
		}
	});

	it("keeps the client and server discriminants disjoint", () => {
		expect(isLiveBridgeServerFrame({ t: "bye" })).toBe(false);
		expect(isLiveBridgeClientFrame({ t: "error", message: "x" })).toBe(false);
	});
});
