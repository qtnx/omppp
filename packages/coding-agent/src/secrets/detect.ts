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

/** Kinds that validate their own values, so the vendor-shape length floor does not apply. */
const SELF_VALIDATED_KINDS: Record<string, true> = { tag: true, generic: true, "url-password": true };
/** Passwords are routinely short; other keyword-assigned credentials keep a floor against prose. */
const MIN_PASSWORD_LENGTH = 4;
const MIN_KEYWORD_SECRET_LENGTH = 12;
/**
 * `IDENT = value`, `IDENT: value`, `"ident": "value"`, `export IDENT='value'`.
 * The identifier is checked separately so `bypass=` or `max_tokens:` never qualify.
 */
const ASSIGNMENT_PATTERN =
	/([A-Za-z][A-Za-z0-9_.-]*)["']?[ \t]*(?::=|[:=])[ \t]*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'`,;)}\]]+))/g;
/** Short `pass`/`pwd` need a boundary (`bypass`, `compass`); longer keywords also match glued (`PGPASSWORD`). */
const LOWER_KEYWORD_SUFFIX =
	/(?:(?:^|[_.-])(api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|client[_-]?secret|pwd|pass)|(apikey|passphrase|password|passwd|secret|token))$/i;
const CAMEL_KEYWORD_SUFFIX =
	/[a-z0-9](Api[_-]?[Kk]ey|Access[Kk]ey|Private[Kk]ey|Secret[Kk]ey|Client[Ss]ecret|Passphrase|Password|Passwd|Secret|Token|Pwd|Pass)$/;
/** `scheme://user:password@host` — the password group only. */
const URL_CREDENTIAL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@?#]+:([^\s/@?#]+)@/gi;
const PLACEHOLDER_WORDS: Record<string, true> = {
	none: true,
	null: true,
	nil: true,
	undefined: true,
	true: true,
	false: true,
	required: true,
	optional: true,
	string: true,
	str: true,
	number: true,
	boolean: true,
	password: true,
	secret: true,
	token: true,
	redacted: true,
	hidden: true,
	example: true,
	placeholder: true,
	env: true,
};

type CredentialFamily = "password" | "token";

function credentialKeyword(identifier: string): CredentialFamily | undefined {
	const lower = LOWER_KEYWORD_SUFFIX.exec(identifier);
	const keyword = lower ? (lower[1] ?? lower[2]) : CAMEL_KEYWORD_SUFFIX.exec(identifier)?.[1];
	if (!keyword) return undefined;
	return /pass|pwd/i.test(keyword) ? "password" : "token";
}

/** Rejects references, types, masks, and code expressions that sit where a secret value would. */
function isPlaceholderValue(value: string): boolean {
	if (PLACEHOLDER_WORDS[value.toLowerCase()]) return true;
	// Variable/template refs, masks, operators, and ellipses: `$PASS`, `${x}`, `<pw>`, `%s`, `***`, `==`, `…`.
	if (/^[$<{%*=&|!?]/.test(value) || /^[*•.x]+$/i.test(value) || value.includes("...") || value.includes("…")) {
		return true;
	}
	// Code rather than a literal: calls and member access (`getPassword()`, `req.body.password`).
	if (/[()]/.test(value) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return true;
	return false;
}

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
	"url-password": "PASSWORD",
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
	// An explicit `<secret>` tag is the user's declaration and keyword/URL
	// detections run their own plausibility check, so any non-empty value counts
	// there (short passwords included); the length floor only guards the
	// vendor-shape regexes against false positives.
	const tooShort = SELF_VALIDATED_KINDS[span.kind]
		? span.value.length === 0
		: span.kind !== "aws-access-key-id" && span.value.length < MIN_SECRET_LENGTH;
	if (tooShort || isInReplacement(span.start, span.end, replacements)) {
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
 * Single forward pass over `<secret>…</secret>` / `<sec>…</sec>` tags (the
 * short form is an alias; `<s>` and `<>` are deliberately NOT accepted — HTML
 * strikethrough and JSX fragments would turn pasted code into "secrets").
 *
 * A lazy `([\s\S]*?)` regex re-scans the remainder of the text from EVERY
 * `<secret` opening, so N unclosed openings cost O(N * len) — 64k openings
 * (~512 KiB) stalled prompt handling for ~10s. Here an unclosed opening
 * advances the cursor instead of restarting the scan, keeping the pass linear.
 */
function collectSecretTags(text: string): Array<{ start: number; end: number; value: string; name?: string }> {
	const tags: Array<{ start: number; end: number; value: string; name?: string }> = [];
	// `<sec>`, `<sec DB_PASS>`, `<sec name="DB_PASS">` (and the `<secret …>` spellings).
	const openPattern = /<sec(?:ret)?(?:\s+(?:name\s*=\s*(?:"([^"]*)"|'([^']*)')|([A-Za-z_][A-Za-z0-9_]*)))?\s*>/gi;
	const closeTag = /<\/sec(?:ret)?\s*>/gi;
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
			name: open[1] ?? open[2] ?? open[3] ?? assignedName(text, open.index),
		});
		cursor = close.index + close[0].length;
	}
	// `||value||` spoiler shorthand: no whitespace inside and not glued to a word
	// or another `|`, so shell/JS `a || b || c` and `x||y` never qualify.
	for (const match of text.matchAll(/(?<![|\w])\|\|([^\s|]+)\|\|(?![|\w])/g)) {
		tags.push({
			start: match.index,
			end: match.index + match[0].length,
			value: match[1],
			name: assignedName(text, match.index),
		});
	}
	return tags;
}

/** `DB_PASS=<sec>…</sec>` / `DB_PASS: ||…||` — reuse the assigned identifier as the env var name. */
function assignedName(text: string, markerStart: number): string | undefined {
	const before = text.slice(Math.max(0, markerStart - 80), markerStart);
	return /([A-Za-z_][A-Za-z0-9_]*)["']?[ \t]*(?::=|[:=])[ \t]*$/.exec(before)?.[1];
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

	for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
		const identifier = match[1];
		const family = credentialKeyword(identifier);
		if (!family) continue;
		const value = match[2] ?? match[3] ?? match[4];
		const minLength = family === "password" ? MIN_PASSWORD_LENGTH : MIN_KEYWORD_SECRET_LENGTH;
		if (value.length < minLength || isPlaceholderValue(value)) continue;
		const valueStart = match.index + match[0].length - value.length - (match[4] === undefined ? 1 : 0);
		addSpan(candidates, replacements, {
			start: valueStart,
			end: valueStart + value.length,
			value,
			name: identifier,
			kind: "generic",
			priority: 13,
		});
	}

	for (const match of text.matchAll(URL_CREDENTIAL_PATTERN)) {
		const value = match[1];
		if (isPlaceholderValue(value)) continue;
		const valueStart = match.index + match[0].length - value.length - 1;
		addSpan(candidates, replacements, {
			start: valueStart,
			end: valueStart + value.length,
			value,
			kind: "url-password",
			priority: 14,
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
