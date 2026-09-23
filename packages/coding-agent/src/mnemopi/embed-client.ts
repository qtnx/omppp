import { logger } from "@oh-my-pi/pi-utils";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	inferenceWorkerEnv,
	logWorkerMessage,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	type RefCountedWorkerHandle,
} from "../subprocess/worker-client";
import type { MnemopiEmbedModelId, MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

/**
 * Parent-side handle for the mnemopi embeddings subprocess. The runtime
 * implementation is a Bun child process so `onnxruntime-node`'s NAPI
 * constructor + finalizer never run inside the main agent address space —
 * those destructors segfault Bun on Windows when mnemopi's local embedding
 * provider loads fastembed in the main process (issue #3031; the mnemopi
 * sibling of the tiny-model fix from #1606 / #1607).
 */
export type MnemopiEmbedWorkerHandle = RefCountedWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>;

type PendingRequest =
	| { kind: "init"; model: MnemopiEmbedModelId; resolve: (ok: boolean) => void }
	| { kind: "embed"; model: MnemopiEmbedModelId; resolve: (vectors: number[][] | Error) => void };

/**
 * Hidden subcommand on the main CLI that boots the mnemopi embeddings worker
 * in the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

/**
 * Spawn the mnemopi embeddings worker as a subprocess. Exported for tests and
 * the smoke probe; production callers go through {@link spawnMnemopiEmbedWorker}.
 * The child inherits the parent env — fastembed honours `HF_HUB_*`,
 * `HTTPS_PROXY`, etc., and our `loadFastembed()` reads the same `OMP_*`
 * runtime-install knobs the parent uses.
 */
export function createMnemopiEmbedSubprocess(): SpawnedSubprocess<MnemopiEmbedWorkerOutbound> {
	return createWorkerSubprocess<MnemopiEmbedWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(MNEMOPI_EMBED_WORKER_ARG),
		env: inferenceWorkerEnv(),
		exitLabel: "mnemopi embed subprocess",
	});
}

function wrapSubprocess(spawned: SpawnedSubprocess<MnemopiEmbedWorkerOutbound>): MnemopiEmbedWorkerHandle {
	const { proc } = spawned;
	// Embed keeps its own guarded `proc.send` (neutralizes only the synchronous
	// throw, not the async EPIPE rejection) rather than the shared `safeSend`
	// the other workers use — behaviour preserved verbatim.
	return {
		...createWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(spawned, message => {
			try {
				proc.send(message);
			} catch (error) {
				logger.debug("mnemopi-embed: send to subprocess failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
	};
}

function createUnavailableMnemopiEmbedWorker(error: unknown): MnemopiEmbedWorkerHandle {
	return {
		...createUnavailableWorker<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

function spawnMnemopiEmbedWorker(): MnemopiEmbedWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createMnemopiEmbedSubprocess()),
		createUnavailableMnemopiEmbedWorker,
		"mnemopi embed worker spawn failed; local embeddings disabled",
	);
}

/**
 * Per-model wrapper produced by {@link MnemopiEmbedClient.initialize}.
 * `embed()` round-trips one batch of texts through the worker subprocess and
 * yields the resulting vectors in a single asynchronous batch — fastembed's
 * own iterator was emitting batches that we collect on the child side anyway,
 * and serializing per-batch over IPC would not improve throughput.
 */
export interface MnemopiSubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

/**
 * Upper bound on a steady-state embed IPC round-trip. Initialization is
 * intentionally exempt: bundled installs may spend several minutes installing
 * fastembed and bootstrapping the model, and killing that worker can strand the
 * runtime install lock. Once initialization succeeds, a longer embed stall
 * means a hung native runtime (issue #4792) that would otherwise pin whatever
 * awaits the embed — a turn's memory recall or the headless shutdown
 * consolidation — indefinitely, leaving the process alive with an unreaped
 * `__omp_worker_mnemopi_embed` child (issue #7352). On expiry the embed fails
 * and the worker is SIGKILL-reaped so the next request respawns a fresh one.
 */
const EMBED_REQUEST_TIMEOUT_MS = 120_000;

/**
 * How long a loaded worker may sit with nothing in flight before it is
 * reaped. The loaded model costs every session hundreds of MB of RSS until
 * shutdown, while the TUI idle trim only covers interactive sessions whose
 * trim window happens to land fully idle. A later request respawns the child
 * and it self-initializes from the `(model, cacheDir)` each embed carries.
 */
const EMBED_WORKER_IDLE_MS = 5 * 60_000;

/** Probe budget before routing to the shared server; unreachable hosts must not stall recall. */
const EMBED_SERVER_PROBE_TIMEOUT_MS = 2_000;

/** How long a successful probe vouches for the server before the next one. */
const EMBED_SERVER_UP_TTL_MS = 60_000;

/** After a failed probe or request, embed locally for this long before retrying the server. */
const EMBED_SERVER_DOWN_TTL_MS = 60_000;

/** Race marker for {@link MnemopiEmbedClient.#awaitRequest}. */
const REQUEST_TIMED_OUT = Symbol("mnemopi.embed.timedOut");

export class MnemopiEmbedClient {
	#worker: MnemopiEmbedWorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#refed = false;
	#idleTimer: NodeJS.Timeout | undefined;
	#spawnWorker: () => MnemopiEmbedWorkerHandle;
	#requestTimeoutMs: number;
	#idleTimeoutMs: number;
	#serverUrl = "";
	#serverUpUntil = 0;
	#serverDownUntil = 0;

	constructor(
		spawnWorker: () => MnemopiEmbedWorkerHandle = spawnMnemopiEmbedWorker,
		requestTimeoutMs: number = EMBED_REQUEST_TIMEOUT_MS,
		idleTimeoutMs: number = EMBED_WORKER_IDLE_MS,
	) {
		this.#spawnWorker = spawnWorker;
		this.#requestTimeoutMs = requestTimeoutMs;
		this.#idleTimeoutMs = idleTimeoutMs;
	}

	/**
	 * Route embeds to a shared `ompx mnemopi-embed-server` so every session on
	 * the tailnet reuses one loaded model instead of spawning its own worker.
	 * Empty disables it. Any probe or request failure falls back to the local
	 * worker for {@link EMBED_SERVER_DOWN_TTL_MS}.
	 */
	setServerUrl(url: string | undefined): void {
		const next = url?.trim().replace(/\/+$/, "") ?? "";
		if (next === this.#serverUrl) return;
		this.#serverUrl = next;
		this.#serverUpUntil = 0;
		this.#serverDownUntil = 0;
	}

	/**
	 * Load the named fastembed model inside the subprocess. Resolves to a
	 * thin wrapper whose `embed()` round-trips through the same worker, or
	 * `null` when the worker cannot init the model (missing peer, native
	 * load failure, etc.). Multiple calls with the same model reuse the
	 * single in-flight worker; calling with a different model loads it on
	 * the child without restarting the process. When the shared embed server
	 * answers its probe, no local worker is spawned at all.
	 */
	async initialize(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
	): Promise<MnemopiSubprocessEmbeddingModel | null> {
		if (this.#serverUrl && (await this.#serverReady())) {
			return { embed: (texts, batchSize) => this.#streamEmbed(model, cacheDir, texts, batchSize) };
		}
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#addPending(id, { kind: "init", model, resolve });
			try {
				worker.send({ type: "init", id, model, cacheDir });
				const ok = await promise;
				if (!ok) return null;
			} finally {
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("mnemopi-embed: init failed", {
				model,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		return { embed: (texts, batchSize) => this.#streamEmbed(model, cacheDir, texts, batchSize) };
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(new Error("mnemopi embed worker terminated"));
		}
		this.#pending.clear();
		this.#refed = false;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	async #embed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		// Only await the probe when a server is configured: the local path must
		// send in the same tick so callers observe the request as in flight.
		if (this.#serverUrl && (await this.#serverReady())) {
			try {
				return await this.#embedRemote(model, texts, batchSize);
			} catch (error) {
				logger.warn("mnemopi-embed: shared embed server failed; embedding locally", {
					server: this.#serverUrl,
					error: error instanceof Error ? error.message : String(error),
				});
				this.#markServerDown();
			}
		}
		return this.#embedLocal(model, cacheDir, texts, batchSize);
	}

	/** Whether the shared server should take this request; probes `/health` at most once per TTL. */
	async #serverReady(): Promise<boolean> {
		if (!this.#serverUrl) return false;
		const now = Date.now();
		if (now < this.#serverDownUntil) return false;
		if (now < this.#serverUpUntil) return true;
		try {
			const response = await fetch(`${this.#serverUrl}/health`, {
				signal: AbortSignal.timeout(EMBED_SERVER_PROBE_TIMEOUT_MS),
			});
			if (response.ok) {
				this.#serverUpUntil = Date.now() + EMBED_SERVER_UP_TTL_MS;
				return true;
			}
		} catch (error) {
			logger.debug("mnemopi-embed: shared embed server unreachable", {
				server: this.#serverUrl,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.#markServerDown();
		return false;
	}

	#markServerDown(): void {
		this.#serverUpUntil = 0;
		this.#serverDownUntil = Date.now() + EMBED_SERVER_DOWN_TTL_MS;
	}

	async #embedRemote(model: MnemopiEmbedModelId, texts: string[], batchSize: number | undefined): Promise<number[][]> {
		// The server resolves `model` against its own fastembed cache; the caller's
		// `cacheDir` is a path on another machine.
		const response = await fetch(`${this.#serverUrl}/v1/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model, texts, batchSize }),
			signal: AbortSignal.timeout(this.#requestTimeoutMs),
		});
		if (!response.ok) throw new Error(`server answered ${response.status}: ${await response.text()}`);
		const { vectors } = (await response.json()) as { vectors?: unknown };
		if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(Array.isArray)) {
			throw new Error("server returned a malformed embedding response");
		}
		return vectors as number[][];
	}

	async #embedLocal(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<number[][] | Error>();
		this.#addPending(id, { kind: "embed", model, resolve });
		try {
			// Carry the (model, cacheDir) the wrapper was bound to in every
			// embed message: dispose + respawn between two embeds on the same
			// `LocalEmbeddingModel` handle would otherwise hit a fresh
			// worker's "embed before init" guard. Worker `ensureLoaded` is
			// idempotent so steady-state embeds pay no extra cost.
			worker.send({ type: "embed", id, model, cacheDir, texts, batchSize });
			const result = await this.#awaitRequest(promise);
			if (result instanceof Error) throw result;
			return result;
		} finally {
			this.#deletePending(id);
		}
	}

	/**
	 * Await one steady-state embed reply, bounded by
	 * {@link EMBED_REQUEST_TIMEOUT_MS}. The timeout timer is `unref`'d so a
	 * pending request has only the worker reference keeping the parent event
	 * loop alive. On expiry the wedged worker is SIGKILL-reaped via
	 * {@link terminate} — faulting any other in-flight request and letting the
	 * next call respawn a fresh child — before the request rejects, so a hung
	 * native runtime cannot pin a turn's recall or shutdown consolidation
	 * forever (issue #7352).
	 */
	async #awaitRequest<T>(promise: Promise<T>): Promise<T> {
		const { promise: timedOut, resolve: fire } = Promise.withResolvers<typeof REQUEST_TIMED_OUT>();
		const timer = setTimeout(() => fire(REQUEST_TIMED_OUT), this.#requestTimeoutMs);
		timer.unref();
		try {
			const winner = await Promise.race([promise, timedOut]);
			if (winner === REQUEST_TIMED_OUT) {
				void this.terminate();
				throw new Error("mnemopi embed worker request timed out");
			}
			return winner;
		} finally {
			clearTimeout(timer);
		}
	}

	async *#streamEmbed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): AsyncIterable<number[][]> {
		const vectors = await this.#embed(model, cacheDir, texts, batchSize);
		// Mnemopi's `collectMatrix` re-batches via async iteration anyway; yield
		// a single batch carrying the full result so the caller's drain loop
		// behaves identically to the in-process fastembed iterator (one yield
		// per `embed()` call) without paying extra IPC round-trips.
		yield vectors;
	}

	#ensureWorker(): MnemopiEmbedWorkerHandle {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	/** Register a pending request and keep the worker referenced while work is in flight. */
	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef();
	}

	/** Drop a pending request and unref the worker once nothing is in flight. */
	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	/**
	 * The embeddings subprocess is spawned unref'd so an idle interactive or
	 * daemon session never blocks exit. Keep it referenced only while a request
	 * is pending so short-lived print-mode commands cannot exit before recall
	 * receives the worker response (issue #12067). Once nothing is in flight,
	 * arm {@link EMBED_WORKER_IDLE_MS}; any new request disarms it.
	 */
	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		if (!shouldRef) {
			this.#idleTimer = setTimeout(() => {
				this.#idleTimer = undefined;
				if (this.#worker === worker && this.#pending.size === 0) void this.terminate();
			}, this.#idleTimeoutMs);
			this.#idleTimer.unref();
		}
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: MnemopiEmbedWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#deletePending(message.id);
		if (message.type === "ready") {
			if (pending.kind === "init") pending.resolve(true);
			return;
		}
		if (message.type === "vectors") {
			if (pending.kind === "embed") pending.resolve(message.vectors);
			return;
		}
		logger.debug("mnemopi-embed: worker returned error", { error: message.error });
		if (pending.kind === "init") pending.resolve(false);
		else pending.resolve(new Error(message.error));
	}

	#handleWorkerError(error: Error): void {
		logger.warn("mnemopi-embed: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const mnemopiEmbedClient = new MnemopiEmbedClient();

export async function shutdownMnemopiEmbedClient(): Promise<void> {
	await mnemopiEmbedClient.terminate();
}

export async function smokeTestMnemopiEmbedWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createMnemopiEmbedSubprocess()), "mnemopi embed worker", timeoutMs);
}
