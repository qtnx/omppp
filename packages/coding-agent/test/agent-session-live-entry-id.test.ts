/**
 * Live-session entry-id stamping.
 *
 * The context-gc plugin disambiguates duplicate-content occurrences by the stable session entry id.
 * `buildSessionContext` stamps that id on resume/rebuild, but the live turn must also expose it:
 * prompt-time non-tool surfaces (file mentions, custom asides) and direct bash/python/custom appends
 * reach the context transform before their asynchronous `message_end` events are persisted. These
 * tests prove the live `AgentMessage` carries `entryId` in the same turn, that the id never leaks into
 * the provider payload, and that the session entry is written exactly once (no duplicate).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

interface LiveEntryHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	contextCaptures: AgentMessage[][];
}

describe("AgentSession live entry id", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-live-entry-id-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createHarness(): Promise<LiveEntryHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model to exist");

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });

		// Capture the messages the context path observes — this is exactly what an extension's
		// `context` hook receives (pre-LLM), and runs before convertToLlm builds the provider payload.
		const contextCaptures: AgentMessage[][] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			transformContext: async (messages: AgentMessage[]) => {
				contextCaptures.push(messages.map(m => ({ ...m }) as AgentMessage));
				return messages;
			},
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory(tempDir);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		return { session, sessionManager, mock, contextCaptures };
	}

	function messageEntries(sessionManager: SessionManager, role: string): AgentMessage[] {
		return sessionManager
			.getEntries()
			.filter(entry => entry.type === "message" && (entry.message as AgentMessage).role === role)
			.map(entry => (entry as { message: AgentMessage }).message);
	}

	function customMessageEntries(sessionManager: SessionManager, customType: string) {
		return sessionManager
			.getEntries()
			.filter(
				entry => entry.type === "custom_message" && (entry as { customType?: string }).customType === customType,
			);
	}

	it("stamps the live prompt fileMention with its entry id before the context path, never leaks it to the provider, and writes one entry", async () => {
		const { session, sessionManager, contextCaptures } = await createHarness();

		fs.writeFileSync(path.join(tempDir, "notes.txt"), "alpha\nbeta\ngamma\n");

		await session.prompt("read @notes.txt please");

		// The live context path observed a fileMention carrying a stable entry id this turn.
		const lastCapture = contextCaptures.at(-1);
		expect(lastCapture).toBeDefined();
		const capturedFileMention = lastCapture!.find(m => m.role === "fileMention") as
			| (AgentMessage & { entryId?: string })
			| undefined;
		expect(capturedFileMention).toBeDefined();
		expect(typeof capturedFileMention!.entryId).toBe("string");
		expect(capturedFileMention!.entryId!.length).toBeGreaterThan(0);

		// The provider conversion of those exact context-path messages must never carry the runtime id.
		for (const providerMessage of convertToLlm(lastCapture!)) {
			expect(Object.hasOwn(providerMessage, "entryId")).toBe(false);
		}

		// Exactly one fileMention session entry exists (no pre-persist + message_end duplicate), and its
		// id matches the id stamped on the live message.
		const fileMentionEntries = sessionManager
			.getEntries()
			.filter(entry => entry.type === "message" && (entry.message as AgentMessage).role === "fileMention");
		expect(fileMentionEntries).toHaveLength(1);
		const persistedFileMention = (fileMentionEntries[0] as { message: AgentMessage }).message as {
			entryId?: string;
		};
		expect(fileMentionEntries[0]!.id).toBe(capturedFileMention!.entryId!);
		expect(persistedFileMention.entryId).toBeUndefined();

		// The user prompt is persisted exactly once and is never stamped (convertToLlm spreads it).
		const userEntries = messageEntries(sessionManager, "user");
		expect(userEntries).toHaveLength(1);
		expect((userEntries[0] as { entryId?: string }).entryId).toBeUndefined();
	});

	it("stamps a direct no-trigger custom append with its entry id without duplicating the entry", async () => {
		const { session, sessionManager } = await createHarness();

		await session.sendCustomMessage(
			{ customType: "context-aside", content: "remember this", display: false },
			{ triggerTurn: false },
		);

		const liveCustom = session.agent.state.messages.find(
			m => m.role === "custom" && m.customType === "context-aside",
		) as (AgentMessage & { entryId?: string }) | undefined;
		expect(liveCustom).toBeDefined();
		expect(typeof liveCustom!.entryId).toBe("string");

		const entries = customMessageEntries(sessionManager, "context-aside");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe(liveCustom!.entryId!);

		// The runtime-only id must not survive provider conversion.
		for (const providerMessage of convertToLlm(session.agent.state.messages)) {
			expect(Object.hasOwn(providerMessage, "entryId")).toBe(false);
		}
	});

	it("stamps a trigger-turn custom prompt with its entry id before the context path without duplicating the entry", async () => {
		const { session, sessionManager, contextCaptures } = await createHarness();

		await session.sendCustomMessage(
			{ customType: "context-aside", content: "remember this turn", display: false },
			{ triggerTurn: true },
		);

		const lastCapture = contextCaptures.at(-1);
		expect(lastCapture).toBeDefined();
		const capturedCustom = lastCapture!.find(m => m.role === "custom" && m.customType === "context-aside") as
			| (AgentMessage & { entryId?: string })
			| undefined;
		expect(capturedCustom).toBeDefined();
		expect(typeof capturedCustom!.entryId).toBe("string");

		const entries = customMessageEntries(sessionManager, "context-aside");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe(capturedCustom!.entryId!);

		for (const providerMessage of convertToLlm(lastCapture!)) {
			expect(Object.hasOwn(providerMessage, "entryId")).toBe(false);
		}
	});

	it("stamps a nextTurn trigger custom prompt with its entry id before the context path without duplicating the entry", async () => {
		const { session, sessionManager, contextCaptures } = await createHarness();

		await session.sendCustomMessage(
			{ customType: "next-turn-aside", content: "remember this next turn", display: false },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);

		const lastCapture = contextCaptures.at(-1);
		expect(lastCapture).toBeDefined();
		const capturedCustom = lastCapture!.find(m => m.role === "custom" && m.customType === "next-turn-aside") as
			| (AgentMessage & { entryId?: string })
			| undefined;
		expect(capturedCustom).toBeDefined();
		expect(typeof capturedCustom!.entryId).toBe("string");

		const entries = customMessageEntries(sessionManager, "next-turn-aside");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe(capturedCustom!.entryId!);

		for (const providerMessage of convertToLlm(lastCapture!)) {
			expect(Object.hasOwn(providerMessage, "entryId")).toBe(false);
		}
	});

	it("stamps live bash and python result appends with their entry ids without duplicating entries", async () => {
		const { session, sessionManager } = await createHarness();

		session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 2,
			outputLines: 1,
			outputBytes: 2,
		});

		session.recordPythonResult("print(1)", {
			output: "1",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 1,
			outputLines: 1,
			outputBytes: 1,
			displayOutputs: [],
			stdinRequested: false,
		});

		const liveBash = session.agent.state.messages.find(m => m.role === "bashExecution") as
			| (AgentMessage & { entryId?: string })
			| undefined;
		const livePython = session.agent.state.messages.find(m => m.role === "pythonExecution") as
			| (AgentMessage & { entryId?: string })
			| undefined;
		expect(typeof liveBash?.entryId).toBe("string");
		expect(typeof livePython?.entryId).toBe("string");

		const bashEntries = messageEntries(sessionManager, "bashExecution");
		const pythonEntries = messageEntries(sessionManager, "pythonExecution");
		expect(bashEntries).toHaveLength(1);
		expect(pythonEntries).toHaveLength(1);

		const bashEntryId = sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && (entry.message as AgentMessage).role === "bashExecution")?.id;
		const pythonEntryId = sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && (entry.message as AgentMessage).role === "pythonExecution")?.id;
		expect(liveBash!.entryId).toBe(bashEntryId);
		expect(livePython!.entryId).toBe(pythonEntryId);
		expect((bashEntries[0] as { entryId?: string }).entryId).toBeUndefined();
		expect((pythonEntries[0] as { entryId?: string }).entryId).toBeUndefined();

		// bash/python convert to fresh user messages, so the runtime id never reaches the provider.
		for (const providerMessage of convertToLlm(session.agent.state.messages)) {
			expect(Object.hasOwn(providerMessage, "entryId")).toBe(false);
		}
	});
});
