/**
 * Process-global loopback HTTP intake for Chrome-extension annotations.
 *
 * A running ompx session opts in via a slash command, which registers a
 * `deliver` callback under an opaque `key` and prints a host/port + pairing
 * code. A Chrome extension pairs with the code, then POSTs picked/highlighted
 * DOM annotations + a screenshot. Submissions are validated and normalized to
 * exactly the shape the in-browser overlay produces, then handed to `deliver`
 * so they surface in the agent conversation identically.
 *
 * A single module-level {@link Bun.serve} instance is shared across every
 * registration and started lazily on the first `enableAnnotateHttp`; it is torn
 * down when the last registration is removed. The `deliver` callback is
 * injected by the caller so this module never imports `../browser.ts` or
 * `./tab-worker` (avoids an import cycle).
 */
import { logger } from "@oh-my-pi/pi-utils";
import { resizeImage } from "../../utils/image-resize";
import { type AnnotationPayload, validateAnnotationPayload } from "./annotate";
import type { AnnotationSubmission } from "./tab-protocol";

/** Connection details handed to the caller so it can print pairing instructions. */
export interface AnnotateHttpInfo {
	host: string;
	port: number;
	/** Human-facing pairing code in `XXXX-XXXX` form. */
	code: string;
	/** Base origin the extension pairs against, e.g. `http://127.0.0.1:3848`. */
	url: string;
}

/** Options for {@link enableAnnotateHttp}. */
export interface EnableAnnotateHttpOptions {
	/** Opaque identity for this registration; the same object toggles it off. */
	key: object;
	/** Label surfaced to the extension on a successful pair. */
	sessionLabel: string;
	/** Preferred loopback host to bind (only honored by the first caller). */
	host: string;
	/** Preferred port to bind (only honored by the first caller). */
	port: number;
	/** Invoked once per accepted submission with the normalized payload. */
	deliver: (submission: AnnotationSubmission) => void;
}

interface Registration {
	/** Display form, `XXXX-XXXX`. */
	code: string;
	/** Raw 8-char code used for exact matching. */
	normalizedCode: string;
	sessionLabel: string;
	deliver: (submission: AnnotationSubmission) => void;
	received: number;
}

// No I/O/0/1 — reduces human transcription errors. Length 32 (power of two), so
// `byte % length` is bias-free over crypto.getRandomValues output.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const ALLOWED_SCREENSHOT_MIME: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/webp": true,
};
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const PORT_FALLBACK_SPAN = 9;
const INVALID_CODE_WINDOW_MS = 60_000;
const INVALID_CODE_LIMIT = 20;

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const registrations = new Map<object, Registration>();
// Rolling timestamps (ms) of invalid-code responses for brute-force throttling.
const invalidCodeHits: number[] = [];

let server: Bun.Server<undefined> | null = null;
let boundHost = "";
let boundPort = 0;

function attachCors(response: Response): Response {
	for (const [key, value] of Object.entries(CORS_HEADERS)) {
		response.headers.set(key, value);
	}
	return response;
}

function corsJson(body: unknown, status: number): Response {
	return attachCors(Response.json(body, { status }));
}

/**
 * Preflight response. Chrome sends `Access-Control-Request-Private-Network` when
 * a public/extension origin targets a localhost/private address; without the
 * matching `Access-Control-Allow-Private-Network: true` the follow-up fetch
 * fails confusingly, so answer it explicitly here.
 */
function preflightResponse(): Response {
	const response = attachCors(new Response(null, { status: 204 }));
	response.headers.set("Access-Control-Allow-Private-Network", "true");
	return response;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function generateNormalizedCode(): string {
	const bytes = new Uint8Array(CODE_LENGTH);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let index = 0; index < CODE_LENGTH; index++) {
		out += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
	}
	return out;
}

function buildInfo(registration: Registration): AnnotateHttpInfo {
	return {
		host: boundHost,
		port: boundPort,
		code: registration.code,
		url: `http://${boundHost}:${boundPort}`,
	};
}

function findRegistrationByCode(code: string): Registration | null {
	const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (normalized.length === 0) {
		return null;
	}
	for (const registration of registrations.values()) {
		if (registration.normalizedCode === normalized) {
			return registration;
		}
	}
	return null;
}

/**
 * Build the response for an unknown-code hit, applying the rolling brute-force
 * throttle. Only invalid-code attempts are counted or throttled; valid codes
 * never reach here.
 */
function invalidCodeResponse(): Response {
	const now = Date.now();
	while (invalidCodeHits.length > 0 && now - invalidCodeHits[0] > INVALID_CODE_WINDOW_MS) {
		invalidCodeHits.shift();
	}
	if (invalidCodeHits.length >= INVALID_CODE_LIMIT) {
		logger.warn("annotate intake: invalid-code attempts throttled", {
			windowMs: INVALID_CODE_WINDOW_MS,
			count: invalidCodeHits.length,
		});
		return corsJson({ ok: false, error: "rate_limited" }, 429);
	}
	invalidCodeHits.push(now);
	return corsJson({ ok: false, error: "invalid_code" }, 403);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJsonBody(req: Request): Promise<BodyResult> {
	const contentLength = req.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			return { ok: false, response: corsJson({ ok: false, error: "payload_too_large" }, 413) };
		}
	}
	let text = "";
	if (req.body) {
		const reader = req.body.getReader();
		const decoder = new TextDecoder();
		let bytesRead = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				bytesRead += value.byteLength;
				if (bytesRead > MAX_BODY_BYTES) {
					await reader.cancel();
					return { ok: false, response: corsJson({ ok: false, error: "payload_too_large" }, 413) };
				}
				text += decoder.decode(value, { stream: true });
			}
			text += decoder.decode();
		} catch {
			return { ok: false, response: corsJson({ ok: false, error: "invalid_json" }, 400) };
		} finally {
			reader.releaseLock();
		}
	}
	if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
		return { ok: false, response: corsJson({ ok: false, error: "payload_too_large" }, 413) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, response: corsJson({ ok: false, error: "invalid_json" }, 400) };
	}
	return { ok: true, value: parsed };
}

async function handlePair(req: Request): Promise<Response> {
	const body = await readJsonBody(req);
	if (!body.ok) {
		return body.response;
	}
	const obj = asRecord(body.value);
	const code = typeof obj?.code === "string" ? obj.code : "";
	const registration = findRegistrationByCode(code);
	if (!registration) {
		return invalidCodeResponse();
	}
	return corsJson({ ok: true, session: registration.sessionLabel }, 200);
}

async function handleAnnotations(req: Request): Promise<Response> {
	const body = await readJsonBody(req);
	if (!body.ok) {
		return body.response;
	}
	const obj = asRecord(body.value);
	const code = typeof obj?.code === "string" ? obj.code : "";

	// (1) unknown code.
	const registration = findRegistrationByCode(code);
	if (!registration) {
		return invalidCodeResponse();
	}

	// (2) validate the annotation payload. `validateAnnotationPayload` parses a
	// raw JSON *string* and throws on invalid input, so re-serialize the already
	// parsed subtree and branch on the thrown error's message.
	let payload: AnnotationPayload;
	try {
		payload = validateAnnotationPayload(JSON.stringify(obj?.payload ?? null));
	} catch (error) {
		return corsJson({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
	}

	// (3) screenshot is required and bounded.
	const screenshot = asRecord(obj?.screenshot);
	const mimeType = typeof screenshot?.mimeType === "string" ? screenshot.mimeType : "";
	const dataB64 = typeof screenshot?.data === "string" ? screenshot.data : "";
	if (!Object.hasOwn(ALLOWED_SCREENSHOT_MIME, mimeType)) {
		return corsJson({ ok: false, error: "invalid_screenshot" }, 400);
	}
	let decodedBytes: number;
	try {
		decodedBytes = Uint8Array.fromBase64(dataB64).length;
	} catch {
		return corsJson({ ok: false, error: "invalid_screenshot" }, 400);
	}
	if (decodedBytes === 0 || decodedBytes > MAX_SCREENSHOT_BYTES) {
		return corsJson({ ok: false, error: "invalid_screenshot" }, 400);
	}

	// (4) normalize the image to match the in-browser overlay pipeline exactly.
	const resized = await resizeImage(
		{ type: "image", data: dataB64, mimeType },
		{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70 },
	);

	// (5) deliver in the shared submission shape.
	const submission: AnnotationSubmission = {
		payload,
		screenshot: { data: resized.buffer.toBase64(), mimeType: resized.mimeType },
		ts: Date.now(),
	};
	registration.deliver(submission);
	registration.received += 1;
	return corsJson({ ok: true }, 200);
}

async function handleRequest(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") {
		return preflightResponse();
	}
	const pathname = new URL(req.url).pathname;
	if (req.method === "POST" && pathname === "/v1/pair") {
		return await handlePair(req);
	}
	if (req.method === "POST" && pathname === "/v1/annotations") {
		return await handleAnnotations(req);
	}
	return corsJson({ ok: false, error: "not_found" }, 404);
}

/**
 * Start the shared server on the first available port in
 * `[preferredPort, preferredPort + PORT_FALLBACK_SPAN]`. `Bun.serve` throws
 * synchronously when a port is already bound, so probe each in turn.
 */
function ensureServer(host: string, preferredPort: number): void {
	if (server) {
		return;
	}
	const lastPort = preferredPort + PORT_FALLBACK_SPAN;
	for (let port = preferredPort; port <= lastPort; port++) {
		try {
			const started = Bun.serve({ hostname: host, port, fetch: handleRequest });
			server = started;
			boundHost = started.hostname ?? host;
			boundPort = started.port ?? port;
			logger.debug("annotate intake listening", { host: boundHost, port: boundPort });
			return;
		} catch (cause) {
			logger.debug("annotate intake: port bind failed", {
				host,
				port,
				error: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}
	throw new Error(`annotate intake: no free port in ${preferredPort}-${lastPort}`);
}

/**
 * Register a session for HTTP annotation intake and return its pairing info.
 *
 * Idempotent per `key`: a repeated call for a key that is already registered
 * returns its existing info (same code) without minting a new one. The shared
 * server is started lazily on the first registration.
 */
export async function enableAnnotateHttp(opts: EnableAnnotateHttpOptions): Promise<AnnotateHttpInfo> {
	const existing = registrations.get(opts.key);
	if (existing) {
		return buildInfo(existing);
	}
	ensureServer(opts.host, opts.port);
	const normalizedCode = generateNormalizedCode();
	const registration: Registration = {
		code: `${normalizedCode.slice(0, 4)}-${normalizedCode.slice(4)}`,
		normalizedCode,
		sessionLabel: opts.sessionLabel,
		deliver: opts.deliver,
		received: 0,
	};
	registrations.set(opts.key, registration);
	return buildInfo(registration);
}

/**
 * Remove the registration for `key`. When the last registration is removed the
 * shared server is stopped and its module ref cleared. Returns whether a
 * registration existed for `key`.
 */
export async function disableAnnotateHttp(key: object): Promise<boolean> {
	const existed = registrations.delete(key);
	if (registrations.size === 0 && server) {
		await server.stop(true);
		server = null;
		boundHost = "";
		boundPort = 0;
		invalidCodeHits.length = 0;
	}
	return existed;
}

/** Current pairing info + received count for a registered key, or `null`. */
export function getAnnotateHttpStatus(key: object): (AnnotateHttpInfo & { received: number }) | null {
	const registration = registrations.get(key);
	if (!registration) {
		return null;
	}
	return { ...buildInfo(registration), received: registration.received };
}
