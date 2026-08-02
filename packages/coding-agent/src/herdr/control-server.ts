/**
 * Per-session herdr control socket: a running ompx session serves a unix
 * socket accepting newline-delimited JSON requests so an external process
 * (herdr, `ompx prompt`) can inject an exact prompt into the live session
 * without going through the TTY.
 *
 * Wire protocol (one JSON line per request/response):
 *   request : {"v":1,"id":string,"method":string,"params":object}
 *   success : {"v":1,"id":<echo>,"result":{...}}
 *   error   : {"v":1,"id":<echo>,"error":{"code":string,"message":string}}
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, logger } from "@oh-my-pi/pi-utils";

export const CONTROL_PROTOCOL_VERSION = 1;

/** Requests never buffer more than this many bytes per line. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type ControlDeliverMode = "steer" | "followUp";
export type ControlAcceptedMode = "turn" | "steer" | "followUp";

/** Descriptor JSON written beside the socket so clients can discover sessions. */
export interface ControlDescriptor {
	version: number;
	sessionId: string;
	pid: number;
	socket: string;
	cwd: string;
	startedAt: number;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
}

export interface ControlSubmitResult {
	mode: ControlAcceptedMode;
}

export interface HerdrControlServerOptions {
	sessionId: string;
	cwd: string;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	/** Injects the prompt into the live session. Throws to reject the request. */
	submit(text: string, options: { deliverAs?: ControlDeliverMode }): ControlSubmitResult;
	isIdle(): boolean;
	/** Extra fields merged into the `session.status` result. */
	status?(): Record<string, unknown>;
	/** Test seam; defaults to `<configRoot>/run/control`. */
	runDir?: string;
}

/** Directory holding one control socket + descriptor per live session. */
export function controlRunDir(): string {
	return path.join(getConfigRootDir(), "run", "control");
}

export function controlSocketPath(sessionId: string, runDir?: string): string {
	return path.join(runDir ?? controlRunDir(), `${sessionId}.sock`);
}

export function controlDescriptorPath(sessionId: string, runDir?: string): string {
	return path.join(runDir ?? controlRunDir(), `${sessionId}.json`);
}

interface ControlSocket {
	write(data: string): unknown;
	end(): unknown;
	terminate?(): unknown;
	data?: unknown;
}

interface ControlRequest {
	v?: number;
	id?: string;
	method?: string;
	params?: Record<string, unknown>;
}

/** Serves the per-session control socket. See module doc for the wire protocol. */
export class HerdrControlServer {
	readonly #options: HerdrControlServerOptions;
	readonly socketPath: string;
	readonly #descriptorPath: string;
	#server: { stop(closeActiveConnections?: boolean): void; unref?(): void } | undefined;
	/** Per-connection partial line buffers. */
	readonly #buffers = new Map<ControlSocket, Buffer>();

	constructor(options: HerdrControlServerOptions) {
		this.#options = options;
		const runDir = options.runDir ?? controlRunDir();
		this.socketPath = controlSocketPath(options.sessionId, runDir);
		this.#descriptorPath = controlDescriptorPath(options.sessionId, runDir);
	}

	/** Bind the socket, then write the discovery descriptor. */
	async start(): Promise<void> {
		if (this.#server) return;
		await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
		// A crashed session leaves its socket file behind; binding over it is safe
		// because the path is namespaced by session id and the old pid is gone.
		await this.#unlink(this.socketPath);
		this.#server = Bun.listen<undefined>({
			unix: this.socketPath,
			socket: {
				open: () => {},
				data: (socket, chunk) => this.#handleData(socket as unknown as ControlSocket, chunk),
				close: socket => {
					this.#buffers.delete(socket as unknown as ControlSocket);
				},
				error: (socket, error) => {
					logger.warn("Herdr control socket error", { error: error.message });
					this.#buffers.delete(socket as unknown as ControlSocket);
				},
			},
		});
		this.#server.unref?.();
		await fs.chmod(this.socketPath, 0o600);
		const descriptor: ControlDescriptor = {
			version: CONTROL_PROTOCOL_VERSION,
			sessionId: this.#options.sessionId,
			pid: process.pid,
			socket: this.socketPath,
			cwd: this.#options.cwd,
			startedAt: Date.now(),
			...(this.#options.paneId ? { paneId: this.#options.paneId } : {}),
			...(this.#options.tabId ? { tabId: this.#options.tabId } : {}),
			...(this.#options.workspaceId ? { workspaceId: this.#options.workspaceId } : {}),
		};
		await Bun.write(this.#descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
		await fs.chmod(this.#descriptorPath, 0o600);
	}

	/** Stop listening and remove the socket + descriptor. Idempotent; never throws. */
	async close(): Promise<void> {
		try {
			this.#server?.stop(true);
		} catch (error) {
			logger.debug("Herdr control server stop failed", { error: String(error) });
		}
		this.#server = undefined;
		this.#buffers.clear();
		await this.#unlink(this.socketPath);
		await this.#unlink(this.#descriptorPath);
	}

	async #unlink(file: string): Promise<void> {
		try {
			await fs.unlink(file);
		} catch {
			// Already absent, or unremovable — either way close() must not throw.
		}
	}

	#handleData(socket: ControlSocket, chunk: Uint8Array): void {
		try {
			let buffered = Buffer.concat([this.#buffers.get(socket) ?? Buffer.alloc(0), Buffer.from(chunk)]);
			while (true) {
				const newlineIndex = buffered.indexOf(0x0a);
				if (newlineIndex === -1) break;
				if (newlineIndex > MAX_LINE_BYTES) {
					this.#respondError(socket, "", "invalid_request", "request too large");
					this.#buffers.delete(socket);
					this.#destroy(socket);
					return;
				}
				const line = buffered.subarray(0, newlineIndex).toString("utf8");
				buffered = buffered.subarray(newlineIndex + 1);
				if (line.trim() === "") continue;
				this.#handleLine(socket, line);
			}
			if (buffered.byteLength > MAX_LINE_BYTES) {
				this.#respondError(socket, "", "invalid_request", "request too large");
				this.#buffers.delete(socket);
				this.#destroy(socket);
				return;
			}
			this.#buffers.set(socket, buffered);
		} catch (error) {
			logger.warn("Herdr control request handling failed", { error: String(error) });
		}
	}

	#destroy(socket: ControlSocket): void {
		try {
			(socket.terminate ?? socket.end).call(socket);
		} catch {
			// Peer already gone.
		}
	}

	#handleLine(socket: ControlSocket, line: string): void {
		let request: ControlRequest;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				this.#respondError(socket, "", "invalid_request", "request must be a JSON object");
				return;
			}
			request = parsed as ControlRequest;
		} catch {
			this.#respondError(socket, "", "invalid_request", "malformed JSON");
			return;
		}
		const id = typeof request.id === "string" ? request.id : "";
		const method = typeof request.method === "string" ? request.method : "";
		const params = typeof request.params === "object" && request.params !== null ? request.params : {};

		switch (method) {
			case "session.ping": {
				this.#respondResult(socket, id, {
					ok: true,
					sessionId: this.#options.sessionId,
					pid: process.pid,
					...(this.#options.paneId ? { paneId: this.#options.paneId } : {}),
				});
				return;
			}
			case "session.status": {
				let extra: Record<string, unknown> = {};
				try {
					extra = this.#options.status?.() ?? {};
				} catch (error) {
					logger.debug("Herdr control status() threw", { error: String(error) });
				}
				this.#respondResult(socket, id, {
					sessionId: this.#options.sessionId,
					pid: process.pid,
					cwd: this.#options.cwd,
					...(this.#options.paneId ? { paneId: this.#options.paneId } : {}),
					idle: this.#safeIsIdle(),
					...extra,
				});
				return;
			}
			case "session.prompt": {
				this.#handlePrompt(socket, id, params);
				return;
			}
			default:
				this.#respondError(socket, id, "unknown_method", `unknown method: ${method || "(missing)"}`);
		}
	}

	#safeIsIdle(): boolean {
		try {
			return this.#options.isIdle();
		} catch {
			return false;
		}
	}

	#handlePrompt(socket: ControlSocket, id: string, params: Record<string, unknown>): void {
		const text = params.text;
		if (typeof text !== "string" || text.length === 0) {
			this.#respondError(socket, id, "invalid_params", "text must be a non-empty string");
			return;
		}
		const deliverAs =
			params.deliverAs === "steer" || params.deliverAs === "followUp"
				? (params.deliverAs as ControlDeliverMode)
				: undefined;
		if (params.requireIdle === true && !this.#safeIsIdle()) {
			this.#respondError(socket, id, "busy", "session is busy");
			return;
		}
		let result: ControlSubmitResult;
		try {
			result = this.#options.submit(text, { deliverAs });
		} catch (error) {
			this.#respondError(socket, id, "internal", error instanceof Error ? error.message : String(error));
			return;
		}
		this.#respondResult(socket, id, {
			accepted: true,
			mode: result.mode,
			sessionId: this.#options.sessionId,
			...(this.#options.paneId ? { paneId: this.#options.paneId } : {}),
		});
	}

	#respondResult(socket: ControlSocket, id: string, result: Record<string, unknown>): void {
		this.#send(socket, { v: CONTROL_PROTOCOL_VERSION, id, result });
	}

	#respondError(socket: ControlSocket, id: string, code: string, message: string): void {
		this.#send(socket, { v: CONTROL_PROTOCOL_VERSION, id, error: { code, message } });
	}

	#send(socket: ControlSocket, payload: Record<string, unknown>): void {
		try {
			socket.write(`${JSON.stringify(payload)}\n`);
		} catch (error) {
			logger.debug("Herdr control response write failed", { error: String(error) });
		}
	}
}
