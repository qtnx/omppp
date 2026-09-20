import { logger } from "@oh-my-pi/pi-utils";
import { JevError, jevAvailable, jevModel, postSystemOne, type JevQuestion, validateChoice } from "../jev/systemone";
import triageInstructions from "../prompts/task/jev/question-triage.md" with { type: "text" };

export const TRIAGE_KINDS = ["fact-in-repo", "already-in-brief", "decision", "user-only", "status"] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

export interface ChildQuestionTriageInput {
	message: string;
	post?: typeof postSystemOne;
	signal?: AbortSignal;
}

export interface ChildQuestionTriage {
	kind: TriageKind;
	confidence: number;
}

export async function triageChildQuestion(input: ChildQuestionTriageInput): Promise<ChildQuestionTriage | undefined> {
	if (!jevAvailable()) return undefined;
	const questions: Record<string, JevQuestion> = {
		"triage::kind": {
			type: "choice",
			instructions: triageInstructions,
			criteria: {
				"fact-in-repo": "Parent can answer from repository map, source anchors, or known contract.",
				"already-in-brief": "Message restates information the assignment brief normally already carries.",
				decision: "Parent must make a design or scope decision.",
				"user-only": "Answer requires a secret, credential, external approval, or other user-only fact.",
				status: "Message only reports progress or completion; no answer is needed.",
			},
		},
	};
	try {
		const response = await (input.post ?? postSystemOne)(
			{
				model: jevModel(),
				state: { message: input.message },
				questions,
			},
			{ timeoutMs: 5_000, signal: input.signal },
		);
		const answer = validateChoice(response.answers["triage::kind"], TRIAGE_KINDS);
		if (answer.confidence < 0.5) return undefined;
		return { kind: answer.choice as TriageKind, confidence: answer.confidence };
	} catch (error) {
		if (error instanceof JevError) {
			logger.debug("Jev child-question triage unavailable", { error: error.message });
			return undefined;
		}
		throw error;
	}
}
