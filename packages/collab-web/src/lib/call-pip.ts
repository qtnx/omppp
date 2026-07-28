/**
 * Floats the call over other apps, as far as the web platform allows.
 *
 * On Android Chrome the *only* always-on-top surface a plain PWA can get is
 * classic video Picture-in-Picture (`HTMLVideoElement.requestPictureInPicture`,
 * Android since Chrome 105). Document PiP — arbitrary DOM in a floating window —
 * is desktop-only, so the call state is painted into a `<canvas>`, captured with
 * `canvas.captureStream()`, and that stream is what goes into PiP.
 *
 * Consequences worth knowing before touching this:
 * - entering PiP requires a user gesture, so it is a button, never automatic;
 * - the PiP window itself takes no custom DOM controls — mute and hang-up reach
 *   it through the Media Session actions in `call-presence.ts`;
 * - the canvas is the whole UI, so every state change has to be redrawn.
 */

export interface CallPipState {
	title: string;
	/** Phase line: "Listening", "Speaking", … */
	status: string;
	muted: boolean;
}

/** The floating surface: a canvas painted into a video that PiP can host. */
export interface PipSurface {
	draw(state: CallPipState): void;
	enter(): Promise<void>;
	exit(): Promise<void>;
	/** Release the canvas, the capture stream, and the video element. */
	dispose(): void;
	/** The user closed the window from the system UI. */
	onLeave(listener: () => void): void;
}

export interface CallPipDeps {
	supported(): boolean;
	createSurface(): PipSurface;
	onActiveChange?(active: boolean): void;
	onWarning?(message: string, cause?: unknown): void;
}

export class CallPip {
	readonly #deps: CallPipDeps;
	#surface: PipSurface | undefined;
	#active = false;

	constructor(deps: CallPipDeps) {
		this.#deps = deps;
	}

	get supported(): boolean {
		return this.#deps.supported();
	}

	get active(): boolean {
		return this.#active;
	}

	/** Enter PiP. MUST be called from a user gesture; false means "not available". */
	async enter(state: CallPipState): Promise<boolean> {
		if (this.#active || !this.#deps.supported()) return false;
		const surface = this.#deps.createSurface();
		this.#surface = surface;
		surface.onLeave(() => this.#handleLeave());
		try {
			surface.draw(state);
			await surface.enter();
		} catch (cause) {
			this.#deps.onWarning?.("The call could not enter picture-in-picture.", cause);
			this.#teardown();
			return false;
		}
		this.#active = true;
		this.#deps.onActiveChange?.(true);
		return true;
	}

	/** Repaint the floating window; a no-op while it is closed. */
	update(state: CallPipState): void {
		if (!this.#active) return;
		try {
			this.#surface?.draw(state);
		} catch (cause) {
			this.#deps.onWarning?.("Repainting the picture-in-picture window failed.", cause);
		}
	}

	/** Close and release. Safe to call repeatedly and from call teardown. */
	async exit(): Promise<void> {
		const surface = this.#surface;
		if (!surface) return;
		try {
			if (this.#active) await surface.exit();
		} catch (cause) {
			this.#deps.onWarning?.("Leaving picture-in-picture failed.", cause);
		}
		this.#teardown();
	}

	/** System-initiated close: the window is already gone, only release locally. */
	#handleLeave(): void {
		if (!this.#surface) return;
		this.#teardown();
	}

	#teardown(): void {
		const surface = this.#surface;
		this.#surface = undefined;
		const wasActive = this.#active;
		this.#active = false;
		try {
			surface?.dispose();
		} catch (cause) {
			this.#deps.onWarning?.("Releasing the picture-in-picture surface failed.", cause);
		}
		if (wasActive) this.#deps.onActiveChange?.(false);
	}
}

const PIP_WIDTH = 480;
const PIP_HEIGHT = 270;
/** One frame per second is plenty for a status card and costs almost nothing. */
const PIP_FPS = 1;

/** Wire a `CallPip` to the real browser. */
export function browserCallPipDeps(
	options: Partial<Pick<CallPipDeps, "onActiveChange" | "onWarning">> = {},
): CallPipDeps {
	return {
		supported: () =>
			typeof document !== "undefined" &&
			document.pictureInPictureEnabled === true &&
			typeof HTMLVideoElement.prototype.requestPictureInPicture === "function",
		createSurface: () => createPipSurface(),
		...options,
	};
}

function createPipSurface(): PipSurface {
	const canvas = document.createElement("canvas");
	canvas.width = PIP_WIDTH;
	canvas.height = PIP_HEIGHT;
	const ctx = canvas.getContext("2d");

	const video = document.createElement("video");
	video.muted = true;
	video.defaultMuted = true;
	video.playsInline = true;
	video.autoplay = true;
	video.setAttribute("aria-hidden", "true");
	video.tabIndex = -1;
	// Rendered but out of sight: WebKit and Blink both refuse to play a video
	// that was never laid out, and PiP needs a playing video.
	video.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;";

	const stream = canvas.captureStream(PIP_FPS);
	video.srcObject = stream;
	document.body.appendChild(video);

	return {
		draw(state) {
			if (!ctx) return;
			ctx.fillStyle = "#0f0b14";
			ctx.fillRect(0, 0, PIP_WIDTH, PIP_HEIGHT);
			ctx.fillStyle = "#c7a7f5";
			ctx.font = "600 22px system-ui, sans-serif";
			ctx.fillText(truncateToCanvas(ctx, state.title, PIP_WIDTH - 48), 24, 76);
			ctx.fillStyle = "#f3ecff";
			ctx.font = "34px system-ui, sans-serif";
			ctx.fillText(state.status, 24, 136);
			ctx.fillStyle = state.muted ? "#ff8a8a" : "#8ce0a8";
			ctx.font = "24px system-ui, sans-serif";
			ctx.fillText(state.muted ? "Mic muted" : "Mic live", 24, 190);
			ctx.fillStyle = "#8b7fa3";
			ctx.font = "18px system-ui, sans-serif";
			ctx.fillText("omp collab voice", 24, 232);
		},
		async enter() {
			await video.play();
			await video.requestPictureInPicture();
		},
		async exit() {
			if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
		},
		dispose() {
			video.pause();
			for (const track of stream.getTracks()) track.stop();
			video.srcObject = null;
			video.remove();
		},
		onLeave(listener) {
			video.addEventListener("leavepictureinpicture", listener, { once: true });
		},
	};
}

/** Trim a title to the canvas width, ellipsis included, without measuring twice per frame. */
function truncateToCanvas(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let cut = text;
	while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
	return `${cut}…`;
}
