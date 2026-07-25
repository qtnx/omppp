import { logger } from "@oh-my-pi/pi-utils";
import {
	BridgeFrameDecoder,
	encodeBridgeFrame,
	isLiveBridgeServerFrame,
	LIVE_BRIDGE_PROTO,
	type LiveBridgeClientFrame,
	type LiveBridgeServerFrame,
} from "./bridge-protocol";
import type { LiveAgentEndpoint, LiveAgentIdentity } from "./endpoints";
import type { LivePhase } from "./visualizer";

/** Byte sink for the client → host direction of the bridge (the ssh child's stdin). */
export interface BridgeWriter {
	write(text: string): unknown;
	end?(): unknown;
}

/** How long the client waits for `welcome` before giving up on the remote helper. */
export const BRIDGE_WELCOME_TIMEOUT_MS = 10_000;

/** Identity plus session metadata the host reports when the bridge comes up. */
export interface BridgeWelcome extends LiveAgentIdentity {
	title?: string;
}

/** Credential the host forwarded because the client had none of its own. */
export interface BridgeCredential {
	accessToken: string;
	accountId?: string;
	expiresAt: number;
}

export interface BridgeAgentEndpointOptions {
	/** Writer for frames headed to the remote host. */
	writer: BridgeWriter;
	/** Fired once the host answers `hello`. */
	onWelcome?: (welcome: BridgeWelcome) => void;
	/** Fired when the host forwards a credential in response to `requestCredential()`. */
	onCredential?: (credential: BridgeCredential) => void;
	/** Fired on a host-reported error; the live session treats it as terminal. */
	onError?: (message: string) => void;
}

/**
 * Client half of the SSH live bridge: a {@link LiveAgentEndpoint} whose delegations
 * run on a remote host instead of an in-process `AgentSession`.
 *
 * The media plane stays local, so only text crosses the wire. Everything the host
 * streams back — commentary and the final answer — arrives as `context` frames and
 * is handed to the controller unchanged, exactly as `LocalAgentEndpoint` would.
 */
export class BridgeAgentEndpoint implements LiveAgentEndpoint {
	readonly #writer: BridgeWriter;
	readonly #options: BridgeAgentEndpointOptions;
	readonly #decoder: BridgeFrameDecoder;
	#contextHandler: ((delegationId: string, text: string, kind?: "commentary") => void) | undefined;
	#endHandler: ((delegationId: string) => void) | undefined;
	#welcome: BridgeWelcome | undefined;
	#welcomeResolvers = Promise.withResolvers<BridgeWelcome>();
	#welcomeTimer: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(options: BridgeAgentEndpointOptions) {
		this.#options = options;
		this.#writer = options.writer;
		this.#decoder = new BridgeFrameDecoder(frame => this.#handleFrame(frame));
	}

	/** Metadata reported by the host, available after {@link waitForWelcome}. */
	get welcome(): BridgeWelcome | undefined {
		return this.#welcome;
	}

	/** Non-frame output the remote shell printed before the first frame (banners, MOTD). */
	get preamble(): string {
		return this.#decoder.preamble;
	}

	/** Feed bytes read from the remote helper's stdout. */
	push(chunk: string | Uint8Array): void {
		if (this.#closed) return;
		try {
			this.#decoder.push(chunk);
		} catch (cause) {
			this.#fail(cause instanceof Error ? cause.message : String(cause));
		}
	}

	/** Send `hello` and resolve once the host answers, or reject on timeout. */
	async waitForWelcome(timeoutMs = BRIDGE_WELCOME_TIMEOUT_MS): Promise<BridgeWelcome> {
		if (this.#welcome) return this.#welcome;
		this.#send({ t: "hello", proto: LIVE_BRIDGE_PROTO });
		this.#welcomeTimer ??= setTimeout(() => {
			const banner = this.#decoder.preamble.trim();
			const detail = banner ? ` The remote printed:\n${banner}` : "";
			this.#welcomeResolvers.reject(
				new Error(`The remote host did not answer the live bridge within ${timeoutMs}ms.${detail}`),
			);
		}, timeoutMs);
		this.#welcomeTimer.unref?.();
		return await this.#welcomeResolvers.promise;
	}

	/** Ask the host to forward a Codex credential; answered through `onCredential` or `onError`. */
	requestCredential(): void {
		this.#send({ t: "auth-request" });
	}

	/** Mirror the local call phase so the host can show it beside the session. */
	reportPhase(phase: LivePhase): void {
		this.#send({ t: "phase", phase });
	}

	/** Mirror a conversational transcript line to the host's display. */
	reportTranscript(role: "user" | "assistant", turn: number, text: string, final: boolean): void {
		this.#send({ t: "transcript", role, turn, text, final });
	}

	onContext(handler: (delegationId: string, text: string, kind?: "commentary") => void): void {
		this.#contextHandler = handler;
	}

	onDelegationEnd(handler: (delegationId: string) => void): void {
		this.#endHandler = handler;
	}

	startDelegation(id: string, request: string): void {
		this.#send({ t: "delegate", id, text: request });
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#welcomeTimer) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = undefined;
		}
		this.#send({ t: "bye" });
		try {
			this.#writer.end?.();
		} catch {
			// The pipe may already be gone.
		}
	}

	/** Report that the transport itself died, failing any pending welcome. */
	fail(message: string): void {
		this.#fail(message);
	}

	#handleFrame(frame: unknown): void {
		if (!isLiveBridgeServerFrame(frame)) {
			logger.debug("Live bridge ignored an unknown host frame");
			return;
		}
		this.#dispatch(frame);
	}

	#dispatch(frame: LiveBridgeServerFrame): void {
		switch (frame.t) {
			case "welcome": {
				if (frame.proto !== LIVE_BRIDGE_PROTO) {
					this.#fail(
						`Live bridge version mismatch: client speaks v${LIVE_BRIDGE_PROTO}, host speaks v${frame.proto}. Update the older side.`,
					);
					return;
				}
				const welcome: BridgeWelcome = {
					sessionId: frame.sessionId,
					username: frame.username,
					firstName: frame.firstName,
					cwd: frame.cwd,
					title: frame.title,
				};
				this.#welcome = welcome;
				if (this.#welcomeTimer) {
					clearTimeout(this.#welcomeTimer);
					this.#welcomeTimer = undefined;
				}
				this.#welcomeResolvers.resolve(welcome);
				this.#options.onWelcome?.(welcome);
				return;
			}
			case "context":
				this.#contextHandler?.(frame.delegationId, frame.text, frame.kind);
				return;
			case "delegation-end":
				this.#endHandler?.(frame.delegationId);
				return;
			case "auth-grant":
				this.#options.onCredential?.({
					accessToken: frame.accessToken,
					accountId: frame.accountId,
					expiresAt: frame.expiresAt,
				});
				return;
			case "error":
				this.#fail(frame.message);
				return;
		}
	}

	#fail(message: string): void {
		if (!this.#welcome) this.#welcomeResolvers.reject(new Error(message));
		this.#options.onError?.(message);
	}

	#send(frame: LiveBridgeClientFrame): void {
		if (this.#closed && frame.t !== "bye") return;
		try {
			this.#writer.write(encodeBridgeFrame(frame));
		} catch (cause) {
			logger.debug("Live bridge write failed", { error: cause instanceof Error ? cause.message : String(cause) });
		}
	}
}
