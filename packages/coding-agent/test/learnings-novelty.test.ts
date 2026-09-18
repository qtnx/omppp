import { describe, expect, test } from "bun:test";
import { JevError, postSystemOne } from "@oh-my-pi/pi-coding-agent/jev/systemone";
import {
	buildNoveltyRequest,
	checkLearningNovelty,
	type NoveltyCheckConfig,
} from "@oh-my-pi/pi-coding-agent/learnings/novelty";
import { type LearningEntry } from "@oh-my-pi/pi-coding-agent/learnings/storage";

function entry(alias: string, content: string, updatedAt = 100): LearningEntry {
	return {
		id: `learning-${alias}`,
		scope: "repo",
		cwd: "/repo",
		content,
		contentHash: `${alias}0123456789`,
		sourceMessageHash: "src",
		trigger: "guideline",
		confidence: 0.9,
		createdAt: updatedAt,
		updatedAt,
		status: "active",
		statusChangedAt: null,
		strength: 1,
		usefulCount: 0,
		notUsefulCount: 0,
		lastReinforcedAt: updatedAt,
		mergedInto: null,
		repoKey: "/repo",
		shownCount: 0,
		lastShownAt: null,
	};
}

const ALIAS_A = "aaaaaaaaaaaa";
const ALIAS_B = "bbbbbbbbbbbb";

const CONFIG: NoveltyCheckConfig = {
	enabled: true,
	reinforceThreshold: 0.6,
	timeoutMs: 4000,
	maxCandidates: 10,
	halfLifeDays: 45,
};

function post(answers: Record<string, unknown>): typeof postSystemOne {
	return (async () => ({ model: "jev-test", answers })) as typeof postSystemOne;
}

describe("buildNoveltyRequest", () => {
	test("sends the message, scope, cwd, and existing entries as state with a choice over aliases plus none", () => {
		const request = buildNoveltyRequest({
			model: "jev-test",
			userText: "never skip verification",
			scope: "repo",
			cwd: "/repo",
			existing: [entry(ALIAS_A, "keep verifying")],
			instructions: {
				duplicate: "Which existing learning covers this?",
				none: "Nothing covers it",
				noul: "Is this new?",
			},
		});
		expect(request.state).toEqual({
			message: "never skip verification",
			scope: "repo",
			cwd: "/repo",
			existing: [{ alias: ALIAS_A, content: "keep verifying" }],
		});
		expect(request.questions.duplicate_of).toEqual({
			type: "choice",
			instructions: "Which existing learning covers this?",
			criteria: { none: "Nothing covers it", [ALIAS_A]: "keep verifying" },
		});
		expect(request.questions.is_new).toEqual({ type: "noul", instructions: "Is this new?" });
	});
});

describe("checkLearningNovelty", () => {
	test("verdicts a confident duplicate and carries the target entry", async () => {
		const a = entry(ALIAS_A, "keep verifying");
		const verdict = await checkLearningNovelty({
			userText: "stop skipping verification",
			scope: "repo",
			cwd: "/repo",
			existing: [a, entry(ALIAS_B, "unrelated")],
			config: CONFIG,
			post: post({
				duplicate_of: {
					choice: ALIAS_A,
					confidence: 1,
					probabilities: { none: 0.1, [ALIAS_A]: 0.8, [ALIAS_B]: 0.1 },
				},
				is_new: { noul: 0.2 },
			}),
		});
		expect(verdict).toEqual({ kind: "duplicate", target: a, probability: 0.8, isNew: 0.2 });
	});

	test("verdicts new when the answer is none", async () => {
		const verdict = await checkLearningNovelty({
			userText: "always run the full suite",
			scope: "repo",
			cwd: "/repo",
			existing: [entry(ALIAS_A, "keep verifying")],
			config: CONFIG,
			post: post({
				duplicate_of: {
					choice: "none",
					confidence: 1,
					probabilities: { none: 0.95, [ALIAS_A]: 0.05 },
				},
				is_new: { noul: 0.9 },
			}),
		});
		expect(verdict).toEqual({ kind: "new", isNew: 0.9, noneProbability: 0.95 });
	});

	test("verdicts new when the duplicate probability is below the reinforce threshold", async () => {
		const verdict = await checkLearningNovelty({
			userText: "stop skipping verification",
			scope: "repo",
			cwd: "/repo",
			existing: [entry(ALIAS_A, "keep verifying")],
			config: CONFIG,
			post: post({
				duplicate_of: { choice: ALIAS_A, confidence: 0.9, probabilities: { none: 0.45, [ALIAS_A]: 0.55 } },
				is_new: { noul: 0.7 },
			}),
		});
		expect(verdict).toEqual({ kind: "new", isNew: 0.7, noneProbability: 0.45 });
	});

	test("falls through as unavailable when the request fails", async () => {
		const verdict = await checkLearningNovelty({
			userText: "x",
			scope: "repo",
			cwd: "/repo",
			existing: [entry(ALIAS_A, "keep verifying")],
			config: CONFIG,
			post: async () => {
				throw new JevError("boom", "connection");
			},
		});
		expect(verdict).toMatchObject({ kind: "unavailable" });
	});

	test("falls through as unavailable when disabled", async () => {
		const verdict = await checkLearningNovelty({
			userText: "x",
			scope: "repo",
			cwd: "/repo",
			existing: [entry(ALIAS_A, "keep verifying")],
			config: { ...CONFIG, enabled: false },
		});
		expect(verdict).toMatchObject({ kind: "unavailable" });
	});

	test("verdicts new when no existing entries exist", async () => {
		const verdict = await checkLearningNovelty({
			userText: "x",
			scope: "repo",
			cwd: "/repo",
			existing: [],
			config: CONFIG,
			post: post({}),
		});
		expect(verdict).toEqual({ kind: "new", isNew: 1, noneProbability: 1 });
	});
});
