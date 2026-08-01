/**
 * Client half of the herdr control socket: discovers live ompx sessions by
 * their descriptor files and submits a prompt over the newline-delimited JSON
 * protocol served by {@link HerdrControlServer}.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlAcceptedMode,
	type ControlDeliverMode,
	type ControlDescriptor,
	controlRunDir,
} from "./control-server";

export interface ControlTarget {
	sessionId?: string;
	paneId?: string;
	cwd?: string;
	socketPath?: string;
}

export interface ControlPromptOptions {
	deliverAs?: ControlDeliverMode;
	requireIdle?: boolean;
	timeoutMs?: number;
	runDir?: string;
}

export interface ControlPromptOk {
	ok: true;
	mode: ControlAcceptedMode;
	sessionId: string;
	paneId?: string;
	socketPath: string;
}

export interface ControlPromptErr {
	ok: false;
	code: "no_session" | "ambiguous" | "busy" | "gone" | "timeout" | "protocol" | "internal";
	message: string;
	candidates?: ControlDescriptor[];
}

export type ControlPromptResult = ControlPromptOk | ControlPromptErr;

const DEFAULT_TIMEOUT_MS = 10_000;

/** Live sessions only: descriptors whose pid is alive. Stale descriptor+socket pairs are pruned. */
export async function listControlSessions(runDir?: string): Promise<ControlDescriptor[]> {
	const dir = runDir ?? controlRunDir();
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	const live: ControlDescriptor[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const descriptorPath = path.join(dir, entry);
		let descriptor: ControlDescriptor;
		try {
			const parsed: unknown = JSON.parse(await Bun.file(descriptorPath).text());
			if (typeof parsed !== "object" || parsed === null) continue;
			descriptor = parsed as ControlDescriptor;
		} catch {
			continue;
		}
		if (typeof descriptor.pid !== "number" || typeof descriptor.sessionId !== "string") continue;
		if (pidAlive(descriptor.pid)) {
			live.push(descriptor);
			continue;
		}
		// Dead session: prune its descriptor and socket file.
		try {
			await fs.unlink(descriptorPath);
		} catch {
			/* already gone */
		}
		if (typeof descriptor.socket === "string") {
			try {
				await fs.unlink(descriptor.socket);
			} catch {
				/* already gone */
			}
		}
	}
	return live;
}

/** `kill(pid, 0)` liveness probe; EPERM means alive-but-foreign, ESRCH means dead. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Resolve a target session and deliver `text` verbatim as one prompt. */
export async function sendControlPrompt(
	text: string,
	target: ControlTarget,
	options?: ControlPromptOptions,
): Promise<ControlPromptResult> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let socketPath = target.socketPath;
	let sessionId = target.sessionId ?? "";
	let paneId = target.paneId;
	if (!socketPath) {
		const sessions = await listControlSessions(options?.runDir);
		let matches = sessions;
		if (target.sessionId) matches = sessions.filter(s => s.sessionId === target.sessionId);
		else if (target.paneId) matches = sessions.filter(s => s.paneId === target.paneId);
		else if (target.cwd) matches = sessions.filter(s => s.cwd === target.cwd);
		if (matches.length === 0) {
			return { ok: false, code: "no_session", message: "no matching live ompx session found" };
		}
		if (matches.length > 1) {
			return {
				ok: false,
				code: "ambiguous",
				message: `${matches.length} live sessions match; pass --session, --pane, or --socket`,
				candidates: matches,
			};
		}
		const chosen = matches[0];
		socketPath = chosen.socket;
		sessionId = chosen.sessionId;
		paneId = chosen.paneId;
	}

	const request = JSON.stringify({
		v: CONTROL_PROTOCOL_VERSION,
		id: "1",
		method: "session.prompt",
		params: {
			text,
			...(options?.deliverAs ? { deliverAs: options.deliverAs } : {}),
			...(options?.requireIdle ? { requireIdle: true } : {}),
		},
	});

	let responseLine: string;
	try {
		responseLine = await requestOnce(socketPath, `${request}\n`, timeoutMs);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.message === "timeout") {
			return { ok: false, code: "timeout", message: `no response within ${timeoutMs}ms` };
		}
		if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
			return { ok: false, code: "gone", message: `session socket unreachable: ${err.code}` };
		}
		return { ok: false, code: "gone", message: err.message ?? String(error) };
	}

	let response: { result?: Record<string, unknown>; error?: { code?: string; message?: string } };
	try {
		const parsed: unknown = JSON.parse(responseLine);
		if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
		response = parsed as typeof response;
	} catch {
		return { ok: false, code: "protocol", message: "unparseable response from session" };
	}

	if (response.error) {
		const code = response.error.code === "busy" ? "busy" : "internal";
		return { ok: false, code, message: response.error.message ?? "server error" };
	}
	const result = response.result;
	if (result?.accepted !== true) {
		return { ok: false, code: "protocol", message: "response missing accepted result" };
	}
	const mode = result.mode;
	if (mode !== "turn" && mode !== "steer" && mode !== "followUp") {
		return { ok: false, code: "protocol", message: `unexpected mode in response: ${String(mode)}` };
	}
	const resultSessionId = typeof result.sessionId === "string" ? result.sessionId : sessionId;
	const resultPaneId = typeof result.paneId === "string" ? result.paneId : paneId;
	return {
		ok: true,
		mode,
		sessionId: resultSessionId,
		...(resultPaneId ? { paneId: resultPaneId } : {}),
		socketPath,
	};
}

/** Connect, send one request line, resolve with the first response line. */
async function requestOnce(socketPath: string, payload: string, timeoutMs: number): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let buffer = "";
	let settled = false;
	let sock: { end(): unknown } | undefined;

	const finish = (fn: () => void) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		fn();
		try {
			sock?.end();
		} catch {
			/* already closed */
		}
	};
	const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);

	Bun.connect({
		unix: socketPath,
		socket: {
			open(socket) {
				sock = socket;
				try {
					socket.write(payload);
				} catch (error) {
					finish(() => reject(error instanceof Error ? error : new Error(String(error))));
				}
			},
			data(_socket, chunk) {
				buffer += Buffer.from(chunk).toString("utf8");
				const newline = buffer.indexOf("\n");
				if (newline >= 0) {
					const line = buffer.slice(0, newline);
					finish(() => resolve(line));
				}
			},
			close() {
				finish(() => reject(new Error("connection closed before response")));
			},
			error(_socket, error) {
				logger.debug("Herdr control client socket error", { error: error.message });
				finish(() => reject(error));
			},
		},
	}).catch(error => {
		// Bun.connect rejects synchronously on some failures (e.g. ENOENT)
		// without firing the socket `error` handler.
		finish(() => reject(error instanceof Error ? error : new Error(String(error))));
	});

	return promise;
}
