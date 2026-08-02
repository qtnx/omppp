import { settings } from "../config/settings";
import { type HerdrJsonRequest, herdrSocketPath, isHerdrPane, sendHerdrRequest } from "./socket";

export type HerdrNotifySound = "none" | "done" | "request";
export type HerdrNotifyPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface HerdrNotifyOptions {
	title: string;
	body?: string;
	sound?: HerdrNotifySound;
	position?: HerdrNotifyPosition;
}

export interface HerdrNotifyResult {
	sent: boolean;
	shown?: boolean;
	reason?: string;
}

export interface HerdrNotifySettings {
	done: boolean;
	blocked: boolean;
	sound: HerdrNotifySound;
	position?: HerdrNotifyPosition;
	minWorkMs: number;
}

export function buildNotificationRequest(
	options: HerdrNotifyOptions,
	id = `herdr-notification-${crypto.randomUUID()}`,
): HerdrJsonRequest {
	const params: Record<string, unknown> = { title: options.title };
	if (options.body !== undefined) params.body = options.body;
	if (options.sound !== undefined) params.sound = options.sound;
	if (options.position !== undefined) params.position = options.position;
	return { id, method: "notification.show", params };
}

export function readHerdrNotifySettings(): HerdrNotifySettings {
	return {
		done: settings.get("herdr.notify.done"),
		blocked: settings.get("herdr.notify.blocked"),
		sound: settings.get("herdr.notify.sound"),
		minWorkMs: settings.get("herdr.notify.minWorkMs"),
	};
}

/** No-op returning `{ sent:false, reason:"not_in_herdr" }` outside a herdr pane. */
export async function showHerdrNotification(
	options: HerdrNotifyOptions,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrNotifyResult> {
	if (options.title.trim().length === 0) return { sent: false, reason: "empty_title" };
	if (!isHerdrPane(env)) return { sent: false, reason: "not_in_herdr" };

	const socketPath = herdrSocketPath(env);
	if (!socketPath) return { sent: false, reason: "not_in_herdr" };
	const response = await sendHerdrRequest(socketPath, buildNotificationRequest(options));
	if (!response) return { sent: false, reason: "request_failed" };

	const shown = typeof response.result?.shown === "boolean" ? response.result.shown : undefined;
	const resultReason = typeof response.result?.reason === "string" ? response.result.reason : undefined;
	const errorReason = response.error?.message ?? response.error?.code;
	return { sent: true, shown, reason: resultReason ?? errorReason };
}
