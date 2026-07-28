import * as logger from "@oh-my-pi/pi-utils/logger";
import type { CreateTelegramBridge, TelegramBridgeHandle, TelegramBridgeStatus } from "../../telegram/types";
import type { InteractiveModeContext } from "../types";

export interface TelegramCommandControllerDeps {
	env: Record<string, string | undefined>;
	createBridge: CreateTelegramBridge;
}

const USAGE = "Usage: /telegram <on|off|status>";
const INVALID_TOKEN_MESSAGE =
	"Telegram could not start, so no Telegram messages are connected. Set OMP_TELEGRAM_BOT_TOKEN and try /telegram on again.";
const INVALID_CHAT_ID_MESSAGE =
	"Telegram could not start, so no Telegram messages are connected. Set OMP_TELEGRAM_ALLOWED_CHAT_ID to a positive safe integer and try /telegram on again.";
const START_FAILED_MESSAGE =
	"Telegram could not start, so no Telegram messages are connected. Check the Telegram configuration and try /telegram on again.";
const STOP_FAILED_MESSAGE =
	"Telegram could not stop cleanly, so its connection state is unknown. Run /telegram status, then try /telegram off again.";
const BRIDGE_FAILED_MESSAGE =
	"Telegram bridge failed, so Telegram messages are disconnected. Run /telegram on to try again.";

/** Owns the session-scoped Telegram bridge lifecycle for `/telegram`. */
export class TelegramCommandController {
	readonly #ctx: InteractiveModeContext;
	readonly #deps: TelegramCommandControllerDeps;
	#bridge: TelegramBridgeHandle | undefined;
	#lifecycle: Promise<void> = Promise.resolve();
	#disposed = false;

	constructor(ctx: InteractiveModeContext, deps: TelegramCommandControllerDeps) {
		this.#ctx = ctx;
		this.#deps = deps;
	}

	get status(): TelegramBridgeStatus {
		return this.#bridge?.status ?? { phase: "disconnected" };
	}

	async handleCommand(action: string): Promise<void> {
		await this.#serialize(async () => {
			if (this.#disposed) return;
			switch (action.trim().toLowerCase()) {
				case "on":
					await this.#start();
					return;
				case "off":
					await this.#stop(true);
					return;
				case "status":
					this.#showBridgeStatus(this.status);
					return;
				default:
					this.#ctx.showError(USAGE);
			}
		});
	}

	async stop(): Promise<void> {
		await this.#serialize(async () => {
			if (!this.#disposed) await this.#stop(false);
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const bridge = this.#bridge;
		this.#bridge = undefined;
		if (!bridge) return;
		bridge.dispose();
		void bridge.stop().catch(() => {
			logger.warn("Telegram bridge command failed", { event: "telegram_bridge_dispose_failed" });
		});
	}

	async #serialize(operation: () => Promise<void>): Promise<void> {
		const next = this.#lifecycle.then(operation, operation);
		this.#lifecycle = next.catch(() => {});
		await next;
	}

	async #start(): Promise<void> {
		const existingBridge = this.#bridge;
		if (existingBridge) {
			if (existingBridge.status.phase !== "failed") {
				this.#showBridgeStatus(existingBridge.status);
				return;
			}
			this.#bridge = undefined;
			try {
				await existingBridge.stop();
			} catch {
				logger.warn("Telegram bridge command failed", { event: "telegram_bridge_failed_cleanup_failed" });
			} finally {
				existingBridge.dispose();
			}
		}
		const token = this.#deps.env.OMP_TELEGRAM_BOT_TOKEN;
		if (!token) {
			this.#ctx.showError(INVALID_TOKEN_MESSAGE);
			return;
		}
		const rawChatId = this.#deps.env.OMP_TELEGRAM_ALLOWED_CHAT_ID;
		if (!rawChatId || !/^[1-9][0-9]*$/.test(rawChatId)) {
			this.#ctx.showError(INVALID_CHAT_ID_MESSAGE);
			return;
		}
		const allowedChatId = Number(rawChatId);
		if (!Number.isSafeInteger(allowedChatId) || allowedChatId <= 0) {
			this.#ctx.showError(INVALID_CHAT_ID_MESSAGE);
			return;
		}

		let bridge: TelegramBridgeHandle;
		try {
			bridge = this.#deps.createBridge({
				token,
				session: this.#ctx.session,
				allowedChatId,
				extractAssistantText: message => this.#ctx.extractAssistantText(message),
				onStatus: status => {
					if (this.#disposed || this.#bridge !== bridge) return;
					this.#showBridgeStatus(status);
				},
			});
		} catch {
			this.#reportFailure("telegram_bridge_create_failed", START_FAILED_MESSAGE);
			return;
		}
		this.#bridge = bridge;

		try {
			await bridge.start();
		} catch {
			if (this.#bridge === bridge) this.#bridge = undefined;
			bridge.dispose();
			if (!this.#disposed) this.#reportFailure("telegram_bridge_start_failed", START_FAILED_MESSAGE);
			return;
		}
		if (this.#disposed || this.#bridge !== bridge) return;
		this.#showBridgeStatus(bridge.status);
	}

	async #stop(notifyUser: boolean): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge) {
			if (notifyUser) this.#ctx.showStatus("Telegram is disconnected.");
			return;
		}
		this.#bridge = undefined;
		try {
			await bridge.stop();
			if (notifyUser && !this.#disposed) this.#ctx.showStatus("Telegram bridge stopped.");
		} catch {
			if (this.#disposed) return;
			if (notifyUser) {
				this.#reportFailure("telegram_bridge_stop_failed", STOP_FAILED_MESSAGE);
			} else {
				logger.warn("Telegram bridge command failed", { event: "telegram_bridge_stop_failed" });
			}
		} finally {
			bridge.dispose();
		}
	}

	#showBridgeStatus(status: TelegramBridgeStatus): void {
		if (this.#disposed) return;
		switch (status.phase) {
			case "connected":
				if (status.botUsername && /^[A-Za-z0-9_]+$/.test(status.botUsername)) {
					this.#ctx.showStatus(`Telegram connected as @${status.botUsername}.`);
				} else {
					this.#ctx.showStatus("Telegram is connected.");
				}
				return;
			case "connecting":
				this.#ctx.showStatus("Telegram is connecting.");
				return;
			case "retrying":
				this.#ctx.showStatus("Telegram is reconnecting.");
				return;
			case "stopping":
				this.#ctx.showStatus("Telegram bridge is stopping.");
				return;
			case "failed":
				this.#reportFailure("telegram_bridge_failed", BRIDGE_FAILED_MESSAGE);
				return;
			case "disconnected":
				this.#ctx.showStatus("Telegram is disconnected.");
		}
	}

	#reportFailure(event: string, message: string): void {
		logger.warn("Telegram bridge command failed", { event });
		this.#ctx.showError(message);
	}
}
