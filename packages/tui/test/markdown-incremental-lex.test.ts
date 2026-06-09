/**
 * The streaming reveal re-lexes the assistant message every ~30fps frame.
 * `lexMarkdown` reuses tokens of the stable prefix and re-lexes only the
 * trailing block. This guard proves the optimization is a pure equivalent: for
 * every streamed prefix, the incremental token sequence must equal a full
 * `markdownParser.lexer` of that same prefix. If marked's `raw` contiguity
 * invariant or a block-boundary assumption ever breaks, these fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	__lexMarkdownForTest as lex,
	__resetMarkdownLexCacheForTest as resetLexCache,
} from "../src/components/markdown.js";

type RawToken = { type: string; raw: string };

// Top-level (type, raw) fully determines the render: inline tokens are a pure
// function of `raw` via the same lexer, so equal type+raw ⇒ identical output.
function project(tokens: RawToken[]): string {
	return tokens.map(t => `${t.type}\u0000${t.raw}`).join("\u0001");
}

// Full-lex baseline: a single call against an empty cache (no reuse possible).
function fullLex(text: string): string {
	resetLexCache();
	return project(lex(text) as RawToken[]);
}

// Stream growing prefixes so the incremental reuse path fires, return the final.
function streamTo(text: string, step = 3): RawToken[] {
	resetLexCache();
	let last: RawToken[] = [];
	for (let n = 1; n < text.length; n += step) last = lex(text.slice(0, n)) as RawToken[];
	last = lex(text) as RawToken[];
	return last;
}

const CORPUS: Record<string, string> = {
	headingsAndProse:
		"# Title\n\nFirst paragraph with **bold** and `code`.\n\n## Section\n\nSecond paragraph that\nsoft-wraps across two source lines.\n\n",
	tightList: "Intro paragraph.\n\n- one\n- two\n- three\n\nOutro paragraph.\n",
	looseList: "- alpha\n\n- beta\n\n- gamma\n\nAfter the list.\n",
	orderedNested: "1. first\n2. second\n   - nested a\n   - nested b\n3. third\n\ntail\n",
	fencedCode: "Before code.\n\n```ts\nconst x = 1;\nfunction f() {\n  return x;\n}\n```\n\nAfter code.\n",
	blockquote: "> quoted line one\n> quoted line two\n\nplain paragraph follows\n\n",
	table: "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\ntrailing paragraph\n",
	thematicBreak: "Section A text\n\n---\n\nSection B text\n\n",
	setext: "Setext Title\n============\n\nbody paragraph\n\nAnother\n-------\n\ntail paragraph\n",
	mixed: "# Doc\n\nIntro **para**.\n\n```py\nprint('hi')\n```\n\n- list item\n- another item\n\n> a quote\n\nDone.\n",
	// A ref-def forces the full-lex fallback; correctness must still hold.
	refDef: "See [ref] here.\n\n[ref]: https://example.com\n\nMore text with [ref] again.\n",
};

describe("incremental markdown lexer == full lexer", () => {
	afterEach(() => resetLexCache());

	for (const [name, doc] of Object.entries(CORPUS)) {
		it(`final streamed lex matches full lex and loses no text: ${name}`, () => {
			const tokens = streamTo(doc);
			expect(tokens.map(t => t.raw).join("")).toBe(doc);
			expect(project(tokens)).toBe(fullLex(doc));
		});

		it(`every streamed prefix matches its full lex: ${name}`, () => {
			for (let n = 1; n <= doc.length; n += 5) {
				const prefix = doc.slice(0, n);
				const expected = fullLex(prefix);
				resetLexCache();
				let last: RawToken[] = [];
				for (let k = 1; k < n; k += 3) last = lex(doc.slice(0, k)) as RawToken[];
				last = lex(prefix) as RawToken[];
				expect(project(last)).toBe(expected);
			}
		});
	}

	// Fine-grained streaming (every 1–2 chars) surfaces seal artifacts that coarser
	// steps skip: a loose list sealed mid-stream must not be split into adjacent
	// single-item list tokens — the trailing-list strip must re-merge it.
	for (const step of [1, 2]) {
		for (const [name, doc] of Object.entries(CORPUS)) {
			it(`final streamed lex matches full lex at step ${step}: ${name}`, () => {
				expect(project(streamTo(doc, step))).toBe(fullLex(doc));
			});
		}
	}

	it("exercises the reuse branch (extending a cached multi-block prefix)", () => {
		const base = "# Heading\n\npara one\n\npara two\n\n";
		resetLexCache();
		lex(base); // cache a ≥2-token prefix
		const extended = `${base}para three with more words\n\n`;
		// startsWith(base) + ≥2 tokens + no ref-def ⇒ reuse path; must equal full.
		expect(project(lex(extended) as RawToken[])).toBe(fullLex(extended));
	});
});
