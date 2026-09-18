/** Work phase a primary turn is judged to be in. */
export type WorkPhase = "planning" | "implementing" | "verifying" | "debugging" | "blocked" | "reporting";

export const WORK_PHASES: readonly WorkPhase[] = [
	"planning",
	"implementing",
	"verifying",
	"debugging",
	"blocked",
	"reporting",
];

export function isWorkPhase(value: unknown): value is WorkPhase {
	return typeof value === "string" && (WORK_PHASES as readonly string[]).includes(value);
}

/** Typed judgments over one primary turn's rendered delta. */
export interface TurnSignals {
	phase: WorkPhase;
	/** Choice confidence 0..1 for `phase`. */
	phaseConfidence: number;
	/** Probability the advisor should review this turn. */
	needsReview: number;
	/** 0 advancing, 0.5 churning, 1 stuck. */
	stuck: number;
	/** Probability the turn claims completion without evidence. */
	doneWithoutEvidence: number;
	/** Probability the turn holds two or more independent work slices. */
	parallelSlices: number;
	model: string;
	inputTokens: number;
}

/** Judgments over a planner's handoff resolution. */
export interface HandoffSignals {
	scope: "single" | "multi";
	scopeConfidence: number;
	/** Probability the plan is locked enough to execute without re-planning. */
	planLocked: number;
}

/** Judgment over a candidate learning. */
export interface LearningSignals {
	/** Probability the content is a reusable generic rule rather than a case-specific note. */
	genericRule: number;
}

/** TypeSafe System One question shapes (subset used here). */
export type NoulQuestion = {
	type: "noul";
	instructions: string;
	criteria?: { true?: string; false?: string };
};
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
};
export type ScoreAnswer = {
	type: "score";
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
	model: string;
	answers: Record<string, Answer>;
	usage: { input_tokens: number; output_tokens: number };
}
