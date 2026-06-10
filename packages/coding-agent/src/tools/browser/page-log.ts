import type { ConsoleMessage, Page } from "puppeteer-core";

export interface ConsoleEntry {
	ts: number;
	kind: string;
	text: string;
	location?: string;
}

export interface PageErrorEntry {
	ts: number;
	message: string;
	stack?: string;
}

export class RingBuffer<T> {
	#items: T[] = [];
	readonly #capacity: number;

	constructor(capacity: number) {
		this.#capacity = Math.max(0, Math.trunc(capacity));
	}

	push(item: T): T | undefined {
		if (this.#capacity === 0) return item;
		let dropped: T | undefined;
		if (this.#items.length === this.#capacity) dropped = this.#items.shift();
		this.#items.push(item);
		return dropped;
	}

	items(): T[] {
		return this.#items.slice();
	}

	clear(): void {
		this.#items.length = 0;
	}
}

export class PageLogBuffer {
	readonly #page: Page;
	readonly #consoleEntries: RingBuffer<ConsoleEntry>;
	readonly #errorEntries: RingBuffer<PageErrorEntry>;
	readonly #onConsole: (msg: ConsoleMessage) => void;
	readonly #onPageError: (error: unknown) => void;

	constructor(page: Page, capacity = 500) {
		this.#page = page;
		this.#consoleEntries = new RingBuffer(capacity);
		this.#errorEntries = new RingBuffer(capacity);
		this.#onConsole = msg => {
			const location = msg.location();
			this.#consoleEntries.push({
				ts: Date.now(),
				kind: msg.type(),
				text: msg.text(),
				...(location.url ? { location: `${location.url}:${location.lineNumber}` } : {}),
			});
		};
		this.#onPageError = error => {
			const err = error instanceof Error ? error : new Error(String(error));
			this.#errorEntries.push({
				ts: Date.now(),
				message: err.message,
				...(err.stack ? { stack: err.stack } : {}),
			});
		};

		this.#page.on("console", this.#onConsole);
		this.#page.on("pageerror", this.#onPageError);
	}

	console(opts: { limit?: number; kind?: string; clear?: boolean } = {}): ConsoleEntry[] {
		let entries = this.#consoleEntries.items();
		if (opts.kind) entries = entries.filter(entry => entry.kind === opts.kind);
		if (opts.limit !== undefined) {
			const limit = Math.max(0, Math.trunc(opts.limit));
			entries = limit >= entries.length ? entries : entries.slice(entries.length - limit);
		}
		if (opts.clear) this.#consoleEntries.clear();
		return entries;
	}

	errors(opts: { limit?: number; clear?: boolean } = {}): PageErrorEntry[] {
		let entries = this.#errorEntries.items();
		if (opts.limit !== undefined) {
			const limit = Math.max(0, Math.trunc(opts.limit));
			entries = limit >= entries.length ? entries : entries.slice(entries.length - limit);
		}
		if (opts.clear) this.#errorEntries.clear();
		return entries;
	}

	dispose(): void {
		this.#page.off("console", this.#onConsole);
		this.#page.off("pageerror", this.#onPageError);
	}
}
