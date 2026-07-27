import * as os from "node:os";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createAudioCapture, createLiveWebRtcPeer } from "@oh-my-pi/pi-natives/live";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "../session/messages";
import { OUTPUT_ACTIVE_LEVEL } from "./controller";
import type { LiveAgentEndpoint, LiveAgentIdentity, LiveMediaEndpoint } from "./endpoints";
import agentFinalMessageTemplate from "./prompts/agent-final-message.md" with { type: "text" };
import inputDeviceGuidanceTemplate from "./prompts/live-input-device-error.md" with { type: "text" };
import { chunkLiveContext, parseLiveServerEvent } from "./protocol";

const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;
const INPUT_SAMPLE_RATE = 16_000;

const inputDeviceGuidance = inputDeviceGuidanceTemplate.trim();

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, level);
}

function microphoneLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index] ?? 0;
		sumSquares += sample * sample;
	}
	return clampLevel(Math.sqrt(sumSquares / samples.length));
}

/** Raised when the local input device cannot be opened; its message is user-facing guidance. */
export class LiveInputDeviceError extends Error {
	constructor(cause: Error) {
		super(inputDeviceGuidance, { cause });
		this.name = "LiveInputDeviceError";
	}
}

/** Subset of the native WebRTC peer used by the local media endpoint. */
export interface LivePeerLike {
	createOffer(): Promise<string>;
	acceptAnswer(sdp: string): Promise<void>;
	waitForOpen(timeoutMs?: number): Promise<void>;
	pushAudio(samples: Float32Array): void;
	setMuted(muted: boolean): void;
	close(): Promise<void>;
}

/** Constructs a media peer wired to event, output-level, and failure callbacks. */
export type LivePeerFactory = (
	onEvent: (error: Error | null, payload: string) => void,
	onLevel: (error: Error | null, level: number) => void,
	onFailure: (error: Error | null, message: string) => void,
) => LivePeerLike;

/** Subset of the native audio capture used by the local media endpoint. */
export interface LiveCaptureLike {
	stop(): void;
}

/** Constructs a microphone capture delivering mono PCM chunks. */
export type LiveCaptureFactory = (
	sampleRate: number,
	onAudio: (error: Error | null, samples: Float32Array) => void,
) => LiveCaptureLike;

/** Dependency overrides for the local media endpoint; defaults use the native peer and capture. */
export interface LocalMediaEndpointOptions {
	createPeer?: LivePeerFactory;
	createCapture?: LiveCaptureFactory;
}

/** Local media plane: owns the native WebRTC peer, the microphone, and the echo gate. */
export class LocalMediaEndpoint implements LiveMediaEndpoint {
	readonly #createPeer: LivePeerFactory;
	readonly #createCapture: LiveCaptureFactory;
	#peer: LivePeerLike | undefined;
	#capture: LiveCaptureLike | undefined;
	#muted = false;
	#outputLevel = 0;
	#closed = false;
	#outputLevelHandler: ((level: number) => void) | undefined;
	#inputLevelHandler: ((level: number) => void) | undefined;
	#failureHandler: ((message: string) => void) | undefined;

	constructor(options: LocalMediaEndpointOptions = {}) {
		this.#createPeer = options.createPeer ?? createLiveWebRtcPeer;
		this.#createCapture = options.createCapture ?? createAudioCapture;
	}

	onOutputLevel(handler: (level: number) => void): void {
		this.#outputLevelHandler = handler;
	}

	/** Register the microphone input level handler used by the local visualizer spectrum. */
	onInputLevel(handler: (level: number) => void): void {
		this.#inputLevelHandler = handler;
	}

	onFailure(handler: (message: string) => void): void {
		this.#failureHandler = handler;
	}

	async createOffer(): Promise<string> {
		const peer = this.#createPeer(
			(error, payload) => {
				if (error) this.#fail(error.message);
				else this.#handlePeerEvent(payload);
			},
			(error, level) => {
				if (error) this.#fail(error.message);
				else this.#handleOutputLevel(level);
			},
			(error, message) => this.#fail(error?.message ?? message),
		);
		this.#peer = peer;
		return await peer.createOffer();
	}

	async acceptAnswer(sdp: string): Promise<void> {
		const peer = this.#peer;
		if (!peer) throw new Error("Live media peer has not been created.");
		await peer.acceptAnswer(sdp);
	}

	async waitForOpen(timeoutMs?: number): Promise<void> {
		const peer = this.#peer;
		if (!peer) throw new Error("Live media peer has not been created.");
		await peer.waitForOpen(timeoutMs);
		if (this.#muted) peer.setMuted(true);
		this.#startCapture();
	}

	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
		this.#peer?.setMuted(muted);
		if (muted) this.#inputLevelHandler?.(0);
	}

	async close(): Promise<void> {
		this.#closed = true;
		const capture = this.#capture;
		this.#capture = undefined;
		if (capture) {
			try {
				capture.stop();
			} catch {
				// The device may already be released.
			}
		}
		const peer = this.#peer;
		this.#peer = undefined;
		if (peer) {
			try {
				await peer.close();
			} catch {
				// The peer may already be closed.
			}
		}
	}

	#startCapture(): void {
		try {
			this.#capture = this.#createCapture(INPUT_SAMPLE_RATE, (error, samples) => {
				if (error) {
					this.#fail(error.message);
					return;
				}
				this.#handleCapture(samples);
			});
		} catch (cause) {
			throw new LiveInputDeviceError(errorFrom(cause));
		}
	}

	#handleCapture(samples: Float32Array): void {
		const peer = this.#peer;
		if (this.#closed || !peer || this.#muted) return;
		const input = microphoneLevel(samples);
		this.#inputLevelHandler?.(input);
		const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
		const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, this.#outputLevel * OUTPUT_ECHO_RATIO);
		if (outputActive && input < echoThreshold) return;
		try {
			peer.pushAudio(samples);
		} catch (cause) {
			this.#fail(errorFrom(cause).message);
		}
	}

	#handleOutputLevel(level: number): void {
		if (this.#closed) return;
		this.#outputLevel = clampLevel(level);
		this.#outputLevelHandler?.(this.#outputLevel);
	}

	#handlePeerEvent(payload: string): void {
		if (this.#closed) return;
		// The sideband socket owned by the transport is authoritative for control events;
		// the data channel only needs to surface fatal errors as media failures here.
		const event = parseLiveServerEvent(payload);
		if (event?.type === "error") this.#fail(event.message);
	}

	#fail(message: string): void {
		if (this.#closed) return;
		this.#failureHandler?.(message);
	}
}

/** Local agent plane: runs delegated coding requests on the in-process AgentSession. */
export class LocalAgentEndpoint implements LiveAgentEndpoint {
	readonly #session: AgentSession;
	readonly #extractAssistantText: (message: AssistantMessage) => string;
	#unsubscribe: (() => void) | undefined;
	#contextHandler: ((delegationId: string, text: string, kind?: "commentary") => void) | undefined;
	#endHandler: ((delegationId: string) => void) | undefined;
	#activeId: string | undefined;

	constructor(session: AgentSession, extractAssistantText: (message: AssistantMessage) => string) {
		this.#session = session;
		this.#extractAssistantText = extractAssistantText;
		this.#unsubscribe = session.subscribe(event => this.#handleSessionEvent(event));
	}

	onContext(handler: (delegationId: string, text: string, kind?: "commentary") => void): void {
		this.#contextHandler = handler;
	}

	onDelegationEnd(handler: (delegationId: string) => void): void {
		this.#endHandler = handler;
	}

	startDelegation(id: string, request: string): void {
		this.#activeId = id;
		void this.#session
			.sendCustomMessage(
				{ customType: LIVE_DELEGATION_MESSAGE_TYPE, content: request, display: true, attribution: "agent" },
				{ triggerTurn: true },
			)
			.catch(cause => logger.error("Live delegation failed to start", { error: errorFrom(cause).message }));
	}

	async close(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#activeId = undefined;
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "toolUse") this.#emitProgress(event.message);
			return;
		}
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		this.#emitFinal(event.messages);
	}

	#emitProgress(message: AssistantMessage): void {
		const delegationId = this.#activeId;
		if (!delegationId) return;
		const progress = this.#extractAssistantText(message).trim();
		if (!progress) return;
		for (const chunk of chunkLiveContext(progress)) this.#contextHandler?.(delegationId, chunk, "commentary");
	}

	#emitFinal(messages: readonly AgentMessage[]): void {
		const delegationId = this.#activeId;
		if (!delegationId) return;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			const text = this.#extractAssistantText(message).trim();
			if (!text) continue;
			const finalContext = prompt.render(agentFinalMessageTemplate, { message: text });
			for (const chunk of chunkLiveContext(finalContext)) this.#contextHandler?.(delegationId, chunk);
			break;
		}
		this.#activeId = undefined;
		this.#endHandler?.(delegationId);
	}
}

function localUser(): { username: string; firstName: string } {
	let username = "user";
	try {
		const candidate = os.userInfo().username.trim();
		if (candidate) username = candidate;
	} catch {
		// Sandboxed runtimes may not expose OS account information.
	}
	const firstPart = username.split(/[._\-\s]+/).find(part => part.length > 0);
	return { username, firstName: firstPart ?? "there" };
}

/** Build the live identity describing the local agent host. */
export function localAgentIdentity(session: AgentSession): LiveAgentIdentity {
	const { username, firstName } = localUser();
	return { sessionId: session.sessionId, username, firstName, cwd: process.cwd() };
}
