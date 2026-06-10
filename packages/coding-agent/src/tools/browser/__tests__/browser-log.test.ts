import { describe, expect, it } from "bun:test";
import type { ConsoleMessage, Page } from "puppeteer-core";
import { PageLogBuffer } from "../page-log";
import { parseStatusFilter, patternToMatcher } from "../network-log";

type Handler = (value: unknown) => void;

class FakePage {
	readonly #handlers: Record<string, Handler[]> = {};

	on(event: string, handler: Handler): this {
		this.#handlers[event] ??= [];
		this.#handlers[event]!.push(handler);
		return this;
	}

	off(event: string, handler: Handler): this {
		const handlers = this.#handlers[event];
		if (!handlers) return this;
		const index = handlers.indexOf(handler);
		if (index !== -1) handlers.splice(index, 1);
		return this;
	}

	emit(event: string, value: unknown): void {
		for (const handler of this.#handlers[event] ?? []) handler(value);
	}
}

function consoleMessage(kind: string, text: string, url = "", lineNumber = 0): ConsoleMessage {
	return {
		type: () => kind,
		text: () => text,
		location: () => ({ url, lineNumber, columnNumber: 0 }),
	} as ConsoleMessage;
}

describe("parseStatusFilter", () => {
	it("matches exact status codes", () => {
		const matches = parseStatusFilter("200");
		expect(matches(200)).toBe(true);
		expect(matches(201)).toBe(false);
		expect(matches(undefined)).toBe(false);
	});

	it("matches status classes", () => {
		const matches = parseStatusFilter("2xx");
		expect(matches(200)).toBe(true);
		expect(matches(299)).toBe(true);
		expect(matches(300)).toBe(false);
	});

	it("matches status ranges", () => {
		const matches = parseStatusFilter("400-499");
		expect(matches(399)).toBe(false);
		expect(matches(400)).toBe(true);
		expect(matches(499)).toBe(true);
		expect(matches(500)).toBe(false);
	});
});

describe("patternToMatcher", () => {
	it("uses plain strings as substring matchers", () => {
		const matches = patternToMatcher("/api/");
		expect(matches("https://example.test/api/users")).toBe(true);
		expect(matches("https://example.test/assets/app.js")).toBe(false);
	});

	it("converts star patterns to anchored glob regexes", () => {
		const matches = patternToMatcher("https://*.example.test/api/*");
		expect(matches("https://cdn.example.test/api/users")).toBe(true);
		expect(matches("http://cdn.example.test/api/users")).toBe(false);
		expect(matches("https://cdn.example.test/assets/api/users")).toBe(false);
	});

	it("uses regular expressions directly", () => {
		const matches = patternToMatcher(/\/v\d+\/items$/);
		expect(matches("https://example.test/v2/items")).toBe(true);
		expect(matches("https://example.test/v2/items/1")).toBe(false);
	});
});

describe("PageLogBuffer", () => {
	it("drops oldest console entries and returns the most recent limit", () => {
		const page = new FakePage();
		const logs = new PageLogBuffer(page as unknown as Page, 3);
		page.emit("console", consoleMessage("log", "one"));
		page.emit("console", consoleMessage("warn", "two"));
		page.emit("console", consoleMessage("log", "three"));
		page.emit("console", consoleMessage("error", "four", "https://example.test/app.js", 42));

		expect(logs.console().map(entry => entry.text)).toEqual(["two", "three", "four"]);
		expect(logs.console({ limit: 2 }).map(entry => entry.text)).toEqual(["three", "four"]);
		expect(logs.console({ kind: "log" }).map(entry => entry.text)).toEqual(["three"]);
		expect(logs.console({ kind: "error" })[0]?.location).toBe("https://example.test/app.js:42");
	});

	it("clears console entries after returning them", () => {
		const page = new FakePage();
		const logs = new PageLogBuffer(page as unknown as Page, 3);
		page.emit("console", consoleMessage("log", "one"));
		page.emit("console", consoleMessage("log", "two"));

		expect(logs.console({ clear: true }).map(entry => entry.text)).toEqual(["one", "two"]);
		expect(logs.console()).toEqual([]);
	});

	it("stores page errors in a bounded buffer and detaches listeners on dispose", () => {
		const page = new FakePage();
		const logs = new PageLogBuffer(page as unknown as Page, 1);
		page.emit("pageerror", new Error("first"));
		page.emit("pageerror", new Error("second"));

		expect(logs.errors().map(entry => entry.message)).toEqual(["second"]);
		logs.dispose();
		page.emit("pageerror", new Error("third"));
		expect(logs.errors().map(entry => entry.message)).toEqual(["second"]);
	});
});
