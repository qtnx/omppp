/**
 * Contract: sessions pointed at a shared `mnemopi-embed-server` embed through
 * it without spawning a local worker, fall back to their local worker when the
 * server is unreachable, and the server rejects malformed requests before they
 * reach the model. Fake workers keep fastembed out; the HTTP hop is real.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";
import { startMnemopiEmbedServer } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-server";

/** Fake worker whose vectors are `[text.length, marker]`, so tests can tell who embedded. */
function markedWorker(marker: number, stats: { spawns: number }): () => MnemopiEmbedWorkerHandle {
	return () => {
		stats.spawns += 1;
		let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
		return {
			send(message: MnemopiEmbedWorkerInbound) {
				queueMicrotask(() => {
					if (message.type === "init") handler?.({ type: "ready", id: message.id });
					else if (message.type === "embed") {
						handler?.({
							type: "vectors",
							id: message.id,
							// Real fastembed rows are Float32Array, not number[].
							vectors: message.texts.map(text => new Float32Array([text.length, marker]) as unknown as number[]),
						});
					}
				});
			},
			onMessage(next) {
				handler = next;
				return () => {
					if (handler === next) handler = undefined;
				};
			},
			onError() {
				return () => {};
			},
			ref() {},
			unref() {},
			async terminate() {
				handler = undefined;
			},
		};
	};
}

async function embedAll(client: MnemopiEmbedClient, texts: string[]): Promise<number[][]> {
	const model = await client.initialize("fast-bge-base-en-v1.5", "/client/cache");
	expect(model).not.toBeNull();
	const rows: number[][] = [];
	for await (const batch of model!.embed(texts, 8)) rows.push(...batch.map(row => Array.from(row)));
	return rows;
}

const SERVER_MARK = 1;
const LOCAL_MARK = 0;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function startServer(): Server<undefined> {
	const serverClient = new MnemopiEmbedClient(markedWorker(SERVER_MARK, { spawns: 0 }));
	const server = startMnemopiEmbedServer({ hostname: "127.0.0.1", port: 0, client: serverClient });
	cleanups.push(async () => {
		await server.stop(true);
		await serverClient.terminate();
	});
	return server;
}

function sessionClient(serverUrl: string, localStats: { spawns: number }): MnemopiEmbedClient {
	const client = new MnemopiEmbedClient(markedWorker(LOCAL_MARK, localStats));
	client.setServerUrl(serverUrl);
	cleanups.push(() => client.terminate());
	return client;
}

describe("shared mnemopi embed server", () => {
	it("embeds through the server without spawning a local worker", async () => {
		const server = startServer();
		const local = { spawns: 0 };
		const client = sessionClient(server.url.href, local);

		expect(await embedAll(client, ["ab", "abcd"])).toEqual([
			[2, SERVER_MARK],
			[4, SERVER_MARK],
		]);
		expect(local.spawns).toBe(0);
	});

	it("falls back to the local worker when the server is unreachable", async () => {
		const server = startServer();
		const url = server.url.href;
		await server.stop(true);
		const local = { spawns: 0 };
		const client = sessionClient(url, local);

		expect(await embedAll(client, ["abc"])).toEqual([[3, LOCAL_MARK]]);
		expect(local.spawns).toBe(1);
	});

	it("rejects a model id that is not a fastembed id", async () => {
		const server = startServer();
		const response = await fetch(new URL("/v1/embed", server.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "../../etc", texts: ["x"] }),
		});
		expect(response.status).toBe(400);
	});
});
