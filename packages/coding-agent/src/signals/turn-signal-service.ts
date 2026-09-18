import { $env, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import handoffQuestions from "./questions/handoff.json";
import learningQuestions from "./questions/learning.json";
import turnQuestions from "./questions/turn.json";
import { TypeSafeClient } from "./typesafe-client";
import {
	type Answer,
	type HandoffSignals,
	isWorkPhase,
	type LearningSignals,
	type Question,
	type TurnSignals,
} from "./types";

/** API state cap is 32k tokens (state + longest question); keep a margin. */
export const DEFAULT_MAX_STATE_CHARS = 80_000;

const TURN_QUESTIONS = turnQuestions as Record<string, Question>;
const HANDOFF_QUESTIONS = handoffQuestions as Record<string, Question>;
const LEARNING_QUESTIONS = learningQuestions as Record<string, Question>;

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

	constructor(client: TypeSafeClient, options: { maxStateChars?: number } = {}) {
		this.#client = client;
		this.#maxStateChars = options.maxStateChars ?? DEFAULT_MAX_STATE_CHARS;
	}

	/** Last successfully classified turn. */
	get latest(): TurnSignals | undefined {
		return this.#latest;
	}

	/** `latest` once any in-flight turn classification has resolved (bounded by the client timeout). */
	async settled(): Promise<TurnSignals | undefined> {
		await this.#inFlight;
		return this.#latest;
	}

	#clip(text: string): string {
		return text.length <= this.#maxStateChars ? text : text.slice(text.length - this.#maxStateChars);
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
		const state = {
			turn_status: context.wip
				? "in progress: the agent will keep working after this slice"
				: "turn ended: the agent yielded",
			...(context.duoPhase ? { duo_phase: context.duoPhase } : {}),
			transcript: this.#clip(deltaText),
		};
		const response = await this.#client.systemOne(state, TURN_QUESTIONS, signal);
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
		const response = await this.#client.systemOne(this.#clip(planText), HANDOFF_QUESTIONS, signal);
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
		const response = await this.#client.systemOne(this.#clip(content), LEARNING_QUESTIONS, signal);
		const genericRule = noul(response?.answers.generic_rule);
		return genericRule === undefined ? undefined : { genericRule };
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
