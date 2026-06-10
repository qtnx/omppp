import type { Page } from "puppeteer-core";
import overlayScript from "../puppeteer/annotate-overlay.txt" with { type: "text" };

export interface AnnotationElementInfo {
	/** Best-effort CSS selector, id-anchored when possible, max depth 6. */
	selector: string;
	tag: string; // lowercase tag name
	id?: string;
	classes?: string[]; // first 3 class names
	role?: string; // explicit role attribute
	name?: string; // aria-label || alt || placeholder || title attr (trimmed)
	text?: string; // trimmed innerText snippet
	rect: { x: number; y: number; width: number; height: number }; // viewport coords at capture time (MAY be negative)
}

/** A single annotation rectangle in viewport (CSS-pixel) coordinates. */
export interface AnnotationRect {
	x: number;
	y: number;
	width: number;
	height: number;
	note?: string;
	element?: AnnotationElementInfo;
}

/** Payload submitted by the in-page overlay when the human hits "Send to agent". */
export interface AnnotationPayload {
	comment: string;
	rects: AnnotationRect[];
	url: string;
	title?: string;
}

/**
 * Callback invoked once per overlay submission with the validated payload and a
 * viewport PNG captured with the overlay chrome hidden. Thrown/rejected errors
 * propagate back to the in-page caller so the overlay can surface a failure toast.
 */
export type AnnotationSubmitHandler = (payload: AnnotationPayload, screenshotPng: Buffer) => void | Promise<void>;

const SUBMIT_FN = "__ompxAnnotateSubmit";
const TAKE_PENDING_FN = "__ompxAnnotateTakePending";
const HOST_ID = "__ompx-annotate-host";
const COMMENT_MAX = 10_000;
const NOTE_MAX = 1_000;
const URL_MAX = 4_096;
const TITLE_MAX = 2_048;

interface AnnotationRegistration {
	/** Mutable handler ref so re-`enable` rebinds without re-exposing the binding. */
	onSubmit: AnnotationSubmitHandler | null;
	/** Identifier of the new-document overlay script, for later removal. */
	scriptId: string | null;
}

// Per-Page registration. The exposed binding is installed once per page and
// dispatches through this map, so enable/disable cycles only swap `onSubmit`.
const registry = new WeakMap<Page, AnnotationRegistration>();

function clampString(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function finiteNonNegative(value: unknown, field: string): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) throw new Error(`Annotation rect "${field}" must be a finite number`);
	return n < 0 ? 0 : n;
}

function finiteRounded(value: unknown): number | null {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.round(n) : null;
}

function optionalClampedString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 ? clampString(value, max) : undefined;
}

function validateElementInfo(value: unknown): AnnotationElementInfo | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	if (typeof obj.selector !== "string" || obj.selector.length === 0) return undefined;
	if (typeof obj.tag !== "string" || obj.tag.length === 0) return undefined;
	if (typeof obj.rect !== "object" || obj.rect === null || Array.isArray(obj.rect)) return undefined;
	const rawRect = obj.rect as Record<string, unknown>;
	const x = finiteRounded(rawRect.x);
	const y = finiteRounded(rawRect.y);
	const width = finiteRounded(rawRect.width);
	const height = finiteRounded(rawRect.height);
	if (x === null || y === null || width === null || height === null) return undefined;

	const element: AnnotationElementInfo = {
		selector: clampString(obj.selector, 500),
		tag: clampString(obj.tag, 50),
		rect: { x, y, width, height },
	};
	const id = optionalClampedString(obj.id, 200);
	if (id) element.id = id;
	const role = optionalClampedString(obj.role, 50);
	if (role) element.role = role;
	const name = optionalClampedString(obj.name, 120);
	if (name) element.name = name;
	const text = optionalClampedString(obj.text, 300);
	if (text) element.text = text;
	if (Array.isArray(obj.classes)) {
		const classes: string[] = [];
		for (const item of obj.classes) {
			if (typeof item === "string") {
				classes.push(clampString(item, 100));
				if (classes.length === 10) break;
			}
		}
		if (classes.length > 0) element.classes = classes;
	}
	return element;
}

/**
 * Parse and defensively validate the JSON string the overlay sends.
 *
 * - Rejects non-JSON / non-object payloads.
 * - Requires at least one of a non-empty `comment` or one rect.
 * - Coerces rect coords to finite numbers, clamping negatives to 0; throws on
 *   non-finite (NaN/Infinity) coordinates.
 * - Clamps oversized strings (`comment` ≤ 10k, `note` ≤ 1k, `url`/`title` bounded).
 * - Drops malformed per-rect element enrichment instead of rejecting the payload.
 *
 * Exported for unit testing; also the trust boundary for untrusted page input.
 */
export function validateAnnotationPayload(raw: string): AnnotationPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Annotation payload is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Annotation payload must be an object");
	}
	const obj = parsed as Record<string, unknown>;

	const comment = typeof obj.comment === "string" ? clampString(obj.comment, COMMENT_MAX) : "";

	const rectsInput = Array.isArray(obj.rects) ? obj.rects : [];
	const rects: AnnotationRect[] = [];
	for (const item of rectsInput) {
		if (typeof item !== "object" || item === null) {
			throw new Error("Annotation rect must be an object");
		}
		const r = item as Record<string, unknown>;
		const rect: AnnotationRect = {
			x: finiteNonNegative(r.x, "x"),
			y: finiteNonNegative(r.y, "y"),
			width: finiteNonNegative(r.width, "width"),
			height: finiteNonNegative(r.height, "height"),
		};
		if (typeof r.note === "string" && r.note.length > 0) {
			rect.note = clampString(r.note, NOTE_MAX);
		}
		const element = validateElementInfo(r.element);
		if (element) rect.element = element;
		rects.push(rect);
	}

	if (comment.trim().length === 0 && rects.length === 0) {
		throw new Error("Annotation requires a comment or at least one rect");
	}

	const payload: AnnotationPayload = {
		comment,
		rects,
		url: typeof obj.url === "string" ? clampString(obj.url, URL_MAX) : "",
	};
	if (typeof obj.title === "string") payload.title = clampString(obj.title, TITLE_MAX);
	return payload;
}

// Drives the capture flow for one overlay submission: validate → hide chrome →
// viewport screenshot → restore chrome → invoke the current handler. Anything
// thrown here rejects the page-side promise so the overlay can toast it.
async function dispatchSubmit(page: Page, raw: string): Promise<void> {
	const handler = registry.get(page)?.onSubmit;
	if (!handler) throw new Error("Annotation mode is not active for this page");

	const payload = validateAnnotationPayload(raw);

	await page
		.evaluate(() => {
			(globalThis as unknown as { __ompxAnnotateSetChromeVisible?: (visible: boolean) => void }).__ompxAnnotateSetChromeVisible?.(false);
		})
		.catch(() => undefined);
	let bytes: Uint8Array;
	try {
		bytes = await page.screenshot({ type: "png" });
	} finally {
		await page
			.evaluate(() => {
				(globalThis as unknown as { __ompxAnnotateSetChromeVisible?: (visible: boolean) => void }).__ompxAnnotateSetChromeVisible?.(true);
			})
			.catch(() => undefined);
	}
	// `page.screenshot` returns a Uint8Array; wrap it as a Buffer view over the
	// same memory (no copy) when it isn't already a Buffer.
	const screenshot = Buffer.isBuffer(bytes)
		? bytes
		: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	await handler(payload, screenshot);
}

/**
 * Install the human-in-the-loop annotation overlay on `page`.
 *
 * Flow:
 * 1. Expose `__ompxAnnotateSubmit` exactly once per page; the binding dispatches
 *    through a mutable per-page handler ref, so repeated calls just rebind
 *    `onSubmit` (puppeteer throws on a duplicate expose — that is caught).
 * 2. Register the overlay via `evaluateOnNewDocument` so it survives navigation,
 *    and `evaluate` it on the current document so it appears immediately.
 *
 * On submit the binding validates the payload, hides the overlay chrome, captures
 * a viewport PNG (chrome hidden, rects visible), restores chrome, then awaits
 * `onSubmit`. Idempotent per page.
 *
 * After (re)install, any submissions the overlay queued page-side while no agent
 * was connected (sessionStorage-backed offline queue) are drained through the
 * same dispatch path, so reconnecting delivers them immediately; their
 * screenshots reflect the current page state, not the moment they were queued.
 */
export async function enableAnnotationMode(page: Page, onSubmit: AnnotationSubmitHandler): Promise<void> {
	let reg = registry.get(page);
	if (reg) {
		reg.onSubmit = onSubmit;
	} else {
		reg = { onSubmit, scriptId: null };
		registry.set(page, reg);
		try {
			await page.exposeFunction(SUBMIT_FN, (raw: string) => dispatchSubmit(page, raw));
		} catch {
			// Name already bound (e.g. re-enable after a hot module reload). The
			// existing binding dispatches through the same registry, so rebinding
			// `onSubmit` above is sufficient.
		}
	}

	// Avoid stacking duplicate new-document scripts across enable cycles.
	if (reg.scriptId) {
		await page.removeScriptToEvaluateOnNewDocument(reg.scriptId).catch(() => undefined);
		reg.scriptId = null;
	}
	const registration = await page.evaluateOnNewDocument(overlayScript);
	reg.scriptId = registration.identifier;

	// Re-arm the page-side gate, then build the overlay on the current document.
	// Self-heal: if the host vanished while the installed flag lingers (e.g. the
	// document was wiped via document.open/write, which keeps globalThis), reset
	// the flag so the overlay rebuilds instead of no-opping on its guard.
	await page
		.evaluate((id: string) => {
			const g = globalThis as unknown as { __ompxAnnotateEnabled?: boolean; __ompxAnnotateInstalled?: boolean };
			g.__ompxAnnotateEnabled = true;
			if (!document.getElementById(id)) g.__ompxAnnotateInstalled = false;
		}, HOST_ID)
		.catch(() => undefined);
	await page.evaluate(overlayScript).catch(() => undefined);

	// Drain the page-side offline queue through the normal dispatch path.
	// Malformed entries are dropped; one bad entry must not block the rest.
	const pending = await page
		.evaluate((fn: string) => {
			const take = (globalThis as unknown as Record<string, (() => unknown) | undefined>)[fn];
			return typeof take === "function" ? take() : [];
		}, TAKE_PENDING_FN)
		.catch(() => []);
	if (Array.isArray(pending)) {
		for (const raw of pending) {
			if (typeof raw !== "string") continue;
			await dispatchSubmit(page, raw).catch(() => undefined);
		}
	}
}

/**
 * Tear down the overlay: stop dispatching submits (clear the handler ref), stop
 * re-injecting on navigation (`removeScriptToEvaluateOnNewDocument`), and remove
 * the host element + reset the page-side flags on the current document. The
 * exposed `__ompxAnnotateSubmit` binding is intentionally left in place so a
 * later `enableAnnotationMode` can rebind it without re-exposing.
 */
export async function disableAnnotationMode(page: Page): Promise<void> {
	const reg = registry.get(page);
	if (!reg) return;
	reg.onSubmit = null;
	if (reg.scriptId) {
		await page.removeScriptToEvaluateOnNewDocument(reg.scriptId).catch(() => undefined);
		reg.scriptId = null;
	}
	await page
		.evaluate((id: string) => {
			const g = globalThis as unknown as { __ompxAnnotateEnabled?: boolean; __ompxAnnotateInstalled?: boolean };
			g.__ompxAnnotateEnabled = false;
			g.__ompxAnnotateInstalled = false;
			document.getElementById(id)?.remove();
		}, HOST_ID)
		.catch(() => undefined);
}
