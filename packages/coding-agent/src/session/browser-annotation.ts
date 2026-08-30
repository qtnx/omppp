import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import browserAnnotationTemplate from "../prompts/tools/browser-annotation.md" with { type: "text" };
import type { BrowserAnnotationEntry } from "../tools";
import type { AgentSession } from "./agent-session";
import { BROWSER_ANNOTATION_MESSAGE_TYPE, type CustomMessage, MAX_BACKGROUND_BROWSER_ANNOTATIONS } from "./messages";

export type BrowserAnnotationDetails = {
	annotations: Array<{ tab: string; url: string; title?: string; timestamp: number }>;
};

/** Build one displayable custom message from annotation entries. Used by both
 *  delivery modes: single-entry for queued follow-ups, batched for the legacy
 *  steer (yieldQueue) dispatcher. */
export function buildBrowserAnnotationBatchMessage(
	entries: BrowserAnnotationEntry[],
): CustomMessage<BrowserAnnotationDetails> | null {
	if (entries.length === 0) return null;
	const multiple = entries.length > 1;
	const count = entries.length;
	const annotations: BrowserAnnotationDetails["annotations"] = [];
	for (const entry of entries) {
		const annotation: BrowserAnnotationDetails["annotations"][number] = {
			tab: entry.tab,
			url: entry.url,
			timestamp: entry.timestamp,
		};
		if (entry.title !== undefined) annotation.title = entry.title;
		annotations.push(annotation);
	}
	const content: (TextContent | ImageContent)[] = [];
	for (const [index, entry] of entries.entries()) {
		content.push({
			type: "text",
			text: prompt.render(browserAnnotationTemplate, {
				annotation: { tab: entry.tab, text: entry.text },
				multiple,
				index: index + 1,
				count,
			}),
		});
		content.push({ type: "image", data: entry.screenshot.data, mimeType: entry.screenshot.mimeType });
	}
	return {
		role: "custom",
		customType: BROWSER_ANNOTATION_MESSAGE_TYPE,
		content,
		display: true,
		attribution: "user",
		details: { annotations },
		timestamp: Date.now(),
	};
}

/** Queue-chip label shown while a queued annotation waits for the current turn. */
export function browserAnnotationChipText(entry: BrowserAnnotationEntry): string {
	return `Browser annotation — ${entry.title?.trim() || entry.url}`;
}

/**
 * Deliver one annotation submission to the session per `browser.annotateDelivery`:
 * - `queue` (default): visible follow-up user message — shows as a queued chip
 *   while a turn is streaming and is processed after it completes; starts a
 *   turn immediately when the session is idle.
 * - `steer`: legacy yieldQueue aside injected mid-run between model requests.
 */
export function deliverBrowserAnnotation(session: AgentSession, entry: BrowserAnnotationEntry): void {
	if (session.settings.get("browser.annotateDelivery") === "steer") {
		session.yieldQueue.enqueue<BrowserAnnotationEntry>(BROWSER_ANNOTATION_MESSAGE_TYPE, entry, {
			maxEntries: MAX_BACKGROUND_BROWSER_ANNOTATIONS,
		});
		return;
	}
	const message = buildBrowserAnnotationBatchMessage([entry]);
	if (!message) return;
	void session
		.sendCustomMessage(message, {
			deliverAs: "followUp",
			triggerTurn: true,
			queueChipText: browserAnnotationChipText(entry),
		})
		.catch((error: unknown) => {
			logger.warn("Browser annotation delivery failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
}
