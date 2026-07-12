import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { WorkflowHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/workflow-hub";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { WorkflowRunRegistry } from "@oh-my-pi/pi-coding-agent/workflow/run-registry";

beforeAll(async () => {
	await initTheme();
});

interface EditorSlot {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createEditorSlot(...initial: unknown[]): EditorSlot {
	return {
		children: [...initial],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function createCtx(slot: EditorSlot, editor: unknown) {
	const setFocus = vi.fn();
	const ctx = {
		editor,
		editorContainer: slot,
		ui: {
			setFocus,
			requestRender: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	return { ctx, setFocus };
}
function createWorkflowCtx(
	slot: EditorSlot,
	editor: unknown,
	onTranscriptOpen: (viewer: AgentTranscriptViewer) => void,
): InteractiveModeContext {
	const ctx = {
		editor,
		editorContainer: slot,
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			showOverlay(component: unknown) {
				if (!(component instanceof AgentTranscriptViewer)) {
					throw new Error("Workflow transcript did not open an AgentTranscriptViewer");
				}
				onTranscriptOpen(component);
				return { hide: vi.fn() };
			},
		},
		keybindings: { getKeys: vi.fn(() => []) },
		session: { getToolByName: () => undefined },
		sessionManager: { getCwd: () => "/tmp" },
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
	} as unknown as InteractiveModeContext;
	return ctx;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});
describe("SelectorController.focusActiveEditorArea", () => {
	// Regression for issue #3349: closing a fullscreen overlay (settings,
	// extensions dashboard, agents dashboard) while a hook selector / approval
	// prompt occupies the editor slot must restore focus to that prompt — not
	// to the editor that the prompt replaced. Pre-fix, the close handlers
	// hardcoded `setFocus(this.ctx.editor)`, leaving keystrokes routed to a
	// no-longer-mounted editor while the visible prompt sat unreachable.

	it("focuses the editor when the slot has only the editor in it", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot(editor);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
	});

	it("focuses the active hook-selector-style prompt when the slot holds it instead of the editor", () => {
		const editor = { id: "editor" };
		const approvalPrompt = { id: "approval-prompt" };
		// Mirrors `ExtensionUiController.showHookSelector`: the hook surface
		// clears the slot and replaces the editor with its prompt component.
		const slot = createEditorSlot(approvalPrompt);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(approvalPrompt);
		expect(setFocus).not.toHaveBeenCalledWith(editor);
	});

	it("falls back to the editor when the slot is empty (defensive)", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot();
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
	});
});

describe("SelectorController workflow transcript opening", () => {
	it("keeps a provisional workflow-agent transcript read-only until its live session exists", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot(editor);
		let transcript: AgentTranscriptViewer | undefined;
		const ctx = createWorkflowCtx(slot, editor, viewer => {
			transcript = viewer;
		});
		const workflows = new WorkflowRunRegistry();
		workflows.ingest({
			kind: "agent",
			runId: "workflow-provisional",
			index: 0,
			label: "Provisioned worker",
			state: "start",
			agentId: "workflow-agent-provisional",
			sessionFile: "/tmp/workflow-agent-provisional.jsonl",
		});

		new SelectorController(ctx).showWorkflowHub(workflows, { getSessions: () => [] } as never);
		const hub = slot.children[0];
		if (!(hub instanceof WorkflowHubOverlayComponent)) {
			throw new Error("Workflow Hub was not mounted in the editor slot");
		}

		try {
			hub.handleInput("\r");
			if (!transcript) throw new Error("Workflow Hub did not open a transcript viewer");

			const rendered = transcript
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");

			expect(rendered).toContain("Agent Hub");
			expect(rendered).not.toContain("Enter:send");

			transcript.handleInput("\u001B");
			hub.handleInput("\r");
			if (!transcript) throw new Error("Workflow Hub did not reopen a transcript viewer");
			const reopenedRendered = transcript
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(reopenedRendered).not.toContain("Enter:send");

			AgentRegistry.global().register({
				id: "workflow-agent-provisional",
				displayName: "Provisioned worker",
				kind: "sub",
				session: {} as never,
				sessionFile: "/tmp/workflow-agent-provisional.jsonl",
				status: "running",
			});

			const liveRendered = transcript
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(liveRendered).toContain("Enter:send");
		} finally {
			hub.handleInput("\u001B");
		}
	});
	it("keeps a transient workflow transcript read-only after reopening the workflow hub", () => {
		const workflowAgentId = "workflow-agent-provisional-reopen";
		const editor = { id: "editor" };
		const slot = createEditorSlot(editor);
		let transcript: AgentTranscriptViewer | undefined;
		const ctx = createWorkflowCtx(slot, editor, viewer => {
			transcript = viewer;
		});
		const workflows = new WorkflowRunRegistry();
		workflows.ingest({
			kind: "agent",
			runId: "workflow-provisional-reopen",
			index: 0,
			label: "Provisioned worker",
			state: "start",
			agentId: workflowAgentId,
			sessionFile: "/tmp/workflow-agent-provisional-reopen.jsonl",
		});
		const controller = new SelectorController(ctx);

		controller.showWorkflowHub(workflows, { getSessions: () => [] } as never);
		const firstHub = slot.children[0];
		if (!(firstHub instanceof WorkflowHubOverlayComponent)) {
			throw new Error("Workflow Hub was not mounted in the editor slot");
		}

		try {
			firstHub.handleInput("\r");
			if (!transcript) throw new Error("Workflow Hub did not open a transcript viewer");

			firstHub.handleInput("\u001B");

			controller.showWorkflowHub(workflows, { getSessions: () => [] } as never);
			const reopenedHub = slot.children[0];
			if (!(reopenedHub instanceof WorkflowHubOverlayComponent)) {
				throw new Error("Workflow Hub was not remounted in the editor slot");
			}

			reopenedHub.handleInput("\r");
			if (!transcript) throw new Error("Reopened Workflow Hub did not open a transcript viewer");

			const rendered = transcript
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain("Enter:send");
		} finally {
			const activeHub = slot.children[0];
			if (activeHub instanceof WorkflowHubOverlayComponent) activeHub.handleInput("\u001B");
		}
	});

	it("submits through a cold-revivable parked workflow transcript", async () => {
		const workflowAgentId = "workflow-agent-cold-revive";
		const editor = { id: "editor" };
		const slot = createEditorSlot(editor);
		let transcript: AgentTranscriptViewer | undefined;
		const ctx = createWorkflowCtx(slot, editor, viewer => {
			transcript = viewer;
		});
		const prompted = Promise.withResolvers<void>();
		const prompt = vi.fn(async () => {
			prompted.resolve();
		});
		const registry = AgentRegistry.global();
		registry.register({
			id: workflowAgentId,
			displayName: "Cold-revivable worker",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/workflow-agent-cold-revive.jsonl",
			status: "parked",
		});
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.setPersistedSubagentReviverFactory(async () => async () => ({ prompt }) as never, 0);
		const ensureLive = vi.spyOn(lifecycle, "ensureLive");
		const workflows = new WorkflowRunRegistry();
		workflows.ingest({
			kind: "agent",
			runId: "workflow-cold-revive",
			index: 0,
			label: "Cold-revivable worker",
			state: "done",
			agentId: workflowAgentId,
			sessionFile: "/tmp/workflow-agent-cold-revive.jsonl",
		});

		new SelectorController(ctx).showWorkflowHub(workflows, { getSessions: () => [] } as never);
		const hub = slot.children[0];
		if (!(hub instanceof WorkflowHubOverlayComponent)) {
			throw new Error("Workflow Hub was not mounted in the editor slot");
		}

		try {
			hub.handleInput("\r");
			if (!transcript) throw new Error("Workflow Hub did not open a transcript viewer");

			expect(
				transcript
					.render(100)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).toContain("Enter:send");

			transcript.handleInput("continue the workflow");
			transcript.handleInput("\r");
			await prompted.promise;

			expect(ensureLive).toHaveBeenCalledTimes(1);
			expect(ensureLive).toHaveBeenCalledWith(workflowAgentId);
			expect(prompt).toHaveBeenCalledWith("continue the workflow", { streamingBehavior: "steer" });
		} finally {
			transcript?.dispose();
			hub.handleInput("\u001B");
		}
	});
});

describe("AgentTranscriptViewer workflow transcript submission", () => {
	it("revives a sendable parked workflow agent before prompting the submitted text", async () => {
		const workflowAgentId = "workflow-agent-submit";
		const prompt = vi.fn(async () => {});
		const session = { prompt } as never;
		const ensureLive = vi.fn(async () => session);
		const registry = new AgentRegistry();
		registry.register({
			id: workflowAgentId,
			displayName: "Workflow agent",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/workflow-agent-submit.jsonl",
			status: "parked",
		});
		const viewer = new AgentTranscriptViewer({
			agentId: workflowAgentId,
			registry,
			lifecycle: () => ({ ensureLive }) as never,
			ui: { requestRender: vi.fn() } as never,
			cwd: "/tmp",
			expandKeys: [],
			hubKeys: [],
			requestRender: vi.fn(),
			onClose: vi.fn(),
			onHubClose: vi.fn(),
		});

		try {
			expect(
				viewer
					.render(100)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).toContain("Enter:send");

			viewer.handleInput("continue the workflow");
			viewer.handleInput("\r");
			for (let i = 0; i < 5; i++) await Promise.resolve();

			expect(ensureLive).toHaveBeenCalledTimes(1);
			expect(ensureLive).toHaveBeenCalledWith(workflowAgentId);
			expect(prompt).toHaveBeenCalledWith("continue the workflow", { streamingBehavior: "steer" });
		} finally {
			viewer.dispose();
		}
	});
});
