/**
 * Tool-approval prompt in the composer's place, presented like the ask
 * dialog: the approval title and its details over an action bar. Approving
 * takes a deliberate chord (`app.approval.approve`, Ctrl+Enter by default),
 * so an Enter typed for the composer as the prompt appears never approves a
 * call, and the chord itself only arms {@link APPROVE_ARM_MS} after mount: it
 * is also the follow-up key, pressed mid-run exactly when prompts appear.
 * Esc denies.
 */
import { type Component, Ellipsis, ScrollView, type TUI, truncateToWidth, wrapTextWithAnsi } from "../index";
import { formatKeyHints, formatTooltipKey } from "../app-keybindings";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { getKeybindings } from "../keybindings";
import {
	appApproveKeys,
	matchesAppApprove,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { col, node } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { PREVIEW_LIMITS, sanitizeDisplayLines } from "../render/render-utils";
import { theme } from "../theme/theme";
import { CountdownTimer } from "../chrome/countdown-timer";

/** Detail rows shown before the rest scrolls: the prompt stays compact, the transcript has the call in full. */
const MAX_DETAIL_ROWS: number = PREVIEW_LIMITS.COLLAPSED_ITEMS;
/** The approve key is ignored this long after mount, so a follow-up sent as the prompt appears cannot approve it. */
export const APPROVE_ARM_MS = 500;

interface ApprovalDialogCallbacks {
	onApprove(): void;
	onDeny(): void;
}

interface ApprovalDialogOptions {
	tui?: TUI;
	/** Wrap long details instead of clipping them to a row: set when the dialog is the only place they show. */
	wrapDetails?: boolean;
	/** Deny once this many ms pass without input (any key restarts the countdown). */
	timeout?: number;
	/** Called when {@link timeout} expires, before the dialog denies. */
	onTimeout?: () => void;
	/** Called when the countdown starts, as the dialog mounts. */
	onTimeoutStart?: () => void;
	/** Called each time a key restarts the countdown. */
	onTimeoutReset?: () => void;
}

export class ApprovalDialogComponent implements Component {
	readonly #title: string;
	readonly #details: readonly string[];
	readonly #panel: OverlayPanel;
	readonly #body = new PanelRows();
	readonly #footer = new PanelRows();
	#scrollOffset = 0;
	#bodyRows = MAX_DETAIL_ROWS;
	#closed = false;
	#native: NativeNode | undefined;
	readonly #armedAt = performance.now() + APPROVE_ARM_MS;
	readonly #countdown: CountdownTimer | undefined;

	/** `prompt`: the approval title on its first line, the details after it. */
	constructor(
		prompt: string,
		private readonly callbacks: ApprovalDialogCallbacks,
		private readonly options: ApprovalDialogOptions = {},
	) {
		const [title = "", ...details] = sanitizeDisplayLines(prompt);
		while (details.length > 0 && details[details.length - 1]!.trim() === "") details.pop();
		this.#title = title;
		this.#details = details;
		this.#panel = new OverlayPanel(title, "omp.overlay.approval");
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
		if (options.timeout && options.timeout > 0) {
			options.onTimeoutStart?.();
			this.#countdown = new CountdownTimer(
				options.timeout,
				options.tui,
				seconds => {
					this.#panel.title = `${title} (${seconds}s)`;
				},
				() => {
					options.onTimeout?.();
					this.#finish(false);
				},
			);
		}
	}

	invalidate(): void {
		this.#native = undefined;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#countdown?.dispose();
		this.#panel.dispose();
	}

	handleInput(keyData: string): void {
		if (this.#closed) return;
		if (this.#countdown) {
			this.#countdown.reset();
			this.options.onTimeoutReset?.();
			// The described countdown restarts with it.
			this.#native = undefined;
		}
		if (matchesAppApprove(keyData)) {
			if (performance.now() >= this.#armedAt) this.#finish(true);
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.#finish(false);
			return;
		}
		const page = Math.max(1, this.#bodyRows - 1);
		if (matchesSelectUp(keyData)) this.#scroll(-1);
		else if (matchesSelectDown(keyData)) this.#scroll(1);
		else if (matchesSelectPageUp(keyData)) this.#scroll(-page);
		else if (matchesSelectPageDown(keyData)) this.#scroll(page);
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		let lines = this.#detailLines(innerWidth);
		const rows = Math.max(1, Math.min(lines.length, MAX_DETAIL_ROWS));
		const overflows = lines.length > rows;
		// Leave a column for the scrollbar once the details overflow.
		if (overflows && innerWidth > 1) lines = this.#detailLines(innerWidth - 1);
		this.#bodyRows = rows;
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, lines.length - rows));
		if (overflows) {
			const view = new ScrollView(lines, {
				height: rows,
				scrollbar: "auto",
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			view.setScrollOffset(this.#scrollOffset);
			this.#body.setLines(view.render(innerWidth));
		} else {
			this.#body.setLines(lines);
		}
		this.#body.setHeight(rows);
		this.#footer.setLines([theme.fg("dim", this.#footerHint(overflows))]);
		return this.#panel.render(width);
	}

	/**
	 * In the dock, in the composer's place and framed as the composer is (an
	 * `omp.editor.*` root role), like the ask dialog, rather than a card over
	 * the transcript: the title, the details, then Deny and the primary
	 * Approve, whose keys show in their tooltips.
	 */
	describe(): NativeNode {
		if (this.#native) return this.#native;
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		const approveKey = appApproveKeys()[0];
		const deny = actionButton("Deny", "deny", {
			...(cancelKey ? { keys: cancelKey } : {}),
			tone: "error",
			title: `Deny this call${cancelKey ? `  ${formatTooltipKey(cancelKey)}` : ""}`,
		});
		const approve = actionButton("Approve", "approve", {
			...(approveKey ? { keys: approveKey } : {}),
			tone: "accent",
			title: `Approve this call${approveKey ? `  ${formatTooltipKey(approveKey)}` : ""}`,
		});
		const children: NativeNode[] = [
			node("text", { text: this.#title, role: "omp.approval.title", tone: "accent" }, undefined, "title"),
		];
		if (this.#details.length > 0) {
			// One clipped row per detail like the text view, unless wrapping was asked for.
			const wrap = this.options.wrapDetails === true;
			const rows = this.#details.map((line, index) =>
				node("text", wrap ? { text: line } : { text: line, truncate: "end" }, undefined, String(index)),
			);
			children.push(node("col", { role: "omp.approval.details" }, rows, "details"));
		}
		// The countdown, when one runs, leads the bar like the ask dialog's.
		children.push(actionBar([...(this.#countdown ? [this.#countdown.describe()] : []), null, deny, approve]));
		// Under the `omp.editor.ask` prefix: Tern's console layout sizes an ask's rows to the
		// composer column by that prefix, where a bare `omp.editor.*` role spans the whole dock.
		this.#native = col(children, { role: "omp.editor.ask.approval", gap: "md" });
		return this.#native;
	}

	/** Deny and Approve run exactly what Esc and the approve key run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closed || event.type !== "action") return;
		if (event.act === "approve") this.#finish(true);
		else if (event.act === "deny") this.#finish(false);
	}

	/** Detail rows at `width`: one clipped row per detail, or wrapped rows with {@link ApprovalDialogOptions.wrapDetails}. */
	#detailLines(width: number): string[] {
		if (!this.options.wrapDetails) {
			return this.#details.map(line => truncateToWidth(theme.fg("accent", line), width, Ellipsis.Unicode));
		}
		return this.#details.flatMap(line => (line === "" ? [""] : wrapTextWithAnsi(theme.fg("accent", line), width)));
	}

	#footerHint(overflows: boolean): string {
		const approve = formatKeyHints(appApproveKeys());
		const scroll = overflows ? ` · ${editorKeys("tui.select.up", "tui.select.down")} scroll` : "";
		return `${approve} approve · ${editorKey("tui.select.cancel")} deny${scroll}`;
	}

	#scroll(delta: number): void {
		this.#scrollOffset = Math.max(0, this.#scrollOffset + delta);
		this.options.tui?.requestRender();
	}

	#finish(approved: boolean): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		if (approved) this.callbacks.onApprove();
		else this.callbacks.onDeny();
	}
}
