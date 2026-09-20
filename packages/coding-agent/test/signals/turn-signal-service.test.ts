import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTurnSignalService, TurnSignalService, TypeSafeClient } from "@oh-my-pi/pi-coding-agent/signals/index";
import type { StopAssessmentInput } from "../../src/signals/types";

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
		difficulty: {
			type: "choice",
			choice: "hard",
			probabilities: { easy: 0.05, moderate: 0.1, hard: 0.8, extreme: 0.05 },
			confidence: 0.8,
		},
		thinking: {
			type: "choice",
			choice: "high",
			probabilities: { medium: 0.1, high: 0.8, xhigh: 0.1 },
			confidence: 0.8,
		},
		risk_domain: { type: "noul", noul: 0.21 },
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

const TRIM_ANSWERS = {
	model: "jev-1.13.0",
	answers: {
		action: {
			type: "choice",
			choice: "shake",
			probabilities: { shake: 0.72, compact: 0.2, nothing: 0.08 },
			confidence: 0.81,
		},
		handoff_sufficient: { type: "noul", noul: 0.66 },
		"keep:rec-1": { type: "noul", noul: 0.04 },
		"keep:rec-2": { type: "noul", noul: 0.91 },
	},
	usage: { input_tokens: 900, output_tokens: 30 },
};

const TRIM_INPUT = {
	upcomingRequest: "Run the migration and verify the ledger balances",
	sessionDigest: "Title: ledger work",
	contextTokens: 120_000,
	candidates: [
		{ id: "rec-1", kind: "tool_result", ageTurns: 6, tokens: 40_000, summary: "old pytest output" },
		{ id: "rec-2", kind: "file_read", ageTurns: 1, tokens: 9_000, summary: "migration file" },
	],
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
			routing: {
				difficulty: "hard",
				difficultyConfidence: 0.8,
				thinking: "high",
				risk: 0.21,
			},
			model: "jev-1.13.0",
			inputTokens: 812,
		});
		expect(service.latest).toBe(signals);
		expect(sent?.model).toBe("jev-latest");
		const state = sent?.state as Record<string, string>;
		expect(state.duo_phase).toBe("executing");
		expect(state.turn_status).toContain("in progress");
	});
	test("retains original request and digest when judging current work", async () => {
		let turnState: Record<string, unknown> | undefined;
		const promptResponse = {
			model: "jev",
			answers: {
				difficulty: { type: "choice", choice: "hard", probabilities: { hard: 1 }, confidence: 1 },
				thinking: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 1 },
				risk_domain: { type: "noul", noul: 0.2 },
			},
			usage: { input_tokens: 2, output_tokens: 2 },
		};
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(body => {
				if ("phase" in (body.questions as Record<string, unknown>)) {
					turnState = body.state as Record<string, unknown>;
					return Response.json(TURN_ANSWERS);
				}
				return Response.json(promptResponse);
			}),
		});
		const service = new TurnSignalService(client);

		await service.classifyPrompt("Fix the retry loop", "Digest: retry test failed twice");
		const signals = await service.classifyTurn("reproduced failure; second fix also failed", { wip: true });

		expect(signals?.routing).toEqual({
			difficulty: "hard",
			difficultyConfidence: 0.8,
			thinking: "high",
			risk: 0.21,
		});
		expect(turnState).toEqual({
			turn_status: "in progress: the agent will keep working after this slice",
			transcript: "reproduced failure; second fix also failed",
			request: "Fix the retry loop",
			prior_context: "Digest: retry test failed twice",
		});
	});

	test("maps bounded routing effort for trivial, hard, and extreme work", async () => {
		const responseFor = (difficulty: string, thinking: string) => ({
			...TURN_ANSWERS,
			answers: {
				...TURN_ANSWERS.answers,
				difficulty: { type: "choice", choice: difficulty, probabilities: { [difficulty]: 1 }, confidence: 1 },
				thinking: { type: "choice", choice: thinking, probabilities: { [thinking]: 1 }, confidence: 1 },
				risk_domain: { type: "noul", noul: 0.1 },
			},
		});
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(body => {
				const transcript = String((body.state as Record<string, unknown>).transcript);
				if (transcript.includes("rename")) return Response.json(responseFor("easy", "medium"));
				if (transcript.includes("architecture")) return Response.json(responseFor("extreme", "xhigh"));
				return Response.json(responseFor("hard", "high"));
			}),
		});
		const service = new TurnSignalService(client);

		const debugging = await service.classifyTurn("reproduced error; first fix failed; second fix failed", {
			wip: true,
		});
		const trivial = await service.classifyTurn("rename known variable in one file", { wip: false });
		const extreme = await service.classifyTurn("architecture migration across services with concurrency risk", {
			wip: false,
		});

		expect(debugging?.routing?.difficulty).toBe("hard");
		expect(debugging?.routing?.thinking).toBe("high");
		expect(trivial?.routing).toMatchObject({ difficulty: "easy", thinking: "medium" });
		expect(extreme?.routing).toMatchObject({ difficulty: "extreme", thinking: "xhigh" });
	});

	test("omits invalid or missing live routing while preserving base turn signals", async () => {
		const responses = [
			{
				...TURN_ANSWERS,
				answers: {
					...TURN_ANSWERS.answers,
					thinking: { type: "choice", choice: "low", probabilities: { low: 1 }, confidence: 1 },
				},
			},
			{
				...TURN_ANSWERS,
				answers: {
					...TURN_ANSWERS.answers,
					difficulty: undefined,
					thinking: undefined,
					risk_domain: undefined,
				},
			},
		];
		for (const response of responses) {
			const service = new TurnSignalService(
				new TypeSafeClient({ apiKey: "k", fetch: fakeFetch(() => Response.json(response)) }),
			);
			const signals = await service.classifyTurn("working", { wip: true });
			expect(signals?.phase).toBe("debugging");
			expect(signals?.routing).toBeUndefined();
			expect(service.latest).toBe(signals);
		}
	});

	test("rejects invalid initial thinking effort", async () => {
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(() =>
				Response.json({
					model: "jev",
					answers: {
						difficulty: { type: "choice", choice: "moderate", probabilities: { moderate: 1 }, confidence: 1 },
						thinking: { type: "choice", choice: "low", probabilities: { low: 1 }, confidence: 1 },
						risk_domain: { type: "noul", noul: 0 },
					},
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			),
		});
		expect(await new TurnSignalService(client).classifyPrompt("Known edit", undefined)).toBeUndefined();
	});

	test("drops out-of-order turn results", async () => {
		const oldResponse = Promise.withResolvers<Response>();
		const newResponse = Promise.withResolvers<Response>();
		let calls = 0;
		const service = new TurnSignalService(
			new TypeSafeClient({
				apiKey: "k",
				fetch: fakeFetch(() => (calls++ === 0 ? oldResponse.promise : newResponse.promise)),
			}),
		);

		const old = service.classifyTurn("old transcript", { wip: true });
		const current = service.classifyTurn("new transcript", { wip: false });
		newResponse.resolve(Response.json({ ...TURN_ANSWERS, model: "new" }));
		const currentSignals = await current;
		oldResponse.resolve(Response.json({ ...TURN_ANSWERS, model: "old" }));

		expect(currentSignals?.model).toBe("new");
		expect(await old).toBeUndefined();
		expect(service.latest?.model).toBe("new");
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

	test("retained request context shares the transcript budget instead of exceeding the endpoint limit", async () => {
		let sent: Record<string, unknown> | undefined;
		const service = new TurnSignalService(
			new TypeSafeClient({
				fetch: fakeFetch(body => {
					sent = body;
					return Response.json(TURN_ANSWERS);
				}),
			}),
			{ maxStateChars: 12 },
		);
		await service.classifyPrompt("old-request", "old-context");
		await service.classifyTurn("old-transcript", { wip: true });
		expect(sent?.state).toMatchObject({ request: "est", prior_context: "ext", transcript: "script" });
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

	test("classifyTopicSwitch sends the digest and request as separate state fields", async () => {
		let state: Record<string, unknown> | undefined;
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(body => {
				state = body.state as Record<string, unknown>;
				return Response.json({
					model: "jev",
					answers: { topic_switch: { type: "noul", noul: 0.82 } },
					usage: { input_tokens: 1, output_tokens: 1 },
				});
			}),
		});
		const service = new TurnSignalService(client);

		expect(await service.classifyTopicSwitch("Title: refactor parser", "Set up the billing webhook")).toEqual({
			topicSwitch: 0.82,
		});
		expect(state).toEqual({ prior_context: "Title: refactor parser", new_request: "Set up the billing webhook" });
	});

	test("classifyTopicSwitch fails open when the answer is missing", async () => {
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(() =>
				Response.json({ model: "jev", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
			),
		});
		expect(await new TurnSignalService(client).classifyTopicSwitch("digest", "request")).toBeUndefined();
	});

	test("classifyPrompt maps difficulty and risk, and rejects an unknown tier", async () => {
		let state: Record<string, unknown> | undefined;
		const answersFor = (choice: string) => ({
			model: "jev",
			answers: {
				difficulty: { type: "choice", choice, probabilities: { [choice]: 0.7 }, confidence: 0.64 },
				thinking: { type: "choice", choice: "high", probabilities: { high: 0.9, medium: 0.1 }, confidence: 0.9 },
				risk_domain: { type: "noul", noul: 0.88 },
			},
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		let choice = "hard";
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(body => {
				state = body.state as Record<string, unknown>;
				return Response.json(answersFor(choice));
			}),
		});
		const service = new TurnSignalService(client);

		expect(await service.classifyPrompt("Migrate the ledger table", "Title: billing")).toEqual({
			difficulty: "hard",
			difficultyConfidence: 0.64,
			thinking: "high",
			risk: 0.88,
		});
		expect(state).toEqual({ request: "Migrate the ledger table", prior_context: "Title: billing" });

		choice = "impossible";
		expect(await service.classifyPrompt("x", undefined)).toBeUndefined();
	});

	test("credentials never reach the endpoint: pattern secrets and obfuscator-known values are scrubbed from every state leaf", async () => {
		let sent = "";
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: ((_url: string | URL | Request, init?: RequestInit) => {
				sent = String(init?.body);
				return Promise.resolve(
					Response.json({ model: "jev", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
				);
			}) as typeof fetch,
			redact: text => text.replaceAll("hunter2-vault-value", "#SECRET_1#"),
		});

		await client.systemOne(
			{
				transcript: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 && curl -u hunter2-vault-value",
				nested: { items: ["password_aB3dEfGh1JkLmN9", "plain text"] },
			},
			{},
		);

		expect(sent).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
		expect(sent).not.toContain("hunter2-vault-value");
		expect(sent).not.toContain("aB3dEfGh1JkLmN9");
		expect(sent).toContain("#SECRET_1#");
		expect(sent).toContain("plain text");
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

describe("TurnSignalService context trim", () => {
	test("asks one keep question per candidate and maps the answers", async () => {
		let sent: Record<string, unknown> | undefined;
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(body => {
				sent = body;
				return Response.json(TRIM_ANSWERS);
			}),
		});
		const service = new TurnSignalService(client);

		const signals = await service.classifyContextTrim(TRIM_INPUT);

		expect(signals).toEqual({
			keep: { "rec-1": 0.04, "rec-2": 0.91 },
			action: "shake",
			actionConfidence: 0.81,
			handoffSufficient: 0.66,
		});
		const questions = sent?.questions as Record<string, { type: string; instructions: string }> | undefined;
		expect(Object.keys(questions ?? {}).sort()).toEqual(["action", "handoff_sufficient", "keep:rec-1", "keep:rec-2"]);
		expect(questions?.["keep:rec-1"]?.instructions).toContain("rec-1");
		expect(questions?.["keep:rec-1"]?.instructions).not.toContain("{{id}}");
	});

	test("returns undefined rather than dropping records when the action is unusable", async () => {
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(() =>
				Response.json({
					...TRIM_ANSWERS,
					answers: {
						...TRIM_ANSWERS.answers,
						action: { type: "choice", choice: "archive", probabilities: {}, confidence: 0.5 },
					},
				}),
			),
		});
		const service = new TurnSignalService(client);

		expect(await service.classifyContextTrim(TRIM_INPUT)).toBeUndefined();
	});

	test("skips the request when there is nothing to judge", async () => {
		let calls = 0;
		const client = new TypeSafeClient({
			apiKey: "k",
			fetch: fakeFetch(() => {
				calls += 1;
				return Response.json(TRIM_ANSWERS);
			}),
		});
		const service = new TurnSignalService(client);

		expect(await service.classifyContextTrim({ ...TRIM_INPUT, candidates: [] })).toBeUndefined();
		expect(calls).toBe(0);
	});
});

describe("stop assessment wire contract", () => {
	test("treats null and array answers as unavailable instead of throwing", async () => {
		for (const answers of [null, []]) {
			const service = new TurnSignalService(
				new TypeSafeClient({ fetch: fakeFetch(() => Response.json({ model: "jev", answers })) }),
			);
			expect(
				await service.judgeStop({
					objective: "Explain",
					latestRequest: "Explain",
					priorRequests: [],
					candidate: "Answer",
					evidence: [],
					openTodos: [],
					mode: { plan: false },
					omitted: false,
				}),
			).toBeUndefined();
		}
	});
	const input: StopAssessmentInput = {
		objective: "Finish CANARY",
		latestRequest: "Fix CANARY",
		priorRequests: ["Keep CANARY private"],
		candidate: "Partial CANARY",
		evidence: [{ callId: "1", tool: "write", target: "CANARY", isError: false }],
		openTodos: ["Verify CANARY"],
		mode: { plan: false },
		omitted: false,
	};
	test("does not approve a stop after prior requests were clipped", async () => {
		const service = new TurnSignalService(
			new TypeSafeClient({
				fetch: fakeFetch(() =>
					Response.json({
						model: "jev",
						answers: {
							stop_kind: {
								type: "choice",
								choice: "complete",
								confidence: 1,
								probabilities: { complete: 1, partial: 0, question: 0, blocked: 0, waiting: 0, uncertain: 0 },
							},
							goal_satisfied: { type: "noul", noul: 1 },
							blocker_external: { type: "noul", noul: 0 },
							needs_user_decision: { type: "noul", noul: 0 },
						},
					}),
				),
			}),
		);
		expect(await service.judgeStop({ ...input, priorRequests: ["x".repeat(4001)], omitted: false })).toBeUndefined();
	});
	const answers = {
		stop_kind: {
			type: "choice",
			choice: "partial",
			confidence: 0.95,
			probabilities: { complete: 0, partial: 1, question: 0, blocked: 0, waiting: 0, uncertain: 0 },
		},
		goal_satisfied: { type: "noul", noul: 0 },
		blocker_external: { type: "noul", noul: 0 },
		needs_user_decision: { type: "noul", noul: 0 },
	};
	test("scrubs exact outgoing payload and batches all four judgments without altering turn signals", async () => {
		let currentSecret = "unused";
		const client = new TypeSafeClient({
			redact: text => text.replaceAll(currentSecret, "[hidden]"),
			fetch: fakeFetch(body => {
				expect(JSON.stringify(body)).not.toContain("CANARY");
				expect(Object.keys(body.questions as object).sort()).toEqual([
					"blocker_external",
					"goal_satisfied",
					"needs_user_decision",
					"stop_kind",
				]);
				return Response.json({ model: "jev", answers });
			}),
		});
		currentSecret = "CANARY";
		const service = new TurnSignalService(client);
		expect(await service.judgeStop(input)).toEqual({
			kind: "partial",
			confidence: 0.95,
			goalSatisfied: 0,
			blockerExternal: 0,
			needsUserDecision: 0,
			model: "jev",
		});
		expect(service.latest).toBeUndefined();
	});
	test("rejects inconsistent choices and out-of-range probabilities, then opens its circuit", async () => {
		let calls = 0;
		const service = new TurnSignalService(
			new TypeSafeClient({
				fetch: fakeFetch(() => {
					calls++;
					return Response.json({
						model: "jev",
						answers: { ...answers, goal_satisfied: { type: "noul", noul: 2 } },
					});
				}),
			}),
		);
		for (let i = 0; i < 4; i++) expect(await service.judgeStop(input)).toBeUndefined();
		expect(calls).toBe(3);
		const invalidChoice = new TurnSignalService(
			new TypeSafeClient({
				fetch: fakeFetch(() =>
					Response.json({
						model: "jev",
						answers: { ...answers, stop_kind: { ...answers.stop_kind, choice: "complete" } },
					}),
				),
			}),
		);
		expect(await invalidChoice.judgeStop(input)).toBeUndefined();
	});
});
