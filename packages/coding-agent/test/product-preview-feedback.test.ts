import { describe, expect, it, spyOn } from "bun:test";
import { createProductPreviewCommand } from "../src/commands/product";
import { formatPreviewFeedback } from "../src/product-preview/feedback";
import type {
	AnswerFeedback,
	CommentFeedback,
	PreviewComment,
	PreviewFeedback,
	PreviewServerHandle,
	PreviewServerOptions,
	ShareController,
	SideAskFeedback,
	StartPreviewServer,
} from "../src/product-preview/types";
import { PREVIEW_FEEDBACK_MESSAGE_TYPE } from "../src/session/messages";
import type { YieldQueue } from "../src/session/yield-queue";
import type { SlashCommandRuntime } from "../src/slash-commands/types";
import { createPresentTool } from "../src/tools/present";

const baseComment: PreviewComment = {
	id: "c1",
	anchor: {
		type: "text",
		itemId: "brief",
		quote: "Problem statement",
		prefix: "## ",
		suffix: "\n",
	},
	body: "Please tighten this section.",
	author: "Ada",
	viaShare: true,
	ts: 1_700_000_000_000,
	resolved: false,
	replies: [],
	ownerSid: "sid-1",
};

describe("formatPreviewFeedback", () => {
	it("formats side-ask with every required field and a template-source note", () => {
		const feedback: SideAskFeedback = {
			type: "side-ask",
			comment: "Can we change &lt;this&gt;?",
			itemId: "brief",
			from: "loopback",
			viaShare: false,
			ts: 1,
			source: "template",
		};
		const text = formatPreviewFeedback(feedback);
		expect(text).toContain("side-ask");
		expect(text).toContain("loopback");
		expect(text).toContain("viaShare: false");
		expect(text).toContain("source: template");
		expect(text).toContain("template");
		expect(text).toContain("itemId: brief");
		expect(text).toContain("Can we change &lt;this&gt;?");
		// Template source must be called out so the model can distinguish bridge prompts.
		expect(text.toLowerCase()).toContain("template");
		expect(text).toMatch(/source\s*[:=].*template|template.*bridge|bridge.*template/i);
	});

	it("formats side-ask from the ask panel without inventing a template note", () => {
		const feedback: SideAskFeedback = {
			type: "side-ask",
			comment: "Plain ask",
			from: "viewer",
			viaShare: true,
			ts: 2,
			source: "user",
		};
		const text = formatPreviewFeedback(feedback);
		expect(text).toContain("Plain ask");
		expect(text).toContain("source: user");
		expect(text).toContain("viewer");
		expect(text).toContain("viaShare: true");
	});

	it("formats comment feedback with title, blockquoted quote, body, author, and event", () => {
		const feedback: CommentFeedback = {
			type: "comment",
			comment: baseComment,
			itemTitle: "Product brief",
			event: "new",
			from: "Ada",
			viaShare: true,
			ts: baseComment.ts,
		};
		const text = formatPreviewFeedback(feedback);
		expect(text).toContain("Product brief");
		expect(text).toContain("> Problem statement");
		expect(text).toContain("Please tighten this section.");
		expect(text).toContain("Ada");
		expect(text).toContain("new");
		expect(text).toContain("brief");
		expect(text).toContain("c1");
	});

	it("formats comment reply events distinctly from new comments", () => {
		const feedback: CommentFeedback = {
			type: "comment",
			comment: {
				...baseComment,
				// Server delivers the full thread; the latest reply is the new text.
				replies: [
					{
						id: "r1",
						body: "Ship the tighter wording.",
						author: "Bea",
						viaShare: false,
						ts: baseComment.ts + 1,
					},
				],
			},
			itemTitle: "Product brief",
			event: "reply",
			from: "Bea",
			viaShare: false,
			ts: baseComment.ts + 1,
		};
		const text = formatPreviewFeedback(feedback);
		expect(text).toContain("reply");
		expect(text).toContain("Bea");
		expect(text).toContain("> Problem statement");
		// Reply body must surface — not only the original comment body.
		expect(text).toContain("Ship the tighter wording.");
		expect(text).not.toContain("Please tighten this section.");
	});

	it("formats canvas-node resolution feedback without inventing a text quote", () => {
		const feedback: CommentFeedback = {
			type: "comment",
			comment: {
				...baseComment,
				anchor: { type: "canvas-node", itemId: "architecture", nodeId: "gateway-auth" },
				resolved: true,
			},
			itemTitle: "Architecture",
			event: "resolve",
			from: "Ada",
			viaShare: true,
			ts: baseComment.ts,
		};
		const text = formatPreviewFeedback(feedback);
		expect(text).toContain("Canvas node:");
		expect(text).toContain("gateway-auth");
		expect(text).toContain("resolve");
		expect(text).not.toContain("Quoted selection:");
	});

	it("formats answer feedback with question, selection, and author", () => {
		const feedback: AnswerFeedback = {
			type: "answer",
			questionId: "layout-choice",
			itemId: "design",
			question: "Which dashboard layout?",
			selection: ["Sidebar", "Top tabs"],
			from: "Cara",
			viaShare: true,
			ts: 3,
		};
		const text = formatPreviewFeedback(feedback);
		expect(text).toContain("layout-choice");
		expect(text).toContain("Which dashboard layout?");
		expect(text).toContain("Sidebar");
		expect(text).toContain("Top tabs");
		expect(text).toContain("Cara");
		expect(text).toContain("design");
		expect(text).toContain("viaShare: true");
	});
});

describe("preview feedback wiring", () => {
	it("present tool passes deliverFeedback into startServer options", async () => {
		const calls: PreviewServerOptions[] = [];
		const handle: PreviewServerHandle = {
			port: 0,
			localUrl: "http://127.0.0.1:0/",
			refresh: async () => ({
				bundle: { title: "t", root: "/r", generatedAt: 1 },
				capabilities: { feedback: true },
				items: [],
			}),
			shareInfo: () => null,
			enableShare: async () => {
				throw new Error("share disabled in test");
			},
			disableShare: () => {},
			stop: async () => {},
		};
		const startServer: StartPreviewServer = async options => {
			calls.push(options ?? {});
			return handle;
		};
		const delivered: PreviewFeedback[] = [];
		const tool = createPresentTool({
			startServer,
			deliverFeedback: feedback => {
				delivered.push(feedback);
			},
		});
		await tool.execute("call-1", { open: false });
		expect(calls).toHaveLength(1);
		expect(typeof calls[0]?.deliverFeedback).toBe("function");
		const sample: SideAskFeedback = {
			type: "side-ask",
			comment: "wired",
			from: "test",
			viaShare: false,
			ts: 1,
			source: "user",
		};
		calls[0]!.deliverFeedback!(sample);
		expect(delivered).toEqual([sample]);
	});

	it("slash command path enqueues PREVIEW_FEEDBACK_MESSAGE_TYPE via session.yieldQueue", async () => {
		const enqueued: Array<{ kind: string; entry: PreviewFeedback }> = [];
		const yieldQueue = {
			enqueue(kind: string, entry: PreviewFeedback) {
				enqueued.push({ kind, entry });
			},
		} as unknown as YieldQueue;

		const starts: PreviewServerOptions[] = [];
		const handle: PreviewServerHandle = {
			port: 4100,
			localUrl: "http://127.0.0.1:4100/",
			refresh: async () => ({
				bundle: { title: "t", root: "/r", generatedAt: 1 },
				capabilities: { feedback: true },
				items: [],
			}),
			shareInfo: () => null,
			enableShare: async () => ({
				shareUrl: "http://100.1.2.3:4100/?t=x",
				token: "x",
				host: "100.1.2.3",
				port: 4100,
			}),
			disableShare: () => {},
			stop: async () => {},
		};
		const startServer: StartPreviewServer = async options => {
			starts.push(options ?? {});
			return handle;
		};
		const shareController: ShareController = {
			enabled: () => false,
			enable: async () => ({
				shareUrl: "http://100.1.2.3:4100/?t=x",
				token: "x",
				host: "100.1.2.3",
				port: 4100,
			}),
			disable: () => {},
			verifyToken: () => false,
			mintExportToken: () => "export",
			consumeExportToken: () => false,
			handoffPrompt: () => "handoff",
		};

		const { slashCommand } = createProductPreviewCommand({
			startServer,
			makeShareController: () => shareController,
		});
		const handleCmd = slashCommand.handle;
		if (!handleCmd) throw new Error("expected slash handler");

		const runtime = {
			session: { yieldQueue },
			sessionManager: {},
			settings: {},
			cwd: "/tmp",
			output: async () => {},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;

		// Spy on the session seam (yieldQueue.enqueue) — never mock.module.
		const enqueueSpy = spyOn(yieldQueue, "enqueue");

		await handleCmd({ name: "product-preview", args: "", text: "/product-preview" }, runtime);

		expect(starts).toHaveLength(1);
		expect(typeof starts[0]?.deliverFeedback).toBe("function");

		const feedback: SideAskFeedback = {
			type: "side-ask",
			comment: "from slash",
			from: "peer",
			viaShare: true,
			ts: 9,
			source: "user",
		};
		starts[0]!.deliverFeedback!(feedback);

		expect(enqueueSpy).toHaveBeenCalled();
		expect(enqueued).toEqual([{ kind: PREVIEW_FEEDBACK_MESSAGE_TYPE, entry: feedback }]);
		expect(PREVIEW_FEEDBACK_MESSAGE_TYPE).toBe("preview-feedback");
	});

	it("slash re-invocation refreshes deliverFeedback on a reused server", async () => {
		const enqueuedA: Array<{ kind: string; entry: PreviewFeedback }> = [];
		const enqueuedB: Array<{ kind: string; entry: PreviewFeedback }> = [];
		const yieldQueueA = {
			enqueue(kind: string, entry: PreviewFeedback) {
				enqueuedA.push({ kind, entry });
			},
		} as unknown as YieldQueue;
		const yieldQueueB = {
			enqueue(kind: string, entry: PreviewFeedback) {
				enqueuedB.push({ kind, entry });
			},
		} as unknown as YieldQueue;

		const starts: PreviewServerOptions[] = [];
		const handle: PreviewServerHandle = {
			port: 4101,
			localUrl: "http://127.0.0.1:4101/",
			refresh: async () => ({
				bundle: { title: "t", root: "/r", generatedAt: 1 },
				capabilities: { feedback: true },
				items: [],
			}),
			shareInfo: () => null,
			enableShare: async () => ({
				shareUrl: "http://100.1.2.3:4101/?t=x",
				token: "x",
				host: "100.1.2.3",
				port: 4101,
			}),
			disableShare: () => {},
			stop: async () => {},
		};
		const startServer: StartPreviewServer = async options => {
			starts.push(options ?? {});
			return handle;
		};
		const shareController: ShareController = {
			enabled: () => false,
			enable: async () => ({
				shareUrl: "http://100.1.2.3:4101/?t=x",
				token: "x",
				host: "100.1.2.3",
				port: 4101,
			}),
			disable: () => {},
			verifyToken: () => false,
			mintExportToken: () => "export",
			consumeExportToken: () => false,
			handoffPrompt: () => "handoff",
		};

		const { slashCommand } = createProductPreviewCommand({
			startServer,
			makeShareController: () => shareController,
		});
		const handleCmd = slashCommand.handle;
		if (!handleCmd) throw new Error("expected slash handler");

		const runtimeA = {
			session: { yieldQueue: yieldQueueA },
			sessionManager: {},
			settings: {},
			cwd: "/tmp",
			output: async () => {},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		const runtimeB = {
			session: { yieldQueue: yieldQueueB },
			sessionManager: {},
			settings: {},
			cwd: "/tmp",
			output: async () => {},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;

		await handleCmd({ name: "product-preview", args: "", text: "/product-preview" }, runtimeA);
		await handleCmd({ name: "product-preview", args: "", text: "/product-preview" }, runtimeB);

		// Reused server: startServer called once, same options object mutated.
		expect(starts).toHaveLength(1);
		const deliver = starts[0]?.deliverFeedback;
		expect(typeof deliver).toBe("function");

		const feedback: SideAskFeedback = {
			type: "side-ask",
			comment: "after rebind",
			from: "peer",
			viaShare: false,
			ts: 11,
			source: "user",
		};
		deliver!(feedback);

		// Live hook must target session B, not the first invoker's queue.
		expect(enqueuedA).toEqual([]);
		expect(enqueuedB).toEqual([{ kind: PREVIEW_FEEDBACK_MESSAGE_TYPE, entry: feedback }]);
	});
});
