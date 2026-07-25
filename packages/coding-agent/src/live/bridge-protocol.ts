import type { LivePhase } from "./visualizer";

/** Wire protocol version of the SSH live bridge; bumped on any frame-shape change. */
export const LIVE_BRIDGE_PROTO = 1;

/** Frames sent by the media/CLI side of the SSH bridge to the remote agent host. */
export type LiveBridgeClientFrame =
	| { t: "hello"; proto: number; sessionId?: string }
	| { t: "delegate"; id: string; text: string }
	| { t: "phase"; phase: LivePhase }
	| { t: "transcript"; role: "user" | "assistant"; turn: number; text: string; final: boolean }
	| { t: "auth-request" }
	| { t: "bye" };

/** Frames sent by the remote agent host back to the media/CLI side. */
export type LiveBridgeServerFrame =
	| {
			t: "welcome";
			proto: number;
			sessionId: string;
			cwd: string;
			username: string;
			firstName: string;
			title?: string;
	  }
	| { t: "context"; delegationId: string; text: string; kind?: "commentary" }
	| { t: "delegation-end"; delegationId: string }
	| { t: "auth-grant"; accessToken: string; accountId?: string; expiresAt: number }
	| { t: "error"; message: string };

/** Either direction's frame; used when encoding a line for the newline-delimited stream. */
export type LiveBridgeFrame = LiveBridgeClientFrame | LiveBridgeServerFrame;

type UnknownRecord = Record<string, unknown>;

/** Maximum in-flight (incomplete-line) buffer before the stream is treated as corrupt. */
const MAX_LINE_BYTES = 1_048_576;
/** Maximum non-JSON preamble text retained for surfacing in an error message. */
const MAX_PREAMBLE_BYTES = 8_192;

const LIVE_PHASE_SET: Record<LivePhase, true> = {
	connecting: true,
	listening: true,
	working: true,
	speaking: true,
	muted: true,
	error: true,
};

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLivePhase(value: unknown): value is LivePhase {
	return typeof value === "string" && Object.hasOwn(LIVE_PHASE_SET, value);
}

/** Encode a frame as a single compact JSON line terminated by a newline. */
export function encodeBridgeFrame(frame: LiveBridgeFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

/** True when `value` is a structurally valid client frame with a known discriminant. */
export function isLiveBridgeClientFrame(value: unknown): value is LiveBridgeClientFrame {
	if (!isRecord(value) || typeof value.t !== "string") return false;
	switch (value.t) {
		case "hello":
			return (
				typeof value.proto === "number" && (value.sessionId === undefined || typeof value.sessionId === "string")
			);
		case "delegate":
			return typeof value.id === "string" && typeof value.text === "string";
		case "phase":
			return isLivePhase(value.phase);
		case "transcript":
			return (
				(value.role === "user" || value.role === "assistant") &&
				typeof value.turn === "number" &&
				typeof value.text === "string" &&
				typeof value.final === "boolean"
			);
		case "auth-request":
		case "bye":
			return true;
		default:
			return false;
	}
}

/** True when `value` is a structurally valid server frame with a known discriminant. */
export function isLiveBridgeServerFrame(value: unknown): value is LiveBridgeServerFrame {
	if (!isRecord(value) || typeof value.t !== "string") return false;
	switch (value.t) {
		case "welcome":
			return (
				typeof value.proto === "number" &&
				typeof value.sessionId === "string" &&
				typeof value.cwd === "string" &&
				typeof value.username === "string" &&
				typeof value.firstName === "string" &&
				(value.title === undefined || typeof value.title === "string")
			);
		case "context":
			return (
				typeof value.delegationId === "string" &&
				typeof value.text === "string" &&
				(value.kind === undefined || value.kind === "commentary")
			);
		case "delegation-end":
			return typeof value.delegationId === "string";
		case "auth-grant":
			return (
				typeof value.accessToken === "string" &&
				(value.accountId === undefined || typeof value.accountId === "string") &&
				typeof value.expiresAt === "number"
			);
		case "error":
			return typeof value.message === "string";
		default:
			return false;
	}
}

/**
 * Streaming decoder for the newline-delimited bridge protocol.
 *
 * Tolerates the two failure modes that occur over an SSH pipe: frames split
 * across chunk boundaries (buffered until a newline arrives) and non-JSON
 * preamble such as shell rc echoes or an MOTD banner (skipped, and retained in
 * {@link preamble} so the caller can surface it). Parsed JSON values are handed
 * to the callback verbatim; the caller narrows them with the frame guards.
 */
export class BridgeFrameDecoder {
	readonly #onFrame: (frame: unknown) => void;
	readonly #textDecoder = new TextDecoder();
	#buffer = "";
	#preamble = "";

	constructor(onFrame: (frame: unknown) => void) {
		this.#onFrame = onFrame;
	}

	/** Non-JSON lines skipped so far (capped), for inclusion in an error message. */
	get preamble(): string {
		return this.#preamble;
	}

	/** Feed a chunk of stream bytes or text; complete frames are dispatched in order. */
	push(chunk: string | Uint8Array): void {
		this.#buffer += typeof chunk === "string" ? chunk : this.#textDecoder.decode(chunk, { stream: true });

		let newlineIndex = this.#buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			let line = this.#buffer.slice(0, newlineIndex);
			this.#buffer = this.#buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.#handleLine(line);
			newlineIndex = this.#buffer.indexOf("\n");
		}

		if (this.#buffer.length > MAX_LINE_BYTES) {
			this.#buffer = "";
			throw new Error(`bridge line buffer exceeded ${MAX_LINE_BYTES} bytes without a newline`);
		}
	}

	#handleLine(line: string): void {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.#retainPreamble(line);
			return;
		}
		this.#onFrame(parsed);
	}

	#retainPreamble(line: string): void {
		const remaining = MAX_PREAMBLE_BYTES - this.#preamble.length;
		if (remaining <= 0) return;
		const addition = this.#preamble.length === 0 ? line : `\n${line}`;
		this.#preamble += addition.length > remaining ? addition.slice(0, remaining) : addition;
	}
}
