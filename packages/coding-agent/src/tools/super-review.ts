import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	countTokens,
	instrumentedCompleteSimple,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type ImageContent, type Model, type TextContent } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { prompt } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { extractTextContent } from "../commit/utils";
import {
	formatModelString,
	resolveConfiguredModelPatterns,
	resolveModelOverrideWithAuthFallback,
} from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import superReviewImageMaterialPrompt from "../prompts/system/super-review-image-material.md" with { type: "text" };
import superReviewSnapcompactNote from "../prompts/system/super-review-snapcompact-note.md" with { type: "text" };
import superReviewSystemPrompt from "../prompts/system/super-review-system.md" with { type: "text" };
import superReviewUserPrompt from "../prompts/system/super-review-user.md" with { type: "text" };
import superReviewDescription from "../prompts/tools/super-review.md" with { type: "text" };
import {
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	toReasoningEffort,
} from "../thinking";
import type { ToolSession } from ".";
import { formatPathRelativeToCwd, parseLineRanges } from "./path-utils";
import { ToolError } from "./tool-errors";

const SUPER_REVIEW_ROLE = formatModelRoleAlias("super_review");
const MAX_FILE_BYTES = 2_000_000;

function sessionIdOf(session: ToolSession): string | undefined {
	return session.getSessionId?.() ?? undefined;
}

const MAX_TOTAL_BYTES = 4_000_000;
const MIN_SNAPCOMPACT_TOKENS = 3000;
const SNAPCOMPACT_SAVINGS_MARGIN = 0.9;

const fileAttachmentSchema = type({
	path: type("string>0").describe(
		"workspace-relative or absolute file path to attach; no URLs, globs, or directories",
	),
	"label?": type("string").describe("short label for this attachment"),
	"range?": type("string>0").describe('optional line selector like "10-80" or "10+50"'),
});

const superReviewSchema = type({
	review_type: type("'plan'|'critical_action'|'qa_plan'|'architecture'|'security'|'adversarial'|'other'").describe(
		"kind of high-intelligence one-turn review",
	),
	question: type("string>0").describe("specific review question or decision to critique"),
	"content?": type("string").describe("inline plan, action, QA plan, or context to review"),
	"files?": fileAttachmentSchema.array().describe("explicit file attachments to read into the review prompt"),
});

const legacySuperReviewSchema = type({
	review_type: type("'plan'|'critical_action'|'qa_plan'|'architecture'|'security'|'adversarial'|'other'"),
	question: "string>0",
	"content?": "string",
	"files?": fileAttachmentSchema.array(),
	"output_schema?": "Record<string,unknown>",
});

export type SuperReviewParams = typeof legacySuperReviewSchema.infer;
type SuperReviewFileAttachment = NonNullable<SuperReviewParams["files"]>[number];

export interface SuperReviewAttachmentDetails {
	path: string;
	label?: string;
	range?: string;
	bytes: number;
	lines: number;
	truncated: boolean;
}

export interface SuperReviewDetails {
	model: string;
	reviewType: SuperReviewParams["review_type"];
	structured: boolean;
	attachments: SuperReviewAttachmentDetails[];
}

interface PreparedAttachment extends SuperReviewAttachmentDetails {
	content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(rawArgs: unknown): SuperReviewParams {
	const parsed = legacySuperReviewSchema(rawArgs);
	if (parsed instanceof type.errors) {
		throw new ToolError(`super_review received invalid arguments: ${parsed.summary}`);
	}
	return parsed;
}

function containsGlobSyntax(filePath: string): boolean {
	return /[*?[\]{}]/.test(filePath);
}

function looksLikeUrl(filePath: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(filePath);
}

function isSecretLikePath(filePath: string): boolean {
	const segments = filePath.split(/[\\/]+/).map(segment => segment.toLowerCase());
	const base = segments[segments.length - 1] ?? "";
	if (base === ".env" || base.startsWith(".env.")) return true;
	if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts"].includes(base)) return true;
	if ([".pem", ".key", ".p12", ".pfx"].some(ext => base.endsWith(ext))) return true;
	if ([".ssh", ".gnupg"].some(segment => segments.includes(segment))) return true;
	return /(secret|credential|credentials|token|password|passwd)/i.test(base);
}

function assertInsideWorkspace(realPath: string, realCwd: string): void {
	const relative = path.relative(realCwd, realPath);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
	throw new ToolError(`Attachment escapes the workspace: ${realPath}`);
}

function selectRange(text: string, selector: string | undefined): { text: string; lines: number } {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	if (!selector) return { text: normalized, lines: lines.length };
	const ranges = parseLineRanges(selector);
	if (!ranges) throw new ToolError(`Invalid attachment range: ${selector}`);
	const selected: string[] = [];
	for (const range of ranges) {
		const start = Math.min(Math.max(range.startLine, 1), lines.length + 1);
		const end = range.endLine === undefined ? lines.length : Math.min(range.endLine, lines.length);
		if (start > end) continue;
		selected.push(...lines.slice(start - 1, end));
	}
	return { text: selected.join("\n"), lines: selected.length };
}

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return { text, bytes, truncated: false };
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
	return { text: text.slice(0, end), bytes: Buffer.byteLength(text.slice(0, end), "utf8"), truncated: true };
}

async function prepareAttachment(
	session: ToolSession,
	entry: SuperReviewFileAttachment,
	remainingBytes: number,
): Promise<PreparedAttachment> {
	if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0) {
		throw new ToolError("Attachment path is required.");
	}
	const rawPath = entry.path;
	if (looksLikeUrl(rawPath)) throw new ToolError(`Attachment URLs/network targets are not allowed: ${rawPath}`);
	if (containsGlobSyntax(rawPath)) throw new ToolError(`Attachment globs are not allowed: ${rawPath}`);
	if (isSecretLikePath(rawPath)) throw new ToolError(`Refusing to attach secret or credential-like file: ${rawPath}`);

	const cwd = session.cwd ?? process.cwd();
	const realCwd = await fs.realpath(cwd);
	const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
	const realPath = await fs.realpath(candidate).catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Cannot resolve attachment ${rawPath}: ${message}`);
	});
	assertInsideWorkspace(realPath, realCwd);
	const stat = await fs.stat(realPath);
	if (stat.isDirectory()) throw new ToolError(`Attachment resolves to a directory: ${rawPath}`);
	if (!stat.isFile()) throw new ToolError(`Attachment is not a regular file: ${rawPath}`);
	if (isSecretLikePath(realPath)) throw new ToolError(`Refusing to attach secret or credential-like file: ${rawPath}`);

	const fullText = await Bun.file(realPath).text();
	const selected = selectRange(fullText, entry.range);
	const budget = Math.max(0, Math.min(MAX_FILE_BYTES, remainingBytes));
	const truncated = truncateUtf8(selected.text, budget);
	const displayPath = formatPathRelativeToCwd(realPath, realCwd);
	return {
		path: displayPath,
		label: entry.label,
		range: entry.range,
		content: truncated.text,
		bytes: truncated.bytes,
		lines: selected.lines,
		truncated: truncated.truncated || Buffer.byteLength(selected.text, "utf8") > budget,
	};
}

async function prepareAttachments(
	session: ToolSession,
	files: SuperReviewParams["files"] | undefined,
): Promise<PreparedAttachment[]> {
	if (!files || files.length === 0) return [];
	const attachments: PreparedAttachment[] = [];
	let remaining = MAX_TOTAL_BYTES;
	for (const file of files) {
		if (remaining <= 0) throw new ToolError("super_review attachment input exceeded the total byte limit.");
		const attachment = await prepareAttachment(session, file, remaining);
		remaining -= attachment.bytes;
		attachments.push(attachment);
	}
	return attachments;
}

async function resolveSuperReviewRequest(session: ToolSession): Promise<{
	model: Model<Api>;
	reasoning: Effort | undefined;
}> {
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("super_review requires a model registry.");
	const patterns = resolveConfiguredModelPatterns(SUPER_REVIEW_ROLE, session.settings);
	if (patterns.length === 0) {
		throw new ToolError(
			"super_review could not resolve a model. Configure modelRoles.super_review or keep the default fallback chain.",
		);
	}
	const resolved = await resolveModelOverrideWithAuthFallback(
		patterns,
		undefined,
		registry,
		session.settings,
		sessionIdOf(session),
	);
	if (!resolved.model) {
		throw new ToolError(
			`super_review could not resolve a model from ${patterns.join(", ")}. Override modelRoles.super_review.`,
		);
	}
	return { model: resolved.model, reasoning: reasoningForSelection(resolved.model, resolved.thinkingLevel) };
}

function reasoningForSelection(
	model: Model<Api>,
	thinkingLevel: ConfiguredThinkingLevel | undefined,
): Effort | undefined {
	const configured = toReasoningEffort(resolveThinkingLevelForModel(model, concreteThinkingLevel(thinkingLevel)));
	if (configured !== undefined) return configured;
	if (!model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0) return undefined;
	return efforts.includes(Effort.High) ? Effort.High : efforts[efforts.length - 1];
}

function renderReviewPrompt(params: SuperReviewParams, attachments: PreparedAttachment[]): string {
	return prompt.render(superReviewUserPrompt, {
		review_type: params.review_type,
		question: params.question,
		content: params.content,
		has_content: Boolean(params.content),
		has_attachments: attachments.length > 0,
		attachments,
	});
}

function renderReviewImageMaterial(params: SuperReviewParams, attachments: PreparedAttachment[]): string {
	return prompt
		.render(superReviewImageMaterialPrompt, {
			content: params.content,
			has_content: Boolean(params.content),
			has_attachments: attachments.length > 0,
			attachments,
		})
		.trim();
}

function canUseSnapcompact(model: Model<Api>): boolean {
	return model.input.includes("image");
}

function attachmentPromptMetadata(attachments: PreparedAttachment[]): PreparedAttachment[] {
	return attachments.map(attachment => ({ ...attachment, content: "" }));
}

function passesSnapcompactGate(text: string, model: Model<Api>, shape: snapcompact.Shape): boolean {
	const textTokens = countTokens(text);
	if (textTokens < MIN_SNAPCOMPACT_TOKENS) return false;
	const frameCount = snapcompact.frames(text, { shape });
	if (frameCount <= 0) return false;
	if (frameCount > snapcompact.providerImageBudget(model.provider)) return false;
	return frameCount * shape.frameTokenEstimate <= textTokens * SNAPCOMPACT_SAVINGS_MARGIN;
}

async function renderReviewContent(
	params: SuperReviewParams,
	attachments: PreparedAttachment[],
	model: Model<Api>,
): Promise<(TextContent | ImageContent)[]> {
	const textPrompt = renderReviewPrompt(params, attachments);
	if (!canUseSnapcompact(model)) return [{ type: "text", text: textPrompt }];
	const imageMaterial = renderReviewImageMaterial(params, attachments);
	const shape = snapcompact.resolveShape(model);
	if (!passesSnapcompactGate(imageMaterial, model, shape)) return [{ type: "text", text: textPrompt }];
	const frames = await snapcompact.renderMany(imageMaterial, {
		shape,
		maxFrames: snapcompact.providerImageBudget(model.provider),
	});
	if (frames.length === 0) return [{ type: "text", text: textPrompt }];
	const metadataPrompt = renderReviewPrompt({ ...params, content: undefined }, attachmentPromptMetadata(attachments));
	return [{ type: "text", text: `${prompt.render(superReviewSnapcompactNote)}\n\n${metadataPrompt}` }, ...frames];
}

async function runSuperReview(
	params: SuperReviewParams,
	session: ToolSession,
	signal?: AbortSignal,
): Promise<{ text: string; details: SuperReviewDetails }> {
	const { model, reasoning } = await resolveSuperReviewRequest(session);
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("super_review requires a model registry.");

	const attachments = await prepareAttachments(session, params.files);
	const telemetry = resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined);
	const response = await instrumentedCompleteSimple(
		model,
		{
			systemPrompt: [prompt.render(superReviewSystemPrompt)],
			messages: [
				{
					role: "user",
					content: await renderReviewContent(params, attachments, model),
					timestamp: Date.now(),
				},
			],
			tools: undefined,
		},
		{
			apiKey: registry.resolver(model, sessionIdOf(session)),
			signal,
			reasoning,
			toolChoice: undefined,
		},
		{ telemetry, oneshotKind: "super_review" },
	);

	if (response.stopReason === "error") throw new ToolError(response.errorMessage ?? "super_review request failed.");
	if (response.stopReason === "aborted") throw new ToolError("super_review request aborted.");

	const text = extractTextContent(response);
	if (!text) throw new ToolError("super_review returned no text output.");
	return {
		text,
		details: {
			model: formatModelString(model),
			reviewType: params.review_type,
			structured: false,
			attachments: attachments.map(({ content: _content, ...attachment }) => attachment),
		},
	};
}

export class SuperReviewTool implements AgentTool<typeof superReviewSchema, SuperReviewDetails> {
	readonly name = "super_review";
	readonly label = "Super Review";
	readonly summary = "Run one high-intelligence review call on the configured super_review model chain";
	readonly description = prompt.render(superReviewDescription);
	readonly parameters = superReviewSchema;
	readonly loadMode = "essential";
	readonly interruptible = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		rawArgs: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SuperReviewDetails>> {
		const params = parseArgs(rawArgs);
		const result = await runSuperReview(params, this.session, signal);
		return { content: [{ type: "text", text: result.text }], details: result.details };
	}
}
