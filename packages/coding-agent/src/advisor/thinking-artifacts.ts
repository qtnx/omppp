/**
 * Thinking-block clamping + gist store for the advisor feed.
 *
 * Primary agents running at high effort emit huge thinking blocks; feeding them
 * verbatim to the advisor is the single largest input cost. This store keeps the
 * head/tail of a large block verbatim (obfuscated), elides the middle behind a
 * `{{GIST:<id>}}` placeholder, and persists the full obfuscated text as a
 * session artifact the advisor can `read` by line range. When gisting is enabled
 * a tiny/smol model later summarizes the elided middles; the placeholder is
 * substituted with those bullets just before the batch is sent.
 *
 * The store is dependency-injected (no direct session imports) so it stays unit
 * testable: a fake `artifactsDir`/`obfuscate`/`gistFn` covers every path.
 */
import { type AssistantMessage, completeSimple } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { ONLINE_TINY_TITLE_MODEL_KEY } from "../tiny/models";

/** Blocks at or under this length are fed verbatim (obfuscated); no clamp/gist. */
const CLAMP_THRESHOLD = 2000;
/** Verbatim head/tail character budget kept around the elided middle. */
const HEAD_TAIL_CHARS = 400;
/** LRU cap for the in-memory middle-slice map (id → obfuscated middle). */
const MIDDLE_LRU_CAP = 64;
/** Artifact subdirectory under the session artifacts dir. */
const ARTIFACT_SUBDIR = "__advisor-artifacts";
/** Placeholder pattern; ids are Bun.hash(text).toString(36) → `[a-z0-9]+`. */
const GIST_PLACEHOLDER_RE = /\{\{GIST:([a-z0-9]+)\}\}/g;
/** Budget for one smol gist call. */
const GIST_MAX_TOKENS = 700;
/** Wall-clock budget for one smol gist round. */
const GIST_TIMEOUT_MS = 5_000;

const GIST_SYSTEM_PROMPT =
	"You summarize elided middles of an AI agent's thinking. For each excerpt, output `<id>:` followed by ≤3 terse bullets — decisions made, discoveries, risks/uncertainties. No preamble, no commentary.";

export interface ThinkingArtifactDeps {
	/** Session artifacts dir (absolute), e.g. `<sessionFile minus .jsonl>`; undefined → artifacts skipped (marker only). */
	artifactsDir: () => string | undefined;
	/** Secret redaction; identity fallback ok. */
	obfuscate: (text: string) => string;
	/** One-shot small-model summarizer; null → gisting unavailable (placeholders resolve to ""). */
	gistFn?: (excerpts: Array<{ id: string; text: string }>, signal: AbortSignal) => Promise<Map<string, string> | null>;
	/** Setting gate for the smol call (advisor.thinkingGist). */
	gistEnabled: () => boolean;
	/** Optional character budget for clamping; 0 or less disables clamping. */
	clampThreshold?: () => number;
}

export class ThinkingArtifactStore {
	readonly #deps: ThinkingArtifactDeps;
	/** id → obfuscated middle slice (LRU, oldest evicted at {@link MIDDLE_LRU_CAP}). */
	readonly #middles = new Map<string, string>();
	/** id → resolved gist bullets (survives re-renders; substituted verbatim). */
	readonly #gistCache = new Map<string, string>();
	readonly #clampThreshold?: () => number;

	constructor(deps: ThinkingArtifactDeps) {
		this.#deps = deps;
		this.#clampThreshold = deps.clampThreshold;
	}

	/**
	 * Clamp a thinking block for the advisor feed. Short blocks are returned
	 * obfuscated verbatim; large blocks are clamped to head/tail + a
	 * `{{GIST:<id>}}` placeholder, with the full obfuscated text spilled to an
	 * artifact (fire-and-forget). Always obfuscates — this text feeds the model.
	 */
	renderThinking(text: string): string {
		const obfuscated = this.#deps.obfuscate(text);
		const threshold = this.#clampThreshold?.() ?? CLAMP_THRESHOLD;
		if (threshold <= 0 || text.length <= threshold) return obfuscated;
		// Content hash → stable id across re-renders (natural dedupe of the same
		// block re-rendered each turn) and a natural artifact filename.
		const id = Bun.hash(text).toString(36);
		const head = obfuscated.slice(0, HEAD_TAIL_CHARS);
		const tail = obfuscated.slice(Math.max(HEAD_TAIL_CHARS, obfuscated.length - HEAD_TAIL_CHARS));
		const middle = obfuscated.slice(HEAD_TAIL_CHARS, Math.max(HEAD_TAIL_CHARS, obfuscated.length - HEAD_TAIL_CHARS));
		this.#storeMiddle(id, middle);

		const dir = this.#deps.artifactsDir();
		let artifactPath: string | undefined;
		if (dir) {
			artifactPath = `${dir}/${ARTIFACT_SUBDIR}/thinking-${id}.md`;
			// Fire-and-forget: a spill failure must never break rendering the feed.
			// Bun.write creates parent dirs.
			Bun.write(artifactPath, obfuscated).catch(err => {
				logger.debug("thinking-artifacts: failed to persist artifact", {
					id,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}

		const elided = artifactPath
			? `[… ${middle.length} chars elided — full: ${artifactPath} (read supports :start-end line ranges)]`
			: `[… ${middle.length} chars elided]`;
		return `${head}\n{{GIST:${id}}}\n${elided}\n${tail}`;
	}

	/**
	 * Substitute `{{GIST:<id>}}` placeholders in a batch. Only ids the store owns
	 * (present in the middle-map or already gisted) are touched — a literal
	 * `{{GIST:...}}` in user text with an unknown id is left as-is. Cached gists
	 * substitute immediately; uncached misses trigger ONE smol call (when enabled)
	 * for all of them; anything unresolved substitutes to "" (the adjacent elided
	 * marker already explains). Never rejects.
	 */
	async resolveGists(batch: string): Promise<string> {
		const misses = new Set<string>();
		let ownsAny = false;
		for (const match of batch.matchAll(GIST_PLACEHOLDER_RE)) {
			const id = match[1];
			if (this.#gistCache.has(id)) {
				ownsAny = true;
			} else if (this.#middles.has(id)) {
				ownsAny = true;
				misses.add(id);
			}
		}
		if (!ownsAny) return batch;

		if (misses.size > 0 && this.#deps.gistEnabled() && this.#deps.gistFn) {
			const excerpts = [...misses].map(id => ({ id, text: this.#middles.get(id) ?? "" }));
			try {
				const result = await this.#deps.gistFn(excerpts, AbortSignal.timeout(GIST_TIMEOUT_MS));
				if (result) {
					for (const [id, bullets] of result) {
						const trimmed = bullets.trim();
						if (trimmed) this.#gistCache.set(id, trimmed);
					}
				}
			} catch {
				// Timeout/abort/throw → leave misses uncached; they substitute to "".
			}
		}

		return batch.replace(GIST_PLACEHOLDER_RE, (whole, id: string) => {
			const cached = this.#gistCache.get(id);
			if (cached) return `_gist:_ ${cached}`;
			if (this.#middles.has(id)) return "";
			return whole; // unknown id — not ours
		});
	}

	#storeMiddle(id: string, middle: string): void {
		// Refresh recency on re-insert; evict oldest past the cap.
		if (this.#middles.has(id)) this.#middles.delete(id);
		this.#middles.set(id, middle);
		while (this.#middles.size > MIDDLE_LRU_CAP) {
			const oldest = this.#middles.keys().next().value;
			if (oldest === undefined) break;
			this.#middles.delete(oldest);
		}
	}
}

/**
 * Build the production `gistFn`: a one-shot smol-model summarizer for the elided
 * middles. Mirrors `title-generator.ts` for the side-request pattern and the
 * local-tiny billing-consent rule (issue #3187): when the user has configured a
 * local on-device tiny model (`providers.tinyModel` ≠ `ONLINE_TINY_TITLE_MODEL_KEY`),
 * we must NOT silently fall back to an online smol model that would bill an
 * arbitrary provider without consent — so we return `undefined` (gisting
 * unavailable; placeholders resolve to "" next to the artifact pointer). Only
 * the default/explicit online selection proceeds to `resolveRoleSelection`.
 */
export function createSmolGistFn(opts: {
	registry: ModelRegistry;
	settings: Settings;
	sessionId?: string;
}): ThinkingArtifactDeps["gistFn"] | undefined {
	const { registry, settings, sessionId } = opts;
	// Local-tiny consent rule, replicated from title-generator.ts (~130-143):
	// the online key is the only value that permits an online side-request; any
	// other value means a local tiny model was chosen → no online fallback.
	if (settings.get("providers.tinyModel") !== ONLINE_TINY_TITLE_MODEL_KEY) {
		return undefined;
	}

	return async (excerpts, signal) => {
		if (excerpts.length === 0) return new Map();
		try {
			const available = registry.getAvailable();
			if (available.length === 0) return null;
			const resolved = resolveRoleSelection(["tiny", "smol"], settings, available);
			const model = resolved?.model;
			if (!model) return null;
			const apiKey = await registry.getApiKey(model, sessionId);
			if (!apiKey) return null;

			const content = excerpts.map(e => `### ${e.id}\n${e.text}`).join("\n\n");
			const response = await completeSimple(
				model,
				{ systemPrompt: [GIST_SYSTEM_PROMPT], messages: [{ role: "user", content, timestamp: Date.now() }] },
				{ apiKey, maxTokens: GIST_MAX_TOKENS, disableReasoning: true, signal },
			);
			if (response.stopReason === "error") return null;
			return parseGistResponse(response.content, excerpts);
		} catch (err) {
			logger.debug("thinking-artifacts: smol gist failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	};
}

/**
 * Tolerant parse of a smol gist response into `id → bullets`. Accepts headers of
 * the form `<id>:`, `### <id>`, list-prefixed variants, and `<id>: bullet` on one
 * line; unparseable ids are omitted (they substitute to "").
 */
function parseGistResponse(
	content: AssistantMessage["content"],
	excerpts: Array<{ id: string; text: string }>,
): Map<string, string> {
	const ids = new Set(excerpts.map(e => e.id));
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += block.text;
	}

	const map = new Map<string, string>();
	let currentId: string | undefined;
	let buf: string[] = [];
	const flush = () => {
		if (currentId) {
			const body = buf.join("\n").trim();
			if (body) map.set(currentId, body);
		}
		buf = [];
	};
	for (const rawLine of text.split("\n")) {
		// `<id>` or `### <id>` or `- <id>:` header alone on the line.
		const header = rawLine.match(/^\s*#*\s*[-*]?\s*([a-z0-9]+)\s*:?\s*$/i);
		if (header && ids.has(header[1])) {
			flush();
			currentId = header[1];
			continue;
		}
		// `<id>: first bullet` header + inline body.
		const inline = rawLine.match(/^\s*#*\s*[-*]?\s*([a-z0-9]+)\s*:\s*(\S.*)$/i);
		if (inline && ids.has(inline[1])) {
			flush();
			currentId = inline[1];
			buf.push(inline[2]);
			continue;
		}
		if (currentId) buf.push(rawLine);
	}
	flush();
	return map;
}
