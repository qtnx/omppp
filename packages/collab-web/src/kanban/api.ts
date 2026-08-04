import { parseBoardSnapshot, parseKanbanComment, parseKanbanTask } from "./state";
import {
	isRecord,
	type KanbanBoardSession,
	type KanbanComment,
	type KanbanCommentDraft,
	type KanbanConnectionState,
	type KanbanMoveRequest,
	type KanbanTask,
	type KanbanTaskDraft,
	type KanbanTaskUpdate,
} from "./types";

export type KanbanFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class KanbanApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;

	constructor(status: number, code: string, message: string, details?: unknown) {
		super(message);
		this.name = "KanbanApiError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

/**
 * Idempotency keys must be unpredictable, not cryptographically ceremonial.
 * `randomUUID` is secure-context only, and the board is also served over plain
 * HTTP on tailnet addresses, where it is missing while `getRandomValues` still
 * works — so fall back to 16 random bytes rather than failing every mutation.
 */
function createIdempotencyKey(): string {
	const webCrypto = globalThis.crypto;
	if (webCrypto?.randomUUID) return webCrypto.randomUUID();
	if (webCrypto?.getRandomValues) {
		const bytes = webCrypto.getRandomValues(new Uint8Array(16));
		return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
	}
	throw new KanbanApiError(0, "crypto_unavailable", "Secure browser randomness is unavailable.");
}

async function parseResponseBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (text.length === 0) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new KanbanApiError(response.status, "invalid_response", "The board returned an unreadable response.");
	}
}

/** What the board needs after an upload to write markdown for the image. */
export interface KanbanAttachmentRef {
	id: string;
	url: string;
	filename: string;
}

export class KanbanApi {
	readonly #boardId: string;
	readonly #fetch: KanbanFetch;
	readonly #connection: () => KanbanConnectionState;

	constructor(
		boardId: string,
		fetchImplementation: KanbanFetch = (input, init) => globalThis.fetch(input, init),
		connection: () => KanbanConnectionState = () => "connected",
	) {
		this.#boardId = boardId;
		this.#fetch = fetchImplementation;
		this.#connection = connection;
	}

	#boardPath(suffix = ""): string {
		return `/api/v1/boards/${encodeURIComponent(this.#boardId)}${suffix}`;
	}

	#assertConnected(): void {
		if (this.#connection() !== "connected") {
			throw new KanbanApiError(0, "disconnected", "The board is disconnected. Reconnect before making changes.");
		}
	}

	async #request(path: string, init?: RequestInit): Promise<unknown> {
		const response = await this.#fetch(path, {
			...init,
			credentials: "same-origin",
			headers: {
				Accept: "application/json",
				...init?.headers,
			},
		});
		const payload = await parseResponseBody(response);
		if (!response.ok) {
			if (isRecord(payload) && isRecord(payload.error)) {
				const code = typeof payload.error.code === "string" ? payload.error.code : "request_failed";
				const message =
					typeof payload.error.message === "string"
						? payload.error.message
						: "The board couldn't complete the request.";
				throw new KanbanApiError(response.status, code, message, payload.error.details);
			}
			throw new KanbanApiError(response.status, "request_failed", "The board couldn't complete the request.");
		}
		if (!isRecord(payload) || !("data" in payload)) {
			throw new KanbanApiError(
				response.status,
				"invalid_response",
				"The board response is missing its data envelope.",
			);
		}
		return payload.data;
	}

	async #mutate(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<unknown> {
		this.#assertConnected();
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-OMPx-Kanban": "1",
		};
		if (method === "POST") headers["Idempotency-Key"] = createIdempotencyKey();
		return this.#request(path, {
			method,
			headers,
			body: JSON.stringify(body),
		});
	}

	async loadBoard(signal?: AbortSignal) {
		return parseBoardSnapshot(await this.#request(this.#boardPath("/board"), { signal }));
	}

	eventsUrl(cursor: number): string {
		if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Kanban SSE cursor must be a nonnegative integer");
		return `${this.#boardPath("/events")}?cursor=${cursor}`;
	}

	/** Sessions currently sharing this board; used as the assignee options. */
	async listSessions(): Promise<KanbanBoardSession[]> {
		const payload = await this.#request(this.#boardPath("/sessions"));
		if (!Array.isArray(payload)) return [];
		return payload.filter(isRecord).map(entry => ({
			sessionId: String(entry.sessionId ?? ""),
			name: String(entry.name ?? ""),
			createdAt: String(entry.createdAt ?? ""),
			lastSeenAt: String(entry.lastSeenAt ?? ""),
		}));
	}

	/**
	 * Uploads one board image as raw bytes. Multipart would buy nothing here:
	 * the server reads a single body and takes the name from a header.
	 */
	async uploadAttachment(file: File): Promise<KanbanAttachmentRef> {
		this.#assertConnected();
		const payload = await this.#request(this.#boardPath("/attachments"), {
			method: "POST",
			headers: {
				"Content-Type": file.type,
				"X-OMPx-Kanban": "1",
				"X-Kanban-Filename": file.name.replace(/[^\w.\- ]/g, "") || "image",
				"Idempotency-Key": createIdempotencyKey(),
			},
			body: file,
		});
		if (!isRecord(payload) || typeof payload.url !== "string" || typeof payload.id !== "string") {
			throw new KanbanApiError(200, "invalid_response", "The upload response was malformed.");
		}
		return { id: payload.id, url: payload.url, filename: file.name };
	}

	async createTask(draft: KanbanTaskDraft): Promise<KanbanTask> {
		return parseKanbanTask(await this.#mutate(this.#boardPath("/tasks"), "POST", draft));
	}

	async updateTask(taskId: string, update: KanbanTaskUpdate): Promise<KanbanTask> {
		return parseKanbanTask(
			await this.#mutate(this.#boardPath(`/tasks/${encodeURIComponent(taskId)}`), "PATCH", update),
		);
	}

	async deleteTask(taskId: string, expectedVersion: number): Promise<void> {
		await this.#mutate(this.#boardPath(`/tasks/${encodeURIComponent(taskId)}`), "DELETE", { expectedVersion });
	}

	async moveTask(taskId: string, move: KanbanMoveRequest): Promise<KanbanTask> {
		return parseKanbanTask(
			await this.#mutate(this.#boardPath(`/tasks/${encodeURIComponent(taskId)}/moves`), "POST", move),
		);
	}

	async listComments(taskId: string): Promise<KanbanComment[]> {
		const data = await this.#request(this.#boardPath(`/tasks/${encodeURIComponent(taskId)}/comments`));
		const comments = Array.isArray(data)
			? data
			: isRecord(data) && Array.isArray(data.comments)
				? data.comments
				: null;
		if (!comments) throw new KanbanApiError(200, "invalid_response", "The comment response is malformed.");
		return comments.map(parseKanbanComment);
	}

	async createComment(taskId: string, draft: KanbanCommentDraft): Promise<KanbanComment> {
		return parseKanbanComment(
			await this.#mutate(this.#boardPath(`/tasks/${encodeURIComponent(taskId)}/comments`), "POST", draft),
		);
	}

	async updateComment(
		taskId: string,
		commentId: string,
		expectedVersion: number,
		body: string,
	): Promise<KanbanComment> {
		return parseKanbanComment(
			await this.#mutate(
				this.#boardPath(`/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`),
				"PATCH",
				{ expectedVersion, body },
			),
		);
	}

	async deleteComment(taskId: string, commentId: string, expectedVersion: number): Promise<KanbanComment> {
		return parseKanbanComment(
			await this.#mutate(
				this.#boardPath(`/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`),
				"DELETE",
				{ expectedVersion },
			),
		);
	}
}
