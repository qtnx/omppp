import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import {
	createTelegramBotClient,
	isValidTelegramBotToken,
	TelegramApiError,
	TelegramBotClient,
	telegramApiErrorMessage,
} from "../../src/telegram/client";

const TOKEN = "123456789:AA_SENTINEL_TOKEN_MUST_NEVER_APPEAR";
const ORIGIN = "https://telegram.test";
const SAFE_DESCRIPTION = "Bad Request: chat not found";
const ARBITRARY_TRANSPORT_TEXT = "untrusted transport failure detail";

const CONTENT = "private Telegram content";
const RAW_DESCRIPTION = "raw Telegram description";

type FetchCall = {
	input: string | URL | Request;
	init?: RequestInit;
};

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeClient(fetch: FetchStub, timeoutMs = 50): TelegramBotClient {
	return new TelegramBotClient(TOKEN, { fetch, origin: ORIGIN, timeoutMs });
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function assertSafeFailure(error: unknown, sensitiveValues: readonly string[] = [TOKEN]): TelegramApiError {
	expect(error).toBeInstanceOf(TelegramApiError);
	const apiError = error as TelegramApiError;

	expect(apiError.cause).toBeUndefined();
	for (const sensitiveValue of sensitiveValues) {
		expect(JSON.stringify(apiError)).not.toContain(sensitiveValue);
		expect(String(apiError)).not.toContain(sensitiveValue);
		expect(apiError.stack).not.toContain(sensitiveValue);
		for (const value of Object.values(apiError)) expect(String(value)).not.toContain(sensitiveValue);
	}
	return apiError;
}

async function expectFailure(
	operation: () => Promise<unknown>,
	sensitiveValues: readonly string[] = [TOKEN],
): Promise<TelegramApiError> {
	const output: string[] = [];
	const spies = ["error", "warn", "log"].map(method =>
		spyOn(console, method as "error").mockImplementation((...values: unknown[]) => {
			output.push(values.map(String).join(" "));
		}),
	);
	try {
		const error = await operation().then(
			() => undefined,
			failure => failure,
		);
		const apiError = assertSafeFailure(error, sensitiveValues);
		for (const sensitiveValue of sensitiveValues) expect(output.join("\n")).not.toContain(sensitiveValue);
		return apiError;
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
}

afterEach(() => {
	// Protect unrelated Bun tests if a test fails before restoring a console spy.
	vi.restoreAllMocks();
});

describe("TelegramBotClient", () => {
	test("exports safe Telegram error helpers", () => {
		const error = new TelegramApiError({ method: "getMe", ambiguous: false });

		expect(isValidTelegramBotToken(TOKEN)).toBe(true);
		expect(isValidTelegramBotToken("not-a-token")).toBe(false);
		expect(telegramApiErrorMessage(error)).toBe(error.message);
		expect(telegramApiErrorMessage(new Error(error.message))).toBeUndefined();
	});

	test("posts the exact getMe request and returns a typed bot user", async () => {
		const calls: FetchCall[] = [];
		const client = makeClient(async (input, init) => {
			calls.push({ input, init });
			return response({ ok: true, result: { id: 1, is_bot: true, username: "bridge_bot" } });
		});

		await expect(client.getMe()).resolves.toEqual({ id: 1, is_bot: true, username: "bridge_bot" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			input: `${ORIGIN}/bot${TOKEN}/getMe`,
			init: { method: "POST", redirect: "error", body: "{}" },
		});
	});

	test("posts the exact getWebhookInfo request and returns a typed webhook", async () => {
		const calls: FetchCall[] = [];
		const client = makeClient(async (input, init) => {
			calls.push({ input, init });
			return response({ ok: true, result: { url: "" } });
		});

		await expect(client.getWebhookInfo()).resolves.toEqual({ url: "" });
		expect(calls[0]).toMatchObject({
			input: `${ORIGIN}/bot${TOKEN}/getWebhookInfo`,
			init: { method: "POST", redirect: "error", body: "{}" },
		});
	});

	test("posts the exact bounded getUpdates request and returns typed updates", async () => {
		const calls: FetchCall[] = [];
		const client = makeClient(async (input, init) => {
			calls.push({ input, init });
			return response({
				ok: true,
				result: [{ update_id: 7, message: { message_id: 9, text: "hello", chat: { id: 4, type: "private" } } }],
			});
		});

		await expect(
			client.getUpdates({ offset: 8, limit: 2, timeoutSeconds: 30, allowedUpdates: ["message"] }),
		).resolves.toEqual([
			{ update_id: 7, message: { message_id: 9, text: "hello", chat: { id: 4, type: "private" } } },
		]);
		expect(calls[0]).toMatchObject({
			input: `${ORIGIN}/bot${TOKEN}/getUpdates`,
			init: {
				method: "POST",
				redirect: "error",
				body: JSON.stringify({ offset: 8, limit: 2, timeout: 30, allowed_updates: ["message"] }),
			},
		});
	});

	test("posts sendMessage without parse_mode", async () => {
		const calls: FetchCall[] = [];
		const client = makeClient(async (input, init) => {
			calls.push({ input, init });
			return response({ ok: true, result: { message_id: 9 } });
		});

		await expect(client.sendMessage(4, "*literal*")).resolves.toBeUndefined();
		expect(calls[0]).toMatchObject({
			input: `${ORIGIN}/bot${TOKEN}/sendMessage`,
			init: { method: "POST", redirect: "error", body: JSON.stringify({ chat_id: 4, text: "*literal*" }) },
		});
		expect(calls[0].init?.body).not.toContain("parse_mode");
	});

	test("uses only the locked Bot API method paths", async () => {
		const paths: string[] = [];
		const client = makeClient(async input => {
			const path = String(input);
			paths.push(path);
			return response({ ok: true, result: path.endsWith("/getUpdates") ? [] : {} });
		});

		await client.getMe().catch(() => undefined);
		await client.getWebhookInfo().catch(() => undefined);
		await client.getUpdates({ timeoutSeconds: 1, allowedUpdates: [] });
		await client.sendMessage(1, "x");
		expect(paths.map(path => path.slice(path.lastIndexOf("/") + 1)).sort()).toEqual([
			"getMe",
			"getUpdates",
			"getWebhookInfo",
			"sendMessage",
		]);
	});

	test.each([
		["getMe", (client: TelegramBotClient) => client.getMe(), { ok: true, result: { id: "wrong", is_bot: true } }],
		["getWebhookInfo", (client: TelegramBotClient) => client.getWebhookInfo(), { ok: true, result: { url: 42 } }],
		[
			"getUpdates",
			(client: TelegramBotClient) => client.getUpdates({ timeoutSeconds: 1, allowedUpdates: [] }),
			{ ok: true, result: [{ update_id: 1, message: { message_id: 2, chat: { id: "wrong", type: "private" } } }] },
		],
	])("rejects malformed successful %s results", async (_name, operation, payload) => {
		const error = await expectFailure(() => operation(makeClient(async () => response(payload))));
		expect(error).toMatchObject({ method: _name, ambiguous: false });
	});

	test.each([
		["non-JSON", async () => new Response("<html>"), 200],
		["malformed JSON", async () => new Response("{", { headers: { "content-type": "application/json" } }), 200],
		["HTTP error", async () => response({ description: TOKEN }, 502), 502],
		["API failure", async () => response({ ok: false, error_code: 400, description: TOKEN }), 200],
	])("sanitizes %s failures", async (_name, fetchResponse, httpStatus) => {
		const error = await expectFailure(() => makeClient(fetchResponse).getMe());
		expect(error).toMatchObject({ method: "getMe", ambiguous: false });
		expect(error.httpStatus).toBe(httpStatus);
	});

	test("retains a safe API rejection description while redacting request secrets", async () => {
		const error = await expectFailure(
			() =>
				makeClient(async () =>
					response(
						{
							ok: false,
							error_code: 400,
							description: `${SAFE_DESCRIPTION}\n${TOKEN}\t${CONTENT}`,
						},
						400,
					),
				).sendMessage(4, CONTENT),
			[TOKEN, CONTENT],
		);

		expect(error).toMatchObject({
			method: "sendMessage",
			httpStatus: 400,
			errorCode: 400,
			ambiguous: false,
		});
		expect(error.description).toContain(SAFE_DESCRIPTION);
		expect(error.description).not.toContain(TOKEN);
		expect(error.description).not.toContain(CONTENT);
		expect(error.description).not.toContain("\n");
		expect(error.message).toContain("sendMessage");
		expect(error.message).toContain("400");
		expect(error.message).toContain(SAFE_DESCRIPTION);
		expect(error.message).toContain("OMP_TELEGRAM_ALLOWED_CHAT_ID");
		expect(error.message).toContain("unreachable or incorrect");
	});

	test("classifies getMe 401 as an invalid bot token without leaking it", async () => {
		const error = await expectFailure(
			() =>
				makeClient(async () =>
					response({ ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` }, 401),
				).getMe(),
			[TOKEN],
		);

		expect(error).toMatchObject({
			method: "getMe",
			httpStatus: 401,
			errorCode: 401,
			invalidToken: true,
			ambiguous: false,
		});
		expect(error.description).toContain("Unauthorized");
		expect(error.description).not.toContain(TOKEN);
		expect(error.message).toContain("OMP_TELEGRAM_BOT_TOKEN");
		expect(error.message).toContain("401");
		expect(error.message).toContain("Unauthorized");
	});

	test("retains a sanitized HTTP 429 envelope and capped retry metadata", async () => {
		const error = await expectFailure(
			() =>
				makeClient(async () =>
					response(
						{
							ok: false,
							error_code: 429,
							description: RAW_DESCRIPTION,
							parameters: { retry_after: 1_000_000 },
						},
						429,
					),
				).sendMessage(4, CONTENT),
			[TOKEN, CONTENT],
		);

		expect(error).toMatchObject({
			method: "sendMessage",
			httpStatus: 429,
			errorCode: 429,
			description: RAW_DESCRIPTION,
			retryAfterMs: 300_000,
			ambiguous: false,
		});
		expect(error.message).toContain(RAW_DESCRIPTION);
		expect(error.transport).toBeUndefined();
	});

	test("sanitizes malformed HTTP error bodies without retaining raw response data", async () => {
		const error = await expectFailure(
			() =>
				makeClient(
					async () =>
						new Response(`${TOKEN} ${CONTENT} ${RAW_DESCRIPTION}`, {
							status: 502,
							headers: { "content-type": "application/json" },
						}),
				).sendMessage(4, CONTENT),
			[TOKEN, CONTENT, RAW_DESCRIPTION],
		);

		expect(error).toMatchObject({ method: "sendMessage", httpStatus: 502, ambiguous: true });
		expect(error.errorCode).toBeUndefined();
		expect(error.retryAfterMs).toBeUndefined();
		expect(error.transport).toBeUndefined();
	});

	test.each([
		[2, 2_000],
		[-1, undefined],
		[1_000_000, 300_000],
	])("normalizes retry_after %p seconds", async (retryAfter, expectedRetryAfterMs) => {
		const error = await expectFailure(() =>
			makeClient(async () =>
				response({ ok: false, error_code: 429, parameters: { retry_after: retryAfter } }),
			).getMe(),
		);
		expect(error.retryAfterMs).toBe(expectedRetryAfterMs);
	});

	test("retains an allowlisted transport code without arbitrary transport text", async () => {
		const transportFailure = Object.assign(new Error(`${TOKEN} ${CONTENT} ${ARBITRARY_TRANSPORT_TEXT}`), {
			cause: { code: "ECONNRESET" },
		});
		const error = await expectFailure(
			() => makeClient(async () => Promise.reject(transportFailure)).getMe(),
			[TOKEN, CONTENT, ARBITRARY_TRANSPORT_TEXT],
		);

		expect(error).toMatchObject({
			method: "getMe",
			ambiguous: false,
			transport: true,
			transportCode: "ECONNRESET",
		});
		expect(error.message).toContain("getMe");
		expect(error.message).toContain("ECONNRESET");
	});

	test("retains a sanitized getUpdates 409 description with poller guidance", async () => {
		const error = await expectFailure(
			() =>
				makeClient(async () =>
					response(
						{
							ok: false,
							error_code: 409,
							description: `Conflict:\nterminated by other getUpdates request ${TOKEN}`,
						},
						409,
					),
				).getUpdates({ timeoutSeconds: 1, allowedUpdates: [] }),
			[TOKEN],
		);

		expect(error).toMatchObject({
			method: "getUpdates",
			httpStatus: 409,
			errorCode: 409,
			ambiguous: false,
		});
		expect(error.description).toContain("Conflict: terminated by other getUpdates request");
		expect(error.description).not.toContain(TOKEN);
		expect(error.description).not.toContain("\n");
		expect(error.message).toContain("another poller is using the same bot token");
		expect(error.message).toContain("Conflict: terminated by other getUpdates request");
	});

	test("rejects invalid tokens before invoking fetch", async () => {
		let calls = 0;
		const client = new TelegramBotClient("not-a-token", {
			fetch: async () => {
				calls++;
				return response({ ok: true, result: {} });
			},
			origin: ORIGIN,
			timeoutMs: 50,
		});
		const error = await expectFailure(() => client.getMe(), ["not-a-token"]);
		expect(error).toMatchObject({ method: "getMe", ambiguous: false, invalidToken: true });
		expect(error.message).toContain("OMP_TELEGRAM_BOT_TOKEN");
		expect(calls).toBe(0);
	});

	test("factory pins the official Bot API origin", async () => {
		const client = createTelegramBotClient(TOKEN);
		expect(client).toBeInstanceOf(TelegramBotClient);
	});
});
