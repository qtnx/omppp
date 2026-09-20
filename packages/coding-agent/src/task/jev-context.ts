import { JevError, jevAvailable, jevModel, postSystemOne, type JevQuestion, validateChoice } from "../jev/systemone";
import { redactMemorySecrets, redactNested } from "../memory-backend/redact";
import instructions from "../prompts/task/jev/context-relevance.md" with { type: "text" };

const VERDICTS = ["required", "supporting", "superseded", "irrelevant"] as const;
const CRITERIA = { required: null, supporting: null, superseded: null, irrelevant: null };
const MAX_CANDIDATES = 40;
const MAX_CANDIDATE_CHARS = 16_000;

export interface RelevantContextInput {
	assignment: string;
	context?: string;
	snapshot: string;
	post?: typeof postSystemOne;
	signal?: AbortSignal;
	maxSections?: number;
	maxChars?: number;
	redact?: (text: string) => string;
}

export interface RelevantContextSelection {
	sections: string[];
	method: "jev" | "none";
	/** Partial classification or required material exceeding the excerpt budget. */
	requiresFullSnapshot: boolean;
	omitted: number;
}

interface Section {
	id: number;
	text: string;
}

export async function selectRelevantContext({
	assignment,
	context,
	snapshot,
	post,
	signal,
	maxSections = 6,
	maxChars = 6000,
	redact,
}: RelevantContextInput): Promise<RelevantContextSelection> {
	const raw = snapshot
		.split(/(?:^|\n)## /)
		.slice(1)
		.map(text => `## ${text.trim()}`);
	const latest = new Map<string, Section>();
	for (const [id, text] of raw.entries())
		latest.set(text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, ""), { id, text });
	const all = [...latest.values()].sort((a, b) => a.id - b.id);
	const fallback = (): RelevantContextSelection => ({
		sections: [],
		method: "none",
		requiresFullSnapshot: all.length > 0,
		omitted: all.length,
	});
	const sectionLimit = Number.isFinite(maxSections) ? Math.max(0, Math.floor(maxSections)) : 6;
	const charLimit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 6000;
	if (!jevAvailable() || !all.length || !sectionLimit || !charLimit) return fallback();

	// Keep a chronological suffix, without presenting a clipped constraint as complete.
	const offered: Section[] = [];
	let candidateChars = 0;
	for (let index = all.length - 1; index >= 0 && offered.length < MAX_CANDIDATES; index--) {
		const section = all[index]!;
		if (candidateChars + section.text.length > MAX_CANDIDATE_CHARS) break;
		offered.push(section);
		candidateChars += section.text.length;
	}
	offered.reverse();
	if (!offered.length) return fallback();
	const questions: Record<string, JevQuestion> = {};
	for (const section of offered)
		questions[`ctx::${section.id}`] = {
			type: "choice",
			instructions: { question: instructions, section_id: section.id },
			criteria: CRITERIA,
		};
	const scrub = redact ? (text: string) => redactMemorySecrets(redact(text)) : redactMemorySecrets;
	let answers: Record<string, unknown>;
	try {
		answers = (
			await (post ?? postSystemOne)(
				{
					model: jevModel(),
					state: redactNested(
						{
							assignment,
							context: context ?? null,
							sections: offered,
							omitted_sections: all.length - offered.length,
						},
						scrub,
					),
					questions,
				},
				{ timeoutMs: 8000, signal },
			)
		).answers;
	} catch (error) {
		if (error instanceof JevError) return fallback();
		throw error;
	}
	let requiresFullSnapshot = offered.length !== all.length;
	const ranked: Array<{ section: Section; required: boolean; confidence: number }> = [];
	for (const section of offered) {
		try {
			const verdict = validateChoice(answers[`ctx::${section.id}`], VERDICTS);
			if (verdict.confidence < 0.6) {
				requiresFullSnapshot = true;
				continue;
			}
			if (verdict.choice === "required" || verdict.choice === "supporting")
				ranked.push({
					section,
					required: verdict.choice === "required",
					confidence: verdict.confidence,
				});
		} catch (error) {
			if (!(error instanceof JevError)) throw error;
			requiresFullSnapshot = true;
		}
	}
	ranked.sort(
		(a, b) => Number(b.required) - Number(a.required) || b.confidence - a.confidence || a.section.id - b.section.id,
	);
	const selected: Section[] = [];
	let used = 0;
	for (const entry of ranked) {
		const size = entry.section.text.length + (selected.length ? 2 : 0);
		if (selected.length >= sectionLimit || used + size > charLimit) {
			if (entry.required) requiresFullSnapshot = true;
			continue;
		}
		selected.push(entry.section);
		used += size;
	}
	selected.sort((a, b) => a.id - b.id);
	return {
		sections: selected.map(section => section.text),
		method: "jev",
		requiresFullSnapshot,
		omitted: all.length - selected.length,
	};
}
