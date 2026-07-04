/**
 * Advisor note artifact store with opt-in clamping.
 *
 * Primary agents can emit large private note blocks. By default (clamp off, or
 * blocks within the configured threshold), this store forwards the full
 * obfuscated block verbatim. Only blocks exceeding `advisor.thinkingClampChars`
 * (>0) are redacted from the feed, persisted as a session artifact, replaced by
 * a `{{GIST:<id>}}` placeholder plus elision marker, and later summarized with
 * a neutral gist. Empty/trivial whitespace remains redacted-only so blank blocks
 * do not create useless artifacts.
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

/** LRU cap for the in-memory gist-source map (id → full obfuscated note). */
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
	"You summarize neutral note excerpts from an AI agent. For each excerpt, output `<id>:` followed by ≤3 terse bullets — decisions made, discoveries, risks/uncertainties. No preamble, no commentary.";

export interface ThinkingArtifactDeps {
	/** Session artifacts dir (absolute), e.g. `<sessionFile minus .jsonl>`; undefined → artifacts skipped (marker only). */
	artifactsDir: () => string | undefined;
	/** Secret redaction; identity fallback ok. */
	obfuscate: (text: string) => string;
	/** One-shot small-model summarizer; null → gisting unavailable (placeholders resolve to ""). */
	gistFn?: (excerpts: Array<{ id: string; text: string }>, signal: AbortSignal) => Promise<Map<string, string> | null>;
	/** Setting gate for the smol call (advisor.thinkingGist). */
	gistEnabled: () => boolean;
	/** Opt-in clamp threshold in chars (advisor.thinkingClampChars); 0/absent → full passthrough. */
	clampThreshold?: () => number;
}

export class ThinkingArtifactStore {
	readonly #deps: ThinkingArtifactDeps;
	/** id → full obfuscated note source (LRU, oldest evicted at {@link MIDDLE_LRU_CAP}). */
	readonly #gistSources = new Map<string, string>();
	/** id → resolved gist bullets (survives re-renders; substituted verbatim). */
	readonly #gistCache = new Map<string, string>();

	constructor(deps: ThinkingArtifactDeps) {
		this.#deps = deps;
	}

	/**
	 * Render an advisor-safe note block. By default, and for blocks within the
	 * opt-in clamp threshold, the full obfuscated block is forwarded verbatim.
	 * Oversized blocks are spilled to an artifact and replaced by a `{{GIST:<id>}}`
	 * placeholder plus elision marker for later smol summarization.
	 */
	renderThinking(text: string): string {
		const obfuscated = this.#deps.obfuscate(text);
		if (text.trim().length === 0) return obfuscated;

		// Clamping is opt-in (advisor.thinkingClampChars). Default/absent (≤0) and
		// blocks within the threshold forward the full obfuscated thinking verbatim —
		// no gist, no elision, no artifact spill. Only oversized blocks are clamped.
		const threshold = this.#deps.clampThreshold?.() ?? 0;
		if (threshold <= 0 || obfuscated.length <= threshold) return obfuscated;

		// Content hash → stable id across re-renders (natural dedupe of the same
		// block re-rendered each turn) and a natural artifact filename.
		const id = Bun.hash(text).toString(36);
		this.#storeGistSource(id, obfuscated);

		const dir = this.#deps.artifactsDir();
		let artifactPath: string | undefined;
		if (dir) {
			artifactPath = `${dir}/${ARTIFACT_SUBDIR}/notes-${id}.md`;
			// Fire-and-forget: a spill failure must never break rendering the feed.
			// Bun.write creates parent dirs.
			Bun.write(artifactPath, obfuscated).catch(err => {
				logger.debug("advisor-notes-artifacts: failed to persist artifact", {
					id,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}

		const elided = artifactPath
			? `[… ${obfuscated.length} chars elided — full: ${artifactPath} (read supports :start-end line ranges)]`
			: `[… ${obfuscated.length} chars elided]`;
		return `{{GIST:${id}}}\n${elided}`;
	}

	/**
	 * Substitute `{{GIST:<id>}}` placeholders in a batch. Only ids the store owns
	 * (present in the gist-source map or already gisted) are touched — a literal
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
			} else if (this.#gistSources.has(id)) {
				ownsAny = true;
				misses.add(id);
			}
		}
		if (!ownsAny) return batch;

		if (misses.size > 0 && this.#deps.gistEnabled() && this.#deps.gistFn) {
			const excerpts = [...misses].map(id => ({ id, text: this.#gistSources.get(id) ?? "" }));
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
			if (this.#gistSources.has(id)) return "";
			return whole; // unknown id — not ours
		});
	}

	#storeGistSource(id: string, source: string): void {
		// Refresh recency on re-insert; evict oldest past the cap.
		if (this.#gistSources.has(id)) this.#gistSources.delete(id);
		this.#gistSources.set(id, source);
		while (this.#gistSources.size > MIDDLE_LRU_CAP) {
			const oldest = this.#gistSources.keys().next().value;
			if (oldest === undefined) break;
			this.#gistSources.delete(oldest);
		}
	}
}

/**
 * Build the production `gistFn`: a one-shot smol-model summarizer for elided
 * note sources. Mirrors `title-generator.ts` for the side-request pattern and
 * the local-tiny billing-consent rule (issue #3187): when the user has configured
 * a local on-device tiny model (`providers.tinyModel` ≠ `ONLINE_TINY_TITLE_MODEL_KEY`),
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
			logger.debug("advisor-notes-artifacts: smol gist failed", {
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
