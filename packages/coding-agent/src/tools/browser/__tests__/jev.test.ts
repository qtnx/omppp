import { describe, expect, test } from "bun:test";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
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

/** Behavior tests assert the action log, so shots and the review turn stay off. */
const QUIET = { apiKey: "test", screenshots: false, review: false } as const;

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
		screenshot: async label => {
			log.push(`shot:${label}`);
			return `/tmp/${label}.png`;
		},
		click: async id => void log.push(`click:${id}`),
		fill: async (id, text) => void log.push(`fill:${id}:${text}`),
		hover: async id => void log.push(`hover:${id}`),
		pressEnter: async id => void log.push(`enter:${id}`),
		drag: async (from, to) => void log.push(`drag:${from}->${to}`),
		scroll: async delta => void log.push(`scroll:${delta}`),
		wait: async () => {},
		helper: async payload => {
			const context = payload as { field?: { label: string } };
			log.push(`text:${context.field?.label}`);
			return { text: "cats" };
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
		const result = await runJevAct(driver, "Search for cats", { ...QUIET, fetch: fetchImpl });
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
		let tick = 0;
		const driver = makeDriver(log, {
			observe: async () => observation(elements, `https://example.test/?step=${tick++}`),
		});
		const fetchImpl = fakeFetch([
			body => answerAll(body, "SELECT", { select_target: "3" }),
			body => answerAll(body, "HOVER", { hover_target: "2" }),
			body => answerAll(body, "PRESS_ENTER", { press_enter_target: "1" }),
			body => answerAll(body, "DONE"),
		]);
		const result = await runJevAct(driver, "Pick economy then submit", { ...QUIET, fetch: fetchImpl });
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
			...QUIET,
			fetch: fakeFetch([
				body => answerAll(body, "DRAG", { drag_from_target: "3", drag_to_target: "1" }),
				body => answerAll(body, "DONE"),
			]),
		});
		expect(log).toEqual(["drag:4->1"]);
		expect(dragged.steps[0]?.dropTarget?.id).toBe(1);

		await expect(
			runJevAct(makeDriver([], { observe: async () => observation(elements) }), "Reorder the row", {
				...QUIET,
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
			...QUIET,
			fetch: fakeFetch([clickGo, clickGo, clickGo, clickGo]),
		});
		expect(result.status).toBe("blocked");
		expect(result.steps).toHaveLength(3);
	});

	test("calls the proxy endpoint without a key and sends Authorization only when one is set", async () => {
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		const capture = (async (url: unknown, init?: RequestInit) => {
			seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({ model: "jev-test", answers: { operation: answer("DONE", operationIds(body)) } }),
				{
					status: 200,
				},
			);
		}) as typeof fetch;
		const driver = makeDriver([], { observe: async () => observation([SUBMIT]) });

		const previousKey = Bun.env.TYPESAFE_API_KEY;
		const previousEndpoint = Bun.env.TYPESAFE_SYSTEMONE_URL;
		delete Bun.env.TYPESAFE_API_KEY;
		delete Bun.env.TYPESAFE_SYSTEMONE_URL;
		try {
			expect((await runJevAct(driver, "Open the thing", { fetch: capture })).status).toBe("done");
			expect(seen[0]?.url).toBe("http://codemc:8791/v1/systemone");
			expect(seen[0]?.headers.Authorization).toBeUndefined();

			await runJevAct(driver, "Open the thing", { ...QUIET, fetch: capture });
			expect(seen[1]?.headers.Authorization).toBe("Bearer test");

			Bun.env.TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
			await runJevAct(driver, "Open the thing", { ...QUIET, fetch: capture });
			expect(seen[2]?.url).toBe("https://api.typesafe.ai/v1/systemone");
		} finally {
			if (previousKey === undefined) delete Bun.env.TYPESAFE_API_KEY;
			else Bun.env.TYPESAFE_API_KEY = previousKey;
			if (previousEndpoint === undefined) delete Bun.env.TYPESAFE_SYSTEMONE_URL;
			else Bun.env.TYPESAFE_SYSTEMONE_URL = previousEndpoint;
		}
	});

	test("refuses to type when the goal supplies no field value", async () => {
		const driver = makeDriver([], {
			observe: async () => observation([SEARCH]),
			fill: async () => {
				throw new Error("must not fill");
			},
			helper: async () => ({ text: null }),
		});
		const fetchImpl = fakeFetch([body => answerAll(body, "TYPE_TEXT", { type_text_target: "1" })]);
		await expect(runJevAct(driver, "Fill the form", { ...QUIET, fetch: fetchImpl })).rejects.toThrow(
			/supplies no value for field "Search"/,
		);
	});
});

describe("runJevAct rescue turn", () => {
	const MODAL = { id: 11, role: "button", name: "Close dialog", states: [] };

	test("a BLOCKED verdict spends one helper turn, executes its plan, and continues the run", async () => {
		const log: string[] = [];
		let closed = false;
		const driver = makeDriver(log, {
			observe: async () =>
				closed
					? observation([SUBMIT], "https://example.test/open")
					: observation([SUBMIT, MODAL], "https://example.test/modal"),
			click: async id => {
				log.push(`click:${id}`);
				if (id === MODAL.id) closed = true;
			},
			helper: async payload => {
				const context = payload as { stuck_because?: string; elements?: Array<{ index: string; label: string }> };
				log.push(`rescue:${context.stuck_because}`);
				const modal = context.elements?.find(e => e.label === "Close dialog");
				return {
					action: "recover",
					reason: "closed the dialog",
					steps: [{ operation: "CLICK", element: modal?.index, text: null }],
				};
			},
		});
		const result = await runJevAct(driver, "Reach the page behind the dialog", {
			...QUIET,
			fetch: fakeFetch([body => answerAll(body, "BLOCKED"), body => answerAll(body, "DONE")]),
		});
		expect(log).toEqual(["rescue:policy_reported_blocked", "click:11"]);
		expect(result.status).toBe("done");
		expect(result.rescues).toBe(1);
		expect(result.steps.map(s => [s.operation, s.target?.id, s.rescue, s.pageChanged])).toEqual([
			["CLICK", 11, "closed the dialog", true],
		]);
	});

	test("a give_up answer surfaces the named obstacle as the blocked reason", async () => {
		const driver = makeDriver([], {
			observe: async () => observation([SUBMIT]),
			helper: async () => ({
				action: "give_up",
				reason: "the flow needs a payment card the goal does not supply",
				steps: [],
			}),
		});
		const result = await runJevAct(driver, "Complete checkout", {
			...QUIET,
			fetch: fakeFetch([body => answerAll(body, "BLOCKED")]),
		});
		expect(result.status).toBe("blocked");
		expect(result.reason).toBe("the flow needs a payment card the goal does not supply");
		expect(result.rescues).toBe(1);
		expect(result.steps).toHaveLength(0);
	});

	test("a plan naming an element that was never offered executes nothing", async () => {
		const log: string[] = [];
		const driver = makeDriver(log, {
			observe: async () => observation([SUBMIT]),
			helper: async () => ({
				action: "recover",
				reason: "clicking the hidden overlay",
				steps: [{ operation: "CLICK", element: "99", text: null }],
			}),
		});
		const result = await runJevAct(driver, "Do the thing", {
			...QUIET,
			fetch: fakeFetch([body => answerAll(body, "BLOCKED")]),
		});
		expect(log).toEqual([]);
		expect(result.status).toBe("blocked");
		expect(result.reason).toBe("clicking the hidden overlay");
	});

	test("three actions that change nothing trigger the rescue before giving up", async () => {
		const log: string[] = [];
		const driver = makeDriver(log, {
			observe: async () => observation([SUBMIT]),
			helper: async payload => {
				log.push(`rescue:${(payload as { stuck_because?: string }).stuck_because}`);
				return { action: "give_up", reason: "the page never reacts", steps: [] };
			},
		});
		const clickGo = (body: Record<string, unknown>): Record<string, unknown> =>
			answerAll(body, "CLICK", { click_target: "1" });
		const result = await runJevAct(driver, "Open the thing", {
			...QUIET,
			fetch: fakeFetch([clickGo, clickGo, clickGo, clickGo]),
		});
		expect(log).toEqual(["click:2", "click:2", "click:2", "rescue:no_progress"]);
		expect(result.status).toBe("blocked");
		expect(result.reason).toBe("the page never reacts");
	});
});

describe("runJevAct reporting", () => {
	test("records the opening and final frames and attaches the review turn", async () => {
		const log: string[] = [];
		const driver = makeDriver(log, {
			observe: async () => observation([SUBMIT]),
			helper: async (_payload, rules) => {
				log.push(rules.startsWith("Judge the browser flow") ? "review" : "other-helper");
				return {
					summary: "One click reached the goal.",
					findings: [
						{
							severity: "major",
							area: "accessibility",
							finding: "The only control is named Go.",
							evidence: 'label "Go"',
						},
						{ severity: "minor", area: "ux", finding: "no progress feedback", evidence: "0 step feedback" },
						// Malformed rows are dropped, not surfaced.
						{ severity: "minor" },
					],
				};
			},
		});
		const result = await runJevAct(driver, "Open the thing", {
			apiKey: "test",
			fetch: fakeFetch([body => answerAll(body, "DONE")]),
		});
		// The final frame is captured before the review turn runs, so the screenshot
		// shows the state the reviewer is judging.
		expect(log).toEqual(["shot:start", "shot:final", "review"]);
		expect(result.shots).toEqual(["/tmp/start.png", "/tmp/final.png"]);
		expect(result.review?.summary).toBe("One click reached the goal.");
		expect(result.review?.findings).toHaveLength(2);
	});

	test("a failing review turn degrades to an unavailable note instead of failing the run", async () => {
		const driver = makeDriver([], {
			observe: async () => observation([SUBMIT]),
			helper: async () => {
				throw new Error("provider rate limited");
			},
		});
		const result = await runJevAct(driver, "Open the thing", {
			apiKey: "test",
			screenshots: false,
			fetch: fakeFetch([body => answerAll(body, "DONE")]),
		});
		expect(result.status).toBe("done");
		expect(result.review?.unavailable).toContain("provider rate limited");
		expect(result.review?.findings).toEqual([]);
	});
});

describe("runJevAct rescue depth", () => {
	test("drives a multi-step rescue plan and asks the reasoning tier first", async () => {
		const log: string[] = [];
		const tiers: Array<string | undefined> = [];
		let closed = false;
		let acknowledged = false;
		const modal = { id: 11, role: "button", name: "Collect rewards", states: [] };
		const confirm = { id: 12, role: "button", name: "Confirm", states: [] };
		const driver = makeDriver(log, {
			observe: async () =>
				closed
					? observation([confirm], "https://example.test/step-2")
					: acknowledged
						? observation([confirm, modal], "https://example.test/step-1")
						: observation([modal], "https://example.test/modal"),
			click: async id => {
				log.push(`click:${id}`);
				if (id === modal.id) acknowledged = true;
				if (id === confirm.id) closed = true;
			},
			helper: async (_payload, _rules, _schema, prefer) => {
				tiers.push(prefer);
				const context = _payload as { elements?: Array<{ index: string; label: string }> };
				const indexOf = (label: string): string | undefined =>
					context.elements?.find(entry => entry.label.startsWith(label))?.index;
				return {
					action: "recover",
					reason: "cleared the round summary, then confirmed",
					steps: [
						{ operation: "CLICK", element: indexOf("Collect"), text: null },
						{ operation: "CLICK", element: indexOf("Confirm"), text: null },
					],
				};
			},
		});
		const result = await runJevAct(driver, "Claim the round reward", {
			apiKey: "test",
			screenshots: false,
			review: false,
			fetch: fakeFetch([body => answerAll(body, "BLOCKED"), body => answerAll(body, "DONE")]),
		});
		// The first click changed the page, so the sequence handed back to the policy,
		// which then finished; the rescue itself escalated to the reasoning tier.
		expect(tiers).toEqual(["default"]);
		expect(result.rescues).toBe(1);
		expect(result.status).toBe("done");
		expect(log).toEqual(["click:11"]);
		expect(result.steps.map(step => [step.operation, step.target?.id, step.rescue])).toEqual([
			["CLICK", 11, "cleared the round summary, then confirmed"],
		]);
	});

	test("keeps driving a rescue plan whose actions leave the page unchanged, up to the plan length", async () => {
		const log: string[] = [];
		const driver = makeDriver(log, {
			observe: async () => observation([{ id: 7, role: "button", name: "Acknowledge", states: [] }]),
			click: async id => void log.push(`click:${id}`),
			helper: async () => ({
				action: "recover",
				reason: "clicked through the gate",
				steps: [
					{ operation: "CLICK", element: "1", text: null },
					{ operation: "CLICK", element: "1", text: null },
				],
			}),
		});
		const result = await runJevAct(driver, "Get past the gate", {
			apiKey: "test",
			screenshots: false,
			review: false,
			fetch: fakeFetch([body => answerAll(body, "BLOCKED"), body => answerAll(body, "DONE")]),
		});
		expect(log).toEqual(["click:7", "click:7"]);
		expect(result.rescues).toBe(1);
		expect(result.steps).toHaveLength(2);
	});
});

describe("policy-requested escalation", () => {
	test("Jev choosing ESCALATE hands the step to the reasoning model and resumes after it", async () => {
		const log: string[] = [];
		const tiers: Array<string | undefined> = [];
		let cleared = false;
		const gate = { id: 21, role: "button", name: "Collect rewards", states: [] };
		const driver = makeDriver(log, {
			observe: async () => observation(cleared ? [SUBMIT] : [SUBMIT, gate]),
			click: async id => {
				log.push(`click:${id}`);
				if (id === gate.id) cleared = true;
			},
			helper: async payload => {
				tiers.push((payload as { stuck_because?: string }).stuck_because);
				return {
					action: "recover",
					reason: "cleared the gate the policy could not choose between",
					steps: [{ operation: "CLICK", element: "2", text: null }],
				};
			},
		});
		const result = await runJevAct(driver, "Open the search page", {
			apiKey: "test",
			screenshots: false,
			review: false,
			fetch: fakeFetch([body => answerAll(body, "ESCALATE"), body => answerAll(body, "DONE")]),
		});
		expect(tiers).toEqual(["policy_requested_escalation"]);
		expect(result.status).toBe("done");
		expect(result.rescues).toBe(1);
		expect(result.steps.map(step => [step.operation, step.target?.id, step.escalated])).toEqual([
			["CLICK", 21, true],
		]);
	});

	test("ESCALATE is not offered once the rescue budget is spent", async () => {
		const seen: string[][] = [];
		const driver = makeDriver([], {
			observe: async () => observation([SUBMIT]),
			// Recover without moving the page, so the loop asks Jev again.
			helper: async () => ({
				action: "recover",
				reason: "tried the only control",
				steps: [{ operation: "CLICK", element: "1", text: null }],
			}),
		});
		const fetchImpl = ((_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const criteria = (body.questions as Record<string, { criteria: Record<string, unknown> }>).operation!.criteria;
			seen.push(Object.keys(criteria));
			return Promise.resolve(
				new Response(JSON.stringify({ answers: answerAll(body, "ESCALATE") }), { status: 200 }),
			);
		}) as typeof fetch;
		await expect(
			runJevAct(driver, "Do the thing", {
				apiKey: "test",
				screenshots: false,
				review: false,
				maxRescues: 1,
				fetch: fetchImpl,
			}),
		).rejects.toThrow(/Invalid Jev response/);
		expect(seen[0]).toContain("ESCALATE");
		// The budget went on the first escalation, so the next request must not offer
		// it — and an answer that still names it is rejected rather than executed.
		expect(seen[1]).not.toContain("ESCALATE");
	});
});
