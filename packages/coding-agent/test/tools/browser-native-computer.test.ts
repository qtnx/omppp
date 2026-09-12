import { describe, expect, it } from "bun:test";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { NativeBrowserComputerTool } from "../../src/tools/browser-native-computer";
import { runInTab } from "../../src/tools/browser/tab-supervisor";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

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
	it("rejects unsupported viewport presets before opening a browser", () => {
		const schema = toolWireSchema(new NativeBrowserComputerTool(makeSession()));
		expect(validateJsonSchemaValue(schema, { viewport: "sideways" }).success).toBe(false);
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"resizes a live mobile tab, retains its viewport, and returns to desktop",
		async () => {
			const tool = new NativeBrowserComputerTool(makeSession());
			const url = `data:text/html,${encodeURIComponent(`<meta name="viewport" content="width=device-width,initial-scale=1"><button style="position:fixed;left:10px;top:10px;width:100px;height:50px" onclick="document.title='clicked'">Tap</button>`)}`;
			const metrics = async () =>
				(
					await runInTab("browser_use", {
						code: 'return await page.evaluate(() => ({ width: innerWidth, height: innerHeight, touch: matchMedia("(pointer: coarse)").matches, landscape: matchMedia("(orientation: landscape)").matches, title: document.title }));',
						timeoutMs: 30_000,
						session: tool.session,
					})
				).returnValue;
			try {
				const portrait = await tool.execute("portrait", { url, viewport: "mobile" });
				expect(portrait.isError).not.toBe(true);
				expect(portrait.content.some(part => part.type === "image")).toBe(true);
				expect(await metrics()).toMatchObject({ width: 390, height: 844, touch: true, landscape: false });
				const landscape = await tool.execute("landscape", { viewport: "mobile-landscape" });
				expect(landscape.isError).not.toBe(true);
				expect(await metrics()).toMatchObject({ width: 844, height: 390, touch: true, landscape: true });
				await tool.execute("click", { actions: [{ type: "click", x: 50, y: 30 }] });
				expect(await metrics()).toMatchObject({ width: 844, height: 390, title: "clicked" });
				const desktop = await tool.execute("desktop", { viewport: "desktop" });
				expect(desktop.isError).not.toBe(true);
				expect(await metrics()).toMatchObject({ width: 1280, height: 720, touch: false, landscape: true });
			} finally {
				await tool.close();
			}
		},
		120_000,
	);

	it("accepts native calls with no JSON arguments and rejects unknown fields", () => {
		const tool = new NativeBrowserComputerTool(makeSession());
		const schema = toolWireSchema(tool);

		expect(validateJsonSchemaValue(schema, {}).success).toBe(true);
		expect(validateJsonSchemaValue(schema, { unexpected: true }).success).toBe(false);
	});

	it("accepts navigate actions and rejects action types outside the documented set", () => {
		const tool = new NativeBrowserComputerTool(makeSession());
		const schema = toolWireSchema(tool);

		expect(
			validateJsonSchemaValue(schema, { actions: [{ type: "navigate", url: "http://localhost/app" }] }).success,
		).toBe(true);
		expect(
			validateJsonSchemaValue(schema, { actions: [{ type: "goto", url: "http://localhost/app" }] }).success,
		).toBe(false);
	});
});
