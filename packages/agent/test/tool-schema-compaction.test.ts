import { describe, expect, test } from "bun:test";
import { type AgentTool, normalizeTools } from "@oh-my-pi/pi-agent-core";

function makeLargeSchema(): Record<string, unknown> {
	const longDescription = "large schema description ".repeat(500);
	return {
		type: "object",
		description: longDescription,
		properties: {
			query: { type: "string", description: longDescription },
			payload: {
				type: "object",
				description: longDescription,
				properties: {
					nested: {
						type: "object",
						description: longDescription,
						properties: {
							leaf: { type: "string", description: longDescription },
						},
					},
				},
			},
		},
		required: ["query", "payload"],
		$defs: {
			unused: {
				type: "object",
				description: longDescription,
				properties: {
					value: { type: "string", enum: Array.from({ length: 800 }, (_, index) => `value-${index}`) },
				},
			},
		},
	};
}

describe("tool schema compaction", () => {
	test("compacts large schemas while preserving the top-level argument surface", () => {
		const tool = {
			name: "large_tool",
			label: "Large Tool",
			description: "Tool with a huge MCP-style schema",
			parameters: makeLargeSchema(),
			execute: async () => ({ content: [] }),
		} as unknown as AgentTool;

		const normalized = normalizeTools([tool], false);
		const parameters = normalized?.[0]?.parameters as Record<string, unknown>;

		expect(Buffer.byteLength(JSON.stringify(parameters), "utf8")).toBeLessThanOrEqual(4_000);
		expect(parameters.required).toEqual(["query", "payload"]);
		const properties = parameters.properties as Record<string, unknown>;
		expect(properties.query).toBeDefined();
		expect(properties.payload).toBeDefined();
		expect(JSON.stringify(parameters)).not.toContain("large schema description");
		expect(parameters.$defs).toBeUndefined();
	});
});
