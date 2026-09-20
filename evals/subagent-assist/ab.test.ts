import { expect, test } from "bun:test";
import { parseTrace } from "./ab";

test("measures one completed child from duplicate envelopes, never parent prose", () => {
	const envelope = '<task-result id="Probe" agent="scout" status="completed" duration="1m 2s"><output>observed fact</output></task-result>';
	const events = [
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: envelope.replace("Probe", "Fake") }] } },
		{ type: "tool_execution_end", result: { content: [{ type: "text", text: envelope }] } },
		{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: envelope }] } },
	];
	const result = parseTrace(events.map(event => JSON.stringify(event)).join("\n"));
	expect(result.taskResults).toBe(1);
	expect(result.childDurationMs).toEqual([62000]);
	expect(result.outputs).toEqual([envelope]);
});

test("failed children remain attempted but contribute neither successful output nor timing", () => {
	const result = parseTrace(JSON.stringify({ type: "tool_execution_end", result: {
		id: "Probe", agent: "scout", exitCode: 1, output: "expected fact but execution failed", durationMs: 90,
		resolvedModel: "provider/model:high", resolvedThinkingLevel: "high",
	} }));
	expect(result.taskResults).toBe(1);
	expect(result.outputs).toEqual([]);
	expect(result.childDurationMs).toEqual([]);
	expect(result.childStatuses).toEqual([{ id: "Probe", agent: "scout", status: "failed", resolvedModel: "provider/model:high", resolvedThinkingLevel: "high" }]);
});
