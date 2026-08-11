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
const SAFE_TRANSPORT_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TELEGRAM_METHODS: Record<TelegramMethod, true> = {
	getMe: true,
	getWebhookInfo: true,
	getUpdates: true,
	sendMessage: true,
};
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_SAFE_DESCRIPTION_LENGTH = 240;
const MAX_TRANSPORT_CAUSE_DEPTH = 8;
const REDACTED_VALUE = "[REDACTED]";

type TelegramFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type TelegramBotClientOptions = {
	fetch?: TelegramFetch;
	origin?: string;
	timeoutMs?: number;
};

type ErrorOptions = Omit<TelegramApiFailure, "name">;

export class TelegramApiError extends Error implements TelegramApiFailure {
	override readonly name = "TelegramApiError" as const;
	readonly method: TelegramMethod;
	readonly httpStatus?: number;
	readonly errorCode?: number;
	readonly retryAfterMs?: number;
	readonly transport?: boolean;
	readonly description?: string;
	readonly transportCode?: string;
	readonly invalidToken?: boolean;
	readonly ambiguous: boolean;

	constructor(options: ErrorOptions) {
		super(telegramApiFailureMessage(options));
		this.method = options.method;
		this.ambiguous = options.ambiguous;
		if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
		if (options.errorCode !== undefined) this.errorCode = options.errorCode;
		if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
		if (options.transport === true) this.transport = true;
		if (options.description !== undefined) this.description = options.description;
		if (options.transportCode !== undefined) this.transportCode = options.transportCode;
		if (options.invalidToken === true) this.invalidToken = true;
	}
}

export function isValidTelegramBotToken(token: string): boolean {
	return TELEGRAM_TOKEN_PATTERN.test(token);
}

export function telegramApiErrorMessage(error: unknown): string | undefined {
	return error instanceof TelegramApiError ? error.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function telegramApiFailureMessage(options: ErrorOptions): string {
	const prefix = `Telegram Bot API ${options.method} failed`;
	if (options.transport === true) {
		return options.transportCode === undefined
			? `${prefix}: transport failure`
			: `${prefix}: transport failure (${options.transportCode})`;
	}

	const details: string[] = [];
	if (options.invalidToken === true) details.push("invalid OMP_TELEGRAM_BOT_TOKEN");
	if (options.httpStatus !== undefined) details.push(`HTTP ${options.httpStatus}`);
	if (options.errorCode !== undefined) details.push(`Telegram ${options.errorCode}`);
	if (
		options.method === "sendMessage" &&
		(options.httpStatus === 400 || options.errorCode === 400) &&
		options.description?.toLowerCase().includes("chat not found")
	) {
		details.push("OMP_TELEGRAM_ALLOWED_CHAT_ID is unreachable or incorrect");
	}
	if (options.method === "getUpdates" && (options.httpStatus === 409 || options.errorCode === 409)) {
		details.push("another poller is using the same bot token");
	}
	if (options.description !== undefined) details.push(options.description);
	return details.length === 0 ? prefix : `${prefix}: ${details.join("; ")}`;
}

function errorProperty(value: Record<string, unknown>, property: string): unknown {
	try {
		return value[property];
	} catch {
		return undefined;
	}
}

function extractTransportCode(error: unknown): string | undefined {
	const seen = new Set<object>();
	let current = error;
	for (let depth = 0; depth < MAX_TRANSPORT_CAUSE_DEPTH; depth++) {
		if (!isRecord(current) || seen.has(current)) return undefined;
		seen.add(current);

		const code = errorProperty(current, "code");
		if (typeof code === "string" && SAFE_TRANSPORT_CODE_PATTERN.test(code)) return code;

		const name = errorProperty(current, "name");
		if (name === "AbortError" || name === "TimeoutError") return name;

		current = errorProperty(current, "cause");
	}
	return undefined;
}

function redactDescriptionValues(value: string, values: readonly string[]): string {
	let redacted = value;
	for (const secret of values) {
		const normalizedSecret = secret.replace(/[\s\x00-\x1F\x7F-\x9F]+/g, " ").trim();
		if (normalizedSecret !== "") redacted = redacted.split(normalizedSecret).join(REDACTED_VALUE);
	}
	return redacted;
}

function telegramDescription(value: unknown, token: string, body: Record<string, unknown>): string | undefined {
	if (typeof value !== "string") return undefined;

	const sensitiveValues = [token];
	if (typeof body.text === "string") sensitiveValues.push(body.text);
	if (typeof body.chat_id === "number" && Number.isFinite(body.chat_id)) {
		sensitiveValues.push(String(body.chat_id));
	}

	const normalizedDescription = value.replace(/[\s\x00-\x1F\x7F-\x9F]+/g, " ").trim();
	const description = redactDescriptionValues(normalizedDescription, sensitiveValues);
	return description === "" ? undefined : description.slice(0, MAX_SAFE_DESCRIPTION_LENGTH);
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
		if (!TELEGRAM_METHODS[method]) {
			throw new TelegramApiError({ method, ambiguous: false });
		}
		if (!isValidTelegramBotToken(this.#token)) {
			throw new TelegramApiError({ method, ambiguous: false, invalidToken: true });
		}
		if (signal?.aborted) {
			throw new TelegramApiError({
				method,
				ambiguous: false,
				transport: true,
				transportCode: extractTransportCode(signal.reason),
			});
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
		} catch (error) {
			throw new TelegramApiError({
				method,
				ambiguous,
				transport: true,
				transportCode: extractTransportCode(error),
			});
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
			const errorCode =
				typeof payload.error_code === "number" &&
				Number.isSafeInteger(payload.error_code) &&
				payload.error_code >= 0
					? payload.error_code
					: undefined;
			throw new TelegramApiError({
				method,
				httpStatus: response.status,
				errorCode,
				retryAfterMs: isRecord(payload.parameters) ? retryAfterMs(payload.parameters.retry_after) : undefined,
				description: telegramDescription(payload.description, this.#token, body),
				invalidToken: method === "getMe" && (response.status === 401 || errorCode === 401),
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
