import { type BaseType, type } from "@oh-my-pi/omptype";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
	type AgentProgress,
	type AgentSource,
	LABEL_MAX,
	oneLineLabel,
	type SubagentRunTelemetry,
} from "@oh-my-pi/pi-tui/tools/task";
import { $env } from "@oh-my-pi/pi-utils";

import type { AgentSessionEvent } from "../session/agent-session";

// The task types moved to `@oh-my-pi/pi-tui/tools/task` (and the observer
// registry) upstream; this module keeps only the runtime pieces that live in
// the coding agent and re-exports the canonical shapes so existing
// `./task/types` importers keep resolving to the single definition.
export { LABEL_MAX, oneLineLabel, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL };
export type {
	AgentProgress,
	AgentSource,
	NestedRepoPatch,
	ReviewData,
	ReviewFinding,
	ReviewGateIteration,
	ReviewGateOutcome,
	ReviewGateProgress,
	ReviewGateResult,
	ReviewSummary,
	SingleResult,
	StructuredSubagentOutput,
	StructuredSubagentSchemaMode,
	StructuredSubagentSchemaSource,
	StructuredSubagentValidationStatus,
	SubagentAbortReason,
	SubagentRunPhase,
	SubagentRunStatus,
	SubagentRunTelemetry,
	SubagentRunTimings,
	TaskItem,
	TaskParams,
	TaskToolDetails,
	YieldItem,
} from "@oh-my-pi/pi-tui/tools/task";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** Session custom-entry discriminator for persisted subagent runtime telemetry. */
export const SUBAGENT_RUN_CUSTOM_TYPE = "subagent_run";

/** Payload emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
	/** See {@link SubagentLifecyclePayload.detached}. */
	detached?: boolean;
}
/** Payload emitted on TASK_SUBAGENT_EVENT_CHANNEL */
export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

/** Payload emitted on TASK_SUBAGENT_LIFECYCLE_CHANNEL */
export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
	/** Present only on terminal lifecycle events. */
	telemetry?: SubagentRunTelemetry;
	/**
	 * Spawn runs as a detached background job: the parent turn keeps working
	 * while this agent runs. Sync task spawns (parent blocked on the call) and
	 * eval `agent()` bridge spawns (rendered inside their eval cell) leave this
	 * unset — surfaces like the subagent HUD only list detached spawns.
	 */
	detached?: boolean;
}

// Keep this explicit: ArkType serializes `unknown` as a boolean subschema, which llama.cpp grammars reject.
const outputSchemaInputSchema = type("object | boolean | string | null");
// Coarse per-spawn thinking effort; must stay in sync with TASK_EFFORTS in ../thinking.
const effortRule = '"lo" | "med" | "hi"' as const;

export const taskItemSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"model?": "string | string[]",
	"max_runtime_seconds?": "number.integer >= 0",
	"self_review?": "boolean",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"+": "delete",
});
const taskItemSchemaIsolated = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"model?": "string | string[]",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"max_runtime_seconds?": "number.integer >= 0",
	"self_review?": "boolean",
	"+": "delete",
});

export const taskSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"model?": "string | string[]",
	"max_runtime_seconds?": "number.integer >= 0",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"self_review?": "boolean",
	"+": "delete",
});
const taskSchemaNoIsolation = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"model?": "string | string[]",
	"max_runtime_seconds?": "number.integer >= 0",
	"self_review?": "boolean",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"+": "delete",
});
const taskSchemaBatch = type({
	context: "string",
	tasks: taskItemSchemaIsolated.array(),
	"+": "delete",
});
const taskSchemaBatchNoIsolation = type({
	context: "string",
	tasks: taskItemSchema.array(),
	"+": "delete",
});
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema | BaseType;

const TASK_AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const taskSchemaCache = new Map<string, BaseType>();

function taskAgentSchemaRule(defaultAgent: string): string {
	const trimmed = defaultAgent.trim();
	if (TASK_AGENT_NAME_PATTERN.test(trimmed)) {
		return `string = '${trimmed}'`;
	}
	return "string";
}

function createTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent: string;
	effortEnabled: boolean;
	evalToolsEnabled: boolean;
}): BaseType {
	const agent = taskAgentSchemaRule(options.defaultAgent);
	const effortField = options.effortEnabled ? { "effort?": effortRule } : {};
	const toolsField = options.evalToolsEnabled ? { "tools?": "string[]" } : {};
	if (options.batchEnabled) {
		if (options.isolationEnabled) {
			const item = type.raw({
				"name?": "string",
				agent,
				task: "string",
				"model?": "string | string[]",
				...effortField,
				"outputSchema?": outputSchemaInputSchema,
				"schemaMode?": '"permissive" | "strict"',
				...toolsField,
				"isolated?": "boolean",
				"max_runtime_seconds?": "number.integer >= 0",
				"self_review?": "boolean",
				"+": "delete",
			});
			return type.raw({
				context: "string",
				tasks: item.array(),
				"+": "delete",
			});
		}
		const item = type.raw({
			"name?": "string",
			agent,
			task: "string",
			"model?": "string | string[]",
			"max_runtime_seconds?": "number.integer >= 0",
			"self_review?": "boolean",
			...effortField,
			"outputSchema?": outputSchemaInputSchema,
			"schemaMode?": '"permissive" | "strict"',
			...toolsField,
			"+": "delete",
		});
		return type.raw({
			context: "string",
			tasks: item.array(),
			"+": "delete",
		});
	}
	if (options.isolationEnabled) {
		return type.raw({
			"name?": "string",
			agent,
			task: "string",
			"model?": "string | string[]",
			"max_runtime_seconds?": "number.integer >= 0",
			...effortField,
			"outputSchema?": outputSchemaInputSchema,
			"schemaMode?": '"permissive" | "strict"',
			...toolsField,
			"isolated?": "boolean",
			"self_review?": "boolean",
			"+": "delete",
		});
	}
	return type.raw({
		"name?": "string",
		agent,
		task: "string",
		"model?": "string | string[]",
		"max_runtime_seconds?": "number.integer >= 0",
		"self_review?": "boolean",
		...effortField,
		"outputSchema?": outputSchemaInputSchema,
		"schemaMode?": '"permissive" | "strict"',
		...toolsField,
		"+": "delete",
	});
}

/** Build the task wire schema for the current settings and spawn policy. */
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	effortEnabled?: boolean;
	/** Advertise the `tools` field for eval-defined tools (`eval.tools.enabled`, default on). */
	evalToolsEnabled?: boolean;
	defaultAgent?: string;
}): TaskToolSchemaInstance {
	const defaultAgent = options.defaultAgent ?? "task";
	const effortEnabled = options.effortEnabled ?? false;
	const evalToolsEnabled = options.evalToolsEnabled ?? true;
	if (defaultAgent === "task" && !effortEnabled && evalToolsEnabled) {
		if (options.batchEnabled) return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
		return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
	}
	const key = `${options.isolationEnabled ? "iso" : "flat"}:${options.batchEnabled ? "batch" : "single"}:${effortEnabled ? "effort" : "default"}:${evalToolsEnabled ? "tools" : "notools"}:${defaultAgent}`;
	const cached = taskSchemaCache.get(key);
	if (cached) return cached;
	const schema = createTaskSchema({ ...options, effortEnabled, evalToolsEnabled, defaultAgent });
	taskSchemaCache.set(key, schema);
	return schema;
}

/** Select the stable roster and telemetry label for a specialized subagent. */
export function resolveSubagentDisplayName(role: string | undefined, agentName: string): string {
	const trimmed = role?.trim();
	return trimmed ? oneLineLabel(trimmed) : agentName;
}

/**
 * Whether an agent at `taskDepth` may still spawn children — i.e. it currently
 * holds the `task` tool. Mirrors the task-tool availability gate;
 * `maxRecursionDepth < 0` disables the cap entirely.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

/**
 * Agent-local review-gate policy declared in agent frontmatter.
 *
 * When present on the selected agent, it overrides the global `task.reviewGate.*`
 * defaults for that agent invocation. This lets bundled/native agents opt into
 * strict, light, or disabled review behavior without requiring user config.
 */
export interface AgentReviewGatePolicy {
	enabled: boolean;
	reviewerAgent?: string;
	reviewerModel?: string[];
	fixerAgent?: string;
	maxFixIterations?: number;
	failOnPriorities?: number[];
	requireCorrectVerdict?: boolean;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	resourceProfile?: "minimal";
	autoloadSkills?: string[];
	reviewGate?: AgentReviewGatePolicy;
	/** When `false`, the agent's `read` tool returns verbatim file content instead of structural summaries. */
	readSummarize?: boolean;
	/** Prewalk hand-off for the spawned session: `true` = switch to the default prewalk target at the first edit/write, string = custom target model pattern. */
	prewalk?: boolean | string;
	/** Advisor for spawned sessions of this agent: `true` = advise with the default advisor-role model, string = advise with that model pattern (optional `:level` suffix). Absent/`false` = no advisor. */
	advisor?: boolean | string;
	source: AgentSource;
	filePath?: string;
}
