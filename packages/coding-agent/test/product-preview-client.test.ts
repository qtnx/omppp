/**
 * Focused logic test: spec story-map parser.
 *
 * Tests the contract the client depends on — a valid spec markdown parses into
 * a story board model; malformed markdown falls back to raw. The parser is
 * extracted into a shared module so the test exercises the real code path
 * (client/client.js is plain JS, not importable as a module under bun test).
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseSpecPhases, parseSpecStories } from "../src/product-preview/client/spec-parser";

describe("parseSpecStories", () => {
	it("parses a valid spec into a story board with indicator counts", () => {
		const md = `# Spec: Auth

## Problem
Teams need invites.

## Stories

### S1 Owner reviews invite
**Persona:** Owner
Acceptance criteria:
- Owner sees pending invites
- Owner can revoke an invite
- Revoked invite shows a badge

### S2 Teammate accepts invite
**Persona:** Teammate
Acceptance criteria:
- Clicking invite shows workspace name
- Accepting creates a session cookie
`;

		const result = parseSpecStories(md);
		expect(result).not.toBeNull();
		expect(result!.parsed).toBe(2);
		expect(result!.total).toBe(2);
		expect(result!.stories).toHaveLength(2);

		const s1 = result!.stories[0];
		expect(s1.id).toBe("S1");
		expect(s1.title).toBe("Owner reviews invite");
		expect(s1.persona).toBe("Owner");
		expect(s1.acCount).toBe(3);

		const s2 = result!.stories[1];
		expect(s2.id).toBe("S2");
		expect(s2.persona).toBe("Teammate");
		expect(s2.acCount).toBe(2);
	});

	it("returns null (raw fallback) when no story headings exist", () => {
		const md = `# Just a doc
No stories here, just prose.
- bullet one
- bullet two
`;
		expect(parseSpecStories(md)).toBeNull();
	});

	it("returns null on completely malformed/empty input", () => {
		expect(parseSpecStories("")).toBeNull();
		expect(parseSpecStories("not markdown at all")).toBeNull();
	});

	it("counts AC bullets under an explicit AC block even without Acceptance criteria heading", () => {
		const md = `### S3 Expired invites
**Persona:** Teammate
AC:
- Expired invite returns a friendly message
- Owner is notified
`;
		const result = parseSpecStories(md);
		expect(result).not.toBeNull();
		expect(result!.stories[0].acCount).toBe(2);
	});

	it("handles missing persona gracefully (badge shows fallback)", () => {
		const md = `### S4 Bare story
- just a criterion
`;
		const result = parseSpecStories(md);
		expect(result).not.toBeNull();
		expect(result!.stories[0].persona).toBe("—");
		expect(result!.stories[0].acCount).toBe(1);
	});

	it("parses the bold-paragraph story format the product-spec skill emits", () => {
		const md = `# Spec

## Stories & acceptance criteria

**S1 — Review rendered artifacts** (Owner). As the owner, I can see every artifact rendered.
- AC1: GET / lists all bundle items grouped by kind.
- AC2: a bundle of 50 docs renders nav in <1s.
- AC3: invalid mermaid shows the code block + a parse-error badge.

**S2 — Story map & phases** (Owner). As the owner, I can see specs as a board.
- AC1: kind=spec renders a board with a parsed N/M indicator.
- AC2: parse failure falls back to raw markdown.

## Journey & states
Not part of any story.
- stray bullet that must not count toward S2
`;
		const result = parseSpecStories(md);
		expect(result).not.toBeNull();
		expect(result!.parsed).toBe(2);
		expect(result!.stories[0]).toEqual({
			id: "S1",
			title: "Review rendered artifacts",
			persona: "Owner",
			acCount: 3,
		});
		expect(result!.stories[1]).toEqual({ id: "S2", title: "Story map & phases", persona: "Owner", acCount: 2 });
	});
});

describe("parseSpecPhases", () => {
	it("parses the row-oriented cut-lines table the product-spec skill emits", () => {
		const md = `# Spec

## Scope & cut-lines

| Phase | Contents |
|---|---|
| NOW | S1-S9 full production grade |
| NEXT (named triggers) | per-viewer identity; annotate anchors |
| NOT | public-internet share; browser-side editing |

## Metrics
`;
		const cols = parseSpecPhases(md);
		expect(cols).toEqual({
			NOW: ["S1-S9 full production grade"],
			NEXT: ["per-viewer identity; annotate anchors"],
			NOT: ["public-internet share; browser-side editing"],
		});
	});

	it("parses a column-oriented NOW/NEXT/NOT table", () => {
		const md = `## Phases

| NOW | NEXT | NOT |
|---|---|---|
| ship auth | audit log | public API |
`;
		const cols = parseSpecPhases(md);
		expect(cols).toEqual({ NOW: ["ship auth"], NEXT: ["audit log"], NOT: ["public API"] });
	});

	it("parses inline list form and returns null without a section", () => {
		const md = `## Cut-lines
- NOW: core flow
- NEXT: exports
- NOT: realtime
`;
		expect(parseSpecPhases(md)).toEqual({ NOW: ["core flow"], NEXT: ["exports"], NOT: ["realtime"] });
		expect(parseSpecPhases("# Doc\nNo phases here.")).toBeNull();
	});
});

describe("vendor bundles", () => {
	// Committed copies are the import source (marked's exports map blocks deep
	// bare-specifier text imports of lib/marked.umd.js). This drift gate pins
	// each committed copy byte-for-byte to the pinned node_modules dist build,
	// so a dependency bump without a re-vendor fails CI instead of silently
	// serving a stale library.
	const vendorDir = path.join(import.meta.dir, "../src/product-preview/client/vendor");
	const distSources: Record<string, string> = {
		"marked.js": path.join(
			path.dirname(Bun.resolveSync("marked/package.json", import.meta.dir)),
			"lib/marked.umd.js",
		),
		"dompurify.js": Bun.resolveSync("dompurify/dist/purify.min.js", import.meta.dir),
		"mermaid.js": Bun.resolveSync("mermaid/dist/mermaid.min.js", import.meta.dir),
	};

	it("committed vendor copies are byte-identical to the pinned node_modules dist builds", async () => {
		for (const [name, distPath] of Object.entries(distSources)) {
			const committed = await Bun.file(path.join(vendorDir, name)).text();
			const dist = await Bun.file(distPath).text();
			expect(committed.length, `${name} drifted from ${distPath}`).toBe(dist.length);
			expect(Bun.hash(committed), `${name} drifted from ${distPath}`).toBe(Bun.hash(dist));
		}
	});

	it("vendor bundles are self-contained classic scripts (no ESM chunks)", async () => {
		for (const name of Object.keys(distSources)) {
			const body = await Bun.file(path.join(vendorDir, name)).text();
			expect(body, `${name} must not lazy-load sibling chunks`).not.toMatch(/\bimport\s*\(\s*["'`]\.?\.?\//);
			expect(body, `${name} must not reference a chunks/ directory`).not.toContain("chunks/");
			expect(body.trimStart().startsWith("import "), `${name} must not be a bare ESM module`).toBe(false);
		}
	});
});
