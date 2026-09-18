import { describe, expect, test } from "bun:test";
import { JevError, postSystemOne } from "@oh-my-pi/pi-coding-agent/jev/systemone";
import {
	buildRelevanceRequest,
	selectRelevantLearnings,
	type LearningTurnCandidate,
} from "@oh-my-pi/pi-coding-agent/learnings/relevance";

function candidate(
	alias: string,
	scope: "global" | "repo",
	score: number,
	content = `guideline ${alias}`,
): LearningTurnCandidate {
	return { id: `learning-${alias}`, alias, scope, content, score };
}

const CONFIG = {
	enabled: true,
	threshold: 0.5,
	timeoutMs: 2500,
	maxCandidates: 10,
	maxInjectedPerScope: 5,
};

function noulPost(answers: Record<string, { noul: number }>): typeof postSystemOne {
	return (async () => ({ model: "jev-test", answers })) as typeof postSystemOne;
}

describe("buildRelevanceRequest", () => {
	test("emits one rel::<alias> noul per candidate over a state with the request context", () => {
		const request = buildRelevanceRequest({
			model: "jev-test",
			request: "Add pagination",
			previousRequest: "Build a settings page",
			cwd: "/repo",
			candidates: [candidate("aaa", "repo", 1)],
			instructions: "Does this guideline apply?",
		});
		expect(request.state).toEqual({
			request: "Add pagination",
			previous_request: "Build a settings page",
			cwd: "/repo",
		});
		expect(request.questions["rel::aaa"]).toEqual({
			type: "noul",
			instructions: { question: "Does this guideline apply?", guideline: "guideline aaa" },
		});
	});
});

describe("selectRelevantLearnings", () => {
	test("keeps only nouls at or above threshold, ordered by noul, capped per scope", async () => {
		const candidates = [
			candidate("aaa", "global", 3, "global one"),
			candidate("bbb", "global", 2, "global two"),
			candidate("ccc", "repo", 1, "repo one"),
		];
		const selection = await selectRelevantLearnings({
			candidates,
			request: "Add pagination",
			cwd: "/repo",
			config: CONFIG,
			post: noulPost({ "rel::aaa": { noul: 0.9 }, "rel::ccc": { noul: 0.7 }, "rel::bbb": { noul: 0.4 } }),
		});
		expect(selection.method).toBe("jev");
		expect(selection.selected.map(entry => entry.alias)).toEqual(["aaa", "ccc"]);
	});

	test("maxCandidates shortlists by stored score before asking Jev", async () => {
		const candidates = [candidate("aaa", "global", 3), candidate("bbb", "global", 2), candidate("ccc", "repo", 1)];
		let asked: string[] = [];
		const post = (async (body: Parameters<typeof postSystemOne>[0]) => {
			asked = Object.keys(body.questions);
			const answers: Record<string, { noul: number }> = {};
			for (const key of asked) answers[key] = { noul: 1 };
			return { model: "jev-test", answers };
		}) as typeof postSystemOne;
		const selection = await selectRelevantLearnings({
			candidates,
			request: "x",
			cwd: "/repo",
			config: { ...CONFIG, maxCandidates: 2 },
			post,
		});
		expect(asked.sort()).toEqual(["rel::aaa", "rel::bbb"]);
		expect(selection.selected.map(entry => entry.alias).sort()).toEqual(["aaa", "bbb"]);
	});

	test("falls back to the stored rank when the Jev request fails", async () => {
		const candidates = [candidate("aaa", "global", 3), candidate("bbb", "global", 2), candidate("ccc", "global", 1)];
		const selection = await selectRelevantLearnings({
			candidates,
			request: "x",
			cwd: "/repo",
			config: { ...CONFIG, maxInjectedPerScope: 2 },
			post: async () => {
				throw new JevError("boom", "connection");
			},
		});
		expect(selection.method).toBe("rank");
		expect(selection.selected.map(entry => entry.alias)).toEqual(["aaa", "bbb"]);
	});

	test("falls back to the rank when disabled", async () => {
		const selection = await selectRelevantLearnings({
			candidates: [candidate("aaa", "global", 3)],
			request: "x",
			cwd: "/repo",
			config: { ...CONFIG, enabled: false },
		});
		expect(selection.method).toBe("rank");
		expect(selection.selected.map(entry => entry.alias)).toEqual(["aaa"]);
	});

	test("applies the per-scope cap to a Jev answer list", async () => {
		const candidates = [
			candidate("aaa", "global", 3, "g1"),
			candidate("bbb", "global", 2, "g2"),
			candidate("ccc", "repo", 1, "r1"),
		];
		const selection = await selectRelevantLearnings({
			candidates,
			request: "x",
			cwd: "/repo",
			config: { ...CONFIG, maxInjectedPerScope: 1 },
			post: noulPost({ "rel::aaa": { noul: 0.9 }, "rel::bbb": { noul: 0.8 }, "rel::ccc": { noul: 0.7 } }),
		});
		expect(selection.selected.map(entry => entry.alias)).toEqual(["aaa", "ccc"]);
	});
});
