import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TurnSignalService, TypeSafeClient } from "@oh-my-pi/pi-coding-agent/signals/index";
import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost } from "../../src/advisor";

/** System One answer payload with a caller-chosen `needs_review` score. */
function turnAnswers(needsReview: number): Record<string, unknown> {
	return {
		model: "jev-1.13.0",
		answers: {
			phase: {
				type: "choice",
				choice: "debugging",
				probabilities: { debugging: 0.8, verifying: 0.2 },
				confidence: 0.76,
			},
			needs_review: { type: "noul", noul: needsReview },
			progress: {
				type: "score",
				score: 1.4,
				legend: { "0": "Advancing", "1": "Churning", "2": "Stuck" },
				probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
				confidence: 0.5,
			},
			done_without_evidence: { type: "noul", noul: 0.05 },
			parallel_slices: { type: "noul", noul: 0.1 },
		},
		usage: { input_tokens: 812, output_tokens: 40 },
	};
}

/**
 * Classifier backed by a fake System One endpoint: one score for every call,
 * a per-call score sequence, or an HTTP failure. `sent` captures request bodies.
 */
function classifier(needsReview: number | number[] | "error", sent?: Record<string, unknown>[]): TurnSignalService {
	let call = 0;
	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		if (sent) sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		if (needsReview === "error") return new Response("boom", { status: 503 });
		const score = Array.isArray(needsReview) ? needsReview[Math.min(call++, needsReview.length - 1)] : needsReview;
		return new Response(JSON.stringify(turnAnswers(score)), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return new TurnSignalService(new TypeSafeClient({ apiKey: "k", fetch: fetchImpl }));
}

function promptText(input: string | AgentMessage[]): string {
	if (typeof input === "string") return input;
	return input
		.map(message => {
			if (!("content" in message)) return String(message);
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			}
			return String(message);
		})
		.join("\n");
}

async function settle(): Promise<void> {
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

interface Harness {
	runtime: AdvisorRuntime;
	messages: AgentMessage[];
	prompts: string[];
	seen: { needsReview: number }[];
	/** Append one primary turn and end it, mid-turn unless `willContinue` is false. */
	turn: (text: string, willContinue: boolean) => Promise<void>;
}

function createHarness(options: {
	service?: TurnSignalService;
	gateEnabled?: boolean;
	duoWorkPhase?: string;
}): Harness {
	const messages: AgentMessage[] = [];
	const prompts: string[] = [];
	const seen: { needsReview: number }[] = [];
	const agent: AdvisorAgent = {
		prompt: async input => {
			prompts.push(promptText(input));
		},
		abort: () => {},
		reset: () => {},
		state: { messages: [] },
	};
	const host: AdvisorRuntimeHost = {
		snapshotMessages: () => messages,
		enqueueAdvice: () => {},
		advisorGate: () => ({ enabled: options.gateEnabled ?? true, reviewThreshold: 0.5 }),
		...(options.service
			? {
					turnSignals: options.service,
					duoWorkPhase: () => options.duoWorkPhase,
					onTurnSignals: signals => {
						seen.push({ needsReview: signals.needsReview });
					},
				}
			: {}),
	};
	const runtime = new AdvisorRuntime(agent, host);
	return {
		runtime,
		messages,
		prompts,
		seen,
		turn: async (text, willContinue) => {
			messages.push({ role: "user", content: text, timestamp: messages.length + 1 } as AgentMessage);
			runtime.onTurnEnd(messages, { willContinue });
			await settle();
		},
	};
}

describe("advisor turn-signal gate", () => {
	it("defers low-score deltas whether in-progress or terminal, then flushes them with the next advisor-worthy turn", async () => {
		const harness = createHarness({ service: classifier([0.2, 0.2, 0.9]) });

		await harness.turn("in-progress marker alpha", true);
		expect(harness.prompts).toHaveLength(0);
		// A deferred turn is settled for backlog accounting: a primary blocking on
		// advisor catch-up must not park on work the advisor deliberately skipped.
		expect(await harness.runtime.waitForCatchup(50, 1)).toBe(true);

		// A yielded chit-chat turn is just as skippable as a mid-task read.
		await harness.turn("terminal chit-chat beta", false);
		expect(harness.prompts).toHaveLength(0);

		await harness.turn("terminal completion claim gamma", false);
		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toContain("in-progress marker alpha");
		expect(harness.prompts[0]).toContain("terminal chit-chat beta");
		expect(harness.prompts[0]).toContain("terminal completion claim gamma");
	});

	it("prompts immediately when the classifier yields no signal", async () => {
		const harness = createHarness({ service: classifier("error") });

		await harness.turn("unclassifiable marker", true);

		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toContain("unclassifiable marker");
	});

	it("keeps deferring low-score turns without a count cap until the classifier asks for the advisor", async () => {
		const harness = createHarness({ service: classifier([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.7]) });

		for (let index = 1; index <= 6; index++) await harness.turn(`quiet marker ${index}`, true);
		expect(harness.prompts).toHaveLength(0);

		await harness.turn("advisor-worthy marker", false);
		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toContain("quiet marker 1");
		expect(harness.prompts[0]).toContain("quiet marker 6");
		expect(harness.prompts[0]).toContain("advisor-worthy marker");
	});

	it("hands every resolved classification to the host", async () => {
		const harness = createHarness({ service: classifier(0.2) });

		await harness.turn("first classified turn", true);
		await harness.turn("second classified turn", false);

		expect(harness.seen).toHaveLength(2);
		expect(harness.seen.map(entry => entry.needsReview)).toEqual([0.2, 0.2]);
	});

	it("reviews every turn when the gate is disabled", async () => {
		const harness = createHarness({ service: classifier(0.2), gateEnabled: false });

		await harness.turn("marker with gate off", true);

		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toContain("marker with gate off");
	});
	it("sends the live duo work phase with the classified turn", async () => {
		const sent: Record<string, unknown>[] = [];
		const harness = createHarness({
			service: classifier(0.9, sent),
			duoWorkPhase: "preplanning",
		});

		await harness.turn("opening brainstorm", true);

		expect(sent).toHaveLength(1);
		expect((sent[0]?.state as Record<string, unknown>).duo_phase).toBe("preplanning");
	});

	it("omits the duo phase when the session is not in duo", async () => {
		const sent: Record<string, unknown>[] = [];
		const harness = createHarness({ service: classifier(0.9, sent) });

		await harness.turn("plain turn", true);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.state as Record<string, unknown>).not.toHaveProperty("duo_phase");
	});
});
