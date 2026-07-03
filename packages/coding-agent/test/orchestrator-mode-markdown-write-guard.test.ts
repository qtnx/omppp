import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	enforceOrchestratorModeMarkdownWrite,
	type OrchestratorModeMarkdownWriteOptions,
} from "@oh-my-pi/pi-coding-agent/orchestrator-mode/markdown-write-guard";
import {
	ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES,
	type OrchestratorModeState,
} from "@oh-my-pi/pi-coding-agent/orchestrator-mode/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const CWD = "/tmp/orchestrator-markdown-write-guard-test";

function createSession(enabled: boolean): ToolSession {
	const state: OrchestratorModeState | undefined = enabled ? { enabled: true } : undefined;
	return {
		cwd: CWD,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getOrchestratorModeState: () => state,
	};
}

function contractMessage(offendingPath: string): string {
	return `In orchestrator mode, only Markdown (.md) files may be written directly \u2014 "${offendingPath}" is not a .md file. Delegate non-Markdown changes to a subagent.`;
}

function expectMarkdownGuardError(
	session: ToolSession,
	targetPath: string,
	opts: OrchestratorModeMarkdownWriteOptions | undefined,
	offendingPath: string,
): void {
	let thrown: unknown;
	try {
		enforceOrchestratorModeMarkdownWrite(session, targetPath, opts);
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(ToolError);
	if (!(thrown instanceof Error)) throw new Error("Expected markdown guard to throw an Error.");
	expect(thrown.message).toBe(contractMessage(offendingPath));
}

describe("orchestrator mode Markdown write guard", () => {
	it("allows Markdown targets when orchestrator mode is enabled", () => {
		const session = createSession(true);

		for (const targetPath of ["notes.md", "NOTES.MD"]) {
			expect(() => enforceOrchestratorModeMarkdownWrite(session, targetPath, { op: "update" })).not.toThrow();
		}
	});

	it("rejects non-Markdown write and edit targets when orchestrator mode is enabled", () => {
		const session = createSession(true);

		expectMarkdownGuardError(session, "app.ts", { op: "update" }, "app.ts");
		expectMarkdownGuardError(session, "data.json", { op: "create" }, "data.json");
		expectMarkdownGuardError(session, "Makefile", { op: "update" }, "Makefile");
		expectMarkdownGuardError(session, "notes.markdown", { op: "update" }, "notes.markdown");
	});

	it("checks both source and destination for moves when orchestrator mode is enabled", () => {
		const session = createSession(true);

		expectMarkdownGuardError(session, "notes.md", { op: "update", move: "deploy.sh" }, "deploy.sh");
		expectMarkdownGuardError(session, "secret.env", { op: "update", move: "notes.md" }, "secret.env");
		expect(() =>
			enforceOrchestratorModeMarkdownWrite(session, "notes.md", { op: "update", move: "archive/NOTES.MD" }),
		).not.toThrow();
	});

	it("blocks non-Markdown deletes while allowing Markdown write/edit/delete operations", () => {
		const session = createSession(true);

		expectMarkdownGuardError(session, "cache.tmp", { op: "delete" }, "cache.tmp");
		expect(() => enforceOrchestratorModeMarkdownWrite(session, "notes.md", { op: "create" })).not.toThrow();
		expect(() => enforceOrchestratorModeMarkdownWrite(session, "notes.md", { op: "update" })).not.toThrow();
		expect(() => enforceOrchestratorModeMarkdownWrite(session, "notes.md", { op: "delete" })).not.toThrow();
	});

	it("is a no-op when orchestrator mode is disabled", () => {
		const session = createSession(false);

		for (const [targetPath, opts] of [
			["app.ts", { op: "update" }],
			["data.json", { op: "create" }],
			["Makefile", { op: "delete" }],
			["notes.md", { op: "update", move: "deploy.sh" }],
		] satisfies Array<[string, OrchestratorModeMarkdownWriteOptions]>) {
			expect(() => enforceOrchestratorModeMarkdownWrite(session, targetPath, opts)).not.toThrow();
		}
	});

	it("keeps write and edit available in the orchestrator mode tool allowlist", () => {
		expect(ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES).toContain("write");
		expect(ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES).toContain("edit");
	});
});
