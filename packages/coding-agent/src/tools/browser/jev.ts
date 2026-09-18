/**
 * Goal-driven DOM policy backed by TypeSafe Jev (`tab.act(goal)`).
 *
 * Port of the jev-ultrafast loop (browser-use/jev-ultrafast): every step observes
 * the page, offers Jev an indexed element table, and lets one request pick both
 * the operation and its target. Model output never becomes a selector, coordinate,
 * or script — every executed target resolves from an observed element id.
 * Field values for TYPE_TEXT come from the session's `smol` completion tier.
 */

import { ToolError, throwIfAborted } from "../tool-errors";
import nextActionRules from "../../prompts/tools/browser-jev/next-action.md" with { type: "text" };
import targetRules from "../../prompts/tools/browser-jev/target.md" with { type: "text" };
import textValueRules from "../../prompts/tools/browser-jev/text-value.md" with { type: "text" };
import type { Observation, ObservationEntry } from "./tab-protocol";

export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_MODEL_ENV = "TYPESAFE_MODEL";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_MAX_STEPS = 30;
const PAGE_TEXT_CAP = 6000;
const SETTLE_MS = 150;
const WAIT_MS = 500;
const REQUEST_TIMEOUT_MS = 25_000;
const RETRY_STATUSES: Record<number, true> = { 429: true, 503: true, 529: true };

/** Jev is on by default whenever the TypeSafe key is present in the environment. */
export function jevApiKey(): string | undefined {
	const key = Bun.env[JEV_API_KEY_ENV]?.trim();
	return key ? key : undefined;
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
	/** Resolve the value to type; `null` means the goal does not supply one. */
	fieldText(context: JevFieldContext, rules: string): Promise<string | null>;
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
	apiKey: string,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch,
): Promise<JevResponse> {
	for (let attempt = 0; attempt < 3; attempt++) {
		throwIfAborted(signal);
		let response: Response;
		try {
			response = await fetchImpl(JEV_ENDPOINT, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
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

/** Run the observe → choose → act loop until Jev reports DONE/BLOCKED or the step budget is spent. */
export async function runJevAct(driver: JevDriver, goal: string, opts: JevActOptions = {}): Promise<JevActResult> {
	const task = goal.trim();
	if (!task) throw new ToolError("tab.act() requires a non-empty goal");
	const apiKey = opts.apiKey ?? jevApiKey();
	if (!apiKey) {
		throw new ToolError(`tab.act() requires ${JEV_API_KEY_ENV} in the environment (TypeSafe Jev API key).`);
	}
	const model = opts.model ?? Bun.env[JEV_MODEL_ENV]?.trim() ?? DEFAULT_MODEL;
	const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
	const fetchImpl = opts.fetch ?? fetch;
	const signal = opts.signal;
	const started = performance.now();
	const steps: JevStep[] = [];
	let observation = await driver.observe();

	const finish = (status: JevActResult["status"]): JevActResult => ({
		status,
		steps,
		url: observation.url,
		title: observation.title,
		elapsedMs: Math.round(performance.now() - started),
	});

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
		if (operation === "BLOCKED") return finish("blocked");

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
		} else if (
			operation === "CLICK" ||
			operation === "TYPE_TEXT" ||
			operation === "SELECT" ||
			operation === "HOVER" ||
			operation === "PRESS_ENTER"
		) {
			const entry = resolveTarget(operation);
			step.target = { id: entry.id, role: entry.role, name: entry.name };
			if (operation === "CLICK" || operation === "SELECT") await driver.click(entry.id);
			else if (operation === "HOVER") await driver.hover(entry.id);
			else if (operation === "PRESS_ENTER") await driver.pressEnter(entry.id);
			else {
				const text = await driver.fieldText(
					{
						goal: task,
						field: {
							label: entry.name ?? entry.description ?? "",
							role: entry.role,
							value: entry.value === undefined ? undefined : String(entry.value),
						},
						page: { title: observation.title, text: pageText.slice(0, PAGE_TEXT_CAP) },
						recent_actions: steps.slice(-6).map(s => ({ action: describeStep(s), text: s.text })),
					},
					textValueRules,
				);
				if (text === null || text.trim().length === 0) {
					throw new ToolError(
						`tab.act(): the goal supplies no value for field ${JSON.stringify(step.target.name ?? entry.role)} (element ${entry.id}); nothing typed.`,
					);
				}
				step.text = text;
				await driver.fill(entry.id, text);
			}
			await driver.wait(SETTLE_MS);
		} else if (operation === "SCROLL_DOWN" || operation === "SCROLL_UP") {
			const delta = Math.max(200, Math.round(observation.viewport.height * 0.8));
			await driver.scroll(operation === "SCROLL_DOWN" ? delta : -delta);
			await driver.wait(SETTLE_MS);
		} else {
			await driver.wait(WAIT_MS);
		}
		steps.push(step);
		observation = await driver.observe();
		step.pageChanged = fingerprint(observation) !== before;
		step.url = observation.url;

		const recent = steps.slice(-3);
		if (recent.length === 3 && recent.every(s => !s.pageChanged && s.operation !== "WAIT")) {
			return finish("blocked");
		}
	}
	return finish("max_steps");
}

type TextHelperTier = "smol" | "default";

/** Prompt payload for the text helper; shared so both backends build the same completion call. */
function fieldTextCompletionArgs(
	context: JevFieldContext,
	rules: string,
	tier: TextHelperTier,
): Record<string, unknown> {
	return {
		prompt: JSON.stringify(context),
		model: tier,
		system: rules,
		schema: {
			type: "object",
			properties: { text: { type: ["string", "null"] } },
			required: ["text"],
			additionalProperties: false,
		},
	};
}

const INVALID_FIELD_TEXT = "Text helper returned no valid field value; nothing typed.";

/** Parse the structured `{ text }` result returned by the completion bridge. */
export function parseFieldText(value: unknown): string | null {
	const record: unknown = typeof value === "string" ? JSON.parse(value) : value;
	if (!record || typeof record !== "object" || !("text" in record)) throw new ToolError(INVALID_FIELD_TEXT);
	const text = record.text;
	if (text === null) return null;
	if (typeof text !== "string" || text.length > 2000) throw new ToolError(INVALID_FIELD_TEXT);
	return text;
}

async function completeFieldText(
	callTool: (name: string, args: unknown) => Promise<unknown>,
	context: JevFieldContext,
	rules: string,
	tier: TextHelperTier,
): Promise<string | null> {
	const handle = await callTool("__completion__", fieldTextCompletionArgs(context, rules, tier));
	if (!handle || typeof handle !== "object" || !("id" in handle) || typeof handle.id !== "string") {
		throw new ToolError("Text helper did not return a completion handle");
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
		throw new ToolError(`Text helper (${tier}) failed: ${reason}`);
	}
	if ("data" in snapshot && snapshot.data !== undefined) return parseFieldText(snapshot.data);
	return parseFieldText("text" in snapshot ? snapshot.text : undefined);
}

/**
 * Resolve a TYPE_TEXT value through the session's `completion()` bridge
 * (`__completion__` returns a handle; `__wait__` settles it). The cheap `smol`
 * tier goes first; a provider/credit failure there falls back to the session's
 * `default` model so one exhausted small-model account cannot strand the run.
 */
export async function fieldTextViaBridge(
	callTool: (name: string, args: unknown) => Promise<unknown>,
	context: JevFieldContext,
	rules: string,
): Promise<string | null> {
	try {
		return await completeFieldText(callTool, context, rules, "smol");
	} catch (error) {
		if (error instanceof ToolError && error.message.startsWith(INVALID_FIELD_TEXT)) throw error;
		const smolFailure = error instanceof Error ? error.message : String(error);
		try {
			return await completeFieldText(callTool, context, rules, "default");
		} catch (fallbackError) {
			const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
			throw new ToolError(`${message} (after smol tier failed: ${smolFailure})`);
		}
	}
}
