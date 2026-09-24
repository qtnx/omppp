import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
	let shotsDir: string;
	beforeEach(async () => {
		shotsDir = await fs.mkdtemp(path.join(os.tmpdir(), "annot-shots-"));
	});
	afterEach(async () => {
		await fs.rm(shotsDir, { recursive: true, force: true });
	});

	it("queue mode delivers a visible queued follow-up user message with a chip label", async () => {
		const { session, calls } = makeSession("queue");
		const entry = makeEntry();
		await deliverBrowserAnnotation(session, entry, shotsDir);

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

	it("saves the screenshot and puts a readable path in the message text", async () => {
		const { session, calls } = makeSession("queue");
		await deliverBrowserAnnotation(session, makeEntry(), shotsDir);

		const text = (calls.sent[0]!.message.content as Array<{ type: string; text?: string }>).find(
			part => part.type === "text",
		)!.text!;
		const match = /Screenshot: (\S+)/.exec(text);
		expect(match).not.toBeNull();
		const saved = match![1]!;
		expect(path.dirname(saved)).toBe(shotsDir);
		expect(saved.endsWith(".png")).toBe(true);
		expect(await Bun.file(saved).text()).toBe("hello");
	});

	it("still delivers without a path when the screenshot cannot be written", async () => {
		const { session, calls } = makeSession("queue");
		const blocker = path.join(shotsDir, "not-a-dir");
		await Bun.write(blocker, "x");
		await deliverBrowserAnnotation(session, makeEntry(), path.join(blocker, "shots"));

		expect(calls.sent).toHaveLength(1);
		const text = (calls.sent[0]!.message.content as Array<{ type: string; text?: string }>).find(
			part => part.type === "text",
		)!.text!;
		expect(text).not.toContain("Screenshot:");
	});

	it("steer mode routes through the yield queue with the buffering cap", async () => {
		const { session, calls } = makeSession("steer");
		const entry = makeEntry();
		await deliverBrowserAnnotation(session, entry, shotsDir);

		expect(calls.sent).toHaveLength(0);
		expect(calls.enqueued).toHaveLength(1);
		const enqueued = calls.enqueued[0]!;
		expect(enqueued.kind).toBe(BROWSER_ANNOTATION_MESSAGE_TYPE);
		expect((enqueued.entry as BrowserAnnotationEntry).screenshotPath?.startsWith(shotsDir)).toBe(true);
		expect(enqueued.options).toEqual({ maxEntries: 20 });
	});
});
