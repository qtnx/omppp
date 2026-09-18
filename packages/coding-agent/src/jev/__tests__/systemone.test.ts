import { afterEach, describe, expect, test } from "bun:test";
import {
	JevError,
	JEV_ENDPOINT_ENV,
	JEV_MODEL_ENV,
	jevEndpoint,
	jevModel,
	postSystemOne,
	type JevRequest,
	validateChoice,
	validateNoul,
} from "../systemone";

const PREVIOUS_ENDPOINT = Bun.env[JEV_ENDPOINT_ENV];
const PREVIOUS_MODEL = Bun.env[JEV_MODEL_ENV];

afterEach(() => {
	if (PREVIOUS_ENDPOINT === undefined) delete Bun.env[JEV_ENDPOINT_ENV];
	else Bun.env[JEV_ENDPOINT_ENV] = PREVIOUS_ENDPOINT;
	if (PREVIOUS_MODEL === undefined) delete Bun.env[JEV_MODEL_ENV];
	else Bun.env[JEV_MODEL_ENV] = PREVIOUS_MODEL;
});

function fakeFetch(script: Array<(body: JevRequest) => number | Record<string, unknown>>): {
	fetch: typeof fetch;
	requestBodies: JevRequest[];
} {
	const requestBodies: JevRequest[] = [];
	let call = 0;
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as JevRequest;
		requestBodies.push(body);
		const outcome = script[call++](body);
		if (typeof outcome === "number") {
			return new Response(JSON.stringify({ model: "jev-test", answers: {} }), { status: outcome });
		}
		return new Response(JSON.stringify({ model: "jev-test", answers: outcome }), { status: 200 });
	}) as typeof fetch;
	return { fetch: fetchImpl, requestBodies };
}

describe("postSystemOne", () => {
	test("retries a 503 and returns the parsed answers from the follow-up", async () => {
		const { fetch: fetchImpl } = fakeFetch([() => 503, () => ({ count: { type: "noul", noul: 0.8 } })]);
		const result = await postSystemOne(
			{ model: "jev-latest", state: "x", questions: { count: { type: "noul", instructions: "Is x true?" } } },
			{ fetchImpl },
		);
		expect(result.answers.count).toEqual({ type: "noul", noul: 0.8 });
	});

	test("maps a 401 to a JevError of kind http", async () => {
		const { fetch: fetchImpl } = fakeFetch([() => 401]);
		await expect(
			postSystemOne(
				{ model: "jev-latest", state: "x", questions: { q: { type: "noul", instructions: "?" } } },
				{ fetchImpl },
			),
		).rejects.toMatchObject({ kind: "http" });
	});

	test("sends the proxy endpoint without a key and the overridden endpoint when set", async () => {
		const seen: string[] = [];
		const fetchImpl = (async (url: unknown) => {
			seen.push(String(url));
			return new Response(JSON.stringify({ model: "jev-test", answers: {} }), { status: 200 });
		}) as typeof fetch;
		await postSystemOne({ model: "jev-latest", state: "", questions: {} }, { fetchImpl });
		expect(seen[0]).toBe("http://codemc:8791/v1/systemone");

		Bun.env.TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
		await postSystemOne({ model: "jev-latest", state: "", questions: {} }, { fetchImpl });
		expect(seen[1]).toBe("https://api.typesafe.ai/v1/systemone");
	});
});

describe("validateChoice", () => {
	test("accepts a normalized probability map over the offered ids", () => {
		expect(
			validateChoice({ choice: "1", confidence: 0.9, probabilities: { "1": 0.9, "2": 0.1 } }, ["1", "2"]),
		).toEqual({
			choice: "1",
			confidence: 0.9,
			probabilities: { "1": 0.9, "2": 0.1 },
		});
	});

	test("rejects an answer naming an unoffered id", () => {
		expect(() =>
			validateChoice({ choice: "3", confidence: 0.9, probabilities: { "1": 0.5, "2": 0.5 } }, ["1", "2"]),
		).toThrow(JevError);
	});
});

describe("validateNoul", () => {
	test("returns the noul probability for a valid noul answer", () => {
		expect(validateNoul({ type: "noul", noul: 0.42 })).toBe(0.42);
		expect(validateNoul({ noul: 0 })).toBe(0);
		expect(validateNoul({ noul: 1 })).toBe(1);
	});

	test("rejects out-of-range, non-finite, or missing nouls", () => {
		for (const bad of [{ noul: 1.2 }, { noul: -0.1 }, { noul: NaN }, { noul: "0.5" }, {}]) {
			expect(() => validateNoul(bad)).toThrow(JevError);
		}
	});
});

describe("env helpers", () => {
	test("jevModel falls back to the versioned default", () => {
		expect(jevModel()).toBe("jev-latest");
		Bun.env.TYPESAFE_MODEL = "jev-1.12";
		expect(jevModel()).toBe("jev-1.12");
	});

	test("jevEndpoint distinguishes unset from explicitly empty", () => {
		if (PREVIOUS_ENDPOINT === undefined) delete Bun.env[JEV_ENDPOINT_ENV];
		expect(jevEndpoint()).toBe("http://codemc:8791/v1/systemone");
		Bun.env.TYPESAFE_SYSTEMONE_URL = "";
		expect(jevEndpoint()).toBe("");
	});
});
