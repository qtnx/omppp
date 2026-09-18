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

/** Jev is on by default whenever the TypeSafe key is present in the environment. */
export function jevApiKey(): string | undefined {
	const key = Bun.env[JEV_API_KEY_ENV]?.trim();
	return key ? key : undefined;
}

/** System One endpoint for Jev; the proxy default needs no local key. */
export function jevEndpoint(): string {
	return Bun.env[JEV_ENDPOINT_ENV]?.trim() || JEV_PROXY_ENDPOINT;
}

export type JevOperation = "CLICK" | "TYPE_TEXT" | "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED";

const FILL_ROLES: Record<string, true> = { textbox: true, searchbox: true, combobox: true, spinbutton: true };

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
	/** Operation → offered target index → observed entry. */
	targets: Partial<Record<"CLICK" | "TYPE_TEXT", Map<string, ObservationEntry>>>;
}

export interface JevStep {
	step: number;
	operation: JevOperation;
	target?: { id: number; role: string; name?: string };
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
	click(id: number): Promise<void>;
	fill(id: number, text: string): Promise<void>;
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
	const click = new Map<string, ObservationEntry>();
	const typeText = new Map<string, ObservationEntry>();
	for (const entry of observation.elements) {
		if (entry.states.includes("disabled")) continue;
		const index = String(elements.length + 1);
		const operations: JevOperation[] = ["CLICK"];
		click.set(index, entry);
		if (FILL_ROLES[entry.role] && !entry.states.includes("readonly")) {
			operations.push("TYPE_TEXT");
			typeText.set(index, entry);
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
	if (click.size > 0) targets.CLICK = click;
	if (typeText.size > 0) targets.TYPE_TEXT = typeText;
	return { elements, targets };
}

const OPERATION_LABELS: Record<JevOperation, string> = {
	CLICK: "Click an element, button, link, menu option, autocomplete suggestion, or calendar day.",
	TYPE_TEXT: "Enter or replace text in an editable field. A helper will supply the value from the goal.",
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
	if (space.targets.TYPE_TEXT) operations.TYPE_TEXT = OPERATION_LABELS.TYPE_TEXT;
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
	for (const operation of ["CLICK", "TYPE_TEXT"] as const) {
		const entries = space.targets[operation];
		if (!entries) continue;
		questions[`${operation.toLowerCase()}_target`] = {
			type: "choice",
			criteria: targetCriteria(entries),
			instructions: { goal, operation, rules: [nextActionRules, targetRules] },
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
	return `${step.operation} ${step.target.role}${name}`;
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
		if (operation === "CLICK" || operation === "TYPE_TEXT") {
			const entries = space.targets[operation]!;
			const targetAnswer = validateChoice(answers[`${operation.toLowerCase()}_target`], entries.keys());
			const entry = entries.get(targetAnswer.choice)!;
			step.target = { id: entry.id, role: entry.role, name: entry.name };
			step.probability = targetAnswer.probabilities[targetAnswer.choice]!;
			if (operation === "CLICK") {
				await driver.click(entry.id);
			} else {
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
