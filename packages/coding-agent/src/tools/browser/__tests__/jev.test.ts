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
	test("offers TYPE_TEXT only for editable text roles and drops disabled controls", () => {
		const space = buildActionSpace(
			observation([
				SEARCH,
				SUBMIT,
				{ id: 3, role: "textbox", name: "Locked", states: ["readonly"] },
				{ id: 4, role: "button", name: "Off", states: ["disabled"] },
				{ id: 5, role: "checkbox", name: "Agree", states: ["checked=true"] },
			]),
		);
		expect(space.elements.map(e => [e.index, e.role, e.operations])).toEqual([
			["1", "searchbox", ["CLICK", "TYPE_TEXT"]],
			["2", "button", ["CLICK"]],
			["3", "textbox", ["CLICK"]],
			["4", "checkbox", ["CLICK"]],
		]);
		expect(space.elements[3]?.checked).toBe("true");
		expect([...space.targets.TYPE_TEXT!.keys()]).toEqual(["1"]);
		expect(space.targets.CLICK!.get("4")?.id).toBe(5);
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

describe("runJevAct", () => {
	test("types helper text into the chosen field, clicks the chosen button, and stops on DONE", async () => {
		const log: string[] = [];
		let value = "";
		const driver: JevDriver = {
			observe: async () =>
				observation([{ ...SEARCH, value }, SUBMIT], value ? "https://example.test/?q=cats" : undefined),
			pageText: async () => "Fixture page",
			click: async id => {
				log.push(`click:${id}`);
			},
			fill: async (id, text) => {
				log.push(`fill:${id}:${text}`);
				value = text;
			},
			scroll: async () => {
				log.push("scroll");
			},
			wait: async () => {},
			fieldText: async context => {
				log.push(`text:${context.field.label}`);
				return "cats";
			},
		};
		const fetchImpl = fakeFetch([
			body => ({
				operation: answer("TYPE_TEXT", operationIds(body)),
				click_target: answer("1", targetIds(body, "click_target")),
				type_text_target: answer("1", targetIds(body, "type_text_target")),
			}),
			body => ({
				operation: answer("CLICK", operationIds(body)),
				click_target: answer("2", targetIds(body, "click_target")),
				type_text_target: answer("1", targetIds(body, "type_text_target")),
			}),
			body => ({
				operation: answer("DONE", operationIds(body)),
				click_target: answer("2", targetIds(body, "click_target")),
				type_text_target: answer("1", targetIds(body, "type_text_target")),
			}),
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

	test("reports blocked after three consecutive actions that leave the page unchanged", async () => {
		const driver: JevDriver = {
			observe: async () => observation([SUBMIT]),
			pageText: async () => "",
			click: async () => {},
			fill: async () => {},
			scroll: async () => {},
			wait: async () => {},
			fieldText: async () => null,
		};
		const clickGo = (body: Record<string, unknown>): Record<string, unknown> => ({
			operation: answer("CLICK", operationIds(body)),
			click_target: answer("1", targetIds(body, "click_target")),
		});
		const result = await runJevAct(driver, "Open the thing", {
			apiKey: "test",
			fetch: fakeFetch([clickGo, clickGo, clickGo, clickGo]),
		});
		expect(result.status).toBe("blocked");
		expect(result.steps).toHaveLength(3);
	});

	test("refuses to type when the goal supplies no field value", async () => {
		const driver: JevDriver = {
			observe: async () => observation([SEARCH]),
			pageText: async () => "",
			click: async () => {},
			fill: async () => {
				throw new Error("must not fill");
			},
			scroll: async () => {},
			wait: async () => {},
			fieldText: async () => null,
		};
		const fetchImpl = fakeFetch([
			body => ({
				operation: answer("TYPE_TEXT", operationIds(body)),
				click_target: answer("1", targetIds(body, "click_target")),
				type_text_target: answer("1", targetIds(body, "type_text_target")),
			}),
		]);
		await expect(runJevAct(driver, "Fill the form", { apiKey: "test", fetch: fetchImpl })).rejects.toThrow(
			/supplies no value for field "Search"/,
		);
	});
});
