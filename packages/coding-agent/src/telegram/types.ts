import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../session/agent-session";

export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
export const TELEGRAM_LONG_POLL_SECONDS = 30;
export const TELEGRAM_REQUEST_TIMEOUT_MS = 35_000;
export const TELEGRAM_MESSAGE_CHUNK_CODE_POINTS = 4_000;
export const TELEGRAM_MAX_OUTBOUND_CHUNKS = 32;
export const TELEGRAM_MAX_SEND_RATE_LIMIT_ATTEMPTS = 5;
export const TELEGRAM_MAX_SEND_RATE_LIMIT_WAIT_MS = 300_000;

export type TelegramBridgePhase = "disconnected" | "connecting" | "connected" | "retrying" | "stopping" | "failed";

export type TelegramMethod = "getMe" | "getWebhookInfo" | "getUpdates" | "sendMessage";

export interface TelegramApiFailure {
	readonly name: "TelegramApiError";
	readonly method: TelegramMethod;
	readonly httpStatus?: number;
	readonly errorCode?: number;
	readonly retryAfterMs?: number;
	readonly transport?: boolean;
	readonly ambiguous: boolean;
}

export interface TelegramBridgeStatus {
	phase: TelegramBridgePhase;
	botUsername?: string;
	message?: string;
	retryAfterMs?: number;
}

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	username?: string;
}

export interface TelegramWebhookInfo {
	url: string;
}

export interface TelegramMessage {
	message_id: number;
	text?: string;
	chat: { id: number; type: string };
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramBotClientContract {
	getMe(signal?: AbortSignal): Promise<TelegramUser>;
	getWebhookInfo(signal?: AbortSignal): Promise<TelegramWebhookInfo>;
	getUpdates(options: {
		offset?: number;
		limit?: number;
		timeoutSeconds: number;
		allowedUpdates: readonly string[];
		signal?: AbortSignal;
	}): Promise<TelegramUpdate[]>;
	sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<void>;
}

export interface TelegramSessionContract {
	readonly sessionId: string;
	/** Resolves true once queued, false when preflight rejects; rejection also guarantees no queue mutation. */
	enqueueUserMessage(
		content: string | (TextContent | ImageContent)[],
		deliverAs: "steer" | "followUp",
		signal?: AbortSignal,
	): Promise<boolean>;
	subscribe(listener: Parameters<AgentSession["subscribe"]>[0]): () => void;
}

export interface TelegramBridgeOptions {
	client: TelegramBotClientContract;
	session: TelegramSessionContract;
	allowedChatId: number;
	extractAssistantText(message: AssistantMessage): string;
	onStatus(status: TelegramBridgeStatus): void;
	delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	random?: () => number;
}

export interface TelegramBridgeHandle {
	readonly status: TelegramBridgeStatus;
	start(): Promise<void>;
	stop(): Promise<void>;
	dispose(): void;
}

export interface TelegramBridgeFactoryOptions extends Omit<TelegramBridgeOptions, "client"> {
	token: string;
}

export type CreateTelegramBridge = (options: TelegramBridgeFactoryOptions) => TelegramBridgeHandle;
