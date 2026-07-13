/// <reference path="./text-modules.d.ts" />
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { writeArchive } from "../utils/zip";
import { PreviewAuth, type PreviewAuthIdentity, previewSessionCookie } from "./auth";
// Bridge IIFE injected inline into /mockup/<id> (not a route; CSP allows only unsafe-inline scripts).
import bridgeSource from "./bridge.js" with { type: "text" };
import { parseCanvasDocument } from "./canvas-schema";
import { type CommentMutationEndpoint, type CommentMutationResult, PreviewCommentStore } from "./comments";
import {
	type BundleItem,
	type BundleManifest,
	type ClientAssetMap,
	type CommentAnchor,
	DEFAULT_PREVIEW_PORT,
	DEFAULT_PREVIEW_ROOT,
	PREVIEW_COOKIE_NAME,
	type PreviewComment,
	type PreviewCommentReply,
	type PreviewCommentWire,
	type PreviewServerHandle,
	type PreviewServerOptions,
	type PreviewSseEvent,
	ROUTE_ANSWER,
	ROUTE_ANSWERS,
	ROUTE_CANVAS,
	ROUTE_COMMENTS,
	ROUTE_COMMENTS_DELETE,
	ROUTE_COMMENTS_REPLY,
	ROUTE_COMMENTS_RESOLVE,
	ROUTE_DOC,
	ROUTE_EVENTS,
	ROUTE_EXPORT,
	ROUTE_MANIFEST,
	ROUTE_MOCKUP_FRAMED,
	ROUTE_MOCKUP_RAW,
	ROUTE_SIDE_ASK,
	type ShareInfo,
	ShareUnavailableError,
	SIDE_ASK_COMMENT_MAX,
	SIDE_ASK_HEADER,
	SIDE_ASK_RATE_PER_MIN,
	type SideAskRequest,
	SSE_HEARTBEAT_MS,
	WATCH_POLL_MS,
	WATCH_SETTLE_MS,
} from "./types";

const APP_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'";
const RAW_MOCKUP_CSP =
	"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'";
const MAX_SIDE_ASK_BODY_BYTES = SIDE_ASK_COMMENT_MAX * 4 + 1024;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const COMMENT_BODY_MAX = 2000;
const COMMENT_QUOTE_MAX = 500;
const COMMENT_CONTEXT_MAX = 32;
const AUTHOR_MAX = 64;
const QUESTION_ID_MAX = 256;
const QUESTION_TEXT_MAX = 500;
const SELECTION_MAX = 10;
const SELECTION_ITEM_MAX = 200;
/** Comment/answer mutations allow a higher burst than side-ask (which is 6/min). */
const COMMENT_RATE_PER_MIN = 120;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const BRIDGE_SCRIPT = `<script>${bridgeSource}</script>`;

interface PreviewServerDependencies {
	clientAssets: ClientAssetMap;
	scan: (options: { root: string; extraPaths?: string[]; title?: string }) => Promise<BundleManifest>;
}

interface PendingManifest {
	manifest: BundleManifest;
	detectedAt: number;
}

interface SideAskParseResult {
	request: (SideAskRequest & { author?: string; source?: "user" | "template" }) | null;
	reason: "invalid" | "too_large" | null;
}

/** Internal composition point; index.ts provides the real scanner and embedded client assets. */
export async function createPreviewServer(
	options: PreviewServerOptions,
	deps: PreviewServerDependencies,
): Promise<PreviewServerHandle> {
	const scanOptions = {
		root: options.root ?? DEFAULT_PREVIEW_ROOT,
		extraPaths: options.extraPaths,
		title: options.title,
	};
	const [manifest, comments] = await Promise.all([deps.scan(scanOptions), PreviewCommentStore.load(scanOptions.root)]);
	const server = new ProductPreviewServer(options, deps, scanOptions, manifest, comments);
	return server.start();
}

class ProductPreviewServer implements PreviewServerHandle {
	port = 0;
	localUrl = "";
	#server: Bun.Server<undefined> | null = null;
	/** Second listener bound to the tailnet IP while sharing (Amendment A1). */
	#shareServer: Bun.Server<undefined> | null = null;
	/** Serializes share transitions so two enables never mint concurrently. */
	#shareLock: Promise<unknown> = Promise.resolve();
	/** Bumped by disableShare()/stop(); an in-flight enable that observes a bump rolls back. */
	#shareGeneration = 0;
	#manifest: BundleManifest;
	#auth = new PreviewAuth();
	#sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	#heartbeatTimer: Timer | null = null;
	#watchTimer: Timer | null = null;
	#scanInFlight: Promise<BundleManifest> | null = null;
	#watching = false;
	#pendingManifest: PendingManifest | null = null;
	#sideAskAttempts = new Map<string, number[]>();
	#commentAttempts = new Map<string, number[]>();
	#lastShareInfo: ShareInfo | null = null;
	/**
	 * Host authorities (`<host>:<port>`) accepted while sharing — built ONCE from
	 * ShareInfo at enable-commit, validated + lowercased, so a later mutation of
	 * the returned ShareInfo cannot widen the allowlist. Empty unless sharing.
	 */
	#shareHostAuthorities: ReadonlySet<string> = new Set();
	#stopped = false;
	#options: PreviewServerOptions;
	#deps: PreviewServerDependencies;
	#scanOptions: { root: string; extraPaths?: string[]; title?: string };
	#comments: PreviewCommentStore;

	constructor(
		options: PreviewServerOptions,
		deps: PreviewServerDependencies,
		scanOptions: { root: string; extraPaths?: string[]; title?: string },
		manifest: BundleManifest,
		comments: PreviewCommentStore,
	) {
		this.#options = options;
		this.#deps = deps;
		this.#scanOptions = scanOptions;
		this.#manifest = this.#withCapabilities(manifest);
		this.#comments = comments;
	}

	start(): PreviewServerHandle {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: this.#options.port ?? DEFAULT_PREVIEW_PORT,
			// Bun defaults to 10 seconds, which would close the SSE stream before its 15-second heartbeat.
			idleTimeout: 30,
			fetch: async (request, previewServer) => await this.#handleRequest(request, previewServer),
		});
		this.#server = server;
		this.port = server.port ?? 0;
		this.localUrl = `http://127.0.0.1:${this.port}/`;
		this.#heartbeatTimer = setInterval(() => this.#broadcastFrame(": heartbeat\n\n"), SSE_HEARTBEAT_MS);
		this.#watchTimer = setInterval(() => void this.#pollWatch(), WATCH_POLL_MS);
		logger.debug("product preview server listening", { port: this.port });
		return this;
	}

	async refresh(): Promise<BundleManifest> {
		const manifest = await this.#scanManifest();
		this.#pendingManifest = null;
		this.#commitManifest(manifest, true);
		return manifest;
	}

	shareInfo(): ShareInfo | null {
		return this.#options.share?.enabled() ? this.#lastShareInfo : null;
	}

	async enableShare(): Promise<ShareInfo> {
		const share = this.#options.share;
		if (!share) throw new ShareUnavailableError("Product preview sharing is not configured");
		// Generation is captured synchronously at CALL time: a disableShare()/stop()
		// issued after this call supersedes it even before the locked body runs.
		const generation = this.#shareGeneration;
		const run = this.#shareLock.then(async () => {
			if (this.#stopped || generation !== this.#shareGeneration) {
				throw new ShareUnavailableError("Product preview share was disabled before it started");
			}
			if (share.enabled()) this.#revokeShareSessions();
			const info = await share.enable(this.port);
			if (this.#stopped || generation !== this.#shareGeneration) {
				// Superseded while awaiting the mint: roll back so no token outlives
				// its listener.
				share.disable();
				throw new ShareUnavailableError("Product preview share was disabled before it started");
			}
			this.#shareServer?.stop(true);
			this.#shareServer = null;
			try {
				this.#shareServer = Bun.serve({
					hostname: info.host,
					port: this.port,
					idleTimeout: 30,
					fetch: async (request, shareServer) => await this.#handleRequest(request, shareServer),
				});
			} catch (error) {
				// Bind failure: revoke the fresh mint — a valid token with no
				// reachable listener must never exist.
				share.disable();
				this.#auth.clearSessions();
				this.#lastShareInfo = null;
				this.#shareHostAuthorities = new Set();
				throw error;
			}
			this.#lastShareInfo = info;
			const authorities = new Set([`${info.host}:${this.port}`.toLowerCase()]);
			for (const alias of info.hostAliases ?? []) {
				const clean = alias.trim().toLowerCase();
				// Belt-and-suspenders: the controller already validates, but the
				// Host allowlist re-checks every alias is a bare DNS name.
				if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(clean)) {
					authorities.add(`${clean}:${this.port}`);
				}
			}
			this.#shareHostAuthorities = authorities;
			logger.debug("product preview share listener started", { host: info.host, port: this.port });
			return info;
		});
		this.#shareLock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	disableShare(): void {
		const share = this.#options.share;
		const wasEnabled = share?.enabled() ?? false;
		// Synchronous supersession: an in-flight enableShare() observes the bump
		// after its await and rolls back instead of resurrecting the listener.
		this.#shareGeneration++;
		share?.disable();
		this.#auth.clearSessions();
		this.#shareServer?.stop(true);
		this.#shareServer = null;
		this.#lastShareInfo = null;
		this.#shareHostAuthorities = new Set();
		if (wasEnabled) this.#revokeShareSessions();
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#shareGeneration++;
		this.#options.share?.disable();
		this.#auth.clearSessions();
		clearInterval(this.#heartbeatTimer ?? undefined);
		clearInterval(this.#watchTimer ?? undefined);
		this.#heartbeatTimer = null;
		this.#watchTimer = null;
		this.#closeSseControllers();
		this.#shareServer?.stop(true);
		this.#shareServer = null;
		this.#lastShareInfo = null;
		this.#shareHostAuthorities = new Set();
		this.#server?.stop(true);
		this.#server = null;
		logger.debug("product preview server stopped", { port: this.port });
	}

	async #handleRequest(request: Request, server: Bun.Server<undefined>): Promise<Response> {
		try {
			const url = new URL(request.url);
			const host = request.headers.get("host")?.toLowerCase() ?? "";
			if (!this.#isAllowedHost(host)) return this.#error(403, "forbidden", "Forbidden");

			const peer = server.requestIP(request)?.address ?? "unknown";
			const loopback = isLoopbackPeer(peer);
			if (hasTraversalAttempt(request.url, url.pathname)) return this.#error(403, "forbidden", "Forbidden");
			if (url.pathname.startsWith(`${ROUTE_EXPORT}/`)) return this.#error(403, "forbidden", "Forbidden");
			if (url.pathname.startsWith(ROUTE_MOCKUP_RAW) && !loopback) return this.#error(403, "forbidden", "Forbidden");
			if (
				request.method === "POST" &&
				isPreviewApiPostPath(url.pathname) &&
				request.headers.get(SIDE_ASK_HEADER) !== "1"
			) {
				return this.#error(403, "side_ask_header_required", "This page can't send asks (missing preview header)");
			}
			if (
				request.method === "GET" &&
				isPreviewApiGetPath(url.pathname) &&
				request.headers.get(SIDE_ASK_HEADER) !== "1"
			) {
				return this.#error(403, "side_ask_header_required", "This page can't send asks (missing preview header)");
			}

			if (url.pathname === ROUTE_EXPORT) return await this.#handleExport(request);
			if (request.method === "GET" && url.searchParams.has("t")) {
				return this.#handleTokenExchange(url, host, peer);
			}

			const identity = this.#auth.authenticate({
				authorization: request.headers.get("authorization"),
				cookie: request.headers.get("cookie"),
				host,
				loopback,
				shareEnabled: this.#options.share?.enabled() ?? false,
				verifyShareToken: candidate => this.#options.share?.verifyToken(candidate) ?? false,
			});
			if (!identity) return this.#authenticationFailure(peer);

			if (request.method === "GET" && url.pathname === ROUTE_MANIFEST) return this.#json(this.#manifest);
			if (request.method === "GET" && url.pathname.startsWith(ROUTE_DOC))
				return await this.#handleDocument(url.pathname);
			if (request.method === "GET" && url.pathname.startsWith(ROUTE_CANVAS))
				return await this.#handleCanvas(url.pathname);
			if (request.method === "POST" && url.pathname === ROUTE_SIDE_ASK)
				return await this.#handleSideAsk(request, peer, identity);
			if (request.method === "GET" && url.pathname === ROUTE_COMMENTS)
				return this.#handleListComments(url, identity, request.headers.get("cookie"));
			if (request.method === "POST" && url.pathname === ROUTE_COMMENTS)
				return await this.#handleCreateComment(request, peer, identity, request.headers.get("cookie"));
			if (request.method === "POST" && url.pathname === ROUTE_COMMENTS_REPLY)
				return await this.#handleReplyComment(request, peer, identity, request.headers.get("cookie"));
			if (request.method === "POST" && url.pathname === ROUTE_COMMENTS_RESOLVE)
				return await this.#handleResolveComment(request, peer, identity, request.headers.get("cookie"));
			if (request.method === "POST" && url.pathname === ROUTE_COMMENTS_DELETE)
				return await this.#handleDeleteComment(request, peer, identity, request.headers.get("cookie"));
			if (request.method === "GET" && url.pathname === ROUTE_ANSWERS) return this.#handleListAnswers(url);
			if (request.method === "POST" && url.pathname === ROUTE_ANSWER)
				return await this.#handleRecordAnswer(request, peer, identity);
			if (request.method === "GET" && url.pathname === ROUTE_EVENTS) return this.#handleEvents();
			if (request.method === "GET" && url.pathname.startsWith(ROUTE_MOCKUP_FRAMED)) {
				return await this.#handleFramedMockup(url.pathname);
			}
			if (request.method === "GET" && url.pathname.startsWith(ROUTE_MOCKUP_RAW)) {
				return await this.#handleRawMockup(url.pathname);
			}
			if (request.method === "GET") {
				const asset = this.#deps.clientAssets[url.pathname];
				if (asset) return this.#response(asset.body, 200, { "Content-Type": asset.contentType }, APP_CSP);
			}
			return this.#error(404, "not_found", "Not found");
		} catch (error) {
			logger.error("product preview request failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return this.#error(500, "internal_error", "Internal server error");
		}
	}

	#handleTokenExchange(url: URL, host: string, peer: string): Response {
		const share = this.#options.share;
		const token = url.searchParams.get("t") ?? "";
		const sid = share?.enabled()
			? this.#auth.exchangeToken(token, host, candidate => share.verifyToken(candidate))
			: null;
		if (!sid) return this.#authenticationFailure(peer);

		url.searchParams.delete("t");
		const location = `${url.pathname}${url.search}`;
		return this.#response(null, 302, { Location: location, "Set-Cookie": previewSessionCookie(sid) });
	}

	#authenticationFailure(peer: string): Response {
		const failure = this.#auth.recordFailure(peer);
		if (failure.throttled) {
			logger.warn("product preview authentication throttled", { peer });
			return this.#error(429, "too_many_auth_failures", "Too many authentication failures");
		}
		logger.warn("product preview authentication failed", { peer });
		return this.#error(401, "unauthorized", "Unauthorized");
	}

	async #handleDocument(pathname: string): Promise<Response> {
		const item = this.#findItem(pathname, ROUTE_DOC);
		if (item === "forbidden") return this.#error(403, "forbidden", "Forbidden");
		if (!item) return this.#error(404, "not_found", "Not found");
		const source = resolveBundlePath(this.#manifest.bundle.root, item.relPath);
		if (!source) return this.#error(403, "forbidden", "Forbidden");
		const content = await readRegularFile(source);
		if (!content) return this.#error(404, "not_found", "Not found");
		return this.#json({ item, content: TEXT_DECODER.decode(content) }, 200, APP_CSP);
	}

	async #handleCanvas(pathname: string): Promise<Response> {
		const item = this.#findItem(pathname, ROUTE_CANVAS);
		if (item === "forbidden") return this.#error(403, "forbidden", "Forbidden");
		if (item?.kind !== "canvas") return this.#error(404, "not_found", "Not found");
		const source = resolveBundlePath(this.#manifest.bundle.root, item.relPath);
		if (!source) return this.#error(403, "forbidden", "Forbidden");
		const content = await readRegularFile(source);
		if (!content) return this.#error(404, "not_found", "Not found");
		const parsed = parseCanvasDocument(content);
		if (!parsed.ok) return this.#error(422, parsed.error.code, parsed.error.message, parsed.error.field);
		return this.#json({ item, canvas: parsed.canvas }, 200, APP_CSP);
	}

	async #handleFramedMockup(pathname: string): Promise<Response> {
		const item = this.#findItem(pathname, ROUTE_MOCKUP_FRAMED);
		if (item === "forbidden") return this.#error(403, "forbidden", "Forbidden");
		if (item?.kind !== "mockup") return this.#error(404, "not_found", "Not found");
		const source = resolveBundlePath(this.#manifest.bundle.root, item.relPath);
		if (!source) return this.#error(403, "forbidden", "Forbidden");
		const content = await readRegularFile(source);
		if (!content) return this.#error(404, "not_found", "Not found");
		// Serve the template document directly with the bridge IIFE injected before </body>.
		// Nested srcdoc wrappers would capture postMessage and break OmpxPreview.
		const html = injectBridgeScript(TEXT_DECODER.decode(content));
		return this.#response(html, 200, { "Content-Type": "text/html; charset=utf-8" }, RAW_MOCKUP_CSP);
	}

	async #handleRawMockup(pathname: string): Promise<Response> {
		const item = this.#findItem(pathname, ROUTE_MOCKUP_RAW);
		if (item === "forbidden") return this.#error(403, "forbidden", "Forbidden");
		if (item?.kind !== "mockup") return this.#error(404, "not_found", "Not found");
		const source = resolveBundlePath(this.#manifest.bundle.root, item.relPath);
		if (!source) return this.#error(403, "forbidden", "Forbidden");
		const content = await readRegularFile(source);
		if (!content) return this.#error(404, "not_found", "Not found");
		return this.#response(content, 200, { "Content-Type": "text/html; charset=utf-8" }, RAW_MOCKUP_CSP);
	}

	async #handleSideAsk(request: Request, peer: string, identity: PreviewAuthIdentity): Promise<Response> {
		const parsed = await parseSideAsk(request);
		if (parsed.reason === "too_large")
			return this.#error(422, "side_ask_too_long", "Comment exceeds 10,000 characters");
		if (!parsed.request) return this.#error(422, "invalid_side_ask", "Invalid side-ask request");
		if (!this.#takeSideAskSlot(peer)) return this.#error(429, "side_ask_rate_limited", "Rate limit exceeded");
		if (!this.#options.deliverFeedback) {
			return this.#error(
				503,
				"side_ask_unavailable",
				"No agent session is attached to this preview. Start it from an ompx session to receive asks.",
			);
		}

		const from = resolveAuthor(parsed.request.author, peer);
		try {
			this.#options.deliverFeedback({
				type: "side-ask",
				comment: parsed.request.comment.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
				itemId: parsed.request.itemId,
				from,
				viaShare: identity.viaShare,
				ts: Date.now(),
				source: parsed.request.source ?? "user",
			});
		} catch (error) {
			logger.error("product preview side-ask delivery failed", {
				peer,
				error: error instanceof Error ? error.message : String(error),
			});
			return this.#error(
				503,
				"side_ask_unavailable",
				"No agent session is attached to this preview. Start it from an ompx session to receive asks.",
			);
		}
		return this.#json({ ok: true }, 202);
	}

	#handleListComments(url: URL, identity: PreviewAuthIdentity, cookie: string | null): Response {
		const itemId = url.searchParams.get("itemId") ?? undefined;
		const requesterSid = resolveOwnerSid(identity, cookie);
		const comments = this.#comments.list(itemId).map(comment => toCommentWire(comment, requesterSid, identity));
		return this.#json({ comments });
	}

	async #handleCreateComment(
		request: Request,
		peer: string,
		identity: PreviewAuthIdentity,
		cookie: string | null,
	): Promise<Response> {
		const parsed = await parseJsonBody(request, MAX_JSON_BODY_BYTES);
		if (parsed.reason === "too_large") return this.#error(422, "invalid_comment", "Comment body is too large");
		if (!parsed.value || typeof parsed.value !== "object")
			return this.#error(422, "invalid_comment", "Invalid comment request");
		if (!this.#takeCommentSlot(peer)) return this.#error(429, "side_ask_rate_limited", "Rate limit exceeded");

		const body = parsed.value as {
			anchor?: unknown;
			body?: unknown;
			author?: unknown;
			requestId?: unknown;
		};
		const anchor = parseAnchor(body.anchor);
		if (!anchor) return this.#error(422, "invalid_comment", "Invalid comment anchor");
		if (typeof body.body !== "string" || body.body.trim().length === 0 || body.body.length > COMMENT_BODY_MAX) {
			return this.#error(422, "invalid_comment", "Invalid comment body");
		}
		const requestId = parseRequestId(body.requestId);
		if (!requestId) return this.#error(422, "invalid_comment", "A client request ID is required", "requestId");
		const author = resolveAuthor(typeof body.author === "string" ? body.author : undefined, peer);
		const ownerSid = resolveOwnerSid(identity, cookie);
		// Non-loopback ownership requires a verified share-cookie sid so bearer-only
		// clients cannot mint empty ownerSid and later delete each other's comments.
		if (identity.method !== "loopback" && ownerSid.length === 0) {
			return this.#error(403, "forbidden", "Share session cookie required to post comments");
		}
		if (!this.#options.deliverFeedback) {
			return this.#error(
				503,
				"side_ask_unavailable",
				"No agent session is attached to this preview. Reconnect the preview and retry.",
			);
		}

		const comment: PreviewComment = {
			id: crypto.randomUUID(),
			anchor,
			body: escapeAngleBrackets(body.body.trim()),
			author,
			viaShare: identity.viaShare,
			ts: Date.now(),
			resolved: false,
			replies: [],
			ownerSid,
		};
		const receipt = {
			scope: ownerSid,
			requestId,
			endpoint: "create" as const,
			fingerprint: commentMutationFingerprint("create", {
				anchor,
				body: comment.body,
				author: comment.author,
			}),
		};
		const prior = this.#comments.findCommentMutation(receipt);
		if (prior?.kind === "conflict") {
			return this.#error(
				422,
				"idempotency_conflict",
				"Request ID was already used for a different comment operation",
			);
		}
		if (prior?.kind === "replayed") {
			return this.#json({ comment: toCommentWire(prior.comment, ownerSid, identity) }, 201);
		}

		const canvasNodePrecondition =
			anchor.type === "canvas-node"
				? async () => (await validateCanvasNodeAnchor(this.#manifest, anchor.itemId, anchor.nodeId)).valid
				: undefined;
		let outcome: CommentMutationResult;
		try {
			outcome = await this.#comments.mutateCommentOnce(
				receipt,
				state => ({
					next: { ...state, comments: [...state.comments, comment] },
					comment,
				}),
				canvasNodePrecondition,
			);
		} catch {
			return this.#error(500, "persist_failed", "Unable to persist comment");
		}
		if (outcome.kind === "rejected") return this.#json({ error: invalidCanvasNodeAnchor() }, 422);
		if (outcome.kind === "conflict") {
			return this.#error(
				422,
				"idempotency_conflict",
				"Request ID was already used for a different comment operation",
			);
		}
		if (!outcome.comment) return this.#error(500, "internal_error", "Comment mutation returned no comment");

		// The receipt and durable comment commit together. Only that first committed
		// operation reaches the owning session; retries replay the receipt.
		if (outcome.kind === "applied") this.#emitCommentFeedback(outcome.comment, peer, identity, "new");
		return this.#json({ comment: toCommentWire(outcome.comment, ownerSid, identity) }, 201);
	}

	async #handleReplyComment(
		request: Request,
		peer: string,
		identity: PreviewAuthIdentity,
		cookie: string | null,
	): Promise<Response> {
		const parsed = await parseJsonBody(request, MAX_JSON_BODY_BYTES);
		if (parsed.reason === "too_large") return this.#error(422, "invalid_reply", "Reply body is too large");
		if (!parsed.value || typeof parsed.value !== "object")
			return this.#error(422, "invalid_reply", "Invalid reply request");
		if (!this.#takeCommentSlot(peer)) return this.#error(429, "side_ask_rate_limited", "Rate limit exceeded");

		const body = parsed.value as { commentId?: unknown; body?: unknown; author?: unknown; requestId?: unknown };
		if (typeof body.commentId !== "string" || body.commentId.length === 0 || body.commentId.length > 128) {
			return this.#error(422, "invalid_reply", "Invalid reply request");
		}
		if (typeof body.body !== "string" || body.body.trim().length === 0 || body.body.length > COMMENT_BODY_MAX) {
			return this.#error(422, "invalid_reply", "Invalid reply body");
		}
		const requestId = parseRequestId(body.requestId);
		if (!requestId) return this.#error(422, "invalid_reply", "A client request ID is required", "requestId");
		if (!this.#options.deliverFeedback) {
			return this.#error(
				503,
				"side_ask_unavailable",
				"No agent session is attached to this preview. Reconnect the preview and retry.",
			);
		}
		const requesterSid = resolveOwnerSid(identity, cookie);
		const author = resolveAuthor(typeof body.author === "string" ? body.author : undefined, peer);
		const reply: PreviewCommentReply = {
			id: crypto.randomUUID(),
			body: escapeAngleBrackets(body.body.trim()),
			author,
			viaShare: identity.viaShare,
			ts: Date.now(),
		};
		const receipt = {
			scope: commentMutationScope(requesterSid, peer),
			requestId,
			endpoint: "reply" as const,
			fingerprint: commentMutationFingerprint("reply", {
				commentId: body.commentId,
				body: reply.body,
				author: reply.author,
			}),
		};
		const prior = this.#comments.findCommentMutation(receipt);
		if (prior?.kind === "conflict") {
			return this.#error(
				422,
				"idempotency_conflict",
				"Request ID was already used for a different comment operation",
			);
		}
		if (prior?.kind === "replayed") {
			return this.#json({ comment: toCommentWire(prior.comment, requesterSid, identity) });
		}

		const existing = this.#comments.list().find(comment => comment.id === body.commentId);
		if (!existing) return this.#error(404, "not_found", "Comment not found");

		const canvasNodeAnchor = existing.anchor.type === "canvas-node" ? existing.anchor : undefined;
		const canvasNodePrecondition =
			canvasNodeAnchor === undefined
				? undefined
				: async () =>
						(await validateCanvasNodeAnchor(this.#manifest, canvasNodeAnchor.itemId, canvasNodeAnchor.nodeId))
							.valid;
		let outcome: CommentMutationResult;
		try {
			outcome = await this.#comments.mutateCommentOnce(
				receipt,
				state => {
					const index = state.comments.findIndex(comment => comment.id === body.commentId);
					if (index === -1) return { next: state, comment: null };
					const updated = structuredClone(state.comments[index]!);
					updated.replies = [...updated.replies, reply];
					const comments = state.comments.slice();
					comments[index] = updated;
					return { next: { ...state, comments }, comment: updated };
				},
				canvasNodePrecondition,
			);
		} catch {
			return this.#error(500, "persist_failed", "Unable to persist reply");
		}
		if (outcome.kind === "rejected") return this.#json({ error: invalidCanvasNodeAnchor() }, 422);
		if (outcome.kind === "conflict") {
			return this.#error(
				422,
				"idempotency_conflict",
				"Request ID was already used for a different comment operation",
			);
		}
		if (!outcome.comment) return this.#error(404, "not_found", "Comment not found");

		if (outcome.kind === "applied") this.#emitCommentFeedback(outcome.comment, peer, identity, "reply");
		return this.#json({ comment: toCommentWire(outcome.comment, requesterSid, identity) });
	}

	async #handleResolveComment(
		request: Request,
		peer: string,
		identity: PreviewAuthIdentity,
		cookie: string | null,
	): Promise<Response> {
		const parsed = await parseJsonBody(request, MAX_JSON_BODY_BYTES);
		if (parsed.reason === "too_large" || !parsed.value || typeof parsed.value !== "object") {
			return this.#error(422, "invalid_resolve", "Invalid resolve request");
		}
		if (!this.#takeCommentSlot(peer)) return this.#error(429, "side_ask_rate_limited", "Rate limit exceeded");

		const body = parsed.value as { commentId?: unknown; resolved?: unknown; requestId?: unknown };
		if (typeof body.commentId !== "string" || body.commentId.length === 0 || body.commentId.length > 128) {
			return this.#error(422, "invalid_resolve", "Invalid resolve request");
		}
		if (typeof body.resolved !== "boolean") return this.#error(422, "invalid_resolve", "Invalid resolve request");
		const resolved = body.resolved;
		const requestId = parseRequestId(body.requestId);
		if (!requestId) return this.#error(422, "invalid_resolve", "A client request ID is required", "requestId");
		if (!this.#options.deliverFeedback) {
			return this.#error(
				503,
				"side_ask_unavailable",
				"No agent session is attached to this preview. Reconnect the preview and retry.",
			);
		}
		const requesterSid = resolveOwnerSid(identity, cookie);
		const receipt = {
			scope: commentMutationScope(requesterSid, peer),
			requestId,
			endpoint: "resolve" as const,
			fingerprint: commentMutationFingerprint("resolve", {
				commentId: body.commentId,
				resolved,
			}),
		};
		const prior = this.#comments.findCommentMutation(receipt);
		if (prior?.kind === "conflict") {
			return this.#error(
				422,
				"idempotency_conflict",
				"Request ID was already used for a different comment operation",
			);
		}
		if (prior?.kind === "replayed") {
			return this.#json({ comment: toCommentWire(prior.comment, requesterSid, identity) });
		}
		const existing = this.#comments.list().find(comment => comment.id === body.commentId);
		if (!existing) return this.#error(404, "not_found", "Comment not found");

		const canvasNodeAnchor = existing.anchor.type === "canvas-node" ? existing.anchor : undefined;
		const canvasNodePrecondition =
			canvasNodeAnchor === undefined
				? undefined
				: async () =>
						(await validateCanvasNodeAnchor(this.#manifest, canvasNodeAnchor.itemId, canvasNodeAnchor.nodeId))
							.valid;
		let outcome: CommentMutationResult;
		try {
			outcome = await this.#comments.mutateCommentOnce(
				receipt,
				state => {
					const index = state.comments.findIndex(comment => comment.id === body.commentId);
					if (index === -1) return { next: state, comment: null };
					const updated = structuredClone(state.comments[index]!);
					updated.resolved = resolved;
					const comments = state.comments.slice();
					comments[index] = updated;
					return { next: { ...state, comments }, comment: updated };
				},
				canvasNodePrecondition,
			);
		} catch {
			return this.#error(500, "persist_failed", "Unable to persist resolve state");
		}
		if (outcome.kind === "rejected") return this.#json({ error: invalidCanvasNodeAnchor() }, 422);
		if (outcome.kind === "conflict") {
			return this.#error(
				422,
				"idempotency_conflict",
				"Request ID was already used for a different comment operation",
			);
		}
		if (!outcome.comment) return this.#error(404, "not_found", "Comment not found");

		if (outcome.kind === "applied") {
			this.#emitCommentFeedback(outcome.comment, peer, identity, resolved ? "resolve" : "reopen");
		}
		return this.#json({ comment: toCommentWire(outcome.comment, requesterSid, identity) });
	}

	async #handleDeleteComment(
		request: Request,
		peer: string,
		identity: PreviewAuthIdentity,
		cookie: string | null,
	): Promise<Response> {
		const parsed = await parseJsonBody(request, MAX_JSON_BODY_BYTES);
		if (parsed.reason === "too_large" || !parsed.value || typeof parsed.value !== "object") {
			return this.#error(422, "invalid_delete", "Invalid delete request");
		}
		if (!this.#takeCommentSlot(peer)) return this.#error(429, "side_ask_rate_limited", "Rate limit exceeded");

		const body = parsed.value as { commentId?: unknown };
		if (typeof body.commentId !== "string" || body.commentId.length === 0 || body.commentId.length > 128) {
			return this.#error(422, "invalid_delete", "Invalid delete request");
		}

		const existing = this.#comments.list().find(comment => comment.id === body.commentId);
		if (!existing) return this.#error(404, "not_found", "Comment not found");

		const requesterSid = resolveOwnerSid(identity, cookie);

		// Require a real verified cookie sid for non-loopback delete authorization.
		// Empty-string ownerSid/requesterSid (bearer without cookie) must not match.
		const allowed =
			identity.method === "loopback" ||
			(requesterSid.length > 0 && existing.ownerSid.length > 0 && requesterSid === existing.ownerSid);
		if (!allowed) return this.#error(403, "forbidden", "You can only delete your own comments");

		let removed: boolean;
		try {
			removed = await this.#comments.remove(body.commentId);
		} catch {
			return this.#error(500, "persist_failed", "Unable to delete comment");
		}
		if (!removed) return this.#error(404, "not_found", "Comment not found");
		return this.#json({ ok: true });
	}

	#handleListAnswers(url: URL): Response {
		const itemId = url.searchParams.get("itemId") ?? undefined;
		return this.#json({ answers: this.#comments.answers(itemId) });
	}

	async #handleRecordAnswer(request: Request, peer: string, identity: PreviewAuthIdentity): Promise<Response> {
		const parsed = await parseJsonBody(request, MAX_JSON_BODY_BYTES);
		if (parsed.reason === "too_large" || !parsed.value || typeof parsed.value !== "object") {
			return this.#error(422, "invalid_answer", "Invalid answer request");
		}
		if (!this.#takeCommentSlot(peer)) return this.#error(429, "side_ask_rate_limited", "Rate limit exceeded");

		const body = parsed.value as {
			questionId?: unknown;
			itemId?: unknown;
			question?: unknown;
			selection?: unknown;
			author?: unknown;
		};
		if (
			typeof body.questionId !== "string" ||
			body.questionId.trim().length === 0 ||
			body.questionId.length > QUESTION_ID_MAX
		) {
			return this.#error(422, "invalid_answer", "Invalid answer request");
		}
		if (
			typeof body.question !== "string" ||
			body.question.trim().length === 0 ||
			body.question.length > QUESTION_TEXT_MAX
		) {
			return this.#error(422, "invalid_answer", "Invalid answer request");
		}
		if (body.itemId !== undefined && (typeof body.itemId !== "string" || body.itemId.length > 256)) {
			return this.#error(422, "invalid_answer", "Invalid answer request");
		}
		if (
			!Array.isArray(body.selection) ||
			body.selection.length === 0 ||
			body.selection.length > SELECTION_MAX ||
			!body.selection.every(item => typeof item === "string" && item.length > 0 && item.length <= SELECTION_ITEM_MAX)
		) {
			return this.#error(422, "invalid_answer", "Invalid answer selection");
		}

		const author = resolveAuthor(typeof body.author === "string" ? body.author : undefined, peer);
		const selection = body.selection.map(item => escapeAngleBrackets(item));
		const question = escapeAngleBrackets(body.question.trim());
		const questionId = body.questionId.trim();
		const itemId = typeof body.itemId === "string" ? body.itemId : undefined;
		const ts = Date.now();

		try {
			await this.#comments.recordAnswer(questionId, {
				selection,
				author,
				ts,
				...(itemId !== undefined ? { itemId } : {}),
			});
		} catch {
			return this.#error(500, "persist_failed", "Unable to persist answer");
		}

		// Deliver only after durable commit when this server is attached to a session.
		if (this.#options.deliverFeedback) {
			try {
				this.#options.deliverFeedback({
					type: "answer",
					questionId,
					itemId,
					question,
					selection,
					from: author,
					viaShare: identity.viaShare,
					ts,
				});
			} catch (error) {
				logger.error("product preview answer delivery failed", {
					peer,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return this.#json({ ok: true }, 202);
	}

	#emitCommentFeedback(
		comment: PreviewComment,
		peer: string,
		identity: PreviewAuthIdentity,
		event: "new" | "reply" | "resolve" | "reopen",
	): void {
		if (!this.#options.deliverFeedback) return;
		const itemTitle =
			this.#manifest.items.find(item => item.id === comment.anchor.itemId)?.title ?? comment.anchor.itemId;
		try {
			this.#options.deliverFeedback({
				type: "comment",
				comment: structuredClone(comment),
				itemTitle,
				event,
				from: event === "reply" ? (comment.replies.at(-1)?.author ?? comment.author) : comment.author,
				viaShare: identity.viaShare,
				ts: Date.now(),
			});
		} catch (error) {
			logger.error("product preview comment delivery failed", {
				peer,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#handleEvents(): Response {
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start: nextController => {
				controller = nextController;
				this.#sseControllers.add(nextController);
				this.#sendEvent(nextController, { type: "manifest", manifest: this.#manifest });
			},
			cancel: () => {
				if (controller) this.#sseControllers.delete(controller);
			},
		});
		return this.#response(stream, 200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
		});
	}

	async #handleExport(request: Request): Promise<Response> {
		const share = this.#options.share;
		if (!share) return this.#error(404, "not_found", "Not found");
		const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
		if (!token || !share.consumeExportToken(token)) return this.#error(401, "unauthorized", "Unauthorized");
		try {
			const archive = await this.#createExportArchive();
			logger.debug("product preview export created", { itemCount: this.#manifest.items.length });
			return this.#response(archive, 200, {
				"Content-Type": "application/gzip",
				"Content-Disposition": 'attachment; filename="product-preview.tar.gz"',
			});
		} catch (error) {
			logger.error("product preview export failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return this.#error(500, "export_failed", "Unable to create export");
		}
	}

	async #createExportArchive(): Promise<Uint8Array> {
		const entries: Array<readonly [string, Uint8Array]> = [];
		for (const item of this.#manifest.items) {
			const source = resolveBundlePath(this.#manifest.bundle.root, item.relPath);
			if (!source) {
				logger.warn("product preview export skipped unsafe item", { itemId: item.id });
				continue;
			}
			const content = await readRegularFile(source);
			if (!content) continue;
			entries.push([item.relPath.replaceAll("\\", "/"), content]);
		}

		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-preview-export-"));
		const archivePath = path.join(directory, "bundle.tar.gz");
		try {
			await writeArchive(archivePath, "tar.gz", entries);
			return await Bun.file(archivePath).bytes();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}

	#findItem(pathname: string, prefix: string): BundleItem | "forbidden" | null {
		const rawId = pathname.slice(prefix.length);
		if (rawId.length === 0) return null;
		let id: string;
		try {
			id = decodeURIComponent(rawId);
		} catch {
			return "forbidden";
		}
		if (id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) return "forbidden";
		return this.#manifest.items.find(item => item.id === id) ?? null;
	}

	#isAllowedHost(host: string): boolean {
		if (host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`) return true;
		return this.#shareHostAuthorities.has(host);
	}

	#takeSideAskSlot(peer: string): boolean {
		const now = Date.now();
		const attempts = (this.#sideAskAttempts.get(peer) ?? []).filter(timestamp => now - timestamp < 60_000);
		attempts.push(now);
		this.#sideAskAttempts.set(peer, attempts);
		return attempts.length <= SIDE_ASK_RATE_PER_MIN;
	}

	#takeCommentSlot(peer: string): boolean {
		const now = Date.now();
		const attempts = (this.#commentAttempts.get(peer) ?? []).filter(timestamp => now - timestamp < 60_000);
		attempts.push(now);
		this.#commentAttempts.set(peer, attempts);
		return attempts.length <= COMMENT_RATE_PER_MIN;
	}

	#withCapabilities(manifest: BundleManifest): BundleManifest {
		return { ...manifest, capabilities: { feedback: this.#options.deliverFeedback !== undefined } };
	}

	#scanManifest(): Promise<BundleManifest> {
		if (this.#scanInFlight) return this.#scanInFlight;
		const scan = this.#deps.scan(this.#scanOptions).then(manifest => this.#withCapabilities(manifest));
		this.#scanInFlight = scan;
		void scan.then(
			() => {
				if (this.#scanInFlight === scan) this.#scanInFlight = null;
			},
			() => {
				if (this.#scanInFlight === scan) this.#scanInFlight = null;
			},
		);
		return scan;
	}

	async #pollWatch(): Promise<void> {
		if (this.#stopped || this.#watching) return;
		this.#watching = true;
		try {
			const candidate = await this.#scanManifest();
			if (sameManifest(candidate, this.#manifest)) {
				this.#pendingManifest = null;
				return;
			}
			const now = Date.now();
			if (!this.#pendingManifest || !sameManifest(candidate, this.#pendingManifest.manifest)) {
				this.#pendingManifest = { manifest: candidate, detectedAt: now };
				return;
			}
			if (now - this.#pendingManifest.detectedAt >= WATCH_SETTLE_MS) {
				this.#commitManifest(candidate, true);
				this.#pendingManifest = null;
			}
		} catch (error) {
			logger.warn("product preview watch scan failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.#watching = false;
		}
	}

	#commitManifest(manifest: BundleManifest, broadcastManifest: boolean): void {
		const changed = new Map(this.#manifest.items.map(item => [item.id, item]));
		this.#manifest = manifest;
		if (broadcastManifest) this.#broadcastEvent({ type: "manifest", manifest });
		for (const item of manifest.items) {
			const previous = changed.get(item.id);
			if (
				!previous ||
				previous.relPath !== item.relPath ||
				previous.mtimeMs !== item.mtimeMs ||
				previous.size !== item.size
			) {
				this.#broadcastEvent({ type: "doc-changed", id: item.id, relPath: item.relPath });
			}
		}
	}

	#revokeShareSessions(): void {
		this.#auth.clearSessions();
		this.#broadcastEvent({ type: "share-revoked" });
		this.#closeSseControllers();
	}

	#broadcastEvent(event: PreviewSseEvent): void {
		this.#broadcastFrame(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	}

	#broadcastFrame(frame: string): void {
		for (const controller of this.#sseControllers) this.#sendFrame(controller, frame);
	}

	#sendEvent(controller: ReadableStreamDefaultController<Uint8Array>, event: PreviewSseEvent): void {
		this.#sendFrame(controller, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	}

	#sendFrame(controller: ReadableStreamDefaultController<Uint8Array>, frame: string): void {
		try {
			controller.enqueue(TEXT_ENCODER.encode(frame));
		} catch {
			this.#sseControllers.delete(controller);
			logger.debug("product preview SSE connection dropped");
		}
	}

	#closeSseControllers(): void {
		for (const controller of this.#sseControllers) {
			try {
				controller.close();
			} catch {
				// A cancelled ReadableStream is already closed.
			}
		}
		this.#sseControllers.clear();
	}

	#json(body: unknown, status = 200, csp = APP_CSP): Response {
		return this.#response(JSON.stringify(body), status, { "Content-Type": "application/json; charset=utf-8" }, csp);
	}

	#error(status: number, code: string, message: string, field?: string): Response {
		return this.#json({ error: { code, message, ...(field === undefined ? {} : { field }) } }, status);
	}

	#response(
		body: string | Uint8Array | ReadableStream<Uint8Array> | null,
		status: number,
		headers: Record<string, string> = {},
		csp = APP_CSP,
	): Response {
		const response = new Response(body, { status, headers });
		response.headers.set("Content-Security-Policy", csp);
		response.headers.set("Referrer-Policy", "no-referrer");
		response.headers.set("X-Content-Type-Options", "nosniff");
		return response;
	}
}

function isLoopbackPeer(peer: string): boolean {
	return peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
}

function hasTraversalAttempt(requestUrl: string, pathname: string): boolean {
	const rawPath = requestUrl.split("?")[0] ?? "";
	if (rawPath.includes("/../") || rawPath.includes("\\") || /%(2e|2f|5c)/i.test(rawPath)) return true;
	try {
		const decoded = decodeURIComponent(pathname);
		return decoded.split("/").includes("..") || decoded.includes("\\");
	} catch {
		return true;
	}
}

function sameManifest(left: BundleManifest, right: BundleManifest): boolean {
	if (left.items.length !== right.items.length) return false;
	const rightById = new Map(right.items.map(item => [item.id, item]));
	return left.items.every(item => {
		const other = rightById.get(item.id);
		return (
			other !== undefined &&
			other.relPath === item.relPath &&
			other.kind === item.kind &&
			other.title === item.title &&
			other.mtimeMs === item.mtimeMs &&
			other.size === item.size
		);
	});
}

async function readRegularFile(filePath: string): Promise<Uint8Array | null> {
	try {
		const before = await fs.lstat(filePath);
		if (!before.isFile()) return null;
		const handle = await fs.open(filePath, "r");
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return null;
			return await handle.readFile();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

function invalidCanvasNodeAnchor(): {
	code: "invalid_anchor";
	message: "Canvas node no longer exists";
	field: "anchor.nodeId";
} {
	return { code: "invalid_anchor", message: "Canvas node no longer exists", field: "anchor.nodeId" };
}

export type CanvasNodeAnchorValidationResult =
	| { valid: true }
	| {
			valid: false;
			error: { code: "invalid_anchor"; message: string; field: "anchor.nodeId" };
	  };

/** Revalidates a canvas node from the artifact currently present on disk. */
export async function validateCanvasNodeAnchor(
	manifest: BundleManifest,
	itemId: string,
	nodeId: string,
): Promise<CanvasNodeAnchorValidationResult> {
	const item = manifest.items.find(candidate => candidate.id === itemId);
	if (item?.kind !== "canvas") {
		return { valid: false, error: invalidCanvasNodeAnchor() };
	}
	const source = resolveBundlePath(manifest.bundle.root, item.relPath);
	const content = source === null ? null : await readRegularFile(source);
	if (content === null) {
		return { valid: false, error: invalidCanvasNodeAnchor() };
	}
	const parsed = parseCanvasDocument(content);
	if (!parsed.ok || !parsed.canvas.nodes.some(node => node.id === nodeId)) {
		return { valid: false, error: invalidCanvasNodeAnchor() };
	}
	return { valid: true };
}

function resolveBundlePath(rootPath: string, relPath: string): string | null {
	if (relPath.length === 0 || relPath.includes("\0") || path.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
		return null;
	}
	const segments = relPath.replaceAll("\\", "/").split("/");
	if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) return null;
	const root = path.resolve(rootPath);
	const resolved = path.resolve(root, ...segments);
	const relative = path.relative(root, resolved);
	if (
		relative.length === 0 ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return null;
	}
	return resolved;
}

async function parseSideAsk(request: Request): Promise<SideAskParseResult> {
	if (!request.body) return { request: null, reason: "invalid" };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > MAX_SIDE_ASK_BODY_BYTES) {
				await reader.cancel();
				return { request: null, reason: "too_large" };
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		const payload = JSON.parse(TEXT_DECODER.decode(concatBytes(chunks, total))) as unknown;
		if (!payload || typeof payload !== "object") return { request: null, reason: "invalid" };
		const { comment, itemId, author, source } = payload as {
			comment?: unknown;
			itemId?: unknown;
			author?: unknown;
			source?: unknown;
		};
		if (typeof comment !== "string" || comment.trim().length === 0) return { request: null, reason: "invalid" };
		if (comment.length > SIDE_ASK_COMMENT_MAX) return { request: null, reason: "too_large" };
		if (itemId !== undefined && (typeof itemId !== "string" || itemId.length > 256))
			return { request: null, reason: "invalid" };
		if (author !== undefined && typeof author !== "string") return { request: null, reason: "invalid" };
		if (source !== undefined && source !== "user" && source !== "template")
			return { request: null, reason: "invalid" };
		return {
			request: {
				comment,
				itemId: typeof itemId === "string" ? itemId : undefined,
				author: typeof author === "string" ? author : undefined,
				source: source === "template" || source === "user" ? source : undefined,
			},
			reason: null,
		};
	} catch {
		return { request: null, reason: "invalid" };
	}
}

async function parseJsonBody(
	request: Request,
	maxBytes: number,
): Promise<{ value: unknown; reason: "too_large" | "invalid" | null }> {
	if (!request.body) return { value: null, reason: "invalid" };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return { value: null, reason: "too_large" };
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return { value: JSON.parse(TEXT_DECODER.decode(concatBytes(chunks, total))) as unknown, reason: null };
	} catch {
		return { value: null, reason: "invalid" };
	}
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function injectBridgeScript(html: string): string {
	const match = /<\/body\s*>/i.exec(html);
	if (!match || match.index === undefined) return `${html}${BRIDGE_SCRIPT}`;
	return `${html.slice(0, match.index)}${BRIDGE_SCRIPT}${html.slice(match.index)}`;
}

function isPreviewApiPostPath(pathname: string): boolean {
	return (
		pathname === ROUTE_SIDE_ASK ||
		pathname === ROUTE_COMMENTS ||
		pathname === ROUTE_COMMENTS_REPLY ||
		pathname === ROUTE_COMMENTS_RESOLVE ||
		pathname === ROUTE_COMMENTS_DELETE ||
		pathname === ROUTE_ANSWER
	);
}

function isPreviewApiGetPath(pathname: string): boolean {
	return pathname === ROUTE_COMMENTS || pathname === ROUTE_ANSWERS;
}

function escapeAngleBrackets(value: string): string {
	return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resolveAuthor(author: string | undefined, peer: string): string {
	if (typeof author !== "string") return peer;
	const trimmed = author.trim().slice(0, AUTHOR_MAX);
	if (trimmed.length === 0) return peer;
	return escapeAngleBrackets(trimmed);
}

function resolveOwnerSid(identity: PreviewAuthIdentity, cookie: string | null): string {
	if (identity.method === "loopback") return "loopback";
	const sid = readPreviewCookie(cookie, PREVIEW_COOKIE_NAME);
	return sid ?? "";
}

function parseRequestId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const requestId = value.trim();
	return requestId.length > 0 && requestId.length <= 128 ? requestId : null;
}

function commentMutationScope(ownerSid: string, peer: string): string {
	return ownerSid.length > 0 ? ownerSid : `peer:${peer.slice(0, 240)}`;
}

function commentMutationFingerprint(endpoint: CommentMutationEndpoint, body: Record<string, unknown>): string {
	return `${endpoint}:${JSON.stringify(body)}`;
}

function toCommentWire(
	comment: PreviewComment,
	requesterSid: string,
	identity: PreviewAuthIdentity,
): PreviewCommentWire {
	const { ownerSid: _ownerSid, ...rest } = comment;
	const mine = identity.method === "loopback" || (requesterSid.length > 0 && requesterSid === comment.ownerSid);
	return { ...rest, mine };
}

function parseAnchor(value: unknown): CommentAnchor | null {
	if (!value || typeof value !== "object") return null;
	const anchor = value as {
		type?: unknown;
		itemId?: unknown;
		nodeId?: unknown;
		quote?: unknown;
		prefix?: unknown;
		suffix?: unknown;
	};
	if (typeof anchor.itemId !== "string" || anchor.itemId.length === 0 || anchor.itemId.length > 256) return null;
	if (anchor.type === "canvas-node") {
		if (typeof anchor.nodeId !== "string" || anchor.nodeId.length === 0 || anchor.nodeId.length > 128) return null;
		return { type: "canvas-node", itemId: anchor.itemId, nodeId: anchor.nodeId };
	}
	if (anchor.type !== "text") return null;
	if (typeof anchor.quote !== "string" || anchor.quote.length < 1 || anchor.quote.length > COMMENT_QUOTE_MAX)
		return null;
	if (typeof anchor.prefix !== "string" || anchor.prefix.length > COMMENT_CONTEXT_MAX) return null;
	if (typeof anchor.suffix !== "string" || anchor.suffix.length > COMMENT_CONTEXT_MAX) return null;
	return {
		type: "text",
		itemId: anchor.itemId,
		quote: escapeAngleBrackets(anchor.quote),
		prefix: escapeAngleBrackets(anchor.prefix),
		suffix: escapeAngleBrackets(anchor.suffix),
	};
}

function readPreviewCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		const value = part.slice(separator + 1).trim();
		return value.length > 0 ? value : null;
	}
	return null;
}
