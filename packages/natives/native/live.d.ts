import type { AudioCapture, LiveWebRtcPeer } from "./index.js";

/** Construct microphone capture, loading the native addon on first use. */
export declare function createAudioCapture(
	sampleRate: number,
	onAudio: (error: Error | null, samples: Float32Array) => void,
): AudioCapture;

/** Construct a live WebRTC peer, loading the native addon on first use. */
export declare function createLiveWebRtcPeer(
	onEvent: (error: Error | null, payload: string) => void,
	onLevel: (error: Error | null, level: number) => void,
	onFailure: (error: Error | null, message: string) => void,
): LiveWebRtcPeer;
