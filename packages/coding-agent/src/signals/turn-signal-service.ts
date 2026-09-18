import { $env, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import contextTrimQuestions from "./questions/context-trim.json";
import handoffQuestions from "./questions/handoff.json";
import learningQuestions from "./questions/learning.json";
import topicQuestions from "./questions/topic.json";
import turnQuestions from "./questions/turn.json";
import { TypeSafeClient } from "./typesafe-client";
import {
	type Answer,
	type ContextTrimInput,
	type ContextTrimSignals,
	type HandoffSignals,
	isWorkPhase,
	type LearningSignals,
	type Question,
	type TopicSignals,
	type TurnSignals,
} from "./types";

/** API state cap is 32k tokens (state + longest question); keep a margin. */
export const DEFAULT_MAX_STATE_CHARS = 80_000;

/** Consecutive unusable responses before the session stops calling the endpoint. */
const FAILURE_BUDGET = 3;

const TURN_QUESTIONS = turnQuestions as Record<string, Question>;
const HANDOFF_QUESTIONS = handoffQuestions as Record<string, Question>;
const LEARNING_QUESTIONS = learningQuestions as Record<string, Question>;
const TOPIC_QUESTIONS = topicQuestions as Record<string, Question>;
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

	#clip(text: string): string {
		return text.length <= this.#maxStateChars ? text : text.slice(text.length - this.#maxStateChars);
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

	classifyTurn(
		deltaText: string,
		context: { wip: boolean; duoPhase?: string },
		signal?: AbortSignal,
	): Promise<TurnSignals | undefined> {
		const run = this.#classifyTurn(deltaText, context, signal);
		this.#inFlight = run;
		return run;
	}

	async #classifyTurn(
		deltaText: string,
		context: { wip: boolean; duoPhase?: string },
		signal?: AbortSignal,
	): Promise<TurnSignals | undefined> {
		if (this.#unavailable) return undefined;
		const state = {
			turn_status: context.wip
				? "in progress: the agent will keep working after this slice"
				: "turn ended: the agent yielded",
			...(context.duoPhase ? { duo_phase: context.duoPhase } : {}),
			transcript: this.#clip(deltaText),
		};
		const response = await this.#client.systemOne(state, TURN_QUESTIONS, signal);
		this.#record(response !== undefined);
		if (!response) return undefined;
		const phaseAnswer = response.answers.phase;
		const needsReview = noul(response.answers.needs_review);
		const stuck = normalizedScore(response.answers.progress);
		const doneWithoutEvidence = noul(response.answers.done_without_evidence);
		const parallelSlices = noul(response.answers.parallel_slices);
		if (
			phaseAnswer?.type !== "choice" ||
			!isWorkPhase(phaseAnswer.choice) ||
			needsReview === undefined ||
			stuck === undefined ||
			doneWithoutEvidence === undefined ||
			parallelSlices === undefined
		) {
			return undefined;
		}
		const signals: TurnSignals = {
			phase: phaseAnswer.choice,
			phaseConfidence: phaseAnswer.confidence,
			needsReview,
			stuck,
			doneWithoutEvidence,
			parallelSlices,
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
	options: { fetch?: typeof fetch } = {},
): TurnSignalService | undefined {
	if (!settings.get("signals.enabled")) return undefined;
	const apiKey = resolveTypeSafeApiKey(settings);
	const baseUrl = ($env.TYPESAFE_SYSTEMONE_URL?.trim() || settings.get("signals.baseUrl") || "").trim();
	if (!apiKey && !baseUrl) return undefined;
	const client = new TypeSafeClient({
		apiKey,
		baseUrl: baseUrl || undefined,
		model: settings.get("signals.model"),
		timeoutMs: settings.get("signals.timeoutMs"),
		fetch: options.fetch,
	});
	return new TurnSignalService(client);
}
