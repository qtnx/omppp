/**
 * Relevant-learning selection for one user turn.
 *
 * Candidates come from the learning store ranked by {@link scoreLearningEntry};
 * a System One request scores each shortlisted candidate with one `noul`
 * question ("does this guideline change how the assistant should carry out the
 * latest request?"), and the ones above threshold are injected into the turn.
 * When Jev is unavailable, disabled, or the request fails, the same selection
 * falls back to the stored rank. Everything here is pure — the session wires a
 * provider over this module.
 */

import { prompt } from "@oh-my-pi/pi-utils";
import {
	JevError,
	jevAvailable,
	jevModel,
	postSystemOne,
	type JevQuestion,
	type JevRequest,
	type JevResponse,
	validateNoul,
} from "../jev/systemone";
import relevanceInstructions from "../prompts/learnings/relevance.md" with { type: "text" };
import turnInjectionTemplate from "../prompts/learnings/turn-injection.md" with { type: "text" };
import { LEARNING_CONTEXT_MESSAGE_TYPE } from "../session/messages";
import type { LearningScope } from "./storage";

export { LEARNING_CONTEXT_MESSAGE_TYPE };

export interface LearningTurnCandidate {
	id: string;
	alias: string;
	scope: LearningScope;
	content: string;
	score: number;
}

export interface RelevanceCheckConfig {
	enabled: boolean;
	threshold: number;
	timeoutMs: number;
	maxCandidates: number;
	maxInjectedPerScope: number;
}

export type RelevanceSelection = {
	selected: LearningTurnCandidate[];
	method: "jev" | "rank";
	reason?: string;
};

export interface RelevanceInput {
	candidates: LearningTurnCandidate[];
	request: string;
	previousRequest?: string;
	cwd: string;
	config: RelevanceCheckConfig;
	post?: typeof postSystemOne;
	signal?: AbortSignal;
}

export function buildRelevanceRequest(input: {
	model: string;
	request: string;
	previousRequest?: string;
	cwd: string;
	candidates: LearningTurnCandidate[];
	instructions: string;
}): JevRequest {
	const questions: Record<string, JevQuestion> = {};
	for (const candidate of input.candidates) {
		questions[`rel::${candidate.alias}`] = {
			type: "noul",
			instructions: { question: input.instructions, guideline: candidate.content },
		};
	}
	return {
		model: input.model,
		state: { request: input.request, previous_request: input.previousRequest ?? null, cwd: input.cwd },
		questions,
	};
}

/** Fold a scored list into the per-scope injection cap, preserving order. */
function capPerScope(candidates: LearningTurnCandidate[], limit: number): LearningTurnCandidate[] {
	const selected: LearningTurnCandidate[] = [];
	const counts: Record<LearningScope, number> = { global: 0, repo: 0 };
	for (const candidate of candidates) {
		if (counts[candidate.scope] >= limit) continue;
		counts[candidate.scope] += 1;
		selected.push(candidate);
	}
	return selected;
}

export async function selectRelevantLearnings(input: RelevanceInput): Promise<RelevanceSelection> {
	const { candidates, request, previousRequest, cwd, config } = input;
	const ranked = [...candidates].sort((left, right) => right.score - left.score);
	const rankSelection = (reason?: string): RelevanceSelection => ({
		method: "rank",
		selected: capPerScope(ranked, config.maxInjectedPerScope),
		reason,
	});
	if (!config.enabled || !jevAvailable()) return rankSelection("jev unavailable");
	const shortlist = ranked.slice(0, Math.max(1, config.maxCandidates));
	if (shortlist.length === 0) return rankSelection();

	let response: JevResponse;
	try {
		response = await (input.post ?? postSystemOne)(
			buildRelevanceRequest({
				model: jevModel(),
				request,
				previousRequest,
				cwd,
				candidates: shortlist,
				instructions: relevanceInstructions,
			}),
			{ timeoutMs: config.timeoutMs, signal: input.signal },
		);
	} catch (error) {
		if (error instanceof JevError) return rankSelection(error.message);
		throw error;
	}
	const scored: Array<{ candidate: LearningTurnCandidate; noul: number }> = [];
	for (const candidate of shortlist) {
		const answer = response.answers[`rel::${candidate.alias}`];
		if (answer === undefined) continue;
		try {
			scored.push({ candidate, noul: validateNoul(answer) });
		} catch {
			// An invalid answer for one candidate must not fail the whole turn.
		}
	}
	const above = scored
		.filter(entry => entry.noul >= config.threshold)
		.sort((left, right) => right.noul - left.noul)
		.map(entry => entry.candidate);
	return { method: "jev", selected: capPerScope(above, config.maxInjectedPerScope) };
}

/** Render the hidden turn message; undefined when nothing was selected. */
export function renderLearningTurnMessage(
	selected: LearningTurnCandidate[],
	template: string = turnInjectionTemplate,
): string | undefined {
	const global = renderSection(
		"Global learnings",
		selected.filter(entry => entry.scope === "global"),
	);
	const repo = renderSection(
		"Repository-specific learnings",
		selected.filter(entry => entry.scope === "repo"),
	);
	if (!global && !repo) return undefined;
	return prompt.render(template, { global_section: global ?? "", repo_section: repo ?? "" }).trim();
}

function renderSection(title: string, entries: LearningTurnCandidate[]): string | undefined {
	if (entries.length === 0) return undefined;
	const lines = entries.map(entry => `- [l:${entry.alias}] ${entry.content.trim()}`).filter(line => line.length > 2);
	return lines.length === 0 ? undefined : `## ${title}\n${lines.join("\n")}`;
}
