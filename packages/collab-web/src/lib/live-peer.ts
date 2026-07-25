/**
 * Browser half of a live voice call.
 *
 * The browser owns the microphone, the speaker, and the `RTCPeerConnection`; the
 * host owns the credential, the signaling call, and the agent. The SDP handshake
 * is the only thing that travels over the collab relay — audio flows directly
 * between this browser and the realtime service.
 */

/** Data channel the realtime service expects alongside the audio track. */
const EVENT_CHANNEL = "oai-events";
/** ICE gathering is best-effort; a trickle-free offer is sent once this elapses. */
const ICE_GATHER_TIMEOUT_MS = 10_000;
/** Level sampling cadence; also the outbound `live-level` rate. */
const LEVEL_INTERVAL_MS = 100;

export interface LivePeerDeps {
	getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
	createPeerConnection(): RTCPeerConnection;
	createAudioContext(): AudioContext;
	/** Element the remote track is attached to; supplied by the panel. */
	audioElement: HTMLAudioElement;
	/** Hands the local SDP to the host and resolves with the answer. */
	sendOffer(sdp: string): Promise<string>;
	/** Input and output levels, 0..1, sampled every 100ms. */
	onLevels?(input: number, output: number): void;
	/** Fatal failure; the call is over. */
	onFailure?(message: string): void;
	/** Scheduler seam so tests do not depend on wall-clock timers. */
	setInterval?(handler: () => void, ms: number): number;
	clearInterval?(handle: number): void;
}

/** Root-mean-square of a byte-domain analyser frame, normalised to 0..1. */
function frameLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
	analyser.getByteTimeDomainData(buffer);
	let sum = 0;
	for (const sample of buffer) {
		const centered = (sample - 128) / 128;
		sum += centered * centered;
	}
	return Math.min(1, Math.sqrt(sum / buffer.length));
}

export class LivePeer {
	readonly #deps: LivePeerDeps;
	#pc: RTCPeerConnection | undefined;
	#stream: MediaStream | undefined;
	#audio: AudioContext | undefined;
	#inputAnalyser: AnalyserNode | undefined;
	#outputAnalyser: AnalyserNode | undefined;
	#levelTimer: number | undefined;
	#muted = false;
	#stopped = false;

	constructor(deps: LivePeerDeps) {
		this.#deps = deps;
	}

	get muted(): boolean {
		return this.#muted;
	}

	/**
	 * Acquire the microphone, negotiate with the host, and start playing the
	 * assistant's audio. Rejects with a user-presentable message.
	 */
	async start(): Promise<void> {
		const stream = await this.#deps.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		this.#stream = stream;
		if (this.#stopped) {
			this.#releaseTracks();
			return;
		}

		const pc = this.#deps.createPeerConnection();
		this.#pc = pc;
		pc.createDataChannel(EVENT_CHANNEL);
		for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
		pc.ontrack = event => this.#attachRemote(event.streams[0] ?? new MediaStream([event.track]));
		pc.oniceconnectionstatechange = () => {
			if (pc.iceConnectionState === "failed") this.#fail("The voice connection dropped.");
		};

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		await this.#waitForIce(pc);
		const localSdp = pc.localDescription?.sdp ?? offer.sdp;
		if (!localSdp) throw new Error("The browser did not produce a session description.");

		const answer = await this.#deps.sendOffer(localSdp);
		if (this.#stopped) return;
		await pc.setRemoteDescription({ type: "answer", sdp: answer });
		this.#startMetering(stream);
	}

	/** Toggle the microphone without tearing the call down. */
	setMuted(muted: boolean): void {
		this.#muted = muted;
		for (const track of this.#stream?.getAudioTracks() ?? []) track.enabled = !muted;
	}

	/** Release the microphone, the peer, and the audio graph. Safe to call repeatedly. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#levelTimer !== undefined) {
			(this.#deps.clearInterval ?? globalThis.clearInterval)(this.#levelTimer);
			this.#levelTimer = undefined;
		}
		this.#releaseTracks();
		const pc = this.#pc;
		this.#pc = undefined;
		if (pc) {
			pc.ontrack = null;
			pc.oniceconnectionstatechange = null;
			pc.close();
		}
		const audio = this.#audio;
		this.#audio = undefined;
		void audio?.close().catch(() => {});
		this.#deps.audioElement.srcObject = null;
	}

	#releaseTracks(): void {
		for (const track of this.#stream?.getTracks() ?? []) track.stop();
		this.#stream = undefined;
	}

	#attachRemote(stream: MediaStream): void {
		if (this.#stopped) return;
		this.#deps.audioElement.srcObject = stream;
		void this.#deps.audioElement.play().catch(() => {
			// Autoplay can be refused until the user interacts; the mic button already is an interaction.
		});
		const audio = this.#ensureAudioContext();
		if (!audio) return;
		const analyser = audio.createAnalyser();
		audio.createMediaStreamSource(stream).connect(analyser);
		this.#outputAnalyser = analyser;
	}

	#startMetering(local: MediaStream): void {
		const audio = this.#ensureAudioContext();
		if (!audio) return;
		const analyser = audio.createAnalyser();
		audio.createMediaStreamSource(local).connect(analyser);
		this.#inputAnalyser = analyser;

		const inputBuffer = new Uint8Array(analyser.fftSize);
		const schedule = this.#deps.setInterval ?? ((handler, ms) => globalThis.setInterval(handler, ms));
		this.#levelTimer = schedule(() => {
			if (this.#stopped) return;
			const input = this.#muted || !this.#inputAnalyser ? 0 : frameLevel(this.#inputAnalyser, inputBuffer);
			const output = this.#outputAnalyser
				? frameLevel(this.#outputAnalyser, new Uint8Array(this.#outputAnalyser.fftSize))
				: 0;
			this.#deps.onLevels?.(input, output);
		}, LEVEL_INTERVAL_MS) as number;
	}

	#ensureAudioContext(): AudioContext | undefined {
		if (!this.#audio) {
			try {
				this.#audio = this.#deps.createAudioContext();
			} catch {
				// Level metering is cosmetic; a blocked AudioContext must not end the call.
				return undefined;
			}
		}
		return this.#audio;
	}

	async #waitForIce(pc: RTCPeerConnection): Promise<void> {
		if (pc.iceGatheringState === "complete") return;
		const settled = Promise.withResolvers<void>();
		const finish = (): void => {
			pc.removeEventListener("icegatheringstatechange", onChange);
			settled.resolve();
		};
		const onChange = (): void => {
			if (pc.iceGatheringState === "complete") finish();
		};
		pc.addEventListener("icegatheringstatechange", onChange);
		const timer = globalThis.setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
		await settled.promise;
		globalThis.clearTimeout(timer);
	}

	#fail(message: string): void {
		if (this.#stopped) return;
		this.#deps.onFailure?.(message);
	}
}
