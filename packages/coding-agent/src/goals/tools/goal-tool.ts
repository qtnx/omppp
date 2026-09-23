import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { prompt } from "@oh-my-pi/pi-utils";

import createGoalDescription from "../../prompts/tools/create-goal.md" with { type: "text" };
import getGoalDescription from "../../prompts/tools/get-goal.md" with { type: "text" };
import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import updateGoalDescription from "../../prompts/tools/update-goal.md" with { type: "text" };

import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

import type { ToolSession } from "../../tools";

import type { Goal, GoalToolDetails } from "@oh-my-pi/pi-tui/tools/goal";

import { completionBudgetReport, type GoalRuntime, remainingTokens } from "../runtime";

const getGoalSchema = type({});

const createGoalSchema = type({
	objective: type("string").describe("Required. The concrete objective to start pursuing."),
	"token_budget?": type("number.integer").describe(
		"Positive token budget for the new goal. Omit unless explicitly requested.",
	),
});

const updateGoalSchema = type({
	status: type("'complete' | 'blocked'").describe(
		"Required. Set to complete only when achieved; set to blocked only after the same blocker repeats for at least three consecutive goal turns.",
	),
});

const goalSchema = type({
	op: type("'create' | 'get' | 'complete' | 'resume' | 'drop'").describe("goal operation"),
	"objective?": type("string").describe("goal objective"),
	"token_budget?": type("number.integer").describe("token budget"),
});

export type GetGoalToolInput = typeof getGoalSchema.infer;
export type CreateGoalToolInput = typeof createGoalSchema.infer;
export type UpdateGoalToolInput = typeof updateGoalSchema.infer;
export type GoalToolInput = typeof goalSchema.infer;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null,
	};
}

function validateCreateParams(params: GoalToolInput): { objective: string; tokenBudget?: number } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new ToolError("objective is required when op=create");
	}
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer when provided");
	}
	return { objective, tokenBudget };
}

function requireGoalRuntime(session: ToolSession): GoalRuntime {
	const runtime = session.getGoalRuntime?.();
	if (!runtime) {
		throw new ToolError("Goal mode is not active.");
	}
	return runtime;
}

function buildGoalToolText(response: GoalToolResponse): string {
	if (!response.goal) {
		return "No active goal.";
	}
	let text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
	if (response.goal.tokenBudget !== undefined) {
		text += ` / ${response.goal.tokenBudget} budget`;
	}
	if (response.remainingTokens !== null) {
		text += `\nRemaining tokens: ${response.remainingTokens}`;
	}
	if (response.completionBudgetReport) {
		text += `\n\n${response.completionBudgetReport}`;
	}
	return text;
}

function buildGoalToolResult(op: GoalToolDetails["op"], response: GoalToolResponse): AgentToolResult<GoalToolDetails> {
	return {
		content: [{ type: "text", text: buildGoalToolText(response) }],
		details: {
			op,
			goal: response.goal,
			remainingTokens: response.remainingTokens,
			completionBudgetReport: response.completionBudgetReport,
		},
	};
}

export class GetGoalTool implements AgentTool<typeof getGoalSchema, GoalToolDetails> {
	readonly name = "get_goal";
	readonly label = "Get Goal";
	readonly description = prompt.render(getGoalDescription);
	readonly parameters = getGoalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		_params: GetGoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const state = this.#session.getGoalModeState?.();
		return buildGoalToolResult("get", buildGoalToolResponse(state?.goal ?? null));
	}
}

export class CreateGoalTool implements AgentTool<typeof createGoalSchema, GoalToolDetails> {
	readonly name = "create_goal";
	readonly label = "Create Goal";
	readonly description = prompt.render(createGoalDescription);
	readonly parameters = createGoalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: CreateGoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = requireGoalRuntime(this.#session);
		const created = await runtime.createGoal({
			objective: params.objective,
			tokenBudget: params.token_budget,
		});
		return buildGoalToolResult("create", buildGoalToolResponse(created.goal));
	}
}

export class UpdateGoalTool implements AgentTool<typeof updateGoalSchema, GoalToolDetails> {
	readonly name = "update_goal";
	readonly label = "Update Goal";
	readonly description = prompt.render(updateGoalDescription);
	readonly parameters = updateGoalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: UpdateGoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = requireGoalRuntime(this.#session);
		const updated = await runtime.updateGoalStatusFromTool(params);
		return buildGoalToolResult(
			params.status === "complete" ? "complete" : "block",
			buildGoalToolResponse(updated, { includeCompletionReport: params.status === "complete" }),
		);
	}
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	readonly label = "Goal";
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = requireGoalRuntime(this.#session);

		let response: GoalToolResponse;
		const op: GoalToolDetails["op"] = params.op;
		if (params.op === "create") {
			const created = await runtime.createGoal(validateCreateParams(params));
			response = buildGoalToolResponse(created.goal);
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null);
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal);
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null);
		} else {
			const completed = await runtime.completeGoalFromTool();
			response = buildGoalToolResponse(completed, { includeCompletionReport: true });
		}
		return buildGoalToolResult(op, response);
	}
}
