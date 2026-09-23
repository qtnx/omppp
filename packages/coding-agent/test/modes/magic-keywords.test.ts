import { describe, expect, it } from "bun:test";
import {
	MAGIC_KEYWORDS,
	renderOrchestrateNotice,
	renderWorkflowNotice,
	requestsOrchestrate,
	requestsWorkflow,
} from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { clearBundledCommandsCache, loadBundledCommands } from "@oh-my-pi/pi-coding-agent/task/commands";

describe("magic keyword registry", () => {
	it("keeps ids and words unique so notice types and settings keys cannot collide", () => {
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.id)).size).toBe(MAGIC_KEYWORDS.length);
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.word)).size).toBe(MAGIC_KEYWORDS.length);
	});
});

describe("orchestrate notice", () => {
	it("is a self-contained system notice carrying the orchestration contract", () => {
		const notice = renderOrchestrateNotice({
			tools: ["read", "task", "edit", "write", "lsp", "bash", "todo"],
		});
		expect(notice.startsWith("<system-notice>")).toBe(true);
		expect(notice.endsWith("</system-notice>")).toBe(true);
		expect(notice).toContain("orchestrator");
		// The contract must not retain the slash-command input placeholder.
		expect(notice).not.toContain("$@");
	});

	it("omits tool-budget mentions for tools absent from the session", () => {
		const notice = renderOrchestrateNotice({ tools: ["read"] });
		expect(notice).not.toContain("`task` for dispatch");
		expect(notice).not.toContain("`edit`");
		expect(notice).not.toContain("`write`");
		expect(notice).not.toContain("`lsp diagnostics`");
		expect(notice).not.toContain("via `bash`");
		expect(notice).not.toContain("`todo` for tracking");
	});

	it("does not name edit when only write is available", () => {
		const writeOnly = renderOrchestrateNotice({ tools: ["read", "write"] });
		expect(writeOnly).toContain("with `write`");
		expect(writeOnly).not.toContain("`edit`/`write`");
		expect(writeOnly).not.toContain("with `edit`");
	});

	it("does not name write when only edit is available", () => {
		const editOnly = renderOrchestrateNotice({ tools: ["read", "edit"] });
		expect(editOnly).toContain("with `edit`");
		expect(editOnly).not.toContain("`edit`/`write`");
	});
});

describe("workflow notice", () => {
	it("defaults to workpools and hides eval-defined tools when disabled", () => {
		const enabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true });
		const disabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: false });
		expect(enabled).toContain("Default to `workpool()`");
		expect(enabled).toContain("`@tool`");
		expect(disabled).toContain("Default to `workpool()`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});
});

describe("orchestrate slash command removal", () => {
	it("is no longer bundled as a slash command", () => {
		clearBundledCommandsCache();
		const names = loadBundledCommands().map(command => command.name);
		expect(names).not.toContain("orchestrate");
		expect(names).toContain("init");
	});
});

// OMPx fork: the keyword tables above gate behavior too, and behavior needs
// explicit directive intent — these suites were ported from the removed
// per-keyword modules (modes/orchestrate.ts, modes/workflow.ts).
describe("orchestrate request intent", () => {
	it("accepts explicit orchestration directives", () => {
		for (const text of [
			"orchestrate",
			"please orchestrate this rollout",
			"hãy orchestrate the independent changes",
		]) {
			expect(requestsOrchestrate(text)).toBe(true);
		}
	});

	it("rejects mentions, complaints, and negations", () => {
		for (const text of [
			"do not orchestrate this small edit",
			"đừng orchestrate task này",
			"check why the agent likes to orchestrate",
			"orchestrate is too expensive here",
			'say "orchestrate" now',
		]) {
			expect(requestsOrchestrate(text)).toBe(false);
		}
	});
});

describe("workflow request intent", () => {
	it("accepts explicit workflow-tool directives", () => {
		for (const text of [
			"workflow",
			"please workflow this rollout",
			"run these workflows",
			"hãy dùng workflow cho task này",
		]) {
			expect(requestsWorkflow(text)).toBe(true);
		}
	});

	it("rejects mentions, complaints, negations, and generic workflow design", () => {
		for (const text of [
			"đừng spam workflow subagents",
			"do not use workflow for this edit",
			"check why workflow keeps spawning agents",
			"workflow is overused here",
			"design the workflows for our release process",
			'say "workflow" now',
		]) {
			expect(requestsWorkflow(text)).toBe(false);
		}
	});
});
