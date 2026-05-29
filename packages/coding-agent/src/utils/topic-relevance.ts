/**
 * Classify whether a new user request is related to the existing session
 * context, using a smol/fast model. Used by the idle topic-switch compaction
 * path: after a long idle gap, an unrelated new request shouldn't drag the
 * entire prior topic's context along.
 */
import { type Api, type AssistantMessage, completeSimple, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import topicRelevanceSystemPrompt from "../prompts/system/topic-relevance-system.md" with { type: "text" };

const TOPIC_RELEVANCE_SYSTEM_PROMPT = prompt.render(topicRelevanceSystemPrompt);

const MAX_REQUEST_CHARS = 2000;
const MAX_DIGEST_CHARS = 4000;
const ASSESS_MAX_TOKENS = 16;
const REASONING_SAFE_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const ASSESS_TOOL_NAME = "assess_relevance";

const assessRelevanceTool: Tool = {
	name: ASSESS_TOOL_NAME,
	description: "Report whether the new request is related to the prior session context.",
	parameters: {
		type: "object",
		properties: {
			related: {
				type: "boolean",
				description:
					"True if the new request continues or depends on the prior context; false if it is an unrelated new topic.",
			},
		},
		required: ["related"],
		additionalProperties: false,
	},
};

export type TopicRelevanceVerdict = "related" | "unrelated";

export interface AssessTopicRelevanceOptions {
	/** Optional session id for sticky API key selection. */
	sessionId?: string;
	/** Current model, used as a fallback when no smol role resolves. */
	currentModel?: Model<Api>;
	/** Resolver evaluated after credential selection to produce request metadata. */
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Hard timeout for the classification request. Defaults to 8s. */
	timeoutMs?: number;
	/** Optional caller signal; aborting it cancels the classification. */
	signal?: AbortSignal;
}

/**
 * Ask the smol model whether `request` is related to `contextDigest`.
 *
 * Returns the verdict, or `null` when the assessment could not be made (no
 * model, no API key, error, or timeout). Callers MUST treat `null` as
 * "don't act" — the feature fails open so a flaky classifier never disrupts
 * a normal turn.
 */
export async function assessTopicRelevance(
	request: string,
	contextDigest: string,
	registry: ModelRegistry,
	settings: Settings,
	options?: AssessTopicRelevanceOptions,
): Promise<TopicRelevanceVerdict | null> {
	const availableModels = registry.getAvailable();
	const model = resolveRoleSelection(["smol"], settings, availableModels, registry)?.model ?? options?.currentModel;
	if (!model) {
		logger.debug("topic-relevance: no model available");
		return null;
	}

	const apiKey = await registry.getApiKey(model, options?.sessionId);
	if (!apiKey) {
		logger.debug("topic-relevance: no API key for smol model", { provider: model.provider, id: model.id });
		return null;
	}
	const metadata = options?.metadataResolver?.(model.provider);

	const truncatedRequest = request.length > MAX_REQUEST_CHARS ? `${request.slice(0, MAX_REQUEST_CHARS)}…` : request;
	const truncatedDigest =
		contextDigest.length > MAX_DIGEST_CHARS ? `${contextDigest.slice(0, MAX_DIGEST_CHARS)}…` : contextDigest;
	const userMessage = `<session-context>
${truncatedDigest}
</session-context>

<new-request>
${truncatedRequest}
</new-request>`;

	const maxTokens = model.reasoning ? Math.max(ASSESS_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS) : ASSESS_MAX_TOKENS;

	const timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: [TOPIC_RELEVANCE_SYSTEM_PROMPT],
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
				tools: [assessRelevanceTool],
			},
			{
				apiKey,
				maxTokens,
				disableReasoning: true,
				toolChoice: { type: "tool", name: ASSESS_TOOL_NAME },
				metadata,
				signal,
			},
		);

		if (response.stopReason === "error") {
			logger.debug("topic-relevance: response error", {
				model: `${model.provider}/${model.id}`,
				errorMessage: response.errorMessage,
			});
			return null;
		}

		const related = extractRelatedFlag(response.content);
		logger.debug("topic-relevance: verdict", {
			model: `${model.provider}/${model.id}`,
			related,
			stopReason: response.stopReason,
		});
		if (related === undefined) return null;
		return related ? "related" : "unrelated";
	} catch (err) {
		logger.debug("topic-relevance: error", {
			model: `${model.provider}/${model.id}`,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function extractRelatedFlag(contentBlocks: AssistantMessage["content"]): boolean | undefined {
	for (const content of contentBlocks) {
		if (content.type === "toolCall" && content.name === ASSESS_TOOL_NAME) {
			const args = content.arguments as Record<string, unknown>;
			if (typeof args.related === "boolean") return args.related;
			return undefined;
		}
	}
	return undefined;
}
