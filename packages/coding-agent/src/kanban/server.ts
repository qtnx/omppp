import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as os from "node:os";
import { logger } from "@oh-my-pi/pi-utils";
import { KanbanError } from "./errors";
import type { KanbanStore } from "./store";
import type { KanbanActivity, KanbanMutation } from "./types";
import {
	validateCommentCreate,
	validateCommentUpdate,
	validateExpectedVersion,
	validateMove,
	validateTaskCreate,
	validateTaskUpdate,
} from "./validation";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const COOKIE_NAME_PREFIX = "ompx_kanban_";
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Formats the board renders inline and the model can read back as an image. */
const ALLOWED_IMAGE_TYPES: Readonly<Record<string, true>> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
};
/** Server hard ceiling: the largest route limit (attachments) plus slack. */
const HARD_MAX_REQUEST_BODY_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;
const MUTATION_HEADER = "X-OMPx-Kanban";
const SSE_HEARTBEAT_MS = 15_000;
/** Most events one reconnect may replay; a client further behind reloads instead. */
const SSE_REPLAY_LIMIT = 200;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const APP_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export interface KanbanClientAsset {
	body: string | Uint8Array;
	contentType: string;
	cacheControl?: string;
}

export type KanbanClientAssets = Readonly<Record<string, KanbanClientAsset>>;

export interface KanbanServerOptions {
	store: KanbanStore;
	assets: KanbanClientAssets;
	/** The single board this process serves, derived from the project directory. */
	boardId: string;
	port?: number;
	onActivity?: (activity: KanbanActivity) => Promise<void> | void;
	onBoardAccess?: () => Promise<void> | void;
}

export interface KanbanServerHandle {
	readonly port: number;
	readonly localUrl: string;
	/** Board roots reachable over this host's tailnet; empty when Tailscale is down. */
	readonly tailnetUrls: readonly string[];
	/** Publish an activity to connected board clients without model delivery. */
	broadcast(activity: KanbanActivity): void;
	stop(): Promise<void>;
}

interface SseClient {
	boardId: string;
	lastCursor: number;
	controller: ReadableStreamDefaultController<Uint8Array>;
}

function securityHeaders(cacheControl: string): Headers {
	return new Headers({
		"Cache-Control": cacheControl,
		"Content-Security-Policy": APP_CSP,
		"Cross-Origin-Resource-Policy": "same-origin",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	});
}

function decodeSegment(value: string): string | null {
	try {
		const decoded = decodeURIComponent(value);
		if (decoded.length === 0 || decoded.length > 256 || decoded.includes("/") || decoded.includes("\0")) return null;
		return decoded;
	} catch {
		return null;
	}
}

function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	const normalized = address.toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

/**
 * Tailscale's CGNAT range (100.64.0.0/10) and its ULA prefix (fd7a:115c:a1e0::/48).
 * Peers reaching the board over the tailnet always present one of these; nothing
 * else on a LAN or the public internet can.
 */
export function isTailnetAddress(address: string | undefined): boolean {
	if (!address) return false;
	const normalized = address.toLowerCase().replace(/^::ffff:/, "");
	if (normalized.startsWith("fd7a:115c:a1e0:")) return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(normalized);
	if (!v4) return false;
	const first = Number(v4[1]);
	const second = Number(v4[2]);
	return first === 100 && second >= 64 && second <= 127;
}

/** This host's own tailnet addresses, or an empty list when Tailscale is down. */
function localTailnetAddresses(): string[] {
	const found: string[] = [];
	for (const entries of Object.values(os.networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.internal || !isTailnetAddress(entry.address)) continue;
			found.push(entry.address.toLowerCase());
		}
	}
	return found;
}

/** Split `host:port` / `[v6]:port` into its lowercased hostname and port text. */
function splitHostHeader(host: string): { hostname: string; port: string } | null {
	const bracketed = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/.exec(host);
	if (bracketed) return { hostname: bracketed[1]!, port: bracketed[2]! };
	const plain = /^([a-z0-9.-]+):(\d{1,5})$/.exec(host);
	if (plain) return { hostname: plain[1]!, port: plain[2]! };
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createKanbanServer(options: KanbanServerOptions): KanbanServerHandle {
	return new KanbanHttpServer(options).start();
}

class KanbanHttpServer implements KanbanServerHandle {
	port = 0;
	localUrl = "";
	tailnetUrls: readonly string[] = [];
	readonly #options: KanbanServerOptions;
	readonly #capabilitySecret = randomBytes(32);
	readonly #sseClients = new Set<SseClient>();
	/** This host's own tailnet literals, resolved once at bind time. */
	#tailnetAddresses: readonly string[] = [];
	#server: Bun.Server<undefined> | null = null;
	#heartbeat: Timer | null = null;
	#stopped = false;

	constructor(options: KanbanServerOptions) {
		this.#options = options;
	}

	start(): KanbanServerHandle {
		if (this.#server) return this;
		this.#tailnetAddresses = localTailnetAddresses();
		// Loopback-only unless this host is actually on a tailnet. `::` is
		// dual-stack, which the tailnet needs for its IPv6 ULA address; who may
		// talk is still decided by `#authorizePeer`, so the wider bind never
		// widens access.
		const hostname = this.#tailnetAddresses.length > 0 ? "::" : "127.0.0.1";
		this.#server = Bun.serve({
			hostname,
			port: this.#options.port ?? 0,
			idleTimeout: 30,
			maxRequestBodySize: HARD_MAX_REQUEST_BODY_BYTES,
			fetch: async (request, server) => await this.#handleRequest(request, server),
		});
		this.port = this.#server.port ?? 0;
		this.localUrl = `http://127.0.0.1:${this.port}/`;
		this.tailnetUrls = this.#tailnetAddresses.map(
			address => `http://${address.includes(":") ? `[${address}]` : address}:${this.port}/`,
		);
		this.#heartbeat = setInterval(() => this.#heartbeatSse(), SSE_HEARTBEAT_MS);
		logger.debug("Kanban server listening", { port: this.port, hostname, tailnet: this.tailnetUrls.length });
		return this;
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		clearInterval(this.#heartbeat ?? undefined);
		this.#heartbeat = null;
		for (const client of [...this.#sseClients]) this.#closeSseClient(client);
		this.#server?.stop(true);
		this.#server = null;
		logger.debug("Kanban server stopped", { port: this.port });
	}

	async #handleRequest(request: Request, server: Bun.Server<undefined>): Promise<Response> {
		const url = new URL(request.url);
		if (!this.#authorizePeer(request, server)) {
			return this.#error(403, "forbidden", "Forbidden", false);
		}

		try {
			if (request.method === "GET" && url.pathname === "/") return this.#asset("/", false);
			if (request.method === "GET" && url.pathname === "/kanban/") return this.#fallbackBoard();

			const segments = url.pathname.split("/").slice(1);
			if (request.method === "GET" && segments.length === 2 && segments[0] === "kanban") {
				const boardId = decodeSegment(segments[1]!);
				if (!boardId || boardId !== this.#options.boardId)
					throw new KanbanError(404, "not_found", "Board not found");
				await this.#options.onBoardAccess?.();
				return this.#board(boardId);
			}
			if (
				request.method === "GET" &&
				segments.length === 3 &&
				segments[0] === "kanban" &&
				segments[2] === "manifest.webmanifest"
			) {
				const boardId = decodeSegment(segments[1]!);
				if (!boardId || boardId !== this.#options.boardId)
					throw new KanbanError(404, "not_found", "Board not found");
				await this.#options.onBoardAccess?.();
				return this.#sessionManifest(boardId);
			}
			if (request.method === "GET" && Object.hasOwn(this.#options.assets, url.pathname)) {
				return this.#asset(url.pathname, false);
			}
			if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "boards") {
				return await this.#handleApi(request, url, segments);
			}
			return this.#error(404, "not_found", "Not found", false);
		} catch (error) {
			if (error instanceof KanbanError) {
				return this.#error(
					error.status,
					error.code,
					error.message,
					url.pathname.startsWith("/api/"),
					error.details,
				);
			}
			logger.error("Kanban request failed", { error: error instanceof Error ? error.name : "unknown" });
			return this.#error(500, "internal_error", "Internal server error", url.pathname.startsWith("/api/"));
		}
	}

	async #handleApi(request: Request, url: URL, segments: string[]): Promise<Response> {
		if (segments.length < 5) throw new KanbanError(404, "not_found", "Not found");
		const boardId = decodeSegment(segments[3]!);
		if (!boardId || boardId !== this.#options.boardId) throw new KanbanError(404, "not_found", "Board not found");
		if (!this.#authenticate(boardId, request.headers.get("cookie"))) {
			throw new KanbanError(401, "unauthorized", "Kanban capability is missing or invalid");
		}
		await this.#options.onBoardAccess?.();

		const mutation = request.method === "POST" || request.method === "PATCH" || request.method === "DELETE";
		if (mutation) this.#authorizeMutation(request, segments[4] !== "attachments");
		if (url.search && !(request.method === "GET" && segments.length === 5 && segments[4] === "events")) {
			throw new KanbanError(422, "validation_error", "Query parameters are not allowed for this route");
		}

		if (request.method === "GET" && segments.length === 5 && segments[4] === "board") {
			return this.#json(this.#options.store.getBoard(boardId), 200);
		}
		if (request.method === "GET" && segments.length === 5 && segments[4] === "sessions") {
			return this.#json(this.#options.store.listSessions(boardId), 200);
		}
		if (request.method === "GET" && segments.length === 5 && segments[4] === "events") {
			if ([...url.searchParams.keys()].some(key => key !== "cursor")) {
				throw new KanbanError(422, "validation_error", "Only the cursor query parameter is allowed");
			}
			const cursorText = url.searchParams.get("cursor") ?? "0";
			if (!/^\d+$/.test(cursorText) || !Number.isSafeInteger(Number(cursorText))) {
				throw new KanbanError(422, "validation_error", "cursor must be a nonnegative integer");
			}
			return this.#events(boardId, Number(cursorText));
		}
		if (segments[4] === "attachments") {
			if (request.method === "POST" && segments.length === 5) return await this.#uploadAttachment(request, boardId);
			if (request.method === "GET" && segments.length === 6) {
				const attachmentId = decodeSegment(segments[5] ?? "");
				if (!attachmentId) throw new KanbanError(404, "not_found", "Attachment not found");
				return this.#attachment(boardId, attachmentId);
			}
			throw new KanbanError(404, "not_found", "Not found");
		}
		if (segments[4] !== "tasks") throw new KanbanError(404, "not_found", "Not found");

		if (request.method === "POST" && segments.length === 5) {
			const raw = await this.#readJson(request);
			const input = validateTaskCreate(raw);
			const result = this.#options.store.createTask(boardId, input, {
				key: this.#idempotencyKey(request),
				method: "POST",
				route: url.pathname,
				body: raw,
			});
			return await this.#mutationResponse(result);
		}

		const taskId = decodeSegment(segments[5] ?? "");
		if (!taskId) throw new KanbanError(404, "not_found", "Task not found");
		if (request.method === "PATCH" && segments.length === 6) {
			const result = this.#options.store.updateTask(
				boardId,
				taskId,
				validateTaskUpdate(await this.#readJson(request)),
			);
			return await this.#mutationResponse(result);
		}
		if (request.method === "DELETE" && segments.length === 6) {
			const result = this.#options.store.deleteTask(
				boardId,
				taskId,
				validateExpectedVersion(await this.#readJson(request)),
			);
			return await this.#mutationResponse(result);
		}
		if (request.method === "POST" && segments.length === 7 && segments[6] === "moves") {
			const raw = await this.#readJson(request);
			const result = this.#options.store.moveTask(boardId, taskId, validateMove(raw), {
				key: this.#idempotencyKey(request),
				method: "POST",
				route: url.pathname,
				body: raw,
			});
			return await this.#mutationResponse(result);
		}
		if (segments[6] !== "comments") throw new KanbanError(404, "not_found", "Not found");
		if (request.method === "GET" && segments.length === 7) {
			return this.#json(this.#options.store.listComments(boardId, taskId), 200);
		}
		if (request.method === "POST" && segments.length === 7) {
			const raw = await this.#readJson(request);
			const result = this.#options.store.createComment(boardId, taskId, validateCommentCreate(raw, "user"), {
				key: this.#idempotencyKey(request),
				method: "POST",
				route: url.pathname,
				body: raw,
			});
			return await this.#mutationResponse(result);
		}

		const commentId = decodeSegment(segments[7] ?? "");
		if (!commentId) throw new KanbanError(404, "not_found", "Comment not found");
		if (request.method === "PATCH" && segments.length === 8) {
			const result = this.#options.store.updateComment(
				boardId,
				taskId,
				commentId,
				validateCommentUpdate(await this.#readJson(request)),
			);
			return await this.#mutationResponse(result);
		}
		if (request.method === "DELETE" && segments.length === 8) {
			const result = this.#options.store.deleteComment(
				boardId,
				taskId,
				commentId,
				validateExpectedVersion(await this.#readJson(request)),
			);
			return await this.#mutationResponse(result);
		}
		throw new KanbanError(405, "method_not_allowed", "Method not allowed");
	}

	/** `/kanban/` with no id redirects to this process's one board. */
	#fallbackBoard(): Response {
		const headers = securityHeaders("no-store");
		headers.set("Location", `/kanban/${encodeURIComponent(this.#options.boardId)}`);
		return new Response(null, { status: 307, headers });
	}

	#board(boardId: string): Response {
		const asset = this.#options.assets["/"];
		if (!asset || typeof asset.body !== "string") throw new Error("Kanban root asset is missing");
		const encodedSessionId = encodeURIComponent(boardId);
		const manifestHref = `/kanban/${encodedSessionId}/manifest.webmanifest`;
		const body = asset.body.replace(
			/(<link\s+rel=["']manifest["']\s+href=)["']\/manifest\.webmanifest["']/i,
			`$1"${manifestHref}"`,
		);
		if (body === asset.body) throw new Error("Kanban root asset has no manifest link");
		const headers = securityHeaders("no-store");
		headers.set("Content-Type", asset.contentType);
		headers.set(
			"Set-Cookie",
			`${this.#cookieName(boardId)}=${this.#capabilityForSession(boardId)}; HttpOnly; SameSite=Strict; Path=/`,
		);
		return new Response(body, { status: 200, headers });
	}

	#sessionManifest(boardId: string): Response {
		const asset = this.#options.assets["/manifest.webmanifest"];
		if (!asset) throw new Error("Kanban manifest asset is missing");
		const source = typeof asset.body === "string" ? asset.body : new TextDecoder().decode(asset.body);
		const parsed: unknown = JSON.parse(source);
		if (!isRecord(parsed)) throw new Error("Kanban manifest asset is malformed");
		const startUrl = `/kanban/${encodeURIComponent(boardId)}`;
		const headers = securityHeaders("no-store");
		headers.set("Content-Type", asset.contentType);
		return new Response(JSON.stringify({ ...parsed, id: startUrl, start_url: startUrl, scope: "/kanban/" }), {
			status: 200,
			headers,
		});
	}

	#asset(assetPath: string, noStore: boolean): Response {
		const asset = this.#options.assets[assetPath];
		if (!asset) return this.#error(404, "not_found", "Not found", false);
		const headers = securityHeaders(
			noStore ? "no-store" : (asset.cacheControl ?? "public, max-age=0, must-revalidate"),
		);
		headers.set("Content-Type", asset.contentType);
		return new Response(asset.body, { status: 200, headers });
	}

	/**
	 * Only loopback and tailnet peers may reach the board, and the `Host` they
	 * present must match how they got here — a loopback name for loopback peers,
	 * one of this host's tailnet literals or a MagicDNS `*.ts.net` name for
	 * tailnet peers. That pairing is what stops DNS rebinding from turning a
	 * public hostname into a loopback-privileged origin.
	 */
	#authorizePeer(request: Request, server: Bun.Server<undefined>): boolean {
		const parsed = splitHostHeader(request.headers.get("host")?.toLowerCase() ?? "");
		if (!parsed || parsed.port !== String(this.port)) return false;
		const peer = server.requestIP(request)?.address;
		if (isLoopback(peer)) {
			return parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "localhost";
		}
		if (!isTailnetAddress(peer)) return false;
		return this.#tailnetAddresses.includes(parsed.hostname) || parsed.hostname.endsWith(".ts.net");
	}

	/** The origin a same-origin board page presents, derived from its own `Host`. */
	#requestOrigin(request: Request): string | null {
		const host = request.headers.get("host")?.toLowerCase() ?? "";
		return splitHostHeader(host) ? `http://${host}` : null;
	}

	#authorizeMutation(request: Request, expectJson = true): void {
		const expectedOrigin = this.#requestOrigin(request);
		if (!expectedOrigin || request.headers.get("origin") !== expectedOrigin) {
			throw new KanbanError(403, "forbidden", "Mutation Origin is not allowed");
		}
		if (request.headers.get(MUTATION_HEADER) !== "1") {
			throw new KanbanError(403, "kanban_header_required", "Kanban mutation header is required");
		}
		if (!expectJson) return;
		const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
		if (!contentType.startsWith("application/json")) {
			throw new KanbanError(415, "unsupported_media_type", "Mutation body must be JSON");
		}
	}

	/**
	 * Board image upload: raw bytes plus an `X-Kanban-Filename` header rather
	 * than multipart, so uploads reuse the JSON routes' auth and the reader can
	 * abort on size without parsing a form.
	 */
	async #uploadAttachment(request: Request, boardId: string): Promise<Response> {
		const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
		if (!Object.hasOwn(ALLOWED_IMAGE_TYPES, contentType)) {
			throw new KanbanError(415, "unsupported_media_type", "Attachments must be PNG, JPEG, GIF, or WebP");
		}
		const bytes = await this.#readBytes(request, MAX_ATTACHMENT_BYTES, "Attachment exceeds 5 MiB");
		if (bytes.byteLength === 0) throw new KanbanError(422, "validation_error", "Attachment body is empty");
		const rawName = request.headers.get("x-kanban-filename") ?? "image";
		const filename = rawName.replace(/[^\w.\- ]/g, "").slice(0, 120) || "image";
		const attachment = this.#options.store.createAttachment(boardId, { filename, contentType, bytes });
		return this.#json(
			{ ...attachment, url: `/api/v1/boards/${encodeURIComponent(boardId)}/attachments/${attachment.id}` },
			201,
		);
	}

	#attachment(boardId: string, attachmentId: string): Response {
		const found = this.#options.store.readAttachment(boardId, attachmentId);
		if (!found) throw new KanbanError(404, "not_found", "Attachment not found");
		const headers = securityHeaders("private, max-age=31536000, immutable");
		headers.set("Content-Type", found.contentType);
		headers.set("Content-Length", String(found.size));
		headers.set("Content-Disposition", `inline; filename="${found.filename.replace(/"/g, "")}"`);
		return new Response(found.bytes, { status: 200, headers });
	}

	#cookieName(boardId: string): string {
		const suffix = createHmac("sha256", this.#capabilitySecret).update("cookie-name\0").update(boardId).digest("hex");
		return `${COOKIE_NAME_PREFIX}${suffix}`;
	}

	#capabilityForSession(boardId: string): string {
		return createHmac("sha256", this.#capabilitySecret).update("capability\0").update(boardId).digest("base64url");
	}

	#authenticate(boardId: string, cookieHeader: string | null): boolean {
		if (!cookieHeader) return false;
		const cookieName = this.#cookieName(boardId);
		const values = cookieHeader
			.split(";")
			.map(part => part.trim())
			.filter(part => part.startsWith(`${cookieName}=`))
			.map(part => part.slice(cookieName.length + 1));
		if (values.length !== 1) return false;
		const candidate = Buffer.from(values[0]!, "utf8");
		const expected = Buffer.from(this.#capabilityForSession(boardId), "utf8");
		return candidate.length === expected.length && timingSafeEqual(candidate, expected);
	}

	#idempotencyKey(request: Request): string {
		const key = request.headers.get("idempotency-key") ?? "";
		if (!/^[\x21-\x7e]{1,256}$/.test(key)) {
			throw new KanbanError(422, "idempotency_key_required", "POST requests require a valid Idempotency-Key");
		}
		return key;
	}

	/** Bounded body reader: aborts mid-stream instead of buffering an oversized body. */
	async #readBytes(request: Request, limit: number, overflowMessage: string): Promise<Uint8Array> {
		const contentLength = request.headers.get("content-length");
		if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > limit) {
			throw new KanbanError(413, "payload_too_large", overflowMessage);
		}
		const chunks: Uint8Array[] = [];
		let byteLength = 0;
		const reader = request.body?.getReader();
		if (reader) {
			try {
				while (true) {
					const result = await reader.read();
					if (result.done) break;
					byteLength += result.value.byteLength;
					if (byteLength > limit) {
						await reader.cancel("payload_too_large").catch(() => undefined);
						throw new KanbanError(413, "payload_too_large", overflowMessage);
					}
					chunks.push(result.value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}

	async #readJson(request: Request): Promise<unknown> {
		const bytes = await this.#readBytes(request, MAX_JSON_BODY_BYTES, "JSON body exceeds 64 KiB");
		let text: string;
		try {
			text = TEXT_DECODER.decode(bytes);
		} catch {
			throw new KanbanError(400, "invalid_json", "Request body is not valid UTF-8 JSON");
		}
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new KanbanError(400, "invalid_json", "Request body is malformed JSON");
		}
	}

	async #mutationResponse<T>(result: KanbanMutation<T>): Promise<Response> {
		if (result.activity) {
			this.#broadcast(result.activity);
			try {
				await this.#options.onActivity?.(result.activity);
			} catch (error) {
				logger.warn("Kanban event delivery deferred to persistent outbox", {
					error: error instanceof Error ? error.name : "unknown",
				});
			}
		}
		return this.#json(result.data, result.status);
	}

	/**
	 * Catch-up for a reconnecting client. Draining the whole backlog pushed the
	 * entire activity table into the stream buffer synchronously — megabytes per
	 * reconnect, no backpressure, and a reconnect loop paid it again every time.
	 * The window is the NEWEST events, so a client that fell far behind lands on
	 * the current tail; it reloads the board snapshot on the next event anyway.
	 */
	#events(boardId: string, cursor: number): Response {
		let client: SseClient | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start: controller => {
				client = { boardId, lastCursor: cursor, controller };
				this.#sseClients.add(client);
				controller.enqueue(TEXT_ENCODER.encode(": connected\n\n"));
				const backlog = this.#options.store.listRecentActivitiesAfter(boardId, cursor, SSE_REPLAY_LIMIT);
				for (const activity of backlog) this.#enqueueSse(client, activity);
			},
			cancel: () => {
				if (client) this.#sseClients.delete(client);
			},
		});
		const headers = securityHeaders("no-store");
		headers.set("Content-Type", "text/event-stream; charset=utf-8");
		headers.set("Connection", "keep-alive");
		headers.set("X-Accel-Buffering", "no");
		return new Response(stream, { status: 200, headers });
	}

	broadcast(activity: KanbanActivity): void {
		this.#broadcast(activity);
	}

	#broadcast(activity: KanbanActivity): void {
		for (const client of [...this.#sseClients]) {
			if (client.boardId === activity.boardId) this.#enqueueSse(client, activity);
		}
	}

	#enqueueSse(client: SseClient, activity: KanbanActivity): void {
		if (activity.cursor <= client.lastCursor) return;
		try {
			client.controller.enqueue(
				TEXT_ENCODER.encode(`id: ${activity.cursor}\ndata: ${JSON.stringify(activity)}\n\n`),
			);
			client.lastCursor = activity.cursor;
		} catch {
			this.#sseClients.delete(client);
		}
	}

	#heartbeatSse(): void {
		const heartbeat = TEXT_ENCODER.encode(": heartbeat\n\n");
		for (const client of [...this.#sseClients]) {
			try {
				client.controller.enqueue(heartbeat);
			} catch {
				this.#sseClients.delete(client);
			}
		}
	}

	#closeSseClient(client: SseClient): void {
		this.#sseClients.delete(client);
		try {
			client.controller.close();
		} catch {
			// Reader already cancelled.
		}
	}

	#json(data: unknown, status: number): Response {
		const headers = securityHeaders("no-store");
		headers.set("Content-Type", "application/json; charset=utf-8");
		return new Response(JSON.stringify({ data }), { status, headers });
	}

	#error(status: number, code: string, message: string, noStore: boolean, details?: unknown): Response {
		const headers = securityHeaders(noStore ? "no-store" : "no-store");
		headers.set("Content-Type", "application/json; charset=utf-8");
		const error = details === undefined ? { code, message } : { code, message, details };
		return new Response(JSON.stringify({ error }), { status, headers });
	}
}
