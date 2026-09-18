import { describe, expect, test } from "bun:test";
import { TurnSignalService, TypeSafeClient } from "@oh-my-pi/pi-coding-agent/signals/index";
import { DuoHandoffTool } from "../handoff-tool";
import type { DuoExecutionScope } from "../state";

interface JudgedHandoff {
	scope: "single" | "multi";
	scopeConfidence: number;
	planLocked: number;
}

/** Fake System One responder for the handoff question set, counting calls. */
function handoffService(judgment: JudgedHandoff, onCall?: () => void): TurnSignalService {
	const client = new TypeSafeClient({
		apiKey: "k",
		fetch: (async (_url: string | URL | Request, _init?: RequestInit) => {
			onCall?.();
			return Response.json({
				model: "jev",
				answers: {
					scope: {
						type: "choice",
						choice: judgment.scope,
						probabilities: { [judgment.scope]: judgment.scopeConfidence },
						confidence: judgment.scopeConfidence,
					},
					plan_locked: { type: "noul", noul: judgment.planLocked },
				},
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}) as typeof fetch,
	});
	return new TurnSignalService(client);
}

function recordingTool(turnSignals?: TurnSignalService): {
	calls: Array<DuoExecutionScope | undefined>;
	tool: DuoHandoffTool;
} {
	const calls: Array<DuoExecutionScope | undefined> = [];
	const tool = new DuoHandoffTool(async (_resolution, scope) => {
		calls.push(scope);
		return "ok";
	}, turnSignals);
	return { calls, tool };
}

describe("DuoHandoffTool scope classification", () => {
	test("hands off as multi when the classifier judges multi with high confidence", async () => {
		const { calls, tool } = recordingTool(handoffService({ scope: "multi", scopeConfidence: 0.9, planLocked: 0.8 }));

		await tool.execute("1", { to: "executor", resolution: "brief" });

		expect(calls).toEqual(["multi"]);
	});

	test("keeps the single default when multi confidence is below the threshold", async () => {
		const { calls, tool } = recordingTool(handoffService({ scope: "multi", scopeConfidence: 0.5, planLocked: 0.8 }));

		await tool.execute("1", { to: "executor", resolution: "brief" });

		expect(calls).toEqual([undefined]);
	});

	test("never classifies when the caller passes an explicit scope", async () => {
		let classifications = 0;
		const { calls, tool } = recordingTool(
			handoffService({ scope: "multi", scopeConfidence: 0.9, planLocked: 0.8 }, () => {
				classifications += 1;
			}),
		);

		await tool.execute("1", { to: "executor", resolution: "brief", scope: "single" });

		expect(calls).toEqual(["single"]);
		expect(classifications).toBe(0);
	});

	test("appends the unlocked-brief note without blocking the handoff", async () => {
		const { calls, tool } = recordingTool(handoffService({ scope: "single", scopeConfidence: 0.4, planLocked: 0.1 }));

		const result = await tool.execute("1", { to: "executor", resolution: "brief" });

		expect(calls).toEqual([undefined]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("reads unlocked"),
		});
	});
});
