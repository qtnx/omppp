import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, ImageContent, TextContent, ThinkingContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { BlobStore, isBlobRef, parseBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import {
	archiveEntries,
	rehydrateEntries,
	TEXT_ARCHIVE_THRESHOLD,
} from "@oh-my-pi/pi-coding-agent/session/entry-archival";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { getAgentDir, getBlobsDir, logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const text = (value: string): TextContent => ({ type: "text", text: value });
const image = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const heavyText = (character: string = "t"): string => character.repeat(TEXT_ARCHIVE_THRESHOLD + 1);
const imageData = (byte: number = 1): string => Buffer.alloc(2 * 1024 * 1024, byte).toString("base64");

function userEntry(
	id: string,
	parentId: string | null,
	content: Array<TextContent | ImageContent> | string,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content, timestamp: 0 },
	};
}

function toolEntry(id: string, parentId: string | null, body: string, png: string): SessionMessageEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: `${id}-call`,
		toolName: "read",
		content: [text(body), image(png)],
		details: { images: [{ data: png, mimeType: "image/png" }] },
		isError: false,
		timestamp: 0,
	};
	return { type: "message", id, parentId, timestamp: new Date(0).toISOString(), message };
}

function assistantEntry(id: string, signature: string, encryptedContent: string): SessionMessageEntry {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reasoning", thinkingSignature: signature },
			{ type: "text", text: "done" },
		],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.2-codex",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			items: [{ type: "reasoning", id: "response-reasoning", encrypted_content: encryptedContent }],
		},
		timestamp: 0,
	} satisfies AssistantMessage;
	return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message };
}

function compactionEntry(id: string, parentId: string | null, frame: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		summary: "summary",
		firstKeptEntryId: "tail",
		tokensBefore: 1,
		preserveData: {
			snapcompact: {
				frames: [{ data: frame, mimeType: "image/png", cols: 8, rows: 8, chars: 64 }],
			},
		},
	};
}

function textContent(entry: SessionMessageEntry): string {
	if (!("content" in entry.message) || !Array.isArray(entry.message.content)) {
		throw new Error("expected block content");
	}
	for (const block of entry.message.content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			return block.text;
		}
	}
	throw new Error("expected text block");
}

function imageContent(entry: SessionMessageEntry): string {
	if (!("content" in entry.message) || !Array.isArray(entry.message.content)) {
		throw new Error("expected block content");
	}
	for (const block of entry.message.content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "image" &&
			"data" in block &&
			typeof block.data === "string"
		) {
			return block.data;
		}
	}
	throw new Error("expected image block");
}

function frameData(entry: SessionEntry): string {
	if (entry.type !== "compaction") throw new Error("expected compaction entry");
	const archive = entry.preserveData?.snapcompact;
	if (!archive || typeof archive !== "object" || !("frames" in archive) || !Array.isArray(archive.frames)) {
		throw new Error("expected snapcompact frames");
	}
	const frame = archive.frames[0];
	if (!frame || typeof frame !== "object" || !("data" in frame) || typeof frame.data !== "string") {
		throw new Error("expected snapcompact frame data");
	}
	return frame.data;
}

describe("reversible session entry archival", () => {
	afterEach(() => {
		// Logger spies are process-global; restore after each missing-blob assertion.
		vi.restoreAllMocks();
	});
	it("swaps only cold heavy leaves to refs and rehydrates byte-identically", () => {
		using tempDir = TempDir.createSync("@omp-session-archive-");
		const blobs = new BlobStore(tempDir.path());
		const body = heavyText();
		const png = imageData();
		const frame = imageData(2);
		const coldMessage = toolEntry("cold", null, body, png);
		const superseded = compactionEntry("old-compaction", "cold", frame);
		const tail = userEntry("tail", "old-compaction", [text(heavyText("z")), image(imageData(3))]);
		const entries: SessionEntry[] = [coldMessage, superseded, tail];
		const original = structuredClone(entries);
		const bytesBeforeArchive = Buffer.byteLength(JSON.stringify(entries));

		archiveEntries(entries.slice(0, 2), blobs);

		expect(isBlobRef(textContent(coldMessage))).toBe(true);
		expect(isBlobRef(imageContent(coldMessage))).toBe(true);
		const details = coldMessage.message.role === "toolResult" ? coldMessage.message.details : undefined;
		expect(details).toEqual({ images: [{ data: expect.stringMatching(/^blob:sha256:/), mimeType: "image/png" }] });
		expect(isBlobRef(frameData(superseded))).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(entries))).toBeLessThan(bytesBeforeArchive);
		expect(textContent(tail)).toBe(heavyText("z"));
		expect(imageContent(tail)).toBe(imageData(3));

		rehydrateEntries(entries.slice(0, 2), blobs);
		expect(entries).toEqual(original);
		expect(Buffer.byteLength(JSON.stringify(entries))).toBe(bytesBeforeArchive);
	});

	it("archives each completed compaction boundary and rehydrates a rewound active path", () => {
		using tempDir = TempDir.createSync("@omp-session-archive-manager-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		try {
			const manager = SessionManager.create(
				path.join(tempDir.path(), "project"),
				path.join(tempDir.path(), "sessions"),
			);
			const originalText = heavyText();
			const originalImage = imageData();
			const messageId = manager.appendMessage({
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [text(originalText), image(originalImage)],
				isError: false,
				timestamp: 0,
			});

			const keptId = manager.appendMessage({ role: "user", content: "kept-inline", timestamp: 1 });
			manager.appendCompaction("first", undefined, keptId, 1);
			const archived = manager.getEntry(messageId);
			if (archived?.type !== "message") throw new Error("expected archived message");
			expect(textContent(archived)).toMatch(/^blob:sha256:/);
			expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("blob:sha256:");
			const afterFirstId = manager.appendMessage({ role: "user", content: "after-first", timestamp: 2 });
			manager.appendCompaction("second", undefined, afterFirstId, 1);
			const afterSecondId = manager.appendMessage({ role: "user", content: "after-second", timestamp: 3 });
			manager.appendCompaction("third", undefined, afterSecondId, 1);

			const contextText = JSON.stringify(manager.buildSessionContext().messages);
			expect(contextText).not.toContain("blob:sha256:");
			manager.branch(messageId);
			const restored = manager.getEntry(messageId);
			if (restored?.type !== "message") throw new Error("expected restored message");
			expect(textContent(restored)).toBe(originalText);
			expect(imageContent(restored)).toBe(originalImage);
			expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("blob:sha256:");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("rehydrates a snapshot restored across an archival boundary", () => {
		using tempDir = TempDir.createSync("@omp-session-archive-rollback-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		try {
			const manager = SessionManager.create(
				path.join(tempDir.path(), "project"),
				path.join(tempDir.path(), "sessions"),
			);
			const originalText = heavyText("r");
			const originalImage = imageData(4);
			const messageId = manager.appendMessage({
				role: "toolResult",
				toolCallId: "rollback-tool",
				toolName: "read",
				content: [text(originalText), image(originalImage)],
				isError: false,
				timestamp: 0,
			});
			const snapshot = manager.captureState();
			const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
			manager.appendCompaction("summary", undefined, keptId, 1);

			manager.restoreState(snapshot);

			const restored = manager.getEntry(messageId);
			if (restored?.type !== "message") throw new Error("expected restored message");
			expect(textContent(restored)).toBe(originalText);
			expect(imageContent(restored)).toBe(originalImage);
			expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("blob:sha256:");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("archives cold string content, thinking signatures, and custom image payloads reversibly", () => {
		using tempDir = TempDir.createSync("@omp-session-archive-scope-");
		const blobs = new BlobStore(tempDir.path());
		const assistant = assistantEntry(
			"reasoning",
			"s".repeat(TEXT_ARCHIVE_THRESHOLD + 1),
			"p".repeat(TEXT_ARCHIVE_THRESHOLD + 1),
		);
		const stringContent = userEntry("cold-string", "reasoning", heavyText("u"));
		const custom: SessionEntry = {
			type: "custom",
			id: "custom",
			parentId: "cold-string",
			timestamp: new Date(0).toISOString(),
			customType: "fixture",
			data: {
				note: heavyText("c"),
				nested: [{ image_url: `data:image/png;base64,${imageData(6)}` }],
				image: { type: "image", data: imageData(7), mimeType: "image/png" },
			},
		};
		const entries: SessionEntry[] = [assistant, stringContent, custom];
		const original = structuredClone(entries);

		archiveEntries(entries, blobs);

		const thinking = (assistant.message as AssistantMessage).content[0] as ThinkingContent;
		expect(isBlobRef(thinking.thinking)).toBe(false);
		expect(isBlobRef(thinking.thinkingSignature ?? "")).toBe(true);
		const archivedUserContent =
			"content" in stringContent.message && typeof stringContent.message.content === "string"
				? stringContent.message.content
				: "";
		expect(isBlobRef(archivedUserContent)).toBe(true);
		const data = custom.data as { note: string; nested: Array<{ image_url: string }>; image: { data: string } };
		expect(data.note).toBe(heavyText("c"));
		expect(isBlobRef(data.nested[0]?.image_url ?? "")).toBe(true);
		expect(isBlobRef(data.image.data)).toBe(true);
		expect(JSON.stringify((assistant.message as AssistantMessage).providerPayload)).not.toContain("blob:sha256:");

		rehydrateEntries(entries, blobs);
		expect(entries).toEqual(original);
	});

	it("degrades missing blobs without leaking raw refs", () => {
		using tempDir = TempDir.createSync("@omp-session-archive-missing-");
		const blobs = new BlobStore(tempDir.path());
		const entry = toolEntry("missing", null, heavyText(), imageData());
		archiveEntries([entry], blobs);
		const textRef = textContent(entry);
		const imageRef = imageContent(entry);
		const textHash = parseBlobRef(textRef);
		const imageHash = parseBlobRef(imageRef);
		if (!textHash || !imageHash) throw new Error("expected blob refs");
		const warn = vi.spyOn(logger, "warn");
		fs.unlinkSync(path.join(tempDir.path(), textHash));
		fs.unlinkSync(path.join(tempDir.path(), imageHash));

		rehydrateEntries([entry], blobs);

		expect(textContent(entry)).toBe("[content archived]");
		expect(imageContent(entry)).toBe("");
		expect(warn).toHaveBeenCalledWith("Blob not found for archived session text", { hash: textHash });
		expect(warn).toHaveBeenCalledWith("Blob not found for archived session image", { hash: imageHash });
		expect(JSON.stringify(entry)).not.toContain("blob:sha256:");
	});

	it("keeps missing archived blobs out of rebuilt context", () => {
		using tempDir = TempDir.createSync("@omp-session-archive-missing-context-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		try {
			const manager = SessionManager.create(
				path.join(tempDir.path(), "project"),
				path.join(tempDir.path(), "sessions"),
			);
			const messageId = manager.appendMessage({
				role: "toolResult",
				toolCallId: "missing-context-tool",
				toolName: "read",
				content: [text(heavyText()), image(imageData())],
				isError: false,
				timestamp: 0,
			});
			const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
			manager.appendCompaction("summary", undefined, keptId, 1);
			const archived = manager.getEntry(messageId);
			if (archived?.type !== "message") throw new Error("expected archived message");
			const textHash = parseBlobRef(textContent(archived));
			const imageHash = parseBlobRef(imageContent(archived));
			if (!textHash || !imageHash) throw new Error("expected blob refs");
			fs.unlinkSync(path.join(getBlobsDir(), textHash));
			fs.unlinkSync(path.join(getBlobsDir(), imageHash));

			manager.branch(messageId);

			expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("blob:sha256:");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("persists archived text as today’s truncated text while retaining image refs", () => {
		using tempDir = TempDir.createSync("@omp-session-archive-persist-");
		const blobs = new BlobStore(tempDir.path());
		const entry = toolEntry("persist", null, "x".repeat(600_000), imageData());
		archiveEntries([entry], blobs);
		const persisted = prepareEntryForPersistence(entry, blobs);
		const serialized = JSON.stringify(persisted);
		const persistedMessage = persisted.type === "message" ? persisted : undefined;
		if (!persistedMessage) throw new Error("expected persisted message");

		expect(serialized).not.toContain('"text":"blob:sha256:');
		expect(serialized).toContain("[Session persistence truncated large content]");
		expect(imageContent(persistedMessage)).toMatch(/^blob:sha256:/);
	});

	it("persists archived string content and signed thinking as full text, never refs", () => {
		using tempDir = TempDir.createSync("@omp-session-archive-persist-refs-");
		const blobs = new BlobStore(tempDir.path());
		const signature = "s".repeat(TEXT_ARCHIVE_THRESHOLD + 1);
		const assistant = assistantEntry("signed", signature, "p".repeat(TEXT_ARCHIVE_THRESHOLD + 1));
		const stringContent = userEntry("cold-string", null, heavyText("u"));
		const custom: SessionEntry = {
			type: "custom",
			id: "custom-persist",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: "fixture",
			data: { nested: [{ image_url: `data:image/png;base64,${imageData(9)}` }] },
		};
		archiveEntries([assistant, stringContent, custom], blobs);

		const persistedAssistant = prepareEntryForPersistence(assistant, blobs) as SessionMessageEntry;
		const signedBlock = (persistedAssistant.message as AssistantMessage).content[0] as ThinkingContent;
		expect(signedBlock.thinkingSignature).toBe(signature);
		expect(signedBlock.thinking).toBe("reasoning");

		const persistedUser = prepareEntryForPersistence(stringContent, blobs) as SessionMessageEntry;
		const persistedUserContent =
			"content" in persistedUser.message && typeof persistedUser.message.content === "string"
				? persistedUser.message.content
				: "";
		expect(persistedUserContent).toBe(heavyText("u"));

		expect(JSON.stringify(prepareEntryForPersistence(custom, blobs))).toContain('"image_url":"blob:sha256:');
	});
});
