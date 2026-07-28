/**
 * Puts the call in the phone's system UI: lock screen, notification shade, and —
 * on Android — the buttons inside a Picture-in-Picture window.
 *
 * A voice call has no player chrome of its own, so the Media Session API is what
 * keeps it visible and controllable once the user leaves the page. An installed
 * PWA cannot draw a true system overlay (that needs `SYSTEM_ALERT_WINDOW`, i.e. a
 * native shell), which makes this the realistic ceiling for "still there after I
 * switch apps".
 *
 * Action support is per-browser: Chrome exposes the call-shaped `hangup` and
 * `togglemicrophone` actions, others throw `TypeError` for anything they do not
 * know. Every registration is therefore individually guarded, and `play`/`pause`
 * carry the same mute toggle so a browser with only the classic transport
 * controls still ends up with a working mute button.
 */

/** Call-shaped actions Chrome accepts but `lib.dom` does not yet name. */
type CallSessionAction = MediaSessionAction | "hangup" | "togglemicrophone";

/** The slice of `navigator.mediaSession` this module drives. */
export interface MediaSessionLike {
	metadata: MediaMetadata | null;
	playbackState: MediaSessionPlaybackState;
	setActionHandler(action: MediaSessionAction, handler: (() => void) | null): void;
}

export interface CallPresenceState {
	/** Session name; the notification's title line. */
	title: string;
	/** Phase line: "Listening", "Speaking", "Muted", … */
	status: string;
	muted: boolean;
}

/** What the system controls are allowed to do to the call. */
export interface CallPresenceActions {
	setMuted(muted: boolean): void;
	hangup(): void;
}

export interface CallPresenceDeps {
	/** `navigator.mediaSession`; omitted when the browser has none. */
	session?: MediaSessionLike;
	/** Builds the metadata object — a seam because `MediaMetadata` is DOM-only. */
	createMetadata(state: CallPresenceState): MediaMetadata;
	onWarning?(message: string, cause?: unknown): void;
}

export class CallPresence {
	readonly #deps: CallPresenceDeps;
	readonly #wired: CallSessionAction[] = [];
	#state: CallPresenceState | undefined;
	#actions: CallPresenceActions | undefined;

	constructor(deps: CallPresenceDeps) {
		this.#deps = deps;
	}

	/** State currently published to the system UI, or undefined when idle. */
	get state(): CallPresenceState | undefined {
		return this.#state;
	}

	/** Publish the call and wire the system controls. Idempotent per call. */
	start(state: CallPresenceState, actions: CallPresenceActions): void {
		this.#actions = actions;
		this.update(state);
		if (this.#wired.length > 0) return;
		// `play`/`pause` are the only actions every implementation renders, so they
		// carry mute; `stop`/`hangup` end the call; `togglemicrophone` is Chrome's.
		this.#wire("play", () => this.#actions?.setMuted(false));
		this.#wire("pause", () => this.#actions?.setMuted(true));
		this.#wire("stop", () => this.#actions?.hangup());
		this.#wire("hangup", () => this.#actions?.hangup());
		this.#wire("togglemicrophone", () => this.#actions?.setMuted(!this.#state?.muted));
	}

	/** Push a new phase or mute state to the lock screen. */
	update(state: CallPresenceState): void {
		const session = this.#deps.session;
		this.#state = state;
		if (!session) return;
		try {
			session.metadata = this.#deps.createMetadata(state);
			// Muted reads as "paused" in system UI, which is what the button shows.
			session.playbackState = state.muted ? "paused" : "playing";
		} catch (cause) {
			this.#deps.onWarning?.("Publishing the call to the system UI failed.", cause);
		}
	}

	/** Drop the notification. A session outliving the call is a defect. */
	stop(): void {
		const session = this.#deps.session;
		this.#state = undefined;
		this.#actions = undefined;
		if (!session) return;
		for (const action of this.#wired.splice(0)) {
			try {
				session.setActionHandler(action as MediaSessionAction, null);
			} catch (cause) {
				this.#deps.onWarning?.(`Clearing the ${action} handler failed.`, cause);
			}
		}
		try {
			session.metadata = null;
			session.playbackState = "none";
		} catch (cause) {
			this.#deps.onWarning?.("Clearing the call's system UI failed.", cause);
		}
	}

	#wire(action: CallSessionAction, handler: () => void): void {
		const session = this.#deps.session;
		if (!session) return;
		try {
			// The cast is the point: these are real Chrome actions that `lib.dom`
			// has not caught up with, and unknown actions throw rather than no-op.
			session.setActionHandler(action as MediaSessionAction, handler);
			this.#wired.push(action);
		} catch {
			// This browser does not know the action — the others still stand.
		}
	}
}

/** Wire a presence to `navigator.mediaSession`, artwork included. */
export function browserCallPresenceDeps(): CallPresenceDeps {
	return {
		session: navigator.mediaSession,
		createMetadata: state =>
			new MediaMetadata({
				title: state.title,
				artist: state.status,
				album: "omp collab",
				artwork: [
					{ src: "/favicon-192x192.png", sizes: "192x192", type: "image/png" },
					{ src: "/favicon-512x512.png", sizes: "512x512", type: "image/png" },
				],
			}),
	};
}
