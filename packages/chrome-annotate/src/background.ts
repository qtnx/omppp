import type { AnnotationPayload } from "./types";

interface HostStorage {
	host?: string;
}

interface ServerJson {
	error?: string;
	session?: string;
}

interface TabCodeEntry {
	code: string;
	session: string;
}

interface TabCodesStorage {
	tabCodes?: Record<string, TabCodeEntry>;
}

interface SubmitMessage {
	type: "ompx-annotate-submit";
	payload: AnnotationPayload;
}

interface PairMessage {
	type: "ompx-annotate-pair";
	code: string;
	host?: string;
	tabId?: number;
}

interface StatusMessage {
	type: "ompx-annotate-status";
	tabId?: number;
}

interface SetHostMessage {
	type: "ompx-annotate-set-host";
	host: string;
}

type ExtensionMessage = SubmitMessage | PairMessage | StatusMessage | SetHostMessage;

type ExtensionResponse =
	| { ok: true; host?: string | null; paired?: boolean; session?: string }
	| { ok: false; error: string; session?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const normalizePairHost = (value: string): string => {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
	try {
		return new URL(withScheme).host;
	} catch {
		return trimmed.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
	}
};

const isPayload = (value: unknown): value is AnnotationPayload =>
	isRecord(value) && typeof value.comment === "string" && Array.isArray(value.rects) && typeof value.url === "string";

const errorMessage = (value: unknown): string => (value instanceof Error ? value.message : String(value)).slice(0, 300);

const parseOptionalTabId = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

const parseMessage = (value: unknown): ExtensionMessage | null => {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (value.type === "ompx-annotate-submit" && isPayload(value.payload)) {
		return { type: "ompx-annotate-submit", payload: value.payload };
	}
	if (value.type === "ompx-annotate-pair" && typeof value.code === "string") {
		const message: PairMessage = { type: "ompx-annotate-pair", code: value.code };
		if (typeof value.host === "string") message.host = value.host;
		const tabId = parseOptionalTabId(value.tabId);
		if (typeof tabId === "number") message.tabId = tabId;
		return message;
	}
	if (value.type === "ompx-annotate-status") {
		const message: StatusMessage = { type: "ompx-annotate-status" };
		const tabId = parseOptionalTabId(value.tabId);
		if (typeof tabId === "number") message.tabId = tabId;
		return message;
	}
	if (value.type === "ompx-annotate-set-host" && typeof value.host === "string") {
		return { type: "ompx-annotate-set-host", host: value.host };
	}
	return null;
};

const readHost = async (): Promise<string | null> => {
	const { promise, resolve, reject } = Promise.withResolvers<string | null>();
	chrome.storage.local.get(["host"], items => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		const storage = items as HostStorage;
		resolve(storage.host ?? null);
	});
	return promise;
};

const writeHost = async (host: string): Promise<void> => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	chrome.storage.local.set({ host }, () => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve();
	});
	return promise;
};

const readTabCodes = async (): Promise<Record<string, TabCodeEntry>> => {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, TabCodeEntry>>();
	chrome.storage.session.get(["tabCodes"], items => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		const storage = items as TabCodesStorage;
		resolve(storage.tabCodes ?? {});
	});
	return promise;
};

const writeTabCodes = async (tabCodes: Record<string, TabCodeEntry>): Promise<void> => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	chrome.storage.session.set({ tabCodes }, () => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve();
	});
	return promise;
};

const readTabCode = async (tabId: number): Promise<TabCodeEntry | null> => {
	const tabCodes = await readTabCodes();
	return tabCodes[String(tabId)] ?? null;
};

const writeTabCode = async (tabId: number, entry: TabCodeEntry): Promise<void> => {
	const tabCodes = await readTabCodes();
	tabCodes[String(tabId)] = entry;
	await writeTabCodes(tabCodes);
};

const removeTabCode = async (tabId: number): Promise<void> => {
	const tabCodes = await readTabCodes();
	delete tabCodes[String(tabId)];
	await writeTabCodes(tabCodes);
};

const clearTabCodes = async (): Promise<void> => {
	await writeTabCodes({});
};

const setHost = async (host: string): Promise<void> => {
	const previousHost = await readHost();
	if (previousHost && previousHost !== host) await clearTabCodes();
	await writeHost(host);
};

const captureVisiblePng = async (windowId?: number): Promise<string> => {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const callback = (dataUrl: string) => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve(dataUrl);
	};
	if (typeof windowId === "number") {
		chrome.tabs.captureVisibleTab(windowId, { format: "png" }, callback);
	} else {
		chrome.tabs.captureVisibleTab({ format: "png" }, callback);
	}
	return promise;
};

const readServerJson = async (response: Response): Promise<ServerJson> => {
	try {
		return (await response.json()) as ServerJson;
	} catch {
		return {};
	}
};

const stripPngDataUrl = (dataUrl: string): string => dataUrl.replace(/^data:image\/png;base64,/, "");

const handleSubmit = async (
	message: SubmitMessage,
	sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> => {
	const tabId = sender.tab?.id;
	if (typeof tabId !== "number") return { ok: false, error: "no_tab" };

	let host: string | null;
	let entry: TabCodeEntry | null;
	try {
		host = await readHost();
		entry = await readTabCode(tabId);
	} catch {
		return { ok: false, error: "storage_unavailable" };
	}
	if (!host || !entry) return { ok: false, error: "not_paired" };

	const windowId = sender.tab?.windowId;

	let dataUrl: string;
	try {
		dataUrl = await captureVisiblePng(windowId);
	} catch {
		try {
			dataUrl = await captureVisiblePng();
		} catch (error) {
			return { ok: false, error: `capture_failed: ${errorMessage(error)}` };
		}
	}

	const data = stripPngDataUrl(dataUrl);
	const url = `http://${host}/v1/annotations`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code: entry.code,
				payload: message.payload,
				screenshot: { data, mimeType: "image/png" },
			}),
		});
	} catch (error) {
		return { ok: false, error: `unreachable: ${errorMessage(error)} @ ${url}` };
	}
	const body = await readServerJson(response);
	if (response.status === 200) return { ok: true };
	if (response.status === 403) {
		try {
			await removeTabCode(tabId);
		} catch {}
	}
	return { ok: false, error: `submit failed (HTTP ${response.status}): ${body.error ?? "no error body"}` };
};

const handlePair = async (message: PairMessage, sender: chrome.runtime.MessageSender): Promise<ExtensionResponse> => {
	const tabId = message.tabId ?? sender.tab?.id;
	if (typeof tabId !== "number") return { ok: false, error: "no_tab" };
	const code = message.code.trim();
	let host = normalizePairHost(message.host ?? "");
	if (!host) {
		try {
			host = (await readHost()) ?? "";
		} catch (error) {
			return { ok: false, error: `storage_write_failed: ${errorMessage(error)}` };
		}
	}
	if (!host || !code) return { ok: false, error: "missing_pairing" };

	const url = `http://${host}/v1/pair`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
		});
	} catch (error) {
		return { ok: false, error: `unreachable: ${errorMessage(error)} @ ${url}` };
	}
	const body = await readServerJson(response);
	if (response.status !== 200) {
		return { ok: false, error: `pair failed (HTTP ${response.status}): ${body.error ?? "no error body"}` };
	}

	const session = body.session ?? "session";
	try {
		await setHost(host);
		await writeTabCode(tabId, { code, session });
	} catch (error) {
		return { ok: false, error: `storage_write_failed: ${errorMessage(error)}` };
	}
	return { ok: true, session };
};

const handleStatus = async (
	message: StatusMessage,
	sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> => {
	const tabId = message.tabId ?? sender.tab?.id;
	const host = await readHost();
	if (typeof tabId !== "number") return { ok: true, host, paired: false };
	const entry = await readTabCode(tabId);
	return { ok: true, host, paired: !!entry, session: entry?.session };
};

const handleSetHost = async (message: SetHostMessage): Promise<ExtensionResponse> => {
	const host = normalizePairHost(message.host);
	if (!host) return { ok: false, error: "missing_pairing" };
	try {
		await setHost(host);
	} catch (error) {
		return { ok: false, error: `storage_write_failed: ${errorMessage(error)}` };
	}
	return { ok: true, host };
};

const handleMessage = async (rawMessage: unknown, sender: chrome.runtime.MessageSender): Promise<ExtensionResponse> => {
	const message = parseMessage(rawMessage);
	if (!message) return { ok: false, error: "unknown_message" };
	if (message.type === "ompx-annotate-submit") return handleSubmit(message, sender);
	if (message.type === "ompx-annotate-pair") return handlePair(message, sender);
	if (message.type === "ompx-annotate-set-host") return handleSetHost(message);
	return handleStatus(message, sender);
};

const queryActiveTab = async (): Promise<chrome.tabs.Tab | null> => {
	const { promise, resolve, reject } = Promise.withResolvers<chrome.tabs.Tab | null>();
	chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve(tabs[0] ?? null);
	});
	return promise;
};

const sendToggleToTab = async (tabId: number): Promise<void> => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	chrome.tabs.sendMessage(tabId, { type: "ompx-annotate-toggle" }, () => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve();
	});
	return promise;
};

const injectContentScript = async (tabId: number): Promise<void> => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve();
	});
	return promise;
};

const showTemporaryActionError = (tabId: number, message: string) => {
	chrome.action.setBadgeText({ tabId, text: "ERR" });
	chrome.action.setTitle({ tabId, title: message });
	globalThis.setTimeout(() => {
		chrome.action.setBadgeText({ tabId, text: "" });
		chrome.action.setTitle({ tabId, title: "OMPx Annotate" });
	}, 4000);
};

const handleToggleCommand = async () => {
	const tab = await queryActiveTab();
	const tabId = tab?.id;
	if (typeof tabId !== "number") return;
	try {
		await sendToggleToTab(tabId);
	} catch {
		try {
			await injectContentScript(tabId);
		} catch (error) {
			showTemporaryActionError(tabId, errorMessage(error));
		}
	}
};

chrome.storage.local.remove("code");

chrome.tabs.onRemoved.addListener(tabId => {
	void removeTabCode(tabId);
});

chrome.commands.onCommand.addListener(command => {
	if (command === "toggle-annotate") void handleToggleCommand();
});

chrome.runtime.onMessage.addListener(
	(message: unknown, sender, sendResponse: (response: ExtensionResponse) => void) => {
		void handleMessage(message, sender).then(
			response => sendResponse(response),
			() => sendResponse({ ok: false, error: "internal_error" }),
		);
		return true;
	},
);
