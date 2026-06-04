import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateContextGcEffectiveTokens } from "../src/effective-usage";
import { CONTEXT_GC_CUSTOM_TYPE, type ContextGcDelta } from "../src/schema";
import { getContextGcDbPath, openContextGcStore } from "../src/storage";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-gc-effective-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

function makeSessionManager(delta?: ContextGcDelta) {
	return {
		getSessionId: () => "session-a",
		getSessionFile: () => path.join(tempDir, "session.jsonl"),
		getEntries: () => [],
		getBranch: () =>
			delta
				? [
						{
							type: "custom",
							customType: CONTEXT_GC_CUSTOM_TYPE,
							data: delta,
						},
					]
				: [],
	};
}

describe("estimateContextGcEffectiveTokens", () => {
	it("subtracts the projected Context GC savings from a caller-provided base estimate", () => {
		const dbPath = getContextGcDbPath(tempDir);
		const store = openContextGcStore({ dbPath });
		try {
			const payloadText = "large tool payload\n".repeat(2_000);
			const payload = store.putPayload("text/plain;charset=utf-8", payloadText);
			store.upsertRecord({
				id: "record-a",
				sessionId: "session-a",
				sessionFile: path.join(tempDir, "session.jsonl"),
				status: "candidate",
				kind: "tool_result",
				source: { toolCallId: "call-a", toolName: "read" },
				payloadHash: payload.hash,
				artifactId: "artifact-a",
				sourceUri: null,
				summary: "large read output",
				tokenEstimate: 8_500,
			});
		} finally {
			store.close();
		}

		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-a",
			toolName: "read",
			content: [{ type: "text", text: "large tool payload\n".repeat(2_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		const delta: ContextGcDelta = {
			op: "unload",
			id: "record-a",
			sessionId: "session-a",
			summary: "read output no longer needed",
			createdAt: new Date().toISOString(),
		};

		const effective = estimateContextGcEffectiveTokens({
			dbPath,
			cwd: tempDir,
			sessionManager: makeSessionManager(delta),
			messages: [message],
			baseTokens: 9_000,
		});

		if (effective === undefined) throw new Error("Expected an effective token estimate");
		expect(effective).toBeLessThan(9_000);
		expect(effective).toBeGreaterThan(0);
	});

	it("subtracts stale inspection output savings after successful cleanup even without unloaded records", () => {
		const inventory: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-inventory",
			toolName: "context_inventory",
			content: [{ type: "text", text: "large inventory row\n".repeat(2_000) }],
			details: { records: ["large inventory row"] },
			isError: false,
		} as unknown as AgentMessage;
		const cleanup: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-unload",
			toolName: "context_unload",
			content: [{ type: "text", text: "Context GC unloaded 0 record(s)." }],
			isError: false,
		} as unknown as AgentMessage;

		const effective = estimateContextGcEffectiveTokens({
			dbPath: getContextGcDbPath(tempDir),
			cwd: tempDir,
			sessionManager: makeSessionManager(),
			messages: [inventory, cleanup],
			baseTokens: 9_000,
			recordIds: [],
		});

		if (effective === undefined) throw new Error("Expected inspection compaction to reduce effective tokens");
		expect(effective).toBeLessThan(9_000);
		expect(effective).toBeGreaterThan(0);
	});

	it("does nothing when the current branch has no unload delta", () => {
		const effective = estimateContextGcEffectiveTokens({
			dbPath: getContextGcDbPath(tempDir),
			cwd: tempDir,
			sessionManager: makeSessionManager(),
			messages: [],
			baseTokens: 9_000,
		});

		expect(effective).toBeUndefined();
	});
});
