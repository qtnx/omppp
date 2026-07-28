import { Mic, MicOff, PhoneOff, PictureInPicture } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserCallPipDeps, CallPip } from "../../lib/call-pip";
import { browserCallPresenceDeps, CallPresence } from "../../lib/call-presence";
import { type GuestClient, type GuestSnapshot, voiceLanguageOverride } from "../../lib/client";
import { LivePeer } from "../../lib/live-peer";
import { browserScreenWakeDeps, ScreenWakeGuard } from "../../lib/screen-wake";
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
	const wakeRef = useRef<ScreenWakeGuard | null>(null);
	const presenceRef = useRef<CallPresence | null>(null);
	const pipRef = useRef<CallPip | null>(null);
	const [pipActive, setPipActive] = useState(false);
	const [pipSupported, setPipSupported] = useState(false);

	const title = snapshot.header?.title ?? snapshot.state?.sessionName ?? "omp collab";
	const phase = snapshot.live.phase;
	const status = muted ? "Muted" : phase ? (PHASE_LABEL[phase] ?? phase) : "In call";

	const teardown = useCallback((): void => {
		peerRef.current?.stop();
		peerRef.current = null;
		// A wake lock, a fallback video, a lock-screen notification or a floating
		// window outliving the call is a defect: the mic and the screen go together.
		void wakeRef.current?.stop();
		wakeRef.current = null;
		presenceRef.current?.stop();
		presenceRef.current = null;
		void pipRef.current?.exit();
		pipRef.current = null;
		setPipActive(false);
		setPeer(null);
		setMuted(false);
		setLevels({ input: 0, output: 0 });
	}, []);

	// Picture-in-Picture is the only always-on-top surface a PWA gets on Android;
	// probing it in an effect keeps the component renderable without a DOM.
	useEffect(() => setPipSupported(browserCallPipDeps().supported()), []);

	// The host owns the call's lifetime: when it says the call ended, release the mic.
	useEffect(() => {
		if (snapshot.live.ended && peerRef.current) teardown();
	}, [snapshot.live.ended, teardown]);

	useEffect(() => teardown, [teardown]);

	const applyMute = useCallback(
		(next: boolean): void => {
			const active = peerRef.current;
			if (!active) return;
			active.setMuted(next);
			client.sendLiveMute(next);
			setMuted(next);
		},
		[client],
	);

	const stop = useCallback((): void => {
		client.sendLiveStop();
		teardown();
	}, [client, teardown]);

	const toggleMute = useCallback((): void => applyMute(!muted), [applyMute, muted]);

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
			// `?lang=` wins; with no override the host picks the call's language.
			sendOffer: sdp => client.sendLiveOffer(sdp, voiceLanguageOverride(window.location.search)),
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
			// Negotiation is async: the call may have ended while it was in flight.
			if (peerRef.current !== next) return;
			// The call is live: hold the screen, and put the call in the system UI
			// so it stays visible and controllable once the guest leaves the page.
			const wake = new ScreenWakeGuard(browserScreenWakeDeps());
			wakeRef.current = wake;
			void wake.start();
			const presence = new CallPresence(browserCallPresenceDeps());
			presence.start({ title, status: "Connecting", muted: false }, { setMuted: applyMute, hangup: stop });
			presenceRef.current = presence;
			pipRef.current = new CallPip(browserCallPipDeps({ onActiveChange: setPipActive }));
			setPeer(next);
		} catch (cause) {
			setError(describeStartFailure(cause));
			teardown();
		} finally {
			setStarting(false);
		}
	}, [applyMute, client, starting, stop, teardown, title]);

	// One source of truth for both surfaces: the lock-screen notification and the
	// floating window show the same phase and mic state as the page.
	useEffect(() => {
		const state = { title, status, muted };
		presenceRef.current?.update(state);
		pipRef.current?.update(state);
	}, [title, status, muted]);

	const togglePip = useCallback(async (): Promise<void> => {
		const pip = pipRef.current;
		if (!pip) return;
		// Entering must happen inside the click: Android requires a user gesture.
		if (pip.active) await pip.exit();
		else await pip.enter({ title, status, muted });
	}, [title, status, muted]);

	if (snapshot.readOnly) {
		// Hiding the control silently reads as a missing feature; say why it is absent.
		return (
			<section className="lv-panel" aria-label="Voice call">
				<p className="lv-note">Voice needs a full invite link. This one is view-only.</p>
			</section>
		);
	}

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
						{pipSupported && (
							<button
								type="button"
								className="lv-btn"
								onClick={() => void togglePip()}
								aria-pressed={pipActive}
								title="Float the call over other apps"
							>
								<PictureInPicture size={14} />
								{pipActive ? "Dock" : "Pop out"}
							</button>
						)}
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
