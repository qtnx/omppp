/**
 * Save-time novelty check for one candidate learning.
 *
 * Before the writer subprocess turns a candidate into a stored row, one System
 * One request decides whether an existing learning already covers the lesson: a
 * `choice` question over the existing aliases plus `none`, and a `noul` question
 * for how genuinely new the message is. A confident duplicate reinforces the
 * existing entry instead of running the writer; an uncertain or unavailable
 * answer falls through to the writer, which is today's behavior.
 */

import {
	JevError,
	jevAvailable,
	jevModel,
	postSystemOne,
	type JevQuestion,
	type JevRequest,
	type JevResponse,
	validateChoice,
	validateNoul,
} from "../jev/systemone";
import duplicateInstructions from "../prompts/learnings/novelty-duplicate.md" with { type: "text" };
import newInstructions from "../prompts/learnings/novelty-new.md" with { type: "text" };
import noneCriterion from "../prompts/learnings/novelty-none.md" with { type: "text" };
import { scoreLearningEntry, type LearningEntry, type LearningScope } from "./storage";

export interface NoveltyCheckConfig {
	enabled: boolean;
	reinforceThreshold: number;
	timeoutMs: number;
	maxCandidates: number;
	halfLifeDays: number;
}

export type NoveltyVerdict =
	| { kind: "duplicate"; target: LearningEntry; probability: number; isNew: number }
	| { kind: "new"; isNew: number; noneProbability: number }
	| { kind: "unavailable"; reason: string };

export interface NoveltyInput {
	userText: string;
	scope: LearningScope;
	cwd: string;
	existing: LearningEntry[];
	config: NoveltyCheckConfig;
	post?: typeof postSystemOne;
	nowSec?: number;
	signal?: AbortSignal;
}

export function buildNoveltyRequest(input: {
	model: string;
	userText: string;
	scope: LearningScope;
	cwd: string;
	existing: LearningEntry[];
	instructions: { duplicate: string; none: string; noul: string };
}): JevRequest {
	const criteria: Record<string, string | null> = { none: input.instructions.none };
	for (const entry of input.existing) {
		criteria[entry.contentHash.slice(0, 12)] = entry.content;
	}
	const questions: Record<string, JevQuestion> = {
		duplicate_of: { type: "choice", instructions: input.instructions.duplicate, criteria },
		is_new: { type: "noul", instructions: input.instructions.noul },
	};
	return {
		model: input.model,
		state: {
			message: input.userText,
			scope: input.scope,
			cwd: input.cwd,
			existing: input.existing.map(entry => ({ alias: entry.contentHash.slice(0, 12), content: entry.content })),
		},
		questions,
	};
}

export async function checkLearningNovelty(input: NoveltyInput): Promise<NoveltyVerdict> {
	const { userText, scope, cwd, existing, config } = input;
	if (!config.enabled || !jevAvailable()) return { kind: "unavailable", reason: "jev unavailable" };
	const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
	const ranked = [...existing].sort(
		(left, right) =>
			scoreLearningEntry(right, { nowSec, halfLifeDays: config.halfLifeDays }) -
			scoreLearningEntry(left, { nowSec, halfLifeDays: config.halfLifeDays }),
	);
	if (ranked.length === 0) return { kind: "new", isNew: 1, noneProbability: 1 };
	const shortlist = ranked.slice(0, Math.max(1, config.maxCandidates));
	let response: JevResponse;
	try {
		response = await (input.post ?? postSystemOne)(
			buildNoveltyRequest({
				model: jevModel(),
				userText,
				scope,
				cwd,
				existing: shortlist,
				instructions: { duplicate: duplicateInstructions, none: noneCriterion, noul: newInstructions },
			}),
			{ timeoutMs: config.timeoutMs, signal: input.signal },
		);
	} catch (error) {
		if (error instanceof JevError) return { kind: "unavailable", reason: error.message };
		throw error;
	}
	try {
		const byAlias = new Map(shortlist.map(entry => [entry.contentHash.slice(0, 12), entry] as const));
		const choice = validateChoice(response.answers.duplicate_of, ["none", ...byAlias.keys()]);
		const isNew = validateNoul(response.answers.is_new);
		const target = byAlias.get(choice.choice);
		if (choice.choice !== "none" && target && choice.probabilities[choice.choice]! >= config.reinforceThreshold) {
			return { kind: "duplicate", target, probability: choice.probabilities[choice.choice]!, isNew };
		}
		return { kind: "new", isNew, noneProbability: choice.probabilities["none"]! };
	} catch (error) {
		if (error instanceof JevError) return { kind: "unavailable", reason: error.message };
		throw error;
	}
}
