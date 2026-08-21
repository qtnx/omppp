import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault, getEnumValues, getUi } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

type PromptOptions = { streamingBehavior?: "steer" | "followUp" };

function makeContext(options: { messageDelivery?: "steer" | "queue"; isCompacting?: boolean } = {}) {
	const prompt = vi.fn(async (_text: string, _options?: PromptOptions) => {});
	const queueCompactionMessage = vi.fn();
	let editorText = "";
	const editor = {
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		addToHistory: vi.fn(),
		setText: (text: string) => {
			editorText = text;
		},
		getText: () => editorText,
		clearDraft: vi.fn((historyText?: string) => {
			if (historyText !== undefined) editor.addToHistory(historyText);
			editorText = "";
			editor.pendingImages = [];
			editor.pendingImageLinks = [];
			editor.imageLinks = undefined;
		}),
	};
	const settings = Settings.isolated(
		options.messageDelivery === undefined ? {} : { messageDelivery: options.messageDelivery },
	);
	const ctx = {
		editor,
		settings,
		ui: { requestRender: vi.fn() },
		session: {
			isStreaming: true,
			isCompacting: options.isCompacting ?? false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			prompt,
		},
		compactionQueuedMessages: [],
		queueCompactionMessage,
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async <T>(_text: string, callback: () => Promise<T>) => callback(),
		updatePendingMessagesDisplay: vi.fn(),
		showError: vi.fn(),
		loopModeEnabled: false,
		focusedAgentId: undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, prompt, queueCompactionMessage };
}

describe("message delivery setting", () => {
	it("defines queue as the default interaction channel", () => {
		expect(getDefault("messageDelivery")).toBe("queue");
		expect(getEnumValues("messageDelivery")).toEqual(["steer", "queue"]);
		expect(getUi("messageDelivery")).toMatchObject({
			label: "Message Delivery",
			tab: "interaction",
		});
	});

	it("routes ordinary streaming input through the default follow-up queue", async () => {
		const { ctx, prompt } = makeContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("send after this turn");

		expect(prompt).toHaveBeenCalledWith("send after this turn", {
			streamingBehavior: "followUp",
			images: undefined,
		});
	});

	it("routes ordinary streaming input through the follow-up behavior when queued", async () => {
		const { ctx, prompt } = makeContext({ messageDelivery: "queue" });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("send after this turn");

		expect(prompt).toHaveBeenCalledWith("send after this turn", {
			streamingBehavior: "followUp",
			images: undefined,
		});
	});

	it("uses the selected channel for ordinary input queued during compaction", async () => {
		const { ctx, queueCompactionMessage } = makeContext({ messageDelivery: "queue", isCompacting: true });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("send after compaction");

		expect(queueCompactionMessage).toHaveBeenCalledWith("send after compaction", "followUp", undefined);
	});
});
