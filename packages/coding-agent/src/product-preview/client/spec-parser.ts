/**
 * Spec story-map parser — shared between client.js (browser) and the test.
 *
 * client.js is plain JS (served verbatim under CSP script-src 'self'), so the
 * parser lives here as importable TS and is duplicated into the browser bundle
 * via a small inline copy. Keep the two in sync; the test pins the contract.
 */

export interface SpecStory {
	id: string;
	title: string;
	persona: string;
	acCount: number;
}

export interface SpecStoryBoard {
	stories: SpecStory[];
	total: number;
	parsed: number;
}

/**
 * Parse a spec markdown into a story board.
 *
 * Two story shapes exist (both emitted by the product skills):
 *   heading style  — `### S1 Title` (or `## S1 Title`)
 *   bold-paragraph — `**S1 — Title** (Persona). …` + `- AC…` bullets, the
 *                    product-spec skill template (docs/product/specs/*)
 * Returns null when no story matches at all so the caller falls back to raw
 * markdown (spec S2-AC2: never a blank board).
 */
export function parseSpecStories(md: string): SpecStoryBoard | null {
	interface StoryMatch {
		id: string;
		title: string;
		inlinePersona: string;
		bodyStart: number;
	}
	const found: StoryMatch[] = [];
	for (const m of md.matchAll(/^#{2,3}\s+S(\d+)\s+(.+)$/gm)) {
		found.push({ id: `S${m[1]}`, title: m[2].trim(), inlinePersona: "", bodyStart: (m.index ?? 0) + m[0].length });
	}
	for (const m of md.matchAll(/^\*\*S(\d+)(?:\s*[—–:-])?\s+([^*\n]+)\*\*(?:\s*\(([^)\n]+)\))?/gm)) {
		found.push({
			id: `S${m[1]}`,
			title: m[2].trim(),
			inlinePersona: m[3]?.trim() ?? "",
			bodyStart: (m.index ?? 0) + m[0].length,
		});
	}
	if (found.length === 0) return null;
	found.sort((a, b) => a.bodyStart - b.bodyStart);

	const stories: SpecStory[] = [];
	for (let i = 0; i < found.length; i++) {
		const match = found[i];
		const hardEnd = i + 1 < found.length ? found[i + 1].bodyStart : md.length;
		let body = md.slice(match.bodyStart, hardEnd);
		const nextHeading = body.search(/^#{1,6}\s/m);
		if (nextHeading !== -1) body = body.slice(0, nextHeading);

		let persona = match.inlinePersona;
		if (!persona) {
			const personaM = body.match(/\*\*Persona:?\*\*\s*(.+)/i) || body.match(/Persona:\s*(.+)/i);
			if (personaM)
				persona = personaM[1]
					.trim()
					.split(/\s{2,}|\||—/)[0]
					.trim();
		}

		let acCount = 0;
		// Prefer an explicit "Acceptance criteria"/"AC" block marker; otherwise
		// every bullet in the story body counts (bold-paragraph `- AC1:` style).
		const acMarker = body.match(/(?:Acceptance criteria|AC)[:\s]*\n([\s\S]+)/i);
		const acSource = acMarker ? acMarker[1] : body;
		for (const line of acSource.split("\n")) {
			if (/^\s*[-*]\s+\S/.test(line)) acCount++;
		}

		stories.push({ id: match.id, title: match.title, persona: persona || "—", acCount });
	}
	return { stories, total: found.length, parsed: stories.length };
}

export interface SpecPhases {
	NOW: string[];
	NEXT: string[];
	NOT: string[];
}

/**
 * Parse the spec's cut-lines section into NOW/NEXT/NOT columns.
 *
 * Handles three shapes:
 *   row-oriented table    — `| NOW | contents |` per row (product-spec skill
 *                           template; row label may carry a suffix like
 *                           `NEXT (named triggers)`)
 *   column-oriented table — `| NOW | NEXT | NOT |` header + value rows
 *   inline list           — `- NOW: contents`
 * Returns null when no cut-lines section or no phase content parses, so the
 * caller keeps the raw doc view (never a blank board).
 */
export function parseSpecPhases(md: string): SpecPhases | null {
	const cols: SpecPhases = { NOW: [], NEXT: [], NOT: [] };
	const sectionRe = /(?:^|\n)#{1,6}\s*[^\n]*(?:cut.?line|phases?)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|\n*$)/i;
	const body = md.match(sectionRe)?.[1];
	if (!body) return null;

	let headerOrder: Array<keyof SpecPhases> | null = null;
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (!line || /^[-:|\s]+$/.test(line)) continue;
		let arr = line.split("|").map(c => c.trim());
		if (arr[0] === "") arr = arr.slice(1);
		if (arr[arr.length - 1] === "") arr = arr.slice(0, -1);
		if (arr.length < 2) {
			const im = line.match(/^(?:[-*]\s+)?(NOW|NEXT|NOT)\s*[:—–-]\s*(.+)/i);
			if (im) cols[im[1].toUpperCase() as keyof SpecPhases].push(im[2].trim());
			continue;
		}
		// A row whose EVERY cell is a bare phase label is a column-table header.
		if (!headerOrder && arr.every(c => /^(NOW|NEXT|NOT)$/i.test(c))) {
			headerOrder = arr.map(c => c.toUpperCase() as keyof SpecPhases);
			continue;
		}
		// Row-oriented: first cell is the phase label (suffixes allowed).
		const rowKey = arr[0].toUpperCase().match(/^(NOW|NEXT|NOT)\b/)?.[1] as keyof SpecPhases | undefined;
		if (rowKey) {
			const content = arr.slice(1).join(" — ").trim();
			if (content) cols[rowKey].push(content);
			continue;
		}
		// Column-oriented: a `| NOW | NEXT | NOT |` header row sets the order.
		if (!headerOrder) {
			const order = arr
				.map(c => c.toUpperCase().match(/^(NOW|NEXT|NOT)$/)?.[0])
				.filter((c): c is keyof SpecPhases => Boolean(c));
			if (order.length >= 1) {
				headerOrder = order;
				continue;
			}
		}
		if (headerOrder) {
			for (let i = 0; i < headerOrder.length && i < arr.length; i++) {
				if (arr[i].trim()) cols[headerOrder[i]].push(arr[i].trim());
			}
		}
	}
	if (!cols.NOW.length && !cols.NEXT.length && !cols.NOT.length) return null;
	return cols;
}
