import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { detectCompletionClaim, hasMutationsSinceLastUserPrompt } from "@oh-my-pi/pi-coding-agent/duo/takeover-signals";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("detectCompletionClaim", () => {
	it("matches English completion language", () => {
		for (const t of [
			"Done.",
			"I have completed the task",
			"The implementation is finished",
			"Bug fixed",
			"Issue resolved",
			"Changes verified",
			"All tests pass",
			"It works now",
			"Implemented successfully",
		]) {
			expect(detectCompletionClaim(t)).toBe(true);
		}
	});

	it("matches Vietnamese completion language and check marks", () => {
		expect(detectCompletionClaim("Đã hoàn thành công việc")).toBe(true);
		expect(detectCompletionClaim("xong rồi")).toBe(true);
		expect(detectCompletionClaim("Tất cả ✅")).toBe(true);
	});

	it("does not match in-progress or plain question text", () => {
		expect(detectCompletionClaim("still working on it")).toBe(false);
		expect(detectCompletionClaim("Which file should I edit?")).toBe(false);
		expect(detectCompletionClaim("Here is the answer to your question.")).toBe(false);
	});
});

describe("hasMutationsSinceLastUserPrompt", () => {
	const userMsg = (text: string): AgentMessage =>
		({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
	const devMsg = (text: string): AgentMessage =>
		({
			role: "user",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: 1,
		}) as unknown as AgentMessage;
	const toolResult = (toolName: string, isError = false): AgentMessage =>
		({ role: "toolResult", toolName, isError, content: "ok", timestamp: 1 }) as unknown as AgentMessage;

	it("returns true for a successful mutation after the last real user prompt", () => {
		const messages = [userMsg("do it"), toolResult("edit")];
		expect(hasMutationsSinceLastUserPrompt(messages)).toBe(true);
	});

	it("returns false when the only mutation precedes the last real user prompt", () => {
		const messages = [toolResult("edit"), userMsg("now answer a question")];
		expect(hasMutationsSinceLastUserPrompt(messages)).toBe(false);
	});

	it("ignores error tool results", () => {
		const messages = [userMsg("do it"), toolResult("edit", true)];
		expect(hasMutationsSinceLastUserPrompt(messages)).toBe(false);
	});

	it("does not reset the window on developer/synthetic (agent-attributed) messages", () => {
		// Real user prompt → mutation → agent-attributed prompt. The agent one must
		// NOT reset the window, so the earlier mutation still counts.
		const messages = [userMsg("do it"), toolResult("write"), devMsg("<system-reminder>continue</system-reminder>")];
		expect(hasMutationsSinceLastUserPrompt(messages)).toBe(true);
	});

	it("counts every mutating tool name", () => {
		for (const name of ["edit", "write", "ast_edit", "task", "workflow", "bash"]) {
			expect(hasMutationsSinceLastUserPrompt([userMsg("go"), toolResult(name)])).toBe(true);
		}
		expect(hasMutationsSinceLastUserPrompt([userMsg("go"), toolResult("read")])).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate integration
//
// Seam: a real advisor runtime is built (so `isAdvisorActive` and the gate guard
// pass), but `AdvisorRuntime.consult` is stubbed to a controllable promise so no
// real advisor-model round-trip is needed. The verdict is driven through the REAL
// `done_verdict` tool instance on the advisor agent — exercising the exact
// callback wiring the session installed.
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentSession advisor done-review gate", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	function doneReminderCount(): number {
		return sessionManager.getBranch().filter(entry => {
			if (entry.type !== "message" || entry.message.role !== "developer") return false;
			const { content } = entry.message;
			if (!Array.isArray(content)) return false;
			return content.some(
				(item): item is TextContent => item.type === "text" && item.text.includes("Advisor done-review REJECTED"),
			);
		}).length;
	}

	function developerMessageTexts(): string[] {
		const texts: string[] = [];
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "developer") continue;
			const { content } = entry.message;
			if (!Array.isArray(content)) continue;
			for (const item of content) {
				if (item && typeof item === "object" && (item as TextContent).type === "text") {
					texts.push((item as TextContent).text);
				}
			}
		}
		return texts;
	}

	function noticeMessages(): string[] {
		return notices.map(n => n.message);
	}

	let notices: Array<{ level: string; message: string }> = [];

	// Seed a real user prompt + a successful mutation so the mutation gate passes.
	function seedMutationHistory(): void {
		session.agent.state.messages.push(
			{ role: "user", content: [{ type: "text", text: "make the change" }], timestamp: Date.now() } as never,
			{ role: "toolResult", toolName: "edit", isError: false, content: "ok", timestamp: Date.now() } as never,
		);
	}

	function seedMutationAndVerificationHistory(): void {
		session.agent.state.messages.push(
			{ role: "user", content: [{ type: "text", text: "make the simple change" }], timestamp: Date.now() } as never,
			{
				role: "toolResult",
				toolName: "edit",
				isError: false,
				content: "changed one test file",
				timestamp: Date.now(),
			} as never,
			{
				role: "toolResult",
				toolName: "bash",
				isError: false,
				content: "bun test packages/coding-agent/test/focused.test.ts\n1 pass",
				timestamp: Date.now(),
			} as never,
		);
	}

	function stopWith(text: string): void {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	/** Grab the real `done_verdict` tool the session wired onto the advisor agent. */
	function driveVerdict(verdict: "approve" | "reject", missing?: string[]): void {
		const advisor = session.getAdvisorAgent();
		const tool = advisor?.state.tools?.find(t => t.name === "done_verdict");
		if (!tool) throw new Error("done_verdict tool not attached to advisor");
		void tool.execute("call-1", { verdict, missing }, undefined, undefined, undefined as never);
	}

	/** Replace the runtime's consult with a stub that resolves on demand. */
	function stubConsult(): { consultStarted: Promise<void>; resolveConsult: () => void } {
		const runtime = session.getAdvisorRuntimeForTest();
		if (!runtime) throw new Error("advisor runtime not live");
		const { promise: consultPromise, resolve: resolveConsult } = Promise.withResolvers<string | null>();
		const { promise: consultStarted, resolve: resolveConsultStarted } = Promise.withResolvers<void>();
		vi.spyOn(runtime, "consult").mockImplementation(() => {
			resolveConsultStarted();
			return consultPromise;
		});
		return { consultStarted, resolveConsult: () => resolveConsult(null) };
	}

	async function enableAdvisor(): Promise<void> {
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
	}

	beforeEach(async () => {
		notices = [];
		tempDir = TempDir.createSync("@pi-done-gate-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: () => {
				throw new Error("advisor stream should not run in these tests");
			},
		});
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session, "emitNotice").mockImplementation((level, message) => {
			notices.push({ level, message });
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("stays silent when no advisor is active", async () => {
		seedMutationHistory();
		stopWith("Done — implemented and verified.");
		await session.waitForIdle();
		expect(doneReminderCount()).toBe(0);
	});

	it("stays silent when advisor.doneGate is off", async () => {
		session.settings.set("advisor.doneGate", false);
		await enableAdvisor();
		stubConsult();
		seedMutationHistory();
		stopWith("Done — implemented and verified.");
		await session.waitForIdle();
		expect(doneReminderCount()).toBe(0);
	});

	it("stays silent with no completion claim", async () => {
		await enableAdvisor();
		stubConsult();
		seedMutationHistory();
		stopWith("Which approach would you prefer?");
		await session.waitForIdle();
		expect(doneReminderCount()).toBe(0);
	});

	it("stays silent with no mutation since the last user prompt", async () => {
		await enableAdvisor();
		stubConsult();
		// No mutation seeded.
		session.agent.state.messages.push({
			role: "user",
			content: [{ type: "text", text: "explain this" }],
			timestamp: Date.now(),
		} as never);
		stopWith("Done — here is the explanation.");
		await session.waitForIdle();
		expect(doneReminderCount()).toBe(0);
	});

	it("appends a reminder and schedules continuation on reject", async () => {
		await enableAdvisor();
		const { resolveConsult } = stubConsult();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		seedMutationHistory();

		const idle = (async () => {
			stopWith("Done — implemented and verified.");
			await session.waitForIdle();
		})();
		// Let the gate install its pending resolver, then drive the reject verdict.
		await new Promise(r => setTimeout(r, 20));
		driveVerdict("reject", ["run the tests and show output"]);
		resolveConsult();
		await idle;

		expect(doneReminderCount()).toBe(1);
		expect(continueSpy).toHaveBeenCalled();
		const reminderTexts: string[] = [];
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const content = (entry.message as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const c of content) {
				if (c && typeof c === "object" && (c as TextContent).type === "text") {
					reminderTexts.push((c as TextContent).text);
				}
			}
		}
		const reminder = reminderTexts.find(t => t.includes("Advisor done-review REJECTED"));
		expect(reminder).toContain("run the tests and show output");
		expect(reminder).toContain("Review 1/2");
	});

	it("stops cleanly on approve", async () => {
		await enableAdvisor();
		const { resolveConsult } = stubConsult();
		seedMutationHistory();

		const idle = (async () => {
			stopWith("Done — implemented and verified.");
			await session.waitForIdle();
		})();
		await new Promise(r => setTimeout(r, 20));
		driveVerdict("approve");
		resolveConsult();
		await idle;

		expect(doneReminderCount()).toBe(0);
	});

	it("does not require independent QA after advisor-approved simple verified work", async () => {
		await enableAdvisor();
		const { consultStarted, resolveConsult } = stubConsult();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		seedMutationAndVerificationHistory();

		const idle = (async () => {
			stopWith("Done — implemented and verified with the focused Bun test.");
			await session.waitForIdle();
		})();
		await consultStarted;
		driveVerdict("approve");
		resolveConsult();
		await idle;

		expect(developerMessageTexts().filter(text => text.includes("Independent QA"))).toHaveLength(0);
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("caps at 2 rejections then stops firing", async () => {
		await enableAdvisor();

		for (let i = 0; i < 2; i++) {
			const { resolveConsult } = stubConsult();
			seedMutationHistory();
			const idle = (async () => {
				stopWith("Done — implemented and verified.");
				await session.waitForIdle();
			})();
			await new Promise(r => setTimeout(r, 20));
			driveVerdict("reject", ["still missing evidence"]);
			resolveConsult();
			await idle;
			vi.restoreAllMocks();
			// Re-stub agent.continue after restore.
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "emitNotice").mockImplementation((level, message) => {
				notices.push({ level, message });
			});
		}
		expect(doneReminderCount()).toBe(2);

		// Third stop: gate is capped, no consult even attempted → no new reminder.
		const runtime = session.getAdvisorRuntimeForTest();
		const consultSpy = vi.spyOn(runtime!, "consult");
		seedMutationHistory();
		stopWith("Done — implemented and verified.");
		await session.waitForIdle();
		expect(doneReminderCount()).toBe(2);
		expect(consultSpy).not.toHaveBeenCalled();
	});

	it("fails open with a warning notice when no verdict arrives", async () => {
		await enableAdvisor();
		const { resolveConsult } = stubConsult();
		seedMutationHistory();

		const idle = (async () => {
			stopWith("Done — implemented and verified.");
			await session.waitForIdle();
		})();
		await new Promise(r => setTimeout(r, 20));
		// Consult settles WITHOUT a verdict → 5s grace → fail-open. Speed the grace
		// by resolving consult; the grace timer still runs but the race resolves null.
		resolveConsult();
		await idle;

		expect(doneReminderCount()).toBe(0);
		expect(noticeMessages().some(m => m.includes("done-review unavailable"))).toBe(true);
	}, 15_000);
});
