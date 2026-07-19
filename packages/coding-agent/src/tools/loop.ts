import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import loopDescription from "../prompts/tools/loop.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const INTERVAL_DURATION_RE = /^(\d+(?:\.\d+)?)([smh])$/;
const MIN_INTERVAL_MS = 10_000;

const loopSchema = z.object({
	prompt: z
		.string()
		.min(1)
		.max(4000)
		.describe("Self-contained instruction delivered on every iteration as a follow-up turn"),
	interval: z
		.string()
		.min(1)
		.describe('Cadence between iterations after the first: "10s", "5m", "1h", or bare seconds (min 10s)'),
	count: z.number().int().min(1).max(100).describe("Total iterations including the immediate first one (max 100)"),
});

type LoopParams = z.infer<typeof loopSchema>;

export interface LoopToolDetails {
	id: string;
	prompt: string;
	interval: string;
	intervalMs: number;
	count: number;
	meta?: OutputMeta;
}

function parseIntervalMs(value: string): number {
	const trimmed = value.trim();
	const duration = INTERVAL_DURATION_RE.exec(trimmed);
	const seconds = duration ? Number(duration[1]) * intervalMultiplier(duration[2]) : Number(trimmed);
	if (!(Number.isFinite(seconds) && seconds > 0)) {
		throw new ToolError(
			`Invalid interval value: ${JSON.stringify(value)}. Expected a positive number of seconds or duration like "5s", "10m", "1h".`,
		);
	}
	const intervalMs = seconds * 1000;
	if (intervalMs < MIN_INTERVAL_MS) {
		throw new ToolError(`Interval too short: ${JSON.stringify(value)}. Minimum interval is 10s (got ${seconds}s).`);
	}
	return intervalMs;
}

function intervalMultiplier(unit: string | undefined): number {
	if (unit === "h") return 3600;
	if (unit === "m") return 60;
	return 1;
}

export class LoopTool implements AgentTool<typeof loopSchema, LoopToolDetails> {
	readonly name = "loop";
	readonly approval = "read" as const;
	readonly label = "Loop";
	readonly summary = "Schedule a prompt to re-run as follow-up turns on an interval";
	readonly description: string;
	readonly parameters = loopSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<LoopParams>) =>
		args.prompt ? `looping: ${args.prompt.slice(0, 80)}` : "scheduling loop";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(loopDescription);
	}

	static createIf(session: ToolSession): LoopTool | null {
		if ((session.taskDepth ?? 0) !== 0) return null;
		if (typeof session.getLoopManager !== "function") return null;
		return new LoopTool(session);
	}

	async execute(
		_toolCallId: string,
		params: LoopParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<LoopToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<LoopToolDetails>> {
		throwIfAborted(signal);
		const manager = this.session.getLoopManager?.();
		if (!manager) {
			throw new ToolError("Loops are unavailable in this session.");
		}

		if (params.prompt.startsWith("/")) {
			throw new ToolError(
				`Loop prompt must not start with "/": extension commands cannot be delivered as follow-up turns.`,
			);
		}

		const intervalMs = parseIntervalMs(params.interval);
		const handle = manager.schedule({
			prompt: params.prompt,
			intervalMs,
			count: params.count,
		});

		const details: LoopToolDetails = {
			id: handle.id,
			prompt: params.prompt,
			interval: params.interval,
			intervalMs,
			count: params.count,
		};

		return toolResult<LoopToolDetails>(details)
			.text(
				`Loop ${handle.id} scheduled: "${params.prompt}" every ${params.interval}, ${params.count} iterations. Iteration 1/${params.count} queued. Iterations arrive as follow-up messages; the loop stops after ${params.count} iterations or when the session ends.`,
			)
			.done();
	}
}
