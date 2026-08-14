import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import codegraphExploreDescription from "../prompts/tools/codegraph-explore.md" with { type: "text" };
import codegraphIndexDescription from "../prompts/tools/codegraph-index.md" with { type: "text" };
import codegraphInitDescription from "../prompts/tools/codegraph-init.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { ToolError } from "../tools/tool-errors";
import { type CodeGraphCommandResult, CodeGraphManager } from "./manager";

const MAX_FILES = 100;

const codegraphInitSchema = type({
	"path?": "string",
});

type CodeGraphInitParams = typeof codegraphInitSchema.infer;

const codegraphIndexSchema = type({
	"path?": "string",
});

type CodeGraphIndexParams = typeof codegraphIndexSchema.infer;

const codegraphExploreSchema = type({
	query: "string > 0",
	"projectPath?": "string",
	"maxFiles?": "number.integer >= 1",
});

type CodeGraphExploreParams = typeof codegraphExploreSchema.infer;

export interface CodeGraphToolDetails {
	command: readonly string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

function resolveProjectPath(session: ToolSession, requestedPath: string | undefined): string {
	return resolveToCwd(requestedPath ?? session.cwd, session.cwd);
}

function commandFailure(result: CodeGraphCommandResult): ToolError {
	const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
	return new ToolError(
		`CodeGraph command failed (exit ${result.exitCode}): ${result.command.join(" ")}${output ? `\n${output}` : ""}`,
	);
}

function resultFor(result: CodeGraphCommandResult): AgentToolResult<CodeGraphToolDetails> {
	if (result.exitCode !== 0) throw commandFailure(result);
	return {
		content: [{ type: "text", text: result.stdout }],
		details: {
			command: result.command,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		},
	};
}

export class CodeGraphInitTool implements AgentTool<typeof codegraphInitSchema, CodeGraphToolDetails> {
	readonly name = "codegraph_init";
	readonly approval: ToolTier = "write";
	readonly label = "CodeGraph Init";
	readonly loadMode = "discoverable" as const;
	readonly summary = "Initialize CodeGraph's on-disk index for a project";
	readonly description = prompt.render(codegraphInitDescription);
	readonly parameters = codegraphInitSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CodeGraphInitParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CodeGraphToolDetails>> {
		const manager = await CodeGraphManager.forProject(resolveProjectPath(this.session, params.path));
		return resultFor(await manager.init(signal));
	}
}

export class CodeGraphIndexTool implements AgentTool<typeof codegraphIndexSchema, CodeGraphToolDetails> {
	readonly name = "codegraph_index";
	readonly approval: ToolTier = "write";
	readonly label = "CodeGraph Index";
	readonly loadMode = "discoverable" as const;
	readonly summary = "Rebuild CodeGraph's on-disk index for a project";
	readonly description = prompt.render(codegraphIndexDescription);
	readonly parameters = codegraphIndexSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CodeGraphIndexParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CodeGraphToolDetails>> {
		const manager = await CodeGraphManager.forProject(resolveProjectPath(this.session, params.path));
		return resultFor(await manager.index(signal));
	}
}

export class CodeGraphExploreTool implements AgentTool<typeof codegraphExploreSchema, CodeGraphToolDetails> {
	readonly name = "codegraph_explore";
	readonly approval = "read" as const;
	readonly label = "CodeGraph Explore";
	readonly loadMode = "essential" as const;
	readonly summary = "Explore indexed code structure, source, and call paths";
	readonly description = prompt.render(codegraphExploreDescription);
	readonly parameters = codegraphExploreSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CodeGraphExploreParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CodeGraphToolDetails>> {
		const projectPath = params.projectPath ? resolveProjectPath(this.session, params.projectPath) : undefined;
		const manager = await CodeGraphManager.forProject(projectPath ?? this.session.cwd);
		const maxFiles = params.maxFiles === undefined ? undefined : Math.min(params.maxFiles, MAX_FILES);
		try {
			return resultFor(await manager.explore(params.query, { projectPath, maxFiles, signal }));
		} catch (error) {
			if (error instanceof ToolError) throw error;
			throw new ToolError(`CodeGraph explore failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
