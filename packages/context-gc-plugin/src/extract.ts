import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

export type ExtractableContent = string | readonly (TextContent | ImageContent)[];

/** Media type for plain-text payloads. */
export const TEXT_MEDIA_TYPE = "text/plain;charset=utf-8";
/** Media type for structured payloads stored as JSON (image-bearing content/messages). */
export const JSON_MEDIA_TYPE = "application/json;charset=utf-8";

export interface ExtractedMessagePayload {
	readonly text: string;
	readonly role?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly customType?: string;
}

/**
 * A payload ready for durable persistence. `text` is the plain-text projection (used for
 * summaries/search/range and projection-hash matching). `stored` is the canonical
 * representation persisted in SQLite: structured JSON when the source carries images,
 * otherwise identical to `text`. `mediaType` describes `stored`.
 */
export interface PersistedPayload {
	readonly text: string;
	readonly stored: string;
	readonly mediaType: string;
}

interface FileMentionFile {
	readonly path: string;
	readonly content: string;
	readonly image?: ImageContent;
}

export function textFromContent(content: ExtractableContent | undefined): string {
	if (typeof content === "string") {
		return content;
	}
	if (!content) {
		return "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push(`[image:${block.mimeType}]`);
		}
	}
	return parts.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

export function extractMessagePayload(message: AgentMessage): ExtractedMessagePayload {
	const record = asRecord(message);
	return {
		text: textForMessage(record),
		role: stringField(record, "role"),
		toolCallId: stringField(record, "toolCallId"),
		toolName: stringField(record, "toolName"),
		customType: stringField(record, "customType"),
	};
}

/**
 * Build a durable payload (text projection + structured `stored` form) for a tool result or
 * message content array. Image-bearing content is stored as JSON; text-only content stays plain.
 */
export function payloadFromContent(content: ExtractableContent | undefined): PersistedPayload {
	const text = textFromContent(content);
	if (typeof content === "string" || !content) {
		return { text, stored: text, mediaType: TEXT_MEDIA_TYPE };
	}
	const hasImage = content.some(block => block.type === "image");
	if (!hasImage) {
		return { text, stored: text, mediaType: TEXT_MEDIA_TYPE };
	}
	return { text, stored: JSON.stringify(content), mediaType: JSON_MEDIA_TYPE };
}

/** Build a durable payload for any inventoried message, preserving structured image content. */
export function payloadForMessage(message: AgentMessage): PersistedPayload {
	const record = asRecord(message);
	switch (record.role) {
		case "fileMention":
			return payloadFromFileMention(record);
		case "bashExecution": {
			const text = textFromBashExecution(record);
			return { text, stored: text, mediaType: TEXT_MEDIA_TYPE };
		}
		case "pythonExecution": {
			const text = textFromPythonExecution(record);
			return { text, stored: text, mediaType: TEXT_MEDIA_TYPE };
		}
		default:
			return payloadFromContent(readContent(record));
	}
}

function textForMessage(record: Record<string, unknown>): string {
	switch (record.role) {
		case "fileMention":
			return textFromFileMention(record);
		case "bashExecution":
			return textFromBashExecution(record);
		case "pythonExecution":
			return textFromPythonExecution(record);
		default:
			return textFromContent(readContent(record));
	}
}

function payloadFromFileMention(record: Record<string, unknown>): PersistedPayload {
	const text = textFromFileMention(record);
	const files = record.files;
	const hasImage = Array.isArray(files) && files.some(file => isFileMentionFile(file) && file.image !== undefined);
	if (!hasImage) {
		return { text, stored: text, mediaType: TEXT_MEDIA_TYPE };
	}
	return { text, stored: JSON.stringify(files), mediaType: JSON_MEDIA_TYPE };
}

function textFromBashExecution(record: Record<string, unknown>): string {
	const command = stringField(record, "command") ?? "";
	const output = stringField(record, "output") ?? "";
	const parts = [`$ ${command}`, output.length > 0 ? output : "(no output)"];
	const exitCode = numberField(record, "exitCode");
	if (exitCode !== undefined && exitCode !== 0) {
		parts.push(`[exit code ${exitCode}]`);
	}
	return parts.join("\n");
}

function textFromPythonExecution(record: Record<string, unknown>): string {
	const code = stringField(record, "code") ?? "";
	const output = stringField(record, "output") ?? "";
	const parts = [`Ran Python:\n${code}`, output.length > 0 ? `Output:\n${output}` : "(no output)"];
	const exitCode = numberField(record, "exitCode");
	if (exitCode !== undefined && exitCode !== 0) {
		parts.push(`[exit code ${exitCode}]`);
	}
	return parts.join("\n");
}

function readContent(record: Record<string, unknown>): ExtractableContent | undefined {
	const content = record.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.filter(isTextOrImageBlock);
	}
	return undefined;
}

function isTextOrImageBlock(value: unknown): value is TextContent | ImageContent {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		(record.type === "text" && typeof record.text === "string") ||
		(record.type === "image" && typeof record.mimeType === "string")
	);
}

function textFromFileMention(record: Record<string, unknown>): string {
	const files = record.files;
	if (!Array.isArray(files)) {
		return "";
	}
	return files.filter(isFileMentionFile).map(formatFileMentionFile).join("\n\n");
}

function formatFileMentionFile(file: FileMentionFile): string {
	const parts = [`<file path="${escapeXmlAttribute(file.path)}">`];
	if (file.content.length > 0) {
		parts.push(file.content);
	}
	if (file.image) {
		parts.push(`[image:${file.image.mimeType}]`);
	}
	parts.push("</file>");
	return parts.join("\n");
}

function isFileMentionFile(value: unknown): value is FileMentionFile {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return typeof record.path === "string" && typeof record.content === "string" && isOptionalImage(record.image);
}

function isOptionalImage(value: unknown): value is ImageContent | undefined {
	if (value === undefined) {
		return true;
	}
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return record.type === "image" && typeof record.mimeType === "string";
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}
