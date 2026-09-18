import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import changePhaseDescription from "../prompts/tools/duo-change-phase.md" with { type: "text" };
import { isWorkPhase, type WorkPhase } from "../signals/types";
import { ToolError } from "../tools/tool-errors";

const changePhaseSchema = type({
	phase: type(
		"'preplanning' | 'planning' | 'implementing' | 'verifying' | 'debugging' | 'blocked' | 'reporting'",
	).describe("Work phase to move the duo session into; its configured phase model takes the main stream."),
	"reason?": type("string").describe(
		"One-line rationale for the switch, shown to the user (what changed in the shape of the work).",
	),
});

type DuoChangePhaseParams = typeof changePhaseSchema.infer;

/** Outcome of a model-requested phase change; `unavailable` means no live duo controller accepted it. */
export type DuoChangePhaseResult = "ok" | "unavailable" | "switch-failed";

export class DuoChangePhaseTool implements AgentTool<typeof changePhaseSchema, undefined> {
	readonly name = "duo_change_phase";
	readonly label = "Duo change phase";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = changePhaseSchema;

	constructor(
		private readonly requestPhaseChange: (phase: WorkPhase, reason?: string) => Promise<DuoChangePhaseResult>,
	) {
		this.description = prompt.render(changePhaseDescription);
	}

	async execute(
		_toolCallId: string,
		args: DuoChangePhaseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		if (!isWorkPhase(args.phase)) {
			throw new ToolError(`duo_change_phase: unknown work phase ${String(args.phase)}.`);
		}
		const result = await this.requestPhaseChange(args.phase, args.reason);
		if (result === "unavailable") {
			throw new ToolError("duo_change_phase is only available while a duo controller is driving the session.");
		}
		if (result === "switch-failed") {
			throw new ToolError("duo_change_phase failed: could not switch the main-stream model (see logs).");
		}
		return {
			content: [
				{
					type: "text",
					text: `Phase changed to ${args.phase}; its configured model now holds the main stream.`,
				},
			],
		};
	}
}
