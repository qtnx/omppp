import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import readAdvisorStateDescription from "../prompts/tools/advisor-read-state.md" with { type: "text" };
import updateAdvisorStateDescription from "../prompts/tools/advisor-update-state.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";

const MAX_STATE_BYTES = 16_384;
const STATE_URL = "local://advisor-state.md";

const readAdvisorStateSchema = type({});
const updateAdvisorStateSchema = type({
	content: type("string").describe("Full replacement advisor state markdown content."),
});

export type ReadAdvisorStateParams = typeof readAdvisorStateSchema.infer;
export type UpdateAdvisorStateParams = typeof updateAdvisorStateSchema.infer;

function localProtocolOptions(session: ToolSession): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getSessionId: () => session.getSessionId?.() ?? null,
		}
	);
}

export class ReadAdvisorStateTool implements AgentTool<typeof readAdvisorStateSchema, undefined> {
	readonly name = "read_advisor_state";
	readonly label = "Read advisor state";
	readonly description = readAdvisorStateDescription;
	readonly parameters = readAdvisorStateSchema;
	readonly loadMode = "essential" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_args: ReadAdvisorStateParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const targetPath = resolveLocalUrlToPath(STATE_URL, localProtocolOptions(this.session));
		let content: string;
		try {
			content = await Bun.file(targetPath).text();
		} catch (err) {
			if (isEnoent(err)) {
				return { content: [{ type: "text", text: "No advisor state has been written yet." }] };
			}
			throw err;
		}

		return { content: [{ type: "text", text: `Advisor state at ${STATE_URL}:\n\n${content}` }] };
	}
}

export class UpdateAdvisorStateTool implements AgentTool<typeof updateAdvisorStateSchema, undefined> {
	readonly name = "update_advisor_state";
	readonly label = "Update advisor state";
	readonly description = updateAdvisorStateDescription;
	readonly parameters = updateAdvisorStateSchema;
	readonly loadMode = "essential" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		args: UpdateAdvisorStateParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const bytes = new TextEncoder().encode(args.content).byteLength;
		if (bytes > MAX_STATE_BYTES) {
			throw new ToolError(`update_advisor_state content exceeds ${MAX_STATE_BYTES} byte cap (${bytes} bytes).`);
		}

		const targetPath = resolveLocalUrlToPath(STATE_URL, localProtocolOptions(this.session));
		await Bun.write(targetPath, args.content);

		return { content: [{ type: "text", text: `Advisor state updated (${bytes} bytes).` }] };
	}
}
