import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { JevError, type JevRequest, type JevResponse } from "@oh-my-pi/pi-coding-agent/jev/systemone";
import { triageChildQuestion, type TriageKind } from "@oh-my-pi/pi-coding-agent/task/jev-triage";

const endpoint = Bun.env.TYPESAFE_SYSTEMONE_URL;

function answer(kind: TriageKind, confidence: number) {
	const probabilities: Record<string, number> = {
		"fact-in-repo": 0,
		"already-in-brief": 0,
		decision: 0,
		"user-only": 0,
		status: 0,
	};
	probabilities[kind] = 1;
	return { type: "choice", choice: kind, confidence, probabilities };
}

beforeEach(() => {
	Bun.env.TYPESAFE_SYSTEMONE_URL = "http://triage.test/v1/systemone";
});

afterEach(() => {
	if (endpoint === undefined) delete Bun.env.TYPESAFE_SYSTEMONE_URL;
	else Bun.env.TYPESAFE_SYSTEMONE_URL = endpoint;
});

describe("triageChildQuestion", () => {
	it("maps each triage kind when confidence is sufficient", async () => {
		const kinds: TriageKind[] = ["fact-in-repo", "already-in-brief", "decision", "user-only", "status"];
		for (const kind of kinds) {
			const post = async (body: JevRequest): Promise<JevResponse> => ({
				answers: { "triage::kind": answer(kind, 0.9) },
				model: body.model,
			});
			expect(await triageChildQuestion({ message: `question ${kind}`, post })).toEqual({ kind, confidence: 0.9 });
		}
	});

	it("drops low-confidence classifications", async () => {
		const post = async (): Promise<JevResponse> => ({
			answers: { "triage::kind": answer("decision", 0.49) },
		});
		expect(await triageChildQuestion({ message: "uncertain", post })).toBeUndefined();
	});

	it("falls back when Jev reports an error", async () => {
		const post = async (): Promise<JevResponse> => {
			throw new JevError("offline", "connection");
		};
		expect(await triageChildQuestion({ message: "question", post })).toBeUndefined();
	});
});
