import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LiveAgentStdout, runLiveAgentPump } from "@oh-my-pi/pi-coding-agent/commands/live-agent";

const encoder = new TextEncoder();
const NEWLINE = 0x0a;

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** In-memory stdout sink that resolves `line` once a full newline-terminated frame lands. */
function makeStdout(): LiveAgentStdout & { chunks: Uint8Array[]; line: Promise<Uint8Array>; bytes(): Uint8Array } {
	const chunks: Uint8Array[] = [];
	const line = Promise.withResolvers<Uint8Array>();
	return {
		chunks,
		line: line.promise,
		write(chunk: Uint8Array) {
			chunks.push(new Uint8Array(chunk));
			const all = concat(chunks);
			if (all.includes(NEWLINE)) line.resolve(all);
		},
		bytes() {
			return concat(chunks);
		},
	};
}

function makeStdin(): { stream: ReadableStream<Uint8Array>; push(bytes: Uint8Array): void; end(): void } {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		stream,
		push(bytes: Uint8Array) {
			controller.enqueue(bytes);
		},
		end() {
			controller.close();
		},
	};
}

describe("runLiveAgentPump", () => {
	it("pumps frames both directions and closes the socket on stdin EOF", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-agent-"));
		const socketPath = path.join(dir, "s.sock");

		const serverSocketReady = Promise.withResolvers<Bun.Socket<undefined>>();
		const serverGotFrame = Promise.withResolvers<Uint8Array>();
		const serverClosed = Promise.withResolvers<void>();
		const received: Uint8Array[] = [];
		const server = Bun.listen({
			unix: socketPath,
			socket: {
				open(sock) {
					serverSocketReady.resolve(sock);
				},
				data(_sock, data) {
					received.push(new Uint8Array(data));
					const all = concat(received);
					if (all.includes(NEWLINE)) serverGotFrame.resolve(all);
				},
				close() {
					serverClosed.resolve();
				},
			},
		});

		const stdin = makeStdin();
		const stdout = makeStdout();
		const stderr: string[] = [];
		const pump = runLiveAgentPump({
			socketPath,
			stdin: stdin.stream,
			stdout,
			stderr: text => stderr.push(text),
		});

		const serverSock = await serverSocketReady.promise;

		// (i) a frame written to stdin arrives at the server byte-identical.
		const clientFrame = encoder.encode('{"t":"hello","proto":1}\n');
		stdin.push(clientFrame);
		expect(await serverGotFrame.promise).toEqual(clientFrame);

		// (ii) a frame the server writes arrives on stdout byte-identical.
		const serverFrame = encoder.encode('{"t":"welcome","proto":1,"sessionId":"abc"}\n');
		serverSock.write(serverFrame);
		serverSock.flush();
		expect(await stdout.line).toEqual(serverFrame);

		// (iii) stdin EOF closes the socket.
		stdin.end();
		await serverClosed.promise;
		expect(await pump).toBe(0);

		server.stop(true);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("exits non-zero and writes nothing to stdout when the socket is missing", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-agent-"));
		const socketPath = path.join(dir, "s.sock");
		const stdout = makeStdout();
		const stderr: string[] = [];
		const code = await runLiveAgentPump({
			socketPath,
			stdin: makeStdin().stream,
			stdout,
			stderr: text => stderr.push(text),
			connectTimeoutMs: 1_000,
		});
		expect(code).not.toBe(0);
		expect(stdout.chunks.length).toBe(0);
		expect(stderr.join("")).toContain(socketPath);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("rejects a traversal session id without touching the filesystem", async () => {
		const stdout = makeStdout();
		const stderr: string[] = [];
		const code = await runLiveAgentPump({
			session: "../etc/passwd",
			stdout,
			stderr: text => stderr.push(text),
		});
		expect(code).not.toBe(0);
		expect(stdout.chunks.length).toBe(0);
		expect(stderr.join("")).toContain("invalid session id");
	});

	it("reports no live session when the run dir has no sockets", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-agent-empty-"));
		const stdout = makeStdout();
		const stderr: string[] = [];
		const code = await runLiveAgentPump({
			runDir: dir,
			stdout,
			stderr: text => stderr.push(text),
		});
		expect(code).not.toBe(0);
		expect(stdout.chunks.length).toBe(0);
		expect(stderr.join("")).toContain("no live-enabled session");
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
