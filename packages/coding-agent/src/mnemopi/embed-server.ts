/**
 * Shared mnemopi embeddings server (`ompx mnemopi-embed-server`). One host
 * (codemc on the tailnet) loads the fastembed model once and every ompx
 * session embeds through it instead of spawning its own ~0.4 GB worker. The
 * model still runs in the usual worker subprocess behind a
 * {@link MnemopiEmbedClient}, so it keeps the request timeout, crash respawn,
 * and idle release that local sessions get.
 */
import type { Server } from "bun";
import { MnemopiEmbedClient, type MnemopiSubprocessEmbeddingModel } from "./embed-client";

export const MNEMOPI_EMBED_SERVER_PORT = 8793;

/** fastembed model ids (`fast-bge-base-en-v1.5`, …); the id becomes a cache path segment. */
const MODEL_ID = /^fast-[A-Za-z0-9][A-Za-z0-9.-]*$/;
const MAX_TEXTS = 256;
const MAX_BATCH_SIZE = 256;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export interface MnemopiEmbedServerOptions {
	hostname: string;
	port: number;
	/** Test seam; production uses a client that spawns the local worker subprocess. */
	client?: MnemopiEmbedClient;
}

interface EmbedRequest {
	model: string;
	texts: string[];
	batchSize?: number;
}

function parseEmbedRequest(body: unknown): EmbedRequest | string {
	if (typeof body !== "object" || body === null) return "body must be a JSON object";
	const { model, texts, batchSize } = body as Record<string, unknown>;
	if (typeof model !== "string" || !MODEL_ID.test(model))
		return "model must be a fastembed id like fast-bge-base-en-v1.5";
	if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS) {
		return `texts must be an array of 1-${MAX_TEXTS} strings`;
	}
	if (!texts.every(text => typeof text === "string")) return "texts must contain only strings";
	if (
		batchSize !== undefined &&
		(typeof batchSize !== "number" || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE)
	) {
		return `batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}`;
	}
	return { model, texts: texts as string[], batchSize };
}

export function startMnemopiEmbedServer({
	hostname,
	port,
	client = new MnemopiEmbedClient(),
}: MnemopiEmbedServerOptions): Server<undefined> {
	const models = new Map<string, Promise<MnemopiSubprocessEmbeddingModel | null>>();

	const loadModel = async (model: string): Promise<MnemopiSubprocessEmbeddingModel | null> => {
		let loading = models.get(model);
		if (!loading) {
			// The server's own fastembed cache: `cacheDir` undefined selects the default root.
			loading = client.initialize(model, undefined);
			models.set(model, loading);
		}
		const loaded = await loading;
		// A failed load must not stick: retry on the next request.
		if (!loaded && models.get(model) === loading) models.delete(model);
		return loaded;
	};

	return Bun.serve({
		hostname,
		port,
		maxRequestBodySize: MAX_REQUEST_BYTES,
		routes: {
			"/health": () => Response.json({ ok: true }),
			"/v1/embed": {
				POST: async request => {
					let body: unknown;
					try {
						body = await request.json();
					} catch {
						return Response.json({ error: "body must be JSON" }, { status: 400 });
					}
					const parsed = parseEmbedRequest(body);
					if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
					const model = await loadModel(parsed.model);
					if (!model) return Response.json({ error: `model ${parsed.model} unavailable` }, { status: 503 });
					try {
						const vectors: number[][] = [];
						// fastembed rows are Float32Array, which JSON would encode as `{ "0": … }` objects.
						for await (const batch of model.embed(parsed.texts, parsed.batchSize)) {
							for (const row of batch) vectors.push(Array.from(row));
						}
						return Response.json({ vectors });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return Response.json({ error: message }, { status: 502 });
					}
				},
			},
		},
		fetch: () => Response.json({ error: "not found" }, { status: 404 }),
	});
}
