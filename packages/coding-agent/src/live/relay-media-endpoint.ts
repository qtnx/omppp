import { logger } from "@oh-my-pi/pi-utils";
import type { LiveMediaEndpoint } from "./endpoints";

/** How long the host waits for the browser to send its SDP offer. */
export const RELAY_OFFER_TIMEOUT_MS = 30_000;
/** How long the host waits for the browser to confirm its peer connected. */
export const RELAY_OPEN_TIMEOUT_MS = 30_000;

/** Frames the endpoint pushes toward the browser; the collab host serializes them. */
export interface RelayMediaSink {
	/** Deliver the Codex SDP answer, or an error explaining why the call failed. */
	sendAnswer(reqId: number, result: { sdp: string } | { error: string }): void;
	/** Ask the browser to mute or unmute its microphone track. */
	sendMute(muted: boolean): void;
	/** Tell the browser the call is over. */
	sendEnded(reason?: string): void;
}

/**
 * Media plane backed by a browser peer reached over the collab relay.
 *
 * The browser owns the microphone, the speaker, and the `RTCPeerConnection`; this
 * host keeps the Codex credential, the signaling call, and the sideband. Only the
 * SDP handshake and a level meter cross the relay — never audio.
 */
export class RelayMediaEndpoint implements LiveMediaEndpoint {
	readonly #sink: RelayMediaSink;
	#offer = Promise.withResolvers<string>();
	#opened = Promise.withResolvers<void>();
	#offerReqId: number | undefined;
	#outputLevelHandler: ((level: number) => void) | undefined;
	#failureHandler: ((message: string) => void) | undefined;
	#closed = false;
	#answered = false;

	constructor(sink: RelayMediaSink) {
		this.#sink = sink;
		// Nothing awaits these until start(); pre-attach no-op catches so an early
		// failure never surfaces as an unhandled rejection.
		this.#offer.promise.catch(() => {});
		this.#opened.promise.catch(() => {});
	}

	/** Whether a browser has already claimed this endpoint. */
	get claimed(): boolean {
		return this.#offerReqId !== undefined;
	}

	/** Feed the browser's SDP offer; the first one wins. */
	submitOffer(reqId: number, sdp: string): void {
		if (this.#closed || this.#offerReqId !== undefined) return;
		this.#offerReqId = reqId;
		this.#offer.resolve(sdp);
	}

	/** The browser reported its peer connection is live. */
	markConnected(): void {
		this.#opened.resolve();
	}

	/** Feed the browser's throttled assistant output level. */
	submitLevel(level: number): void {
		if (this.#closed || !Number.isFinite(level)) return;
		this.#outputLevelHandler?.(Math.min(1, Math.max(0, level)));
	}

	/** The browser or the relay reported a fatal media failure. */
	reportFailure(message: string): void {
		if (this.#closed) return;
		this.#rejectPending(message);
		this.#failureHandler?.(message);
	}

	onOutputLevel(handler: (level: number) => void): void {
		this.#outputLevelHandler = handler;
	}

	onFailure(handler: (message: string) => void): void {
		this.#failureHandler = handler;
	}

	async createOffer(): Promise<string> {
		return await this.#withTimeout(
			this.#offer.promise,
			RELAY_OFFER_TIMEOUT_MS,
			"The browser did not start a live call in time.",
		);
	}

	async acceptAnswer(sdp: string): Promise<void> {
		const reqId = this.#offerReqId;
		if (reqId === undefined) throw new Error("No browser offer is pending.");
		this.#answered = true;
		this.#sink.sendAnswer(reqId, { sdp });
	}

	async waitForOpen(timeoutMs = RELAY_OPEN_TIMEOUT_MS): Promise<void> {
		await this.#withTimeout(this.#opened.promise, timeoutMs, "The browser peer never connected.");
	}

	async setMuted(muted: boolean): Promise<void> {
		if (this.#closed) return;
		this.#sink.sendMute(muted);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectPending("The live call ended.");
		this.#sink.sendEnded();
	}

	/**
	 * Report a signaling failure to the browser before tearing down, so the UI can
	 * explain why the call never started instead of silently going idle.
	 */
	failSignaling(message: string): void {
		const reqId = this.#offerReqId;
		if (reqId !== undefined && !this.#answered) this.#sink.sendAnswer(reqId, { error: message });
		this.reportFailure(message);
	}

	#rejectPending(message: string): void {
		this.#offer.reject(new Error(message));
		this.#opened.reject(new Error(message));
	}

	async #withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(() => timeout.reject(new Error(message)), timeoutMs);
		timer.unref?.();
		try {
			return await Promise.race([promise, timeout.promise]);
		} finally {
			clearTimeout(timer);
			timeout.promise.catch(() => {});
			logger.debug("Relay media wait settled");
		}
	}
}
