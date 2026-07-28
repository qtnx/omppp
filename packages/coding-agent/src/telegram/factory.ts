import { TelegramBridge } from "./bridge";
import { createTelegramBotClient } from "./client";
import type { CreateTelegramBridge } from "./types";

export const createTelegramBridge: CreateTelegramBridge = ({ token, ...options }) =>
	new TelegramBridge({ ...options, client: createTelegramBotClient(token) });
