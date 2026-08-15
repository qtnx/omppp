export interface DetectedSecret {
	start: number;
	end: number;
	value: string;
	name?: string;
	kind: string;
}

type Candidate = DetectedSecret & { generic: boolean; priority: number };

const MIN_SECRET_LENGTH = 12;
/**
 * Matches ONLY the exact marker `#detectAndStorePromptSecrets` emits:
 * `[secret NAME (MASK) — exported as env var NAME in bash]`, with the same
 * NAME on both sides. Deliberately strict: a loose `\[secret[^\]]*\]` would let
 * a user (or an injected document) wrap a live credential in `[secret ghp_…]`
 * and suppress every overlapping detection, sending the raw token to the model.
 */
const replacementPattern = /\[secret ([A-Z_][A-Z0-9_]{0,63}) \([^)]*\) — exported as env var \1 in bash\]/g;

const namesByKind: Record<string, string> = {
	"github-token": "GITHUB_TOKEN",
	"openai-key": "OPENAI_API_KEY",
	"anthropic-key": "ANTHROPIC_API_KEY",
	pem: "PRIVATE_KEY",
	"aws-access-key-id": "AWS_ACCESS_KEY_ID",
	"slack-token": "SLACK_TOKEN",
	"gitlab-token": "GITLAB_TOKEN",
	"npm-token": "NPM_TOKEN",
	"stripe-key": "STRIPE_KEY",
	jwt: "JWT_TOKEN",
	tag: "SECRET",
	generic: "SECRET",
	"hex-key": "SECRET",
};

export function kindToName(kind: string): string {
	return namesByKind[kind] ?? "SECRET";
}

function overlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
	return start < otherEnd && otherStart < end;
}

function isInReplacement(start: number, end: number, replacements: Array<[number, number]>): boolean {
	return replacements.some(([replacementStart, replacementEnd]) =>
		overlaps(start, end, replacementStart, replacementEnd),
	);
}

interface CandidateSpan {
	start: number;
	end: number;
	value: string;
	kind: string;
	priority: number;
	name?: string;
}

function addSpan(candidates: Candidate[], replacements: Array<[number, number]>, span: CandidateSpan): void {
	if (
		(span.kind !== "aws-access-key-id" && span.value.length < MIN_SECRET_LENGTH) ||
		isInReplacement(span.start, span.end, replacements)
	) {
		return;
	}
	candidates.push({ ...span, generic: span.kind === "generic" });
}

function addMatch(
	candidates: Candidate[],
	replacements: Array<[number, number]>,
	match: RegExpExecArray,
	kind: string,
	priority: number,
): void {
	addSpan(candidates, replacements, {
		start: match.index,
		end: match.index + match[0].length,
		value: match[0],
		kind,
		priority,
	});
}

function collectRegexMatches(
	text: string,
	replacements: Array<[number, number]>,
	candidates: Candidate[],
	pattern: RegExp,
	kind: string,
	priority: number,
): void {
	for (const match of text.matchAll(pattern)) {
		addMatch(candidates, replacements, match, kind, priority);
	}
}

/**
 * Single forward pass over `<secret>…</secret>` tags.
 *
 * A lazy `([\s\S]*?)` regex re-scans the remainder of the text from EVERY
 * `<secret` opening, so N unclosed openings cost O(N * len) — 64k openings
 * (~512 KiB) stalled prompt handling for ~10s. Here an unclosed opening
 * advances the cursor instead of restarting the scan, keeping the pass linear.
 */
function collectSecretTags(text: string): Array<{ start: number; end: number; value: string; name?: string }> {
	const tags: Array<{ start: number; end: number; value: string; name?: string }> = [];
	const openPattern = /<secret(?:\s+name\s*=\s*(?:"([^"]*)"|'([^']*)'))?\s*>/gi;
	const closeTag = /<\/secret\s*>/gi;
	let cursor = 0;
	while (cursor < text.length) {
		openPattern.lastIndex = cursor;
		const open = openPattern.exec(text);
		if (!open) break;
		const bodyStart = open.index + open[0].length;
		closeTag.lastIndex = bodyStart;
		const close = closeTag.exec(text);
		if (!close) {
			// Unclosed opening: no closing tag exists anywhere after it, so no
			// later opening can close either — the whole scan is done.
			break;
		}
		tags.push({
			start: open.index,
			end: close.index + close[0].length,
			value: text.slice(bodyStart, close.index).trim(),
			name: open[1] ?? open[2],
		});
		cursor = close.index + close[0].length;
	}
	return tags;
}

export function detectSecretsInText(text: string): DetectedSecret[] {
	const replacements = [...text.matchAll(replacementPattern)].map(
		match => [match.index, match.index + match[0].length] as [number, number],
	);
	const candidates: Candidate[] = [];

	for (const tag of collectSecretTags(text)) {
		addSpan(candidates, replacements, { ...tag, kind: "tag", priority: 0 });
	}
	collectRegexMatches(
		text,
		replacements,
		candidates,
		/^-----BEGIN ([A-Z ]*PRIVATE KEY)-----\r?$[\s\S]*?^-----END \1-----\r?$/gm,
		"pem",
		1,
	);
	collectRegexMatches(text, replacements, candidates, /gh[pousr]_[A-Za-z0-9]{36,}/g, "github-token", 2);
	collectRegexMatches(text, replacements, candidates, /github_pat_[A-Za-z0-9_]{22,}/g, "github-token", 3);
	collectRegexMatches(text, replacements, candidates, /sk-ant-[A-Za-z0-9-]{20,}/g, "anthropic-key", 4);
	collectRegexMatches(text, replacements, candidates, /sk-[A-Za-z0-9_-]{20,}/g, "openai-key", 5);
	collectRegexMatches(text, replacements, candidates, /\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key-id", 6);
	collectRegexMatches(text, replacements, candidates, /xox[baprs]-[A-Za-z0-9-]{10,}/g, "slack-token", 7);
	collectRegexMatches(text, replacements, candidates, /glpat-[A-Za-z0-9_-]{20,}/g, "gitlab-token", 8);
	collectRegexMatches(text, replacements, candidates, /npm_[A-Za-z0-9]{36}/g, "npm-token", 9);
	collectRegexMatches(text, replacements, candidates, /[sr]k_live_[A-Za-z0-9]{20,}/g, "stripe-key", 10);
	collectRegexMatches(
		text,
		replacements,
		candidates,
		/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
		"jwt",
		11,
	);

	for (const match of text.matchAll(/0x[0-9a-fA-F]{64}/g)) {
		const lineStart = text.lastIndexOf("\n", match.index) + 1;
		const lineEndIndex = text.indexOf("\n", match.index);
		const line = text.slice(lineStart, lineEndIndex === -1 ? text.length : lineEndIndex);
		if (/(key|private|secret|mnemonic|wallet)/i.test(line)) {
			addMatch(candidates, replacements, match, "hex-key", 12);
		}
	}

	for (const match of text.matchAll(
		/(api[_-]?key|apikey|token|secret|password|passwd)\s*[=:]\s*["']?([^\s"']{16,})["']?/gi,
	)) {
		const value = match[2];
		const separatorIndex = match[0].search(/[=:]/);
		const valueStart = match.index + match[0].indexOf(value, separatorIndex + 1);
		addSpan(candidates, replacements, {
			start: valueStart,
			end: valueStart + value.length,
			value,
			kind: "generic",
			priority: 13,
		});
	}

	const selected: Candidate[] = [];
	const specific = candidates
		.filter(candidate => !candidate.generic)
		.sort((left, right) => left.start - right.start || left.priority - right.priority);
	for (const candidate of specific) {
		if (
			!selected.some(selectedCandidate =>
				overlaps(candidate.start, candidate.end, selectedCandidate.start, selectedCandidate.end),
			)
		) {
			selected.push(candidate);
		}
	}

	const generic = candidates
		.filter(candidate => candidate.generic)
		.sort((left, right) => left.start - right.start || left.priority - right.priority);
	for (const candidate of generic) {
		if (
			!selected.some(selectedCandidate =>
				overlaps(candidate.start, candidate.end, selectedCandidate.start, selectedCandidate.end),
			)
		) {
			selected.push(candidate);
		}
	}

	return selected
		.sort((left, right) => left.start - right.start || left.priority - right.priority)
		.map(({ start, end, value, name, kind }) => ({
			start,
			end,
			value,
			...(name === undefined ? {} : { name }),
			kind,
		}));
}
