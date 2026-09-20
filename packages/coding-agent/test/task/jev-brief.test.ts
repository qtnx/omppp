import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	JevError,
	type JevRequest,
	type JevResponse,
	type JevPostOptions,
} from "@oh-my-pi/pi-coding-agent/jev/systemone";
import { assessBriefs, routeAgent } from "@oh-my-pi/pi-coding-agent/task/jev-brief";

const endpointBefore = Bun.env.TYPESAFE_SYSTEMONE_URL;

type Post = (body: JevRequest, options?: JevPostOptions) => Promise<JevResponse>;

function choiceAnswer(choice: string, ids: string[], confidence: number) {
	const probabilities: Record<string, number> = {};
	for (const id of ids) probabilities[id] = id === choice ? 1 : 0;
	return { choice, confidence, probabilities };
}

beforeEach(() => {
	Bun.env.TYPESAFE_SYSTEMONE_URL = "http://jev.test/v1/systemone";
});

afterEach(() => {
	if (endpointBefore === undefined) delete Bun.env.TYPESAFE_SYSTEMONE_URL;
	else Bun.env.TYPESAFE_SYSTEMONE_URL = endpointBefore;
});

describe("assessBriefs", () => {
	it("flags only noul answers below 0.5", async () => {
		let request: JevRequest | undefined;
		const post: Post = async body => {
			request = body;
			return {
				answers: {
					"brief::0::anchors": { noul: 0.49 },
					"brief::0::acceptance": { noul: 0.5 },
					"brief::0::scope": { noul: 0.9 },
				},
			};
		};

		const result = await assessBriefs({
			assignments: [{ name: "Parser", task: "Edit src/parser.ts:parse", context: "Keep API stable." }],
			post,
			timeoutMs: 8_000,
		});

		expect(result).toEqual([{ name: "Parser", gaps: ["anchors"] }]);
		expect(request?.state).toEqual({
			assignments: [{ name: "Parser", task: "Edit src/parser.ts:parse", context: "Keep API stable." }],
		});
		expect(Object.keys(request?.questions ?? {})).toEqual([
			"brief::0::anchors",
			"brief::0::acceptance",
			"brief::0::scope",
		]);
	});
});

describe("routeAgent", () => {
	it("returns undefined when confidence is below 0.6", async () => {
		const post: Post = async () => ({
			answers: { "route::pick": choiceAnswer("task", ["task", "scout"], 0.59) },
		});

		const result = await routeAgent({
			assignment: "Implement parser fix",
			context: "Use existing parser utilities.",
			agents: [
				{ name: "task", description: "Implement one contained slice." },
				{ name: "scout", description: "Locate facts without editing." },
			],
			post,
		});

		expect(result).toBeUndefined();
	});

	it("returns undefined on JevError", async () => {
		const post: Post = async () => {
			throw new JevError("offline", "connection");
		};

		const result = await routeAgent({
			assignment: "Implement parser fix",
			context: "Use existing parser utilities.",
			agents: [{ name: "task", description: "Implement one contained slice." }],
			post,
		});

		expect(result).toBeUndefined();
	});

	it("accepts only agents present in criteria", async () => {
		let criteria: Record<string, string | null> | undefined;
		const post: Post = async body => {
			const question = body.questions["route::pick"];
			if (question?.type === "choice") criteria = question.criteria;
			return {
				answers: {
					"route::pick": {
						choice: "reviewer",
						confidence: 0.99,
						probabilities: { task: 0, reviewer: 1 },
					},
				},
			};
		};

		const result = await routeAgent({
			assignment: "Implement parser fix",
			context: "Use existing parser utilities.",
			agents: [{ name: "task", description: "Implement one contained slice." }],
			post,
		});

		expect(criteria).toEqual({ task: "Implement one contained slice." });
		expect(result).toBeUndefined();
	});
});
