import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import handoffDescription from "../prompts/tools/duo-handoff.md" with { type: "text" };
import type { TurnSignalService } from "../signals/index";
import { ToolError } from "../tools/tool-errors";
import type { DuoHandoffResult } from "./controller";
import type { DuoExecutionScope, TakeoverDecision, TakeoverPurpose } from "./state";

/** Judged scope confidence required before an inferred `multi` scope overrides the single default. */
const INFERRED_MULTI_SCOPE_CONFIDENCE = 0.7;
/** Below this plan-locked probability the brief is reported as unlocked (advisory only, never blocking). */
const UNLOCKED_PLAN_PROBABILITY = 0.35;
const UNLOCKED_BRIEF_NOTE =
	"Note: the brief reads unlocked (files, target behavior, or verification step missing); executor should confirm open decisions before editing.";

const handoffSchema = type({
	to: type("'executor'").describe("The duo executor model."),
	resolution: type("string").describe(
		"Brief for the executor and advisor: what was planned or resolved, current state, and next steps.",
	),
	"scope?": type("'single' | 'multi'").describe(
		"Task scope for the executor: 'single' (default) = executor works directly with full tools; 'multi' = long-running multi-phase implementation with several independent workstreams, executor runs in Safe orchestrator mode and delegates. Omit to keep the current scope.",
	),
});

type DuoHandoffParams = typeof handoffSchema.infer & Record<never, TakeoverPurpose | TakeoverDecision>;

export class DuoHandoffTool implements AgentTool<typeof handoffSchema, undefined> {
	readonly name = "duo_handoff";
	readonly label = "Duo handoff";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = handoffSchema;

	constructor(
		private readonly requestHandoff: (resolution: string, scope?: DuoExecutionScope) => Promise<DuoHandoffResult>,
		private readonly turnSignals?: TurnSignalService,
	) {
		this.description = prompt.render(handoffDescription);
	}

	async execute(
		_toolCallId: string,
		args: DuoHandoffParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		// An explicit scope is the caller's decision and skips classification entirely.
		let scope = args.scope;
		let inferredUnlockedBrief = false;
		if (scope === undefined && this.turnSignals) {
			const judged = await this.turnSignals.classifyHandoff(args.resolution, signal);
			if (judged) {
				if (judged.scope === "multi" && judged.scopeConfidence >= INFERRED_MULTI_SCOPE_CONFIDENCE) {
					scope = "multi";
				}
				inferredUnlockedBrief = judged.planLocked < UNLOCKED_PLAN_PROBABILITY;
			}
		}
		const result = await this.requestHandoff(args.resolution, scope);
		if (result === "no-controller") {
			throw new ToolError("duo_handoff is unavailable: no duo controller is active in this session.");
		}
		if (result === "wrong-phase") {
			throw new ToolError(
				"duo_handoff is unavailable: duo is not in a phase that can hand off (only planning, takeover, executing, or degraded).",
			);
		}
		if (result === "already-executor") {
			throw new ToolError("duo_handoff: the resolved executor already holds the main stream — nothing to hand off.");
		}
		if (result === "switch-failed") {
			throw new ToolError("duo_handoff failed: could not switch the main-stream model (see logs).");
		}
		return {
			content: [
				{
					type: "text",
					text: inferredUnlockedBrief
						? `Handoff to executor scheduled at the next turn boundary.\n${UNLOCKED_BRIEF_NOTE}`
						: "Handoff to executor scheduled at the next turn boundary.",
				},
			],
		};
	}
}
