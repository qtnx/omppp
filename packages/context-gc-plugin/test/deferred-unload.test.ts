import { describe, expect, it } from "bun:test";
import {
	AUTO_SHAKE_KEEP_RECENT_MESSAGES,
	AUTO_SHAKE_MIN_TOTAL_TOKENS,
	DEFERRED_UNLOAD_APPLY_RATIO,
	type DeferredUnloadSessionState,
	decideDeferredUnloads,
	FLIP_BACK_P,
	isCacheCold,
	livePrefixTokens,
	PROMPT_CACHE_TTL_MS,
	selectAutoShakeRecords,
	selectTrimByJudgment,
	trimPaysOff,
	type TrimCandidate,
} from "../src/deferred-unload";
import type { ContextRecord } from "../src/schema";

function record(id: string, tokenEstimate: number): ContextRecord {
	return { id, tokenEstimate, status: "unloaded" } as ContextRecord;
}

const NOW = 1_000_000;
const MODEL = "anthropic/claude-opus-5";
const OTHER_MODEL = "anthropic/claude-fable-5-1";

function warmState(applied: string[] = []): DeferredUnloadSessionState {
	return {
		applied: new Set(applied),
		lastResponseByModel: new Map([
			[MODEL, { at: NOW - 30_000, prefixTokens: 90_000, writePricePerToken: 10 / 1_000_000 }],
		]),
	};
}

describe("decideDeferredUnloads", () => {
	it("keeps a small unload verbatim while the prompt cache is warm", () => {
		const state = warmState();
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 10_000)],
			state,
			contextTokens: 400_000,
			modelKey: MODEL,
			now: NOW,
		});
		expect(decision.reason).toBe("deferred");
		expect(decision.projectIds.size).toBe(0);
		expect(decision.deferredTokens).toBe(10_000);
		expect(state.applied.size).toBe(0);
	});

	it("applies pending unloads once the cache has been idle past its TTL", () => {
		const state: DeferredUnloadSessionState = {
			applied: new Set(),
			lastResponseByModel: new Map([
				[MODEL, { at: NOW - PROMPT_CACHE_TTL_MS, prefixTokens: 90_000, writePricePerToken: 10 / 1_000_000 }],
			]),
		};
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 10_000), record("b", 500)],
			state,
			contextTokens: 400_000,
			modelKey: MODEL,
			now: NOW,
		});
		expect(decision.reason).toBe("cache-cold");
		expect([...decision.projectIds].sort()).toEqual(["a", "b"]);
		expect(state.applied.has("a")).toBe(true);
	});

	it("treats a process without a completed turn as cold", () => {
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 1_000)],
			state: { applied: new Set(), lastResponseByModel: new Map() },
			contextTokens: 400_000,
			modelKey: MODEL,
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
			modelKey: MODEL,
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
			modelKey: MODEL,
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
			modelKey: MODEL,
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

describe("per-model cache warmth", () => {
	it("reads cold for a model that has not answered, warm for the one that has", () => {
		const state = warmState();
		expect(isCacheCold(state, NOW, MODEL)).toBe(false);
		expect(isCacheCold(state, NOW, OTHER_MODEL)).toBe(true);
		expect(livePrefixTokens(state, NOW, MODEL)).toBe(90_000);
		expect(livePrefixTokens(state, NOW, OTHER_MODEL)).toBe(0);
	});

	it("applies pending unloads after a switch while the previous model stays warm", () => {
		const state = warmState();
		const decision = decideDeferredUnloads({
			unloaded: [record("a", 10_000)],
			state,
			contextTokens: 400_000,
			modelKey: OTHER_MODEL,
			now: NOW,
		});
		expect(decision.reason).toBe("cache-cold");
		expect(decision.projectIds.has("a")).toBe(true);
		// The model that just answered keeps its own live prefix.
		expect(isCacheCold(state, NOW, MODEL)).toBe(false);
	});
});

describe("selectTrimByJudgment", () => {
	const candidate = (id: string, tokens: number, messageIndex = 5): TrimCandidate => ({
		id,
		kind: "tool_result",
		ageTurns: 4,
		tokens,
		summary: `${id} summary`,
		messageIndex,
	});

	it("sheds only records the judgment answered below the threshold", () => {
		const shed = selectTrimByJudgment(
			[candidate("stale", 5_000), candidate("needed", 5_000), candidate("unanswered", 5_000)],
			{ keep: { stale: 0.05, needed: 0.9 }, action: "shake", actionConfidence: 0.8 },
			0.35,
		);
		expect(shed.map(entry => entry.id)).toEqual(["stale"]);
	});

	it("sheds nothing when the judgment says the history is still in use", () => {
		const shed = selectTrimByJudgment(
			[candidate("stale", 5_000)],
			{ keep: { stale: 0.01 }, action: "nothing", actionConfidence: 0.9 },
			0.35,
		);
		expect(shed).toEqual([]);
	});
});

describe("trimPaysOff", () => {
	const stateWith = (
		models: Array<[string, { at: number; prefixTokens: number; writePricePerToken: number }]>,
	): DeferredUnloadSessionState => ({ applied: new Set(), lastResponseByModel: new Map(models) });
	const PRICE = 10 / 1_000_000;

	it("pays when the shed tokens outweigh the other model's live prefix", () => {
		const state = stateWith([[MODEL, { at: NOW - 30_000, prefixTokens: 20_000, writePricePerToken: PRICE }]]);
		expect(trimPaysOff(state, NOW, OTHER_MODEL, 90_000, PRICE)).toBe(true);
		expect(trimPaysOff(state, NOW, OTHER_MODEL, 5_000, PRICE)).toBe(false);
	});

	it("ignores a prefix that already expired", () => {
		const state = stateWith([
			[MODEL, { at: NOW - PROMPT_CACHE_TTL_MS, prefixTokens: 500_000, writePricePerToken: PRICE }],
		]);
		expect(trimPaysOff(state, NOW, OTHER_MODEL, 1_000, PRICE)).toBe(true);
	});

	it("prices the flip-back risk at the configured probability", () => {
		const state = stateWith([[MODEL, { at: NOW - 30_000, prefixTokens: 100_000, writePricePerToken: PRICE }]]);
		// 100k prefix x flip-back probability is the loss the shed must beat.
		const breakEven = 100_000 * FLIP_BACK_P;
		expect(trimPaysOff(state, NOW, OTHER_MODEL, breakEven + 1, PRICE)).toBe(true);
		expect(trimPaysOff(state, NOW, OTHER_MODEL, breakEven - 1, PRICE)).toBe(false);
	});
});
