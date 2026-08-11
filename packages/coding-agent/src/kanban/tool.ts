import { randomUUID } from "node:crypto";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { getKanbanModelApi } from "../kanban";
import type { ToolSession } from "../tools";
import type { OutputMeta } from "../tools/output-meta";
import { ToolError } from "../tools/tool-errors";
import { toolResult } from "../tools/tool-result";
import { KanbanError } from "./errors";
import kanbanDescription from "./kanban-tool.md" with { type: "text" };
import type { KanbanModelApi } from "./runtime";
import type { KanbanIdempotencyOperation } from "./store";
import {
	KANBAN_STATUSES,
	type KanbanBoardSnapshot,
	type KanbanComment,
	type KanbanMutation,
	type KanbanTask,
} from "./types";
import {
	validateCommentCreate,
	validateExpectedVersion,
	validateMove,
	validateTaskCreate,
	validateTaskUpdate,
} from "./validation";

const kanbanSchema = type({
	op: type("'board' | 'get' | 'create' | 'update' | 'move' | 'delete' | 'comment' | 'comments'").describe("operation"),
	"taskId?": type("string").describe("task id"),
	"task?": type("unknown").describe("create: task fields"),
	"patch?": type("unknown").describe("update: fields including expectedVersion"),
	"move?": type("unknown").describe("move: expectedVersion, status, index"),
	"expectedVersion?": type("number").describe("delete: current task version"),
	"comment?": type("unknown").describe("comment: author and body"),
});

export type KanbanToolParams = typeof kanbanSchema.infer;

export interface KanbanToolDetails {
	op: KanbanToolParams["op"];
	taskId?: string;
	status?: number;
	board?: KanbanBoardSnapshot;
	task?: KanbanTask;
	comments?: KanbanComment[];
	comment?: KanbanComment;
	meta?: OutputMeta;
}

interface LiveKanbanApi {
	boardId: string;
	api: KanbanModelApi;
}

const READ_ONLY_OPERATIONS: Partial<Record<KanbanToolParams["op"], true>> = {
	board: true,
	get: true,
	comments: true,
};

function compactBoard(board: KanbanBoardSnapshot): object {
	return {
		cursor: board.cursor,
		columns: KANBAN_STATUSES.map(status => ({
			status,
			tasks: board.tasks
				.filter(task => task.status === status)
				.map(task => ({
					id: task.id,
					title: task.title,
					status: task.status,
					priority: task.priority,
					position: task.position,
					version: task.version,
					assignee: task.assignee,
					labels: task.labels,
				})),
		})),
	};
}

function formatKanbanError(error: KanbanError): string {
	const message = `Kanban error [${error.code}] (${error.status}): ${error.message}`;
	return error.code === "version_conflict"
		? `${message}. Re-read the board or task, then retry with its current version.`
		: message;
}

/** `/api/v1/sessions/<session>/attachments/<id>` as written into markdown. */
const ATTACHMENT_URL_RE = /\/api\/v1\/sessions\/[^/\s)"']+\/attachments\/([\w-]+)/g;
const MAX_TOOL_IMAGES = 6;

/**
 * The id the Kanban runtime registers boards under. `getSessionId` returns the
 * session-manager id, which diverges from `AgentSession.sessionId` whenever a
 * provider session id is active — looking a board up by that one silently finds
 * nothing and leaves the tool unmounted.
 */
function boardSessionId(session: ToolSession): string | null {
	return session.getKanbanSessionId?.() ?? session.getSessionId?.() ?? null;
}

/** Session-scoped model tool for the live Kanban board. */
export class KanbanTool implements AgentTool<typeof kanbanSchema, KanbanToolDetails> {
	readonly name = "kanban";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const op = (args as Partial<KanbanToolParams>).op;
		return op && READ_ONLY_OPERATIONS[op] ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<KanbanToolParams>;
		const operation = typeof params.op === "string" ? params.op : "(missing)";
		const lines = [`Operation: ${operation}`];
		if (typeof params.taskId === "string" && params.taskId.length > 0) lines.push(`Task: ${params.taskId}`);
		return lines;
	};
	readonly label = "Kanban";
	readonly summary = "Read and update the session Kanban board";
	readonly description: string;
	readonly parameters = kanbanSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(kanbanDescription);
	}

	/**
	 * Create only while this session owns a live board. Tools are built before
	 * the board registers, so the first pass returns `null`; the runtime mounts
	 * this tool afterwards via `SessionTools.refreshKanbanTool()`.
	 */
	static createIf(session: ToolSession): KanbanTool | null {
		const sessionId = boardSessionId(session);
		return sessionId && getKanbanModelApi(sessionId) ? new KanbanTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: KanbanToolParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<KanbanToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<KanbanToolDetails>> {
		try {
			const { api, boardId } = this.#liveApi();
			switch (params.op) {
				case "board": {
					const board = api.store.getBoard(boardId);
					return toolResult<KanbanToolDetails>({ op: params.op, board })
						.text(this.#json(compactBoard(board)))
						.done();
				}
				case "get": {
					const taskId = this.#taskId(params);
					const task = api.store.getTask(boardId, taskId);
					const comments = api.store.listComments(boardId, taskId);
					const images = this.#taskImages(api, boardId, task, comments);
					const summary = this.#json({ task, comments });
					const builder = toolResult<KanbanToolDetails>({ op: params.op, taskId, task, comments });
					return images.length === 0
						? builder.text(summary).done()
						: builder.content([{ type: "text", text: summary }, ...images]).done();
				}
				case "create": {
					const input = validateTaskCreate(params.task);
					const result = api.store.createTask(
						boardId,
						input,
						this.#operation(`/api/v1/boards/${boardId}/tasks`, params.task),
					);
					api.publish(result.activity);
					return this.#taskMutationResult(params.op, result);
				}
				case "update": {
					const taskId = this.#taskId(params);
					const input = validateTaskUpdate(params.patch);
					const result = api.store.updateTask(boardId, taskId, input);
					api.publish(result.activity);
					return this.#taskMutationResult(params.op, result);
				}
				case "move": {
					const taskId = this.#taskId(params);
					const input = validateMove(params.move);
					const result = api.store.moveTask(
						boardId,
						taskId,
						input,
						this.#operation(`/api/v1/boards/${boardId}/tasks/${taskId}/moves`, params.move),
						{ claimBy: api.sessionName },
					);
					api.publish(result.activity);
					return this.#taskMutationResult(params.op, result);
				}
				case "delete": {
					const taskId = this.#taskId(params);
					const input = validateExpectedVersion({ expectedVersion: params.expectedVersion });
					const result = api.store.deleteTask(boardId, taskId, input);
					api.publish(result.activity);
					return toolResult<KanbanToolDetails>({ op: params.op, taskId, status: result.status })
						.text(`Deleted task ${taskId}.`)
						.done();
				}
				case "comment": {
					const taskId = this.#taskId(params);
					const input = validateCommentCreate(params.comment, api.sessionName);
					const result = api.store.createComment(
						boardId,
						taskId,
						input,
						this.#operation(`/api/v1/boards/${boardId}/tasks/${taskId}/comments`, params.comment),
					);
					api.publish(result.activity);
					return toolResult<KanbanToolDetails>({
						op: params.op,
						taskId,
						status: result.status,
						comment: result.data,
					})
						.text(this.#json({ comment: result.data }))
						.done();
				}
				case "comments": {
					const taskId = this.#taskId(params);
					const comments = api.store.listComments(boardId, taskId);
					return toolResult<KanbanToolDetails>({ op: params.op, taskId, comments })
						.text(this.#json({ comments }))
						.done();
				}
				default:
					throw new ToolError(`Unsupported Kanban operation: ${String(params.op)}`);
			}
		} catch (error) {
			throw this.#toolError(error);
		}
	}

	#liveApi(): LiveKanbanApi {
		const sessionId = boardSessionId(this.session);
		if (!sessionId) throw new ToolError("Kanban board is unavailable because this session has no session ID.");
		const api = getKanbanModelApi(sessionId);
		if (!api) {
			throw new ToolError(
				"Kanban board is no longer running for this session. Re-open the board before using kanban.",
			);
		}
		return { boardId: api.boardId, api };
	}

	/**
	 * Board images referenced from the description or comments, decoded so the
	 * model sees the screenshot instead of a URL it cannot fetch. Bounded so one
	 * image-heavy task cannot blow up a tool result.
	 */
	#taskImages(
		api: KanbanModelApi,
		boardId: string,
		task: KanbanTask,
		comments: readonly KanbanComment[],
	): ImageContent[] {
		const sources = [task.description ?? "", ...comments.map(comment => comment.body)].join("\n");
		const ids = new Set<string>();
		for (const match of sources.matchAll(ATTACHMENT_URL_RE)) {
			const id = match[1];
			if (id) ids.add(id);
			if (ids.size >= MAX_TOOL_IMAGES) break;
		}
		const images: ImageContent[] = [];
		for (const id of ids) {
			const found = api.store.readAttachment(boardId, id);
			if (!found) continue;
			images.push({
				type: "image",
				data: Buffer.from(found.bytes).toString("base64"),
				mimeType: found.contentType,
			});
		}
		return images;
	}

	#taskId(params: KanbanToolParams): string {
		const taskId = params.taskId?.trim();
		if (!taskId) throw new ToolError(`Kanban ${params.op} requires a non-empty taskId.`);
		return taskId;
	}

	/**
	 * `body` is the caller's raw argument, matching what the HTTP route hashes.
	 * A post-validation object can carry explicit `undefined` fields, which the
	 * store's canonical JSON rejects outright.
	 */
	#operation(route: string, body: unknown): KanbanIdempotencyOperation {
		return { key: randomUUID(), method: "POST", route, body: body ?? null };
	}

	#taskMutationResult(
		op: Extract<KanbanToolParams["op"], "create" | "update" | "move">,
		result: KanbanMutation<KanbanTask>,
	): AgentToolResult<KanbanToolDetails> {
		return toolResult<KanbanToolDetails>({
			op,
			taskId: result.data.id,
			status: result.status,
			task: result.data,
		})
			.text(this.#json({ task: result.data }))
			.done();
	}

	#toolError(error: unknown): ToolError {
		if (error instanceof ToolError) return error;
		if (error instanceof KanbanError) return new ToolError(formatKanbanError(error));
		return new ToolError(`Kanban operation failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	#json(value: unknown): string {
		return JSON.stringify(value, null, 2) ?? "null";
	}
}
