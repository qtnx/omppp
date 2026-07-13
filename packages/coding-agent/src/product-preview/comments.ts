import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { PreviewComment, PreviewCommentReply } from "./types";

const STATE_VERSION = 1;
const STATE_DIR = ".ompx-preview";
const STATE_FILE = "state.json";
const STATE_TMP = "state.json.tmp";

const MAX_COMMENT_RECEIPTS = 256;

export interface StoredAnswer {
	selection: string[];
	author: string;
	ts: number;
	itemId?: string;
}

export type CommentMutationEndpoint = "create" | "reply" | "resolve";

export interface CommentMutationReceipt {
	scope: string;
	requestId: string;
	endpoint: CommentMutationEndpoint;
	fingerprint: string;
	comment: PreviewComment;
}

export type CommentMutationResult =
	| { kind: "applied"; comment: PreviewComment | null }
	| { kind: "replayed"; comment: PreviewComment }
	| { kind: "conflict" }
	/** The serialized precondition failed; no durable state was written. */
	| { kind: "rejected" };

interface StateShape {
	version: number;
	comments: PreviewComment[];
	answers: Record<string, StoredAnswer>;
	/** Bounded, per-viewer idempotency receipts for steering comment mutations. */
	receipts: CommentMutationReceipt[];
}

function emptyState(): StateShape {
	return { version: STATE_VERSION, comments: [], answers: {}, receipts: [] };
}

/** Test seam for atomic write failures — production path uses Bun.write. */
export async function writePreviewStateTmp(tmpPath: string, json: string): Promise<number> {
	return await Bun.write(tmpPath, json);
}

/** Test seam for atomic rename failures — production path uses fs.rename. */
export async function renamePreviewStateFile(tmpPath: string, finalPath: string): Promise<void> {
	await fs.rename(tmpPath, finalPath);
}

/**
 * Transactional comment/answer store. `#committed` is the only readable state and
 * always matches the last durable file write. Mutations never touch `#committed`
 * until the atomic rename succeeds.
 */
export class PreviewCommentStore {
	#root: string;
	#committed: StateShape;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(root: string, committed: StateShape) {
		this.#root = root;
		this.#committed = committed;
	}

	static async load(root: string): Promise<PreviewCommentStore> {
		const dir = path.join(root, STATE_DIR);
		const finalPath = path.join(dir, STATE_FILE);
		const tmpPath = path.join(dir, STATE_TMP);

		// Leftover tmp from a crashed write is never authoritative — drop it.
		try {
			await fs.unlink(tmpPath);
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("product preview comment store: failed to remove leftover tmp", {
					path: tmpPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		try {
			const raw = await Bun.file(finalPath).text();
			const parsed = JSON.parse(raw) as unknown;
			const normalized = normalizeState(parsed);
			if (!normalized) {
				logger.warn("product preview comment store: corrupt state, starting empty", { path: finalPath });
				return new PreviewCommentStore(root, emptyState());
			}
			const store = new PreviewCommentStore(root, normalized.state);
			if (normalized.migratedLegacyAnchors) {
				try {
					await store.#atomicWrite(normalized.state);
				} catch (error) {
					logger.warn("product preview comment store: failed to persist legacy-anchor migration", {
						path: finalPath,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return store;
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("product preview comment store: failed to load state, starting empty", {
					path: finalPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return new PreviewCommentStore(root, emptyState());
		}
	}

	list(itemId?: string): PreviewComment[] {
		const comments = this.#committed.comments;
		if (itemId === undefined) return structuredClone(comments);
		return structuredClone(comments.filter(comment => comment.anchor.itemId === itemId));
	}

	async add(comment: PreviewComment): Promise<PreviewComment> {
		return await this.#transact(state => {
			const nextComment = structuredClone(comment);
			return {
				next: { ...state, comments: [...state.comments, nextComment] },
				result: structuredClone(nextComment),
			};
		});
	}

	findCommentMutation(
		receipt: Omit<CommentMutationReceipt, "comment">,
	): Extract<CommentMutationResult, { kind: "replayed" | "conflict" }> | null {
		const existing = this.#committed.receipts.find(
			entry => entry.scope === receipt.scope && entry.requestId === receipt.requestId,
		);
		if (!existing) return null;
		if (existing.endpoint !== receipt.endpoint || existing.fingerprint !== receipt.fingerprint) {
			return { kind: "conflict" };
		}
		return { kind: "replayed", comment: structuredClone(existing.comment) };
	}

	/**
	 * Applies an idempotent comment mutation in one serialized turn. A caller may
	 * provide an async precondition for state that lives outside this store (such
	 * as the current canvas artifact); it runs after receipt replay/conflict
	 * handling and immediately before the durable write.
	 */
	async mutateCommentOnce(
		receipt: Omit<CommentMutationReceipt, "comment">,
		mutator: (state: Readonly<StateShape>) => { next: StateShape; comment: PreviewComment | null },
		precondition?: () => Promise<boolean>,
	): Promise<CommentMutationResult> {
		return await this.#enqueue(async () => {
			const state = structuredClone(this.#committed);
			const existing = state.receipts.find(
				entry => entry.scope === receipt.scope && entry.requestId === receipt.requestId,
			);
			if (existing) {
				if (existing.endpoint !== receipt.endpoint || existing.fingerprint !== receipt.fingerprint) {
					return { kind: "conflict" };
				}
				return { kind: "replayed", comment: structuredClone(existing.comment) };
			}
			if (precondition && !(await precondition())) return { kind: "rejected" };

			const mutation = mutator(state);
			if (!mutation.comment) {
				await this.#atomicWrite(mutation.next);
				this.#committed = mutation.next;
				return { kind: "applied", comment: null };
			}
			const storedReceipt: CommentMutationReceipt = {
				...receipt,
				comment: structuredClone(mutation.comment),
			};
			const next = {
				...mutation.next,
				receipts: [...mutation.next.receipts, storedReceipt].slice(-MAX_COMMENT_RECEIPTS),
			};
			await this.#atomicWrite(next);
			this.#committed = next;
			return { kind: "applied", comment: structuredClone(mutation.comment) };
		});
	}

	async reply(commentId: string, reply: PreviewCommentReply): Promise<PreviewComment | null> {
		return await this.#transact(state => {
			const index = state.comments.findIndex(comment => comment.id === commentId);
			if (index === -1) return { next: state, result: null };
			const updated = structuredClone(state.comments[index]!);
			updated.replies = [...updated.replies, structuredClone(reply)];
			const comments = state.comments.slice();
			comments[index] = updated;
			return { next: { ...state, comments }, result: structuredClone(updated) };
		});
	}

	async setResolved(commentId: string, resolved: boolean): Promise<PreviewComment | null> {
		return await this.#transact(state => {
			const index = state.comments.findIndex(comment => comment.id === commentId);
			if (index === -1) return { next: state, result: null };
			const updated = structuredClone(state.comments[index]!);
			updated.resolved = resolved;
			const comments = state.comments.slice();
			comments[index] = updated;
			return { next: { ...state, comments }, result: structuredClone(updated) };
		});
	}

	async remove(commentId: string): Promise<boolean> {
		return await this.#transact(state => {
			const index = state.comments.findIndex(comment => comment.id === commentId);
			if (index === -1) return { next: state, result: false };
			const comments = state.comments.slice();
			comments.splice(index, 1);
			return { next: { ...state, comments }, result: true };
		});
	}

	async recordAnswer(
		questionId: string,
		answer: { selection: string[]; author: string; ts: number; itemId?: string },
	): Promise<void> {
		await this.#transact(state => {
			const answers = { ...state.answers, [questionId]: structuredClone(answer) };
			return { next: { ...state, answers }, result: undefined };
		});
	}

	answers(itemId?: string): Record<string, { selection: string[]; author: string; ts: number }> {
		const out: Record<string, { selection: string[]; author: string; ts: number }> = {};
		for (const [questionId, answer] of Object.entries(this.#committed.answers)) {
			if (itemId !== undefined && answer.itemId !== itemId) continue;
			out[questionId] = {
				selection: structuredClone(answer.selection),
				author: answer.author,
				ts: answer.ts,
			};
		}
		return out;
	}

	#transact<T>(mutator: (state: StateShape) => { next: StateShape; result: T }): Promise<T> {
		// Candidate is always computed from #committed inside the serialized turn —
		// never from a previous uncommitted mutation. Publish only after durable rename.
		return this.#enqueue(async () => {
			const { next, result } = mutator(structuredClone(this.#committed));
			await this.#atomicWrite(next);
			this.#committed = next;
			// Caller must not be able to mutate #committed through the returned object.
			return structuredClone(result);
		});
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(operation);
		// Chain survives rejection so later mutations still run; caller observes `run`.
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #atomicWrite(state: StateShape): Promise<void> {
		const dir = path.join(this.#root, STATE_DIR);
		const finalPath = path.join(dir, STATE_FILE);
		const tmpPath = path.join(dir, STATE_TMP);
		const json = `${JSON.stringify(state, null, "\t")}\n`;
		try {
			await fs.mkdir(dir, { recursive: true });
			await writePreviewStateTmp(tmpPath, json);
			await renamePreviewStateFile(tmpPath, finalPath);
		} catch (error) {
			logger.error("product preview comment store: persist failed", {
				path: finalPath,
				error: error instanceof Error ? error.message : String(error),
			});
			// Best-effort cleanup of a half-written tmp so the next load doesn't keep junk.
			try {
				await fs.unlink(tmpPath);
			} catch {
				// ignore
			}
			throw error;
		}
	}
}

function normalizeState(value: unknown): { state: StateShape; migratedLegacyAnchors: boolean } | null {
	if (!value || typeof value !== "object") return null;
	const record = value as {
		version?: unknown;
		comments?: unknown;
		answers?: unknown;
		receipts?: unknown;
	};
	if (record.version !== STATE_VERSION) return null;
	if (!Array.isArray(record.comments)) return null;
	if (!record.answers || typeof record.answers !== "object" || Array.isArray(record.answers)) return null;
	if (record.receipts !== undefined && !Array.isArray(record.receipts)) return null;

	const comments: PreviewComment[] = [];
	let migratedLegacyAnchors = false;
	for (const entry of record.comments) {
		const comment = normalizeComment(entry);
		if (!comment) return null;
		const rawComment = entry as { anchor?: unknown };
		if (
			rawComment.anchor &&
			typeof rawComment.anchor === "object" &&
			!("type" in (rawComment.anchor as Record<string, unknown>))
		) {
			migratedLegacyAnchors = true;
		}
		comments.push(comment);
	}

	const answers: Record<string, StoredAnswer> = {};
	for (const [questionId, raw] of Object.entries(record.answers as Record<string, unknown>)) {
		const answer = normalizeAnswer(raw);
		if (!answer) return null;
		answers[questionId] = answer;
	}

	const receipts: CommentMutationReceipt[] = [];
	for (const raw of record.receipts ?? []) {
		const receipt = normalizeReceipt(raw);
		if (!receipt) return null;
		receipts.push(receipt);
	}
	if (receipts.length > MAX_COMMENT_RECEIPTS) return null;
	return {
		state: { version: STATE_VERSION, comments, answers, receipts },
		migratedLegacyAnchors,
	};
}

function normalizeComment(value: unknown): PreviewComment | null {
	if (!value || typeof value !== "object") return null;
	const c = value as Record<string, unknown>;
	if (typeof c.id !== "string" || typeof c.body !== "string" || typeof c.author !== "string") return null;
	if (typeof c.viaShare !== "boolean" || typeof c.ts !== "number" || typeof c.resolved !== "boolean") return null;
	if (typeof c.ownerSid !== "string" || !Array.isArray(c.replies)) return null;
	const anchor = normalizeAnchor(c.anchor);
	if (!anchor) return null;
	const replies: PreviewCommentReply[] = [];
	for (const reply of c.replies) {
		const normalized = normalizeReply(reply);
		if (!normalized) return null;
		replies.push(normalized);
	}
	return {
		id: c.id,
		anchor,
		body: c.body,
		author: c.author,
		viaShare: c.viaShare,
		ts: c.ts,
		resolved: c.resolved,
		replies,
		ownerSid: c.ownerSid,
	};
}

function normalizeReceipt(value: unknown): CommentMutationReceipt | null {
	if (!value || typeof value !== "object") return null;
	const receipt = value as Record<string, unknown>;
	if (
		typeof receipt.scope !== "string" ||
		receipt.scope.length === 0 ||
		receipt.scope.length > 256 ||
		typeof receipt.requestId !== "string" ||
		receipt.requestId.length === 0 ||
		receipt.requestId.length > 128 ||
		typeof receipt.fingerprint !== "string" ||
		receipt.fingerprint.length === 0 ||
		receipt.fingerprint.length > 16_384
	) {
		return null;
	}
	if (receipt.endpoint !== "create" && receipt.endpoint !== "reply" && receipt.endpoint !== "resolve") return null;
	const comment = normalizeComment(receipt.comment);
	if (!comment) return null;
	return {
		scope: receipt.scope,
		requestId: receipt.requestId,
		endpoint: receipt.endpoint,
		fingerprint: receipt.fingerprint,
		comment,
	};
}
function normalizeAnchor(value: unknown): PreviewComment["anchor"] | null {
	if (!value || typeof value !== "object") return null;
	const anchor = value as Record<string, unknown>;
	if (typeof anchor.itemId !== "string" || anchor.itemId.length === 0 || anchor.itemId.length > 256) return null;
	if (anchor.type === "canvas-node") {
		if (typeof anchor.nodeId !== "string" || anchor.nodeId.length === 0 || anchor.nodeId.length > 128) return null;
		return { type: "canvas-node", itemId: anchor.itemId, nodeId: anchor.nodeId };
	}
	// State files written before C2 lack a discriminant. Normalize exactly once
	// during load, then all subsequent writes use the union-only text shape.
	if (anchor.type !== undefined && anchor.type !== "text") return null;
	if (typeof anchor.quote !== "string" || anchor.quote.length === 0 || anchor.quote.length > 500) return null;
	if (typeof anchor.prefix !== "string" || anchor.prefix.length > 32) return null;
	if (typeof anchor.suffix !== "string" || anchor.suffix.length > 32) return null;
	return {
		type: "text",
		itemId: anchor.itemId,
		quote: anchor.quote,
		prefix: anchor.prefix,
		suffix: anchor.suffix,
	};
}

function normalizeReply(value: unknown): PreviewCommentReply | null {
	if (!value || typeof value !== "object") return null;
	const r = value as Record<string, unknown>;
	if (typeof r.id !== "string" || typeof r.body !== "string" || typeof r.author !== "string") return null;
	if (typeof r.viaShare !== "boolean" || typeof r.ts !== "number") return null;
	return { id: r.id, body: r.body, author: r.author, viaShare: r.viaShare, ts: r.ts };
}

function normalizeAnswer(value: unknown): StoredAnswer | null {
	if (!value || typeof value !== "object") return null;
	const a = value as Record<string, unknown>;
	if (!Array.isArray(a.selection) || !a.selection.every(item => typeof item === "string")) return null;
	if (typeof a.author !== "string" || typeof a.ts !== "number") return null;
	if (a.itemId !== undefined && typeof a.itemId !== "string") return null;
	return {
		selection: a.selection.slice(),
		author: a.author,
		ts: a.ts,
		...(a.itemId !== undefined ? { itemId: a.itemId } : {}),
	};
}
