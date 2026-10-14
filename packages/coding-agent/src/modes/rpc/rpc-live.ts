/**
 * GPT live voice sessions for RPC mode: binds a {@link LiveSessionController} to the
 * RPC AgentSession (so delegated work runs with the host's tools) and forwards its
 * callbacks as unsolicited `live_*` frames.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { LiveSessionController, type LiveSessionControllerOptions } from "../../live/controller";
import type { LiveAgentEndpoint, LiveAgentIdentity, LiveMediaEndpoint } from "../../live/endpoints";
import { LocalAgentEndpoint, LocalMediaEndpoint, localAgentIdentity } from "../../live/local-endpoints";
import { cfgLiveVoice } from "../../live/settings";
import { DEFAULT_LIVE_VOICE } from "../../live/voices";
import type { AgentSession } from "../../session/agent-session";
import type { RpcLiveFrame } from "./rpc-types";

/** Minimum spacing between `live_levels` frames. */
export const RPC_LIVE_LEVELS_INTERVAL_MS = 100;

/** The controller surface the RPC bridge drives. */
export type RpcLiveSession = Pick<LiveSessionController, "start" | "stop" | "toggleMute" | "muted">;

/** Builds the controller for one live session; tests substitute a fake. */
export type RpcLiveSessionFactory = (options: LiveSessionControllerOptions) => RpcLiveSession;

/** Media plane that also reports microphone input levels (feeds `live_levels`). */
export type RpcLiveMedia = LiveMediaEndpoint & { onInputLevel(handler: (level: number) => void): void };

/** Endpoints and identity one live session runs on. */
export interface RpcLiveEndpoints {
	media: RpcLiveMedia;
	agent: LiveAgentEndpoint;
	identity: LiveAgentIdentity;
}

/** Builds the endpoints for one live session; tests substitute fakes. */
export type RpcLiveEndpointsFactory = (session: AgentSession) => RpcLiveEndpoints;

function createLocalEndpoints(session: AgentSession): RpcLiveEndpoints {
	return {
		media: new LocalMediaEndpoint(),
		agent: new LocalAgentEndpoint(session, extractVisibleAssistantText),
		identity: localAgentIdentity(session),
	};
}

/** `live_start` parameters. */
export interface RpcLiveStartOptions {
	voice?: string;
	instructions?: string;
}

/** Visible assistant text: text blocks only, no thinking or tool calls. Shared with interactive mode. */
export function extractVisibleAssistantText(message: AssistantMessage): string {
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim();
}

/** Owns at most one live session for an RPC server. */
export class RpcLiveBridge {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcLiveFrame) => void;
	readonly #createSession: RpcLiveSessionFactory;
	readonly #levelsIntervalMs: number;
	readonly #createEndpoints: RpcLiveEndpointsFactory;

	/** Set from construction until the controller has fully stopped (connecting, active, closing). */
	#controller: RpcLiveSession | undefined;
	#closing: Promise<void> | undefined;
	#pendingLevels: { input: number; output: number } | undefined;
	#levelsTimer: NodeJS.Timeout | undefined;
	#lastLevelsAt = Number.NEGATIVE_INFINITY;

	constructor(
		session: AgentSession,
		output: (frame: RpcLiveFrame) => void,
		createSession: RpcLiveSessionFactory = options => new LiveSessionController(options),
		levelsIntervalMs = RPC_LIVE_LEVELS_INTERVAL_MS,
		createEndpoints: RpcLiveEndpointsFactory = createLocalEndpoints,
	) {
		this.#createEndpoints = createEndpoints;
		this.#session = session;
		this.#output = output;
		this.#createSession = createSession;
		this.#levelsIntervalMs = levelsIntervalMs;
	}

	/** Whether a session is connecting, active, or closing. */
	get active(): boolean {
		return this.#controller !== undefined;
	}

	/** Connects a live session and resolves once it is recording. */
	async start(options: RpcLiveStartOptions = {}): Promise<{ voice: string }> {
		if (this.#controller) throw new Error("A live session is already active");
		const voice = options.voice?.trim() || cfgLiveVoice.get(this.#session.settings) || DEFAULT_LIVE_VOICE;
		let terminated = false;
		const { media, agent, identity } = this.#createEndpoints(this.#session);
		// The controller owns the single output-level handler, so tap both levels here and forward output to it.
		let inputLevel = 0;
		let outputLevel = 0;
		let controllerOutputHandler: ((level: number) => void) | undefined;
		media.onInputLevel(level => {
			inputLevel = level;
			if (!terminated) this.#queueLevels(inputLevel, outputLevel);
		});
		media.onOutputLevel(level => {
			outputLevel = level;
			if (!terminated) this.#queueLevels(inputLevel, outputLevel);
			controllerOutputHandler?.(level);
		});
		const tappedMedia: LiveMediaEndpoint = {
			createOffer: () => media.createOffer(),
			acceptAnswer: sdp => media.acceptAnswer(sdp),
			waitForOpen: timeoutMs => media.waitForOpen(timeoutMs),
			setMuted: muted => media.setMuted(muted),
			onOutputLevel: handler => {
				controllerOutputHandler = handler;
			},
			onFailure: handler => media.onFailure(handler),
			close: () => media.close(),
		};
		const controller = this.#createSession({
			media: tappedMedia,
			agent,
			identity,
			authStorage: this.#session.modelRegistry.authStorage,
			voice,
			instructions: options.instructions,
			callbacks: {
				onPhase: phase => this.#output({ type: "live_phase", phase }),
				onTranscript: transcript => {
					if (!transcript) return;
					this.#output({
						type: "live_transcript",
						role: transcript.role,
						turn: transcript.turn,
						text: transcript.text,
						final: transcript.final,
					});
				},
				onTerminal: error => {
					if (terminated) return;
					terminated = true;
					this.#flushLevels();
					this.#output(error ? { type: "live_end", error: error.message } : { type: "live_end" });
					this.#retire(controller);
				},
			},
		});
		this.#controller = controller;
		try {
			await controller.start();
		} catch (cause) {
			await this.#retire(controller);
			throw cause instanceof Error ? cause : new Error(String(cause));
		}
		return { voice };
	}

	/** Stops the active session; resolves once it has stopped. No-op without one. */
	async stop(): Promise<void> {
		const controller = this.#controller;
		if (!controller) return;
		await this.#retire(controller);
	}

	/** Sets (or toggles when omitted) microphone mute. */
	setMuted(muted?: boolean): { muted: boolean } {
		const controller = this.#controller;
		if (!controller || this.#closing) throw new Error("No live session is active");
		if (muted === undefined || muted !== controller.muted) controller.toggleMute();
		return { muted: controller.muted };
	}

	/** Stops `controller` and releases the slot once it has fully stopped. Idempotent. */
	#retire(controller: RpcLiveSession): Promise<void> {
		if (this.#controller !== controller) return Promise.resolve();
		this.#closing ??= controller.stop().finally(() => {
			if (this.#controller !== controller) return;
			this.#controller = undefined;
			this.#closing = undefined;
			// Levels never follow `live_end`.
			clearTimeout(this.#levelsTimer);
			this.#levelsTimer = undefined;
			this.#pendingLevels = undefined;
		});
		return this.#closing;
	}

	#queueLevels(input: number, output: number): void {
		this.#pendingLevels = { input, output };
		if (this.#levelsTimer) return;
		const wait = this.#lastLevelsAt + this.#levelsIntervalMs - Date.now();
		if (wait <= 0) {
			this.#flushLevels();
			return;
		}
		this.#levelsTimer = setTimeout(() => {
			this.#levelsTimer = undefined;
			this.#flushLevels();
		}, wait);
	}

	#flushLevels(): void {
		if (this.#levelsTimer) {
			clearTimeout(this.#levelsTimer);
			this.#levelsTimer = undefined;
		}
		const levels = this.#pendingLevels;
		if (!levels) return;
		this.#pendingLevels = undefined;
		this.#lastLevelsAt = Date.now();
		this.#output({ type: "live_levels", input: levels.input, output: levels.output });
	}
}
