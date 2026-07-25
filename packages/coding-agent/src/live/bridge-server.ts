import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import {
	BridgeFrameDecoder,
	encodeBridgeFrame,
	isLiveBridgeClientFrame,
	LIVE_BRIDGE_PROTO,
	type LiveBridgeServerFrame,
} from "./bridge-protocol";
import type { LiveAgentEndpoint, LiveAgentIdentity } from "./endpoints";

/** Directory holding one socket per live-enabled session on this host. */
export function liveRunDir(): string {
	return path.join(getConfigRootDir(), "run", "live");
}

/** Socket path a laptop client reaches through `ompx live-agent --session <id>`. */
export function liveSocketPath(sessionId: string): string {
	return path.join(liveRunDir(), `${sessionId}.sock`);
}

/** Credential the host may hand a client that has none of its own. */
export interface LiveBridgeCredential {
	accessToken: string;
	accountId?: string;
	/** Epoch milliseconds after which the client must request a fresh grant. */
	expiresAt: number;
}

/** Dependencies for the remote half of the SSH live bridge. */
export interface LiveBridgeServerOptions {
	/** Agent plane served to the attached client; one delegation at a time. */
	agent: LiveAgentEndpoint;
	/** Identity of this host, echoed in `welcome` so the client stops describing itself. */
	identity: LiveAgentIdentity;
	/** Session title shown by the client, when the session has one. */
	title?: string;
	/**
	 * Resolve a forwardable Codex credential. Absent (the default) means credential
	 * forwarding is disabled and `auth-request` is answered with an error.
	 */
	resolveCredential?: () => Promise<LiveBridgeCredential>;
	/** Notifies the UI when a client attaches or detaches. */
	onPeerChange?: (connected: boolean) => void;
	/** Client-reported call phase, mirrored into the host's own status line. */
	onPhase?: (phase: string) => void;
	/** Socket path override; defaults to `~/.omp/run/live/<sessionId>.sock`. Test seam. */
	socketPath?: string;
}

type BridgeSocket = { write(data: string): unknown; end(): unknown };

/**
 * Serves this session's agent plane on a unix socket so a laptop that owns the
 * microphone and speaker can run the media half of a live call over SSH.
 *
 * Exactly one client is served at a time: a second connection is rejected with an
 * `error` frame rather than silently stealing the session. A client that vanishes
 * mid-turn does not abort the agent — the turn belongs to the session and stays
 * visible in the host's own transcript.
 */
export class LiveBridgeServer {
	readonly #options: LiveBridgeServerOptions;
	readonly #sessionId: string;
	#server: { stop(closeActiveConnections?: boolean): void } | undefined;
	#socketPath: string | undefined;
	#peer: BridgeSocket | undefined;
	#handlersBound = false;

	constructor(options: LiveBridgeServerOptions) {
		this.#options = options;
		this.#sessionId = options.identity.sessionId;
	}

	/** Path of the bound socket, or undefined before `start()` and after `stop()`. */
	get socketPath(): string | undefined {
		return this.#socketPath;
	}

	/** Whether a client is currently attached. */
	get attached(): boolean {
		return this.#peer !== undefined;
	}

	/** Bind the session socket and begin accepting one client. Returns the socket path. */
	async start(): Promise<string> {
		if (this.#socketPath) return this.#socketPath;
		const socketPath = this.#options.socketPath ?? liveSocketPath(this.#sessionId);
		await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
		// A crashed session leaves its socket file behind; binding over it is safe because
		// the path is namespaced by session id and the old process no longer answers.
		await this.#unlinkSocket(socketPath);

		this.#bindAgentHandlers();
		this.#server = Bun.listen<undefined>({
			unix: socketPath,
			socket: {
				open: socket => this.#handleOpen(socket),
				data: (socket, chunk) => this.#handleData(socket, chunk),
				close: socket => this.#handleClose(socket),
				error: (socket, error) => {
					logger.warn("Live bridge socket error", { error: error.message });
					this.#handleClose(socket);
				},
			},
		});
		await fs.chmod(socketPath, 0o600);
		this.#socketPath = socketPath;
		return socketPath;
	}

	/** Close the client, stop listening, and remove the socket file. Idempotent. */
	async stop(): Promise<void> {
		const peer = this.#peer;
		this.#peer = undefined;
		if (peer) {
			this.#trySend(peer, { t: "error", message: "The live session on the host has ended." });
			try {
				peer.end();
			} catch {
				// The client may have already gone away.
			}
		}
		this.#server?.stop(true);
		this.#server = undefined;
		const socketPath = this.#socketPath;
		this.#socketPath = undefined;
		if (socketPath) await this.#unlinkSocket(socketPath);
	}

	#bindAgentHandlers(): void {
		if (this.#handlersBound) return;
		this.#handlersBound = true;
		this.#options.agent.onContext((delegationId, text, kind) => {
			this.#send({ t: "context", delegationId, text, kind });
		});
		this.#options.agent.onDelegationEnd(delegationId => {
			this.#send({ t: "delegation-end", delegationId });
		});
	}

	#handleOpen(socket: BridgeSocket & { data?: unknown }): void {
		if (this.#peer) {
			this.#trySend(socket, {
				t: "error",
				message: "Another client is already attached to this live session.",
			});
			try {
				socket.end();
			} catch {
				// Nothing to clean up for a rejected connection.
			}
			return;
		}
		this.#peer = socket;
		const decoder = new BridgeFrameDecoder(frame => this.#handleFrame(socket, frame));
		decoderBySocket.set(socket, decoder);
		this.#options.onPeerChange?.(true);
	}

	#handleData(socket: BridgeSocket, chunk: Uint8Array): void {
		if (this.#peer !== socket) return;
		const decoder = decoderBySocket.get(socket);
		if (!decoder) return;
		try {
			decoder.push(chunk);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			this.#trySend(socket, { t: "error", message: `Live bridge stream is corrupt: ${message}` });
			try {
				socket.end();
			} catch {
				// The stream is already unusable.
			}
		}
	}

	#handleClose(socket: BridgeSocket): void {
		decoderBySocket.delete(socket);
		if (this.#peer !== socket) return;
		this.#peer = undefined;
		this.#options.onPeerChange?.(false);
	}

	#handleFrame(socket: BridgeSocket, frame: unknown): void {
		if (!isLiveBridgeClientFrame(frame)) {
			logger.debug("Live bridge ignored an unknown client frame");
			return;
		}
		switch (frame.t) {
			case "hello":
				if (frame.proto !== LIVE_BRIDGE_PROTO) {
					this.#trySend(socket, {
						t: "error",
						message: `Live bridge version mismatch: host speaks v${LIVE_BRIDGE_PROTO}, client speaks v${frame.proto}. Update the older side.`,
					});
					try {
						socket.end();
					} catch {
						// Nothing more to do for a rejected client.
					}
					return;
				}
				this.#trySend(socket, {
					t: "welcome",
					proto: LIVE_BRIDGE_PROTO,
					sessionId: this.#options.identity.sessionId,
					cwd: this.#options.identity.cwd,
					username: this.#options.identity.username,
					firstName: this.#options.identity.firstName,
					title: this.#options.title,
				});
				return;
			case "delegate":
				this.#options.agent.startDelegation(frame.id, frame.text);
				return;
			case "phase":
				this.#options.onPhase?.(frame.phase);
				return;
			case "transcript":
				// Transcripts are mirrored for host-side display only; the agent plane
				// receives conversational context through delegations, not transcripts.
				return;
			case "auth-request":
				void this.#handleAuthRequest(socket);
				return;
			case "bye":
				try {
					socket.end();
				} catch {
					// The client is already leaving.
				}
				return;
		}
	}

	async #handleAuthRequest(socket: BridgeSocket): Promise<void> {
		const resolve = this.#options.resolveCredential;
		if (!resolve) {
			this.#trySend(socket, {
				t: "error",
				message:
					"This host does not forward credentials. Sign in on the client with `ompx auth login`, or enable `live.allowCredentialForward` on the host.",
			});
			return;
		}
		try {
			const credential = await resolve();
			this.#trySend(socket, {
				t: "auth-grant",
				accessToken: credential.accessToken,
				accountId: credential.accountId,
				expiresAt: credential.expiresAt,
			});
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			this.#trySend(socket, { t: "error", message: `Could not forward a credential: ${message}` });
		}
	}

	#send(frame: LiveBridgeServerFrame): void {
		const peer = this.#peer;
		if (peer) this.#trySend(peer, frame);
	}

	#trySend(socket: BridgeSocket, frame: LiveBridgeServerFrame): void {
		try {
			socket.write(encodeBridgeFrame(frame));
		} catch (cause) {
			logger.debug("Live bridge write failed", { error: cause instanceof Error ? cause.message : String(cause) });
		}
	}

	async #unlinkSocket(socketPath: string): Promise<void> {
		try {
			await fs.unlink(socketPath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
}

/** Decoders are per-connection state that Bun's socket handlers cannot carry inline. */
const decoderBySocket = new WeakMap<BridgeSocket, BridgeFrameDecoder>();
