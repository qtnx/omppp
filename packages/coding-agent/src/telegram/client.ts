import {
	TELEGRAM_API_ORIGIN,
	TELEGRAM_REQUEST_TIMEOUT_MS,
	type TelegramApiFailure,
	type TelegramBotClientContract,
	type TelegramMessage,
	type TelegramMethod,
	type TelegramUpdate,
	type TelegramUser,
	type TelegramWebhookInfo,
} from "./types";

const TELEGRAM_TOKEN_PATTERN = /^\d{1,20}:[A-Za-z0-9_-]{35}$/;
const TELEGRAM_METHODS: Record<TelegramMethod, true> = {
	getMe: true,
	getWebhookInfo: true,
	getUpdates: true,
	sendMessage: true,
};
const MAX_RETRY_AFTER_MS = 300_000;
const FAILURE_MESSAGE = "Telegram Bot API request failed";

type TelegramFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type TelegramBotClientOptions = {
	fetch?: TelegramFetch;
	origin?: string;
	timeoutMs?: number;
};

type ErrorOptions = Omit<TelegramApiFailure, "name">;

export class TelegramApiError extends Error implements TelegramApiFailure {
	readonly name = "TelegramApiError" as const;
	readonly method: TelegramMethod;
	readonly httpStatus?: number;
	readonly errorCode?: number;
	readonly retryAfterMs?: number;
	readonly transport?: boolean;
	readonly ambiguous: boolean;

	constructor(options: ErrorOptions) {
		super(FAILURE_MESSAGE);
		this.method = options.method;
		this.ambiguous = options.ambiguous;
		if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
		if (options.errorCode !== undefined) this.errorCode = options.errorCode;
		if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
		if (options.transport === true) this.transport = true;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
	return Math.min(value, MAX_RETRY_AFTER_MS / 1_000) * 1_000;
}

function isTelegramUser(value: unknown): value is TelegramUser {
	return (
		isRecord(value) &&
		typeof value.id === "number" &&
		Number.isFinite(value.id) &&
		typeof value.is_bot === "boolean" &&
		(value.username === undefined || typeof value.username === "string")
	);
}

function isTelegramWebhookInfo(value: unknown): value is TelegramWebhookInfo {
	return isRecord(value) && typeof value.url === "string";
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
	return (
		isRecord(value) &&
		typeof value.message_id === "number" &&
		Number.isFinite(value.message_id) &&
		(value.text === undefined || typeof value.text === "string") &&
		isRecord(value.chat) &&
		typeof value.chat.id === "number" &&
		Number.isFinite(value.chat.id) &&
		typeof value.chat.type === "string"
	);
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
	return (
		isRecord(value) &&
		typeof value.update_id === "number" &&
		Number.isFinite(value.update_id) &&
		(value.message === undefined || isTelegramMessage(value.message))
	);
}

function toTelegramUser(value: TelegramUser): TelegramUser {
	return value.username === undefined
		? { id: value.id, is_bot: value.is_bot }
		: { id: value.id, is_bot: value.is_bot, username: value.username };
}

function toTelegramWebhookInfo(value: TelegramWebhookInfo): TelegramWebhookInfo {
	return { url: value.url };
}

function toTelegramMessage(value: TelegramMessage): TelegramMessage {
	const message = {
		message_id: value.message_id,
		chat: { id: value.chat.id, type: value.chat.type },
	};
	return value.text === undefined ? message : { ...message, text: value.text };
}

function toTelegramUpdate(value: TelegramUpdate): TelegramUpdate {
	return value.message === undefined
		? { update_id: value.update_id }
		: { update_id: value.update_id, message: toTelegramMessage(value.message) };
}

export class TelegramBotClient implements TelegramBotClientContract {
	#token: string;
	#fetch: TelegramFetch;
	#origin: string;
	#timeoutMs: number;

	constructor(token: string, options: TelegramBotClientOptions = {}) {
		this.#token = token;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#origin = options.origin ?? TELEGRAM_API_ORIGIN;
		this.#timeoutMs = options.timeoutMs ?? TELEGRAM_REQUEST_TIMEOUT_MS;
	}

	async getMe(signal?: AbortSignal): Promise<TelegramUser> {
		const result = await this.#request("getMe", {}, isTelegramUser, signal);
		return toTelegramUser(result);
	}

	async getWebhookInfo(signal?: AbortSignal): Promise<TelegramWebhookInfo> {
		const result = await this.#request("getWebhookInfo", {}, isTelegramWebhookInfo, signal);
		return toTelegramWebhookInfo(result);
	}

	async getUpdates(options: {
		offset?: number;
		limit?: number;
		timeoutSeconds: number;
		allowedUpdates: readonly string[];
		signal?: AbortSignal;
	}): Promise<TelegramUpdate[]> {
		const body: Record<string, unknown> = {};
		if (options.offset !== undefined) body.offset = options.offset;
		if (options.limit !== undefined) body.limit = options.limit;
		body.timeout = options.timeoutSeconds;
		body.allowed_updates = options.allowedUpdates;
		const result = await this.#request(
			"getUpdates",
			body,
			(value): value is TelegramUpdate[] => Array.isArray(value) && value.every(isTelegramUpdate),
			options.signal,
		);
		return result.map(toTelegramUpdate);
	}

	async sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<void> {
		await this.#request("sendMessage", { chat_id: chatId, text }, isRecord, signal);
	}

	async #request<Result>(
		method: TelegramMethod,
		body: Record<string, unknown>,
		isResult: (value: unknown) => value is Result,
		signal?: AbortSignal,
	): Promise<Result> {
		if (!TELEGRAM_METHODS[method] || !TELEGRAM_TOKEN_PATTERN.test(this.#token)) {
			throw new TelegramApiError({ method, ambiguous: false });
		}
		if (signal?.aborted) {
			throw new TelegramApiError({ method, ambiguous: false, transport: true });
		}

		const timeoutSignal = AbortSignal.timeout(Math.max(0, this.#timeoutMs));
		const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
		const ambiguous = method === "sendMessage";
		let response: Response;
		try {
			response = await this.#fetchWithAbort(
				`${this.#origin}/bot${this.#token}/${method}`,
				{
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8" },
					body: JSON.stringify(body),
					redirect: "error",
					signal: requestSignal,
				},
				requestSignal,
			);
		} catch {
			throw new TelegramApiError({ method, ambiguous, transport: true });
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new TelegramApiError({ method, httpStatus: response.status, ambiguous });
		}

		if (!isRecord(payload) || typeof payload.ok !== "boolean") {
			throw new TelegramApiError({ method, httpStatus: response.status, ambiguous });
		}
		if (!payload.ok) {
			throw new TelegramApiError({
				method,
				httpStatus: response.status,
				errorCode:
					typeof payload.error_code === "number" &&
					Number.isSafeInteger(payload.error_code) &&
					payload.error_code >= 0
						? payload.error_code
						: undefined,
				retryAfterMs: isRecord(payload.parameters) ? retryAfterMs(payload.parameters.retry_after) : undefined,
				ambiguous: false,
			});
		}
		if (!response.ok) throw new TelegramApiError({ method, httpStatus: response.status, ambiguous });
		if (!isResult(payload.result)) {
			throw new TelegramApiError({ method, httpStatus: response.status, ambiguous: false });
		}
		return payload.result;
	}

	async #fetchWithAbort(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
		if (signal.aborted) throw signal.reason;
		const { promise, reject } = Promise.withResolvers<Response>();
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([this.#fetch(url, init), promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

export function createTelegramBotClient(token: string): TelegramBotClient {
	return new TelegramBotClient(token);
}
