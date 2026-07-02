import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ShakeMode } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession, ToolShakeRequest } from "@oh-my-pi/pi-coding-agent/tools";
import { ShakeTool } from "@oh-my-pi/pi-coding-agent/tools/shake";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

type ShakeSession = ToolSession & {
	requestShake?: (mode: ShakeMode) => ToolShakeRequest;
};

function createSession(overrides: Partial<ShakeSession> = {}): ShakeSession {
	return {
		cwd: "/tmp/shake-tool-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	} as ShakeSession;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("ShakeTool", () => {
	it("is unavailable when the session cannot request shake", () => {
		expect(ShakeTool.createIf(createSession({ requestShake: undefined }))).toBeNull();
	});

	it("schedules elide mode by default", async () => {
		let received: ShakeMode | undefined;
		const tool = ShakeTool.createIf(
			createSession({
				requestShake: mode => {
					received = mode;
					return { status: "scheduled" };
				},
			}),
		);
		expect(tool).not.toBeNull();

		const result = await tool!.execute("call-1", { reason: "phase boundary" });

		expect(received).toBe("elide");
		expect(getText(result)).toContain("turn ends");
	});

	it("reports already-scheduled without throwing", async () => {
		const tool = ShakeTool.createIf(
			createSession({
				requestShake: () => ({ status: "already-scheduled" }),
			}),
		);
		expect(tool).not.toBeNull();

		const result = await tool!.execute("call-1", { reason: "phase boundary" });

		expect(getText(result)).toContain("Do not call again");
	});

	it("passes through images mode", async () => {
		let received: ShakeMode | undefined;
		const tool = ShakeTool.createIf(
			createSession({
				requestShake: mode => {
					received = mode;
					return { status: "scheduled" };
				},
			}),
		);
		expect(tool).not.toBeNull();

		await tool!.execute("call-1", { mode: "images", reason: "drop stale screenshots" });

		expect(received).toBe("images");
	});

	it("throws ToolError when shake is unavailable", async () => {
		const tool = ShakeTool.createIf(
			createSession({
				requestShake: () => ({ status: "unavailable", detail: "session is not ready" }),
			}),
		);
		expect(tool).not.toBeNull();

		await expect(tool!.execute("call-1", { reason: "phase boundary" })).rejects.toThrow(ToolError);
	});
});
