import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AdvisorConsultResult } from "../../advisor";
import { ConsultTool } from "../consult";
import type { ToolSession } from "../index";

function createToolSession(result?: AdvisorConsultResult): ToolSession {
	return {
		consultAdvisor: async () =>
			result ?? { status: "answered", answer: "blocking-answer", attempts: [{ attempt: 1 }] },
		consultAdvisorAsync: () => true,
	} as unknown as ToolSession;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map(c => c.text ?? "").join("\n");
}

describe("ConsultTool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dispatches async consults without waiting for an advisor answer", async () => {
		const session = createToolSession();
		const blocking = vi.spyOn(session, "consultAdvisor");
		const asyncConsult = vi.spyOn(session, "consultAdvisorAsync");
		const tool = new ConsultTool(session);

		const result = await tool.execute("tc-1", { question: "background?", async: true });

		expect(asyncConsult).toHaveBeenCalledWith("background?");
		expect(blocking).not.toHaveBeenCalled();
		expect(result.useless).toBeUndefined();
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Question dispatched to the advisor asynchronously — it will reply through an advisory note when ready. Keep working; do not block on it.",
			},
		]);
	});

	it("keeps omitted async on the existing blocking consult path", async () => {
		const session = createToolSession();
		const blocking = vi.spyOn(session, "consultAdvisor");
		const asyncConsult = vi.spyOn(session, "consultAdvisorAsync");
		const tool = new ConsultTool(session);

		const result = await tool.execute("tc-2", { question: "gate?" });

		expect(blocking).toHaveBeenCalledWith("gate?", undefined);
		expect(asyncConsult).not.toHaveBeenCalled();
		expect(result.content).toEqual([{ type: "text", text: "blocking-answer" }]);
		expect(result.useless).toBeUndefined();
	});

	it("returns only the answer when answered on the first attempt", async () => {
		const tool = new ConsultTool(
			createToolSession({ status: "answered", answer: "the advice", attempts: [{ attempt: 1 }] }),
		);
		const result = await tool.execute("tc-3", { question: "q" });
		expect(result.content).toEqual([{ type: "text", text: "the advice" }]);
		expect(result.useless).toBeUndefined();
	});

	it("reports failed attempts before the answer when answered after retries", async () => {
		const tool = new ConsultTool(
			createToolSession({
				status: "answered",
				answer: "final advice",
				attempts: [{ attempt: 1, error: "socket hang up" }, { attempt: 2, error: "503 upstream" }, { attempt: 3 }],
			}),
		);
		const result = await tool.execute("tc-4", { question: "q" });
		const text = textOf(result);
		expect(text).toContain("answered after 3 attempts (2 failed)");
		expect(text).toContain("attempt 1: socket hang up");
		expect(text).toContain("attempt 2: 503 upstream");
		expect(text.endsWith("final advice")).toBe(true);
		expect(result.useless).toBeUndefined();
	});

	const failureCases: { name: string; result: AdvisorConsultResult; expects: string[]; forbids?: string[] }[] = [
		{
			name: "unavailable",
			result: { status: "unavailable", attempts: [] },
			expects: ["unavailable", "Enable/configure the advisor", "No advisor prompt attempt was made."],
		},
		{
			name: "paused",
			result: { status: "paused", attempts: [] },
			expects: ["paused", "Resume or reset the advisor"],
		},
		{
			name: "disposed",
			result: { status: "disposed", attempts: [] },
			expects: ["disposed", "Start or rebuild the advisor session"],
		},
		{
			name: "aborted",
			result: { status: "aborted", attempts: [{ attempt: 1, error: "aborted mid-flight" }] },
			expects: ["aborted", "will not be retried automatically", "attempt 1: aborted mid-flight"],
		},
		{
			name: "timed_out",
			result: { status: "timed_out", attempts: [{ attempt: 1 }], elapsedMs: 300_000, timeoutMs: 300_000 },
			expects: ["timed out after 300s", "ceiling 300s", "1 attempt made."],
		},
		{
			name: "queue_cleared",
			result: { status: "queue_cleared", attempts: [], reason: "advisor model changed" },
			expects: ["queue was cleared (advisor model changed)", "Retry after the advisor lifecycle action"],
		},
		{
			name: "rate_limited",
			result: {
				status: "rate_limited",
				attempts: [{ attempt: 1, error: "429 rate limit exceeded" }],
				error: "429 rate limit exceeded",
				requeued: true,
			},
			expects: ["Advisor rate-limited, requeued", "429 rate limit exceeded", "attempt 1: 429 rate limit exceeded"],
			forbids: ["timed out", "did not answer in time"],
		},
		{
			name: "provider_error retryable",
			result: {
				status: "provider_error",
				attempts: [
					{ attempt: 1, error: "boom" },
					{ attempt: 2, error: "boom" },
					{ attempt: 3, error: "boom" },
				],
				error: "boom",
				retryable: true,
			},
			expects: ["provider error: boom", "Retry later.", "3 attempts made, 3 failed:", "attempt 3: boom"],
		},
		{
			name: "provider_error non-retryable",
			result: {
				status: "provider_error",
				attempts: [{ attempt: 1, error: "invalid api key" }],
				error: "invalid api key",
				retryable: false,
			},
			expects: ["provider error: invalid api key", "Fix the advisor provider/model configuration"],
		},
		{
			name: "empty_response",
			result: { status: "empty_response", attempts: [{ attempt: 1 }] },
			expects: ["no text", "Retry once or proceed"],
		},
	];

	for (const tc of failureCases) {
		it(`formats an actionable useless result for ${tc.name}`, async () => {
			const tool = new ConsultTool(createToolSession(tc.result));
			const result = await tool.execute("tc-f", { question: "q" });
			const text = textOf(result);
			for (const expected of tc.expects) expect(text).toContain(expected);
			for (const forbidden of tc.forbids ?? []) expect(text).not.toContain(forbidden);
			expect(result.useless).toBe(true);
		});
	}

	it("reports advisor inactive when consultAdvisor is absent", async () => {
		const tool = new ConsultTool({} as unknown as ToolSession);
		const result = await tool.execute("tc-5", { question: "q" });
		expect(textOf(result)).toContain("Advisor is not active in this session.");
		expect(result.useless).toBe(true);
	});
});
