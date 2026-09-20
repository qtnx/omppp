import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { scoutSource, type ScoutResult, type ScoutSourceDetail } from "../jev/scout";
import description from "../prompts/tools/jev-scout.md" with { type: "text" };
import type { ToolSession } from "./index";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { clampTimeout } from "./tool-timeouts";

const scoutSchema = type({
	query: type("string").describe("What behavior or function to locate; include the relevant domain"),
	"path?": type("string").describe("Local file or directory to search; defaults to the working directory"),
	"max_files?": type("number.integer >= 1 & number <= 8").describe("Maximum files to inspect; default 3"),
	"timeout?": type("number > 0").describe("Overall timeout in seconds; default 60"),
	"+": "reject",
});

/** Read-only, bounded source navigation; Jev selects only observed paths and lines. */
export class JevScoutTool implements AgentTool<typeof scoutSchema, ScoutResult> {
	readonly name = "jev_scout";
	readonly label = "Jev Scout";
	// Essential, not discoverable: the system prompt routes behavior-to-location
	// search here, and `jev_scout` only exists when a Jev endpoint is configured
	// (availability gate in tools/index.ts).
	readonly loadMode = "essential" as const;
	readonly approval = "read" as const;
	readonly concurrency = "shared" as const;
	readonly interruptible = true;
	readonly summary = "Locate relevant functions through semantic file navigation and source outlines";
	readonly description = description.trim();
	readonly parameters = scoutSchema;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, rawArgs: unknown, signal?: AbortSignal): Promise<AgentToolResult<ScoutResult>> {
		const params = scoutSchema(rawArgs);
		if (params instanceof type.errors) throw new ToolError(`jev_scout received invalid arguments: ${params.summary}`);
		if (signal?.aborted) throw new ToolAbortError();
		const timeoutMs =
			clampTimeout("jev_scout", params.timeout ?? 60, this.session.settings.get("tools.maxTimeout")) * 1000;
		const deadline = AbortSignal.timeout(timeoutMs);
		const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
		try {
			const result = await scoutSource({
				query: params.query,
				path: resolveToCwd(params.path ?? ".", this.session.cwd),
				maxFiles: params.max_files,
				sourceDetail: this.session.settings.get("signals.scoutSourceDetail") as ScoutSourceDetail,
				redact: text => this.session.redactOutboundText?.(text) ?? text,
				signal: combined,
			});
			const text = [
				result.status === "found"
					? "Relevant source excerpts:"
					: "No matching source selected within the searched scope.",
				...result.excerpts.map(excerpt => {
					const file = formatPathRelativeToCwd(excerpt.path, this.session.cwd);
					const lines = excerpt.text
						.split("\n")
						.map((line, index) => `${excerpt.startLine + index}:${replaceTabs(line)}`);
					return `${file}:${excerpt.startLine}-${excerpt.endLine}\n${lines.join("\n")}`;
				}),
				...result.warnings.map(warning => `Note: ${replaceTabs(warning)}`),
				`Scope: ${result.directoriesVisited} directories, ${result.filesRead} files; ${result.truncated ? "partial" : "selected scope inspected"}.`,
				`Jev: ${result.requests} requests; ${result.inputTokens} input tokens, ${result.outputTokens} output tokens.`,
			].join("\n\n");
			return { content: [{ type: "text", text }], details: result };
		} catch (error) {
			if (signal?.aborted) throw new ToolAbortError();
			if (deadline.aborted)
				throw new ToolError("Source scouting timed out. Narrow path to a relevant directory or file.");
			if (error instanceof ToolError) throw error;
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	}
}
