import type { KanbanActivity } from "./types";
import { ACTIVITY_LABELS, activityDetail } from "./view-model";

const PERMISSION_KEY = "omp-kanban-notify";

export function notificationsSupported(): boolean {
	return typeof Notification !== "undefined";
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
