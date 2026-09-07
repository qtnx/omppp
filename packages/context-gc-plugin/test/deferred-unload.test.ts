import { describe, expect, it } from "bun:test";
import {
	AUTO_SHAKE_KEEP_RECENT_MESSAGES,
	AUTO_SHAKE_MIN_TOTAL_TOKENS,
	DEFERRED_UNLOAD_APPLY_RATIO,
	type DeferredUnloadSessionState,
	decideDeferredUnloads,
	PROMPT_CACHE_TTL_MS,
	selectAutoShakeRecords,
} from "../src/deferred-unload";
import type { ContextRecord } from "../src/schema";

function record(id: string, tokenEstimate: number): ContextRecord {
	return { id, tokenEstimate, status: "unloaded" } as ContextRecord;
}

const NOW = 1_000_000;

function warmState(applied: string[] = []): DeferredUnloadSessionState {
	return { applied: new Set(applied), lastResponseAt: NOW - 30_000 };
}

describe("decideDeferredUnloads", () => {
	it("keeps a small unload verbatim while the prompt cache is warm", () => {
		const state = warmState();
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 10_000)],
			state,
			contextTokens: 400_000,
			now: NOW,
		});
		expect(decision.reason).toBe("deferred");
		expect(decision.projectIds.size).toBe(0);
		expect(decision.deferredTokens).toBe(10_000);
		expect(state.applied.size).toBe(0);
	});

	it("applies pending unloads once the cache has been idle past its TTL", () => {
		const state: DeferredUnloadSessionState = { applied: new Set(), lastResponseAt: NOW - PROMPT_CACHE_TTL_MS };
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 10_000), record("b", 500)],
			state,
			contextTokens: 400_000,
			now: NOW,
		});
		expect(decision.reason).toBe("cache-cold");
		expect([...decision.projectIds].sort()).toEqual(["a", "b"]);
		expect(state.applied.has("a")).toBe(true);
	});

	it("treats a process without a completed turn as cold", () => {
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 1_000)],
			state: { applied: new Set() },
			contextTokens: 400_000,
			now: NOW,
		});
		expect(decision.reason).toBe("cache-cold");
	});

	it("applies while warm when the pending share of context pays for the rewrite", () => {
		const contextTokens = 100_000;
		const decision = decideDeferredUnloads({
			unloaded: [record("a", contextTokens * DEFERRED_UNLOAD_APPLY_RATIO)],
			state: warmState(),
			contextTokens,
			now: NOW,
		});
		expect(decision.reason).toBe("ratio");
		expect(decision.projectIds.has("a")).toBe(true);
	});

	it("applies immediately when context size is unknown", () => {
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 100)],
			state: warmState(),
			contextTokens: null,
			now: NOW,
		});
		expect(decision.reason).toBe("ratio");
	});

	it("never un-applies an already projected record", () => {
		const state = warmState(["a"]);
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 100), record("b", 100)],
			state,
			contextTokens: 400_000,
			now: NOW,
		});
		expect(decision.reason).toBe("deferred");
		expect([...decision.projectIds]).toEqual(["a"]);
	});
});

describe("selectAutoShakeRecords", () => {
	const candidate = (id: string, kind: string, messageIndex: number, netTokens: number, status = "candidate") => ({
		record: { id, kind, status, tokenEstimate: netTokens } as ContextRecord,
		messageIndex,
		netTokens,
	});
	const messageCount = 100;

	it("keeps recent messages, pinned records, and instruction kinds", () => {
		const selected = selectAutoShakeRecords(
			[
				candidate("old-tool", "tool_result", 5, 5_000),
				candidate("recent-tool", "tool_result", messageCount - AUTO_SHAKE_KEEP_RECENT_MESSAGES, 5_000),
				candidate("skill", "skill", 3, 5_000),
				candidate("pinned", "bash_execution", 4, 5_000, "pinned"),
				candidate("already", "file_read", 2, 5_000, "unloaded"),
			],
			messageCount,
		);
		expect(selected.map(record => record.id)).toEqual(["old-tool"]);
	});

	it("shakes nothing when the aggregate saving is below the floor", () => {
		const selected = selectAutoShakeRecords(
			[candidate("a", "tool_result", 1, AUTO_SHAKE_MIN_TOTAL_TOKENS - 1)],
			messageCount,
		);
		expect(selected).toEqual([]);
	});

	it("orders shaken records from the earliest message", () => {
		const selected = selectAutoShakeRecords(
			[candidate("late", "mcp_output", 40, 3_000), candidate("early", "tool_result", 10, 3_000)],
			messageCount,
		);
		expect(selected.map(record => record.id)).toEqual(["early", "late"]);
	});
});
