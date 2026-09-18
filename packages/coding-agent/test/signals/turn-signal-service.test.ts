import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTurnSignalService, TurnSignalService, TypeSafeClient } from "@oh-my-pi/pi-coding-agent/signals/index";

function fakeFetch(handler: (body: Record<string, unknown>) => Response | Promise<Response>): typeof fetch {
	return (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return handler(body);
	}) as typeof fetch;
}

const TURN_ANSWERS = {
	model: "jev-1.13.0",
	answers: {
		phase: {
			type: "choice",
			choice: "debugging",
			probabilities: { debugging: 0.8, verifying: 0.2 },
			confidence: 0.76,
		},
		needs_review: { type: "noul", noul: 0.21 },
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

describe("TurnSignalService", () => {
	test("maps a System One response into typed turn signals and remembers the latest", async () => {
		let sent: Record<string, unknown> | undefined;
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(body => {
				sent = body;
				return Response.json(TURN_ANSWERS);
			}),
		});
		const service = new TurnSignalService(client);

		const signals = await service.classifyTurn("### Session update\n- ran tests: 2 fail", {
			wip: true,
			duoPhase: "executing",
		});

		expect(signals).toEqual({
			phase: "debugging",
			phaseConfidence: 0.76,
			needsReview: 0.21,
			stuck: 0.7,
			doneWithoutEvidence: 0.05,
			parallelSlices: 0.1,
			model: "jev-1.13.0",
			inputTokens: 812,
		});
		expect(service.latest).toBe(signals);
		expect(sent?.model).toBe("jev-latest");
		const state = sent?.state as Record<string, string>;
		expect(state.duo_phase).toBe("executing");
		expect(state.turn_status).toContain("in progress");
		expect(Object.keys(sent?.questions as object).sort()).toEqual([
			"done_without_evidence",
			"needs_review",
			"parallel_slices",
			"phase",
			"progress",
		]);
	});

	test("clips oversized state to its tail", async () => {
		let sent: Record<string, unknown> | undefined;
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(body => {
				sent = body;
				return Response.json(TURN_ANSWERS);
			}),
		});
		const service = new TurnSignalService(client, { maxStateChars: 10 });
		await service.classifyTurn("0123456789ABCDEFGHIJ", { wip: false });
		expect((sent?.state as Record<string, string> | undefined)?.transcript).toBe("ABCDEFGHIJ");
	});

	test("authenticates only when a key is configured", async () => {
		const seen: Array<Record<string, string>> = [];
		const capture = (async (_url: string | URL | Request, init?: RequestInit) => {
			seen.push(init?.headers as Record<string, string>);
			return Response.json(TURN_ANSWERS);
		}) as unknown as typeof fetch;
		await new TurnSignalService(new TypeSafeClient({ fetch: capture })).classifyTurn("x", { wip: true });
		await new TurnSignalService(new TypeSafeClient({ apiKey: "k", fetch: capture })).classifyTurn("x", {
			wip: true,
		});
		expect(seen[0]?.Authorization).toBeUndefined();
		expect(seen[1]?.Authorization).toBe("Bearer k");
		expect(seen[0]?.["Content-Type"]).toBe("application/json");
	});

	test("gives up after three consecutive failures and resumes the budget on success", async () => {
		let calls = 0;
		const scripted = (async () => {
			calls += 1;
			return calls === 3 ? Response.json(TURN_ANSWERS) : new Response("nope", { status: 503 });
		}) as unknown as typeof fetch;
		const service = new TurnSignalService(new TypeSafeClient({ fetch: scripted }));

		for (let i = 0; i < 6; i++) await service.classifyTurn("x", { wip: true });
		expect(calls).toBe(6);
		expect(service.latest).toBeDefined();

		expect(await service.classifyTurn("x", { wip: true })).toBeUndefined();
		expect(calls).toBe(6);
		expect(service.connected).toBe(false);
	});

	test("fails open on HTTP errors, malformed bodies, and unknown phases", async () => {
		const cases: Array<() => Response> = [
			() => new Response("nope", { status: 429 }),
			() => Response.json({ model: "jev", answers: "x" }),
			() =>
				Response.json({
					...TURN_ANSWERS,
					answers: { ...TURN_ANSWERS.answers, phase: { ...TURN_ANSWERS.answers.phase, choice: "dancing" } },
				}),
		];
		for (const make of cases) {
			const service = new TurnSignalService(new TypeSafeClient({ apiKey: "k", fetch: fakeFetch(() => make()) }));
			expect(await service.classifyTurn("x", { wip: true })).toBeUndefined();
			expect(service.latest).toBeUndefined();
		}
	});

	test("times out into undefined instead of throwing", async () => {
		const client = new TypeSafeClient({
			apiKey: "k",
			timeoutMs: 20,
			fetch: ((_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				})) as typeof fetch,
		});
		expect(await new TurnSignalService(client).classifyTurn("x", { wip: true })).toBeUndefined();
	});

	test("classifyHandoff and classifyLearning map their answers", async () => {
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(body => {
				const questions = body.questions as Record<string, unknown>;
				if ("scope" in questions) {
					return Response.json({
						model: "jev",
						answers: {
							scope: {
								type: "choice",
								choice: "multi",
								probabilities: { single: 0.2, multi: 0.8 },
								confidence: 0.7,
							},
							plan_locked: { type: "noul", noul: 0.9 },
						},
						usage: { input_tokens: 1, output_tokens: 1 },
					});
				}
				return Response.json({
					model: "jev",
					answers: { generic_rule: { type: "noul", noul: 0.3 } },
					usage: { input_tokens: 1, output_tokens: 1 },
				});
			}),
		});
		const service = new TurnSignalService(client);
		expect(await service.classifyHandoff("plan")).toEqual({ scope: "multi", scopeConfidence: 0.7, planLocked: 0.9 });
		expect(await service.classifyLearning("rule")).toEqual({ genericRule: 0.3 });
	});
});

describe("createTurnSignalService", () => {
	async function settingsWith(overrides: Record<string, unknown>): Promise<Settings> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-signals-"));
		return Settings.loadReadOnly({ agentDir: path.join(dir, "agent"), cwd: dir, overrides });
	}

	test("builds without a key against an endpoint, and needs one when the endpoint is empty", async () => {
		const previous = Bun.env.TYPESAFE_API_KEY;
		delete Bun.env.TYPESAFE_API_KEY;
		try {
			expect(createTurnSignalService(await settingsWith({ "signals.enabled": false }))).toBeUndefined();
			// Default endpoint is the tailnet proxy, which authenticates upstream itself.
			expect(createTurnSignalService(await settingsWith({}))).toBeInstanceOf(TurnSignalService);
			// No endpoint and no key: nothing to call.
			expect(createTurnSignalService(await settingsWith({ "signals.baseUrl": "" }))).toBeUndefined();
			expect(
				createTurnSignalService(await settingsWith({ "signals.baseUrl": "", "signals.apiKey": "k" })),
			).toBeInstanceOf(TurnSignalService);
			expect(
				createTurnSignalService(await settingsWith({ "signals.apiKey": "k", "signals.model": "jev-1.13.0" })),
			).toBeInstanceOf(TurnSignalService);
		} finally {
			if (previous !== undefined) Bun.env.TYPESAFE_API_KEY = previous;
		}
	});
});
