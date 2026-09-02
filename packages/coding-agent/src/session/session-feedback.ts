/**
 * Local session feedback.
 *
 * `/feedback <text>` records what the user thought of the session so it can be
 * evaluated later. Feedback is stored as a `custom` entry inside the session
 * JSONL itself (never sent anywhere), so it survives resume/fork and can be
 * listed or bundled into a zip together with the transcript.
 */
import * as path from "node:path";
import { APP_NAME, isEnoent } from "@oh-my-pi/pi-utils";
import { zipSync } from "fflate";
import type { CustomEntry, SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

export const FEEDBACK_CUSTOM_TYPE = "feedback";

export type FeedbackRating = "positive" | "negative";

/** 1 (worst) to 5 (best). */
export type FeedbackScore = 1 | 2 | 3 | 4 | 5;

export type FeedbackSource = "command" | "rating-prompt";

/** Payload persisted in the `feedback` custom entry. */
export interface SessionFeedbackData {
	text: string;
	rating?: FeedbackRating;
	/** 1-5 star rating when the feedback came from a rating prompt or `/feedback rate`. */
	score?: FeedbackScore;
	/** Where the feedback was collected; absent on early records (= "command"). */
	source?: FeedbackSource;
	/** `provider/modelId` active when the feedback was given. */
	model?: string;
	/** Entry id of the latest assistant message on the branch at feedback time. */
	targetEntryId?: string;
	/** First line of that assistant message, for orientation without the transcript. */
	targetPreview?: string;
	cwd: string;
}

export interface SessionFeedbackRecord extends SessionFeedbackData {
	id: string;
	timestamp: string;
}

export interface FeedbackSessionLike {
	sessionManager: Pick<
		SessionManager,
		"appendCustomEntry" | "getEntries" | "getBranch" | "getCwd" | "getSessionId" | "getSessionFile" | "getSessionName"
	>;
	model?: { provider: string; id: string };
}

const RATING_PREFIXES: ReadonlyArray<[RegExp, FeedbackRating]> = [
	[/^(\+1|👍|good|:\)|:thumbsup:)\b\s*/i, "positive"],
	[/^(-1|👎|bad|:\(|:thumbsdown:)\b\s*/i, "negative"],
];

/** Split an optional leading `+1`/`-1`/`good`/`bad` marker off the feedback text. */
export function parseFeedbackInput(raw: string): { text: string; rating?: FeedbackRating } {
	const trimmed = raw.trim();
	for (const [pattern, rating] of RATING_PREFIXES) {
		const match = pattern.exec(trimmed);
		if (match) return { text: trimmed.slice(match[0].length).trim(), rating };
	}
	return { text: trimmed };
}

/** Parse a 1-5 score; anything else → undefined. */
export function parseFeedbackScore(raw: string): FeedbackScore | undefined {
	const value = Number(raw.trim());
	return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : undefined;
}

/** Scores of 4-5 count as positive, 1-2 as negative, 3 as neutral. */
export function ratingFromScore(score: FeedbackScore): FeedbackRating | undefined {
	if (score >= 4) return "positive";
	if (score <= 2) return "negative";
	return undefined;
}

/** Rating prompts ask for detail when the score is 3 or below. */
export const LOW_SCORE_THRESHOLD = 3;

const PREVIEW_LIMIT = 120;

function lastAssistantTarget(entries: readonly SessionEntry[]): { id: string; preview?: string } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		let text = "";
		for (const part of entry.message.content) {
			if (part.type === "text") text += part.text;
		}
		const firstLine = text
			.split("\n")
			.map(line => line.trim())
			.find(line => line.length > 0);
		const preview = firstLine
			? firstLine.length > PREVIEW_LIMIT
				? `${firstLine.slice(0, PREVIEW_LIMIT - 1)}…`
				: firstLine
			: undefined;
		return { id: entry.id, preview };
	}
	return undefined;
}

/** Explicit feedback payload (rating prompt or `/feedback rate`). */
export interface FeedbackInput {
	text?: string;
	score?: FeedbackScore;
	source?: FeedbackSource;
}

/**
 * Persist one feedback record into the session. A string is parsed like
 * `/feedback <text>`; an object records an explicit score. Returns the stored
 * record.
 */
export function recordSessionFeedback(
	session: FeedbackSessionLike,
	input: string | FeedbackInput,
): SessionFeedbackRecord {
	const parsed = typeof input === "string" ? parseFeedbackInput(input) : parseFeedbackInput(input.text ?? "");
	const score = typeof input === "string" ? undefined : input.score;
	const rating = score !== undefined ? ratingFromScore(score) : parsed.rating;
	const text = parsed.text;
	if (!text && !rating && score === undefined) throw new Error("Feedback text is empty.");
	const manager = session.sessionManager;
	const target = lastAssistantTarget(manager.getBranch());
	const data: SessionFeedbackData = {
		text,
		rating,
		score,
		source: typeof input === "string" ? "command" : (input.source ?? "command"),
		model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
		targetEntryId: target?.id,
		targetPreview: target?.preview,
		cwd: manager.getCwd(),
	};
	const id = manager.appendCustomEntry(FEEDBACK_CUSTOM_TYPE, data);
	const stored = manager.getEntries().find(entry => entry.id === id);
	return { id, timestamp: stored?.timestamp ?? new Date().toISOString(), ...data };
}

function isFeedbackEntry(entry: SessionEntry): entry is CustomEntry<SessionFeedbackData> {
	if (entry.type !== "custom" || entry.customType !== FEEDBACK_CUSTOM_TYPE) return false;
	const data = entry.data;
	return typeof data === "object" && data !== null && typeof (data as SessionFeedbackData).text === "string";
}

/** Every feedback record in the session, across all branches, in creation order. */
export function listSessionFeedback(manager: Pick<SessionManager, "getEntries">): SessionFeedbackRecord[] {
	const records: SessionFeedbackRecord[] = [];
	for (const entry of manager.getEntries()) {
		if (!isFeedbackEntry(entry)) continue;
		records.push({ id: entry.id, timestamp: entry.timestamp, ...entry.data! });
	}
	return records;
}

/** Whether the session already holds a 1-5 rating (the idle prompt asks only once per session). */
export function hasSessionRating(manager: Pick<SessionManager, "getEntries">): boolean {
	return listSessionFeedback(manager).some(record => record.score !== undefined);
}

function ratingLabel(record: SessionFeedbackRecord): string {
	if (record.score !== undefined) return `[${record.score}/5] `;
	if (record.rating === "positive") return "[+1] ";
	if (record.rating === "negative") return "[-1] ";
	return "";
}

/** Operator-facing summary used by `/feedback list`. */
export function formatSessionFeedbackList(records: readonly SessionFeedbackRecord[]): string {
	if (records.length === 0) return "No feedback recorded for this session yet. Add some with /feedback <text>.";
	const lines = [`Feedback for this session (${records.length})`];
	records.forEach((record, index) => {
		lines.push(`${index + 1}. ${record.timestamp} ${ratingLabel(record)}${record.text || "(no text)"}`);
		if (record.targetPreview) lines.push(`   re: ${record.targetPreview}`);
	});
	return lines.join("\n");
}

/** Markdown rendering bundled into the export so the zip is readable without tooling. */
export function formatSessionFeedbackMarkdown(
	records: readonly SessionFeedbackRecord[],
	meta: { sessionId: string; sessionName?: string; cwd: string },
): string {
	const lines = [`# Session feedback`, "", `- Session: ${meta.sessionId}`];
	if (meta.sessionName) lines.push(`- Name: ${meta.sessionName}`);
	lines.push(`- Directory: ${meta.cwd}`, `- Entries: ${records.length}`, "");
	for (const record of records) {
		const scoreLabel =
			record.score !== undefined ? ` (${record.score}/5)` : record.rating ? ` (${record.rating})` : "";
		lines.push(`## ${record.timestamp}${scoreLabel}`, "");
		if (record.source === "rating-prompt") lines.push("- Source: idle rating prompt");
		if (record.model) lines.push(`- Model: ${record.model}`);
		if (record.targetEntryId) lines.push(`- Assistant entry: ${record.targetEntryId}`);
		if (record.targetPreview) lines.push(`- Assistant said: ${record.targetPreview}`);
		lines.push("", record.text || "_(no text)_", "");
	}
	return lines.join("\n");
}

export interface FeedbackExportResult {
	path: string;
	count: number;
	/** False when the session was never materialized on disk (in-memory session). */
	includesTranscript: boolean;
}

async function readSessionTranscript(sessionFile: string | undefined): Promise<Uint8Array | undefined> {
	if (!sessionFile) return undefined;
	try {
		return new Uint8Array(await Bun.file(sessionFile).arrayBuffer());
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Bundle the session transcript plus its feedback into a zip. Default file:
 * `<APP_NAME>-feedback-<session file basename>.zip` in `cwd`.
 */
export async function exportSessionFeedbackZip(
	manager: Pick<SessionManager, "getEntries" | "getCwd" | "getSessionId" | "getSessionFile" | "getSessionName">,
	outputPath?: string,
): Promise<FeedbackExportResult> {
	const records = listSessionFeedback(manager);
	const sessionId = manager.getSessionId();
	const sessionFile = manager.getSessionFile();
	const cwd = manager.getCwd();
	const sessionName = manager.getSessionName();
	const transcript = await readSessionTranscript(sessionFile);
	const exportedAt = new Date().toISOString();
	const manifest = {
		app: APP_NAME,
		sessionId,
		sessionName,
		cwd,
		sessionFile,
		exportedAt,
		feedbackCount: records.length,
		files: ["manifest.json", "feedback.json", "feedback.md", ...(transcript ? ["session.jsonl"] : [])],
	};
	const encoder = new TextEncoder();
	const files: Record<string, Uint8Array> = {
		"manifest.json": encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
		"feedback.json": encoder.encode(`${JSON.stringify(records, null, 2)}\n`),
		"feedback.md": encoder.encode(formatSessionFeedbackMarkdown(records, { sessionId, sessionName, cwd })),
	};
	if (transcript) files["session.jsonl"] = transcript;
	const zip = zipSync(files, { level: 6, mtime: exportedAt });
	const baseName = sessionFile ? path.basename(sessionFile, ".jsonl") : sessionId;
	const resolved = path.resolve(cwd, outputPath?.trim() || `${APP_NAME}-feedback-${baseName}.zip`);
	await Bun.write(resolved, zip);
	return { path: resolved, count: records.length, includesTranscript: transcript !== undefined };
}
