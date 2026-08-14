import { logger } from "@oh-my-pi/pi-utils";
import type { HerdrJsonRequest } from "./socket";

const MAX_TOKEN_ENTRIES = 16;
const TOKEN_KEY_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_TTL_MS = 1;
const MAX_TTL_MS = 86_400_000;

export interface PaneMetadataFields {
	title?: string;
	displayAgent?: string;
	agent?: string;
	appliesToSource?: string;
	stateLabels?: Record<string, string>;
	tokens?: Record<string, string | null>;
	ttlMs?: number;
	clearTitle?: boolean;
	clearDisplayAgent?: boolean;
	clearStateLabels?: boolean;
}

export function buildPaneMetadataRequest(params: {
	paneId: string;
	source: string;
	seq: number;
	fields: PaneMetadataFields;
}): HerdrJsonRequest {
	const { fields } = params;
	const requestParams: Record<string, unknown> = {
		pane_id: params.paneId,
		source: params.source,
		seq: params.seq,
	};
	if (fields.title !== undefined) requestParams.title = fields.title;
	if (fields.displayAgent !== undefined) requestParams.display_agent = fields.displayAgent;
	if (fields.agent !== undefined) requestParams.agent = fields.agent;
	if (fields.appliesToSource !== undefined) requestParams.applies_to_source = fields.appliesToSource;
	if (fields.stateLabels !== undefined) requestParams.state_labels = fields.stateLabels;
	if (fields.clearTitle !== undefined) requestParams.clear_title = fields.clearTitle;
	if (fields.clearDisplayAgent !== undefined) requestParams.clear_display_agent = fields.clearDisplayAgent;
	if (fields.clearStateLabels !== undefined) requestParams.clear_state_labels = fields.clearStateLabels;
	if (fields.tokens !== undefined) {
		const tokens: Record<string, string | null> = {};
		const dropped: string[] = [];
		let tokenCount = 0;
		for (const [key, value] of Object.entries(fields.tokens)) {
			if (!TOKEN_KEY_PATTERN.test(key) || tokenCount >= MAX_TOKEN_ENTRIES) {
				dropped.push(key);
				continue;
			}
			tokens[key] = value;
			tokenCount += 1;
		}
		if (dropped.length > 0) logger.debug("herdr pane metadata: dropped token keys", { keys: dropped });
		requestParams.tokens = tokens;
	}
	if (fields.ttlMs !== undefined) {
		const ttlMs = Number.isFinite(fields.ttlMs) ? Math.trunc(fields.ttlMs) : MIN_TTL_MS;
		requestParams.ttl_ms = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs));
	}
	return { id: `pane-metadata-${params.seq}`, method: "pane.report_metadata", params: requestParams };
}

export function buildPaneAgentSessionRequest(params: {
	paneId: string;
	source: string;
	agent: string;
	seq: number;
	sessionId?: string;
	sessionPath?: string;
	sessionStartSource?: string;
}): HerdrJsonRequest {
	const requestParams: Record<string, unknown> = {
		pane_id: params.paneId,
		source: params.source,
		agent: params.agent,
		seq: params.seq,
	};
	if (params.sessionId !== undefined) requestParams.agent_session_id = params.sessionId;
	if (params.sessionPath !== undefined) requestParams.agent_session_path = params.sessionPath;
	if (params.sessionStartSource !== undefined) requestParams.session_start_source = params.sessionStartSource;
	return { id: `pane-agent-session-${params.seq}`, method: "pane.report_agent_session", params: requestParams };
}

/** 950 -> "950"; 12_345 -> "12.3k"; 1_250_000 -> "1.25M" (<=4 significant chars, no trailing ".0"). */
export function formatTokenCount(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const sign = value < 0 ? "-" : "";
	const absolute = Math.abs(value);
	if (absolute < 1_000) return `${sign}${Math.round(absolute)}`;

	const unit: readonly [number, string] = absolute >= 1_000_000 ? [1_000_000, "M"] : [1_000, "k"];
	const scaled = absolute / unit[0];
	const decimalPlaces = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
	const formatted = scaled
		.toFixed(decimalPlaces)
		.replace(/\.0+$/, "")
		.replace(/(\.\d*?)0+$/, "$1");
	return `${sign}${formatted}${unit[1]}`;
}

/** 0 -> "$0"; 1.234 -> "$1.23"; 0.004 -> "$0.004" (never scientific notation). */
export function formatCostUsd(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "$0";
	const sign = value < 0 ? "-" : "";
	const absolute = Math.abs(value);
	const decimalPlaces = absolute >= 0.01 ? 2 : Math.min(20, Math.max(3, Math.ceil(-Math.log10(absolute)) + 1));
	const formatted = absolute
		.toFixed(decimalPlaces)
		.replace(/\.0+$/, "")
		.replace(/(\.\d*?)0+$/, "$1");
	return `${sign}$${formatted}`;
}

/** Collapse all whitespace runs (including newlines) to single spaces, trim, cap at `max` (default 72) with a trailing ellipsis. Returns "" for blank input. */
export function summarizeTitle(text: string, max = 72): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return "";
	if (normalized.length <= max) return normalized;
	if (max <= 0) return "";
	if (max === 1) return "…";
	return `${normalized.slice(0, max - 1)}…`;
}
