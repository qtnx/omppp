import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { buildSessionData } from "@oh-my-pi/pi-coding-agent/export/html";
import { buildShareSnapshot, SERVER_MAX_SEALED_BYTES, sealToFit } from "@oh-my-pi/pi-coding-agent/export/share";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { formatSessionDumpText } from "@oh-my-pi/pi-coding-agent/session/session-dump-format";
import type { SessionEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getBlobsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const PNG_BYTES = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
	0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4,
	0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const PNG_B64 = PNG_BYTES.toString("base64");
const ARCHIVED_TEXT = "archived tool output that should resolve for dump and export";

const IV_LENGTH = 12;

async function makeKey(): Promise<CryptoKey> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function open(key: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<unknown> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: sealed.subarray(0, IV_LENGTH) },
		key,
		sealed.subarray(IV_LENGTH),
	);
	return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(plain))));
}

function header(): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "t",
		timestamp: "2026-07-12T00:00:00.000Z",
		cwd: "/tmp",
	};
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-12T00:00:00.000Z",
		message,
	} as SessionEntry;
}

describe("export/share/dump blob-ref consumer guards", () => {
	let previousAgentDir: string | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		if (previousAgentDir !== undefined) setAgentDir(previousAgentDir);
		previousAgentDir = undefined;
		if (tempDir) await tempDir.remove();
		tempDir = undefined;
	});

	function withAgentBlobs(): BlobStore {
		tempDir = TempDir.createSync("@export-blob-guard-");
		previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		fs.mkdirSync(getBlobsDir(), { recursive: true });
		return new BlobStore(getBlobsDir());
	}

	function smWith(entries: SessionEntry[], leafId: string): SessionManager {
		return {
			getHeader: () => header(),
			getEntries: () => entries,
			getLeafId: () => leafId,
		} as unknown as SessionManager;
	}

	it("buildSessionData resolves present image and text blob refs", () => {
		const blobs = withAgentBlobs();
		const imageRef = blobs.putSync(PNG_BYTES, { extension: "png" }).ref;
		const textRef = blobs.putSync(Buffer.from(ARCHIVED_TEXT, "utf8")).ref;
		expect(isBlobRef(imageRef)).toBe(true);
		expect(isBlobRef(textRef)).toBe(true);

		const entries = [
			messageEntry("u1", null, {
				role: "user",
				content: [
					{ type: "text", text: "caption" } satisfies TextContent,
					{ type: "image", data: imageRef, mimeType: "image/png" } satisfies ImageContent,
				],
				timestamp: 1,
			} as AgentMessage),
			messageEntry("t1", "u1", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: textRef } satisfies TextContent],
				isError: false,
				timestamp: 2,
			} as AgentMessage),
		];

		const data = buildSessionData(smWith(entries, "t1"));
		const flat = JSON.stringify(data);
		expect(flat).not.toContain("blob:sha256:");
		expect(flat).toContain(PNG_B64);
		expect(flat).toContain(ARCHIVED_TEXT);
	});

	it("buildSessionData substitutes placeholders when blobs are missing", () => {
		withAgentBlobs();
		const missingImage = `blob:sha256:${"b".repeat(64)}`;
		const missingText = `blob:sha256:${"c".repeat(64)}`;
		const entries = [
			messageEntry("u1", null, {
				role: "user",
				content: [
					{ type: "text", text: "hi" },
					{ type: "image", data: missingImage, mimeType: "image/png" },
				],
				timestamp: 1,
			} as AgentMessage),
			messageEntry("t1", "u1", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: missingText }],
				isError: false,
				timestamp: 2,
			} as AgentMessage),
		];

		expect(() => buildSessionData(smWith(entries, "t1"))).not.toThrow();
		const data = buildSessionData(smWith(entries, "t1"));
		const flat = JSON.stringify(data);
		expect(flat).not.toContain("blob:sha256:");
		expect(flat).toContain("[image unavailable]");
		expect(flat).toContain("[content archived]");
	});

	it("buildShareSnapshot resolves present refs and never ships raw blob refs", () => {
		const blobs = withAgentBlobs();
		const imageRef = blobs.putSync(PNG_BYTES, { extension: "png" }).ref;
		const textRef = blobs.putSync(Buffer.from(ARCHIVED_TEXT, "utf8")).ref;
		const entries = [
			messageEntry("u1", null, {
				role: "user",
				content: [
					{ type: "text", text: "see" },
					{ type: "image", data: imageRef, mimeType: "image/png" },
				],
				timestamp: 1,
			} as AgentMessage),
			messageEntry("t1", "u1", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: textRef }],
				isError: false,
				timestamp: 2,
			} as AgentMessage),
		];

		const snapshot = buildShareSnapshot(smWith(entries, "t1"));
		const flat = JSON.stringify(snapshot);
		expect(flat).not.toContain("blob:sha256:");
		expect(flat).toContain(PNG_B64);
		expect(flat).toContain(ARCHIVED_TEXT);
	});

	it("sealToFit still works when image data is a short blob ref (treat as omitable image)", async () => {
		withAgentBlobs();
		// After resolve-or-placeholder, missing becomes placeholder text; present becomes base64.
		// This asserts the size-trim path does not choke if a short blob ref somehow remains.
		const key = await makeKey();
		const missingImage = `blob:sha256:${"d".repeat(64)}`;
		const entries = [
			messageEntry("u1", null, {
				role: "user",
				content: [
					{ type: "text", text: "keep" },
					{ type: "image", data: missingImage, mimeType: "image/png" },
				],
				timestamp: 1,
			} as AgentMessage),
		];
		const snapshot = buildShareSnapshot(smWith(entries, "u1"));
		const { sealed } = await sealToFit(key, snapshot, SERVER_MAX_SEALED_BYTES);
		const opened = await open(key, sealed);
		const flat = JSON.stringify(opened);
		expect(flat).not.toContain("blob:sha256:");
		expect(flat).toContain("keep");
	});

	it("formatSessionDumpText resolves text blob refs and placeholders missing ones", () => {
		const blobs = withAgentBlobs();
		const textRef = blobs.putSync(Buffer.from(ARCHIVED_TEXT, "utf8")).ref;
		const missingText = `blob:sha256:${"e".repeat(64)}`;

		const present = formatSessionDumpText({
			messages: [
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [{ type: "text", text: textRef }],
					isError: false,
					timestamp: 1,
				} as AgentMessage,
			],
		});
		expect(present).toContain(ARCHIVED_TEXT);
		expect(present).not.toContain("blob:sha256:");

		const missing = formatSessionDumpText({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: missingText }],
					timestamp: 1,
				} as AgentMessage,
			],
		});
		expect(missing).toContain("[content archived]");
		expect(missing).not.toContain("blob:sha256:");
	});

	it("formatSessionDumpText leaves inline text and image markers unchanged", () => {
		withAgentBlobs();
		const out = formatSessionDumpText({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hello world" },
						{ type: "image", data: PNG_B64, mimeType: "image/png" },
					],
					timestamp: 1,
				} as AgentMessage,
			],
		});
		expect(out).toContain("hello world");
		expect(out).toContain("[Image]");
		expect(out).not.toContain("blob:sha256:");
	});
});
