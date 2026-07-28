import { loadNative } from "./loader-state.js";

/** Construct microphone capture, loading the native addon on first use. */
export function createAudioCapture(sampleRate, onAudio) {
	const { AudioCapture } = loadNative();
	return new AudioCapture(sampleRate, onAudio);
}

/** Construct a live WebRTC peer, loading the native addon on first use. */
export function createLiveWebRtcPeer(onEvent, onLevel, onFailure) {
	const { LiveWebRtcPeer } = loadNative();
	return new LiveWebRtcPeer(onEvent, onLevel, onFailure);
}
