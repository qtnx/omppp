/**
 * Keeps the screen awake for the lifetime of a voice call.
 *
 * A voice call shows no video and takes no touch input, so a phone dims and then
 * locks the screen mid-call and the call goes with it. Two mechanisms, best first:
 *
 * 1. the Screen Wake Lock API — the native answer (Chrome/Android, Safari 16.4+).
 *    The browser drops the lock whenever the document is hidden and never restores
 *    it on its own, so it has to be re-acquired on `visibilitychange`;
 * 2. an inaudible, looping, `playsInline` `<video>` — the only lever older iOS
 *    Safari gives us. The asset carries no audio track at all, so it cannot touch
 *    the call's audio session.
 *
 * Exactly one of them runs at a time: acquiring the lock tears the video down.
 * Both are driven by the *call's* lifetime — `start()` when a call goes live,
 * `stop()` when it ends, reconnects, fails, or the page goes away — never by a
 * component mount. A lock or a video that outlives the call is a defect.
 *
 * Every failure here is non-fatal by construction: an unsupported browser or a
 * refused request degrades to the next mechanism, and never to a broken call.
 */
import silentLoopVideo from "./silent-loop.mp4";

/** Which mechanism is currently holding the screen awake. */
export type ScreenWakeMode = "wake-lock" | "video" | null;

/** The slice of `WakeLockSentinel` this module depends on. */
export interface WakeLockSentinelLike {
	release(): Promise<void>;
	addEventListener(type: "release", listener: () => void): void;
	removeEventListener(type: "release", listener: () => void): void;
}

/** The inaudible looping video used where no wake lock exists. */
export interface SilentVideoLoop {
	/** Start or resume playback; safe to call repeatedly. */
	resume(): void;
	/** Pause, unmount, and release the element. */
	stop(): void;
}

export interface ScreenWakeDeps {
	/** `navigator.wakeLock.request("screen")`; omitted when the browser has none. */
	requestWakeLock?(): Promise<WakeLockSentinelLike>;
	/** Builds the fallback video; omitted disables the fallback entirely. */
	createSilentVideo?(): SilentVideoLoop | undefined;
	isVisible(): boolean;
	/** Subscribes to `visibilitychange`; returns the unsubscribe. */
	onVisibilityChange(listener: () => void): () => void;
	/** Mode transitions, for diagnostics and UI. */
	onMode?(mode: ScreenWakeMode): void;
	/** Non-fatal failure notice; the call carries on regardless. */
	onWarning?(message: string, cause?: unknown): void;
}

export class ScreenWakeGuard {
	readonly #deps: ScreenWakeDeps;
	#active = false;
	#mode: ScreenWakeMode = null;
	#sentinel: WakeLockSentinelLike | undefined;
	#video: SilentVideoLoop | undefined;
	#unlisten: (() => void) | undefined;
	#acquiring: Promise<void> | undefined;
	readonly #onRelease = (): void => this.#handleSentinelRelease();

	constructor(deps: ScreenWakeDeps) {
		this.#deps = deps;
	}

	/** Mechanism currently in force, or null when nothing holds the screen. */
	get mode(): ScreenWakeMode {
		return this.#mode;
	}

	get active(): boolean {
		return this.#active;
	}

	/** Hold the screen awake. Idempotent; resolves once a mechanism is chosen. */
	async start(): Promise<void> {
		if (this.#active) return;
		this.#active = true;
		this.#unlisten = this.#deps.onVisibilityChange(() => this.#handleVisibility());
		await this.#acquire();
	}

	/** Release everything. Safe to call repeatedly, and from teardown paths. */
	async stop(): Promise<void> {
		this.#active = false;
		this.#unlisten?.();
		this.#unlisten = undefined;
		// An in-flight request resolves into a released sentinel because
		// `#acquireOnce` re-checks `#active` after its await.
		this.#stopVideo();
		await this.#releaseSentinel();
		this.#setMode(null);
	}

	/**
	 * Resolves once no acquisition is in flight. Re-acquisition is fired from
	 * browser events rather than awaited by a caller, so this is the seam tests
	 * (and diagnostics) use instead of racing the event loop.
	 */
	async settled(): Promise<void> {
		while (this.#acquiring) await this.#acquiring.catch(() => {});
	}

	/** Serialised so a visibility burst cannot request two locks at once. */
	async #acquire(): Promise<void> {
		this.#acquiring ??= this.#acquireOnce().finally(() => {
			this.#acquiring = undefined;
		});
		return this.#acquiring;
	}

	async #acquireOnce(): Promise<void> {
		if (!this.#active || this.#sentinel) return;
		const request = this.#deps.requestWakeLock;
		if (request) {
			try {
				const sentinel = await request();
				if (!this.#active) {
					void sentinel.release().catch(() => {});
					return;
				}
				this.#sentinel = sentinel;
				sentinel.addEventListener("release", this.#onRelease);
				// Never both at once — the lock supersedes the video.
				this.#stopVideo();
				this.#setMode("wake-lock");
				return;
			} catch (cause) {
				this.#deps.onWarning?.("Screen wake lock refused; falling back to a silent video.", cause);
			}
		}
		this.#startVideo();
	}

	/** The browser dropped the lock — typically because the tab was backgrounded. */
	#handleSentinelRelease(): void {
		this.#sentinel?.removeEventListener("release", this.#onRelease);
		this.#sentinel = undefined;
		if (this.#mode === "wake-lock") this.#setMode(null);
		if (!this.#active) return;
		// Visible means the drop was not a backgrounding: take it again now.
		// Hidden means `visibilitychange` re-acquires when the page returns.
		if (this.#deps.isVisible()) void this.#acquire();
	}

	#handleVisibility(): void {
		if (!this.#active || !this.#deps.isVisible() || this.#sentinel) return;
		// Retries the lock first even while the video is running: a browser that
		// refused once (or had none) may grant it after the page is foregrounded.
		void this.#acquire();
	}

	#startVideo(): void {
		if (!this.#active) return;
		this.#video ??= this.#deps.createSilentVideo?.();
		if (!this.#video) {
			this.#setMode(null);
			return;
		}
		this.#video.resume();
		this.#setMode("video");
	}

	#stopVideo(): void {
		const video = this.#video;
		this.#video = undefined;
		if (!video) return;
		try {
			video.stop();
		} catch (cause) {
			this.#deps.onWarning?.("Tearing down the wake-lock fallback video failed.", cause);
		}
		if (this.#mode === "video") this.#setMode(null);
	}

	async #releaseSentinel(): Promise<void> {
		const sentinel = this.#sentinel;
		this.#sentinel = undefined;
		if (!sentinel) return;
		sentinel.removeEventListener("release", this.#onRelease);
		try {
			await sentinel.release();
		} catch (cause) {
			this.#deps.onWarning?.("Releasing the screen wake lock failed.", cause);
		}
	}

	#setMode(mode: ScreenWakeMode): void {
		if (this.#mode === mode) return;
		this.#mode = mode;
		this.#deps.onMode?.(mode);
	}
}

/**
 * Bundled fallback asset: a 16×16, two-frame H.264 loop with no audio track at
 * all (~1.5 KB). The bundler emits it next to the document and hands back its
 * URL, so it resolves the same in `bun ./index.html` and in the built `dist/`.
 */
export const SILENT_VIDEO_SRC: string = silentLoopVideo;

/** Wire a guard to the real browser: `navigator.wakeLock`, `document`, a hidden video. */
export function browserScreenWakeDeps(options: { videoSrc?: string } = {}): ScreenWakeDeps {
	const src = options.videoSrc ?? SILENT_VIDEO_SRC;
	const wakeLock: WakeLock | undefined = navigator.wakeLock;
	return {
		requestWakeLock: wakeLock ? () => wakeLock.request("screen") : undefined,
		createSilentVideo: () => createSilentVideo(src),
		isVisible: () => document.visibilityState === "visible",
		onVisibilityChange(listener) {
			document.addEventListener("visibilitychange", listener);
			return () => document.removeEventListener("visibilitychange", listener);
		},
	};
}

/**
 * A 1px, inaudible, looping video. `playsInline` is mandatory: without it iOS
 * hands the video to the fullscreen native player and takes over the call UI.
 * The element is hidden by size and opacity rather than `display:none`, which
 * WebKit treats as "not rendered" and refuses to play.
 */
function createSilentVideo(src: string): SilentVideoLoop {
	const el = document.createElement("video");
	el.src = src;
	el.loop = true;
	el.autoplay = true;
	el.playsInline = true;
	el.muted = true;
	el.defaultMuted = true;
	el.volume = 0;
	el.preload = "auto";
	// Older WebKit reads the attributes, not the properties, at load time.
	el.setAttribute("muted", "");
	el.setAttribute("playsinline", "");
	el.setAttribute("webkit-playsinline", "");
	// Keep AirPlay/Cast from routing the "call" to a TV mid-conversation.
	el.disableRemotePlayback = true;
	el.setAttribute("aria-hidden", "true");
	el.tabIndex = -1;
	el.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;";
	document.body.appendChild(el);
	return {
		resume() {
			// Autoplay of a muted, inline video is allowed; a rejection here only
			// means the fallback is unavailable, never that the call is broken.
			void el.play().catch(() => {});
		},
		stop() {
			el.pause();
			el.removeAttribute("src");
			el.load();
			el.remove();
		},
	};
}
