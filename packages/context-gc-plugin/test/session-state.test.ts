import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ContextGcDelta, ContextStatus } from "../src/schema";
import {
	branchRecords,
	type ContextGcSessionState,
	deriveBranchStatuses,
	readContextGcSessionState,
	readContextGcSessionStateFromSessionManager,
} from "../src/session-state";
import { type ContextGcStore, openContextGcStore } from "../src/storage";

let tempDir: string | undefined;
let store: ContextGcStore | undefined;

afterEach(() => {
	store?.close();
	store = undefined;
	if (tempDir) {
		fs.rmSync(tempDir, { force: true, recursive: true });
		tempDir = undefined;
	}
});

function openStore(): ContextGcStore {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-gc-session-"));
	store = openContextGcStore({ dbPath: path.join(tempDir, "context-gc.sqlite") });
	return store;
}

function delta(op: ContextGcDelta["op"], id: string): ContextGcDelta {
	return { op, id, sessionId: "session-a", createdAt: new Date().toISOString() };
}

function seedRecord(active: ContextGcStore, id: string, status: ContextStatus, sessionId = "session-a"): void {
	const payload = active.putPayload("text/plain;charset=utf-8", `payload ${id}`);
	active.upsertRecord({
		id,
		sessionId,
		sessionFile: null,
		status,
		kind: "tool_result",
		source: {},
		payloadHash: payload.hash,
		summary: `summary ${id}`,
	});
}

function makeState(deltas: ContextGcDelta[]): ContextGcSessionState {
	return { sessionId: "session-a", sessionFile: undefined, cwd: ".", deltas, messageEntries: [] };
}

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { extractMessagePayload, payloadForMessage } from "../src/extract";

interface FakeSessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	content?: string;
	display?: boolean;
	timestamp?: string;
	message?: unknown;
}

function makeCtx(entries: FakeSessionEntry[]): ExtensionContext {
	return {
		cwd: ".",
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
			getSessionId: () => "session-a",
			getBranch: () => entries,
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
}

function resolveBranchEntryId(
	role: string,
	storedHash: string,
	state: ContextGcSessionState,
	consumedEntryIds: Set<string>,
	customType?: string,
): string | undefined {
	for (const entry of state.messageEntries) {
		if (consumedEntryIds.has(entry.id)) continue;
		const extracted = extractMessagePayload(entry.message);
		if (extracted.role !== role) continue;
		if (role === "custom" && customType !== undefined && extracted.customType !== customType) continue;
		if (Bun.SHA256.hash(payloadForMessage(entry.message).stored, "hex") !== storedHash) continue;
		consumedEntryIds.add(entry.id);
		return entry.id;
	}
	return undefined;
}

describe("readContextGcSessionState", () => {
	it("includes custom_message branch entries as custom AgentMessages for entry-id linkage", () => {
		const shared = "duplicate custom payload";
		const entries: FakeSessionEntry[] = [
			{
				type: "custom_message",
				id: "cm-1",
				parentId: null,
				customType: "tool-output",
				content: shared,
				display: false,
				timestamp: "2026-01-01T00:00:00.000Z",
			},
			{
				type: "custom_message",
				id: "cm-2",
				parentId: "cm-1",
				customType: "tool-output",
				content: shared,
				display: false,
				timestamp: "2026-01-01T00:00:01.000Z",
			},
		];
		const state = readContextGcSessionState(makeCtx(entries));

		expect(state.messageEntries).toHaveLength(2);
		expect(state.messageEntries[0]?.id).toBe("cm-1");
		expect(state.messageEntries[1]?.id).toBe("cm-2");
		const first = state.messageEntries[0]?.message as unknown as Record<string, unknown>;
		expect(first.role).toBe("custom");
		expect(first.customType).toBe("tool-output");
		expect(first.content).toBe(shared);
	});

	it("reads active branch state from a structural session manager", () => {
		const branchDelta = delta("candidate", "branch-record");
		const state = readContextGcSessionStateFromSessionManager({
			cwd: "/repo",
			sessionManager: {
				getSessionFile: () => "/tmp/session.jsonl",
				getSessionId: () => "session-a",
				getBranch: () => [
					{ type: "custom", id: "d1", parentId: null, customType: "context-gc", data: branchDelta },
				],
				getEntries: () => [],
			},
		});

		expect(state.cwd).toBe("/repo");
		expect(state.sessionFile).toBe("/tmp/session.jsonl");
		expect(state.deltas).toEqual([branchDelta]);
	});

	it("recovers distinct entry ids for duplicate custom_message payloads", () => {
		const shared = "duplicate custom payload";
		const entries: FakeSessionEntry[] = [
			{
				type: "custom_message",
				id: "cm-1",
				parentId: null,
				customType: "tool-output",
				content: shared,
				display: false,
				timestamp: "2026-01-01T00:00:00.000Z",
			},
			{
				type: "custom_message",
				id: "cm-2",
				parentId: "cm-1",
				customType: "tool-output",
				content: shared,
				display: false,
				timestamp: "2026-01-01T00:00:01.000Z",
			},
		];
		const state = readContextGcSessionState(makeCtx(entries));
		const hash = Bun.SHA256.hash(shared, "hex");
		const consumed = new Set<string>();

		expect(resolveBranchEntryId("custom", hash, state, consumed, "tool-output")).toBe("cm-1");
		expect(resolveBranchEntryId("custom", hash, state, consumed, "tool-output")).toBe("cm-2");
		expect(resolveBranchEntryId("custom", hash, state, consumed, "tool-output")).toBeUndefined();
	});
});

describe("deriveBranchStatuses", () => {
	it("keeps a record a candidate on a branch without an unload delta", () => {
		const statuses = deriveBranchStatuses([delta("candidate", "r1")]);
		expect(statuses.get("r1")).toBe("candidate");
	});

	it("marks unloaded only when the branch carries an unload delta", () => {
		expect(deriveBranchStatuses([delta("candidate", "r1"), delta("unload", "r1")]).get("r1")).toBe("unloaded");
	});

	it("tracks pin and restores candidate on unpin", () => {
		expect(deriveBranchStatuses([delta("candidate", "r1"), delta("pin", "r1")]).get("r1")).toBe("pinned");
		expect(deriveBranchStatuses([delta("candidate", "r1"), delta("pin", "r1"), delta("unpin", "r1")]).get("r1")).toBe(
			"candidate",
		);
	});

	it("does not change status on recall", () => {
		expect(
			deriveBranchStatuses([delta("candidate", "r1"), delta("unload", "r1"), delta("recall", "r1")]).get("r1"),
		).toBe("unloaded");
	});
});

describe("branchRecords", () => {
	it("keeps a DB-unloaded record visible on a branch that lacks an unload delta", () => {
		const active = openStore();
		// The global DB row says unloaded, but the active branch only carries the candidate delta.
		seedRecord(active, "r1", "unloaded");
		const records = branchRecords(active, makeState([delta("candidate", "r1")]));
		expect(records).toHaveLength(1);
		expect(records[0]?.status).toBe("candidate");
	});

	it("reflects unloaded when the active branch carries an unload delta", () => {
		const active = openStore();
		seedRecord(active, "r2", "candidate");
		const records = branchRecords(active, makeState([delta("candidate", "r2"), delta("unload", "r2")]));
		expect(records[0]?.status).toBe("unloaded");
	});

	it("ignores deltas for records in other sessions", () => {
		const active = openStore();
		seedRecord(active, "other", "unloaded", "session-b");
		const records = branchRecords(active, makeState([delta("unload", "other")]));
		expect(records).toHaveLength(0);
	});

	it("applies the unload summary on the unloading branch without touching the DB or sibling branches", () => {
		const active = openStore();
		seedRecord(active, "r3", "candidate"); // DB base summary = "summary r3"
		const candidate: ContextGcDelta = {
			op: "candidate",
			id: "r3",
			sessionId: "session-a",
			summary: "summary r3",
			createdAt: new Date().toISOString(),
		};
		const unloadOnA: ContextGcDelta = {
			op: "unload",
			id: "r3",
			sessionId: "session-a",
			summary: "branch A unload summary",
			createdAt: new Date().toISOString(),
		};

		const branchA = branchRecords(active, makeState([candidate, unloadOnA]));
		const branchB = branchRecords(active, makeState([candidate]));

		// Branch A (with the unload delta) sees the replacement summary.
		expect(branchA[0]?.status).toBe("unloaded");
		expect(branchA[0]?.summary).toBe("branch A unload summary");
		// Branch B (without it) keeps the durable base summary and candidate status.
		expect(branchB[0]?.status).toBe("candidate");
		expect(branchB[0]?.summary).toBe("summary r3");
		// The DB base summary is never mutated by a branch-local unload.
		expect(active.getRecord("r3")?.summary).toBe("summary r3");
	});

	it("restores the base summary when an unload is followed by an unpin on the same branch", () => {
		const active = openStore();
		seedRecord(active, "r4", "candidate");
		const unload: ContextGcDelta = {
			op: "unload",
			id: "r4",
			sessionId: "session-a",
			summary: "transient unload summary",
			createdAt: new Date().toISOString(),
		};
		const unpin: ContextGcDelta = {
			op: "unpin",
			id: "r4",
			sessionId: "session-a",
			createdAt: new Date().toISOString(),
		};

		const records = branchRecords(active, makeState([unload, unpin]));
		expect(records[0]?.status).toBe("candidate");
		expect(records[0]?.summary).toBe("summary r4");
	});
});
