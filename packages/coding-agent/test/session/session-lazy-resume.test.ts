import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent, UserMessage } from "@oh-my-pi/pi-ai";
import { BlobStore, isBlobRef, parseBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { archiveEntries } from "@oh-my-pi/pi-coding-agent/session/entry-archival";
import {
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	loadSessionMessagesReadOnly,
	resolveBlobRefsInEntries,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { getAgentDir, getBlobsDir, logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const ISO = "2026-07-12T00:00:00.000Z";
const COLD_TEXT = "cold history ".repeat(50_000);
const COLD_IMAGE = Buffer.alloc(2_048, 1).toString("base64");
const KEPT_IMAGE = Buffer.alloc(2_048, 2).toString("base64");
const TAIL_IMAGE = Buffer.alloc(2_048, 3).toString("base64");
const FRAME_IMAGE = Buffer.alloc(2_048, 4).toString("base64");
const PROVIDER_IMAGE_URL = `data:image/png;base64,${Buffer.alloc(2_048, 5).toString("base64")}`;

interface Fixture {
	file: string;
	blobStore: BlobStore;
	coldTextOnDisk: string;
	coldImageRef: string;
	tailImageRef: string;
	providerImageRef: string;
}

let tempDir: TempDir | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
	tempDir = TempDir.createSync("@session-lazy-resume-");
	previousAgentDir = getAgentDir();
	setAgentDir(path.join(tempDir.path(), "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (previousAgentDir) setAgentDir(previousAgentDir);
	if (tempDir) await tempDir.remove();
	tempDir = undefined;
	previousAgentDir = undefined;
});

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function userEntry(id: string, parentId: string | null, content: UserMessage["content"]): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: ISO,
		message: { role: "user", content, timestamp: 0 },
	};
}

function structuredContent(entry: SessionMessageEntry): (TextContent | ImageContent)[] {
	const message = entry.message as { content?: unknown };
	if (!Array.isArray(message.content)) throw new Error("Expected structured message content");
	return message.content as (TextContent | ImageContent)[];
}

function messageImage(entry: SessionMessageEntry): ImageContent {
	const block = structuredContent(entry).find((candidate): candidate is ImageContent => candidate.type === "image");
	if (!block) throw new Error("Expected image block");
	return block;
}

function messageText(entry: SessionMessageEntry): string {
	const block = structuredContent(entry).find((candidate): candidate is TextContent => candidate.type === "text");
	if (!block) throw new Error("Expected text block");
	return block.text;
}

async function writeCompactedFixture(): Promise<Fixture> {
	if (!tempDir) throw new Error("Missing test temp directory");
	const blobStore = new BlobStore(getBlobsDir());
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "session",
		timestamp: ISO,
		cwd: tempDir.path(),
	};
	const cold = userEntry("cold", null, [text(COLD_TEXT), image(COLD_IMAGE)]);
	const providerImage: FileEntry = {
		type: "custom",
		id: "provider-image",
		parentId: cold.id,
		timestamp: ISO,
		customType: "provider-history",
		data: { image_url: PROVIDER_IMAGE_URL },
	};
	const kept = userEntry("kept", providerImage.id, [text("kept context"), image(KEPT_IMAGE)]);
	const compaction: CompactionEntry = {
		type: "compaction",
		id: "compaction",
		parentId: kept.id,
		timestamp: ISO,
		summary: "Compacted cold history",
		firstKeptEntryId: kept.id,
		tokensBefore: 1_000,
		preserveData: {
			snapcompact: {
				frames: [{ data: FRAME_IMAGE, mimeType: "image/png", cols: 10, rows: 10, chars: 100 }],
				totalChars: 100,
				truncatedChars: 0,
			},
		},
	};
	const tail = userEntry("tail", compaction.id, [text("tail context"), image(TAIL_IMAGE)]);
	const persisted = [header, cold, providerImage, kept, compaction, tail].map(entry =>
		prepareEntryForPersistence(entry, blobStore),
	);
	const persistedCold = persisted[1] as SessionMessageEntry;
	const persistedProviderImage = persisted[2] as Extract<FileEntry, { type: "custom" }>;
	const persistedTail = persisted[5] as SessionMessageEntry;
	const coldImageRef = messageImage(persistedCold).data;
	const tailImageRef = messageImage(persistedTail).data;
	const providerImageRef = (persistedProviderImage.data as { image_url?: unknown } | undefined)?.image_url;
	if (
		!isBlobRef(coldImageRef) ||
		!isBlobRef(tailImageRef) ||
		typeof providerImageRef !== "string" ||
		!isBlobRef(providerImageRef)
	) {
		throw new Error("Fixture did not persist image refs");
	}
	const file = path.join(tempDir.path(), "compacted.jsonl");
	await Bun.write(file, `${persisted.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return {
		file,
		blobStore,
		coldTextOnDisk: messageText(persistedCold),
		coldImageRef,
		tailImageRef,
		providerImageRef,
	};
}

function readMessage(manager: SessionManager, id: string): SessionMessageEntry {
	const entry = manager.getEntry(id);
	if (entry?.type !== "message") throw new Error(`Expected message entry ${id}`);
	return entry;
}

function readLatestFrame(manager: SessionManager): ImageContent {
	const entry = manager.getEntry("compaction");
	if (entry?.type !== "compaction") throw new Error("Expected compaction entry");
	const frames = (entry.preserveData as { snapcompact?: { frames?: ImageContent[] } } | undefined)?.snapcompact
		?.frames;
	const frame = frames?.[0];
	if (!frame) throw new Error("Expected snapcompact frame");
	return frame;
}

function expectNoBlobRefs(value: unknown): void {
	expect(JSON.stringify(value)).not.toContain("blob:sha256:");
}

describe("lazy session resume", () => {
	it("keeps entries before firstKeptEntryId cold while restoring the active compacted tail and latest frames", async () => {
		const fixture = await writeCompactedFixture();
		if (!tempDir) throw new Error("Missing test temp directory");
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));

		await manager.setSessionFile(fixture.file);

		expect(messageImage(readMessage(manager, "cold")).data).toBe(fixture.coldImageRef);
		expect(messageText(readMessage(manager, "cold"))).toBe(fixture.coldTextOnDisk);
		expect(messageImage(readMessage(manager, "kept")).data).toBe(KEPT_IMAGE);
		expect(messageImage(readMessage(manager, "tail")).data).toBe(TAIL_IMAGE);
		expect(readLatestFrame(manager).data).toBe(FRAME_IMAGE);
		expectNoBlobRefs(manager.buildSessionContext().messages);
	});

	it("loads old inline sessions unchanged when no compaction exists", async () => {
		if (!tempDir) throw new Error("Missing test temp directory");
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "inline-session",
			timestamp: ISO,
			cwd: tempDir.path(),
		};
		const inlineImage = Buffer.alloc(16, 9).toString("base64");
		const entry = userEntry("inline", null, [text("inline text"), image(inlineImage)]);
		const file = path.join(tempDir.path(), "inline.jsonl");
		await Bun.write(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));

		await manager.setSessionFile(file);

		expect(messageText(readMessage(manager, "inline"))).toBe("inline text");
		expect(messageImage(readMessage(manager, "inline")).data).toBe(inlineImage);
	});

	it("uses an empty placeholder for a missing tail blob without leaking a raw ref into context", async () => {
		const fixture = await writeCompactedFixture();
		const hash = parseBlobRef(fixture.tailImageRef);
		if (!tempDir || !hash) throw new Error("Expected tail blob hash");
		fs.rmSync(path.join(getBlobsDir(), hash));
		const warning = vi.spyOn(logger, "warn");
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));

		await manager.setSessionFile(fixture.file);

		expect(messageImage(readMessage(manager, "tail")).data).toBe("");
		expect(warning).toHaveBeenCalled();
		expectNoBlobRefs(manager.buildSessionContext().messages);
	});

	it("applies the same lazy boundary to forks and read-only message loading", async () => {
		const fixture = await writeCompactedFixture();
		if (!tempDir) throw new Error("Missing test temp directory");

		const forked = await SessionManager.forkFrom(
			fixture.file,
			tempDir.path(),
			path.join(tempDir.path(), "fork-sessions"),
		);
		expect(messageImage(readMessage(forked, "cold")).data).toBe(fixture.coldImageRef);
		expect(messageImage(readMessage(forked, "tail")).data).toBe(TAIL_IMAGE);

		const messages = await loadSessionMessagesReadOnly(fixture.file);
		expectNoBlobRefs(messages);
		const tail = messages.find(
			(message): message is Extract<AgentMessage, { role: "user" }> =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some(block => block.type === "text" && block.text === "tail context"),
		);
		if (!tail || !Array.isArray(tail.content)) throw new Error("Expected tail message in read-only context");
		const tailImage = tail.content.find((block): block is ImageContent => block.type === "image");
		expect(tailImage?.data).toBe(TAIL_IMAGE);
	});

	it("rehydrates archived text refs that enter the live path", async () => {
		const blobStore = new BlobStore(getBlobsDir());
		const archivedText = "archived text bytes";
		const textRef = blobStore.putSync(Buffer.from(archivedText, "utf8")).ref;
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "archived-text",
			timestamp: ISO,
			cwd: tempDir?.path() ?? "/tmp",
		};
		const entry = userEntry("text", null, [text(textRef)]);
		const entries: FileEntry[] = [header, entry];

		await resolveBlobRefsInEntries(entries, blobStore);

		expect(messageText(entries[1] as SessionMessageEntry)).toBe(archivedText);
	});

	it("rehydrates replication snapshots because remote collab guests do not share the host blob store", async () => {
		const fixture = await writeCompactedFixture();
		if (!tempDir) throw new Error("Missing test temp directory");
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		await manager.setSessionFile(fixture.file);
		archiveEntries(manager.getEntries(), fixture.blobStore);

		const snapshot = manager.snapshotForReplication();
		const cold = snapshot.entries.find(
			(entry): entry is SessionMessageEntry => entry.id === "cold" && entry.type === "message",
		);
		if (!cold) throw new Error("Expected cold entry in replication snapshot");

		expect(messageImage(cold).data).toBe(COLD_IMAGE);
		expect(messageText(cold)).toBe(fixture.coldTextOnDisk);
		expectNoBlobRefs(snapshot.entries);
	});

	it("rehydrates images across a resumed rollback boundary while leaving disk-truncated text truncated", async () => {
		const fixture = await writeCompactedFixture();
		if (!tempDir) throw new Error("Missing test temp directory");
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		await manager.setSessionFile(fixture.file);
		const snapshot = manager.captureState();
		const rollbackSnapshot = { ...snapshot, entries: snapshot.entries.filter(entry => entry.id === "cold") };

		manager.restoreState(rollbackSnapshot);
		expect(messageImage(readMessage(manager, "cold")).data).toBe(COLD_IMAGE);
		expect(messageText(readMessage(manager, "cold"))).toBe(fixture.coldTextOnDisk);
		expect(messageText(readMessage(manager, "cold"))).not.toBe(COLD_TEXT);
	});
});
