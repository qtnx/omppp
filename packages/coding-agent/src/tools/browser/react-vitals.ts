import type { Page } from "puppeteer-core";
import reactHookScript from "../puppeteer/react-hook.txt" with { type: "text" };
import vitalsScript from "../puppeteer/vitals.txt" with { type: "text" };
import { ToolError } from "../tool-errors";

const REACT_HOOK_MISSING = "React DevTools hook not installed — reopen the tab with react: true";

export interface VitalsReport {
	lcp?: number;
	cls?: number;
	fcp?: number;
	ttfb?: number;
	inp?: number;
	domContentLoaded?: number;
	load?: number;
	url: string;
	details?: unknown;
}

export interface ReactTreeNode {
	id: number;
	name: string;
	kind: "function" | "class" | "host" | "suspense" | "fragment" | "provider" | "consumer" | "memo" | "lazy" | "portal" | "other";
	key?: string;
	childCount?: number;
	children?: ReactTreeNode[];
}

export interface ReactInspectResult {
	id: number;
	name: string;
	props?: Record<string, unknown>;
	state?: unknown;
	hooks?: unknown[];
	source?: string;
}

export interface SuspenseBoundary {
	id: number;
	state: "suspended" | "resolved";
	name?: string;
}

type BrowserFiber = {
	tag?: number;
	type?: unknown;
	elementType?: unknown;
	key?: null | string;
	child?: BrowserFiber | null;
	sibling?: BrowserFiber | null;
	return?: BrowserFiber | null;
	memoizedProps?: unknown;
	memoizedState?: unknown;
	stateNode?: unknown;
	_debugSource?: unknown;
};

type BrowserRoot = { current?: BrowserFiber | null };
type BrowserCommit = { ts: number; rendererId?: number };
type BrowserReactState = {
	roots: Set<BrowserRoot>;
	recording: boolean;
	commits: BrowserCommit[];
	idMap: Map<number, BrowserFiber>;
	nextId: number;
};

type BrowserVitalsState = {
	lcp?: { startTime?: number; size?: number; tag?: string; id?: string };
	cls?: number;
	fcp?: number;
	ttfb?: number;
	inp?: number;
	domContentLoaded?: number;
	load?: number;
	events?: unknown;
};

type BrowserGlobal = typeof globalThis & {
	__ompxReact?: BrowserReactState;
	__ompxVitals?: BrowserVitalsState;
	location: { href: string };
};

export async function installVitals(page: Page): Promise<void> {
	await page.evaluateOnNewDocument(vitalsScript);
}

export async function installReactHook(page: Page): Promise<void> {
	await page.evaluateOnNewDocument(reactHookScript);
}

export async function readVitals(page: Page): Promise<VitalsReport> {
	const report = await page.evaluate(() => {
		const state = (globalThis as BrowserGlobal).__ompxVitals;
		if (!state) return undefined;
		const lcp = typeof state.lcp?.startTime === "number" ? state.lcp.startTime : undefined;
		return {
			lcp,
			cls: typeof state.cls === "number" ? state.cls : undefined,
			fcp: typeof state.fcp === "number" ? state.fcp : undefined,
			ttfb: typeof state.ttfb === "number" ? state.ttfb : undefined,
			inp: typeof state.inp === "number" ? state.inp : undefined,
			domContentLoaded: typeof state.domContentLoaded === "number" ? state.domContentLoaded : undefined,
			load: typeof state.load === "number" ? state.load : undefined,
			url: (globalThis as BrowserGlobal).location.href,
			details: { lcp: state.lcp, inpEvents: state.events },
		};
	});
	if (!report) throw new ToolError("Vitals collector not installed — reopen the tab with vitals: true");
	return report;
}

export async function reactTree(
	page: Page,
	opts: { maxDepth?: number; maxNodes?: number } = {},
): Promise<{ roots: ReactTreeNode[]; totalNodes: number; truncated: boolean }> {
	const result = await page.evaluate(options => {
		const state = (globalThis as BrowserGlobal).__ompxReact;
		if (!state) return undefined;
		const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 8));
		const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? 500));
		let totalNodes = 0;
		let truncated = false;

		const asObject = (value: unknown): Record<string, unknown> | undefined =>
			value !== null && (typeof value === "object" || typeof value === "function")
				? (value as Record<string, unknown>)
				: undefined;

		const namedType = (fiber: BrowserFiber): Record<string, unknown> | undefined =>
			asObject(fiber.type) ?? asObject(fiber.elementType);

		const typeName = (value: unknown): string | undefined => {
			if (typeof value === "string") return value;
			const object = asObject(value);
			if (!object) return undefined;
			const displayName = object.displayName;
			const name = object.name;
			if (typeof displayName === "string" && displayName) return displayName;
			if (typeof name === "string" && name) return name;
			return undefined;
		};

		const kindFor = (fiber: BrowserFiber): ReactTreeNode["kind"] => {
			if (typeof fiber.type === "string") return "host";
			if (fiber.tag === 13) return "suspense";
			if (fiber.tag === 7) return "fragment";
			if (fiber.tag === 10) return "provider";
			if (fiber.tag === 9) return "consumer";
			if (fiber.tag === 14 || fiber.tag === 15) return "memo";
			if (fiber.tag === 16) return "lazy";
			if (fiber.tag === 4) return "portal";
			const type = namedType(fiber);
			const prototype = asObject(type?.prototype);
			if (prototype?.isReactComponent) return "class";
			if (typeof fiber.type === "function") return "function";
			const symbolText = String(type?.$$typeof ?? "");
			if (symbolText.includes("react.memo")) return "memo";
			if (symbolText.includes("react.lazy")) return "lazy";
			if (symbolText.includes("react.provider")) return "provider";
			if (symbolText.includes("react.context")) return "consumer";
			return "other";
		};

		const nameFor = (fiber: BrowserFiber): string => {
			if (fiber.tag === 13) return typeName(fiber.type) ?? "Suspense";
			if (fiber.tag === 7) return "Fragment";
			const name = typeName(fiber.type) ?? typeName(fiber.elementType);
			if (name) return name;
			return kindFor(fiber) === "other" ? "Unknown" : kindFor(fiber);
		};

		const idFor = (fiber: BrowserFiber): number => {
			for (const [id, existing] of state.idMap) {
				if (existing === fiber) return id;
			}
			const id = state.nextId++;
			state.idMap.set(id, fiber);
			return id;
		};

		const countChildren = (fiber: BrowserFiber): number => {
			let count = 0;
			let child = fiber.child ?? null;
			while (child) {
				count++;
				child = child.sibling ?? null;
			}
			return count;
		};

		const walk = (fiber: BrowserFiber, depth: number): ReactTreeNode | undefined => {
			if (totalNodes >= maxNodes) {
				truncated = true;
				return undefined;
			}
			totalNodes++;
			const node: ReactTreeNode = { id: idFor(fiber), name: nameFor(fiber), kind: kindFor(fiber) };
			if (fiber.key !== null && fiber.key !== undefined) node.key = String(fiber.key);
			const childCount = countChildren(fiber);
			if (childCount > 0) node.childCount = childCount;
			if (depth >= maxDepth) {
				if (childCount > 0) truncated = true;
				return node;
			}
			const children: ReactTreeNode[] = [];
			let child = fiber.child ?? null;
			while (child) {
				const childNode = walk(child, depth + 1);
				if (childNode) children.push(childNode);
				child = child.sibling ?? null;
			}
			if (children.length > 0) node.children = children;
			return node;
		};

		const roots: ReactTreeNode[] = [];
		for (const root of state.roots) {
			if (!root.current) continue;
			const rootNode = walk(root.current, 0);
			if (rootNode) roots.push(rootNode);
		}
		return { roots, totalNodes, truncated };
	}, opts);
	if (!result) throw new ToolError(REACT_HOOK_MISSING);
	return result;
}

export async function reactInspect(page: Page, id: number): Promise<ReactInspectResult> {
	const result = await page.evaluate(fiberId => {
		const state = (globalThis as BrowserGlobal).__ompxReact;
		if (!state) return { missingHook: true as const };
		const fiber = state.idMap.get(fiberId);
		if (!fiber) return { missingFiber: true as const };

		const asObject = (value: unknown): Record<string, unknown> | undefined =>
			value !== null && (typeof value === "object" || typeof value === "function")
				? (value as Record<string, unknown>)
				: undefined;

		const typeName = (value: unknown): string | undefined => {
			if (typeof value === "string") return value;
			const object = asObject(value);
			const displayName = object?.displayName;
			const name = object?.name;
			if (typeof displayName === "string" && displayName) return displayName;
			if (typeof name === "string" && name) return name;
			return undefined;
		};

		const serialize = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
			if (value === null || value === undefined) return value;
			const valueType = typeof value;
			if (valueType === "string" || valueType === "number" || valueType === "boolean") return value;
			if (valueType === "bigint") return String(value);
			if (valueType === "symbol") return String(value);
			if (valueType === "function") return `[Function: ${typeName(value) ?? "anonymous"}]`;
			const object = value as object;
			if (seen.has(object)) return "[Circular]";
			const record = value as Record<string, unknown>;
			if (record.$$typeof && record.props) return "[ReactElement]";
			if (depth <= 0) return Array.isArray(value) ? "[Array]" : "[Object]";
			seen.add(object);
			if (Array.isArray(value)) {
				const out = value.slice(0, 20).map(item => serialize(item, depth - 1, seen));
				if (value.length > 20) out.push(`… ${value.length - 20} more`);
				return out;
			}
			const out: Record<string, unknown> = {};
			const keys = Object.keys(record).slice(0, 20);
			for (const key of keys) out[key] = serialize(record[key], depth - 1, seen);
			if (Object.keys(record).length > keys.length) out.__truncated = true;
			return out;
		};

		const props = serialize(fiber.memoizedProps, 3, new WeakSet<object>());
		let stateValue: unknown;
		let hooks: unknown[] | undefined;
		const typeObject = asObject(fiber.type);
		const prototype = asObject(typeObject?.prototype);
		if (prototype?.isReactComponent) {
			const stateNode = asObject(fiber.stateNode);
			stateValue = serialize(stateNode?.state ?? fiber.memoizedState, 3, new WeakSet<object>());
		} else {
			hooks = [];
			let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null | undefined;
			let guard = 0;
			while (hook && guard < 50) {
				hooks.push(serialize(hook.memoizedState, 3, new WeakSet<object>()));
				hook = hook.next as { memoizedState?: unknown; next?: unknown } | null | undefined;
				guard++;
			}
		}

		const debugSource = asObject(fiber._debugSource);
		let source: string | undefined;
		if (debugSource) {
			const fileName = debugSource.fileName;
			const lineNumber = debugSource.lineNumber;
			if (typeof fileName === "string") source = `${fileName}${typeof lineNumber === "number" ? `:${lineNumber}` : ""}`;
		}

		const propsRecord = props && typeof props === "object" && !Array.isArray(props) ? (props as Record<string, unknown>) : undefined;
		return {
			id: fiberId,
			name: typeName(fiber.type) ?? typeName(fiber.elementType) ?? "Unknown",
			props: propsRecord,
			state: stateValue,
			hooks: hooks && hooks.length > 0 ? hooks : undefined,
			source,
		};
	}, id);
	if ("missingHook" in result) throw new ToolError(REACT_HOOK_MISSING);
	if ("missingFiber" in result) throw new ToolError(`React fiber id ${id} not found — call reactTree() first`);
	return result;
}

/**
 * Starts or stops React commit recording. Component-level counts are intentionally
 * omitted: walking every committed fiber would add page-visible commit overhead.
 */
export async function reactRenders(
	page: Page,
	action: "start" | "stop",
): Promise<{ commits: number; durationMs: number; components?: Record<string, number> } | undefined> {
	const result = await page.evaluate(renderAction => {
		const state = (globalThis as BrowserGlobal).__ompxReact;
		if (!state) return undefined;
		if (renderAction === "start") {
			state.commits.length = 0;
			state.recording = true;
			return { commits: 0, durationMs: 0 };
		}
		state.recording = false;
		const first = state.commits[0];
		const last = state.commits[state.commits.length - 1];
		return {
			commits: state.commits.length,
			durationMs: first && last ? Math.max(0, last.ts - first.ts) : 0,
		};
	}, action);
	if (!result) throw new ToolError(REACT_HOOK_MISSING);
	return result;
}

export async function reactSuspense(page: Page): Promise<SuspenseBoundary[]> {
	const result = await page.evaluate(() => {
		const state = (globalThis as BrowserGlobal).__ompxReact;
		if (!state) return undefined;

		const asObject = (value: unknown): Record<string, unknown> | undefined =>
			value !== null && (typeof value === "object" || typeof value === "function")
				? (value as Record<string, unknown>)
				: undefined;

		const typeName = (value: unknown): string | undefined => {
			if (typeof value === "string") return value;
			const object = asObject(value);
			const displayName = object?.displayName;
			const name = object?.name;
			if (typeof displayName === "string" && displayName) return displayName;
			if (typeof name === "string" && name) return name;
			return undefined;
		};

		const idFor = (fiber: BrowserFiber): number => {
			for (const [id, existing] of state.idMap) {
				if (existing === fiber) return id;
			}
			const id = state.nextId++;
			state.idMap.set(id, fiber);
			return id;
		};

		const nearestName = (fiber: BrowserFiber): string | undefined => {
			let parent = fiber.return ?? null;
			while (parent) {
				const name = typeName(parent.type) ?? typeName(parent.elementType);
				if (name) return name;
				parent = parent.return ?? null;
			}
			return undefined;
		};

		const out: SuspenseBoundary[] = [];
		const walk = (fiber: BrowserFiber): void => {
			if (fiber.tag === 13) {
				out.push({
					id: idFor(fiber),
					state: fiber.memoizedState !== null && fiber.memoizedState !== undefined ? "suspended" : "resolved",
					name: typeName(fiber.type) ?? nearestName(fiber),
				});
			}
			let child = fiber.child ?? null;
			while (child) {
				walk(child);
				child = child.sibling ?? null;
			}
		};

		for (const root of state.roots) {
			if (root.current) walk(root.current);
		}
		return out;
	});
	if (!result) throw new ToolError(REACT_HOOK_MISSING);
	return result;
}
