/**
 * Product Preview — shared contracts. DRAFT: locks together with the
 * implementation plan (docs/superpowers/plans/2026-07-12-product-preview-webui.md)
 * when the dogfood spec/design/architecture artifacts are approved. Workers
 * build against these shapes; changing them then requires a plan amendment.
 */

/** Artifact classification driving client renderers. */
export type ItemKind = "brief" | "spec" | "design" | "architecture" | "plan" | "mockup" | "canvas" | "doc";

/** One presentable artifact inside a bundle. */
export interface BundleItem {
	/** Deterministic id: lowercase hex sha256 of `relPath`, first 12 chars. */
	id: string;
	kind: ItemKind;
	/** POSIX-style path relative to the bundle root. Never absolute, never contains `..`. */
	relPath: string;
	/** First `# H1` in markdown / `<title>` in HTML, else the filename. */
	title: string;
	mtimeMs: number;
	size: number;
}

/** Scan result served at GET /api/manifest. */
export interface BundleManifest {
	bundle: {
		title: string;
		/** Absolute root directory the bundle was scanned from. */
		root: string;
		generatedAt: number;
	};
	/** Feature availability for the current preview server. */
	capabilities: {
		/** A live owner session can accept preview feedback. */
		feedback: boolean;
	};
	items: BundleItem[];
}

/** Server-sent events on GET /events. */
export type PreviewSseEvent =
	| { type: "manifest"; manifest: BundleManifest }
	| { type: "doc-changed"; id: string; relPath: string }
	| { type: "share-revoked" };

/** POST /api/side-ask request body. */
export interface SideAskRequest {
	/** Free-form question/feedback; server enforces SIDE_ASK_COMMENT_MAX. */
	comment: string;
	/** Item the viewer was looking at, when known. */
	itemId?: string;
}

/** Shared fields on every feedback event delivered to the owner session. */
export interface PreviewFeedbackBase {
	/** Display name given by the viewer, else the peer identity string. */
	from: string;
	viaShare: boolean;
	ts: number;
}

/** Side-ask typed in the ask panel or sent by a custom-HTML template via the bridge. */
export interface SideAskFeedback extends PreviewFeedbackBase {
	type: "side-ask";
	/** Sanitized comment (envelope delimiters escaped). */
	comment: string;
	itemId?: string;
	/** "user" = typed in the ask panel; "template" = sent by a custom-HTML template via the bridge. */
	source: "user" | "template";
}

/** Text-selection anchor for an inline comment. */
export interface TextCommentAnchor {
	type: "text";
	itemId: string;
	/** Exact selected text, 1..500 chars. */
	quote: string;
	/** Up to 32 chars of text immediately before the quote ("" at doc start). */
	prefix: string;
	/** Up to 32 chars immediately after ("" at doc end). */
	suffix: string;
}

/** Node-selection anchor for an inline comment on a canvas artifact. */
export interface CanvasNodeCommentAnchor {
	type: "canvas-node";
	itemId: string;
	nodeId: string;
}

/** A feedback anchor always identifies either selected text or a canvas node. */
export type CommentAnchor = TextCommentAnchor | CanvasNodeCommentAnchor;

/** One reply on a preview comment thread. */
export interface PreviewCommentReply {
	id: string; // crypto.randomUUID()
	body: string; // 1..2000 chars
	author: string;
	viaShare: boolean;
	ts: number;
}

/** Inline comment anchored to a document selection. */
export interface PreviewComment {
	id: string; // crypto.randomUUID()
	anchor: CommentAnchor;
	body: string; // 1..2000 chars
	author: string;
	viaShare: boolean;
	ts: number;
	resolved: boolean;
	replies: PreviewCommentReply[];
	/** Session id that created the comment (share-cookie sid, or "loopback"); NEVER serialized to API responses. */
	ownerSid: string;
}

/** API wire shape: ownerSid stripped, per-request delete capability flag. */
export type PreviewCommentWire = Omit<PreviewComment, "ownerSid"> & { mine: boolean };

/** Comment mutation event handed to the owner session. */
export interface CommentFeedback extends PreviewFeedbackBase {
	type: "comment";
	comment: PreviewComment;
	itemTitle: string;
	/** The agent instruction that durably changed this review thread. */
	event: "new" | "reply" | "resolve" | "reopen";
}

/** Structured multi-choice answer from the owner-facing Q&A surface. */
export interface AnswerFeedback extends PreviewFeedbackBase {
	type: "answer";
	questionId: string;
	itemId?: string;
	question: string;
	selection: string[];
}

/** Any feedback event delivered to the owner session. */
export type PreviewFeedback = SideAskFeedback | CommentFeedback | AnswerFeedback;

/** Live share state; minted values are printed to the TUI only, never to the model. */
export interface ShareInfo {
	/** e.g. "http://100.101.102.103:3877/?t=<token>" — SECRET. */
	shareUrl: string;
	token: string;
	/** Bind host chosen from the Tailscale interface (the IPv4 tailnet address). */
	host: string;
	port: number;
	/**
	 * Extra Host-header authorities to accept while sharing — the machine's
	 * hostname and MagicDNS name (bare host, no port). Lets a browser reach the
	 * tailnet bind by name; the server accepts `<alias>:<port>` for each while
	 * share is active. Never carries the bind IP (that stays `host`).
	 */
	readonly hostAliases?: readonly string[];
}

/**
 * Share lifecycle owner. Exactly one token is active at a time: `enable` on an
 * already-enabled controller rotates (revokes prior token + cookie sessions).
 */
export interface ShareController {
	enabled(): boolean;
	/** Mint + activate a share token. Throws ShareUnavailableError when no Tailscale interface / funnel conflict. */
	enable(port: number): Promise<ShareInfo>;
	/** Revoke token, cookie sessions, and export tokens. Idempotent. */
	disable(): void;
	/** Timing-safe verification of the main share token. */
	verifyToken(candidate: string): boolean;
	/** Mint a single-use export token (EXPORT_TOKEN_TTL_MS). */
	mintExportToken(): string;
	/** Timing-safe verify + consume (single use). */
	consumeExportToken(candidate: string): boolean;
	/** Copyable teammate prompt block for the handoff panel. */
	handoffPrompt(info: ShareInfo, bundleId: string): string;
}

export class ShareUnavailableError extends Error {}

/** A static client asset served verbatim by route path. */
export interface ClientAsset {
	body: string | Uint8Array;
	contentType: string;
}

/** Route path (leading slash) to asset. Built by client/assets.ts (P3); the server impl takes it as an internal factory dep; composed in index.ts (P7). */
export type ClientAssetMap = Readonly<Record<string, ClientAsset>>;

/** Options for starting the preview server. */
export interface PreviewServerOptions {
	/** Bundle root directory; default DEFAULT_PREVIEW_ROOT. */
	root?: string;
	/** Extra files/dirs (kind=doc) merged into the bundle. */
	extraPaths?: string[];
	title?: string;
	/** 0 = ephemeral. CLI/slash default DEFAULT_PREVIEW_PORT. */
	port?: number;
	/** Injected share controller; absent = local-only server (share routes 404). */
	share?: ShareController;
	/** Delivery callback for viewer feedback; absent = side-ask/comments/answers return 503. */
	deliverFeedback?: (feedback: PreviewFeedback) => void;
}

/** Running server handle. */
export interface PreviewServerHandle {
	port: number;
	/** "http://127.0.0.1:<port>/" */
	localUrl: string;
	/** Rescan the bundle and broadcast the manifest SSE event. */
	refresh(): Promise<BundleManifest>;
	/** Current share info when share mode is active (TUI-only data). */
	shareInfo(): ShareInfo | null;
	/** Enable share on the RUNNING server (human-gated callers only). */
	enableShare(): Promise<ShareInfo>;
	disableShare(): void;
	stop(): Promise<void>;
}

/** Factory signature workers code/test against (implementation in server.ts). */
export type StartPreviewServer = (options?: PreviewServerOptions) => Promise<PreviewServerHandle>;

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------
export const ROUTE_MANIFEST = "/api/manifest";
export const ROUTE_DOC = "/api/doc/"; // + <id> → { item, content } JSON
export const ROUTE_CANVAS = "/api/canvas/"; // + <id> → { item, canvas } JSON
export const ROUTE_SIDE_ASK = "/api/side-ask";
export const ROUTE_COMMENTS = "/api/comments";
export const ROUTE_COMMENTS_REPLY = "/api/comments/reply";
export const ROUTE_COMMENTS_RESOLVE = "/api/comments/resolve";
export const ROUTE_COMMENTS_DELETE = "/api/comments/delete";
export const ROUTE_ANSWERS = "/api/answers";
export const ROUTE_ANSWER = "/api/answer";
export const ROUTE_EXPORT = "/api/export"; // Bearer export-token ONLY (never in URL) → tar.gz
export const ROUTE_EVENTS = "/events";
export const ROUTE_MOCKUP_FRAMED = "/mockup/"; // + <id> → sandboxed iframe shell (all viewers)
export const ROUTE_MOCKUP_RAW = "/mockup-raw/"; // + <id> → loopback-only raw doc (annotate rects)

// ---------------------------------------------------------------------------
// Auth / headers / caps
// ---------------------------------------------------------------------------
export const PREVIEW_COOKIE_NAME = "__ompx_preview_sid";
export const SIDE_ASK_HEADER = "x-ompx-preview";
export const SIDE_ASK_COMMENT_MAX = 10_000;
export const SIDE_ASK_RATE_PER_MIN = 6;
export const EXPORT_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SSE_HEARTBEAT_MS = 15_000;
export const WATCH_POLL_MS = 1_000;
export const WATCH_SETTLE_MS = 500;
export const AUTH_FAIL_LIMIT = 10;
export const AUTH_FAIL_WINDOW_MS = 60_000;
export const DEFAULT_PREVIEW_ROOT = "docs/product";
export const DEFAULT_PREVIEW_PORT = 3877;

/** Tailscale CGNAT range for interface detection. */
export const TAILSCALE_V4_PREFIX = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
