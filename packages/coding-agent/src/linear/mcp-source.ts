import type { KanbanPriority } from "../kanban/types";
import { callTool, listTools } from "../mcp/client";
import { MCPManager } from "../mcp/manager";
import type { MCPServerConnection, MCPToolCallResult, MCPToolDefinition } from "../mcp/types";
import { LINEAR_SERVER_CONFIG } from "./config";

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	url: string | null;
	priority: KanbanPriority;
	updatedAt: string;
}

export interface LinearComment {
	id: string;
	body: string;
	author: string;
}

const LINEAR_NUMERIC_PRIORITIES: Record<number, KanbanPriority> = {
	0: "lowest",
	1: "highest",
	2: "high",
	3: "medium",
	4: "low",
};

export class LinearMcpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LinearMcpError";
	}
}

/** Reads assigned Linear work exclusively through the configured `linear` MCP server. */
export class McpLinearSource {
	readonly #manager: MCPManager | undefined;

	constructor(manager: MCPManager | undefined = MCPManager.instance()) {
		this.#manager = manager;
	}

	async ensureAvailable(): Promise<void> {
		const { tools } = await this.#connectionAndTools();
		resolveTool(tools, "list_issues");
		resolveTool(tools, "list_comments");
	}

	async listIssues(status: string): Promise<LinearIssue[]> {
		const { connection, tools } = await this.#connectionAndTools();
		const tool = resolveTool(tools, "list_issues");
		const rows = rowsFromResult(
			await callTool(connection, tool.name, { assignee: "me", state: status, limit: 250 }),
			"issues",
		);
		return rows.map((row, index) => parseIssue(row, index));
	}

	async listComments(issueId: string): Promise<LinearComment[]> {
		const { connection, tools } = await this.#connectionAndTools();
		const tool = resolveTool(tools, "list_comments");
		const rows = rowsFromResult(await callTool(connection, tool.name, { issueId }), "comments");
		return rows.map((row, index) => parseComment(row, index));
	}

	async #connectionAndTools(): Promise<{ connection: MCPServerConnection; tools: MCPToolDefinition[] }> {
		const manager = this.#manager;
		if (!manager) throw new LinearMcpError('Linear MCP server "linear" is not configured');
		let connection = manager.getConnection("linear");
		if (!connection) {
			const result = await manager.connectServers({ linear: LINEAR_SERVER_CONFIG }, {});
			const error = result.errors.get("linear");
			if (error) throw new LinearMcpError(error);
			connection = manager.getConnection("linear") ?? (await manager.waitForConnection("linear"));
		}
		return { connection, tools: await listTools(connection) };
	}
}

function resolveTool(tools: readonly MCPToolDefinition[], expected: string): MCPToolDefinition {
	const normalized = normalizeToolName(expected);
	const tool = tools.find(candidate => normalizeToolName(candidate.name) === normalized);
	if (!tool) throw new LinearMcpError(`Linear MCP tool "${expected}" is unavailable`);
	return tool;
}

function normalizeToolName(name: string): string {
	return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function rowsFromResult(result: MCPToolCallResult, field: "issues" | "comments"): unknown[] {
	if (result.isError) throw new LinearMcpError(`Linear MCP ${field} request failed: ${readMcpText(result)}`);
	const text = readMcpText(result);
	let payload: unknown;
	try {
		payload = JSON.parse(text) as unknown;
	} catch {
		throw new LinearMcpError(`Linear MCP ${field} response is malformed JSON`);
	}
	if (Array.isArray(payload)) return payload;
	const record = objectFields(payload, `Linear MCP ${field} response`);
	const data = record.data;
	const nested: Record<string, unknown> | null =
		typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
	const rows = record[field] ?? record.nodes ?? nested?.[field] ?? nested?.nodes;
	if (!Array.isArray(rows)) throw new LinearMcpError(`Linear MCP ${field} response is malformed`);
	return rows;
}

function readMcpText(result: MCPToolCallResult): string {
	const text = result.content
		.filter(
			(content): content is Extract<(typeof result.content)[number], { type: "text" }> => content.type === "text",
		)
		.map(content => content.text)
		.join("\n");
	if (text.length === 0) throw new LinearMcpError("Linear MCP response has no text content");
	return text;
}

function parseIssue(value: unknown, index: number): LinearIssue {
	const record = objectFields(value, `Linear MCP issue ${index}`);
	const id = requiredString(record, "id", `issue ${index}`);
	const identifier = requiredString(record, "identifier", `issue ${index}`);
	const title = requiredString(record, "title", `issue ${index}`);
	const updatedAt = requiredString(record, "updatedAt", `issue ${index}`);
	if (Number.isNaN(Date.parse(updatedAt))) {
		throw new LinearMcpError(`Linear MCP issue ${index} is malformed: updatedAt must be an ISO timestamp`);
	}
	const description = optionalString(record, "description", `issue ${index}`);
	const url = optionalString(record, "url", `issue ${index}`);
	return { id, identifier, title, description, url, priority: parsePriority(record.priority, index), updatedAt };
}

function parseComment(value: unknown, index: number): LinearComment {
	const record = objectFields(value, `Linear MCP comment ${index}`);
	const id = requiredString(record, "id", `comment ${index}`);
	const body = requiredString(record, "body", `comment ${index}`);
	const author =
		firstString(
			record.author,
			nestedString(record.user, "name"),
			nestedString(record.user, "displayName"),
			nestedString(record.creator, "name"),
		) ?? "Linear";
	return { id, body, author };
}

function parsePriority(value: unknown, index: number): KanbanPriority {
	if (value === undefined || value === null) return "medium";
	if (typeof value === "number") {
		const priority = LINEAR_NUMERIC_PRIORITIES[value];
		if (priority) return priority;
	}
	if (typeof value === "string") {
		const normalized = value.toLowerCase().replaceAll(/[^a-z]/g, "");
		if (normalized === "nopriority") return "lowest";
		if (normalized === "urgent") return "highest";
		if (["lowest", "low", "medium", "high", "highest"].includes(normalized)) return normalized as KanbanPriority;
	}
	throw new LinearMcpError(`Linear MCP issue ${index} has an unsupported priority`);
}

function requiredString(record: Record<string, unknown>, field: string, subject: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0)
		throw new LinearMcpError(`Linear MCP ${subject} is malformed: ${field} is required`);
	return value;
}

function optionalString(record: Record<string, unknown>, field: string, subject: string): string | null {
	const value = record[field];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string")
		throw new LinearMcpError(`Linear MCP ${subject} is malformed: ${field} must be a string`);
	return value;
}

function objectFields(value: unknown, subject: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LinearMcpError(`${subject} is malformed`);
	}
	return value as Record<string, unknown>;
}

function nestedString(value: unknown, field: string): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return firstString((value as Record<string, unknown>)[field]);
}
function firstString(...values: unknown[]): string | null {
	return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}
