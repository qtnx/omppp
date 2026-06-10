/**
 * The streaming reveal re-renders a growing assistant message ~30fps and
 * recreates the Markdown component each frame. `render()` reuses the
 * rendered+wrapped+padded output of every blank-line-sealed block (keyed by the
 * reused token objects from `lexMarkdown`) and re-renders only the growing tail.
 *
 * This guard proves the optimization is a pure equivalent: for every streamed
 * prefix sequence ending at `doc`, the final incremental render MUST be
 * byte-identical to a fresh full render of `doc` (empty caches, no reuse). It
 * exercises the spacing coupling (`nextTokenType` trailing blanks), the
 * per-token wrap + margin/background factoring, code-fence highlight reuse, and
 * the OSC 66 (text-sizing) `previousLineWasOsc66` threading across the freeze
 * boundary. If any of those diverge, these fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Chalk } from "chalk";
import {
	type DefaultTextStyle,
	Markdown,
	type MarkdownTheme,
	__resetMarkdownRenderCachesForTest as resetRenderCaches,
} from "../src/components/markdown.js";
import { setTerminalTextSizing, TERMINAL } from "../src/terminal-capabilities.js";
import { defaultMarkdownTheme } from "./test-themes.js";

const chalk = new Chalk({ level: 3 });

// A deterministic highlighter exercises the code-fence path: a sealed fence must
// be highlighted exactly once and its lines reused; the open fence re-highlights.
const themeWithHighlight: MarkdownTheme = {
	...defaultMarkdownTheme,
	highlightCode: (code: string) => code.split("\n").map(line => chalk.green(line)),
};

// Multi-block documents (each \n\n seals a block) so the freeze actually fires.
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
	// A ref-def forces the full-lex fallback (no token reuse); equivalence must still hold.
	refDef: "See [ref] here.\n\n[ref]: https://example.com\n\nMore text with [ref] again.\n",
	// Paragraph -> list (paragraph's trailing blank depends on the next type being "list").
	paraThenList: "Lead paragraph here.\n\n- item one\n- item two\n\nClosing paragraph.\n",
};

interface Cfg {
	px: number;
	py: number;
	style?: DefaultTextStyle;
}

function fullRender(doc: string, width: number, theme: MarkdownTheme, cfg: Cfg): string[] {
	resetRenderCaches();
	return new Markdown(doc, cfg.px, cfg.py, theme, cfg.style).render(width);
}

// Stream growing prefixes (new instance per frame, mirroring component recreation)
// so the incremental reuse path fires, then return the final full render.
function streamRender(doc: string, width: number, theme: MarkdownTheme, cfg: Cfg, step = 2): string[] {
	resetRenderCaches();
	for (let n = 1; n < doc.length; n += step) {
		new Markdown(doc.slice(0, n), cfg.px, cfg.py, theme, cfg.style).render(width);
	}
	return new Markdown(doc, cfg.px, cfg.py, theme, cfg.style).render(width);
}

describe("incremental markdown render == full render", () => {
	afterEach(() => resetRenderCaches());

	const widths = [40, 80];
	const themes: Array<[string, MarkdownTheme]> = [
		["plain", defaultMarkdownTheme],
		["highlight", themeWithHighlight],
	];
	const cfgs: Array<[string, Cfg]> = [
		["px0py0", { px: 0, py: 0 }],
		["px2py1", { px: 2, py: 1 }],
	];

	for (const [docName, doc] of Object.entries(CORPUS)) {
		for (const width of widths) {
			for (const [themeName, theme] of themes) {
				for (const [cfgName, cfg] of cfgs) {
					it(`${docName} @${width} ${themeName} ${cfgName}`, () => {
						expect(streamRender(doc, width, theme, cfg)).toEqual(fullRender(doc, width, theme, cfg));
					});
				}
			}
		}
	}

	it("stays equivalent under a background-fill default style", () => {
		const style: DefaultTextStyle = { bgColor: (t: string) => `\x1b[44m${t}\x1b[49m` };
		const cfg: Cfg = { px: 1, py: 0, style };
		for (const doc of Object.values(CORPUS)) {
			expect(streamRender(doc, 60, defaultMarkdownTheme, cfg)).toEqual(
				fullRender(doc, 60, defaultMarkdownTheme, cfg),
			);
		}
	});
});

describe("incremental render with text-sizing (OSC 66) headings", () => {
	let prevTextSizing: boolean;
	beforeAll(() => {
		prevTextSizing = TERMINAL.textSizing;
		setTerminalTextSizing(true);
	});
	afterAll(() => setTerminalTextSizing(prevTextSizing));
	afterEach(() => resetRenderCaches());

	const docs: Record<string, string> = {
		h1ThenProse: "# Big Heading Here\n\nFollowing paragraph text that is long enough to wrap.\n\nmore tail\n",
		h1ThenCode: "# Title\n\n```ts\nconst x = 1;\n```\n\ntail paragraph\n",
		multipleH1: "# One\n\npara one\n\n# Two\n\npara two\n\n# Three\n\npara three\n\n",
	};

	for (const [name, doc] of Object.entries(docs)) {
		for (const width of [40, 80]) {
			it(`${name} @${width}`, () => {
				const cfg: Cfg = { px: 0, py: 0 };
				expect(streamRender(doc, width, defaultMarkdownTheme, cfg)).toEqual(
					fullRender(doc, width, defaultMarkdownTheme, cfg),
				);
			});
		}
	}
});
