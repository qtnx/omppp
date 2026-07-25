import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { LiveAgentEndpoint, LiveAgentIdentity, LiveMediaEndpoint } from "./endpoints";
import liveInstructionsTemplate from "./prompts/live-instructions.md" with { type: "text" };
import {
	buildDelegationContextAppend,
	buildSessionClose,
	type LiveClientMessage,
	type LiveServerEvent,
} from "./protocol";
import { CodexLiveTransport, type LiveTransportOptions } from "./transport";
import type { LivePhase } from "./visualizer";

const DEFAULT_VOICE = "sol";
/** Output RMS at or above this level counts as the assistant actively speaking. */
export const OUTPUT_ACTIVE_LEVEL = 0.015;

/** Incremental or final transcript for one realtime conversational turn. */
export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	/** Monotonic role-local turn number used to coalesce streaming updates. */
	turn: number;
	final: boolean;
}

/** UI notifications emitted during a live session. */
export interface LiveSessionCallbacks {
	/** Reports connection and activity phase changes. */
	onPhase(phase: LivePhase): void;
	/** Reports the latest available conversational transcript. */
	onTranscript(transcript: LiveTranscript | undefined): void;
	/** Reports one terminal stop, optionally carrying its cause. */
	onTerminal(error?: Error): void;
}

/** Control plane the controller drives; `CodexLiveTransport` is the production implementation. */
export interface LiveControlTransport {
	connect(): Promise<void>;
	send(message: LiveClientMessage): Promise<void>;
	close(): Promise<void>;
}

/** Dependencies and presentation callbacks for a live session. */
export interface LiveSessionControllerOptions {
	/** Media plane: microphone, WebRTC peer, echo gate. */
	media: LiveMediaEndpoint;
	/** Agent plane: runs delegated coding requests. */
	agent: LiveAgentEndpoint;
	/** Identity of the agent host, feeding live instructions and Codex headers. */
	identity: LiveAgentIdentity;
	/** Credential storage used by the control plane for Codex signaling. */
	authStorage: AuthStorage;
	/** UI callbacks for live session state. */
	callbacks: LiveSessionCallbacks;
	/** Realtime output voice, defaulting to sol. */
	voice?: string;
	/** Control-plane factory; defaults to the Codex live transport. Overridable for tests. */
	createTransport?: (options: LiveTransportOptions) => LiveControlTransport;
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/** Coordinates the realtime conversational surface with delegated agent turns. */
export class LiveSessionController {
	readonly #media: LiveMediaEndpoint;
	readonly #agent: LiveAgentEndpoint;
	readonly #identity: LiveAgentIdentity;
	readonly #authStorage: AuthStorage;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #voice: string;
	readonly #createTransport: (options: LiveTransportOptions) => LiveControlTransport;

	#transport: LiveControlTransport | undefined;
	#sendChain: Promise<void> = Promise.resolve();
	#stopPromise: Promise<void> | undefined;
	#started = false;
	#stopped = false;
	#terminalEmitted = false;
	#failure: Error | undefined;
	#muted = false;
	#phase: LivePhase = "connecting";
	#outputLevel = 0;
	#activeDelegationId: string | undefined;
	#userTranscript = "";
	#assistantTranscript = "";
	#userTranscriptFinal = false;
	#assistantTranscriptFinal = false;
	#userTranscriptTurn = 0;
	#assistantTranscriptTurn = 0;
	#lastTranscript: LiveTranscript | undefined;

	constructor(options: LiveSessionControllerOptions) {
		this.#media = options.media;
		this.#agent = options.agent;
		this.#identity = options.identity;
		this.#authStorage = options.authStorage;
		this.#callbacks = options.callbacks;
		this.#voice = options.voice?.trim() || DEFAULT_VOICE;
		this.#createTransport = options.createTransport ?? (opts => new CodexLiveTransport(opts));
	}

	/** Current realtime call phase. */
	get phase(): LivePhase {
		return this.#phase;
	}

	/** Whether microphone input is currently muted. */
	get muted(): boolean {
		return this.#muted;
	}

	/** Connects the realtime surface and starts microphone streaming. */
	async start(): Promise<void> {
		if (this.#stopped) {
			throw (
				this.#failure ?? new Error("This live session has already stopped; create a new controller to reconnect.")
			);
		}
		if (this.#started) return;
		this.#started = true;
		this.#emitPhase("connecting", true);
		this.#emitTranscript(undefined);
		if (this.#stopped) {
			throw this.#failure ?? new Error("The live session stopped while starting.");
		}

		try {
			this.#media.onOutputLevel(level => this.#guardEvent(() => this.#handleOutputLevel(level)));
			this.#media.onFailure(message => this.#guardEvent(() => this.#reportFailure(new Error(message))));
			this.#agent.onContext((delegationId, text, kind) =>
				this.#guardEvent(() => this.#queueSend(buildDelegationContextAppend(delegationId, text, kind))),
			);
			this.#agent.onDelegationEnd(delegationId => this.#guardEvent(() => this.#handleDelegationEnd(delegationId)));

			const instructions = prompt.render(liveInstructionsTemplate, {
				firstName: this.#identity.firstName,
				username: this.#identity.username,
			});
			const transport = this.#createTransport({
				authStorage: this.#authStorage,
				sessionId: this.#identity.sessionId,
				instructions,
				voice: this.#voice,
				media: this.#media,
				callbacks: { onEvent: event => this.#guardEvent(() => this.#handleLiveEvent(event)) },
			});
			this.#transport = transport;
			await transport.connect();
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped while connecting.");
			}
			if (this.#muted) await this.#media.setMuted(true);
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped before recording began.");
			}
			this.#refreshAudioPhase();
		} catch (cause) {
			const error = errorFrom(cause);
			this.#reportFailure(error);
			await this.stop();
			throw error;
		}
	}

	/** Toggles microphone capture while leaving output and the session connected. */
	toggleMute(): void {
		if (this.#stopped) return;
		this.#muted = !this.#muted;
		this.#refreshAudioPhase();
		void this.#media.setMuted(this.#muted).catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	/** Stops recording, closes the live session, and emits one terminal callback. */
	stop(): Promise<void> {
		if (!this.#stopPromise) this.#stopPromise = this.#stop();
		return this.#stopPromise;
	}

	async #stop(): Promise<void> {
		this.#stopped = true;
		let cleanupError: Error | undefined;

		try {
			await this.#agent.close();
		} catch (cause) {
			cleanupError = errorFrom(cause);
		}

		await this.#sendChain;
		const transport = this.#transport;
		this.#transport = undefined;
		if (transport) {
			try {
				await transport.send(buildSessionClose());
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
			try {
				await transport.close();
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
		}

		try {
			await this.#media.close();
		} catch (cause) {
			cleanupError ??= errorFrom(cause);
		}

		if (cleanupError) this.#emitPhaseSafely("error");
		this.#emitTerminal(cleanupError);
	}

	#guardEvent(handler: () => void): void {
		if (this.#stopped) return;
		try {
			handler();
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#handleLiveEvent(event: LiveServerEvent): void {
		switch (event.type) {
			case "session.started":
				this.#emitPhase("listening");
				break;
			case "session.updated":
			case "output_audio.delta":
			case "unknown":
				break;
			case "input_transcript.added":
				this.#addTranscript("user", event.item.text);
				break;
			case "output_transcript.added":
				this.#addTranscript("assistant", event.item.text);
				break;
			case "turn.done":
				this.#finishTranscript(event.turn.role, event.turn.transcript);
				break;
			case "delegation.created":
				this.#handleDelegation(event);
				break;
			case "error":
				this.#reportFailure(new Error(event.message));
				break;
		}
	}

	#handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
		let request = "";
		for (const content of event.item.content) {
			if (content.type !== "input_text") continue;
			request += `${request ? "\n" : ""}${content.text}`;
		}
		request = request.trim();
		if (!request) return;
		this.#activeDelegationId = event.item.id;
		this.#emitPhase("working");
		this.#agent.startDelegation(event.item.id, request);
	}

	#handleDelegationEnd(delegationId: string): void {
		if (this.#activeDelegationId !== delegationId) return;
		this.#activeDelegationId = undefined;
		this.#refreshAudioPhase();
	}

	#handleOutputLevel(level: number): void {
		this.#outputLevel = Number.isFinite(level) ? level : 0;
		if (!this.#activeDelegationId) this.#refreshAudioPhase();
	}

	#addTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		let next: string;
		if (!current) {
			this.#startTranscriptTurn(role);
			next = text;
		} else if (wasFinal) {
			if (text === current || current.endsWith(text)) return;
			this.#startTranscriptTurn(role);
			next = text;
		} else if (text.startsWith(current)) {
			next = text;
		} else if (current.endsWith(text)) {
			next = current;
		} else {
			next = current + text;
		}
		this.#storeTranscript(role, next, false);
	}

	#finishTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		if (!current) {
			this.#startTranscriptTurn(role);
		} else if (wasFinal) {
			if (text === current) return;
			this.#startTranscriptTurn(role);
		}
		const next = !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
		this.#storeTranscript(role, next, true);
	}

	#startTranscriptTurn(role: LiveTranscript["role"]): void {
		if (role === "user") {
			this.#userTranscriptTurn += 1;
		} else {
			this.#assistantTranscriptTurn += 1;
		}
	}

	#storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		const normalized = text.trim();
		if (!normalized) return;
		const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
		if (role === "user") {
			this.#userTranscript = normalized;
			this.#userTranscriptFinal = final;
		} else {
			this.#assistantTranscript = normalized;
			this.#assistantTranscriptFinal = final;
		}
		if (
			this.#lastTranscript?.role === role &&
			this.#lastTranscript.turn === turn &&
			this.#lastTranscript.text === normalized &&
			this.#lastTranscript.final === final
		) {
			return;
		}
		this.#emitTranscript({ role, turn, text: normalized, final });
	}

	#queueSend(message: LiveClientMessage): void {
		const transport = this.#transport;
		if (!transport || this.#stopped) return;
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (!this.#stopped) await transport.send(message);
			})
			.catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	#refreshAudioPhase(): void {
		if (this.#stopped) return;
		if (this.#muted) {
			this.#emitPhase("muted");
		} else if (this.#activeDelegationId) {
			this.#emitPhase("working");
		} else if (this.#outputLevel > OUTPUT_ACTIVE_LEVEL) {
			this.#emitPhase("speaking");
		} else {
			this.#emitPhase("listening");
		}
	}

	#emitPhase(phase: LivePhase, force = false): void {
		if (!force && this.#phase === phase) return;
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitPhaseSafely(phase: LivePhase): void {
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch {
			// Terminal callback is the final error boundary for UI failures.
		}
	}

	#emitTranscript(transcript: LiveTranscript | undefined): void {
		this.#lastTranscript = transcript;
		try {
			this.#callbacks.onTranscript(transcript);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#reportFailure(error: Error): void {
		if (this.#terminalEmitted) return;
		this.#failure = error;
		this.#emitPhaseSafely("error");
		this.#emitTerminal(error);
		void this.stop();
	}

	#emitTerminal(error?: Error): void {
		if (this.#terminalEmitted) return;
		this.#terminalEmitted = true;
		try {
			this.#callbacks.onTerminal(error);
		} catch {
			// Nothing remains above the terminal callback to receive its error.
		}
	}
}
