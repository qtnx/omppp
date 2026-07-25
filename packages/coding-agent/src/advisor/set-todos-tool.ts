import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import setTodosDescription from "../prompts/tools/advisor-set-todos.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { type TodoPhase, type TodoStatus, USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import { ToolError } from "../tools/tool-errors";

const TODO_STATUSES: Record<TodoStatus, true> = {
	pending: true,
	in_progress: true,
	completed: true,
	blocked: true,
	abandoned: true,
};

const setTodosSchema = type({
	phases: type({
		phase: type("string").describe("Non-empty phase name."),
		items: type({
			content: type("string").describe("Non-empty todo item content."),
			status: type("'pending' | 'in_progress' | 'completed' | 'blocked' | 'abandoned'").describe(
				"Todo item status.",
			),
		}).array(),
	}).array(),
});

export type SetTodosParams = typeof setTodosSchema.infer;

interface AdvisorTodoSession extends ToolSession {
	appendCustomEntry?: (customType: string, data?: unknown) => string;
}

function assertTodoStatus(status: string, phaseIndex: number, itemIndex: number): asserts status is TodoStatus {
	if (TODO_STATUSES[status as TodoStatus] !== true) {
		throw new ToolError(
			`phases[${phaseIndex}].items[${itemIndex}].status must be pending, in_progress, completed, blocked, or abandoned.`,
		);
	}
}

function validateAndConvert(phases: SetTodosParams["phases"]): TodoPhase[] {
	if (phases.length === 0) {
		throw new ToolError("set_todos requires at least one phase; clearing todos is not an advisor action.");
	}

	return phases.map((phase, phaseIndex) => {
		const name = phase.phase.trim();
		if (!name) {
			throw new ToolError(`phases[${phaseIndex}].phase must be non-empty.`);
		}
		return {
			name,
			tasks: phase.items.map((item, itemIndex) => {
				const content = item.content.trim();
				if (!content) {
					throw new ToolError(`phases[${phaseIndex}].items[${itemIndex}].content must be non-empty.`);
				}
				assertTodoStatus(item.status, phaseIndex, itemIndex);
				return { content, status: item.status };
			}),
		};
	});
}

function openTodoCount(phases: TodoPhase[]): number {
	return phases.reduce(
		(count, phase) =>
			count + phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress").length,
		0,
	);
}

export class SetTodosTool implements AgentTool<typeof setTodosSchema, undefined> {
	readonly name = "set_todos";
	readonly label = "Set todos";
	readonly description = setTodosDescription;
	readonly parameters = setTodosSchema;
	readonly loadMode = "essential" as const;

	constructor(private readonly session: AdvisorTodoSession) {}

	async execute(
		_toolCallId: string,
		args: SetTodosParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const phases = validateAndConvert(args.phases);
		if (!this.session.setTodoPhases || !this.session.appendCustomEntry) {
			throw new ToolError("set_todos requires session todo and custom-entry persistence support.");
		}

		// Mirror the /todo commit path: update live state and append the durable custom entry for compaction/resume.
		this.session.setTodoPhases(phases);
		this.session.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });

		return {
			content: [{ type: "text", text: `Todos updated: ${phases.length} phases, ${openTodoCount(phases)} open.` }],
		};
	}
}
