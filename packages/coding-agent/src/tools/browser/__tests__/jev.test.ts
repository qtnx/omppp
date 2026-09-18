import { describe, expect, test } from "bun:test";
import { ToolError } from "../../tool-errors";
import { buildActionSpace, type JevDriver, runJevAct, validateChoice } from "../jev";
import type { Observation, ObservationEntry } from "../tab-protocol";

function observation(elements: ObservationEntry[], url = "https://example.test/"): Observation {
	return {
		url,
		title: "Fixture",
		viewport: { width: 1280, height: 720 },
		scroll: { x: 0, y: 0, width: 1280, height: 720, scrollWidth: 1280, scrollHeight: 720 },
		elements,
	};
}

const SEARCH: ObservationEntry = { id: 1, role: "searchbox", name: "Search", value: "", states: [] };
const SUBMIT: ObservationEntry = { id: 2, role: "button", name: "Go", states: [] };

describe("buildActionSpace", () => {
	test("offers TYPE_TEXT/PRESS_ENTER for editable roles, SELECT for options, and drops disabled controls", () => {
		const space = buildActionSpace(
			observation([
				SEARCH,
				SUBMIT,
				{ id: 3, role: "textbox", name: "Locked", states: ["readonly"] },
				{ id: 4, role: "button", name: "Off", states: ["disabled"] },
				{ id: 5, role: "checkbox", name: "Agree", states: ["checked=true"] },
				{ id: 6, role: "option", name: "Economy", states: ["selected=false"] },
			]),
		);
		expect(space.elements.map(e => [e.index, e.role, e.operations])).toEqual([
			["1", "searchbox", ["CLICK", "TYPE_TEXT", "PRESS_ENTER"]],
			["2", "button", ["CLICK"]],
			["3", "textbox", ["CLICK"]],
			["4", "checkbox", ["CLICK"]],
			["5", "option", ["CLICK", "SELECT"]],
		]);
		expect(space.elements[3]?.checked).toBe("true");
		expect([...space.targets.TYPE_TEXT!.keys()]).toEqual(["1"]);
		expect([...space.targets.PRESS_ENTER!.keys()]).toEqual(["1"]);
		expect(space.targets.SELECT!.get("5")?.id).toBe(6);
		expect(space.targets.CLICK!.get("4")?.id).toBe(5);
		// Hover and both drag endpoints accept every observed element.
		expect(space.targets.HOVER!.size).toBe(5);
		expect(space.targets.DRAG_FROM!.size).toBe(5);
		expect(space.targets.DRAG_TO!.size).toBe(5);
	});
});

describe("validateChoice", () => {
	test("rejects a choice outside the offered ids or an unnormalized head", () => {
		expect(() =>
			validateChoice({ choice: "3", confidence: 0.9, probabilities: { "1": 0.5, "2": 0.5 } }, ["1", "2"]),
		).toThrow(ToolError);
		expect(() =>
			validateChoice({ choice: "1", confidence: 0.9, probabilities: { "1": 0.9, "2": 0.5 } }, ["1", "2"]),
		).toThrow(ToolError);
		expect(
			validateChoice({ choice: "1", confidence: 0.4, probabilities: { "1": 0.6, "2": 0.4 } }, ["1", "2"]).choice,
		).toBe("1");
	});
});

interface Answer {
	choice: string;
	probabilities: Record<string, number>;
}

function answer(choice: string, ids: string[]): Answer & { confidence: number } {
	const probabilities: Record<string, number> = {};
	for (const id of ids) probabilities[id] = id === choice ? 1 : 0;
	return { choice, confidence: 1, probabilities };
}

function fakeFetch(script: Array<(body: Record<string, unknown>) => Record<string, unknown>>): typeof fetch {
	let call = 0;
	return (async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const respond = script[call++];
		if (!respond) throw new Error("unexpected Jev request");
		return new Response(JSON.stringify({ model: "jev-test", answers: respond(body) }), { status: 200 });
	}) as typeof fetch;
}

function operationIds(body: Record<string, unknown>): string[] {
	const questions = body.questions as Record<string, { criteria: Record<string, unknown> }>;
	return Object.keys(questions.operation!.criteria);
}

function targetIds(body: Record<string, unknown>, head: string): string[] {
	const questions = body.questions as Record<string, { criteria: Record<string, unknown> }>;
	return Object.keys(questions[head]!.criteria);
}

/** Driver whose every operation appends to `log`; overrides replace one method. */
function makeDriver(log: string[], overrides: Partial<JevDriver> & Pick<JevDriver, "observe">): JevDriver {
	return {
		pageText: async () => "Fixture page",
		click: async id => void log.push(`click:${id}`),
		fill: async (id, text) => void log.push(`fill:${id}:${text}`),
		hover: async id => void log.push(`hover:${id}`),
		pressEnter: async id => void log.push(`enter:${id}`),
		drag: async (from, to) => void log.push(`drag:${from}->${to}`),
		scroll: async delta => void log.push(`scroll:${delta}`),
		wait: async () => {},
		fieldText: async context => {
			log.push(`text:${context.field.label}`);
			return "cats";
		},
		...overrides,
	};
}

/** Answer the operation head plus every target head the request actually offered. */
function answerAll(
	body: Record<string, unknown>,
	operation: string,
	choices: Record<string, string> = {},
): Record<string, unknown> {
	const questions = body.questions as Record<string, { criteria: Record<string, unknown> }>;
	const answers: Record<string, unknown> = { operation: answer(operation, operationIds(body)) };
	for (const head of Object.keys(questions)) {
		if (head === "operation") continue;
		const ids = targetIds(body, head);
		answers[head] = answer(choices[head] ?? ids[0]!, ids);
	}
	return answers;
}

describe("runJevAct", () => {
	test("types helper text into the chosen field, clicks the chosen button, and stops on DONE", async () => {
		const log: string[] = [];
		let value = "";
		const driver = makeDriver(log, {
			observe: async () =>
				observation([{ ...SEARCH, value }, SUBMIT], value ? "https://example.test/?q=cats" : undefined),
			fill: async (id, text) => {
				log.push(`fill:${id}:${text}`);
				value = text;
			},
		});
		const fetchImpl = fakeFetch([
			body => answerAll(body, "TYPE_TEXT", { type_text_target: "1" }),
			body => answerAll(body, "CLICK", { click_target: "2" }),
			body => answerAll(body, "DONE"),
		]);
		const result = await runJevAct(driver, "Search for cats", { apiKey: "test", fetch: fetchImpl });
		expect(log).toEqual(["text:Search", "fill:1:cats", "click:2"]);
		expect(result.status).toBe("done");
		expect(result.steps.map(s => [s.operation, s.target?.id, s.text, s.pageChanged])).toEqual([
			["TYPE_TEXT", 1, "cats", true],
			["CLICK", 2, undefined, false],
		]);
		expect(result.url).toBe("https://example.test/?q=cats");
	});

	test("routes SELECT through element activation and HOVER/PRESS_ENTER to their own operations", async () => {
		const log: string[] = [];
		const elements = [SEARCH, SUBMIT, { id: 9, role: "option", name: "Economy", states: [] }];
		const driver = makeDriver(log, { observe: async () => observation(elements) });
		const fetchImpl = fakeFetch([
			body => answerAll(body, "SELECT", { select_target: "3" }),
			body => answerAll(body, "HOVER", { hover_target: "2" }),
			body => answerAll(body, "PRESS_ENTER", { press_enter_target: "1" }),
			body => answerAll(body, "DONE"),
		]);
		const result = await runJevAct(driver, "Pick economy then submit", { apiKey: "test", fetch: fetchImpl });
		expect(log).toEqual(["click:9", "hover:2", "enter:1"]);
		expect(result.steps.map(s => [s.operation, s.target?.id])).toEqual([
			["SELECT", 9],
			["HOVER", 2],
			["PRESS_ENTER", 1],
		]);
	});

	test("DRAG resolves both endpoints and refuses a self-drag", async () => {
		const log: string[] = [];
		const elements = [SEARCH, SUBMIT, { id: 4, role: "listitem", name: "Row", states: [] }];
		const driver = makeDriver(log, { observe: async () => observation(elements) });
		const dragged = await runJevAct(driver, "Reorder the row", {
			apiKey: "test",
			fetch: fakeFetch([
				body => answerAll(body, "DRAG", { drag_from_target: "3", drag_to_target: "1" }),
				body => answerAll(body, "DONE"),
			]),
		});
		expect(log).toEqual(["drag:4->1"]);
		expect(dragged.steps[0]?.dropTarget?.id).toBe(1);

		await expect(
			runJevAct(makeDriver([], { observe: async () => observation(elements) }), "Reorder the row", {
				apiKey: "test",
				fetch: fakeFetch([body => answerAll(body, "DRAG", { drag_from_target: "2", drag_to_target: "2" })]),
			}),
		).rejects.toThrow(/same element/);
	});

	test("reports blocked after three consecutive actions that leave the page unchanged", async () => {
		const log: string[] = [];
		const driver = makeDriver(log, { observe: async () => observation([SUBMIT]) });
		const clickGo = (body: Record<string, unknown>): Record<string, unknown> =>
			answerAll(body, "CLICK", { click_target: "1" });
		const result = await runJevAct(driver, "Open the thing", {
			apiKey: "test",
			fetch: fakeFetch([clickGo, clickGo, clickGo, clickGo]),
		});
		expect(result.status).toBe("blocked");
		expect(result.steps).toHaveLength(3);
	});

	test("refuses to type when the goal supplies no field value", async () => {
		const driver = makeDriver([], {
			observe: async () => observation([SEARCH]),
			fill: async () => {
				throw new Error("must not fill");
			},
			fieldText: async () => null,
		});
		const fetchImpl = fakeFetch([body => answerAll(body, "TYPE_TEXT", { type_text_target: "1" })]);
		await expect(runJevAct(driver, "Fill the form", { apiKey: "test", fetch: fetchImpl })).rejects.toThrow(
			/supplies no value for field "Search"/,
		);
	});
});
