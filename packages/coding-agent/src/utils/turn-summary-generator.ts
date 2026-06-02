/**
 * Generate a concise past-tense recap (2-3 sentences) of what an agent
 * accomplished in the latest turn, using a smol, fast model. Mirrors title-generator.ts.
 *
 * The recap is a UI-only "activity log" block surfaced when a run completes, so
 * a user who left the session open (or backgrounded it) can tell at a glance what
 * the agent just did without re-reading the whole turn.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, completeSimple, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import turnSummarySystemPrompt from "../prompts/system/turn-summary-system.md" with { type: "text" };

const TURN_SUMMARY_SYSTEM_PROMPT = prompt.render(turnSummarySystemPrompt);

const MAX_REQUEST_CHARS = 600;
const MAX_RESPONSE_CHARS = 1500;
const MAX_TURN_TOOLS = 12;
const SUMMARY_MAX_TOKENS = 200;
const REASONING_SAFE_MAX_TOKENS = 1024;
const SET_SUMMARY_TOOL_NAME = "set_summary";

const setSummaryTool: Tool = {
	name: SET_SUMMARY_TOOL_NAME,
	description: "Record the concise recap of what the assistant just accomplished.",
	parameters: {
		type: "object",
		properties: {
			summary: {
				type: "string",
				description:
					"A concise past-tense recap (2-3 sentences, at most ~60 words) of what the assistant did this turn.",
			},
		},
		required: ["summary"],
		additionalProperties: false,
	},
};

/** Input distilled from the latest turn, fed to the summarization model. */
export interface TurnSummaryContext {
	/** The genuine user prompt that started the turn. */
	readonly request: string;
	/** The assistant's final reply text for the turn (may be empty). */
	readonly response: string;
	/** Distinct tool names invoked during the turn, in first-use order, capped. */
	readonly tools: readonly string[];
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const value = (block as { text?: unknown }).text;
			if (typeof value === "string") text += value;
		}
	}
	return text;
}

/**
 * Distill the most recent turn — everything after the last genuine user prompt —
 * into a {@link TurnSummaryContext}.
 *
 * Returns `undefined` when the turn did no tool work (a pure conversational
 * reply); those turns are skipped because there is nothing the agent "did"
 * beyond the visible answer, and summarizing them only adds cost and noise.
 */
export function collectTurnSummaryContext(messages: readonly AgentMessage[]): TurnSummaryContext | undefined {
	let startIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			startIdx = i;
			break;
		}
	}
	if (startIdx < 0) return undefined;

	const tools: string[] = [];
	const seen = new Set<string>();
	let response = "";
	let hadToolCall = false;

	for (let i = startIdx + 1; i < messages.length; i++) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		let assistantText = "";
		for (const block of content) {
			const type = block && typeof block === "object" ? (block as { type?: unknown }).type : undefined;
			if (type === "text") {
				const value = (block as { text?: unknown }).text;
				if (typeof value === "string") assistantText += value;
			} else if (type === "toolCall") {
				hadToolCall = true;
				const name = (block as { name?: unknown }).name;
				if (typeof name === "string" && name && !seen.has(name)) {
					seen.add(name);
					if (tools.length < MAX_TURN_TOOLS) tools.push(name);
				}
			}
		}
		// Keep the latest non-empty assistant text as the turn's final reply.
		if (assistantText.trim()) response = assistantText;
	}

	if (!hadToolCall) return undefined;

	const startMessage = messages[startIdx];
	const request = startMessage?.role === "user" ? extractUserText(startMessage.content) : "";
	return {
		request: request.trim(),
		response: response.trim(),
		tools,
	};
}

function getSummaryModel(
	registry: ModelRegistry,
	settings: Settings,
	currentModel?: Model<Api>,
): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const summaryModel = resolveRoleSelection(["commit", "smol"], settings, availableModels, registry)?.model;
	if (summaryModel) return summaryModel;

	return currentModel;
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Generate a concise turn recap. Returns `null` when no model/key is available
 * or the model produces nothing usable; callers fall back silently.
 *
 * @param context Distilled turn input from {@link collectTurnSummaryContext}.
 * @param registry Model registry.
 * @param settings Settings used to resolve the smol/commit role.
 * @param sessionId Optional session id for sticky API key selection.
 * @param currentModel Current model (fallback when no role model resolves).
 * @param metadataResolver Optional resolver evaluated after credential selection
 *   to produce request metadata (e.g. account_uuid for session attribution).
 */
export async function generateTurnSummary(
	context: TurnSummaryContext,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
): Promise<string | null> {
	const request = truncate(context.request, MAX_REQUEST_CHARS);
	const response = truncate(context.response, MAX_RESPONSE_CHARS);
	if (!request && !response && context.tools.length === 0) return null;

	const model = getSummaryModel(registry, settings, currentModel);
	if (!model) {
		logger.debug("turn-summary: no summary model found");
		return null;
	}

	const toolsLine = context.tools.length > 0 ? context.tools.join(", ") : "none";
	const userMessage = `<request>
${request || "(none)"}
</request>
<tools-used>${toolsLine}</tools-used>
<final-response>
${response || "(none)"}
</final-response>`;

	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) {
		logger.debug("turn-summary: no API key for summary model", { provider: model.provider, id: model.id });
		return null;
	}
	// Resolve metadata after getApiKey so the session-sticky credential is recorded
	// first; the resolver can then return the account_uuid actually used.
	const metadata = metadataResolver?.(model.provider);

	const maxTokens = model.reasoning ? Math.max(SUMMARY_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS) : SUMMARY_MAX_TOKENS;

	try {
		const completion = await completeSimple(
			model,
			{
				systemPrompt: [TURN_SUMMARY_SYSTEM_PROMPT],
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
				tools: [setSummaryTool],
			},
			{
				apiKey,
				maxTokens,
				disableReasoning: true,
				toolChoice: { type: "tool", name: SET_SUMMARY_TOOL_NAME },
				metadata,
			},
		);

		if (completion.stopReason === "error") {
			logger.debug("turn-summary: response error", {
				model: `${model.provider}/${model.id}`,
				stopReason: completion.stopReason,
				errorMessage: completion.errorMessage,
			});
			return null;
		}

		const summary = extractGeneratedSummary(completion.content);
		if (!summary) return null;

		const cleaned = summary
			.replace(/^["'`]|["'`]$/g, "")
			.replace(/[.!?]+$/, "")
			.trim();
		return cleaned || null;
	} catch (err) {
		logger.debug("turn-summary: error", {
			model: `${model.provider}/${model.id}`,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function extractGeneratedSummary(contentBlocks: AssistantMessage["content"]): string {
	let textSummary = "";
	for (const content of contentBlocks) {
		if (content.type === "toolCall" && content.name === SET_SUMMARY_TOOL_NAME) {
			const args = content.arguments as Record<string, unknown>;
			const summary = args.summary;
			return typeof summary === "string" ? summary.trim() : "";
		}
		if (content.type === "text") {
			textSummary += content.text;
		}
	}
	return textSummary.trim();
}
