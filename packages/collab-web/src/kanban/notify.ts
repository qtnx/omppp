import type { KanbanActivity } from "./types";
import { ACTIVITY_LABELS, activityDetail } from "./view-model";

const PERMISSION_KEY = "omp-kanban-notify";

/**
 * The Notification API is exposed on every modern browser but only *works* in a
 * secure context: https, or localhost. The board is routinely opened over plain
 * http on a tailnet address, where `requestPermission()` never grants and the
 * constructor is a no-op. Reporting "supported" there leaves the user a toggle
 * that flips but never notifies, so the secure-context check is part of support.
 */
export function notificationsSupported(): boolean {
	return typeof Notification !== "undefined" && globalThis.isSecureContext === true;
}

export function notificationsEnabled(): boolean {
	if (!notificationsSupported()) return false;
	try {
		return globalThis.localStorage.getItem(PERMISSION_KEY) === "on" && Notification.permission === "granted";
	} catch {
		return Notification.permission === "granted";
	}
}

/** Asks once, then remembers the choice so the board never nags on reload. */
export async function enableNotifications(): Promise<boolean> {
	if (!notificationsSupported()) return false;
	const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
	const granted = permission === "granted";
	try {
		globalThis.localStorage.setItem(PERMISSION_KEY, granted ? "on" : "off");
	} catch {
		// Private-mode storage refusal must not block the notification itself.
	}
	return granted;
}

export function disableNotifications(): void {
	try {
		globalThis.localStorage.setItem(PERMISSION_KEY, "off");
	} catch {
		// Nothing to persist; the in-memory permission still applies.
	}
}

/**
 * Fires a desktop notification for a board change this browser did not make.
 * Silent while the tab is focused: the board is already visible there.
 */
export function notifyBoardEvent(event: KanbanActivity): void {
	if (!notificationsEnabled()) return;
	if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) return;
	const detail = activityDetail(event);
	try {
		const notification = new Notification(ACTIVITY_LABELS[event.type], {
			body: detail || "The board changed.",
			tag: `kanban-${event.taskId ?? event.id}`,
			icon: "/favicon-192x192.png",
		});
		notification.onclick = () => {
			globalThis.focus();
			notification.close();
		};
	} catch {
		// Notification construction can throw on unsupported platforms; the
		// board update itself already landed, so this stays best-effort.
	}
}

const SOUND_KEY = "omp-kanban-sound";
const BASE_TITLE = "Kanban board | OMPx";

/** Sound defaults ON: a board you are not looking at is the whole point of it. */
export function soundEnabled(): boolean {
	try {
		return globalThis.localStorage.getItem(SOUND_KEY) !== "off";
	} catch {
		return true;
	}
}

export function setSoundEnabled(enabled: boolean): void {
	try {
		globalThis.localStorage.setItem(SOUND_KEY, enabled ? "on" : "off");
	} catch {
		// Private-mode storage refusal must not break the toggle for this session.
	}
}

let audioContext: AudioContext | null = null;

/**
 * Two-note chime, synthesised rather than shipped as an audio file: the board
 * bundle stays asset-free and there is nothing to keep in sync with the theme.
 * Best-effort — a blocked or unsupported AudioContext must never break an event.
 */
export function playBoardChime(): void {
	if (!soundEnabled()) return;
	try {
		audioContext ??= new AudioContext();
		if (audioContext.state === "suspended") void audioContext.resume();
		const start = audioContext.currentTime;
		const gain = audioContext.createGain();
		gain.gain.setValueAtTime(0.0001, start);
		gain.gain.exponentialRampToValueAtTime(0.09, start + 0.012);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
		gain.connect(audioContext.destination);
		for (const [index, frequency] of [880, 1320].entries()) {
			const oscillator = audioContext.createOscillator();
			const at = start + index * 0.08;
			oscillator.type = "sine";
			oscillator.frequency.setValueAtTime(frequency, at);
			oscillator.connect(gain);
			oscillator.start(at);
			oscillator.stop(at + 0.14);
		}
	} catch {
		// Audio is a nicety; the toast already carried the message.
	}
}

interface IconLinkState {
	link: HTMLLinkElement;
	href: string;
	type: string;
}

let originalIcons: IconLinkState[] | null = null;
let badgedIconHref: string | null = null;

/**
 * Paints the existing favicon into a canvas and stamps an accent dot on it, so
 * the badge always matches whatever icon the page actually ships.
 */
async function buildBadgedIcon(href: string): Promise<string | null> {
	try {
		const image = new Image();
		image.src = href;
		await image.decode();
		const size = 64;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const context = canvas.getContext("2d");
		if (!context) return null;
		context.drawImage(image, 0, 0, size, size);
		context.beginPath();
		context.arc(size - 16, 16, 15, 0, Math.PI * 2);
		context.fillStyle = "#ed4abf";
		context.fill();
		context.lineWidth = 5;
		context.strokeStyle = "#0f0b14";
		context.stroke();
		return canvas.toDataURL("image/png");
	} catch {
		return null;
	}
}

function applyIconBadge(badged: boolean): void {
	originalIcons ??= [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map(link => ({
		link,
		href: link.href,
		type: link.type,
	}));
	if (originalIcons.length === 0) return;
	if (!badged) {
		for (const icon of originalIcons) {
			icon.link.type = icon.type;
			icon.link.href = icon.href;
		}
		return;
	}
	const paint = (href: string): void => {
		for (const icon of originalIcons ?? []) {
			icon.link.type = "image/png";
			icon.link.href = href;
		}
	};
	if (badgedIconHref) {
		paint(badgedIconHref);
		return;
	}
	// Prefer a raster source: an SVG icon can taint or fail to decode in canvas.
	const source = originalIcons.find(icon => icon.type === "image/png") ?? originalIcons[0];
	if (!source) return;
	void buildBadgedIcon(source.href).then(href => {
		if (!href) return;
		badgedIconHref = href;
		paint(href);
	});
}

/**
 * Reflects unseen board activity in the places a backgrounded tab still shows:
 * the title and the favicon. Zero restores both.
 */
export function setBoardAttention(unseen: number): void {
	document.title = unseen > 0 ? `(${unseen}) ${BASE_TITLE}` : BASE_TITLE;
	applyIconBadge(unseen > 0);
}
