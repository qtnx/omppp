import { type Component, replaceTabs, sliceByColumn, type TUI, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { renderAsciiBar } from "../../slash-commands/helpers/format";
import { getSymbolTheme, theme } from "../theme/theme";

// Live progress overlay shown while compaction runs. Remote (OpenAI V2 SSE)
// compaction gives no completion total, so the bar is INDETERMINATE — we never
// fabricate a percentage. A local 1s timer advances even with zero progress
// events so non-streaming paths (V1 POST, local summary, Anthropic) still show
// motion. A `~N tok` counter appears only once a progress update with bytes>0
// arrives.

// Local ticks at 1s granularity for the m:ss timer; the shimmer bar + spinner
// animate off the same cadence (fast enough to read as "alive", cheap to redraw).
const TICK_INTERVAL_MS = 1000;
// Wider indeterminate bar than the default so the shimmer sweep is legible.
const DEFAULT_BAR_WIDTH = 20;

/** Plain progress fields (not the event type) so the component is testable in isolation. */
export interface CompactionProgressFields {
	events: number;
	bytes: number;
	estTokens?: number;
}

/** Format a millisecond duration as an `m:ss` clock (e.g. 65_000 -> "1:05"). */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Renders a single live compaction-progress line:
 *   <spinner> <label> <indeterminate shimmer bar> <m:ss> [~N tok]
 * The token counter is suppressed until a progress update with bytes>0 lands.
 */
export class CompactionProgressComponent implements Component {
	// Sanitized once at construction (tabs stripped); truncated per-render to width.
	#label: string;
	#elapsedMs = 0;
	#bytes = 0;
	#estTokens: number | undefined;
	// Gate for the `~N tok` counter: only shown after real streamed payload arrives.
	#hasProgress = false;
	#frames: string[];
	#currentFrame = 0;
	#intervalId: NodeJS.Timeout | undefined;
	// Optional UI handle; when present the local tick requests a component-scoped
	// redraw. Left undefined in isolated tests (they call render() directly).
	#ui: TUI | undefined;

	constructor(label: string, ui?: TUI, spinnerFrames?: string[]) {
		// Strip tabs up front (TUI text must be sanitized); truncation happens at render.
		this.#label = replaceTabs(label);
		this.#ui = ui;
		this.#frames = spinnerFrames && spinnerFrames.length > 0 ? spinnerFrames : getSymbolTheme().spinnerFrames;
	}

	/** Begin the local 1s timer. Idempotent; safe to call once per lifecycle. */
	start(): void {
		if (this.#intervalId) return;
		this.#elapsedMs = 0;
		// Local tick: increment elapsed by a fixed 1s step + advance the spinner even
		// when NO progress events arrive (the whole point — non-streaming paths still
		// animate). Incrementing (vs reading the wall clock) keeps the m:ss display
		// deterministic and correct under fake timers in tests.
		this.#intervalId = setInterval(() => {
			this.#elapsedMs += TICK_INTERVAL_MS;
			this.#currentFrame = (this.#currentFrame + 1) % this.#frames.length;
			this.#ui?.requestComponentRender?.(this);
		}, TICK_INTERVAL_MS);
	}

	/** Feed cumulative SSE counters from a CompactionProgressUpdate. */
	update(fields: CompactionProgressFields): void {
		// `fields.events` is part of the contract but not rendered on the single line.
		this.#bytes = fields.bytes;
		this.#estTokens = fields.estTokens;
		// Counter appears only once real payload bytes have streamed.
		if (fields.bytes > 0) this.#hasProgress = true;
		this.#ui?.requestComponentRender?.(this);
	}

	/** Directly set elapsed (used by non-streaming callers/tests); bypasses the tick. */
	setElapsed(ms: number): void {
		this.#elapsedMs = Math.max(0, ms);
		this.#ui?.requestComponentRender?.(this);
	}

	invalidate(): void {
		// No cached render state to drop.
	}

	/** Stop the local timer. Idempotent. */
	stop(): void {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
	}

	/** Lifecycle teardown mirrors stop(). Idempotent. */
	dispose(): void {
		this.stop();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const spinner = theme.fg("accent", this.#frames[this.#currentFrame] ?? "");
		const barWidth = Math.max(6, Math.min(DEFAULT_BAR_WIDTH, width - 12));
		// Indeterminate: renderAsciiBar(undefined, ...) yields a shimmering dotted
		// placeholder with NO percentage — the provider gives no total.
		const bar = renderAsciiBar(undefined, barWidth, theme);
		const timer = theme.fg("muted", formatElapsed(this.#elapsedMs));
		// Reserve room for spinner + bar + timer (+ counter) before truncating the label.
		const reserved = visibleWidth(spinner) + visibleWidth(bar) + visibleWidth(timer) + 8;
		const labelWidth = Math.max(1, width - reserved);
		const label = theme.fg("muted", truncateToWidth(this.#label, labelWidth));
		const parts = [spinner, label, bar, timer];
		if (this.#hasProgress) {
			// Prefer the provider estimate; fall back to a bytes/4 heuristic.
			const tokens = this.#estTokens ?? Math.ceil(this.#bytes / 4);
			parts.push(theme.fg("muted", `~${tokens} tok`));
		}
		let line = parts.join(" ");
		// Final guard so ANSI-padded content never overflows the row.
		if (visibleWidth(line) > width) line = sliceByColumn(line, 0, width, true);
		return [line];
	}
}
