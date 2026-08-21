import { getKanbanModelApi } from "../kanban";
import type { KanbanSessionPort } from "../kanban/runtime";
import type { KanbanStore } from "../kanban/store";
import type { KanbanActivity, KanbanTask } from "../kanban/types";
import { McpLinearSource, type LinearComment, type LinearIssue } from "./mcp-source";

const POLL_INTERVAL_MS = 30_000;
const LINEAR_LABEL = "linear";
const LINEAR_UPDATED_PREFIX = "linear-updated:";

export interface LinearIntegrationStatus {
	running: boolean;
	statuses: readonly string[];
	lastSyncAt: string | null;
	lastError: string | null;
}

interface LinearIntegration extends LinearIntegrationStatus {
	session: KanbanSessionPort;
	source: McpLinearSource;
	timer: Timer | null;
	sync: Promise<LinearSyncResult> | null;
	stopped: boolean;
}

interface LinearSyncResult {
	imported: number;
	updated: number;
	comments: number;
}

const integrations = new Map<string, LinearIntegration>();

export async function startLinearIntegration(
	session: KanbanSessionPort,
	statuses: readonly string[],
): Promise<{ statuses: readonly string[]; imported: number }> {
	const normalizedStatuses = normalizeStatuses(statuses);
	if (!getKanbanModelApi(session.sessionId)) {
		throw new Error("Kanban board is not running for this session");
	}
	await stopLinearIntegration(session.sessionId);
	const integration: LinearIntegration = {
		session,
		source: new McpLinearSource(),
		statuses: normalizedStatuses,
		running: true,
		lastSyncAt: null,
		lastError: null,
		timer: null,
		sync: null,
		stopped: false,
	};
	integrations.set(session.sessionId, integration);
	try {
		const result = await synchronize(integration);
		if (integration.stopped) throw new Error("Linear integration stopped during initial sync");
		integration.timer = setInterval(() => void poll(integration), POLL_INTERVAL_MS);
		return { statuses: integration.statuses, imported: result.imported };
	} catch (error) {
		await stopIntegration(integration);
		throw error;
	}
}

export async function stopLinearIntegration(sessionId: string): Promise<boolean> {
	const integration = integrations.get(sessionId);
	if (!integration) return false;
	await stopIntegration(integration);
	return true;
}

export function getLinearIntegrationStatus(sessionId: string): LinearIntegrationStatus | null {
	const integration = integrations.get(sessionId);
	if (!integration) return null;
	return {
		running: integration.running,
		statuses: integration.statuses,
		lastSyncAt: integration.lastSyncAt,
		lastError: integration.lastError,
	};
}

export async function syncLinearIntegration(sessionId: string): Promise<LinearSyncResult> {
	const integration = integrations.get(sessionId);
	if (!integration || integration.stopped) throw new Error("Linear integration is not running");
	return await synchronize(integration);
}

async function poll(integration: LinearIntegration): Promise<void> {
	if (integration.stopped || integrations.get(integration.session.sessionId) !== integration) return;
	try {
		await synchronize(integration);
	} catch {
		// `synchronize` records and announces exactly one warning per failed tick.
	}
}

async function synchronize(integration: LinearIntegration): Promise<LinearSyncResult> {
	if (integration.sync) return await integration.sync;
	const run = syncOnce(integration);
	integration.sync = run;
	try {
		const result = await run;
		integration.lastSyncAt = new Date().toISOString();
		integration.lastError = null;
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		integration.lastError = message;
		integration.session.emitNotice("warning", `Linear sync failed: ${message}`, "linear");
		throw error;
	} finally {
		if (integration.sync === run) integration.sync = null;
	}
}

async function syncOnce(integration: LinearIntegration): Promise<LinearSyncResult> {
	const api = getKanbanModelApi(integration.session.sessionId);
	if (!api) throw new Error("Kanban board is not running for this session");
	await integration.source.ensureAvailable();
	const tasks = new Map(
		api.store
			.getBoard(api.boardId)
			.tasks.flatMap(task => {
				const label = task.labels.find(candidate => candidate.startsWith("linear:"));
				return label ? [[label.slice("linear:".length), task] as const] : [];
			}),
	);
	const seenIssues = new Set<string>();
	const result: LinearSyncResult = { imported: 0, updated: 0, comments: 0 };
	for (const status of integration.statuses) {
		const issues = await integration.source.listIssues(status);
		for (const issue of issues) {
			if (integration.stopped || integrations.get(integration.session.sessionId) !== integration) {
				throw new Error("Linear integration is not running");
			}
			if (seenIssues.has(issue.id)) continue;
			seenIssues.add(issue.id);
			const existing = tasks.get(issue.id);
			const comments = await integration.source.listComments(issue.id);
			if (!existing) {
				const mutation = api.store.createTask(
					api.boardId,
					{
						title: taskTitle(issue),
						status: "backlog",
						priority: issue.priority,
							description: taskDescription(issue),
							assignee: api.sessionName,
							labels: taskLabels(issue),
						},
					linearOperation("issue", issue.id),
				);
				const task = mutation.data;
				const initialActivities = createComments(api.boardId, task.id, comments, api.store, issue.id);
				result.comments += initialActivities.length;
				api.publish(mutation.activity);
				for (const activity of initialActivities) api.publish(activity);
				const readyCount = api.store.getBoard(api.boardId).tasks.filter(candidate => candidate.status === "ready").length;
				const moved = api.store.moveTask(
					api.boardId,
					task.id,
					{ expectedVersion: task.version, status: "ready", index: readyCount },
					linearOperation("start", issue.id),
				);
				tasks.set(issue.id, moved.data);
				await api.ingest(moved.activity);
				result.imported++;
				continue;
			}

			const refreshed = updateRemoteTask(api.boardId, existing, issue, api.store);
			if (refreshed.task !== existing) {
				tasks.set(issue.id, refreshed.task);
				if (refreshed.activity) await api.ingest(refreshed.activity);
				result.updated++;
			}
			const commentActivities = createComments(api.boardId, refreshed.task.id, comments, api.store, issue.id);
			result.comments += commentActivities.length;
			for (const activity of commentActivities) await api.ingest(activity);
			if (hasNewerRemoteUpdate(existing, issue) && isTerminal(refreshed.task.status)) {
				const readyCount = api.store.getBoard(api.boardId).tasks.filter(task => task.status === "ready").length;
				const moved = api.store.moveTask(
					api.boardId,
					refreshed.task.id,
					{ expectedVersion: refreshed.task.version, status: "ready", index: readyCount },
					linearOperation("reopen", `${issue.id}:${issue.updatedAt}`),
				);
				tasks.set(issue.id, moved.data);
				await api.ingest(moved.activity);
				if (refreshed.task === existing) result.updated++;
			}
		}
	}
	return result;
}

function createComments(
	boardId: string,
	taskId: string,
	comments: readonly LinearComment[],
	store: KanbanStore,
	issueId: string,
): KanbanActivity[] {
	const activities: KanbanActivity[] = [];
	for (const comment of comments) {
		const mutation = store.createComment(
			boardId,
			taskId,
			{ author: comment.author, body: comment.body },
			linearOperation("comment", `${issueId}:${comment.id}`),
		);
		if (mutation.activity) activities.push(mutation.activity);
	}
	return activities;
}

function updateRemoteTask(
	boardId: string,
	task: KanbanTask,
	issue: LinearIssue,
	store: KanbanStore,
): { task: KanbanTask; activity: KanbanActivity | null } {
	const title = taskTitle(issue);
	const description = taskDescription(issue);
	const labels = taskLabels(issue);
	if (task.title === title && task.description === description && equalLabels(task.labels, labels)) {
		return { task, activity: null };
	}
	const mutation = store.updateTask(boardId, task.id, {
		expectedVersion: task.version,
		title,
		description,
		labels,
	});
	return { task: mutation.data, activity: mutation.activity };
}

function taskTitle(issue: LinearIssue): string {
	return `${issue.identifier}: ${issue.title}`;
}

function taskDescription(issue: LinearIssue): string | null {
	const parts = [issue.description, issue.url ? `Linear: ${issue.url}` : null].filter(
		(part): part is string => part !== null && part.length > 0,
	);
	return parts.length > 0 ? parts.join("\n\n") : null;
}

function taskLabels(issue: LinearIssue): string[] {
	return [LINEAR_LABEL, `linear:${issue.id}`, `${LINEAR_UPDATED_PREFIX}${encodeURIComponent(issue.updatedAt)}`];
}

function linearOperation(kind: "issue" | "comment" | "start" | "reopen", id: string) {
	return {
		key: `linear:${kind}:${id}`,
		method: "POST" as const,
		route: `/linear/${kind}s/${encodeURIComponent(id)}`,
		body: { linearId: id },
	};
}

function hasNewerRemoteUpdate(task: KanbanTask, issue: LinearIssue): boolean {
	const updatedLabel = task.labels.find(label => label.startsWith(LINEAR_UPDATED_PREFIX));
	if (!updatedLabel) return true;
	try {
		return Date.parse(issue.updatedAt) > Date.parse(decodeURIComponent(updatedLabel.slice(LINEAR_UPDATED_PREFIX.length)));
	} catch {
		return true;
	}
}

function equalLabels(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((label, index) => label === right[index]);
}

function isTerminal(status: KanbanTask["status"]): boolean {
	return status === "done" || status === "cancelled";
}

function normalizeStatuses(statuses: readonly string[]): readonly string[] {
	const normalized = [...new Set(statuses.map(status => status.trim()).filter(status => status.length > 0))];
	if (normalized.length === 0) throw new Error("Linear integration requires at least one non-empty status");
	return normalized;
}

async function stopIntegration(integration: LinearIntegration): Promise<void> {
	integration.stopped = true;
	integration.running = false;
	clearInterval(integration.timer ?? undefined);
	integration.timer = null;
	if (integrations.get(integration.session.sessionId) === integration) integrations.delete(integration.session.sessionId);
}
