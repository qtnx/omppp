import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

interface MockHarness {
	calls: unknown[];
}

interface Harness {
	session: AgentSession;
	mock: MockHarness;
	authStorage: AuthStorage;
	tempDir: string;
}

interface TextBearingMessage {
	content: string | Array<{ type: string; text?: string }>;
}

// Hermetic auth avoids SQLite schema/init flake while still constructing a real
// AgentSession and driving the actual Agent loop used by idle wakes.
class InMemoryAuthCredentialStore implements AuthCredentialStore {
	#credentials: StoredAuthCredential[] = [];
	#cache = new Map<string, { value: string; expiresAtSec: number }>();
	#nextId = 1;

	close(): void {}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		return this.#credentials
			.filter(credential => credential.disabledCause === null && (!provider || credential.provider === provider))
			.map(credential => ({ ...credential, credential: { ...credential.credential } }));
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		const row = this.#credentials.find(entry => entry.id === id);
		if (row) row.credential = { ...credential };
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		const row = this.#credentials.find(entry => entry.id === id);
		if (row) row.disabledCause = disabledCause;
	}

	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean {
		const row = this.#credentials.find(entry => entry.id === id);
		if (!row || row.disabledCause !== null || JSON.stringify(row.credential) !== expectedData) return false;
		row.disabledCause = disabledCause;
		return true;
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		this.#credentials = this.#credentials.filter(entry => entry.provider !== provider);
		const rows = credentials.map(credential => this.#createRow(provider, credential));
		this.#credentials.push(...rows);
		return rows.map(row => ({ ...row, credential: { ...row.credential } }));
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		const existing = this.#credentials.find(
			entry => entry.provider === provider && JSON.stringify(entry.credential) === JSON.stringify(credential),
		);
		if (!existing) this.#credentials.push(this.#createRow(provider, credential));
		return this.listAuthCredentials(provider);
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		for (const row of this.#credentials) {
			if (row.provider === provider) row.disabledCause = disabledCause;
		}
	}

	getCache(key: string, options?: { includeExpired?: boolean }): string | null {
		const entry = this.#cache.get(key);
		if (!entry) return null;
		if (!options?.includeExpired && entry.expiresAtSec <= Math.floor(Date.now() / 1000)) return null;
		return entry.value;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#cache.set(key, { value, expiresAtSec });
	}

	cleanExpiredCache(): void {
		const nowSec = Math.floor(Date.now() / 1000);
		for (const [key, entry] of this.#cache) {
			if (entry.expiresAtSec <= nowSec) this.#cache.delete(key);
		}
	}

	#createRow(provider: string, credential: AuthCredential): StoredAuthCredential {
		return { id: this.#nextId++, provider, credential: { ...credential }, disabledCause: null };
	}
}

function stopReply(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = (message as TextBearingMessage).content;
	if (typeof content === "string") return content;
	return content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function hasIncomingIrc(messages: AgentMessage[], body: string): boolean {
	return messages.some(message => {
		if (message.role !== "custom") return false;
		const custom = message as { customType?: string; details?: { message?: string } };
		return custom.customType === "irc:incoming" && custom.details?.message === body;
	});
}

async function createHarness(responses: Array<MockResponse | (() => MockResponse)>): Promise<Harness> {
	const tempDir = path.join(os.tmpdir(), `pi-irc-wake-test-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	const authStorage = new AuthStorage(new InMemoryAuthCredentialStore());
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
	const mock = createMockModel({ responses });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
	});
	return { session, mock, authStorage, tempDir };
}

describe("IRC idle wake continuation", () => {
	const harnesses: Harness[] = [];
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.authStorage.close();
			if (fs.existsSync(harness.tempDir)) removeSyncWithRetries(harness.tempDir);
		}
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	// Contract: idle delivery must start a real turn, consume the irc:incoming record,
	// produce the recipient response, and leave no duplicate mailbox copy behind.
	it("delivering to an idle subagent runs a real wake turn that consumes the incoming IRC record", async () => {
		const harness = await createHarness([stopReply("seed done"), stopReply("replying from wake")]);
		harnesses.push(harness);
		await harness.session.prompt("finish initial task");
		await harness.session.waitForIdle();
		registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: harness.session, status: "idle" });

		const events: AgentSessionEvent["type"][] = [];
		harness.session.subscribe(event => {
			if (event.type === "agent_start" || event.type === "agent_end") events.push(event.type);
		});

		const receipt = await bus.send({ from: "Main", to: "0-Sub", body: "wake ping" });
		expect(receipt).toEqual({ to: "0-Sub", outcome: "woken" });
		await harness.session.waitForIdle();

		expect(events).toEqual(["agent_start", "agent_end"]);
		expect(harness.mock.calls).toHaveLength(2);
		expect(hasIncomingIrc(harness.session.agent.state.messages, "wake ping")).toBe(true);
		expect(harness.session.agent.state.messages.some(message => textOf(message).includes("replying from wake"))).toBe(
			true,
		);
		expect(bus.inbox("0-Sub", { peek: true })).toEqual([]);
	});

	// Contract: provider failure during the wake is reported via agent state, so the
	// bus must log and redeliver the original IRC body instead of trusting the wake.
	it("re-buffers an idle IRC wake when the real wake turn resolves with provider error state", async () => {
		const harness = await createHarness([
			stopReply("seed done"),
			() => {
				throw new Error("wake provider failed");
			},
		]);
		harnesses.push(harness);
		await harness.session.prompt("finish initial task");
		await harness.session.waitForIdle();
		registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: harness.session, status: "idle" });
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

		const receipt = await bus.send({ from: "Main", to: "0-Sub", body: "do not lose me" });
		expect(receipt).toEqual({ to: "0-Sub", outcome: "woken" });
		await harness.session.waitForIdle();

		expect(harness.mock.calls).toHaveLength(2);
		expect(errorSpy.mock.calls.some(([message]) => message === "IRC wake turn produced no completed response")).toBe(
			true,
		);
		const peeked = bus.inbox("0-Sub", { peek: true });
		expect(peeked.map(message => message.body)).toEqual(["do not lose me"]);
		const waited = await bus.wait("0-Sub", { from: "Main" }, 5);
		expect(waited?.body).toBe("do not lose me");
		expect(bus.inbox("0-Sub", { peek: true })).toEqual([]);
	});

	// Contract: reviving a parked recipient is reported separately from the actual
	// delivery path, preserving "woken" for the real wake outcome.
	it("reports parked revival separately from the actual wake delivery outcome", async () => {
		const harness = await createHarness([stopReply("seed done"), stopReply("revived wake reply")]);
		harnesses.push(harness);
		await harness.session.prompt("finish initial task");
		await harness.session.waitForIdle();
		registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
		AgentLifecycleManager.global().adopt("0-Parked", { idleTtlMs: 0, revive: async () => harness.session });

		const receipt = await bus.send({ from: "Main", to: "0-Parked", body: "wake parked" });
		expect(receipt).toEqual({ to: "0-Parked", outcome: "woken", revived: true });
		await harness.session.waitForIdle();
		expect(hasIncomingIrc(harness.session.agent.state.messages, "wake parked")).toBe(true);
	});
});
