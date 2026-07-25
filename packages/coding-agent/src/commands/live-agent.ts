/**
 * `ompx live-agent` — the remote-side transport half of the SSH live bridge
 * (deployment B). A laptop reaches it through `ssh <target> ompx live-agent
 * --session <id>`; the command resolves the session's unix socket under
 * `~/.omp/run/live/` and becomes a transparent bidirectional pipe between
 * stdio and that socket.
 *
 * It is a dumb pipe: it does NOT parse or validate bridge frames — the live
 * endpoints on either end do. **stdout carries only frames** (newline-delimited
 * JSON the client parses); every diagnostic, banner, and error goes to stderr.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { LIVE_BRIDGE_PROTO } from "../live/bridge-protocol";

/** Default socket-connect timeout: never hang waiting on a dead/absent socket. */
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** Minimal byte sink for the socket → stdout direction (satisfied by `Bun.stdout.writer()`). */
export interface LiveAgentStdout {
	write(chunk: Uint8Array): unknown;
	flush?(): unknown;
}

export interface LiveAgentPumpOptions {
	/** Explicit socket path; when set it overrides all session resolution (used by tests). */
	socketPath?: string;
	/** Session id, or `latest`/omitted to auto-detect the single live session. */
	session?: string;
	/** Base directory scanned for `<id>.sock`; defaults to `~/.omp/run/live`. */
	runDir?: string;
	/** Client → socket byte source; defaults to `Bun.stdin.stream()`. */
	stdin?: ReadableStream<Uint8Array>;
	/** Socket → client byte sink; defaults to `Bun.stdout.writer()`. */
	stdout?: LiveAgentStdout;
	/** Diagnostic sink; defaults to `process.stderr`. NEVER stdout. */
	stderr?: (text: string) => void;
	/** Abort signal (wired to SIGINT/SIGTERM by the command). */
	signal?: AbortSignal;
	/** Connect timeout in ms. */
	connectTimeoutMs?: number;
}

/** A session id must be a plain filename component — no separators, no traversal. */
function isValidSessionId(id: string): boolean {
	if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		if ("code" in error && typeof error.code === "string") {
			return `${error.code}: ${error.message}`;
		}
		return error.message;
	}
	return String(error);
}

type ResolvedSocket = { kind: "ok"; path: string } | { kind: "error"; code: number };

/**
 * Resolve the target socket path from options. Writes a stderr diagnostic and
 * returns a non-zero code for every failure mode; never throws.
 */
function resolveSocketPath(options: LiveAgentPumpOptions, stderr: (text: string) => void): ResolvedSocket {
	if (options.socketPath !== undefined) return { kind: "ok", path: options.socketPath };

	const runDir = options.runDir ?? path.join(getConfigRootDir(), "run", "live");
	const session = options.session?.trim();

	if (session && session !== "latest") {
		if (!isValidSessionId(session)) {
			stderr(`live-agent: invalid session id ${JSON.stringify(session)}\n`);
			return { kind: "error", code: 1 };
		}
		return { kind: "ok", path: path.join(runDir, `${session}.sock`) };
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(runDir);
	} catch {
		stderr(`live-agent: no live-enabled session is running on this host (looked in ${runDir})\n`);
		return { kind: "error", code: 1 };
	}

	const ids = entries
		.filter(name => name.endsWith(".sock"))
		.map(name => name.slice(0, -".sock".length))
		.filter(id => id.length > 0)
		.sort();

	if (ids.length === 0) {
		stderr("live-agent: no live-enabled session is running on this host\n");
		return { kind: "error", code: 1 };
	}
	if (ids.length > 1) {
		stderr("live-agent: multiple live sessions are running; pass --session <id>:\n");
		for (const id of ids) stderr(`  ${id}\n`);
		return { kind: "error", code: 1 };
	}

	const only = ids[0];
	if (!only) {
		stderr("live-agent: no live-enabled session is running on this host\n");
		return { kind: "error", code: 1 };
	}
	return { kind: "ok", path: path.join(runDir, `${only}.sock`) };
}

interface Connection {
	readable: ReadableStream<Uint8Array>;
	socket: Bun.Socket<undefined>;
}

/**
 * Connect to a unix socket, resolving with the read stream and socket. Rejects
 * (rather than hanging) on connect failure — ENOENT (missing), ECONNREFUSED
 * (stale socket from a crashed process), EACCES, ENOTSOCK — and on timeout.
 */
async function connectUnixSocket(unixPath: string, timeoutMs: number): Promise<Connection> {
	const { promise, resolve, reject } = Promise.withResolvers<Connection>();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let opened = false;

	const readable = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});

	const timer = setTimeout(() => {
		reject(new Error(`timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	void promise.then(
		() => clearTimeout(timer),
		() => clearTimeout(timer),
	);

	Bun.connect({
		unix: unixPath,
		socket: {
			open(socket) {
				opened = true;
				resolve({ readable, socket });
			},
			data(_socket, data) {
				controller?.enqueue(new Uint8Array(data));
			},
			close() {
				if (!opened) reject(new Error("closed before opening"));
				try {
					controller?.close();
				} catch {
					/* already closed */
				}
			},
			error(_socket, error) {
				if (!opened) reject(error);
				try {
					controller?.error(error);
				} catch {
					/* already closed */
				}
			},
		},
	}).catch(error => {
		// Bun.connect rejects synchronously on some failures (e.g. ENOENT)
		// without firing the socket `error` handler.
		if (!opened) reject(error);
	});

	return promise;
}

/**
 * Run the stdio ↔ unix-socket pump. Resolves with the process exit code:
 * 0 on a clean half-close from either side, non-zero on any failure. Every
 * diagnostic goes to stderr; stdout receives only raw socket bytes.
 */
export async function runLiveAgentPump(options: LiveAgentPumpOptions = {}): Promise<number> {
	const stderr =
		options.stderr ??
		((text: string) => {
			process.stderr.write(text);
		});

	const resolved = resolveSocketPath(options, stderr);
	if (resolved.kind === "error") return resolved.code;
	const socketPath = resolved.path;

	// A path that exists but is not a socket would produce an opaque connect
	// error; report it clearly instead. A missing path falls through to connect,
	// which surfaces ENOENT per the connection-error contract.
	try {
		const stat = fs.statSync(socketPath);
		if (!stat.isSocket()) {
			stderr(`live-agent: ${socketPath} exists but is not a socket\n`);
			return 1;
		}
	} catch {
		/* missing or unstatable — let connect report the real cause */
	}

	let connection: Connection;
	try {
		connection = await connectUnixSocket(socketPath, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
	} catch (error) {
		stderr(`live-agent: cannot connect to ${socketPath}: ${describeError(error)}\n`);
		return 1;
	}
	const { readable, socket } = connection;
	stderr(`live-agent: connected to ${socketPath} (proto ${LIVE_BRIDGE_PROTO})\n`);

	const stdout = options.stdout ?? Bun.stdout.writer();
	const stdin = options.stdin ?? Bun.stdin.stream();
	const reader = stdin.getReader();

	const done = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	const finish = (code: number, cause?: unknown) => {
		if (exitCode !== null) return;
		exitCode = code;
		if (cause !== undefined) stderr(`live-agent: ${describeError(cause)}\n`);
		try {
			void reader.cancel().catch(() => {});
		} catch {
			/* already released */
		}
		try {
			socket.end();
		} catch {
			/* already closed */
		}
		try {
			stdout.flush?.();
		} catch {
			/* nothing buffered */
		}
		done.resolve(code);
	};

	// socket → stdout: raw bytes, flushed per chunk to keep the control channel low-latency.
	void (async () => {
		try {
			for await (const chunk of readable) {
				stdout.write(chunk);
				stdout.flush?.();
			}
			finish(0); // socket closed cleanly
		} catch (error) {
			finish(1, error);
		}
	})();

	// stdin → socket.
	void (async () => {
		try {
			while (true) {
				const { done: readerDone, value } = await reader.read();
				if (readerDone) break;
				if (value && value.byteLength > 0) {
					socket.write(value);
					socket.flush();
				}
			}
			finish(0); // stdin EOF → half-close the socket and exit 0
		} catch (error) {
			// A write racing socket teardown is expected during shutdown; only
			// surface it when we have not already settled.
			if (exitCode === null) finish(1, error);
		}
	})();

	const signal = options.signal;
	if (signal) {
		if (signal.aborted) finish(0);
		else signal.addEventListener("abort", () => finish(0), { once: true });
	}

	return done.promise;
}

export default class LiveAgent extends Command {
	static description = "Bridge stdio to a live session's unix socket (used by `ompx live --attach`)";
	static hidden = true;

	static flags = {
		session: Flags.string({
			char: "s",
			description: "Session id, or 'latest' to auto-detect the one running live session",
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(LiveAgent);
		const controller = new AbortController();
		const onSignal = () => {
			controller.abort();
		};
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		try {
			process.exitCode = await runLiveAgentPump({
				session: flags.session,
				signal: controller.signal,
			});
		} finally {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
		}
	}
}
