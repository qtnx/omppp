import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { type AgentTelemetry, instrumentedCompleteSimple } from "./telemetry";

export type SingleTurnCompleteImpl = <TApi extends Api>(
	model: Model<TApi>,
	ctx: Context,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type SingleTurnStreamFn = <TApi extends Api>(
	model: Model<TApi>,
	ctx: Context,
	options: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface RunSingleTurnAgentRequest<TApi extends Api = Api> {
	readonly model: Model<TApi>;
	readonly systemPrompt: string | readonly string[];
	readonly prompt: string;
	readonly timestamp?: number;
	readonly streamFn?: SingleTurnStreamFn;
	readonly options?: SimpleStreamOptions;
	readonly telemetry?: AgentTelemetry;
	readonly oneshotKind?: string;
	readonly completeImpl?: SingleTurnCompleteImpl;
}

export interface RunSingleTurnAgentResult {
	readonly message: AssistantMessage;
	readonly text: string;
}

export async function runSingleTurnAgent<TApi extends Api>(
	request: RunSingleTurnAgentRequest<TApi>,
): Promise<RunSingleTurnAgentResult> {
	if (request.prompt.trim().length === 0) {
		throw new Error("runSingleTurnAgent requires a non-blank prompt");
	}

	const systemPrompt = normalizeSystemPrompt(request.systemPrompt);
	const completeImpl = request.completeImpl ?? adaptStreamFn(request.streamFn);
	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: request.prompt, timestamp: request.timestamp ?? Date.now() }],
	};
	const message = await instrumentedCompleteSimple(request.model, context, request.options ?? {}, {
		telemetry: request.telemetry,
		oneshotKind: request.oneshotKind ?? "single_turn_agent",
		completeImpl,
	});

	return { message, text: extractText(message) };
}

function normalizeSystemPrompt(systemPrompt: string | readonly string[]): string[] {
	const entries = typeof systemPrompt === "string" ? [systemPrompt] : [...systemPrompt];
	if (entries.length === 0 || entries.some(entry => entry.trim().length === 0)) {
		throw new Error("runSingleTurnAgent requires non-blank systemPrompt entries");
	}
	return entries;
}

function adaptStreamFn(streamFn: SingleTurnStreamFn | undefined): SingleTurnCompleteImpl | undefined {
	if (!streamFn) return undefined;
	return async (model, ctx, options) => {
		const stream = await streamFn(model, ctx, options);
		return stream.result();
	};
}

function extractText(message: AssistantMessage): string {
	return message.content.flatMap(content => (content.type === "text" ? [content.text] : [])).join("");
}
