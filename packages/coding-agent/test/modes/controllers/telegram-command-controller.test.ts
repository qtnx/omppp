import { describe, expect, it, vi } from "bun:test";
import { TelegramCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/telegram-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type {
	CreateTelegramBridge,
	TelegramBridgeFactoryOptions,
	TelegramBridgeHandle,
	TelegramBridgeStatus,
} from "@oh-my-pi/pi-coding-agent/telegram/types";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { TelegramApiError, telegramApiErrorMessage } from "../../../src/telegram/client";

const VALID_BOT_TOKEN = `123456789:${"a".repeat(35)}`;

interface BridgeRecord {
	handle: TelegramBridgeHandle;
	startCalls: number;
	stopCalls: number;
	disposeCalls: number;
	emit(status: TelegramBridgeStatus): void;
}

interface BridgeHarness {
	factory: CreateTelegramBridge;
	options: TelegramBridgeFactoryOptions[];
	handles: BridgeRecord[];
}

interface ContextHarness {
	ctx: InteractiveModeContext;
	statuses: string[];
	errors: string[];
}

interface ControllerHarness extends ContextHarness {
	controller: TelegramCommandController;
	bridge: BridgeHarness;
}

function createBridgeHarness(options?: {
	start?: (bridgeOptions: TelegramBridgeFactoryOptions) => Promise<void>;
}): BridgeHarness {
	const capturedOptions: TelegramBridgeFactoryOptions[] = [];
	const handles: BridgeRecord[] = [];
	const factory: CreateTelegramBridge = bridgeOptions => {
		capturedOptions.push(bridgeOptions);
		let status: TelegramBridgeStatus = { phase: "disconnected" };
		let startCalls = 0;
		let stopCalls = 0;
		let disposeCalls = 0;
		const start = async () => {
			startCalls++;
			await options?.start?.(bridgeOptions);
			status = { phase: "connected", botUsername: "bridgebot" };
		};
		const stop = async () => {
			stopCalls++;
			status = { phase: "disconnected" };
		};
		const dispose = () => {
			disposeCalls++;
		};
		const handle: TelegramBridgeHandle = {
			get status() {
				return status;
			},
			start,
			stop,
			dispose,
		};
		const record: BridgeRecord = {
			handle,
			get startCalls() {
				return startCalls;
			},
			get stopCalls() {
				return stopCalls;
			},
			get disposeCalls() {
				return disposeCalls;
			},
			emit(nextStatus) {
				status = nextStatus;
				bridgeOptions.onStatus(nextStatus);
			},
		};
		handles.push(record);
		return handle;
	};
	return { factory, options: capturedOptions, handles };
}

function createContext(): ContextHarness {
	const statuses: string[] = [];
	const errors: string[] = [];
	const ctx = {
		session: { sessionId: "session" },
		extractAssistantText: vi.fn(() => "model response"),
		showStatus: vi.fn((message: string) => statuses.push(message)),
		showError: vi.fn((message: string) => errors.push(message)),
	} as unknown as InteractiveModeContext;
	return { ctx, statuses, errors };
}

function createController(
	env: Record<string, string | undefined>,
	options?: { start?: (bridgeOptions: TelegramBridgeFactoryOptions) => Promise<void> },
): ControllerHarness {
	const context = createContext();
	const bridge = createBridgeHarness(options);
	return {
		...context,
		bridge,
		controller: new TelegramCommandController(context.ctx, { env, createBridge: bridge.factory }),
	};
}

describe("TelegramCommandController", () => {
	it("rejects a missing token before constructing a bridge", async () => {
		const harness = createController({ OMP_TELEGRAM_ALLOWED_CHAT_ID: "42" });
		await harness.controller.handleCommand("on");
		expect(harness.bridge.handles).toHaveLength(0);
		expect(harness.errors).toEqual([expect.stringContaining("OMP_TELEGRAM_BOT_TOKEN")]);
		expect(JSON.stringify(harness.errors)).not.toContain("malformed");
	});

	it("rejects a malformed token before constructing a bridge without leaking it", async () => {
		const harness = createController({
			OMP_TELEGRAM_BOT_TOKEN: "not-a-telegram-token",
			OMP_TELEGRAM_ALLOWED_CHAT_ID: "42",
		});
		await harness.controller.handleCommand("on");
		expect(harness.bridge.handles).toHaveLength(0);
		expect(harness.errors).toEqual([expect.stringContaining("OMP_TELEGRAM_BOT_TOKEN")]);
		expect(harness.errors).toEqual([expect.stringContaining("malformed")]);
		expect(JSON.stringify(harness.errors)).not.toContain("not-a-telegram-token");
	});

	it("rejects every invalid or non-canonical chat id before constructing a bridge", async () => {
		for (const chatId of [
			undefined,
			" ",
			"0",
			"-1",
			"+1",
			"1.0",
			"1e3",
			"001",
			"12x",
			String(Number.MAX_SAFE_INTEGER + 1),
		]) {
			const harness = createController({
				OMP_TELEGRAM_BOT_TOKEN: VALID_BOT_TOKEN,
				OMP_TELEGRAM_ALLOWED_CHAT_ID: chatId,
			});
			await harness.controller.handleCommand("on");
			expect(harness.bridge.handles).toHaveLength(0);
			expect(harness.errors).toEqual([expect.stringContaining("OMP_TELEGRAM_ALLOWED_CHAT_ID")]);
		}
	});

	it("serializes lifecycle commands, replaces bridges, and ignores old status", async () => {
		const started = Promise.withResolvers<void>();
		const releaseStart = Promise.withResolvers<void>();
		const harness = createController(
			{ OMP_TELEGRAM_BOT_TOKEN: VALID_BOT_TOKEN, OMP_TELEGRAM_ALLOWED_CHAT_ID: "42" },
			{
				start: async () => {
					started.resolve();
					await releaseStart.promise;
				},
			},
		);

		const firstOn = harness.controller.handleCommand("on");
		const secondOn = harness.controller.handleCommand("on");
		const off = harness.controller.handleCommand("off");
		await started.promise;
		expect(harness.bridge.handles).toHaveLength(1);
		expect(harness.bridge.handles[0]?.startCalls).toBe(1);
		expect(harness.bridge.handles[0]?.stopCalls).toBe(0);

		releaseStart.resolve();
		await Promise.all([firstOn, secondOn, off]);
		expect(harness.bridge.handles[0]?.stopCalls).toBe(1);
		expect(harness.statuses).toContain("Telegram bridge stopped.");

		await harness.controller.handleCommand("off");
		expect(harness.bridge.handles[0]?.stopCalls).toBe(1);
		expect(harness.statuses.at(-1)).toBe("Telegram is disconnected.");

		await harness.controller.handleCommand("on");
		expect(harness.bridge.handles).toHaveLength(2);
		harness.bridge.handles[0]?.emit({ phase: "connected", botUsername: "oldbot" });
		expect(harness.statuses).not.toContain("Telegram connected as @oldbot.");
		harness.bridge.handles[1]?.emit({ phase: "connected", botUsername: "newbot" });
		expect(harness.statuses.at(-1)).toBe("Telegram connected as @newbot.");
	});

	it("replaces a failed bridge on retry while preserving active-start idempotency", async () => {
		const harness = createController({
			OMP_TELEGRAM_BOT_TOKEN: VALID_BOT_TOKEN,
			OMP_TELEGRAM_ALLOWED_CHAT_ID: "42",
		});

		await harness.controller.handleCommand("on");
		const failedBridge = harness.bridge.handles[0];
		failedBridge?.emit({ phase: "failed", message: "sanitized failure" });
		const errorsBeforeRetry = [...harness.errors];

		await harness.controller.handleCommand("on");

		expect(failedBridge?.stopCalls).toBe(1);
		expect(failedBridge?.disposeCalls).toBe(1);
		expect(harness.bridge.handles).toHaveLength(2);
		expect(harness.bridge.handles[1]?.startCalls).toBe(1);
		expect(harness.statuses.at(-1)).toBe("Telegram connected as @bridgebot.");
		expect(harness.errors).toEqual(errorsBeforeRetry);

		await harness.controller.handleCommand("on");
		expect(harness.bridge.handles).toHaveLength(2);
	});

	it("shows a Telegram API startup cause once and logs only its event", async () => {
		const failure = new TelegramApiError({
			method: "sendMessage",
			httpStatus: 400,
			errorCode: 400,
			description: "Bad Request: chat not found",
			ambiguous: false,
		});
		const safeCause = telegramApiErrorMessage(failure);
		if (!safeCause) throw new Error("Expected a safe Telegram API failure cause.");
		expect(safeCause).toContain("chat not found");
		const harness = createController(
			{ OMP_TELEGRAM_BOT_TOKEN: VALID_BOT_TOKEN, OMP_TELEGRAM_ALLOWED_CHAT_ID: "42" },
			{
				start: async bridgeOptions => {
					bridgeOptions.onStatus({ phase: "failed", message: safeCause });
					throw failure;
				},
			},
		);
		const warn = vi.spyOn(logger, "warn");
		try {
			await harness.controller.handleCommand("on");
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toContain("Telegram could not start");
			expect(harness.errors[0]).toContain(safeCause);
			expect(warn.mock.calls).toEqual([
				["Telegram bridge command failed", { event: "telegram_bridge_start_failed" }],
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("shows a bridge-safe terminal cause with retry guidance", async () => {
		const failure = new TelegramApiError({
			method: "getUpdates",
			httpStatus: 409,
			errorCode: 409,
			ambiguous: false,
		});
		const safeCause = telegramApiErrorMessage(failure);
		if (!safeCause) throw new Error("Expected a safe Telegram API failure cause.");
		const harness = createController({
			OMP_TELEGRAM_BOT_TOKEN: VALID_BOT_TOKEN,
			OMP_TELEGRAM_ALLOWED_CHAT_ID: "42",
		});

		await harness.controller.handleCommand("on");
		harness.bridge.handles[0]?.emit({ phase: "failed", message: safeCause });

		expect(harness.errors).toHaveLength(1);
		expect(harness.errors[0]).toContain(safeCause);
		expect(harness.errors[0]).toContain("Run /telegram on to try again.");
	});

	it("keeps arbitrary startup errors generic and logs only their event identifier", async () => {
		const sentinel = {
			token: VALID_BOT_TOKEN,
			url: `https://api.telegram.org/bot${VALID_BOT_TOKEN}/sendMessage`,
			chatId: "42",
			inbound: "private inbound text",
			output: "private model output",
		};
		const harness = createController(
			{ OMP_TELEGRAM_BOT_TOKEN: sentinel.token, OMP_TELEGRAM_ALLOWED_CHAT_ID: sentinel.chatId },
			{
				start: async () => {
					throw new Error(Object.values(sentinel).join(" "));
				},
			},
		);
		const warn = vi.spyOn(logger, "warn");
		try {
			await harness.controller.handleCommand("on");
			expect(harness.errors).toEqual([
				"Telegram could not start, so no Telegram messages are connected. Check the Telegram configuration and try /telegram on again.",
			]);
			expect(warn.mock.calls).toEqual([
				["Telegram bridge command failed", { event: "telegram_bridge_start_failed" }],
			]);
			const captured = JSON.stringify({ statuses: harness.statuses, errors: harness.errors, logs: warn.mock.calls });
			for (const value of Object.values(sentinel)) expect(captured).not.toContain(value);
		} finally {
			warn.mockRestore();
		}
	});

	it("fences status and lifecycle work after synchronous disposal", async () => {
		const started = Promise.withResolvers<void>();
		const releaseStart = Promise.withResolvers<void>();
		const harness = createController(
			{ OMP_TELEGRAM_BOT_TOKEN: VALID_BOT_TOKEN, OMP_TELEGRAM_ALLOWED_CHAT_ID: "42" },
			{
				start: async () => {
					started.resolve();
					await releaseStart.promise;
				},
			},
		);

		const on = harness.controller.handleCommand("on");
		await started.promise;
		harness.controller.dispose();
		harness.bridge.handles[0]?.emit({ phase: "connected", botUsername: "latebot" });
		releaseStart.resolve();
		await on;
		await harness.controller.handleCommand("on");

		expect(harness.bridge.handles).toHaveLength(1);
		expect(harness.bridge.handles[0]?.disposeCalls).toBe(1);
		expect(harness.statuses).not.toContain("Telegram connected as @latebot.");
	});
});
