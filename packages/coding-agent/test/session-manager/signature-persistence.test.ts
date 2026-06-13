import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager, type SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBlobsDir, TempDir } from "@oh-my-pi/pi-utils";

function isAssistantSessionEntry(entry: unknown): entry is SessionMessageEntry & { message: AssistantMessage } {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "message" &&
		"message" in entry &&
		typeof entry.message === "object" &&
		entry.message !== null &&
		"role" in entry.message &&
		entry.message.role === "assistant"
	);
}

function getAssistantMessage(session: SessionManager): AssistantMessage {
	const assistantEntry = session.getEntries().find(isAssistantSessionEntry);
	if (!assistantEntry) throw new Error("Expected assistant message");
	return assistantEntry.message;
}

describe("SessionManager signature persistence", () => {
	it("clears oversized signatures instead of truncating them", async () => {
		using tempDir = TempDir.createSync("@pi-session-signature-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());

		session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "s".repeat(600_000) },
				{ type: "text", text: "done", textSignature: "m".repeat(600_000) },
				{ type: "toolCall", id: "tool_1", name: "read", arguments: {}, thoughtSignature: "t".repeat(600_000) },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		} satisfies AssistantMessage);
		await session.flush();

		const reloaded = await SessionManager.open(session.getSessionFile()!);
		const assistant = getAssistantMessage(reloaded);

		expect(assistant.content[0]).toMatchObject({ type: "thinking", thinking: "reasoning", thinkingSignature: "" });
		expect(assistant.content[1]).toMatchObject({ type: "text", text: "done", textSignature: "" });
		expect(assistant.content[2]).toMatchObject({ type: "toolCall", id: "tool_1", thoughtSignature: "" });
	});

	it("externalizes provider image data URLs and restores preserved history payloads across reload", async () => {
		using tempDir = TempDir.createSync("@pi-session-provider-image-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const largeImageUrl = `data:image/png;base64,${"a".repeat(600_000)}`;

		session.appendMessage({
			role: "user",
			content: "look at this",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai-codex",
				items: [
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: "look at this" },
							{ type: "input_image", detail: "auto", image_url: largeImageUrl },
						],
					},
				],
			},
			timestamp: 1,
		});
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		await session.flush();

		const expectedBlobHash = new Bun.SHA256().update(Buffer.from(largeImageUrl, "utf8")).digest("hex");
		const persistedBlob = await fs.readFile(path.join(getBlobsDir(), expectedBlobHash), "utf8");
		expect(persistedBlob).toBe(largeImageUrl);

		const reloaded = await SessionManager.open(session.getSessionFile()!);
		const reloadedUserEntry = reloaded
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (reloadedUserEntry?.type !== "message" || reloadedUserEntry.message.role !== "user") {
			throw new Error("Expected user message");
		}

		expect(reloadedUserEntry.message.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			items: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "look at this" },
						{ type: "input_image", detail: "auto", image_url: largeImageUrl },
					],
				},
			],
		});
	});

	it("externalizes snapcompact frame data and restores it across reload", async () => {
		using tempDir = TempDir.createSync("@pi-session-snapcompact-frame-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const frameData = Buffer.alloc(450_000, 7).toString("base64");

		const firstKeptEntryId = session.appendMessage({ role: "user", content: "after archive", timestamp: 1 });
		session.appendCompaction(
			"Archived history",
			"Archived 1 snapcompact frame",
			firstKeptEntryId,
			1000,
			undefined,
			false,
			{
				snapcompact: {
					frames: [
						{
							data: frameData,
							mimeType: "image/png",
							cols: 261,
							rows: 261,
							chars: 44951,
							font: "8x8",
							variant: "sent",
							lineRepeat: 1,
							detail: "original",
						},
					],
					totalChars: 44951,
					truncatedChars: 0,
				},
			},
		);
		await session.ensureOnDisk();
		await session.flush();

		const persisted = await fs.readFile(session.getSessionFile()!, "utf8");
		expect(persisted).not.toContain("[Session persistence truncated large content]");
		expect(persisted).not.toContain(frameData.slice(0, 1000));

		const reloaded = await SessionManager.open(session.getSessionFile()!);
		const summary = reloaded.buildSessionContext().messages.find(message => message.role === "compactionSummary");
		if (summary?.role !== "compactionSummary") throw new Error("Expected compaction summary");

		expect(summary.images).toEqual([
			{
				type: "image",
				data: frameData,
				mimeType: "image/png",
				detail: "original",
			},
		]);
	});

	it("rehydrates assistant replay metadata in memory without rewriting the session file", async () => {
		using tempDir = TempDir.createSync("@pi-session-rehydrate-persistence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const providerPayload = {
			type: "openaiResponsesHistory" as const,
			provider: "openai",
			items: [
				{ type: "reasoning", encrypted_content: "enc_stale" },
				{
					type: "message",
					role: "assistant",
					status: "completed",
					id: "msg_stale_snapshot",
					content: [{ type: "output_text", text: "done" }],
				},
			],
		};

		session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: JSON.stringify(providerPayload.items[0]) },
				{ type: "text", text: "done" },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			providerPayload,
			timestamp: 2,
		} satisfies AssistantMessage);
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const persistedBefore = await fs.readFile(sessionFile, "utf8");
		const initialMtimeMs = (await fs.stat(sessionFile)).mtimeMs;
		await session.close();

		const reloaded = await SessionManager.open(sessionFile);
		const assistant = getAssistantMessage(reloaded);

		// After rehydration, assistant providerPayload must be stripped to prevent
		// stale native history replay on warmed sessions.
		expect(assistant.providerPayload).toBeUndefined();
		expect(assistant.content[0]).toMatchObject({
			type: "thinking",
			thinking: "reasoning",
			thinkingSignature: undefined,
		});
		expect(await fs.readFile(sessionFile, "utf8")).toBe(persistedBefore);
		expect((await fs.stat(sessionFile)).mtimeMs).toBe(initialMtimeMs);
		await reloaded.close();
	});
});
