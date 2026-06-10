import type { HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { RingBuffer } from "./page-log";

const RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
const RESPONSE_BODY_TRUNCATED_SUFFIX = "\n...[truncated]";

export interface RequestEntry {
	id: number;
	ts: number;
	method: string;
	url: string;
	resourceType: string;
	status?: number;
	ok?: boolean;
	failure?: string;
	fromCache?: boolean;
	durationMs?: number;
}

export interface RequestDetail extends RequestEntry {
	requestHeaders: Record<string, string>;
	responseHeaders?: Record<string, string>;
	postData?: string;
	responseBody?: string;
}

export interface RequestFilter {
	filter?: string;
	type?: string | string[];
	method?: string | string[];
	status?: string;
	limit?: number;
}

export interface RouteSpec {
	abort?: boolean;
	body?: string | object;
	status?: number;
	headers?: Record<string, string>;
	contentType?: string;
}

interface StoredRequest extends RequestEntry {
	requestHeaders: Record<string, string>;
	responseHeaders?: Record<string, string>;
	postData?: string;
}

interface RouteEntry {
	pattern: string | RegExp;
	matches: (url: string) => boolean;
	spec: RouteSpec;
}

export function parseStatusFilter(s: string): (status: number | undefined) => boolean {
	const trimmed = s.trim();
	const exact = Number.parseInt(trimmed, 10);
	if (/^\d{3}$/.test(trimmed)) return status => status === exact;

	const statusClass = /^(\d)xx$/i.exec(trimmed);
	if (statusClass) {
		const start = Number.parseInt(statusClass[1]!, 10) * 100;
		const end = start + 99;
		return status => status !== undefined && status >= start && status <= end;
	}

	const range = /^(\d{3})-(\d{3})$/.exec(trimmed);
	if (range) {
		const start = Number.parseInt(range[1]!, 10);
		const end = Number.parseInt(range[2]!, 10);
		return status => status !== undefined && status >= start && status <= end;
	}

	return () => false;
}

export function patternToMatcher(p: string | RegExp): (url: string) => boolean {
	if (p instanceof RegExp) return url => p.test(url);
	if (!p.includes("*")) return url => url.includes(p);

	const source = p
		.split("*")
		.map(part => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
		.join(".*");
	const regex = new RegExp(`^${source}$`);
	return url => regex.test(url);
}

export class NetworkLog {
	readonly #page: Page;
	readonly #capacity: number;
	readonly #requests: RingBuffer<StoredRequest>;
	readonly #requestByPuppeteer = new Map<HTTPRequest, StoredRequest>();
	readonly #responseById = new Map<number, HTTPResponse>();
	readonly #routeEntries: RouteEntry[] = [];
	readonly #onRequest: (request: HTTPRequest) => void;
	readonly #onResponse: (response: HTTPResponse) => void;
	readonly #onRequestFailed: (request: HTTPRequest) => void;
	#nextId = 1;
	#interceptionEnabled = false;
	#disposed = false;

	constructor(page: Page, capacity = 1000) {
		this.#page = page;
		this.#capacity = Math.max(0, Math.trunc(capacity));
		this.#requests = new RingBuffer(this.#capacity);
		this.#onRequest = request => {
			if (this.#disposed) {
				if (this.#interceptionEnabled) void this.#settleInterceptedRequest(request);
				return;
			}
			const postData = request.postData();
			const entry: StoredRequest = {
				id: this.#nextId++,
				ts: Date.now(),
				method: request.method(),
				url: request.url(),
				resourceType: request.resourceType(),
				requestHeaders: request.headers(),
				...(postData !== undefined ? { postData } : {}),
			};
			const dropped = this.#requests.push(entry);
			if (dropped) this.#prune(dropped);
			if (this.#capacity > 0) this.#requestByPuppeteer.set(request, entry);
			if (this.#interceptionEnabled) void this.#settleInterceptedRequest(request);
		};
		this.#onResponse = response => {
			const request = response.request();
			const entry = this.#requestByPuppeteer.get(request);
			if (!entry) return;
			entry.status = response.status();
			entry.ok = response.status() >= 200 && response.status() <= 399;
			entry.fromCache = response.fromCache();
			entry.responseHeaders = response.headers();
			entry.durationMs = Date.now() - entry.ts;
			this.#responseById.set(entry.id, response);
		};
		this.#onRequestFailed = request => {
			const entry = this.#requestByPuppeteer.get(request);
			if (!entry) return;
			const failure = request.failure();
			if (failure) entry.failure = failure.errorText;
			entry.durationMs = Date.now() - entry.ts;
		};

		this.#page.on("request", this.#onRequest);
		this.#page.on("response", this.#onResponse);
		this.#page.on("requestfailed", this.#onRequestFailed);
	}

	requests(filter: RequestFilter = {}): RequestEntry[] {
		let entries: StoredRequest[] = this.#requests.items();
		if (filter.filter) {
			const matcher = /^\/(.*)\/$/.exec(filter.filter);
			const regex = matcher ? new RegExp(matcher[1]!) : undefined;
			entries = regex
				? entries.filter(entry => regex.test(entry.url))
				: entries.filter(entry => entry.url.includes(filter.filter!));
		}
		if (filter.type) {
			const types = new Set(Array.isArray(filter.type) ? filter.type : [filter.type]);
			entries = entries.filter(entry => types.has(entry.resourceType));
		}
		if (filter.method) {
			const methods = new Set(
				(Array.isArray(filter.method) ? filter.method : [filter.method]).map(method => method.toUpperCase()),
			);
			entries = entries.filter(entry => methods.has(entry.method.toUpperCase()));
		}
		if (filter.status) {
			const matchesStatus = parseStatusFilter(filter.status);
			entries = entries.filter(entry => matchesStatus(entry.status));
		}
		if (filter.limit !== undefined) {
			const limit = Math.max(0, Math.trunc(filter.limit));
			entries = limit >= entries.length ? entries : entries.slice(entries.length - limit);
		}
		return entries.map(
			({ requestHeaders: _requestHeaders, responseHeaders: _responseHeaders, postData: _postData, ...entry }) =>
				entry,
		);
	}

	async request(id: number): Promise<RequestDetail | undefined> {
		const entry = this.#requests.items().find(request => request.id === id);
		if (!entry) return undefined;
		const response = this.#responseById.get(id);
		let responseBody: string | undefined;
		if (response) {
			try {
				responseBody = truncateResponseBody(await response.text());
			} catch {
				responseBody = undefined;
			}
		}
		return {
			...entry,
			...(responseBody !== undefined ? { responseBody } : {}),
		};
	}

	async route(pattern: string | RegExp, spec: RouteSpec): Promise<void> {
		const route: RouteEntry = { pattern, matches: patternToMatcher(pattern), spec };
		this.#routeEntries.push(route);
		if (!this.#interceptionEnabled) {
			this.#interceptionEnabled = true;
			try {
				await this.#page.setRequestInterception(true);
			} catch (error) {
				this.#interceptionEnabled = false;
				const index = this.#routeEntries.indexOf(route);
				if (index !== -1) this.#routeEntries.splice(index, 1);
				throw error;
			}
		}
	}

	async unroute(pattern?: string | RegExp): Promise<void> {
		if (pattern === undefined) {
			this.#routeEntries.length = 0;
		} else {
			for (let index = this.#routeEntries.length - 1; index >= 0; index--) {
				if (this.#routeEntries[index]!.pattern === pattern) this.#routeEntries.splice(index, 1);
			}
		}
		if (this.#routeEntries.length === 0 && this.#interceptionEnabled) {
			await this.#page.setRequestInterception(false);
			this.#interceptionEnabled = false;
		}
	}

	clear(): void {
		this.#requests.clear();
		this.#requestByPuppeteer.clear();
		this.#responseById.clear();
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#interceptionEnabled) {
			this.#routeEntries.length = 0;
			void this.#page.setRequestInterception(false).then(
				() => {
					this.#interceptionEnabled = false;
					this.#page.off("request", this.#onRequest);
				},
				() => undefined,
			);
		} else {
			this.#page.off("request", this.#onRequest);
		}
		this.#page.off("response", this.#onResponse);
		this.#page.off("requestfailed", this.#onRequestFailed);
		this.clear();
	}

	#prune(entry: StoredRequest): void {
		this.#responseById.delete(entry.id);
		for (const [request, stored] of this.#requestByPuppeteer) {
			if (stored === entry) {
				this.#requestByPuppeteer.delete(request);
				break;
			}
		}
	}

	async #settleInterceptedRequest(request: HTTPRequest): Promise<void> {
		const route = this.#routeEntries.find(entry => entry.matches(request.url()));
		try {
			if (!route) {
				await request.continue();
				return;
			}
			if (route.spec.abort) {
				await request.abort();
				return;
			}
			if (
				route.spec.body !== undefined ||
				route.spec.status !== undefined ||
				route.spec.headers ||
				route.spec.contentType
			) {
				const body = route.spec.body;
				await request.respond({
					status: route.spec.status ?? 200,
					contentType: route.spec.contentType ?? (typeof body === "object" ? "application/json" : "text/plain"),
					headers: route.spec.headers,
					body: typeof body === "object" ? JSON.stringify(body) : body,
				});
				return;
			}
			await request.continue();
		} catch {
			// Request may already be handled by the page or browser.
		}
	}
}

function truncateResponseBody(body: string): string {
	const bytes = new TextEncoder().encode(body);
	if (bytes.length <= RESPONSE_BODY_LIMIT_BYTES) return body;
	const truncated = new TextDecoder().decode(bytes.slice(0, RESPONSE_BODY_LIMIT_BYTES));
	return `${truncated}${RESPONSE_BODY_TRUNCATED_SUFFIX}`;
}
