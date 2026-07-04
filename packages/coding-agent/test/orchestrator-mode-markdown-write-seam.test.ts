import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { OrchestratorModeState } from "@oh-my-pi/pi-coding-agent/orchestrator-mode/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { enforcePlanModeWrite } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const CWD = "/tmp/orchestrator-markdown-write-seam-test";

function createSession(orchestratorEnabled: boolean): ToolSession {
	const orchestratorState: OrchestratorModeState | undefined = orchestratorEnabled ? { enabled: true } : undefined;
	return {
		cwd: CWD,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getOrchestratorModeState: () => orchestratorState,
		getPlanModeState: () => undefined,
	};
}

function contractMessage(offendingPath: string): string {
	return `In orchestrator mode, only Markdown (.md) files may be written directly — "${offendingPath}" is not a .md file. Delegate non-Markdown changes to a subagent.`;
}

function expectPlanModeSeamMarkdownError(
	session: ToolSession,
	targetPath: string,
	options: { move?: string; op?: "create" | "update" | "delete" },
	offendingPath: string,
): void {
	let thrown: unknown;
	try {
		enforcePlanModeWrite(session, targetPath, options);
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(ToolError);
	if (!(thrown instanceof Error)) throw new Error("Expected plan-mode seam to throw an Error.");
	expect(thrown.message).toBe(contractMessage(offendingPath));
}

describe("orchestrator mode Markdown write plan-mode seam", () => {
	it("routes write checks through enforcePlanModeWrite before plan-mode branching", () => {
		const enabledSession = createSession(true);

		expectPlanModeSeamMarkdownError(enabledSession, "app.ts", { op: "create" }, "app.ts");
		expect(() => enforcePlanModeWrite(enabledSession, "notes.md", { op: "create" })).not.toThrow();
		expectPlanModeSeamMarkdownError(enabledSession, "notes.md", { op: "update", move: "deploy.sh" }, "deploy.sh");

		const disabledSession = createSession(false);
		expect(() => enforcePlanModeWrite(disabledSession, "app.ts", { op: "create" })).not.toThrow();
	});
});
