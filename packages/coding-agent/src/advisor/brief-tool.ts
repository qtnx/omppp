import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import updateBriefDescription from "../prompts/tools/advisor-update-brief.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";

const MAX_BRIEF_BYTES = 8192;
const BRIEF_URL = "local://advisor-brief.md";

const updateBriefSchema = type({
	content: type("string").describe("Full replacement advisor brief markdown content."),
});

export type UpdateBriefParams = typeof updateBriefSchema.infer;

function localProtocolOptions(session: ToolSession): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getSessionId: () => session.getSessionId?.() ?? null,
		}
	);
}

export class UpdateBriefTool implements AgentTool<typeof updateBriefSchema, undefined> {
	readonly name = "update_brief";
	readonly label = "Update brief";
	readonly description = updateBriefDescription;
	readonly parameters = updateBriefSchema;
	readonly loadMode = "essential" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		args: UpdateBriefParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const bytes = new TextEncoder().encode(args.content).byteLength;
		if (bytes > MAX_BRIEF_BYTES) {
			throw new ToolError(`update_brief content exceeds ${MAX_BRIEF_BYTES} byte cap (${bytes} bytes).`);
		}

		// Resolve through the session's local:// mapping so parent/subagent advisors share the same durable brief.
		const targetPath = resolveLocalUrlToPath(BRIEF_URL, localProtocolOptions(this.session));
		await Bun.write(targetPath, args.content);

		return { content: [{ type: "text", text: `Brief updated (${bytes} bytes).` }] };
	}
}
