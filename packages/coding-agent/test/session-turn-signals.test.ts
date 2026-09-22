import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnSignalService, TypeSafeClient } from "@oh-my-pi/pi-coding-agent/signals/index";
import type { TurnSignals } from "@oh-my-pi/pi-coding-agent/signals/types";
import { AdvisorRuntime, type AdvisorAgent, type AdvisorRuntimeHost } from "../src/advisor/runtime";
import { SessionAdvisors, type SessionAdvisorsHost } from "../src/session/session-advisors";
import { formatRoutingHistory } from "../src/session/session-history-format";

function turnResponse(): Record<string, unknown> {
	return {
		model: "jev-1.13.0",
		answers: {
			phase: {
				type: "choice",
				choice: "debugging",
				probabilities: { debugging: 0.9, verifying: 0.1 },
				confidence: 0.9,
			},
			needs_review: { type: "noul", noul: 0.9 },
			progress: {
				type: "score",
				score: 2,
				legend: { "0": "Advancing", "1": "Churning", "2": "Stuck" },
				probabilities: { "0": 0.05, "1": 0.05, "2": 0.9 },
				confidence: 0.9,
			},
			done_without_evidence: { type: "noul", noul: 0.1 },
			parallel_slices: { type: "noul", noul: 0.1 },
			difficulty: {
				type: "choice",
				choice: "hard",
				probabilities: { hard: 0.9, moderate: 0.1 },
				confidence: 0.9,
			},
			thinking: {
				type: "choice",
				choice: "high",
				probabilities: { high: 0.9, medium: 0.1 },
				confidence: 0.9,
			},
			risk_domain: { type: "noul", noul: 0 },
		},
		usage: { input_tokens: 42, output_tokens: 7 },
	};
}

function serviceWithFetch(handler: (body: Record<string, unknown>) => Response): {
	service: TurnSignalService;
	calls: Record<string, unknown>[];
} {
	const calls: Record<string, unknown>[] = [];
	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		calls.push(body);
		return handler(body);
	}) as typeof fetch;
	return {
		service: new TurnSignalService(new TypeSafeClient({ apiKey: "test", fetch: fetchImpl })),
		calls,
	};
}

function primaryMessages(suffix: string): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "text", text: `earlier unrelated context ${"x".repeat(4000)}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1,
		} as AssistantMessage,
		{
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${suffix}`, name: "bash", arguments: { command: suffix } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
		} as AssistantMessage,
		{
			role: "toolResult",
			toolCallId: `call-${suffix}`,
			toolName: "bash",
			content: [{ type: "text", text: `latest tool failure ${suffix}` }],
			isError: true,
			timestamp: 3,
		} as AgentMessage,
	];
}

function sessionHost(
	settings: Settings,
	options: { duoPhase?: "executing"; autoThinking?: boolean } = {},
): SessionAdvisorsHost {
	return {
		settings,
		duoStatus: () =>
			options.duoPhase ? { phase: options.duoPhase, takeoverCount: 0, advisorPaused: false } : undefined,
		isAutoThinking: () => options.autoThinking === true,
	} as unknown as SessionAdvisorsHost;
}

const resolvedSignals: TurnSignals = {
	phase: "debugging",
	phaseConfidence: 0.9,
	needsReview: 0.9,
	stuck: 1,
	doneWithoutEvidence: 0.1,
	parallelSlices: 0.1,
	model: "jev",
	inputTokens: 1,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("primary turn signal lifecycle", () => {
	it("classifies recent conversation plus latest tools once, waits without advisors, and forwards routing", async () => {
		const { service, calls } = serviceWithFetch(() => Response.json(turnResponse()));
		const delivered: TurnSignals[] = [];
		let methodResolved = true;
		const advisors = new SessionAdvisors(
			sessionHost(Settings.isolated({ "advisor.syncBacklog": "off" }), { duoPhase: "executing" }),
			{
				enabled: false,
				turnSignals: service,
				onTurnSignals: signals => {
					expect(methodResolved).toBe(false);
					delivered.push(signals);
				},
			},
		);

		methodResolved = false;
		await advisors.onPrimaryTurnEnd(primaryMessages("first"), false);
		methodResolved = true;
		expect(delivered).toHaveLength(1);
		expect(calls).toHaveLength(1);
		const firstState = calls[0]?.state as Record<string, unknown>;
		expect(firstState.transcript).toContain("latest tool failure first");
		expect(firstState.transcript).toContain("earlier unrelated context");
		expect(delivered[0]?.routing).toEqual({
			difficulty: "hard",
			difficultyConfidence: 0.9,
			thinking: "high",
			risk: 0,
		});

		// Running tool steps without advisors are sampled by time, not per step:
		// the first starts the clock, later ones spend a request once 15s passed.
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		await advisors.onPrimaryTurnEnd(primaryMessages("continuing 1"), true);
		now += 5_000;
		await advisors.onPrimaryTurnEnd(primaryMessages("continuing 2"), true);
		expect(calls).toHaveLength(1);
		now += 10_000;
		methodResolved = false;
		await advisors.onPrimaryTurnEnd(primaryMessages("continuing 3"), true);
		methodResolved = true;
		expect(calls).toHaveLength(2);
		expect(delivered).toHaveLength(2);
		now += 1_000;
		await advisors.onPrimaryTurnEnd(primaryMessages("continuing 4"), true);
		expect(calls).toHaveLength(2);
	});

	it("samples running steps for auto thinking without duo, but not terminal boundaries", async () => {
		const { service, calls } = serviceWithFetch(() => Response.json(turnResponse()));
		const delivered: TurnSignals[] = [];
		const advisors = new SessionAdvisors(
			sessionHost(Settings.isolated({ "advisor.syncBacklog": "off" }), { autoThinking: true }),
			{ enabled: false, turnSignals: service, onTurnSignals: signals => delivered.push(signals) },
		);
		let now = 2_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await advisors.onPrimaryTurnEnd(primaryMessages("running 1"), true);
		now += 20_000;
		await advisors.onPrimaryTurnEnd(primaryMessages("running 2"), true);
		expect(calls).toHaveLength(1);
		expect(delivered[0]?.routing?.thinking).toBe("high");

		// The next prompt re-judges effort itself, so the terminal boundary is free
		// and restarts the clock for the next run.
		await advisors.onPrimaryTurnEnd(primaryMessages("terminal"), false);
		now += 60_000;
		await advisors.onPrimaryTurnEnd(primaryMessages("next run 1"), true);
		expect(calls).toHaveLength(1);
	});

	it("spends no request when neither a live duo nor an advisor consumes the classification", async () => {
		const { service, calls } = serviceWithFetch(() => Response.json(turnResponse()));
		const delivered: TurnSignals[] = [];
		const advisors = new SessionAdvisors(sessionHost(Settings.isolated({ "advisor.syncBacklog": "off" })), {
			enabled: false,
			turnSignals: service,
			onTurnSignals: signals => delivered.push(signals),
		});

		await advisors.onPrimaryTurnEnd(primaryMessages("terminal"), false);
		await advisors.onPrimaryTurnEnd(primaryMessages("continuing"), true);
		expect(calls).toHaveLength(0);
		expect(delivered).toHaveLength(0);
	});

	it("retains short follow-ups with preceding user decisions, assistant findings, and tool failures", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "Investigate the cross-service race; do not apply another guess.", timestamp: 1 },
			...primaryMessages("second failed attempt"),
			{ role: "user", content: "Continue", timestamp: 4 },
		];
		const history = formatRoutingHistory(messages);
		expect(history).toContain("cross-service race");
		expect(history).toContain("earlier unrelated context");
		expect(history).toContain("second failed attempt");
		expect(history).toContain("Continue");
	});

	it("bounds recent history and excludes old conversation and injected developer instructions", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "obsolete topic", timestamp: 0 },
			...Array.from({ length: 8 }, (_, index): AgentMessage => ({
				role: "user",
				content: `recent message ${index}`,
				timestamp: index + 2,
			})),
			{ role: "developer", content: "private instructions", timestamp: 1 },
		];
		const history = formatRoutingHistory(messages);
		expect(history).not.toContain("obsolete topic");
		expect(history).not.toContain("private instructions");
		expect(history).toContain("recent message 0");
		expect(history).toContain("recent message 7");
	});

	it("fails open on endpoint errors without invoking the callback", async () => {
		const { service, calls } = serviceWithFetch(() => new Response("boom", { status: 503 }));
		const delivered: TurnSignals[] = [];
		const advisors = new SessionAdvisors(
			sessionHost(Settings.isolated({ "advisor.syncBacklog": "off" }), { duoPhase: "executing" }),
			{
				enabled: false,
				turnSignals: service,
				onTurnSignals: signals => delivered.push(signals),
			},
		);

		await expect(advisors.onPrimaryTurnEnd(primaryMessages("error"), false)).resolves.toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(delivered).toHaveLength(0);
	});

	it("does not classify again when runtime receives a shared promise", async () => {
		let classifications = 0;
		const { service } = serviceWithFetch(() => {
			classifications++;
			return Response.json(turnResponse());
		});
		const messages = primaryMessages("shared");
		const agent: AdvisorAgent = {
			prompt: async () => {},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages,
			turnSignals: service,
			onTurnSignals: () => {
				throw new Error("shared promise must own callback");
			},
		};
		const runtime = new AdvisorRuntime(agent, host);
		runtime.onTurnEnd(messages, { signals: Promise.resolve(resolvedSignals) });
		await runtime.waitForCatchup(1000, 1);
		expect(classifications).toBe(0);
	});
});
