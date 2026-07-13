export interface TextAnchor {
	quote: string;
	prefix: string;
	suffix: string;
}

const CONTEXT_LENGTH = 32;

export function buildAnchor(docText: string, start: number, end: number): TextAnchor {
	const safeStart = Math.max(0, Math.min(start, docText.length));
	const safeEnd = Math.max(safeStart, Math.min(end, docText.length));
	return {
		quote: docText.slice(safeStart, safeEnd),
		prefix: docText.slice(Math.max(0, safeStart - CONTEXT_LENGTH), safeStart),
		suffix: docText.slice(safeEnd, safeEnd + CONTEXT_LENGTH),
	};
}

/** Resolves an exact quote only when its surrounding text identifies one occurrence. */
export function resolveAnchor(docText: string, anchor: TextAnchor): { start: number; end: number } | null {
	if (!anchor.quote) return null;

	const candidates: Array<{ start: number; end: number; score: number }> = [];
	let start = docText.indexOf(anchor.quote);
	while (start !== -1) {
		const end = start + anchor.quote.length;
		let score = 0;
		if (anchor.prefix && docText.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix)
			score += 1;
		if (anchor.suffix && docText.slice(end, end + anchor.suffix.length) === anchor.suffix) score += 1;
		candidates.push({ start, end, score });
		start = docText.indexOf(anchor.quote, start + 1);
	}
	if (!candidates.length) return null;

	const bestScore = Math.max(...candidates.map(candidate => candidate.score));
	const winners = candidates.filter(candidate => candidate.score === bestScore);
	return winners.length === 1 ? { start: winners[0].start, end: winners[0].end } : null;
}
