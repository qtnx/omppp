import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { GoalModeState } from "../goals/state";
import continuePrompt from "../prompts/session/completion-continue.md" with { type: "text" };
import auditPrompt from "../prompts/session/completion-audit.md" with { type: "text" };
import type { StopAssessment, StopAssessmentInput, TurnSignalService } from "../signals";
import type { SessionManager } from "./session-manager";

export interface SessionCompletionHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	signals(): TurnSignalService | undefined;
	generation(): number;
	signal(): AbortSignal;
	/** Includes cancellation, queued user control, handoff, mode and resource guards. */
	canContinue(): boolean;
	openTodos(): string[];
	goal(): GoalModeState | undefined;
	mode(): StopAssessmentInput["mode"];
	schedule(options: { generation: number; shouldContinue: () => boolean }): void;
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** Owns only stop assessment; the session remains the sole continuation/lifecycle owner. */
export class SessionCompletion {
	readonly #host: SessionCompletionHost;
	#sessionId = "";
	#generation: number;
	#objective = "";
	#requests: Array<{ key: string; text: string }> = [];
	/** Audited stop keys. Keyed, not a flag: re-observing history must not refund an audit. */
	#audited = new Set<string>();
	#complete = false;
	#progress = "";
	#noProgress = 0;
	#revision = 0;
	#assessment: { key: string; promise: Promise<StopAssessment | undefined> } | undefined;
	#settle: { message: AssistantMessage; promise: Promise<boolean> } | undefined;

	constructor(host: SessionCompletionHost) {
		this.#host = host;
		this.#generation = host.generation();
		for (const entry of host.sessionManager.getBranch()) if (entry.type === "message") this.observe(entry.message);
	}

	observe(message: AgentMessage): void {
		const id = this.#host.sessionManager.getSessionId();
		if (id !== this.#sessionId) {
			this.#sessionId = id;
			this.#objective = "";
			this.#requests = [];
			this.#complete = false;
			this.#audited.clear();
			this.#assessment = undefined;
			this.#progress = "";
			this.#noProgress = 0;
		}
		if (message.role !== "user" || message.attribution === "agent") return;
		const text = textOf(message);
		const key = `${message.timestamp}:${Bun.hash(text)}`;
		if (this.#requests.some(request => request.key === key)) return;
		if (!this.#objective || this.#complete) this.#objective = text;
		this.#requests.push({ key, text });
		if (this.#requests.length > 5) this.#requests.shift();
		// A new request bumps #revision, so its stop keys are new and unaudited.
		this.#complete = false;
		this.#revision++;
		this.#assessment = undefined;
	}

	check(final: AssistantMessage): Promise<boolean> {
		if (this.#settle?.message === final) return this.#settle.promise;
		const promise = this.#check(final);
		this.#settle = { message: final, promise };
		return promise;
	}

	async #check(final: AssistantMessage): Promise<boolean> {
		const host = this.#host;
		if (!host.settings.get("autonomy.stopGate") || !host.canContinue() || final.stopReason !== "stop") return false;
		if (this.#generation !== host.generation()) {
			this.#generation = host.generation();
			this.#sessionId = "";
			this.#requests = [];
			this.#settle = undefined;
		}
		// Recover from persisted branch on first use; thereafter observe genuine messages
		// at persistence time so compaction cannot replace the original objective.
		if (this.#sessionId !== host.sessionManager.getSessionId() || !this.#requests.length) {
			for (const entry of host.sessionManager.getBranch()) if (entry.type === "message") this.observe(entry.message);
			for (const message of host.agent.state.messages) this.observe(message);
		}
		const request = this.#requests.at(-1);
		if (!request) return false;
		const generation = host.generation();
		const revision = this.#revision;
		const signal = host.signal();
		const mode = host.mode();
		const modeKey = JSON.stringify(mode);
		const current = () =>
			!signal.aborted &&
			host.canContinue() &&
			host.generation() === generation &&
			this.#revision === revision &&
			JSON.stringify(host.mode()) === modeKey;
		const todos = host.openTodos();
		const goal = host.goal()?.goal;
		const open = [...todos, ...(goal?.status === "active" ? [goal.objective] : [])];
		const outcomes = host.agent.state.messages.filter(message => message.role === "toolResult");
		const calls = new Map<string, { target?: string; fingerprint: string }>();
		for (const message of host.agent.state.messages)
			if (message.role === "assistant") {
				for (const block of message.content)
					if (block.type === "toolCall") {
						const args = block.arguments;
						const target = typeof args.path === "string" ? args.path : undefined;
						calls.set(block.id, { target, fingerprint: String(Bun.hash(JSON.stringify(args))) });
					}
			}
		const evidence: StopAssessmentInput["evidence"] = outcomes.slice(-16).map(result => {
			const details = isRecord(result.details) ? result.details : undefined;
			return {
				callId: result.toolCallId,
				tool: result.toolName,
				isError: result.isError,
				target: calls.get(result.toolCallId)?.target,
				exitCode: typeof details?.exitCode === "number" ? details.exitCode : undefined,
				status: typeof details?.status === "string" ? details.status : undefined,
			};
		});
		// Content fingerprints stay local. Distinct call ids or timestamps alone are not progress.
		const effects = new Set(
			outcomes.map(
				result =>
					`${result.toolName}:${calls.get(result.toolCallId)?.fingerprint}:${result.isError}:${Bun.hash(JSON.stringify(result.content))}`,
			),
		);
		const progress = String(Bun.hash(JSON.stringify([[...effects].sort(), open, goal?.status])));
		this.#noProgress = progress === this.#progress ? this.#noProgress + 1 : 0;
		this.#progress = progress;
		const candidate = textOf(final).replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, "");
		const input: StopAssessmentInput = {
			objective: this.#objective,
			latestRequest: request.text,
			priorRequests: this.#requests.slice(0, -1).map(item => item.text),
			candidate,
			evidence,
			openTodos: todos,
			goal: goal && { objective: goal.objective, status: goal.status },
			mode,
			omitted:
				outcomes.length > 16 ||
				candidate.length > 6000 ||
				this.#objective.length > 4000 ||
				request.text.length > 4000,
		};
		const service = host.signals();
		// Without classification this gate is inert: the existing todo, plan, QA and
		// empty-stop machinery keeps owning the turn, and no extra model turn is spent.
		if (!service) return false;
		const key = `${this.#sessionId}:${generation}:${revision}:${Bun.hash(candidate)}:${progress}`;
		if (this.#assessment?.key !== key) this.#assessment = { key, promise: service.judgeStop(input, signal) };
		const started = Date.now();
		const assessment = await this.#assessment.promise;
		// No judgment — outage, malformed answer, or context clipped before sending —
		// leaves the turn exactly as it was. It never becomes approval, and it never
		// spends a model turn on an audit the classifier did not ask for.
		if (!assessment) return false;
		if (!current()) return false;
		// Local obligations may change while the request is in flight; a stale answer cannot close them.
		const currentGoal = host.goal()?.goal;
		const currentOpen = [...host.openTodos(), ...(currentGoal?.status === "active" ? [currentGoal.objective] : [])];
		let audit = false;
		let resume = false;
		const trusted = assessment.confidence >= 0.8 && !input.omitted;
		if (assessment.needsUserDecision >= 0.8) return false;
		if (trusted && assessment.kind === "complete" && assessment.goalSatisfied >= 0.8 && !currentOpen.length) {
			this.#complete = true;
			return false;
		}
		if (trusted && assessment.blockerExternal <= 0.2 && assessment.needsUserDecision <= 0.2) {
			resume =
				currentOpen.length > 0 ||
				(["partial", "question"].includes(assessment.kind) && assessment.goalSatisfied <= 0.2) ||
				assessment.kind === "blocked";
		}
		// An audit costs a model turn, so one request gets at most one: it is spent on an
		// answer that arrived but cannot be trusted.
		const auditKey = `${this.#sessionId}:${generation}:${revision}`;
		if (!resume && !this.#audited.has(auditKey)) {
			audit = true;
			resume = true;
		}
		// Known open work is never erased by a complete verdict or an exhausted audit allowance.
		if (!resume && currentOpen.length) resume = true;
		if (!resume) return false;
		if (audit) this.#audited.add(auditKey);
		const reminder: Message = {
			role: "developer",
			attribution: "agent",
			timestamp: Date.now(),
			content: [
				{
					type: "text",
					text: prompt.render(audit ? auditPrompt : continuePrompt, {
						request: request.text,
						objective: this.#objective,
						openItems: currentOpen,
						candidate,
						stage: this.#noProgress >= 2 ? "change-strategy" : "next-action",
						planOnly: mode.plan,
					}),
				},
			],
		};
		host.agent.appendMessage(reminder);
		host.sessionManager.appendMessage(reminder);
		host.schedule({ generation, shouldContinue: current });
		logger.debug("completion gate", {
			generation,
			audit,
			omitted: input.omitted,
			noProgress: this.#noProgress,
			latencyMs: Date.now() - started,
		});
		return true;
	}
}
