import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { convertToLlm } from "../src/session/messages";
import { runPrintMode } from "../src/modes/print-mode";
import * as signals from "../src/signals/turn-signal-service";
import { TypeSafeClient } from "../src/signals/typesafe-client";
import type { StopAssessment } from "../src/signals/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});
const recordSchema = type({ value: "string" });
const stop = (text: string): MockResponse => ({ content: [text], stopReason: "stop" });
const write = (value: string, id: string): MockResponse => ({
	content: [{ type: "toolCall", name: "record", id, arguments: { value } }],
	stopReason: "toolUse",
});
function response(kind: StopAssessment["kind"], satisfied = 0, external = 0, decision = 0): Response {
	return Response.json({
		model: "test-jev",
		answers: {
			stop_kind: {
				type: "choice",
				choice: kind,
				confidence: 0.95,
				probabilities: Object.fromEntries(
					["complete", "partial", "question", "blocked", "waiting", "uncertain"].map(key => [
						key,
						key === kind ? 1 : 0,
					]),
				),
			},
			goal_satisfied: { type: "noul", noul: satisfied },
			blocker_external: { type: "noul", noul: external },
			needs_user_decision: { type: "noul", noul: decision },
		},
	});
}
async function rig(
	responses: MockResponse[],
	judge: (state: Record<string, unknown>) => Response | Promise<Response>,
	extensionEvents = true,
	priorRequest?: string,
	signalsEnabled = true,
) {
	const temp = TempDir.createSync("ompx-completion-");
	const storage = createInMemoryAuthStorage();
	storage.setRuntimeApiKey("mock", "fixture");
	const mock = createMockModel({ responses });
	const file = path.join(temp.path(), "result.txt");
	let onRecord = () => {};
	const tool: AgentTool<typeof recordSchema> = {
		name: "record",
		label: "Record",
		description: "Write the requested value",
		parameters: recordSchema,
		execute: async (_id, args) => {
			await Bun.write(file, args.value);
			onRecord();
			return { content: [{ type: "text", text: "PRIVATE_TOOL_BODY" }], details: { status: "success" } };
		},
	};
	const sent: Record<string, unknown>[] = [];
	const fetcher = (async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		if (!body.questions.stop_kind) return Response.json({ model: "test-jev", answers: {} });
		sent.push(body.state);
		return judge(body.state);
	}) as typeof fetch;
	const service = new signals.TurnSignalService(new TypeSafeClient({ fetch: fetcher }));
	vi.spyOn(signals, "createTurnSignalService").mockReturnValue(signalsEnabled ? service : undefined);
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.doneGate": false,
		"duo.mode": "off",
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const tools = [tool] as AgentTool[];
	const agent = new Agent({
		getApiKey: () => "fixture",
		initialState: { model: mock, systemPrompt: ["Test"], tools },
		convertToLlm,
		streamFn: mock.stream,
	});
	const manager = SessionManager.inMemory(temp.path());
	if (priorRequest) {
		const prior = { role: "user" as const, content: [{ type: "text" as const, text: priorRequest }], timestamp: 1 };
		manager.appendMessage(prior);
		agent.appendMessage(prior);
	}
	const ends: Array<boolean | undefined> = [];
	/** Recorded when the run really settles; a suspended settle must not appear here. */
	const extensionRunner = {
		emit: async (event: { type: string; willContinue?: boolean }) => {
			if (event.type === "agent_end") ends.push(event.willContinue);
		},
		emitBeforeAgentStart: async () => undefined,
		hasHandlers: () => false,
		emitSessionStop: async () => undefined,
	} as unknown as ConstructorParameters<typeof AgentSession>[0]["extensionRunner"];
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(storage),
		extensionRunner: extensionEvents ? extensionRunner : undefined,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	cleanups.push(async () => {
		await session.dispose();
		storage.close();
		temp.removeSync();
	});
	return {
		session,
		mock,
		file,
		ends,
		sent,
		manager,
		onRecord: (callback: () => void) => {
			onRecord = callback;
		},
	};
}

describe("main-stream completion gate", () => {
	it("is inert when signals are disabled: no continuation and no outbound request", async () => {
		const r = await rig([stop("Should I write the file?")], () => response("question", 0), true, undefined, false);
		r.session.setTodoPhases([
			{ name: "Delivery", tasks: [{ content: "Write and verify result.txt", status: "pending" }] },
		]);
		await r.session.prompt("Deliver result.txt.");
		await r.session.waitForIdle();
		expect(r.sent).toEqual([]);
		expect(r.mock.calls).toHaveLength(1);
		expect(await Bun.file(r.file).exists()).toBe(false);
	});

	it("keeps open work actionable after an audit and an uncertain external-blocker verdict", async () => {
		const r = await rig(
			[stop("Partial."), stop("Still partial."), write("verified", "w"), stop("Delivered.")],
			state =>
				response(
					state.candidate === "Delivered." ? "complete" : "uncertain",
					state.candidate === "Delivered." ? 1 : 0,
					0.5,
				),
		);
		r.session.setTodoPhases([
			{ name: "Delivery", tasks: [{ content: "Write and verify result.txt", status: "pending" }] },
		]);
		r.onRecord(() => r.session.setTodoPhases([]));
		await r.session.prompt("Deliver result.txt.");
		await r.session.waitForIdle();
		expect(await Bun.file(r.file).text()).toBe("verified");
		expect(r.mock.calls).toHaveLength(4);
		expect(r.ends).toEqual([true, true, undefined]);
	});

	it("a complete verdict cannot erase an open item; real work closes it", async () => {
		const r = await rig([stop("Done."), write("verified", "w"), stop("Delivered.")], () => response("complete", 1));
		r.session.setTodoPhases([
			{ name: "Delivery", tasks: [{ content: "Write and verify result.txt", status: "pending" }] },
		]);
		r.onRecord(() => r.session.setTodoPhases([]));
		await r.session.prompt("Deliver result.txt.");
		await r.session.waitForIdle();
		expect(await Bun.file(r.file).text()).toBe("verified");
		expect(r.ends).toEqual([true, undefined]);
	});

	it("continues a premature question, performs a real file write and only then ends", async () => {
		const r = await rig(
			[stop("Should I write the file?"), write("delivered", "w1"), stop("File delivered.")],
			state =>
				response(
					String(state.candidate).includes("Should") ? "question" : "complete",
					String(state.candidate).includes("Should") ? 0 : 1,
				),
		);
		await r.session.prompt("Write result.txt containing delivered.");
		await r.session.waitForIdle();
		expect(await Bun.file(r.file).text()).toBe("delivered");
		expect(r.ends).toEqual([true, undefined]);
		expect(r.mock.calls).toHaveLength(3);
		expect(reminders(r.manager)).toHaveLength(1);
		expect(JSON.stringify(r.sent)).not.toContain("PRIVATE_TOOL_BODY");
		expect(r.sent.at(-1)?.evidence).toEqual([
			expect.objectContaining({ tool: "record", status: "success", isError: false }),
		]);
	});
	it("allows more than two substantive repairs rather than silently quitting", async () => {
		const r = await rig(
			[
				stop("Partial 1"),
				write("one", "1"),
				stop("Partial 2"),
				write("two", "2"),
				stop("Partial 3"),
				write("final", "3"),
				stop("Delivered"),
			],
			state =>
				response(state.candidate === "Delivered" ? "complete" : "partial", state.candidate === "Delivered" ? 1 : 0),
		);
		await r.session.prompt("Finish the fixture repair.");
		await r.session.waitForIdle();
		expect(await Bun.file(r.file).text()).toBe("final");
		expect(r.sent.length).toBe(4);
	});
	it("does not turn a negative report-only result or a complete plan into implementation", async () => {
		const r = await rig([stop("Two tests fail."), stop("Plan: modify the parser, then verify rejection.")], () =>
			response("complete", 1),
		);
		await r.session.prompt("Report test failures only; do not modify files.");
		await r.session.waitForIdle();
		await r.session.prompt("Write a plan only; no implementation.");
		await r.session.waitForIdle();
		expect(await Bun.file(r.file).exists()).toBe(false);
		expect(r.mock.calls.length).toBe(2);
	});
	it("stops for a user-held approval rather than overriding it", async () => {
		const r = await rig([stop("The required approval has not been granted.")], () => response("blocked", 0, 1, 1));
		await r.session.prompt("Do not write until I approve; explain the missing approval.");
		await r.session.waitForIdle();
		expect(await Bun.file(r.file).exists()).toBe(false);
		expect(r.mock.calls.length).toBe(1);
	});
	it("treats unavailable classification as inert rather than approval or continuation", async () => {
		const r = await rig([stop("Answer.")], () => Response.json({ model: "test-jev", answers: {} }));
		await r.session.prompt("Explain the fixture.");
		await r.session.waitForIdle();
		expect(r.mock.calls.length).toBe(1);
		expect(r.sent.length).toBe(1);
		expect(await Bun.file(r.file).exists()).toBe(false);
	});
	it("discards an assessment that resolves after user cancellation", async () => {
		const pending = Promise.withResolvers<Response>();
		const started = Promise.withResolvers<void>();
		const r = await rig([stop("Partial")], () => {
			started.resolve();
			return pending.promise;
		});
		const run = r.session.prompt("Write the fixture.");
		await started.promise;
		const abort = r.session.abort();
		pending.resolve(response("partial"));
		await Promise.all([run, abort]);
		await r.session.waitForIdle();
		expect(r.mock.calls.length).toBe(1);
		expect(await Bun.file(r.file).exists()).toBe(false);
	});
	it("lets queued user control supersede an in-flight stop judgment", async () => {
		const pending = Promise.withResolvers<Response>();
		const started = Promise.withResolvers<void>();
		let calls = 0;
		const r = await rig([stop("Partial"), stop("Stopped without writing.")], () => {
			if (++calls === 1) {
				started.resolve();
				return pending.promise;
			}
			return response("complete", 1, 0, 1);
		});
		const run = r.session.prompt("Write the fixture.");
		await started.promise;
		await r.session.followUp("Stop; do not write anything.");
		pending.resolve(response("partial"));
		await run;
		await r.session.waitForIdle();
		expect(await Bun.file(r.file).exists()).toBe(false);
		expect(reminders(r.manager)).toEqual([]);
		expect(r.mock.calls).toHaveLength(2);
	});

	it("never approves or continues on context clipped before sending", async () => {
		const r = await rig([stop("Final answer.")], () => response("complete", 1), true, "x".repeat(4001));
		await r.session.prompt("Report the result only.");
		await r.session.waitForIdle();
		// The oversized prior request is never transmitted, so no verdict exists to act on.
		expect(r.sent).toEqual([]);
		expect(r.mock.calls).toHaveLength(1);
		expect(reminders(r.manager)).toEqual([]);
		expect(await Bun.file(r.file).exists()).toBe(false);
	});

	// A print-mode variant of this ordering is NOT covered here: `runPrintMode` never
	// returns against this in-memory rig even with the gate uninvolved (a plain
	// tool-call-then-stop run hangs the same way), so such a test would assert the
	// harness, not the contract. Suspended-versus-terminal ends stay covered by the
	// `ends` assertions above.

	it("resolves a local obstacle instead of treating it as an external blocker", async () => {
		const r = await rig(
			[
				stop("Blocked: fixture.json is missing; please create it."),
				write("fixture", "f1"),
				stop("Fixture created and verified."),
			],
			state =>
				response(
					state.candidate === "Fixture created and verified." ? "complete" : "blocked",
					state.candidate === "Fixture created and verified." ? 1 : 0,
					0.05,
					0.1,
				),
		);
		await r.session.prompt("Create the missing local fixture and verify it.");
		await r.session.waitForIdle();
		expect(await Bun.file(r.file).text()).toBe("fixture");
		expect(r.mock.calls).toHaveLength(3);
	});
	it("honors an enforced hard token budget before spending on assessment", async () => {
		const r = await rig([stop("Partial")], () => response("partial"));
		r.session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Finish the fixture." }],
			timestamp: 1,
		});
		r.session.sessionManager.beginTurnBudget(0, true);
		// Agent-originated prompt preserves the already-enforced budget.
		await r.session.prompt("Continue", { synthetic: true });
		await r.session.waitForIdle();
		expect(r.sent.length).toBe(0);
		expect(r.mock.calls.length).toBe(1);
	});
});

function reminders(manager: SessionManager): string[] {
	return manager
		.getBranch()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "developer" && Array.isArray(entry.message.content)
				? entry.message.content.flatMap(item =>
						item.type === "text" && item.text.includes("<system-reminder>") ? [item.text] : [],
					)
				: [],
		);
}
