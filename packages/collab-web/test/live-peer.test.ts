import { describe, expect, it } from "bun:test";
import { LivePeer, type LivePeerDeps } from "../src/lib/live-peer";

class FakeTrack {
	enabled = true;
	stopped = false;
	readonly kind = "audio";
	stop(): void {
		this.stopped = true;
	}
}

class FakeStream {
	constructor(readonly tracks: FakeTrack[]) {}
	getAudioTracks(): FakeTrack[] {
		return this.tracks;
	}
	getTracks(): FakeTrack[] {
		return this.tracks;
	}
}

class FakePeerConnection {
	iceGatheringState: RTCIceGatheringState = "complete";
	iceConnectionState: RTCIceConnectionState = "new";
	localDescription: { sdp: string } | null = null;
	remoteDescription: { type: string; sdp: string } | null = null;
	closed = false;
	readonly channels: string[] = [];
	readonly addedTracks: FakeTrack[] = [];
	ontrack: ((event: { streams: unknown[]; track: unknown }) => void) | null = null;
	oniceconnectionstatechange: (() => void) | null = null;

	createDataChannel(label: string): void {
		this.channels.push(label);
	}
	addTrack(track: FakeTrack): void {
		this.addedTracks.push(track);
	}
	async createOffer(): Promise<{ type: string; sdp: string }> {
		return { type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" };
	}
	async setLocalDescription(description: { sdp: string }): Promise<void> {
		this.localDescription = description;
	}
	async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
		this.remoteDescription = description;
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	close(): void {
		this.closed = true;
	}
}

interface Harness {
	peer: LivePeer;
	pc: FakePeerConnection;
	stream: FakeStream;
	offers: string[];
	failures: string[];
	element: { srcObject: unknown; play(): Promise<void> };
}

function harness(overrides: Partial<LivePeerDeps> = {}): Harness {
	const stream = new FakeStream([new FakeTrack()]);
	const pc = new FakePeerConnection();
	const offers: string[] = [];
	const failures: string[] = [];
	const element = {
		srcObject: null as unknown,
		play: async () => {},
	};
	const peer = new LivePeer({
		getUserMedia: async () => stream as unknown as MediaStream,
		createPeerConnection: () => pc as unknown as RTCPeerConnection,
		createAudioContext: () => {
			throw new Error("no audio context in tests");
		},
		audioElement: element as unknown as HTMLAudioElement,
		sendOffer: async sdp => {
			offers.push(sdp);
			return "v=0\r\nanswer\r\n";
		},
		onFailure: message => failures.push(message),
		setInterval: () => 0,
		clearInterval: () => {},
		...overrides,
	});
	return { peer, pc, stream, offers, failures, element };
}

describe("LivePeer", () => {
	it("offers one audio track plus the oai-events channel and applies the host's answer", async () => {
		const h = harness();

		await h.peer.start();

		expect(h.pc.channels).toEqual(["oai-events"]);
		expect(h.pc.addedTracks).toHaveLength(1);
		expect(h.offers).toHaveLength(1);
		expect(h.offers[0]).toContain("m=audio");
		expect(h.pc.remoteDescription).toEqual({ type: "answer", sdp: "v=0\r\nanswer\r\n" });
	});

	it("mutes by disabling the local track without ending the call", async () => {
		const h = harness();
		await h.peer.start();

		h.peer.setMuted(true);
		expect(h.stream.tracks[0].enabled).toBe(false);
		expect(h.pc.closed).toBe(false);

		h.peer.setMuted(false);
		expect(h.stream.tracks[0].enabled).toBe(true);
	});

	it("releases the microphone and the peer once, however often stop is called", async () => {
		const h = harness();
		await h.peer.start();

		h.peer.stop();
		h.peer.stop();

		expect(h.stream.tracks[0].stopped).toBe(true);
		expect(h.pc.closed).toBe(true);
		expect(h.element.srcObject).toBeNull();
	});

	it("surfaces a refused offer instead of leaving the call half-open", async () => {
		const h = harness({
			sendOffer: async () => {
				throw new Error("A voice call is already running in this session.");
			},
		});

		await expect(h.peer.start()).rejects.toThrow("already running");
	});
});
