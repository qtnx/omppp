import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, UserMessage } from "@oh-my-pi/pi-ai";
import { getBlobsDir, logger, stringifyJson } from "@oh-my-pi/pi-utils";
import { BlobStore } from "../session/blob-store";
import type { SessionMessageEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { prepareEntryForPersistence } from "../session/session-persistence";
import { FileSessionStorage, type SessionStorageWriter } from "../session/session-storage";

/**
 * Reserved transcript stem for advisor session files. Chosen so it cannot
 * collide with a task subagent's `<id>.jsonl` (task ids are reserved against
 * this exact stem in {@link AgentOutputManager}).
 */
export const ADVISOR_TRANSCRIPT_STEM = "__advisor";
export const ADVISOR_TRANSCRIPT_FILENAME = `${ADVISOR_TRANSCRIPT_STEM}.jsonl`;

const JSONL_SUFFIX = ".jsonl";
const TRANSCRIPT_SCAN_CHUNK_BYTES = 64 * 1024;
const TRANSCRIPT_ENTRY_PREFIX_BYTES = 4 * 1024;
const transcriptPrefixDecoder = new TextDecoder("utf-8");

function extractPersistedEntryId(prefix: string): string | null {
	const idMarker = '"id":"';
	const parentIdMarker = '"parentId":';
	const idStart = prefix.indexOf(idMarker);
	const parentIdStart = prefix.indexOf(parentIdMarker);
	if (idStart < 0 || parentIdStart < idStart) return null;
	const valueStart = idStart + idMarker.length;
	const valueEnd = prefix.indexOf('"', valueStart);
	if (valueEnd < 0) return null;
	const id = prefix.slice(valueStart, valueEnd);
	return id && !id.includes("\\") ? id : null;
}

function isPersistedMetadataPrefix(prefix: string): boolean {
	return prefix.startsWith('{"type":"session",') || prefix.startsWith('{"type":"title",');
}

/**
 * Transcript filename for an advisor: `__advisor.jsonl` for the legacy/default
 * advisor (empty slug), `__advisor.<slug>.jsonl` for a named advisor. The `.`
 * separator keeps named files out of the output manager's `-<n>` bump namespace.
 */
export function advisorTranscriptFilename(slug: string): string {
	return slug ? `${ADVISOR_TRANSCRIPT_STEM}.${slug}${JSONL_SUFFIX}` : ADVISOR_TRANSCRIPT_FILENAME;
}

/** Whether a filename is any advisor transcript (`__advisor.jsonl` or `__advisor.<slug>.jsonl`). */
export function isAdvisorTranscriptName(name: string): boolean {
	return (
		name === ADVISOR_TRANSCRIPT_FILENAME ||
		(name.startsWith(`${ADVISOR_TRANSCRIPT_STEM}.`) && name.endsWith(JSONL_SUFFIX))
	);
}

/**
 * Append-only persister for an advisor agent's transcript.
 *
 * The advisor is a passive reviewer with its own model usage, so — like a task
 * subagent — its turns are written to a JSONL inside the owning session's
 * artifacts dir (`<session>/__advisor.jsonl`, `<session>/<SubId>/__advisor.jsonl`
 * for subagent advisors). That single file gives the advisor model proper usage
 * attribution in `omp stats` (the stats parser scans the session dir
 * recursively) and a read-only transcript in the Agent Hub, without making the
 * advisor a registered, messageable peer.
 *
 * The target is derived from the *session file* (`getSessionFile()`), never
 * `getArtifactsDir()` — subagents adopt the parent's artifact manager, so the
 * artifacts dir points at the parent root and every subagent advisor would
 * collide. The file path is resolved synchronously when a message finalizes and
 * captured for the queued write, so a `/new`, resume, or session switch in
 * flight can never misattribute an old advisor turn into the new session's file.
 * On such a switch the previous writer is closed and the new file opened on the
 * next recorded turn. The recorder never truncates: the advisor's in-memory
 * context resets/compacts independently, but every billed turn is appended here.
 */
export class AdvisorTranscriptRecorder {
	#writer: SessionStorageWriter | undefined;
	#file: string | undefined;
	#lastEntryId: string | null = null;
	#filename: string;
	readonly #storage = new FileSessionStorage();
	readonly #blobs = new BlobStore(getBlobsDir());
	/** Serializes async setup/close against appends so records land in order. */
	#queue: Promise<void>;

	/**
	 * @param filename Transcript filename within the session dir. Defaults to
	 *   `__advisor.jsonl`; named advisors pass `__advisor.<slug>.jsonl` via
	 *   {@link advisorTranscriptFilename}.
	 * @param after Optional barrier the queue starts behind — used on the advisor
	 *   on→off→on toggle so a fresh recorder's first `open` waits for the prior
	 *   recorder's `close` and the two never hold the same file at once.
	 */
	constructor(
		private readonly resolveSessionFile: () => string | undefined,
		private readonly resolveCwd: () => string,
		filename: string = ADVISOR_TRANSCRIPT_FILENAME,
		after?: Promise<unknown>,
	) {
		this.#filename = filename;
		this.#queue = after
			? after.then(
					() => {},
					() => {},
				)
			: Promise.resolve();
	}

	/**
	 * Persist one finalized advisor message. Assistant turns carry the usage the
	 * stats parser reads; tool results round out the Hub transcript; user deltas
	 * (the advisor's "session update" prompts) are persisted but flagged
	 * `synthetic`/agent-attributed so they never inflate user-message metrics.
	 * Non-conversational message kinds are skipped.
	 */
	record(message: AgentMessage): void {
		let persisted: Message;
		switch (message.role) {
			case "assistant":
			case "toolResult":
				persisted = message;
				break;
			case "user":
				// Clone so the live advisor message stays untouched; mark synthetic so
				// stats' user-message metrics skip these agent-internal review prompts.
				persisted = { ...(message as UserMessage), synthetic: true, attribution: "agent" };
				break;
			default:
				return;
		}
		const sessionFile = this.resolveSessionFile();
		if (!sessionFile?.endsWith(JSONL_SUFFIX)) return;
		const file = path.join(sessionFile.slice(0, -JSONL_SUFFIX.length), this.#filename);
		const cwd = this.resolveCwd();
		this.#enqueue(() => this.#append(file, cwd, persisted));
	}

	/** Flush pending writes (best-effort). */
	flush(): Promise<void> {
		return this.#enqueueResult(async () => {
			if (this.#writer) await this.#writer.flush();
		});
	}

	/** Flush and close the writer, releasing the session file. */
	close(): Promise<void> {
		return this.#enqueueResult(() => this.#closeWriter());
	}

	async #append(file: string, cwd: string, message: Message): Promise<void> {
		if (file !== this.#file) {
			await this.#closeWriter();
			const fileExists = await this.#storage.exists(file);
			if (!fileExists || this.#storage.statSync(file).size === 0) {
				const manager = await SessionManager.open(file, undefined, this.#storage, {
					initialCwd: cwd,
					suppressBreadcrumb: true,
				});
				try {
					this.#lastEntryId = manager.appendMessage(message);
					await manager.flush();
				} finally {
					await manager.close();
				}
				this.#writer = this.#storage.openWriter(file, { flags: "a" });
				this.#file = file;
				return;
			}
			this.#lastEntryId = await this.#prepareExistingTail(file);
			this.#writer = this.#storage.openWriter(file, { flags: "a" });
			this.#file = file;
		}

		const entry: SessionMessageEntry = {
			type: "message",
			id: Bun.randomUUIDv7(),
			parentId: this.#lastEntryId,
			timestamp: new Date().toISOString(),
			message,
		};
		const line = `${stringifyJson(prepareEntryForPersistence(entry, this.#blobs)) ?? "null"}\n`;
		const writer = this.#writer;
		if (!writer) throw new Error("Advisor transcript writer is unavailable");
		await writer.append(line);
		this.#lastEntryId = entry.id;
	}

	async #prepareExistingTail(file: string): Promise<string | null> {
		const expectedSize = this.#storage.statSync(file).size;
		let lineEnd = await this.#trimTrailingLineBreaks(file, expectedSize);
		let trailingCorruption = false;
		let truncateTo: number | null = null;
		while (lineEnd > 0) {
			const lineStart = await this.#findLineStart(file, lineEnd);
			const contentEnd = await this.#trimTrailingHorizontalWhitespace(file, lineStart, lineEnd);
			const lineLength = contentEnd - lineStart;
			const prefixLength = Math.min(TRANSCRIPT_ENTRY_PREFIX_BYTES, lineLength);
			const prefixBytes = await this.#storage.readBytes(file, lineStart, prefixLength);
			const finalByte =
				contentEnd > lineStart ? await this.#storage.readBytes(file, contentEnd - 1, 1) : new Uint8Array();
			let validRecord = false;
			if (finalByte[0] === 125) {
				const prefix = transcriptPrefixDecoder.decode(prefixBytes);
				const id = extractPersistedEntryId(prefix);
				if (id !== null) {
					if (!trailingCorruption) return id;
					const boundary = truncateTo ?? (await this.#lineTerminatorEnd(file, lineEnd, expectedSize));
					return this.#truncateCorruptTail(file, expectedSize, boundary, id);
				}
				if (isPersistedMetadataPrefix(prefix)) {
					validRecord = true;
				} else if (prefixLength === lineLength) {
					try {
						JSON.parse(prefix);
						validRecord = true;
					} catch {
						// A complete-looking but invalid record is still trailing corruption.
					}
				}
			}
			if (validRecord) {
				if (trailingCorruption && truncateTo === null) {
					truncateTo = await this.#lineTerminatorEnd(file, lineEnd, expectedSize);
				}
			} else {
				trailingCorruption = true;
			}
			lineEnd = await this.#trimTrailingLineBreaks(file, lineStart);
		}
		if (trailingCorruption) {
			if (truncateTo === null) throw new Error(`Advisor transcript has no valid JSONL records: ${file}`);
			return this.#truncateCorruptTail(file, expectedSize, truncateTo, null);
		}
		return null;
	}

	async #lineTerminatorEnd(file: string, lineEnd: number, fileSize: number): Promise<number> {
		const terminator = await this.#storage.readBytes(file, lineEnd, Math.min(2, fileSize - lineEnd));
		let boundary = lineEnd;
		for (const byte of terminator) {
			if (byte !== 10 && byte !== 13) break;
			boundary++;
		}
		return boundary;
	}

	async #truncateCorruptTail(
		file: string,
		expectedSize: number,
		truncateTo: number,
		lastEntryId: string | null,
	): Promise<string | null> {
		if (this.#storage.statSync(file).size !== expectedSize) return this.#prepareExistingTail(file);
		await this.#storage.truncate(file, truncateTo);
		return lastEntryId;
	}

	async #trimTrailingHorizontalWhitespace(file: string, start: number, end: number): Promise<number> {
		let cursor = end;
		while (cursor > start) {
			const chunkStart = Math.max(start, cursor - TRANSCRIPT_SCAN_CHUNK_BYTES);
			const chunk = await this.#storage.readBytes(file, chunkStart, cursor - chunkStart);
			for (let index = chunk.length - 1; index >= 0; index--) {
				if (chunk[index] !== 9 && chunk[index] !== 32) return chunkStart + index + 1;
			}
			cursor = chunkStart;
		}
		return start;
	}

	async #trimTrailingLineBreaks(file: string, end: number): Promise<number> {
		let cursor = end;
		while (cursor > 0) {
			const start = Math.max(0, cursor - TRANSCRIPT_SCAN_CHUNK_BYTES);
			const chunk = await this.#storage.readBytes(file, start, cursor - start);
			for (let index = chunk.length - 1; index >= 0; index--) {
				if (chunk[index] !== 10 && chunk[index] !== 13) return start + index + 1;
			}
			cursor = start;
		}
		return 0;
	}

	async #findLineStart(file: string, lineEnd: number): Promise<number> {
		let cursor = lineEnd;
		while (cursor > 0) {
			const start = Math.max(0, cursor - TRANSCRIPT_SCAN_CHUNK_BYTES);
			const chunk = await this.#storage.readBytes(file, start, cursor - start);
			for (let index = chunk.length - 1; index >= 0; index--) {
				if (chunk[index] === 10) return start + index + 1;
			}
			cursor = start;
		}
		return 0;
	}

	async #closeWriter(): Promise<void> {
		const writer = this.#writer;
		this.#writer = undefined;
		this.#file = undefined;
		this.#lastEntryId = null;
		if (!writer) return;
		try {
			await writer.close();
		} catch (err) {
			logger.debug("advisor transcript close failed", { err: String(err) });
		}
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work, work).catch(err => {
			logger.debug("advisor transcript record failed", { err: String(err) });
		});
	}

	#enqueueResult(work: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => {});
		return next;
	}
}
