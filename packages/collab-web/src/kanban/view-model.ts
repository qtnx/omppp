import type { KanbanActivity, KanbanPriority, KanbanStatus } from "./types";

const LABEL_HUES: Record<string, number> = {
	bug: 25,
	feature: 145,
	improvement: 80,
};

export function labelColor(label: string): string {
	const normalized = label.trim().toLocaleLowerCase();
	let hue = LABEL_HUES[normalized];
	if (hue === undefined) {
		let hash = 2166136261;
		for (const character of normalized) {
			hash ^= character.codePointAt(0) ?? 0;
			hash = Math.imul(hash, 16777619);
		}
		hue = (hash >>> 0) % 360;
	}
	return `oklch(68% 0.16 ${hue})`;
}

export const STATUS_LABELS: Record<KanbanStatus, string> = {
	backlog: "Backlog",
	ready: "Ready",
	in_progress: "In progress",
	blocked: "Blocked",
	review: "Review",
	done: "Done",
	cancelled: "Cancelled",
};

export const PRIORITY_LABELS: Record<KanbanPriority, string> = {
	lowest: "Lowest",
	low: "Low",
	medium: "Medium",
	high: "High",
	highest: "Highest",
};

export function displayTitle(title: string): string {
	return title.trim() || "Untitled task";
}

export const ACTIVITY_LABELS: Record<KanbanActivity["type"], string> = {
	"task.created": "Task created",
	"task.updated": "Task updated",
	"task.deleted": "Task deleted",
	"task.moved": "Task moved",
	"comment.created": "Comment added",
	"comment.updated": "Comment edited",
	"comment.deleted": "Comment deleted",
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

export function formatKanbanDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : DATE_FORMATTER.format(date);
}

export function activityDetail(activity: KanbanActivity): string | null {
	const fields: string[] = [];
	for (const [key, label] of [
		["fromStatus", "From"],
		["toStatus", "To"],
		["status", "Status"],
		["assignee", "Assignee"],
		["author", "Author"],
	] as const) {
		const value = activity.data[key];
		if (typeof value === "string" && value.length > 0) fields.push(`${label}: ${value}`);
	}
	return fields.length > 0 ? fields.join(", ") : null;
}
