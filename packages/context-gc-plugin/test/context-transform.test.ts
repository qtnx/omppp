import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { projectUnloadedContext } from "../src/context-transform";
import { extractMessagePayload, textFromContent } from "../src/extract";
import type { ContextRecord } from "../src/schema";

describe("extract helpers", () => {
	test("converts text and image content blocks into stable text", () => {
		expect(textFromContent("plain")).toBe("plain");
		expect(
			textFromContent([
				{ type: "text", text: "hello" },
				{ type: "image", mimeType: "image/png", data: "abc" },
			]),
		).toBe("hello\n[image:image/png]");
	});

	test("extracts file mention paths and contents into stable text", () => {
		const message = {
			role: "fileMention",
			files: [{ path: "src/a.ts", content: "export const x = 1;", lineCount: 1, byteSize: 18 }],
		} as unknown as AgentMessage;
		const extracted = extractMessagePayload(message);
		expect(extracted.text).toContain("src/a.ts");
		expect(extracted.text).toContain("export const x = 1;");
	});
});

describe("projectUnloadedContext", () => {
	test("replaces unloaded tool result payloads with recall placeholders while preserving tool-result pairing", () => {
		const messages = [
			{
				role: "toolResult",
				toolCallId: "call_a",
				toolName: "bash",
				content: [{ type: "text", text: "very long output" }],
				timestamp: 1,
			},
		] as unknown as AgentMessage[];
		const records = [
			{
				...makeRecord({ id: "ctx_a", toolCallId: "call_a", toolName: "bash" }),
				payloadHash: sha256Hex("very long output"),
				summary: "Bash summary",
			} as unknown as ContextRecord,
		];

		const projected = projectUnloadedContext(messages, records);
		const out = projected[0] as unknown as Record<string, unknown>;

		expect(projected[0]).not.toBe(messages[0]);
		expect(out.toolCallId).toBe("call_a");
		expect(out.toolName).toBe("bash");
		expect(out.content).toEqual([{ type: "text", text: expect.stringContaining("Context unloaded: ctx_a") }]);
		expect(String((out.content as Array<{ text: string }>)[0].text)).not.toContain("very long output");
	});

	test("removes stale Context GC inspection tool outputs after cleanup while preserving tool-result pairing", () => {
		const messages = [
			{
				role: "toolResult",
				toolCallId: "call_inventory_before",
				toolName: "context_inventory",
				content: [{ type: "text", text: "Context GC inventory:\nlarge stale inventory details" }],
			},
			{
				role: "toolResult",
				toolCallId: "call_stats_before",
				toolName: "context_stats",
				content: [{ type: "text", text: "Context GC stats:\nlarge stale stats details" }],
			},
			{
				role: "toolResult",
				toolCallId: "call_unload",
				toolName: "context_unload",
				content: [{ type: "text", text: "Context GC unloaded 2 record(s)." }],
			},
			{
				role: "toolResult",
				toolCallId: "call_inventory_after",
				toolName: "context_inventory",
				content: [{ type: "text", text: "fresh inventory still needed" }],
			},
		] as unknown as AgentMessage[];

		const projected = projectUnloadedContext(messages, []);
		const inventoryBefore = projected[0] as unknown as { content: Array<{ text: string }>; toolCallId: string };
		const statsBefore = projected[1] as unknown as { content: Array<{ text: string }>; toolCallId: string };
		const unload = projected[2] as unknown as { content: Array<{ text: string }> };
		const inventoryAfter = projected[3] as unknown as { content: Array<{ text: string }> };

		expect(projected).toHaveLength(messages.length);
		expect(inventoryBefore.toolCallId).toBe("call_inventory_before");
		expect(inventoryBefore.content[0].text).toBe("Context GC inspection output removed after context_unload.");
		expect(statsBefore.toolCallId).toBe("call_stats_before");
		expect(statsBefore.content[0].text).toBe("Context GC inspection output removed after context_unload.");
		expect(unload.content[0].text).toBe("Context GC unloaded 2 record(s).");
		expect(inventoryAfter.content[0].text).toBe("fresh inventory still needed");
	});

	test("keeps Context GC inspection outputs until a later cleanup happens", () => {
		const message = {
			role: "toolResult",
			toolCallId: "call_inventory",
			toolName: "context_inventory",
			content: [{ type: "text", text: "inventory required for current cleanup decision" }],
		} as unknown as AgentMessage;

		expect(projectUnloadedContext([message], [])[0]).toBe(message);
	});

	test("placeholder includes top-level artifactId when set", () => {
		const message = {
			role: "toolResult",
			toolCallId: "call_a",
			toolName: "bash",
			content: [{ type: "text", text: "very long output" }],
			timestamp: 1,
		} as unknown as AgentMessage;
		const records = [
			{
				...makeRecord({ id: "ctx_art", toolCallId: "call_a", toolName: "bash" }),
				payloadHash: sha256Hex("very long output"),
				summary: "Bash summary",
				artifactId: "artifact-top-level",
				source: { toolCallId: "call_a", toolName: "bash", artifactId: "artifact-source-only" },
			} as unknown as ContextRecord,
		];

		const projected = projectUnloadedContext([message], records);
		const out = projected[0] as unknown as Record<string, unknown>;
		const text = String((out.content as Array<{ text: string }>)[0].text);

		expect(text).toContain("Artifact: artifact-top-level");
		expect(text).not.toContain("artifact-source-only");
	});

	test("leaves loaded records and unmatched messages unchanged", () => {
		const message = {
			role: "user",
			content: "hello",
			timestamp: 1,
		} as unknown as AgentMessage;
		const records = [
			{
				...makeRecord({ id: "ctx_loaded", toolCallId: "call_a", toolName: "bash" }),
				status: "candidate",
			} as unknown as ContextRecord,
		];

		expect(projectUnloadedContext([message], records)[0]).toBe(message);
	});

	test("does not replace custom messages by custom type alone", () => {
		const messages = [
			{
				role: "custom",
				entryId: "context:0",
				customType: "context-gc",
				content: "first custom payload",
				details: { keep: true },
				timestamp: 1,
			},
			{
				role: "custom",
				entryId: "context:1",
				customType: "context-gc",
				content: "second custom payload",
				details: { large: "details should not face the LLM" },
				timestamp: 2,
			},
		] as unknown as AgentMessage[];
		const records = [
			{
				...makeRecord({ id: "ctx_custom", toolCallId: "unused", toolName: "custom" }),
				kind: "custom_tool_output",
				source: { entryId: "context:1", customType: "context-gc" },
				summary: "Custom context summary",
				payloadHash: sha256Hex("second custom payload"),
			} as unknown as ContextRecord,
		];

		const projected = projectUnloadedContext(messages, records);
		const first = projected[0] as unknown as Record<string, unknown>;
		const second = projected[1] as unknown as Record<string, unknown>;

		expect(projected[0]).toBe(messages[0]);
		expect(first.content).toBe("first custom payload");
		expect(second.content).toEqual([{ type: "text", text: expect.stringContaining("Context unloaded: ctx_custom") }]);
		expect(second.details).toBeUndefined();
		expect(String((second.content as Array<{ text: string }>)[0].text)).not.toContain("second custom payload");
	});

	test("does not replace positional custom messages when payload hash differs", () => {
		const message = {
			role: "custom",
			entryId: "context:0",
			customType: "context-gc",
			content: "new custom payload",
			timestamp: 1,
		} as unknown as AgentMessage;
		const records = [
			{
				...makeRecord({ id: "ctx_old_custom", toolCallId: "unused", toolName: "custom" }),
				kind: "custom_tool_output",
				source: { entryId: "context:0", customType: "context-gc" },
				payloadHash: sha256Hex("old custom payload"),
				summary: "Old custom summary",
			} as unknown as ContextRecord,
		];

		expect(projectUnloadedContext([message], records)[0]).toBe(message);
	});

	test("does not project same-content custom messages with different customType values", () => {
		const sharedContent = `shared custom payload ${"x".repeat(2_000)}`;
		const messageA = {
			role: "custom",
			customType: "type-a",
			content: sharedContent,
			timestamp: 1,
		} as unknown as AgentMessage;
		const messageB = {
			role: "custom",
			customType: "type-b",
			content: sharedContent,
			timestamp: 2,
		} as unknown as AgentMessage;
		const records = [
			{
				...makeRecord({ id: "ctx_type_a", toolCallId: "", toolName: "custom" }),
				kind: "custom_tool_output",
				source: { customType: "type-a" },
				payloadHash: sha256Hex(sharedContent),
				summary: "Type A summary",
			} as unknown as ContextRecord,
		];

		const projected = projectUnloadedContext([messageA, messageB], records);
		const outA = projected[0] as unknown as Record<string, unknown>;
		const outB = projected[1] as unknown as Record<string, unknown>;

		expect(outA.content).toEqual([{ type: "text", text: expect.stringContaining("Context unloaded: ctx_type_a") }]);
		expect(projected[1]).toBe(messageB);
		expect(outB.content).toBe(sharedContent);
	});

	test("replaces unloaded custom payloads matched by entry id with kind/customType/payload-hash validation", () => {
		const largePayload = `custom payload ${"y".repeat(2_000)}`;
		const customMessage = {
			role: "custom",
			id: "entry-1",
			customType: "other-custom",
			content: largePayload,
			details: { large: "details should not face the LLM" },
		} as unknown as AgentMessage;
		const records = [
			{
				...makeRecord({ id: "ctx_entry", toolCallId: "", toolName: "custom" }),
				kind: "custom_tool_output",
				// Entry id is a disambiguator, but kind/customType/payload-hash must also match.
				source: { entryId: "entry-1", customType: "other-custom" },
				payloadHash: sha256Hex(largePayload),
				summary: "Entry context summary",
			} as unknown as ContextRecord,
		];

		const projected = projectUnloadedContext([customMessage], records)[0] as unknown as Record<string, unknown>;

		expect(projected.content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_entry") },
		]);
		expect(projected.details).toBeUndefined();
		expect(String((projected.content as Array<{ text: string }>)[0].text)).not.toContain(largePayload);
	});

	test("does not project an entry-id-bound record onto a same-id message when payload hash differs", () => {
		const message = {
			role: "custom",
			id: "entry-1",
			customType: "other-custom",
			content: `changed payload ${"y".repeat(2_000)}`,
		} as unknown as AgentMessage;
		const records = [
			{
				...makeRecord({ id: "ctx_entry", toolCallId: "", toolName: "custom" }),
				kind: "custom_tool_output",
				source: { entryId: "entry-1", customType: "other-custom" },
				// Stale stored-payload hash: entry id alone must not bypass payload validation.
				payloadHash: sha256Hex(`stale payload ${"y".repeat(2_000)}`),
				summary: "Entry context summary",
			} as unknown as ContextRecord,
		];

		expect(projectUnloadedContext([message], records)[0]).toBe(message);
	});

	test("projects same-content custom records bound to distinct entry ids independently", () => {
		const shared = `dup custom payload ${"d".repeat(2_000)}`;
		const messageA = {
			role: "custom",
			id: "entry-A",
			customType: "tool-output",
			content: shared,
			timestamp: 1,
		} as unknown as AgentMessage;
		const messageB = {
			role: "custom",
			id: "entry-B",
			customType: "tool-output",
			content: shared,
			timestamp: 2,
		} as unknown as AgentMessage;
		const recordFor = (id: string, entryId: string): ContextRecord =>
			({
				...makeRecord({ id, toolCallId: "", toolName: "custom" }),
				kind: "custom_tool_output",
				source: { entryId, customType: "tool-output" },
				payloadHash: sha256Hex(shared),
				summary: `${id} summary`,
			}) as unknown as ContextRecord;

		// Unload only the first occurrence: the same-content sibling must stay verbatim.
		const onlyA = projectUnloadedContext([messageA, messageB], [recordFor("ctx_A", "entry-A")]);
		expect((onlyA[0] as unknown as Record<string, unknown>).content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_A") },
		]);
		expect(onlyA[1]).toBe(messageB);

		// Unload both: each record projects only its own entry, never the other's.
		const both = projectUnloadedContext(
			[messageA, messageB],
			[recordFor("ctx_A", "entry-A"), recordFor("ctx_B", "entry-B")],
		);
		expect((both[0] as unknown as Record<string, unknown>).content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_A") },
		]);
		expect((both[1] as unknown as Record<string, unknown>).content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_B") },
		]);
	});

	test("does not project an entry-id-bound record onto a live message that dropped its entry id", () => {
		const shared = `entry-bound lost-id payload ${"k".repeat(2_000)}`;
		// Live message carries no stable entry id (e.g. a surface appended live, not yet rebuilt from
		// session entries). An entry-bound record must NOT fall back to hash matching here, or it could
		// project onto the wrong duplicate occurrence.
		const message = {
			role: "custom",
			customType: "tool-output",
			content: shared,
			timestamp: 1,
		} as unknown as AgentMessage;
		const record = {
			...makeRecord({ id: "ctx_lost_id", toolCallId: "", toolName: "custom" }),
			kind: "custom_tool_output",
			source: { entryId: "entry-A", customType: "tool-output" },
			payloadHash: sha256Hex(shared),
			summary: "Entry-bound summary",
		} as unknown as ContextRecord;

		expect(projectUnloadedContext([message], [record])[0]).toBe(message);
	});

	test("entry-id-bound record projects only its own occurrence among same-payload duplicates", () => {
		const shared = `dup entryId payload ${"m".repeat(2_000)}`;
		const messageA = {
			role: "custom",
			entryId: "entry-A",
			customType: "tool-output",
			content: shared,
			timestamp: 1,
		} as unknown as AgentMessage;
		const messageB = {
			role: "custom",
			entryId: "entry-B",
			customType: "tool-output",
			content: shared,
			timestamp: 2,
		} as unknown as AgentMessage;
		// Record bound to the SECOND occurrence's entry id.
		const record = {
			...makeRecord({ id: "ctx_dup_entry", toolCallId: "", toolName: "custom" }),
			kind: "custom_tool_output",
			source: { entryId: "entry-B", customType: "tool-output" },
			payloadHash: sha256Hex(shared),
			summary: "Dup entry summary",
		} as unknown as ContextRecord;

		const projected = projectUnloadedContext([messageA, messageB], [record]);
		// Positionally-first, same-payload occurrence A stays verbatim; only entry-B is projected.
		expect(projected[0]).toBe(messageA);
		expect((projected[1] as unknown as Record<string, unknown>).content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_dup_entry") },
		]);
	});

	test("a single fallback record projects at most one of several duplicate live messages", () => {
		const shared = `fallback dup payload ${"f".repeat(2_000)}`;
		// No entry ids anywhere -> hash-only fallback matching.
		const messageOne = {
			role: "custom",
			customType: "tool-output",
			content: shared,
			timestamp: 1,
		} as unknown as AgentMessage;
		const messageTwo = {
			role: "custom",
			customType: "tool-output",
			content: shared,
			timestamp: 2,
		} as unknown as AgentMessage;
		const record = {
			...makeRecord({ id: "ctx_dup", toolCallId: "", toolName: "custom" }),
			kind: "custom_tool_output",
			source: { customType: "tool-output" },
			payloadHash: sha256Hex(shared),
			summary: "Fallback dup summary",
		} as unknown as ContextRecord;

		const projected = projectUnloadedContext([messageOne, messageTwo], [record]);

		expect((projected[0] as unknown as Record<string, unknown>).content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_dup") },
		]);
		// The record is consumed by the first match; the duplicate stays verbatim.
		expect(projected[1]).toBe(messageTwo);
		expect((projected[1] as unknown as Record<string, unknown>).content).toBe(shared);
	});

	test("two image-bearing records with identical text projection match by stored-payload hash", () => {
		const caption = `vision caption ${"v".repeat(2_000)}`;
		const contentA = [
			{ type: "text", text: caption },
			{ type: "image", mimeType: "image/png", data: "AAAA" },
		];
		const contentB = [
			{ type: "text", text: caption },
			{ type: "image", mimeType: "image/png", data: "BBBB" },
		];
		const messageA = {
			role: "custom",
			customType: "vision",
			content: contentA,
			timestamp: 1,
		} as unknown as AgentMessage;
		const messageB = {
			role: "custom",
			customType: "vision",
			content: contentB,
			timestamp: 2,
		} as unknown as AgentMessage;
		// Record bound to image A by the lossless stored-payload hash (JSON of the content array).
		const recordA = {
			...makeRecord({ id: "ctx_imgA", toolCallId: "", toolName: "custom" }),
			kind: "custom_tool_output",
			source: { customType: "vision" },
			payloadHash: sha256Hex(JSON.stringify(contentA)),
			summary: "Image A summary",
		} as unknown as ContextRecord;

		const projected = projectUnloadedContext([messageA, messageB], [recordA]);

		expect((projected[0] as unknown as Record<string, unknown>).content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_imgA") },
		]);
		// Same text projection but different image bytes -> must NOT alias onto record A.
		expect(projected[1]).toBe(messageB);
	});

	test("replaces unloaded file mention payloads matched by context entry id", () => {
		const fileContent = `export const value = "${"z".repeat(2_000)}";`;
		const messages = [
			{
				role: "fileMention",
				entryId: "context:0",
				files: [{ path: "src/value.ts", content: fileContent, lineCount: 1, byteSize: fileContent.length }],
				timestamp: 3,
			},
			{
				role: "fileMention",
				files: [{ path: "src/other.ts", content: "keep me", lineCount: 1, byteSize: 7 }],
				timestamp: 4,
			},
		] as unknown as AgentMessage[];
		const records = [
			{
				...makeRecord({ id: "ctx_file", toolCallId: "", toolName: "fileMention" }),
				kind: "file_mention",
				source: { entryId: "context:0", path: "src/value.ts" },
				payloadHash: sha256Hex(extractMessagePayload(messages[0]).text),
				summary: "File mention summary",
			} as unknown as ContextRecord,
		];

		const projected = projectUnloadedContext(messages, records);
		const replaced = projected[0] as unknown as Record<string, unknown>;

		expect(replaced.role).toBe("custom");
		expect(replaced.customType).toBe("context-gc-projected");
		expect(replaced.content).toEqual([{ type: "text", text: expect.stringContaining("Context unloaded: ctx_file") }]);
		expect(String((replaced.content as Array<{ text: string }>)[0].text)).not.toContain(fileContent);
		expect(projected[1]).toBe(messages[1]);
	});

	test("does not replace positional file mentions when payload hash differs", () => {
		const oldFile = {
			role: "fileMention",
			files: [{ path: "src/value.ts", content: "old file content", lineCount: 1, byteSize: 16 }],
			timestamp: 3,
		} as unknown as AgentMessage;
		const message = {
			role: "fileMention",
			entryId: "context:0",
			files: [{ path: "src/value.ts", content: "new file content", lineCount: 1, byteSize: 16 }],
			timestamp: 4,
		} as unknown as AgentMessage;
		const records = [
			{
				...makeRecord({ id: "ctx_old_file", toolCallId: "", toolName: "fileMention" }),
				kind: "file_mention",
				source: { entryId: "context:0", path: "src/value.ts" },
				payloadHash: sha256Hex(extractMessagePayload(oldFile).text),
				summary: "Old file summary",
			} as unknown as ContextRecord,
		];

		expect(projectUnloadedContext([message], records)[0]).toBe(message);
	});

	test("projects custom and file mention messages by payload hash regardless of index", () => {
		const customText = `shifted custom payload ${"q".repeat(2_000)}`;
		const customMessage = {
			role: "custom",
			customType: "tool-output",
			content: customText,
			timestamp: 3,
		} as unknown as AgentMessage;
		// Record carries no positional `context:${index}` id — only a stable customType + payload hash.
		const record = {
			...makeRecord({ id: "ctx_shift", toolCallId: "", toolName: "custom" }),
			kind: "custom_tool_output",
			source: { customType: "tool-output" },
			payloadHash: sha256Hex(customText),
			summary: "Shifted custom summary",
		} as unknown as ContextRecord;

		const leadingNoise = [
			{ role: "user", content: "noise one", timestamp: 0 },
			{ role: "user", content: "noise two", timestamp: 1 },
			{ role: "user", content: "noise three", timestamp: 2 },
		] as unknown as AgentMessage[];

		// Same record matches whether the custom message is at index 1 or index 3.
		const atIndexOne = projectUnloadedContext([leadingNoise[0], customMessage], [record]);
		expect(atIndexOne[0]).toBe(leadingNoise[0]);
		expect((atIndexOne[1] as unknown as Record<string, unknown>).content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_shift") },
		]);

		const shifted = projectUnloadedContext([...leadingNoise, customMessage], [record]);
		expect(shifted.slice(0, 3)).toEqual(leadingNoise);
		const replaced = shifted[3] as unknown as Record<string, unknown>;
		expect(replaced.content).toEqual([
			{ type: "text", text: expect.stringContaining("Context unloaded: ctx_shift") },
		]);
		expect(String((replaced.content as Array<{ text: string }>)[0].text)).not.toContain(customText);
	});

	test("projects unloaded bash and python execution messages matched by payload hash", () => {
		const bashMessage = {
			role: "bashExecution",
			command: "make build",
			output: "b".repeat(2_000),
			exitCode: 0,
			timestamp: 1,
		} as unknown as AgentMessage;
		const pythonMessage = {
			role: "pythonExecution",
			code: "run()",
			output: "p".repeat(2_000),
			exitCode: 0,
			timestamp: 2,
		} as unknown as AgentMessage;
		const records = [
			{
				...makeRecord({ id: "ctx_bash", toolCallId: "", toolName: "bash" }),
				kind: "bash_execution",
				source: { command: "make build" },
				payloadHash: sha256Hex(extractMessagePayload(bashMessage).text),
				summary: "Bash summary",
			} as unknown as ContextRecord,
			{
				...makeRecord({ id: "ctx_python", toolCallId: "", toolName: "python" }),
				kind: "python_execution",
				source: { command: "run()" },
				payloadHash: sha256Hex(extractMessagePayload(pythonMessage).text),
				summary: "Python summary",
			} as unknown as ContextRecord,
		];

		const projected = projectUnloadedContext([bashMessage, pythonMessage], records);
		const bashOut = projected[0] as unknown as Record<string, unknown>;
		const pythonOut = projected[1] as unknown as Record<string, unknown>;

		expect(bashOut.role).toBe("custom");
		expect(bashOut.customType).toBe("context-gc-projected");
		expect(String((bashOut.content as Array<{ text: string }>)[0].text)).toContain("Context unloaded: ctx_bash");
		expect(pythonOut.customType).toBe("context-gc-projected");
		expect(String((pythonOut.content as Array<{ text: string }>)[0].text)).toContain("Context unloaded: ctx_python");
	});

	test("does not project execution messages excluded from context", () => {
		const excludedBashMessage = {
			role: "bashExecution",
			command: "make build",
			output: "b".repeat(2_000),
			exitCode: 0,
			excludeFromContext: true,
			timestamp: 1,
		} as unknown as AgentMessage;
		const record = {
			...makeRecord({ id: "ctx_excluded_bash", toolCallId: "", toolName: "bash" }),
			kind: "bash_execution",
			source: { command: "make build" },
			payloadHash: sha256Hex(extractMessagePayload(excludedBashMessage).text),
			summary: "Excluded bash summary",
		} as unknown as ContextRecord;

		const projected = projectUnloadedContext([excludedBashMessage], [record]);

		expect(projected[0]).toBe(excludedBashMessage);
	});
});

function sha256Hex(text: string): string {
	return Bun.SHA256.hash(text, "hex");
}

function makeRecord(input: { id: string; toolCallId: string; toolName: string }): ContextRecord {
	return {
		id: input.id,
		sessionId: "session-1",
		sessionFile: null,
		status: "unloaded",
		kind: "tool_result",
		source: { toolCallId: input.toolCallId, toolName: input.toolName },
		payloadHash: "hash",
		artifactId: null,
		sourceUri: null,
		summary: "Summary",
		tokenEstimate: 100,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		unloadedAt: "2026-06-01T00:00:00.000Z",
		recallCount: 0,
	};
}
