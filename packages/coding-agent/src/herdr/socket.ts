import * as net from "node:net";
import { logger } from "@oh-my-pi/pi-utils";

const DEFAULT_TIMEOUT_MS = 500;

export interface HerdrJsonRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export interface HerdrJsonResponse {
	id?: string;
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

/** `$HERDR_SOCKET_PATH` when this process runs inside a herdr pane, else undefined. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.HERDR_SOCKET_PATH;
}

/** True when HERDR_ENV=1 and both HERDR_SOCKET_PATH and HERDR_PANE_ID are set. */
export function isHerdrPane(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseResponse(line: string): HerdrJsonResponse | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed)) return undefined;

		const response: HerdrJsonResponse = {};
		const id = readString(parsed.id);
		if (id !== undefined) response.id = id;
		if (isRecord(parsed.result)) response.result = parsed.result;
		if (isRecord(parsed.error)) {
			response.error = {
				code: readString(parsed.error.code),
				message: readString(parsed.error.message),
			};
		}
		return response;
	} catch {
		return undefined;
	}
}

/**
 * Send one NDJSON request and resolve the first response line.
 * Best-effort: resolves `undefined` on connect error, timeout, or unparseable reply — never throws.
 */
export async function sendHerdrRequest(
	socketPath: string,
	request: HerdrJsonRequest,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HerdrJsonResponse | undefined> {
	const deferred = Promise.withResolvers<HerdrJsonResponse | undefined>();
	let done = false;
	let timeout: NodeJS.Timeout | undefined;
	let socket: net.Socket | undefined;
	let buffer = "";
	const finish = (response: HerdrJsonResponse | undefined): void => {
		if (done) return;
		done = true;
		clearTimeout(timeout);
		socket?.destroy();
		deferred.resolve(response);
	};

	try {
		socket = net.createConnection(socketPath);
	} catch (error) {
		logger.debug("herdr socket: connection setup failed", { error: String(error) });
		return undefined;
	}

	socket.on("error", error => {
		logger.debug("herdr socket: request error", { error: String(error) });
		finish(undefined);
	});
	socket.on("connect", () => {
		try {
			socket?.write(`${JSON.stringify(request)}\n`);
		} catch (error) {
			logger.debug("herdr socket: request write failed", { error: String(error) });
			finish(undefined);
		}
	});
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const newline = buffer.indexOf("\n");
		if (newline >= 0) finish(parseResponse(buffer.slice(0, newline)));
	});
	socket.on("end", () => finish(undefined));
	timeout = setTimeout(() => finish(undefined), timeoutMs);
	timeout.unref?.();
	return deferred.promise;
}

/** One decoded subscription event line from a herdr event stream. */
export interface HerdrEvent {
	event: string;
	data: Record<string, unknown>;
}

export interface HerdrEventStream {
	/** Stop reading and drop the connection. Idempotent. */
	close(): void;
}

export interface HerdrEventStreamHandlers {
	onEvent(event: HerdrEvent): void;
	/** Fires once when the stream ends for any reason, including `close()`. */
	onClose(reason: string): void;
	/** Fires when herdr acknowledges the subscription with `subscription_started`. */
	onReady?(): void;
}

/**
 * Open a long-lived subscription over the herdr socket.
 *
 * Herdr accepts exactly ONE `events.subscribe` per connection: a second request
 * on the same socket is neither acknowledged nor honoured, and it silently stops
 * the first stream (verified against herdr 0.7.5). Callers needing a different
 * subscription set MUST close this stream and open a new one.
 *
 * `pane.*` subscriptions carry no wildcard either — `pane_id: "*"` answers
 * `pane_not_found` — so a fleet-wide watcher enumerates concrete pane ids and
 * pairs them with the global `pane.agent_detected` subscription.
 */
export function openHerdrEventStream(
	socketPath: string,
	subscriptions: ReadonlyArray<Record<string, unknown>>,
	handlers: HerdrEventStreamHandlers,
	requestId = `omp:events:${Date.now().toString(36)}`,
): HerdrEventStream {
	let socket: net.Socket | undefined;
	let buffer = "";
	let ended = false;
	const end = (reason: string): void => {
		if (ended) return;
		ended = true;
		socket?.destroy();
		socket = undefined;
		handlers.onClose(reason);
	};

	try {
		socket = net.createConnection(socketPath);
	} catch (error) {
		queueMicrotask(() => end(`connect failed: ${String(error)}`));
		return { close: () => end("closed") };
	}

	socket.on("connect", () => {
		try {
			socket?.write(
				`${JSON.stringify({ v: 1, id: requestId, method: "events.subscribe", params: { subscriptions } })}\n`,
			);
		} catch (error) {
			end(`subscribe write failed: ${String(error)}`);
		}
	});
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim() === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			const eventName = readString(parsed.event);
			if (eventName) {
				handlers.onEvent({ event: eventName, data: isRecord(parsed.data) ? parsed.data : {} });
				continue;
			}
			if (isRecord(parsed.error)) {
				end(
					`subscribe rejected: ${readString(parsed.error.message) ?? readString(parsed.error.code) ?? "unknown"}`,
				);
				return;
			}
			if (isRecord(parsed.result) && readString(parsed.result.type) === "subscription_started") handlers.onReady?.();
		}
	});
	socket.on("error", error => end(`stream error: ${String(error)}`));
	socket.on("end", () => end("server closed the stream"));
	socket.on("close", () => end("connection closed"));

	return { close: () => end("closed") };
}

/** One pane row from `pane.list`, narrowed to the fields a watcher reconciles on. */
export interface HerdrPaneInfo {
	paneId: string;
	workspaceId?: string;
	agent?: string;
	displayAgent?: string;
	agentStatus?: string;
	title?: string;
}

function parsePaneInfo(value: unknown): HerdrPaneInfo | undefined {
	if (!isRecord(value)) return undefined;
	const paneId = readString(value.pane_id);
	if (!paneId) return undefined;
	return {
		paneId,
		workspaceId: readString(value.workspace_id),
		agent: readString(value.agent),
		displayAgent: readString(value.display_agent),
		agentStatus: readString(value.agent_status),
		title: readString(value.title),
	};
}

/**
 * Snapshot every pane herdr knows about. Used to reconcile state across a
 * stream reconnect, where status transitions can be missed.
 */
export async function herdrPaneSnapshot(socketPath: string, timeoutMs = 2_000): Promise<HerdrPaneInfo[]> {
	const response = await sendHerdrRequest(
		socketPath,
		{ id: `omp:panes:${Date.now().toString(36)}`, method: "pane.list", params: {} },
		timeoutMs,
	);
	const panes = response?.result?.panes;
	if (!Array.isArray(panes)) return [];
	const out: HerdrPaneInfo[] = [];
	for (const pane of panes) {
		const info = parsePaneInfo(pane);
		if (info) out.push(info);
	}
	return out;
}
