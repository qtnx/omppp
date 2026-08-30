import { describe, expect, it } from "bun:test";
import type { BrowserAnnotationEntry } from "../../tools";
import type { AgentSession } from "../agent-session";
import { deliverBrowserAnnotation } from "../browser-annotation";
import { BROWSER_ANNOTATION_MESSAGE_TYPE, type CustomMessage } from "../messages";

function makeEntry(): BrowserAnnotationEntry {
	return {
		tab: "review",
		url: "http://localhost:3000/",
		title: "Checkout",
		text: "Human feedback from http://localhost:3000/ — Checkout\nComment: button overlaps footer",
		screenshot: { data: "aGVsbG8=", mimeType: "image/png" },
		timestamp: 1700000000000,
	};
}

interface DeliveryCalls {
	enqueued: Array<{ kind: string; entry: unknown; options: unknown }>;
	sent: Array<{ message: CustomMessage; options: Record<string, unknown> | undefined }>;
}

function makeSession(mode: "queue" | "steer"): { session: AgentSession; calls: DeliveryCalls } {
	const calls: DeliveryCalls = { enqueued: [], sent: [] };
	const session = {
		settings: { get: (path: string) => (path === "browser.annotateDelivery" ? mode : undefined) },
		yieldQueue: {
			enqueue: (kind: string, entry: unknown, options: unknown) => {
				calls.enqueued.push({ kind, entry, options });
			},
		},
		sendCustomMessage: async (message: CustomMessage, options: Record<string, unknown> | undefined) => {
			calls.sent.push({ message, options });
			return false;
		},
	} as unknown as AgentSession;
	return { session, calls };
}

describe("deliverBrowserAnnotation", () => {
	it("queue mode delivers a visible queued follow-up user message with a chip label", () => {
		const { session, calls } = makeSession("queue");
		const entry = makeEntry();
		deliverBrowserAnnotation(session, entry);

		expect(calls.enqueued).toHaveLength(0);
		expect(calls.sent).toHaveLength(1);
		const { message, options } = calls.sent[0]!;
		expect(options?.deliverAs).toBe("followUp");
		expect(options?.triggerTurn).toBe(true);
		expect(options?.queueChipText).toBe("Browser annotation — Checkout");
		// Queue-chip visibility contract: user-attributed displayable custom message.
		expect(message.customType).toBe(BROWSER_ANNOTATION_MESSAGE_TYPE);
		expect(message.attribution).toBe("user");
		expect(message.display).toBe(true);
		const content = message.content as Array<{ type: string; text?: string; data?: string }>;
		expect(content.find(part => part.type === "text")?.text).toContain("button overlaps footer");
		expect(content.find(part => part.type === "image")?.data).toBe("aGVsbG8=");
	});

	it("steer mode routes through the yield queue with the buffering cap", () => {
		const { session, calls } = makeSession("steer");
		const entry = makeEntry();
		deliverBrowserAnnotation(session, entry);

		expect(calls.sent).toHaveLength(0);
		expect(calls.enqueued).toHaveLength(1);
		const enqueued = calls.enqueued[0]!;
		expect(enqueued.kind).toBe(BROWSER_ANNOTATION_MESSAGE_TYPE);
		expect(enqueued.entry).toBe(entry);
		expect(enqueued.options).toEqual({ maxEntries: 20 });
	});
});
