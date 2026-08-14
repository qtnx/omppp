import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import effortDescription from "../prompts/tools/advisor-set-executor-effort.md" with { type: "text" };
import { ToolError } from "../tools/tool-errors";

const effortSchema = type({
	level: type("'high' | 'xhigh' | 'max'").describe("Executor thinking level to enforce; never lower than high."),
	reason: type("string").describe("Evidence-backed reason for changing executor effort."),
});

const ALLOWED_EXECUTOR_EFFORTS: Readonly<Record<"high" | "xhigh" | "max", true>> = {
	[ThinkingLevel.High]: true,
	[ThinkingLevel.XHigh]: true,
	[ThinkingLevel.Max]: true,
};

type SetExecutorEffortParams = typeof effortSchema.infer;

export class SetExecutorEffortTool implements AgentTool<typeof effortSchema, undefined> {
	readonly name = "set_executor_effort";
	readonly label = "Set executor effort";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = effortSchema;

	constructor(private readonly setExecutorEffort: (level: ThinkingLevel, reason: string) => boolean) {
		this.description = prompt.render(effortDescription);
	}

	async execute(
		_toolCallId: string,
		args: SetExecutorEffortParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const level = args.level as ThinkingLevel;
		// Product policy: advisor may raise or normalize to high, but never lower executor effort.
		if (ALLOWED_EXECUTOR_EFFORTS[level as keyof typeof ALLOWED_EXECUTOR_EFFORTS] !== true) {
			throw new ToolError("set_executor_effort only accepts high, xhigh, or max.");
		}
		if (!this.setExecutorEffort(level, args.reason)) {
			throw new ToolError("set_executor_effort failed: duo controller rejected the executor effort override.");
		}
		return {
			content: [{ type: "text", text: `Executor effort override set to ${level}.` }],
			useless: true,
		};
	}
}
