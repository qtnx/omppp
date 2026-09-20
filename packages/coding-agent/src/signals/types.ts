/** Work phase a primary turn is judged to be in. */
export type WorkPhase =
	| "preplanning"
	| "planning"
	| "implementing"
	| "verifying"
	| "debugging"
	| "blocked"
	| "reporting";

export const WORK_PHASES: readonly WorkPhase[] = [
	"preplanning",
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
	/**
	 * Probability the slice is open-ended discovery in unfamiliar code (many
	 * reads/searches across modules with no edit target yet) rather than a
	 * targeted lookup. Omitted when the classifier did not answer it.
	 */
	openEndedDiscovery?: number;
	/** Routing judgment over the current work and original user request. */
	routing?: PromptSignals;
	model: string;
	inputTokens: number;
}

/**
 * Extension EventBus channel carrying every resolved {@link TurnSignals}
 * (payload: one `TurnSignals` object). Extensions that gate on a turn
 * classification subscribe through `pi.events`; the delegation-reminder
 * plugin uses it to tell a parallel-slice turn from a single-slice one.
 */
export const TURN_SIGNALS_CHANNEL = "signals:turn";

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

/** Judgment over a new user request against the session's prior context. */
export interface TopicSignals {
	/** Probability the request starts work the prior context is not needed for. */
	topicSwitch: number;
}

/** How hard a new user request is judged before any work starts, easiest first. */
export type PromptDifficulty = "easy" | "moderate" | "hard" | "extreme";

/** Ascending difficulty; the index doubles as the rung on the routing model ladder. */
export const PROMPT_DIFFICULTIES: readonly PromptDifficulty[] = ["easy", "moderate", "hard", "extreme"];

export function isPromptDifficulty(value: unknown): value is PromptDifficulty {
	return typeof value === "string" && (PROMPT_DIFFICULTIES as readonly string[]).includes(value);
}

/** Judgments over a new user request, used to route it to the right model tier. */
export interface PromptSignals {
	difficulty: PromptDifficulty;
	/** Choice confidence 0..1 for `difficulty`. */
	difficultyConfidence: number;
	/** Reasoning effort selected for the request. */
	thinking?: "medium" | "high" | "xhigh";
	/** Probability the request touches a risk domain (auth, money, data migration, deploy, secrets). */
	risk: number;
}

/** One prompt record offered to the context-trim judgment. */
export interface ContextTrimCandidate {
	id: string;
	kind: string;
	/** Conversational turns since the record entered the prompt. */
	ageTurns: number;
	tokens: number;
	/** One-line summary; clipped by the caller. */
	summary: string;
}

export interface ContextTrimInput {
	upcomingRequest: string;
	sessionDigest: string;
	contextTokens: number | null;
	candidates: ContextTrimCandidate[];
}

/** Judgments over the prompt about to be rebuilt for a model whose cache is cold. */
export interface ContextTrimSignals {
	/** Probability, per candidate id, that the upcoming work needs the record's full content. */
	keep: Record<string, number>;
	action: "shake" | "compact" | "nothing";
	actionConfidence: number;
	/** Probability the upcoming request alone is enough to start from. */
	handoffSufficient: number;
}

export interface StopAssessment {
	kind: "complete" | "partial" | "question" | "blocked" | "waiting" | "uncertain";
	confidence: number;
	goalSatisfied: number;
	blockerExternal: number;
	needsUserDecision: number;
	model: string;
}

export interface StopAssessmentInput {
	objective: string;
	latestRequest: string;
	priorRequests: string[];
	candidate: string;
	evidence: Array<{
		callId: string;
		tool: string;
		target?: string;
		isError: boolean;
		exitCode?: number;
		status?: string;
	}>;
	openTodos: string[];
	goal?: { objective: string; status: string };
	mode: { plan: boolean; duo?: string };
	omitted: boolean;
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
