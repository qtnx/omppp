import { Mic, MicOff, PhoneOff } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { LivePeer } from "../../lib/live-peer";
import "./live.css";

export interface LivePanelProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
}

const PHASE_LABEL: Record<string, string> = {
	connecting: "Connecting",
	listening: "Listening",
	speaking: "Speaking",
	working: "Working on it",
	muted: "Muted",
	error: "Error",
};

/** Turn a browser media error into copy that tells the guest what to do next. */
function describeStartFailure(error: unknown): string {
	const name = error instanceof DOMException ? error.name : "";
	if (name === "NotAllowedError" || name === "SecurityError") {
		return "Microphone access was blocked. Allow it for this site in your browser settings, then try again.";
	}
	if (name === "NotFoundError") return "No microphone was found. Connect one and try again.";
	return error instanceof Error ? error.message : String(error);
}

export function LivePanel({ client, snapshot }: LivePanelProps): ReactNode {
	const [peer, setPeer] = useState<LivePeer | null>(null);
	const [starting, setStarting] = useState(false);
	const [muted, setMuted] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [levels, setLevels] = useState({ input: 0, output: 0 });
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const peerRef = useRef<LivePeer | null>(null);

	const teardown = useCallback((): void => {
		peerRef.current?.stop();
		peerRef.current = null;
		setPeer(null);
		setMuted(false);
		setLevels({ input: 0, output: 0 });
	}, []);

	// The host owns the call's lifetime: when it says the call ended, release the mic.
	useEffect(() => {
		if (snapshot.live.ended && peerRef.current) teardown();
	}, [snapshot.live.ended, teardown]);

	useEffect(() => teardown, [teardown]);

	const start = useCallback(async (): Promise<void> => {
		const element = audioRef.current;
		if (!element || starting || peerRef.current) return;
		if (!window.isSecureContext) {
			setError("Voice needs a secure page. Open this session over HTTPS, or through localhost.");
			return;
		}
		setError(null);
		setStarting(true);
		const next = new LivePeer({
			getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
			createPeerConnection: () => new RTCPeerConnection(),
			createAudioContext: () => new AudioContext(),
			audioElement: element,
			sendOffer: sdp => client.sendLiveOffer(sdp),
			onLevels: (input, output) => {
				setLevels({ input, output });
				client.sendLiveLevel(output);
			},
			onFailure: message => {
				setError(message);
				teardown();
			},
		});
		peerRef.current = next;
		try {
			await next.start();
			setPeer(next);
		} catch (cause) {
			setError(describeStartFailure(cause));
			teardown();
		} finally {
			setStarting(false);
		}
	}, [client, starting, teardown]);

	const stop = useCallback((): void => {
		client.sendLiveStop();
		teardown();
	}, [client, teardown]);

	const toggleMute = useCallback((): void => {
		const active = peerRef.current;
		if (!active) return;
		const next = !muted;
		active.setMuted(next);
		client.sendLiveMute(next);
		setMuted(next);
	}, [client, muted]);

	if (snapshot.readOnly) {
		// Hiding the control silently reads as a missing feature; say why it is absent.
		return (
			<section className="lv-panel" aria-label="Voice call">
				<p className="lv-note">Voice needs a full invite link. This one is view-only.</p>
			</section>
		);
	}

	const phase = snapshot.live.phase;
	const transcript = snapshot.live.transcript;

	return (
		<section className="lv-panel" aria-label="Voice call">
			{/* biome-ignore lint/a11y/useMediaCaption: realtime assistant audio has no caption track. */}
			<audio ref={audioRef} autoPlay playsInline />
			<div className="lv-row">
				{peer ? (
					<>
						<button
							type="button"
							className={muted ? "lv-btn lv-btn-off" : "lv-btn lv-btn-on"}
							onClick={toggleMute}
							aria-pressed={muted}
						>
							{muted ? <MicOff size={14} /> : <Mic size={14} />}
							{muted ? "Unmute" : "Mute"}
						</button>
						<button type="button" className="lv-btn" onClick={stop}>
							<PhoneOff size={14} />
							End call
						</button>
					</>
				) : (
					<button type="button" className="lv-btn lv-btn-on" onClick={() => void start()} disabled={starting}>
						<Mic size={14} />
						{starting ? "Starting…" : "Start voice"}
					</button>
				)}
				<span className="lv-phase" aria-live="polite">
					{phase ? (PHASE_LABEL[phase] ?? phase) : "Idle"}
				</span>
				{peer && (
					<span className="lv-meters" aria-hidden="true">
						<span className="lv-meter">
							<span className="lv-meter-fill" style={{ width: `${Math.round(levels.input * 100)}%` }} />
						</span>
						<span className="lv-meter">
							<span
								className="lv-meter-fill lv-meter-out"
								style={{ width: `${Math.round(levels.output * 100)}%` }}
							/>
						</span>
					</span>
				)}
			</div>
			{transcript && (
				<p className={transcript.role === "user" ? "lv-line lv-line-user" : "lv-line"}>{transcript.text}</p>
			)}
			{error && <p className="lv-error">{error}</p>}
			{!error && !peer && snapshot.live.ended && <p className="lv-note">{snapshot.live.ended}</p>}
		</section>
	);
}
