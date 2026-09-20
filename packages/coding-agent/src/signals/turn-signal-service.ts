import { $env, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { validateChoice } from "../jev/systemone";
import stopKindPrompt from "../prompts/jev/stop-kind.md" with { type: "text" };
import stopCompletePrompt from "../prompts/jev/stop-complete.md" with { type: "text" };
import stopBlockerPrompt from "../prompts/jev/stop-blocker.md" with { type: "text" };
import stopDecisionPrompt from "../prompts/jev/stop-decision.md" with { type: "text" };
import contextTrimQuestions from "./questions/context-trim.json";
import handoffQuestions from "./questions/handoff.json";
import learningQuestions from "./questions/learning.json";
import promptQuestions from "./questions/prompt.json";
import topicQuestions from "./questions/topic.json";
import turnQuestions from "./questions/turn.json";
import { TypeSafeClient } from "./typesafe-client";
import {
	type Answer,
	type ContextTrimInput,
	type ContextTrimSignals,
	type HandoffSignals,
	isWorkPhase,
	isPromptDifficulty,
	type LearningSignals,
	type PromptSignals,
	type Question,
	type StopAssessment,
	type StopAssessmentInput,
	type TopicSignals,
	type TurnSignals,
} from "./types";

/** API state cap is 32k tokens (state + longest question); keep a margin. */
export const DEFAULT_MAX_STATE_CHARS = 80_000;

/** Consecutive unusable responses before the session stops calling the endpoint. */
const FAILURE_BUDGET = 3;

const TURN_QUESTIONS = { ...turnQuestions, ...promptQuestions } as Record<string, Question>;
const HANDOFF_QUESTIONS = handoffQuestions as Record<string, Question>;
const LEARNING_QUESTIONS = learningQuestions as Record<string, Question>;
const TOPIC_QUESTIONS = topicQuestions as Record<string, Question>;
const PROMPT_QUESTIONS = promptQuestions as Record<string, Question>;
const CONTEXT_TRIM_QUESTIONS = contextTrimQuestions as Record<string, Question> & { keep: Question };

/** Candidate summaries are clipped so a large candidate set stays inside the state cap. */
const CONTEXT_TRIM_SUMMARY_CHARS = 300;
const CONTEXT_TRIM_ACTIONS: Record<string, true> = { shake: true, compact: true, nothing: true };

function isContextTrimAction(value: string): value is ContextTrimSignals["action"] {
	return CONTEXT_TRIM_ACTIONS[value] === true;
}

function noul(answer: Answer | undefined): number | undefined {
	return answer?.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : undefined;
}
type PromptThinking = "medium" | "high" | "xhigh";

const PROMPT_THINKING: Record<PromptThinking, true> = { medium: true, high: true, xhigh: true };

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function hasValidProbabilities(value: unknown): value is Record<string, number> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const probabilities = value as Record<string, unknown>;
	const values = Object.values(probabilities);
	return values.length > 0 && values.every(isProbability);
}

function isPromptThinking(value: unknown): value is PromptThinking {
	return typeof value === "string" && PROMPT_THINKING[value as PromptThinking] === true;
}

function parsePromptSignals(answers: Record<string, Answer>): PromptSignals | undefined {
	const difficulty = answers.difficulty;
	const thinking = answers.thinking;
	const risk = answers.risk_domain;
	if (
		difficulty?.type !== "choice" ||
		!isPromptDifficulty(difficulty.choice) ||
		!isProbability(difficulty.confidence) ||
		!hasValidProbabilities(difficulty.probabilities) ||
		thinking?.type !== "choice" ||
		!isPromptThinking(thinking.choice) ||
		!isProbability(thinking.confidence) ||
		!hasValidProbabilities(thinking.probabilities) ||
		risk?.type !== "noul" ||
		!isProbability(risk.noul)
	) {
		return undefined;
	}
	return {
		difficulty: difficulty.choice,
		difficultyConfidence: difficulty.confidence,
		thinking: thinking.choice,
		risk: risk.noul,
	};
}

/** Maps a Score answer onto 0..1 across its levels (first level 0, last level 1). */
function normalizedScore(answer: Answer | undefined): number | undefined {
	if (answer?.type !== "score" || !Number.isFinite(answer.score)) return undefined;
	const levels = Object.keys(answer.legend).length;
	if (levels < 2) return undefined;
	return Math.min(1, Math.max(0, answer.score / (levels - 1)));
}

/**
 * Runs the typed judgments the session consumes (advisor gate, duo phase,
 * stuck, handoff scope, learning gate). Every method resolves `undefined`
 * when the API is unavailable so consumers keep their prior behavior.
 */
export class TurnSignalService {
	readonly #client: TypeSafeClient;
	readonly #maxStateChars: number;
	#latest: TurnSignals | undefined;
	#inFlight: Promise<TurnSignals | undefined> | undefined;
	#promptState: { request: string; prior_context?: string } | undefined;
	#requestGeneration = 0;
	#turnSequence = 0;
	#failures = 0;
	#unavailable = false;

	constructor(client: TypeSafeClient, options: { maxStateChars?: number } = {}) {
		this.#client = client;
		this.#maxStateChars = options.maxStateChars ?? DEFAULT_MAX_STATE_CHARS;
	}

	/** Last successfully classified turn. */
	get latest(): TurnSignals | undefined {
		return this.#latest;
	}

	/** False once this session spent its failure budget; derived UI must not show a stale classification. */
	get connected(): boolean {
		return !this.#unavailable;
	}

	/** `latest` once any in-flight turn classification has resolved (bounded by the client timeout). */
	async settled(): Promise<TurnSignals | undefined> {
		await this.#inFlight;
		return this.#latest;
	}

	#clip(text: string, maxChars = this.#maxStateChars): string {
		return text.length <= maxChars ? text : text.slice(text.length - maxChars);
	}

	/** A dead or unreachable endpoint must not cost every turn the request timeout. */
	#record(ok: boolean): void {
		if (ok) {
			this.#failures = 0;
			return;
		}
		this.#failures += 1;
		if (this.#failures >= FAILURE_BUDGET && !this.#unavailable) {
			this.#unavailable = true;
			logger.debug("turn signals disabled for this session", { failures: this.#failures });
		}
	}

	/** Malformed or unavailable judgments never become an approval. */
	async judgeStop(input: StopAssessmentInput, signal?: AbortSignal): Promise<StopAssessment | undefined> {
		if (this.#unavailable || signal?.aborted) return undefined;
		let omitted = input.omitted;
		const clip = (text: string, limit: number): string => {
			if (text.length <= limit) return text;
			omitted = true;
			return text.slice(0, limit);
		};
		const state = {
			objective: clip(input.objective, 4000),
			latestRequest: clip(input.latestRequest, 4000),
			priorRequests: clip(input.priorRequests.slice(-4).join("\n\n"), 4000),
			candidate: clip(input.candidate, 6000),
			evidence: input.evidence.slice(-16).map(item => ({
				callId: clip(item.callId, 80),
				tool: clip(item.tool, 80),
				target: item.target === undefined ? undefined : clip(item.target, 160),
				isError: item.isError,
				exitCode: item.exitCode,
				status: item.status === undefined ? undefined : clip(item.status, 40),
			})),
			openTodos: input.openTodos.slice(0, 16).map(item => clip(item, 120)),
			omittedTodos: Math.max(0, input.openTodos.length - 16),
			goal: input.goal ? { objective: clip(input.goal.objective, 1000), status: input.goal.status } : undefined,
			mode: input.mode,
			omitted:
				omitted || input.openTodos.length > 16 || input.evidence.length > 16 || input.priorRequests.length > 4,
		};
		// The controller must audit against full context, not trust a judgment over
		// omitted constraints. JSON escaping can also exceed the total state bound.
		if (state.omitted || JSON.stringify(state).length > 24000) return undefined;
		const response = await this.#client.systemOne(
			state,
			{
				stop_kind: {
					type: "choice",
					instructions: stopKindPrompt,
					criteria: {
						complete: null,
						partial: null,
						question: null,
						blocked: null,
						waiting: null,
						uncertain: null,
					},
				},
				goal_satisfied: { type: "noul", instructions: stopCompletePrompt },
				blocker_external: { type: "noul", instructions: stopBlockerPrompt },
				needs_user_decision: { type: "noul", instructions: stopDecisionPrompt },
			},
			signal,
		);
		const kind = response?.answers.stop_kind;
		const satisfied = noul(response?.answers.goal_satisfied);
		const external = noul(response?.answers.blocker_external);
		const decision = noul(response?.answers.needs_user_decision);
		const probability = (value: number | undefined): value is number =>
			value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
		if (!response) {
			if (!signal?.aborted) this.#record(false);
			return undefined;
		}
		if (
			kind?.type !== "choice" ||
			!["complete", "partial", "question", "blocked", "waiting", "uncertain"].includes(kind.choice) ||
			!probability(kind.confidence) ||
			!probability(satisfied) ||
			!probability(external) ||
			!probability(decision)
		) {
			this.#record(false);
			return undefined;
		}
		try {
			validateChoice(kind, ["complete", "partial", "question", "blocked", "waiting", "uncertain"]);
		} catch {
			this.#record(false);
			return undefined;
		}
		this.#record(true);
		return {
			kind: kind.choice as StopAssessment["kind"],
			confidence: kind.confidence,
			goalSatisfied: satisfied,
			blockerExternal: external,
			needsUserDecision: decision,
			model: response.model,
		};
	}

	classifyTurn(
		deltaText: string,
		context: { wip: boolean; duoPhase?: string },
		signal?: AbortSignal,
	): Promise<TurnSignals | undefined> {
		const generation = this.#requestGeneration;
		const sequence = ++this.#turnSequence;
		const run = this.#classifyTurn(deltaText, context, signal, generation, sequence);
		this.#inFlight = run;
		return run;
	}

	async #classifyTurn(
		deltaText: string,
		context: { wip: boolean; duoPhase?: string },
		signal: AbortSignal | undefined,
		generation: number,
		sequence: number,
	): Promise<TurnSignals | undefined> {
		if (this.#unavailable) return undefined;
		const contextChars = (this.#promptState?.request.length ?? 0) + (this.#promptState?.prior_context?.length ?? 0);
		const state = {
			turn_status: context.wip
				? "in progress: the agent will keep working after this slice"
				: "turn ended: the agent yielded",
			...(context.duoPhase ? { duo_phase: context.duoPhase } : {}),
			transcript: this.#clip(deltaText, this.#maxStateChars - contextChars),
			...this.#promptState,
		};
		const response = await this.#client.systemOne(state, TURN_QUESTIONS, signal);
		if (generation !== this.#requestGeneration || sequence !== this.#turnSequence) return undefined;
		this.#record(response !== undefined);
		if (!response) return undefined;
		const phaseAnswer = response.answers.phase;
		const needsReview = noul(response.answers.needs_review);
		const stuck = normalizedScore(response.answers.progress);
		const doneWithoutEvidence = noul(response.answers.done_without_evidence);
		const parallelSlices = noul(response.answers.parallel_slices);
		const openEndedDiscovery = noul(response.answers.open_ended_discovery);
		if (
			phaseAnswer?.type !== "choice" ||
			!isWorkPhase(phaseAnswer.choice) ||
			!isProbability(phaseAnswer.confidence) ||
			needsReview === undefined ||
			stuck === undefined ||
			doneWithoutEvidence === undefined ||
			parallelSlices === undefined
		) {
			return undefined;
		}
		const routing = parsePromptSignals(response.answers);
		const signals: TurnSignals = {
			phase: phaseAnswer.choice,
			phaseConfidence: phaseAnswer.confidence,
			needsReview,
			stuck,
			doneWithoutEvidence,
			parallelSlices,
			...(openEndedDiscovery === undefined ? {} : { openEndedDiscovery }),
			...(routing === undefined ? {} : { routing }),
			model: response.model,
			inputTokens: response.usage.input_tokens,
		};
		this.#latest = signals;
		logger.debug("turn signals", { ...signals, wip: context.wip });
		return signals;
	}

	async classifyHandoff(planText: string, signal?: AbortSignal): Promise<HandoffSignals | undefined> {
		if (this.#unavailable) return undefined;
		const response = await this.#client.systemOne(this.#clip(planText), HANDOFF_QUESTIONS, signal);
		this.#record(response !== undefined);
		if (!response) return undefined;
		const scope = response.answers.scope;
		const planLocked = noul(response.answers.plan_locked);
		if (
			scope?.type !== "choice" ||
			(scope.choice !== "single" && scope.choice !== "multi") ||
			planLocked === undefined
		) {
			return undefined;
		}
		return { scope: scope.choice, scopeConfidence: scope.confidence, planLocked };
	}

	async classifyLearning(content: string, signal?: AbortSignal): Promise<LearningSignals | undefined> {
		if (this.#unavailable) return undefined;
		const response = await this.#client.systemOne(this.#clip(content), LEARNING_QUESTIONS, signal);
		this.#record(response !== undefined);
		const genericRule = noul(response?.answers.generic_rule);
		return genericRule === undefined ? undefined : { genericRule };
	}

	/**
	 * Judge a new user request against a digest of the session's prior context
	 * (idle topic-switch compaction). One noul question over the digest — never
	 * the full transcript — so the pre-prompt round trip stays cheap.
	 */
	async classifyTopicSwitch(
		priorContext: string,
		request: string,
		signal?: AbortSignal,
	): Promise<TopicSignals | undefined> {
		if (this.#unavailable) return undefined;
		const state = { prior_context: this.#clip(priorContext), new_request: this.#clip(request) };
		const response = await this.#client.systemOne(state, TOPIC_QUESTIONS, signal);
		this.#record(response !== undefined);
		const topicSwitch = noul(response?.answers.topic_switch);
		return topicSwitch === undefined ? undefined : { topicSwitch };
	}

	/**
	 * Judge a new user request before any work starts: how hard it is and
	 * whether it touches a risk domain. Runs on the prompt (plus an optional
	 * short digest of prior context), never the transcript, so it can gate the
	 * turn start with a tight timeout.
	 */
	async classifyPrompt(
		request: string,
		priorContext: string | undefined,
		signal?: AbortSignal,
	): Promise<PromptSignals | undefined> {
		const generation = ++this.#requestGeneration;
		this.#latest = undefined;
		this.#inFlight = undefined;
		this.#promptState = {
			request: this.#clip(request, Math.floor(this.#maxStateChars / 4)),
			...(priorContext === undefined
				? {}
				: { prior_context: this.#clip(priorContext, Math.floor(this.#maxStateChars / 4)) }),
		};
		if (this.#unavailable) return undefined;
		const response = await this.#client.systemOne(this.#promptState, PROMPT_QUESTIONS, signal);
		if (generation !== this.#requestGeneration) return undefined;
		this.#record(response !== undefined);
		if (!response) return undefined;
		return parsePromptSignals(response.answers);
	}

	/**
	 * Judge what the prompt about to be rebuilt for a cold-cache model still
	 * needs: one noul per candidate record plus the overall treatment. One
	 * request; the per-record questions fan out in parallel server-side.
	 * `keep` only carries ids the model answered, so callers treat a missing id
	 * as "no verdict" rather than "drop".
	 */
	async classifyContextTrim(input: ContextTrimInput, signal?: AbortSignal): Promise<ContextTrimSignals | undefined> {
		if (this.#unavailable || input.candidates.length === 0) return undefined;
		const candidates = input.candidates.map(candidate => ({
			id: candidate.id,
			kind: candidate.kind,
			age_turns: candidate.ageTurns,
			tokens: candidate.tokens,
			summary: candidate.summary.slice(0, CONTEXT_TRIM_SUMMARY_CHARS),
		}));
		const state = {
			upcoming_request: this.#clip(input.upcomingRequest),
			session_digest: this.#clip(input.sessionDigest),
			context_tokens: input.contextTokens,
			candidates,
		};
		const questions: Record<string, Question> = {
			action: CONTEXT_TRIM_QUESTIONS.action,
			handoff_sufficient: CONTEXT_TRIM_QUESTIONS.handoff_sufficient,
		};
		const keepTemplate = CONTEXT_TRIM_QUESTIONS.keep;
		for (const candidate of candidates) {
			questions[`keep:${candidate.id}`] = {
				...keepTemplate,
				instructions: keepTemplate.instructions.replaceAll("{{id}}", candidate.id),
			};
		}
		const response = await this.#client.systemOne(state, questions, signal);
		this.#record(response !== undefined);
		if (!response) return undefined;
		const action = response.answers.action;
		const handoffSufficient = noul(response.answers.handoff_sufficient);
		if (action?.type !== "choice" || !isContextTrimAction(action.choice) || handoffSufficient === undefined) {
			return undefined;
		}
		const keep: Record<string, number> = {};
		for (const candidate of candidates) {
			const value = noul(response.answers[`keep:${candidate.id}`]);
			if (value !== undefined) keep[candidate.id] = value;
		}
		return {
			keep,
			action: action.choice,
			actionConfidence: action.confidence,
			handoffSufficient,
		};
	}
}

/** Resolves the TypeSafe key: environment first, then the settings credential. */
export function resolveTypeSafeApiKey(settings: Settings): string | undefined {
	const fromEnv = $env.TYPESAFE_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	const fromSettings = settings.get("signals.apiKey")?.trim();
	return fromSettings || undefined;
}

/** Builds the service when signals are enabled and a key exists; otherwise `undefined`. */
export function createTurnSignalService(
	settings: Settings,
	options: { fetch?: typeof fetch; redact?: (text: string) => string } = {},
): TurnSignalService | undefined {
	if (!settings.get("signals.enabled")) return undefined;
	const apiKey = resolveTypeSafeApiKey(settings);
	if ($env.TYPESAFE_SYSTEMONE_URL !== undefined && !$env.TYPESAFE_SYSTEMONE_URL.trim()) return undefined;
	const baseUrl = ($env.TYPESAFE_SYSTEMONE_URL?.trim() || settings.get("signals.baseUrl") || "").trim();
	if (!apiKey && !baseUrl) return undefined;
	const client = new TypeSafeClient({
		apiKey,
		baseUrl: baseUrl || undefined,
		model: settings.get("signals.model"),
		timeoutMs: settings.get("signals.timeoutMs"),
		fetch: options.fetch,
		redact: options.redact,
	});
	return new TurnSignalService(client);
}
