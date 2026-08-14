import { describe, expect, it } from "bun:test";
import { buildNotificationRequest } from "@oh-my-pi/pi-coding-agent/herdr/notify";
import {
	buildPaneAgentSessionRequest,
	buildPaneMetadataRequest,
	formatCostUsd,
	formatTokenCount,
	summarizeTitle,
} from "@oh-my-pi/pi-coding-agent/herdr/pane-metadata";

describe("herdr pane metadata", () => {
	it("builds locked snake_case metadata params and omits undefined fields", () => {
		const request = buildPaneMetadataRequest({
			paneId: "workspace:pane",
			source: "herdr:omp",
			seq: 4,
			fields: {
				title: "Investigating",
				displayAgent: "ompx",
				agent: "omp",
				appliesToSource: "herdr:omp",
				stateLabels: { status: "working" },
				clearTitle: false,
				clearDisplayAgent: true,
				clearStateLabels: false,
			},
		});

		expect(request).toEqual({
			id: "pane-metadata-4",
			method: "pane.report_metadata",
			params: {
				pane_id: "workspace:pane",
				source: "herdr:omp",
				seq: 4,
				title: "Investigating",
				display_agent: "ompx",
				agent: "omp",
				applies_to_source: "herdr:omp",
				state_labels: { status: "working" },
				clear_title: false,
				clear_display_agent: true,
				clear_state_labels: false,
			},
		});
	});

	it("filters token names, caps token count, and clamps metadata ttl", () => {
		const tokens = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`token_${index}`, String(index)]));
		const request = buildPaneMetadataRequest({
			paneId: "workspace:pane",
			source: "herdr:omp",
			seq: 5,
			fields: { tokens: { "bad key!": "dropped", ...tokens }, ttlMs: 99_999_999 },
		});
		const params = request.params as { tokens: Record<string, string>; ttl_ms: number };

		expect(params.tokens).not.toHaveProperty("bad key!");
		expect(Object.keys(params.tokens)).toHaveLength(16);
		expect(params.tokens).toHaveProperty("token_0", "0");
		expect(params.tokens).not.toHaveProperty("token_16");
		expect(params.ttl_ms).toBe(86_400_000);
		expect(
			buildPaneMetadataRequest({
				paneId: "workspace:pane",
				source: "herdr:omp",
				seq: 6,
				fields: { ttlMs: 0 },
			}).params.ttl_ms,
		).toBe(1);
	});

	it("formats token and cost values and summarizes titles", () => {
		expect(formatTokenCount(950)).toBe("950");
		expect(formatTokenCount(12_345)).toBe("12.3k");
		expect(formatTokenCount(1_250_000)).toBe("1.25M");
		expect(formatCostUsd(0)).toBe("$0");
		expect(formatCostUsd(1.234)).toBe("$1.23");
		expect(formatCostUsd(0.004)).toBe("$0.004");
		expect(summarizeTitle("  First line\n\nsecond\tline  ")).toBe("First line second line");
		expect(summarizeTitle("abcdef", 4)).toBe("abc…");
		expect(summarizeTitle(" \n\t ")).toBe("");
	});

	it("builds notification requests without unset optional params", () => {
		expect(buildNotificationRequest({ title: "Done" }, "notify-1")).toEqual({
			id: "notify-1",
			method: "notification.show",
			params: { title: "Done" },
		});
	});

	it("builds locked agent session params", () => {
		expect(
			buildPaneAgentSessionRequest({
				paneId: "workspace:pane",
				source: "herdr:omp",
				agent: "omp",
				seq: 7,
				sessionId: "session-1",
				sessionPath: "/tmp/session.jsonl",
				sessionStartSource: "cli",
			}),
		).toEqual({
			id: "pane-agent-session-7",
			method: "pane.report_agent_session",
			params: {
				pane_id: "workspace:pane",
				source: "herdr:omp",
				agent: "omp",
				seq: 7,
				agent_session_id: "session-1",
				agent_session_path: "/tmp/session.jsonl",
				session_start_source: "cli",
			},
		});
	});
});
