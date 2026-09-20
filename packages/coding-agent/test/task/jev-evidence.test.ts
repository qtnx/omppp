import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type JevRequest, type JevResponse } from "@oh-my-pi/pi-coding-agent/jev/systemone";
import { assessResultEvidence } from "@oh-my-pi/pi-coding-agent/task/jev-evidence";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

const endpoint = Bun.env.TYPESAFE_SYSTEMONE_URL;

function settledResult(): SingleResult {
	return {
		index: 0,
		id: "child-1",
		agent: "task",
		agentSource: "bundled",
		task: "verify",
		exitCode: 0,
		output: "Acceptance: bun test ... -> 2 pass",
		stderr: "",
		truncated: false,
		durationMs: 100,
		tokens: 1,
		requests: 1,
		outputPath: "/tmp/child-1.md",
		outputMeta: { lineCount: 1, charCount: 38 },
	};
}

beforeEach(() => {
	Bun.env.TYPESAFE_SYSTEMONE_URL = "http://evidence.test/v1/systemone";
});

afterEach(() => {
	if (endpoint === undefined) delete Bun.env.TYPESAFE_SYSTEMONE_URL;
	else Bun.env.TYPESAFE_SYSTEMONE_URL = endpoint;
});

describe("assessResultEvidence", () => {
	it("classifies both sides of the acceptance threshold", async () => {
		const post = async (): Promise<JevResponse> => ({
			answers: { "evidence::acceptance": { type: "noul", noul: 0.8 } },
		});
		const strong = await assessResultEvidence({ assignment: "Acceptance: check", output: "check -> pass", post });
		expect(strong).toEqual({ evidence: "strong", noul: 0.8 });

		const weak = await assessResultEvidence({
			assignment: "Acceptance: check",
			output: "tests pass",
			post: async () => ({ answers: { "evidence::acceptance": { type: "noul", noul: 0.49 } } }),
		});
		expect(weak).toEqual({ evidence: "weak", noul: 0.49 });
	});

	it("sends bounded assignment and output state", async () => {
		let state: unknown;
		const post = async (body: JevRequest): Promise<JevResponse> => {
			state = body.state;
			return { answers: { "evidence::acceptance": { type: "noul", noul: 0.5 } } };
		};
		await assessResultEvidence({ assignment: "a".repeat(4_100), output: "o".repeat(8_100), post });
		expect(state).toEqual({ assignment: "a".repeat(4_000), output: "o".repeat(8_000) });
	});
});

describe("task result evidence rendering", () => {
	it("renders weak evidence warning only when evidence is weak", () => {
		const weak = formatTaskResultSummary(settledResult(), { totalDurationMs: 100, evidence: "weak" });
		const strong = formatTaskResultSummary(settledResult(), { totalDurationMs: 100, evidence: "strong" });
		expect(weak).toContain("evidence: weak — re-run its Acceptance check before accepting");
		expect(strong).not.toContain("evidence:");
	});
});
