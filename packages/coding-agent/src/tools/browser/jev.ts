/**
 * Goal-driven DOM policy backed by TypeSafe Jev (`tab.act(goal)`).
 *
 * Port of the jev-ultrafast loop (browser-use/jev-ultrafast): every step observes
 * the page, offers Jev an indexed element table, and lets one request pick both
 * the operation and its target. Model output never becomes a selector, coordinate,
 * or script — every executed target resolves from an observed element id.
 *
 * Two jobs go to the session's `smol` completion tier (falling back to the
 * session default model): the value a TYPE_TEXT field needs, and a rescue turn
 * that tries to clear a stuck page — a modal, consent banner, tutorial overlay,
 * or end-of-round gate the choice-only policy cannot reason about — before the
 * run reports `blocked` to its caller.
 */

import { ToolError, throwIfAborted } from "../tool-errors";
import nextActionRules from "../../prompts/tools/browser-jev/next-action.md" with { type: "text" };
import targetRules from "../../prompts/tools/browser-jev/target.md" with { type: "text" };
import rescueRules from "../../prompts/tools/browser-jev/rescue.md" with { type: "text" };
import textValueRules from "../../prompts/tools/browser-jev/text-value.md" with { type: "text" };
import type { Observation, ObservationEntry } from "./tab-protocol";

export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_MODEL_ENV = "TYPESAFE_MODEL";
export const JEV_ENDPOINT_ENV = "TYPESAFE_SYSTEMONE_URL";
/** The tailnet proxy holds the key; point the endpoint at TypeSafe directly to need a local one. */
export const JEV_PROXY_ENDPOINT = "http://codemc:8791/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_MAX_STEPS = 30;
const PAGE_TEXT_CAP = 6000;
const SETTLE_MS = 150;
const WAIT_MS = 500;
const REQUEST_TIMEOUT_MS = 25_000;
const RETRY_STATUSES: Record<number, true> = { 429: true, 503: true, 529: true };
/** Rescue turns allowed per run; each costs one `smol` completion. */
const MAX_RESCUES = 2;
/** Consecutive non-WAIT actions that changed nothing before the run is considered stuck. */
const STALL_LIMIT = 3;

/** Jev is on by default whenever the TypeSafe key is present in the environment. */
export function jevApiKey(): string | undefined {
	const key = Bun.env[JEV_API_KEY_ENV]?.trim();
	return key ? key : undefined;
}

/** System One endpoint for Jev; the proxy default needs no local key. */
export function jevEndpoint(): string {
	return Bun.env[JEV_ENDPOINT_ENV]?.trim() || JEV_PROXY_ENDPOINT;
}

/**
 * One-line debug summary of the Jev driver as this process would call it:
 * endpoint (tailnet proxy unless overridden), where the key comes from, and the
 * model and step cap a goal would use. The key itself is never rendered.
 */
export function jevDebugSummary(): string {
	const override = Bun.env[JEV_MODEL_ENV]?.trim();
	const model = override || DEFAULT_MODEL;
	const endpointOverride = Bun.env[JEV_ENDPOINT_ENV]?.trim();
	const route = endpointOverride ? `(${JEV_ENDPOINT_ENV})` : "(proxy default)";
	const auth = jevApiKey()
		? `key ${JEV_API_KEY_ENV}`
		: endpointOverride
			? `no key — ${JEV_API_KEY_ENV} unset and the endpoint is not the proxy`
			: "key held by the proxy";
	const gate = jevApiKey() ? "" : `; tab.act hidden from browser docs (${JEV_API_KEY_ENV} unset)`;
	return `Jev: model ${model} ${override ? `(${JEV_MODEL_ENV})` : "(default)"}, maxSteps ${DEFAULT_MAX_STEPS}, endpoint ${jevEndpoint()} ${route}, ${auth}${gate}`;
}

export type JevOperation =
	| "CLICK"
	| "TYPE_TEXT"
	| "SELECT"
	| "HOVER"
	| "PRESS_ENTER"
	| "DRAG"
	| "SCROLL_UP"
	| "SCROLL_DOWN"
	| "WAIT"
	| "DONE"
	| "BLOCKED";

/** Roles whose value a TYPE_TEXT operation may replace. */
const FILL_ROLES: Record<string, true> = { textbox: true, searchbox: true, combobox: true, spinbutton: true };
/** Roles that carry a chooseable value inside a listbox/menu/select. */
const OPTION_ROLES: Record<string, true> = { option: true, menuitemradio: true, treeitem: true };
/** Target heads Jev answers alongside the operation head. */
const TARGET_OPERATIONS = ["CLICK", "TYPE_TEXT", "SELECT", "HOVER", "PRESS_ENTER", "DRAG_FROM", "DRAG_TO"] as const;

type JevTargetHead = (typeof TARGET_OPERATIONS)[number];

/** One row of the element table sent to Jev. */
export interface JevElement {
	index: string;
	label: string;
	role: string;
	value?: string;
	checked?: string;
	selected?: string;
	expanded?: string;
	operations: JevOperation[];
}

export interface JevActionSpace {
	elements: JevElement[];
	/** Target head → offered target index → observed entry. */
	targets: Partial<Record<JevTargetHead, Map<string, ObservationEntry>>>;
}

export interface JevStep {
	step: number;
	operation: JevOperation;
	target?: { id: number; role: string; name?: string };
	/** DRAG only: the element the source was dropped onto. */
	dropTarget?: { id: number; role: string; name?: string };
	text?: string;
	/** Set when the rescue helper, not Jev, chose this action; holds its one-line reason. */
	rescue?: string;
	confidence: number;
	probability: number;
	latencyMs: number;
	pageChanged: boolean;
	url: string;
}

export interface JevActResult {
	status: "done" | "blocked" | "max_steps";
	steps: JevStep[];
	url: string;
	title?: string;
	elapsedMs: number;
	/** Rescue turns spent on this run. */
	rescues: number;
	/** Why the run stopped, when a rescue turn named the remaining obstacle. */
	reason?: string;
}

export interface JevFieldContext {
	goal: string;
	field: { label: string; role: string; value?: string };
	page: { title?: string; text: string };
	recent_actions: Array<{ action: string; text?: string }>;
}

/** Backend-neutral surface the loop drives; the worker and cmux tabs each bind one. */
export interface JevDriver {
	observe(): Promise<Observation>;
	pageText(): Promise<string>;
	/**
	 * Activate an observed element: an ordinary click, except a native `<option>`,
	 * which commits through its owning `<select>` because Chromium refuses to
	 * click an option node. Both CLICK and SELECT route here.
	 */
	click(id: number): Promise<void>;
	fill(id: number, text: string): Promise<void>;
	hover(id: number): Promise<void>;
	/** Focus the field, then press Enter on it. */
	pressEnter(id: number): Promise<void>;
	/** Drag the first element's center onto the second element's center. */
	drag(fromId: number, toId: number): Promise<void>;
	scroll(deltaY: number): Promise<void>;
	wait(ms: number): Promise<void>;
	/**
	 * Ask the session's helper model for one structured answer (field value,
	 * rescue plan). `rules` is the system prompt, `schema` the required JSON
	 * shape; the returned value is parsed and validated by this module.
	 */
	helper(payload: object, rules: string, schema: object): Promise<unknown>;
}

export interface JevRescueContext {
	goal: string;
	stuck_because: "policy_reported_blocked" | "no_progress";
	page: { url: string; title?: string; text: string };
	offered_operations: string[];
	elements: JevElement[];
	recent_actions: Array<{ action: string; page_changed: boolean; rescue?: string }>;
}

/** One rescue answer, already validated against the offered action space. */
interface JevRescuePlan {
	operation: Exclude<JevOperation, "DONE" | "BLOCKED" | "DRAG">;
	entry?: ObservationEntry;
	text?: string;
	reason: string;
}

export interface JevActOptions {
	maxSteps?: number;
	signal?: AbortSignal;
	apiKey?: string;
	model?: string;
	fetch?: typeof fetch;
}

interface JevChoice {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

interface JevResponse {
	model?: string;
	answers: Record<string, unknown>;
}

function stateValue(entry: ObservationEntry, key: string): string | undefined {
	const prefix = `${key}=`;
	const state = entry.states.find(s => s.startsWith(prefix));
	return state?.slice(prefix.length);
}

/** Map an observation to Jev's indexed element table and per-operation target heads. */
export function buildActionSpace(observation: Observation): JevActionSpace {
	const elements: JevElement[] = [];
	const heads: Record<JevTargetHead, Map<string, ObservationEntry>> = {
		CLICK: new Map(),
		TYPE_TEXT: new Map(),
		SELECT: new Map(),
		HOVER: new Map(),
		PRESS_ENTER: new Map(),
		DRAG_FROM: new Map(),
		DRAG_TO: new Map(),
	};
	for (const entry of observation.elements) {
		if (entry.states.includes("disabled")) continue;
		const index = String(elements.length + 1);
		const operations: JevOperation[] = ["CLICK"];
		heads.CLICK.set(index, entry);
		// Every observed element is a legal hover and drag endpoint; only the
		// operation head decides whether those matter on this page.
		heads.HOVER.set(index, entry);
		heads.DRAG_FROM.set(index, entry);
		heads.DRAG_TO.set(index, entry);
		if (FILL_ROLES[entry.role] && !entry.states.includes("readonly")) {
			operations.push("TYPE_TEXT", "PRESS_ENTER");
			heads.TYPE_TEXT.set(index, entry);
			heads.PRESS_ENTER.set(index, entry);
		}
		if (OPTION_ROLES[entry.role]) {
			operations.push("SELECT");
			heads.SELECT.set(index, entry);
		}
		const element: JevElement = {
			index,
			label: entry.name ?? entry.description ?? "",
			role: entry.role,
			operations,
		};
		if (entry.value !== undefined) element.value = String(entry.value);
		const checked = stateValue(entry, "checked");
		if (checked !== undefined) element.checked = checked;
		const selected = stateValue(entry, "selected");
		if (selected !== undefined) element.selected = selected;
		const expanded = stateValue(entry, "expanded");
		if (expanded !== undefined) element.expanded = expanded;
		elements.push(element);
	}
	const targets: JevActionSpace["targets"] = {};
	for (const head of TARGET_OPERATIONS) {
		if (heads[head].size > 0) targets[head] = heads[head];
	}
	return { elements, targets };
}

const OPERATION_LABELS: Record<JevOperation, string> = {
	CLICK: "Click an element, button, link, menu option, autocomplete suggestion, or calendar day.",
	TYPE_TEXT: "Enter or replace text in an editable field. A helper will supply the value from the goal.",
	SELECT:
		"Choose an observed option/value inside a select, listbox, menu, or tree instead of clicking it — required for a native <select>.",
	HOVER: "Hover an element to reveal a menu, tooltip, or hover-only control.",
	PRESS_ENTER:
		"Press Enter on an editable field to submit it or confirm the highlighted suggestion, when no Submit control is visible.",
	DRAG: "Drag one observed element onto another (reorder, drag-and-drop target, slider handle onto a track position).",
	SCROLL_DOWN: "Scroll the page down to reveal content below the current viewport.",
	SCROLL_UP: "Scroll the page up to reveal content above the current viewport.",
	WAIT: "Wait briefly because a needed control is absent/disabled or results are still loading.",
	DONE: "Every requirement is visibly satisfied.",
	BLOCKED: "No supported operation can progress.",
};

function targetCriteria(entries: Map<string, ObservationEntry>): Record<string, Record<string, string>> {
	const criteria: Record<string, Record<string, string>> = {};
	for (const [index, entry] of entries) {
		const row: Record<string, string> = {
			element: `[${index}] ${entry.role} ${entry.name ?? entry.description ?? ""}`.trimEnd(),
			current_value: entry.value === undefined ? "" : String(entry.value),
			role: entry.role,
		};
		for (const key of ["checked", "selected", "expanded"]) {
			const value = stateValue(entry, key);
			if (value !== undefined) row[key] = value;
		}
		criteria[index] = row;
	}
	return criteria;
}

/** Build the single systemone request for one decision cycle. */
export function buildJevRequest(
	observation: Observation,
	pageText: string,
	goal: string,
	history: JevStep[],
	model: string,
): { body: Record<string, unknown>; space: JevActionSpace; operations: Record<string, string> } {
	const space = buildActionSpace(observation);
	const operations: Record<string, string> = {};
	if (space.targets.CLICK) operations.CLICK = OPERATION_LABELS.CLICK;
	if (space.targets.TYPE_TEXT) {
		operations.TYPE_TEXT = OPERATION_LABELS.TYPE_TEXT;
		operations.PRESS_ENTER = OPERATION_LABELS.PRESS_ENTER;
	}
	if (space.targets.SELECT) operations.SELECT = OPERATION_LABELS.SELECT;
	if (space.targets.HOVER) operations.HOVER = OPERATION_LABELS.HOVER;
	// DRAG needs both endpoints; a single observed element cannot be dragged onto itself.
	if ((space.targets.DRAG_FROM?.size ?? 0) > 1) operations.DRAG = OPERATION_LABELS.DRAG;
	const { scroll } = observation;
	if (scroll.y + scroll.height < scroll.scrollHeight - 1) operations.SCROLL_DOWN = OPERATION_LABELS.SCROLL_DOWN;
	if (scroll.y > 0) operations.SCROLL_UP = OPERATION_LABELS.SCROLL_UP;
	operations.WAIT = OPERATION_LABELS.WAIT;
	operations.DONE = OPERATION_LABELS.DONE;
	operations.BLOCKED = OPERATION_LABELS.BLOCKED;

	const questions: Record<string, unknown> = {
		operation: {
			type: "choice",
			criteria: operations,
			instructions: { goal, rules: nextActionRules },
		},
	};
	for (const head of TARGET_OPERATIONS) {
		const entries = space.targets[head];
		if (!entries) continue;
		// A head only costs tokens when its operation is actually offered.
		const operation = head === "DRAG_FROM" || head === "DRAG_TO" ? "DRAG" : head;
		if (operations[operation] === undefined) continue;
		questions[`${head.toLowerCase()}_target`] = {
			type: "choice",
			criteria: targetCriteria(entries),
			instructions: {
				goal,
				operation:
					head === "DRAG_FROM" ? "DRAG (element to pick up)" : head === "DRAG_TO" ? "DRAG (drop target)" : head,
				rules: [nextActionRules, targetRules],
			},
		};
	}
	const body = {
		model,
		state: {
			page: { url: observation.url, title: observation.title ?? "", text: pageText.slice(0, PAGE_TEXT_CAP) },
			elements: space.elements,
			recent_actions: history.slice(-10).map(step => ({
				action: describeStep(step),
				kind: step.operation,
				text: step.text ?? null,
				page_changed: step.pageChanged,
			})),
		},
		questions,
	};
	return { body, space, operations };
}

function describeStep(step: JevStep): string {
	if (!step.target) return step.operation;
	const name = step.target.name ? ` ${step.target.name}` : "";
	const drop = step.dropTarget
		? ` onto ${step.dropTarget.role}${step.dropTarget.name ? ` ${step.dropTarget.name}` : ""}`
		: "";
	return `${step.operation} ${step.target.role}${name}${drop}`;
}

/** Reject any answer whose choice, probability set, or normalization is off — no action executes on it. */
export function validateChoice(answer: unknown, ids: Iterable<string>): JevChoice {
	const valid = new Set(ids);
	const record = answer as Partial<JevChoice> | undefined;
	const probabilities = record?.probabilities;
	const choice = record?.choice;
	const confidence = record?.confidence;
	const ok =
		typeof choice === "string" &&
		valid.has(choice) &&
		probabilities !== undefined &&
		probabilities !== null &&
		typeof probabilities === "object" &&
		typeof confidence === "number" &&
		Number.isFinite(confidence) &&
		confidence >= 0 &&
		confidence <= 1 &&
		Object.keys(probabilities).length === valid.size &&
		Object.keys(probabilities).every(key => valid.has(key)) &&
		Object.values(probabilities).every(p => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) &&
		Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) < 0.02 &&
		probabilities[choice]! >= Math.max(...Object.values(probabilities)) - 1e-6;
	if (!ok) throw new ToolError("Invalid Jev response; no action executed.");
	return { choice, confidence, probabilities };
}

async function postJev(
	body: Record<string, unknown>,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch,
): Promise<JevResponse> {
	const endpoint = jevEndpoint();
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	for (let attempt = 0; attempt < 3; attempt++) {
		throwIfAborted(signal);
		let response: Response;
		try {
			response = await fetchImpl(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
					: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throwIfAborted(signal);
			throw new ToolError(
				`Jev connection failed; no action executed (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		if (RETRY_STATUSES[response.status] && attempt < 2) {
			await Bun.sleep(500 * 2 ** attempt);
			continue;
		}
		if (!response.ok) {
			throw new ToolError(`Jev returned HTTP ${response.status}; no action executed.`);
		}
		return (await response.json()) as JevResponse;
	}
	throw new ToolError("Jev unavailable; no action executed.");
}

function fingerprint(observation: Observation): string {
	const rows = observation.elements.map(e => [e.role, e.name, e.value, e.states.join(",")]);
	return `${observation.url}|${Bun.hash(JSON.stringify(rows)).toString(36)}`;
}

const RESCUE_SCHEMA = {
	type: "object",
	properties: {
		action: { enum: ["recover", "give_up"] },
		operation: { type: ["string", "null"] },
		element: { type: ["string", "null"] },
		text: { type: ["string", "null"] },
		reason: { type: "string" },
	},
	required: ["action", "reason"],
	additionalProperties: false,
} as const;

/** Operations a rescue turn may choose; DRAG needs two endpoints and DONE/BLOCKED are verdicts. */
const RESCUE_OPERATIONS: Record<string, true> = {
	CLICK: true,
	SELECT: true,
	HOVER: true,
	PRESS_ENTER: true,
	TYPE_TEXT: true,
	SCROLL_DOWN: true,
	SCROLL_UP: true,
	WAIT: true,
};

/**
 * Validate a rescue answer against the SAME action space Jev was offered. An
 * unusable answer (unknown operation, unoffered element, missing text) is not an
 * error — it means no rescue happened, and the caller reports the real block.
 */
function parseRescuePlan(
	value: unknown,
	space: JevActionSpace,
	operations: Record<string, string>,
): { plan?: JevRescuePlan; reason: string } {
	const record = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown> | null;
	const reason =
		record && typeof record.reason === "string" && record.reason.trim().length > 0
			? record.reason.trim().slice(0, 300)
			: "rescue turn returned no usable plan";
	if (!record || record.action !== "recover") return { reason };
	const operation = typeof record.operation === "string" ? record.operation.toUpperCase() : "";
	if (!RESCUE_OPERATIONS[operation] || operations[operation] === undefined) return { reason };
	const op = operation as JevRescuePlan["operation"];
	if (op === "SCROLL_DOWN" || op === "SCROLL_UP" || op === "WAIT") return { plan: { operation: op, reason }, reason };
	const head = op as JevTargetHead;
	const entries = space.targets[head];
	const index = typeof record.element === "string" ? record.element : "";
	const entry = entries?.get(index);
	if (!entry) return { reason };
	if (op === "TYPE_TEXT") {
		const text = typeof record.text === "string" ? record.text : "";
		if (text.trim().length === 0 || text.length > 2000) return { reason };
		return { plan: { operation: op, entry, text, reason }, reason };
	}
	return { plan: { operation: op, entry, reason }, reason };
}

/** Run the observe → choose → act loop until Jev reports DONE/BLOCKED or the step budget is spent. */
export async function runJevAct(driver: JevDriver, goal: string, opts: JevActOptions = {}): Promise<JevActResult> {
	const task = goal.trim();
	if (!task) throw new ToolError("tab.act() requires a non-empty goal");
	const apiKey = opts.apiKey ?? jevApiKey();
	const model = opts.model ?? Bun.env[JEV_MODEL_ENV]?.trim() ?? DEFAULT_MODEL;
	const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
	const fetchImpl = opts.fetch ?? fetch;
	const signal = opts.signal;
	const started = performance.now();
	const steps: JevStep[] = [];
	let observation = await driver.observe();
	let rescues = 0;
	let stalled = 0;

	const finish = (status: JevActResult["status"], reason?: string): JevActResult => ({
		status,
		steps,
		url: observation.url,
		title: observation.title,
		elapsedMs: Math.round(performance.now() - started),
		rescues,
		reason,
	});

	/** Execute one resolved action; returns the page fingerprint taken before it. */
	const apply = async (step: JevStep, plan: { operation: JevOperation; entry?: ObservationEntry; text?: string }) => {
		const { operation, entry, text } = plan;
		if (entry) step.target = { id: entry.id, role: entry.role, name: entry.name };
		if (operation === "CLICK" || operation === "SELECT") await driver.click(entry!.id);
		else if (operation === "HOVER") await driver.hover(entry!.id);
		else if (operation === "PRESS_ENTER") await driver.pressEnter(entry!.id);
		else if (operation === "TYPE_TEXT") {
			step.text = text;
			await driver.fill(entry!.id, text!);
		} else if (operation === "SCROLL_DOWN" || operation === "SCROLL_UP") {
			const delta = Math.max(200, Math.round(observation.viewport.height * 0.8));
			await driver.scroll(operation === "SCROLL_DOWN" ? delta : -delta);
		} else {
			await driver.wait(WAIT_MS);
			return;
		}
		await driver.wait(SETTLE_MS);
	};

	/**
	 * One helper turn that tries to clear a stuck page before the run gives up.
	 * Returns the rescue reason when an action ran, otherwise the obstacle the
	 * helper named, which becomes the run's `reason`.
	 */
	const rescue = async (
		why: JevRescueContext["stuck_because"],
		pageText: string,
		space: JevActionSpace,
		operations: Record<string, string>,
	): Promise<{ recovered: boolean; reason: string }> => {
		if (rescues >= MAX_RESCUES) return { recovered: false, reason: "rescue budget spent" };
		rescues++;
		const context: JevRescueContext = {
			goal: task,
			stuck_because: why,
			page: { url: observation.url, title: observation.title, text: pageText.slice(0, PAGE_TEXT_CAP) },
			offered_operations: Object.keys(operations),
			elements: space.elements,
			recent_actions: steps.slice(-8).map(s => ({
				action: describeStep(s),
				page_changed: s.pageChanged,
				rescue: s.rescue,
			})),
		};
		const answer = await driver.helper(context, rescueRules, RESCUE_SCHEMA);
		const { plan, reason } = parseRescuePlan(answer, space, operations);
		if (!plan) return { recovered: false, reason };
		const before = fingerprint(observation);
		const step: JevStep = {
			step: steps.length + 1,
			operation: plan.operation,
			rescue: plan.reason,
			confidence: 0,
			probability: 0,
			latencyMs: 0,
			pageChanged: false,
			url: observation.url,
		};
		await apply(step, plan);
		steps.push(step);
		observation = await driver.observe();
		step.pageChanged = fingerprint(observation) !== before;
		step.url = observation.url;
		stalled = 0;
		return { recovered: true, reason: plan.reason };
	};

	while (steps.length < maxSteps) {
		throwIfAborted(signal);
		const pageText = await driver.pageText();
		const { body, space, operations } = buildJevRequest(observation, pageText, task, steps, model);
		const requestStarted = performance.now();
		const result = await postJev(body, apiKey, signal, fetchImpl);
		const latencyMs = Math.round(performance.now() - requestStarted);
		const answers = result.answers ?? {};
		const operationAnswer = validateChoice(answers.operation, Object.keys(operations));
		const operation = operationAnswer.choice as JevOperation;
		if (operation === "DONE") return finish("done");
		if (operation === "BLOCKED") {
			// Jev only chooses among offered actions; a modal, consent banner, or
			// end-of-round gate reads as "blocked" to it. Spend one helper turn
			// before handing the cost back to the caller.
			const attempt = await rescue("policy_reported_blocked", pageText, space, operations);
			if (attempt.recovered) continue;
			return finish("blocked", attempt.reason);
		}

		const before = fingerprint(observation);
		const step: JevStep = {
			step: steps.length + 1,
			operation,
			confidence: operationAnswer.confidence,
			probability: operationAnswer.probabilities[operation]!,
			latencyMs,
			pageChanged: false,
			url: observation.url,
		};
		const resolveTarget = (head: JevTargetHead): ObservationEntry => {
			const entries = space.targets[head]!;
			const answer = validateChoice(answers[`${head.toLowerCase()}_target`], entries.keys());
			step.probability = answer.probabilities[answer.choice]!;
			return entries.get(answer.choice)!;
		};
		if (operation === "DRAG") {
			const from = resolveTarget("DRAG_FROM");
			const to = resolveTarget("DRAG_TO");
			if (from.id === to.id) {
				throw new ToolError(
					`tab.act(): DRAG chose the same element (${from.id}) as source and target; nothing dragged.`,
				);
			}
			step.target = { id: from.id, role: from.role, name: from.name };
			step.dropTarget = { id: to.id, role: to.role, name: to.name };
			await driver.drag(from.id, to.id);
			await driver.wait(SETTLE_MS);
		} else {
			const entry =
				operation === "SCROLL_DOWN" || operation === "SCROLL_UP" || operation === "WAIT"
					? undefined
					: resolveTarget(operation as JevTargetHead);
			let text: string | undefined;
			if (operation === "TYPE_TEXT") {
				const value = await fieldText(driver, {
					goal: task,
					field: {
						label: entry!.name ?? entry!.description ?? "",
						role: entry!.role,
						value: entry!.value === undefined ? undefined : String(entry!.value),
					},
					page: { title: observation.title, text: pageText.slice(0, PAGE_TEXT_CAP) },
					recent_actions: steps.slice(-6).map(s => ({ action: describeStep(s), text: s.text })),
				});
				if (value === null || value.trim().length === 0) {
					throw new ToolError(
						`tab.act(): the goal supplies no value for field ${JSON.stringify(entry!.name ?? entry!.role)} (element ${entry!.id}); nothing typed.`,
					);
				}
				text = value;
			}
			await apply(step, { operation, entry, text });
		}
		steps.push(step);
		observation = await driver.observe();
		step.pageChanged = fingerprint(observation) !== before;
		step.url = observation.url;

		stalled = step.pageChanged || step.operation === "WAIT" ? 0 : stalled + 1;
		if (stalled >= STALL_LIMIT) {
			const attempt = await rescue("no_progress", pageText, space, operations);
			if (!attempt.recovered) return finish("blocked", attempt.reason);
		}
	}
	return finish("max_steps");
}

type HelperTier = "smol" | "default";

/** Completion arguments for one helper turn; both backends build the same call. */
function helperCompletionArgs(payload: object, rules: string, schema: object, tier: HelperTier) {
	return { prompt: JSON.stringify(payload), model: tier, system: rules, schema };
}

async function completeHelper(
	callTool: (name: string, args: unknown) => Promise<unknown>,
	payload: object,
	rules: string,
	schema: object,
	tier: HelperTier,
): Promise<unknown> {
	const handle = await callTool("__completion__", helperCompletionArgs(payload, rules, schema, tier));
	if (!handle || typeof handle !== "object" || !("id" in handle) || typeof handle.id !== "string") {
		throw new ToolError("Helper model did not return a completion handle");
	}
	const waited = await callTool("__wait__", { items: [{ kind: "completion", id: handle.id }] });
	const snapshot: unknown =
		waited && typeof waited === "object" && "items" in waited && Array.isArray(waited.items)
			? waited.items[0]
			: undefined;
	if (!snapshot || typeof snapshot !== "object" || !("status" in snapshot) || snapshot.status !== "completed") {
		const reason =
			snapshot && typeof snapshot === "object" && "error" in snapshot && typeof snapshot.error === "string"
				? snapshot.error
				: "no result";
		throw new ToolError(`Helper model (${tier}) failed: ${reason}`);
	}
	if ("data" in snapshot && snapshot.data !== undefined) return snapshot.data;
	return "text" in snapshot ? snapshot.text : undefined;
}

/**
 * Run one helper turn through the session's `completion()` bridge
 * (`__completion__` returns a handle; `__wait__` settles it). The cheap `smol`
 * tier goes first; a provider/credit failure there falls back to the session's
 * `default` model so one exhausted small-model account cannot strand a run.
 */
export async function helperViaBridge(
	callTool: (name: string, args: unknown) => Promise<unknown>,
	payload: object,
	rules: string,
	schema: object,
): Promise<unknown> {
	try {
		return await completeHelper(callTool, payload, rules, schema, "smol");
	} catch (error) {
		const smolFailure = error instanceof Error ? error.message : String(error);
		try {
			return await completeHelper(callTool, payload, rules, schema, "default");
		} catch (fallbackError) {
			const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
			throw new ToolError(`${message} (after smol tier failed: ${smolFailure})`);
		}
	}
}

const FIELD_TEXT_SCHEMA = {
	type: "object",
	properties: { text: { type: ["string", "null"] } },
	required: ["text"],
	additionalProperties: false,
} as const;

/** Ask the helper model for one field value; `null` means the goal supplies none. */
async function fieldText(driver: JevDriver, context: JevFieldContext): Promise<string | null> {
	const value = await driver.helper(context, textValueRules, FIELD_TEXT_SCHEMA);
	const record: unknown = typeof value === "string" ? JSON.parse(value) : value;
	if (!record || typeof record !== "object" || !("text" in record)) {
		throw new ToolError("Text helper returned no valid field value; nothing typed.");
	}
	const text = record.text;
	if (text === null) return null;
	if (typeof text !== "string" || text.length > 2000) {
		throw new ToolError("Text helper returned no valid field value; nothing typed.");
	}
	return text;
}
