import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setKeybindings, type Component, type TerminalFrameProvider, type TUI } from "@oh-my-pi/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeSurfaceProvider } from "@oh-my-pi/pi-tui/native/node";
import { AskDialogComponent, type ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { APPROVE_ARM_MS, ApprovalDialogComponent } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./native/tsp-harness";

const ENTER = "\n";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const SHIFT_RIGHT = "\x1b[1;2C";
const SHIFT_LEFT = "\x1b[1;2D";

/** A terminal that draws every kind (`meter` included). */
const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** Depth-first search over described nodes, with the keypath the reconciler reports (hoisted overlays get `^`). */
function find(
	root: NativeNode,
	predicate: (node: NativeNode) => boolean,
	path = "",
): { node: NativeNode; path: string } | undefined {
	for (const [index, child] of (root.c ?? []).entries()) {
		if (!isNode(child)) continue;
		const segment = child.k === "overlay" ? `^${child.key ?? index}` : `${child.key ?? index}`;
		const childPath = path ? `${path}/${segment}` : segment;
		if (predicate(child)) return { node: child, path: childPath };
		const found = find(child, predicate, childPath);
		if (found) return found;
	}
	return undefined;
}

const QUESTIONS: ExtensionAskDialogQuestion[] = [
	{
		id: "policy",
		question: "How should frames without credits be handled?",
		options: [{ label: "Drop them" }, { label: "Park them" }, { label: "Block" }],
		recommended: 1,
	},
	{ id: "flag", question: "Ship behind a flag?", options: [{ label: "Yes" }, { label: "No" }] },
];

function ask(onSubmit = vi.fn(), onCancel = vi.fn()): AskDialogComponent {
	return new AskDialogComponent(QUESTIONS, { onSubmit, onCancel, onPrompt: async () => undefined });
}

describe("dialogs under a native surface", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme unavailable");
		setThemeInstance(dark);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("ask: the action bar's Submit answers exactly as Enter does, question by question", () => {
		const viaKeys = vi.fn();
		const keyed = ask(viaKeys);
		keyed.handleInput(ENTER);
		keyed.handleInput(DOWN);
		keyed.handleInput(ENTER);
		keyed.handleInput(ENTER);

		const viaPointer = vi.fn();
		const pointed = ask(viaPointer);
		const press = (act: string) => {
			const button = find(pointed.describe(CX), node => node.p?.role === "omp.btn" && node.key === act);
			if (!button) throw new Error(`no ${act} button`);
			pointed.handleNativeEvent({ type: "action", key: button.path, act, mods: [] });
		};
		press("submit");
		pointed.handleInput(DOWN);
		press("submit");
		// Review tab: Submit sends the answers.
		press("submit");

		expect(viaKeys).toHaveBeenCalledTimes(1);
		expect(viaPointer.mock.calls).toEqual(viaKeys.mock.calls);
		expect(
			viaPointer.mock.calls[0]?.[0].results.map((r: { selectedOptions: string[] }) => r.selectedOptions),
		).toEqual([["Park them"], ["No"]]);
	});

	it("ask: tab and option events reach the dialog through its described keypaths", () => {
		const onSubmit = vi.fn();
		const dialog = ask(onSubmit);
		const tabs = find(dialog.describe(CX), node => node.k === "tabs");
		dialog.handleNativeEvent({ type: "select", key: tabs!.path, item: "1" });
		const options = find(dialog.describe(CX), node => node.p?.role === "omp.ask.options");
		expect(options?.node.key).toBe("q1");
		dialog.handleNativeEvent({ type: "activate", key: options!.path, item: "option:0" });
		dialog.handleNativeEvent({ type: "action", key: "x", act: "submit", mods: [] });
		expect(onSubmit.mock.calls[0]?.[0].results[1].selectedOptions).toEqual(["Yes"]);
	});

	it("ask: docks in place of the composer instead of a modal sheet over the transcript", async () => {
		// A modal bottom sheet hid the transcript rows explaining the question and blocked scrolling.
		const transcript: Component = { render: () => [], invalidate: () => {}, describe: () => md("Why this decision") };
		const dialog = ask();
		const provider: TerminalFrameProvider & NativeSurfaceProvider = {
			renderFrame: () => ({ viewport: [] }),
			acknowledgeHistory: () => {},
			describeSurface: () => ({ main: [transcript], dock: [dialog] }),
		};
		const harness = await TspHarness.start(tui => {
			tui.setFrameProvider(provider);
			tui.setFocus(dialog);
		});
		try {
			expect(harness.errors).toEqual([]);
			expect(harness.region("layer")?.c ?? []).toEqual([]);
			const dock = harness.region("dock")!;
			// Framed as the prompt composer (an `omp.editor.*` root role), so Tern draws the composer's shell.
			const root = dock.c?.find(node => node.p?.role === "omp.editor.ask");
			expect(root?.c?.some(node => node.p?.role === "omp.ask.options")).toBe(true);
			expect(harness.findAll(node => node.k === "overlay")).toEqual([]);
		} finally {
			harness.stop();
		}
	});

	it("ask: a chosen answer is marked apart from the highlighted row; answered tabs and the review say what was chosen", () => {
		const dialog = ask();
		const item = (key: string) => find(dialog.describe(CX), node => node.k === "item" && node.key === key)?.node.p;
		// The highlighted (recommended) row is not chosen until Enter.
		expect(item("option:1")?.tone).toBeUndefined();
		dialog.handleInput(ENTER);
		dialog.handleInput(LEFT);
		expect(item("option:1")?.tone).toBe("accent");
		expect(item("option:0")?.tone).toBeUndefined();
		const items = (kind: string) =>
			(find(dialog.describe(CX), node => node.k === kind)?.node.p as { items?: unknown } | undefined)?.items;
		const tabs = items("tabs") as { label: { t: string }[] }[];
		expect(tabs.map(tab => tab.label.map(part => part.t).join(""))).toEqual(["✓ policy", "flag", "Review"]);
		dialog.handleInput(RIGHT);
		dialog.handleInput(RIGHT);
		const answers = items("kv") as { k: string; v: { t: string }[] }[];
		expect(answers.map(entry => [entry.k, entry.v.map(part => part.t).join("")])).toEqual([
			["policy", "Park them"],
			["flag", "Unanswered"],
		]);
	});

	it("ask: Skip cancels like Esc; the recommended option loses its suffix for the badge", () => {
		const onCancel = vi.fn();
		const dialog = ask(vi.fn(), onCancel);
		const recommended = find(dialog.describe(CX), node => node.k === "item" && node.key === "option:1");
		expect(recommended?.node.p).toMatchObject({ label: [{ t: "Park them" }], value: [{ t: "Recommended" }] });
		dialog.handleNativeEvent({ type: "action", key: "x", act: "cancel", mods: [] });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("ask: hiding (Alt+H or Hide) never answers; Enter or Show restores the same pending question", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const dialog = ask(onSubmit, onCancel);
		const options = () => find(dialog.describe(CX), node => node.p?.role === "omp.ask.options");
		const press = (act: string) => {
			const button = find(dialog.describe(CX), node => node.p?.role === "omp.btn" && node.key === act);
			if (!button) throw new Error(`no ${act} button`);
			dialog.handleNativeEvent({ type: "action", key: button.path, act, mods: [] });
		};

		press("hide");
		expect(options()).toBeUndefined();
		expect(dialog.render(80)).toHaveLength(1);
		// A Submit click left over from the expanded bar must not answer the hidden question.
		dialog.handleNativeEvent({ type: "action", key: "x", act: "submit", mods: [] });
		dialog.handleInput(ENTER);
		expect(options()).toBeDefined();

		dialog.handleInput("\x1bh");
		expect(dialog.render(80)).toHaveLength(1);
		press("show");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		dialog.handleInput(ENTER);
		dialog.handleInput(ENTER);
		dialog.handleInput(ENTER);
		expect(onSubmit.mock.calls[0]?.[0].results.map((r: { selectedOptions: string[] }) => r.selectedOptions)).toEqual([
			["Park them"],
			["Yes"],
		]);
	});

	it("ask: hidden while a draft owns input, Enter stays with the draft and only the hide key restores", () => {
		let draft = "half-typed";
		const routed: string[] = [];
		const dialog = new AskDialogComponent(
			QUESTIONS,
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: async () => undefined },
			{
				inputGuard: {
					isBlocked: () => draft.length > 0,
					handleInput: key => routed.push(key),
					hint: "Finish or clear the current prompt to answer",
				},
			},
		);
		const line = () => stripVTControlCharacters(dialog.render(200).join("\n"));

		dialog.handleInput("\x1bh");
		expect(line()).toContain("Finish or clear the current prompt to answer");
		expect(line()).not.toContain("/⏎ show");
		dialog.handleInput(ENTER);
		expect(routed).toEqual([ENTER]);
		expect(dialog.render(200)).toHaveLength(1);

		draft = "";
		expect(line()).toContain("/⏎ show");
		dialog.handleInput("\x1bh");
		expect(dialog.render(200).length).toBeGreaterThan(1);
	});

	it("approval: Enter never approves; the follow-up chord is ignored until armed, then approves; Esc denies", () => {
		const prompt = "Allow tool: write\nPath: /tmp/out.txt";
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const keyed = { onApprove: vi.fn(), onDeny: vi.fn() };
			const dialog = new ApprovalDialogComponent(prompt, keyed);
			// An Enter typed for the composer, and a follow-up (Ctrl+Enter, Ctrl+Q) sent as the prompt mounts.
			for (const key of [ENTER, "\r", "\x1b[13;5u", "\x11"]) dialog.handleInput(key);
			now.mockReturnValue(1_000 + APPROVE_ARM_MS - 1);
			dialog.handleInput("\x1b[13;5u");
			expect(keyed.onApprove).not.toHaveBeenCalled();
			expect(keyed.onDeny).not.toHaveBeenCalled();
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			dialog.handleInput("\x1b[13;5u");
			// Settled once: a later Esc does not also deny.
			dialog.handleInput("\x1b");
			expect(keyed.onApprove).toHaveBeenCalledTimes(1);
			expect(keyed.onDeny).not.toHaveBeenCalled();

			// Denying and clicking Approve are deliberate, so neither waits to arm.
			const denied = { onApprove: vi.fn(), onDeny: vi.fn() };
			new ApprovalDialogComponent(prompt, denied).handleInput("\x1b");
			expect(denied.onDeny).toHaveBeenCalledTimes(1);
			const pointed = { onApprove: vi.fn(), onDeny: vi.fn() };
			const clicked = new ApprovalDialogComponent(prompt, pointed);
			const approve = find(clicked.describe(), node => node.p?.role === "omp.btn" && node.key === "approve");
			clicked.handleNativeEvent({ type: "action", key: approve!.path, act: "approve", mods: [] });
			expect(pointed.onApprove).toHaveBeenCalledTimes(1);
		} finally {
			now.mockRestore();
		}
	});

	it("approval: any key restarts the timeout (reporting start and reset), so a scroll before the deadline keeps it open", () => {
		vi.useFakeTimers();
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
		const onTimeout = vi.fn();
		const onTimeoutStart = vi.fn();
		const onTimeoutReset = vi.fn();
		const dialog = new ApprovalDialogComponent("Allow tool: bash\nCommand: ls", callbacks, {
			timeout: 1_000,
			onTimeout,
			onTimeoutStart,
			onTimeoutReset,
		});
		try {
			expect(onTimeoutStart).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(900);
			dialog.handleInput(DOWN);
			expect(onTimeoutReset).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(200);
			expect(onTimeout).not.toHaveBeenCalled();
			expect(callbacks.onDeny).not.toHaveBeenCalled();
			vi.advanceTimersByTime(800);
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
		} finally {
			dialog.dispose();
			vi.useRealTimers();
		}
	});

	it("approval: an expired timeout denies (never approves) and reports the timeout", async () => {
		const denied = Promise.withResolvers<void>();
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn(() => denied.resolve()) };
		const onTimeout = vi.fn();
		const dialog = new ApprovalDialogComponent("Allow tool: bash\nCommand: ls", callbacks, { timeout: 1, onTimeout });
		try {
			await denied.promise;
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
			expect(callbacks.onApprove).not.toHaveBeenCalled();
		} finally {
			dialog.dispose();
		}
	});

	it("approval: wrapDetails shows a long detail whole instead of clipping it to one row", () => {
		const command = `Command: echo ok && ${"x".repeat(120)} && rm -rf ~`;
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
		const body = (dialog: ApprovalDialogComponent) =>
			stripVTControlCharacters(dialog.render(60).join("\n")).replace(/[│\s]+/g, "");
		expect(body(new ApprovalDialogComponent(`Allow tool: bash\n${command}`, callbacks))).not.toContain("rm-rf~");
		const wrapped = new ApprovalDialogComponent(`Allow tool: bash\n${command}`, callbacks, { wrapDetails: true });
		expect(body(wrapped)).toContain("rm-rf~");
		const row = find(wrapped.describe(), node => node.p?.role === "omp.approval.details")?.node.c?.[0];
		expect((row as NativeNode).p).not.toHaveProperty("truncate");
	});

	it("approval: docks in place of the composer with its details, not a card over the transcript", async () => {
		const transcript: Component = { render: () => [], invalidate: () => {}, describe: () => md("Why this write") };
		const dialog = new ApprovalDialogComponent("Allow tool: write\nPath: /tmp/out.txt", {
			onApprove: vi.fn(),
			onDeny: vi.fn(),
		});
		const provider: TerminalFrameProvider & NativeSurfaceProvider = {
			renderFrame: () => ({ viewport: [] }),
			acknowledgeHistory: () => {},
			describeSurface: () => ({ main: [transcript], dock: [dialog] }),
		};
		const harness = await TspHarness.start(tui => {
			tui.setFrameProvider(provider);
			tui.setFocus(dialog);
		});
		try {
			expect(harness.errors).toEqual([]);
			const root = harness.region("dock")!.c?.find(node => node.p?.role === "omp.editor.ask.approval");
			const details = root?.c?.find(node => node.p?.role === "omp.approval.details");
			expect(details?.c?.map(node => node.p)).toEqual([
				expect.objectContaining({ text: "Path: /tmp/out.txt", truncate: "end" }),
			]);
			expect(harness.findAll(node => node.k === "overlay" || node.k === "card")).toEqual([]);
		} finally {
			harness.stop();
		}
	});

	it("plan review: the title heading titles the sheet and is not repeated in the body; Copy copies what `c` does", () => {
		const viaKey = vi.fn();
		const viaButton = vi.fn();
		const plan = "# Ship credits\n\nintro\n\n## Alpha\n\na\n\n## Beta\n\nb\n";
		const keyed = new PlanReviewOverlay(
			plan,
			{ options: ["Approve"] },
			{ onPick: vi.fn(), onCancel: vi.fn(), onCopyPlan: viaKey },
		);
		keyed.handleInput("c");
		const pointed = new PlanReviewOverlay(
			plan,
			{ options: ["Approve"] },
			{ onPick: vi.fn(), onCancel: vi.fn(), onCopyPlan: viaButton },
		);
		expect(pointed.nativeOverlay.head).toBe("Ship credits");
		const body = pointed.describe();
		expect(JSON.stringify(find(body, node => node.p?.role === "omp.plan.body")?.node)).not.toContain(
			"# Ship credits",
		);
		pointed.handleNativeEvent({ type: "action", key: "tools/copyPlan", act: "copyPlan", mods: [] });
		expect(viaButton.mock.calls).toEqual(viaKey.mock.calls);
		expect(viaKey).toHaveBeenCalledTimes(1);
	});

	it("plan review: ←/→ walk the horizontal decision bar, Shift+←/→ step the model slider, ↑ leaves it", () => {
		const onPick = vi.fn();
		const onChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			"# Plan\n\nbody\n",
			{
				options: ["Approve", "Refine", "Stay"],
				slider: { segments: [{ label: "Fast" }, { label: "Smart" }], index: 0, onChange },
			},
			{ onPick, onCancel: vi.fn() },
		);
		setNativeRendering(true);
		try {
			// → → ← lands on the middle option; Shift+→ then Shift+← round-trips the slider.
			overlay.handleInput(RIGHT);
			overlay.handleInput(RIGHT);
			overlay.handleInput(LEFT);
			overlay.handleInput(SHIFT_RIGHT);
			overlay.handleInput(SHIFT_LEFT);
			// ↓ has nothing below the bar: the selection stays put.
			overlay.handleInput(DOWN);
			// ↑ hands focus to the body, where Enter returns to the bar instead of confirming.
			overlay.handleInput(UP);
			overlay.handleInput(ENTER);
			expect(onPick).not.toHaveBeenCalled();
			overlay.handleInput(ENTER);
		} finally {
			setNativeRendering(false);
		}
		expect(onChange.mock.calls).toEqual([[1], [0]]);
		expect(onPick).toHaveBeenCalledWith("Refine");
	});

	it("login: Cancel runs Esc's path and Continue submits the pasted code", async () => {
		const tui = { requestRender() {}, setFocus() {} } as unknown as TUI;
		const onComplete = vi.fn();
		const dialog = new LoginDialogComponent(tui, "openai-codex", onComplete, () => {});
		dialog.showAuth("https://auth.example.com/authorize?x=1", "Enter code: ABCD-1234");
		const waiting = dialog.describe();
		// The device code copies itself; with nothing to answer, opening the page is the primary action.
		expect(find(waiting, node => node.p?.role === "omp.login.code")?.node.p).toMatchObject({
			actions: { click: "copy" },
			href: "ABCD-1234",
		});
		expect(find(waiting, node => node.p?.actions?.click === "open")?.node.p).toMatchObject({
			href: "https://auth.example.com/authorize?x=1",
			tone: "accent",
		});
		expect(find(waiting, node => node.p?.actions?.click === "submit")).toBeUndefined();

		const pending = dialog.showManualInput("Paste the authorization code:");
		const described = dialog.describe();
		// A field waiting for an answer takes the primary action; Open stays as a plain button.
		expect(find(described, node => node.p?.actions?.click === "submit")?.node.p).toMatchObject({ tone: "accent" });
		expect(find(described, node => node.p?.actions?.click === "open")?.node.p?.tone).toBeUndefined();
		dialog.pasteText("code-123");
		dialog.handleNativeEvent({ type: "action", key: "x", act: "submit", mods: [] });
		expect(await pending).toBe("code-123");

		const cancelled = dialog.showManualInput("Paste the authorization code:");
		dialog.handleNativeEvent({ type: "action", key: "x", act: "cancel", mods: [] });
		await expect(cancelled).rejects.toThrow("Login cancelled");
		expect(onComplete).toHaveBeenCalledWith(false, "Login cancelled");
	});
});
