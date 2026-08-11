import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";

/**
 * Retractable /usage transcript block. Rows already committed to native
 * scrollback are immutable history; only the still-live suffix may disappear.
 */
export class UsagePanel extends Container {
	#committedRows = 0;
	#committedPrefixRows: readonly string[] = [];
	#lastRenderedRows: readonly string[] = [];
	#preservedRows: readonly string[] | undefined;
	#scrollPastQueued = false;
	#version = 0;

	constructor(
		output: string,
		readonly onScrolledPast: () => void,
	) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(output, 1, 0));
	}

	override render(width: number): readonly string[] {
		if (this.#preservedRows) return this.#preservedRows;
		const rows = super.render(width);
		this.#lastRenderedRows = rows;
		return rows;
	}

	override setNativeScrollbackCommittedRows(rows: number): void {
		const previousCommittedRows = this.#committedRows;
		this.#committedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
		if (this.#lastRenderedRows.length === 0 || this.#committedRows <= previousCommittedRows) return;

		const prefixStart = Math.min(previousCommittedRows, this.#committedPrefixRows.length);
		const prefixEnd = Math.min(this.#committedRows, this.#lastRenderedRows.length);
		this.#committedPrefixRows = [
			...this.#committedPrefixRows.slice(0, prefixStart),
			...this.#lastRenderedRows.slice(prefixStart, prefixEnd),
		];
		if (this.#scrollPastQueued || this.#committedRows < this.#lastRenderedRows.length) return;
		this.#scrollPastQueued = true;
		queueMicrotask(this.onScrolledPast);
	}

	/** Freeze the committed prefix and retract every still-live row. */
	dismissUncommittedSuffix(): void {
		if (this.#preservedRows) return;
		this.#preservedRows = [...this.#committedPrefixRows];
		this.#version++;
		this.invalidate();
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}
}
