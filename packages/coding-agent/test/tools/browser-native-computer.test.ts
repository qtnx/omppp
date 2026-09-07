import { describe, expect, it } from "bun:test";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { NATIVE_BROWSER_VIEWPORT, NativeBrowserComputerTool } from "../../src/tools/browser-native-computer";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("native browser computer tool", () => {
	it("uses OpenAI native computer marker and fixed coordinate viewport", () => {
		const tool = new NativeBrowserComputerTool(makeSession());

		expect(tool.native).toEqual({ type: "computer" });
		expect(NATIVE_BROWSER_VIEWPORT).toEqual({ width: 1280, height: 720 });
		expect(tool.description).toContain("1280x720");
	});

	it("accepts native calls with no JSON arguments and rejects unknown fields", () => {
		const tool = new NativeBrowserComputerTool(makeSession());
		const schema = toolWireSchema(tool);

		expect(validateJsonSchemaValue(schema, {}).success).toBe(true);
		expect(validateJsonSchemaValue(schema, { unexpected: true }).success).toBe(false);
	});
});
