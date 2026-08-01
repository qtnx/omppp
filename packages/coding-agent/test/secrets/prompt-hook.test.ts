import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "../../../agent/src";
import { clearCustomApis, type Model, registerCustomApi } from "../../../ai/src";
import { AssistantMessageEventStream } from "../../../ai/src/utils/event-stream";
import { Settings } from "../../src/config/settings";
import type {
	SecretEntry,
	SecretVaultLike,
	VaultKeyBackend,
	VaultSecretMeta,
	VaultSecretSource,
} from "../../src/secrets";
import { vaultSecretEntry } from "../../src/secrets/vault";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage } from "../helpers/agent-session-setup";

class FakeSecretVault implements SecretVaultLike {
	calls: Array<{ name: string; value: string; source: VaultSecretSource }> = [];
	readonly keyBackend: VaultKeyBackend = "file";
	readonly keyMaterialToRedact: string = "fake-vault-key-material";

	list(): VaultSecretMeta[] {
		return [];
	}

	get(_name: string): string | undefined {
		return undefined;
	}

	async set(name: string, value: string, source: VaultSecretSource): Promise<string> {
		this.calls.push({ name, value, source });
		return name;
	}

	async remove(_name: string): Promise<boolean> {
		return false;
	}

	env(): Record<string, string> {
		return {};
	}

	toSecretEntries(): SecretEntry[] {
		return [];
	}
}

const model = {
	id: "secret-prompt-hook-model",
	name: "Secret Prompt Hook Model",
	api: "secret-prompt-hook-test",
	provider: "test-provider",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
	compat: undefined,
} satisfies Model;

function getPromptText(messages: AgentMessage[]): string {
	const message = [...messages].reverse().find(message => message.role === "user" || message.role === "developer");
	if (!message) throw new Error("Expected a prompt message");
	if (typeof message.content === "string") return message.content;
	const text = message.content.find(content => content.type === "text");
	if (!text) throw new Error("Expected prompt text content");
	return text.text;
}

function createSession(autoDetect: boolean, vault: FakeSecretVault): AgentSession {
	return new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["system"], messages: [], tools: [] },
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"secrets.enabled": true,
			"secrets.autoDetect": autoDetect,
		}),
		modelRegistry: { getApiKey: vi.fn(async () => "key") } as never,
		secretVault: vault,
	});
}

describe("AgentSession prompt secret detection", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		clearCustomApis();
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	function registerResponse(): void {
		registerCustomApi(model.api, () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") }));
			return stream;
		});
	}

	it("stores detected GitHub tokens and replaces them before the agent receives the prompt", async () => {
		registerResponse();
		const vault = new FakeSecretVault();
		const session = createSession(true, vault);
		sessions.push(session);
		const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

		await session.prompt(`Use ${token}`);

		const prompt = getPromptText(session.agent.state.messages);
		expect(vault.calls).toEqual([{ name: "GITHUB_TOKEN", value: token, source: "detected" }]);
		expect(prompt).not.toContain(token);
		expect(prompt).toContain("[secret GITHUB_TOKEN (");
		expect(prompt).not.toContain("$");
	});

	it("stores tagged secrets under their normalized tag name", async () => {
		registerResponse();
		const vault = new FakeSecretVault();
		const session = createSession(true, vault);
		sessions.push(session);

		await session.prompt('<secret name="db_pass">password-with-enough-length</secret>');

		const prompt = getPromptText(session.agent.state.messages);
		expect(vault.calls).toEqual([{ name: "DB_PASS", value: "password-with-enough-length", source: "tag" }]);
		expect(prompt).not.toContain("<secret");
		expect(prompt).toContain("[secret DB_PASS (");
	});

	it("leaves synthetic prompts untouched", async () => {
		registerResponse();
		const vault = new FakeSecretVault();
		const session = createSession(true, vault);
		sessions.push(session);
		const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

		await session.prompt(token, { synthetic: true });

		expect(vault.calls).toEqual([]);
		expect(getPromptText(session.agent.state.messages)).toBe(token);
	});

	it("leaves prompts untouched when automatic detection is disabled", async () => {
		registerResponse();
		const vault = new FakeSecretVault();
		const session = createSession(false, vault);
		sessions.push(session);
		const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

		await session.prompt(token);

		expect(vault.calls).toEqual([]);
		expect(getPromptText(session.agent.state.messages)).toBe(token);
	});

	it("applies the vault replacement to steered text", async () => {
		registerResponse();
		const vault = new FakeSecretVault();
		const session = createSession(true, vault);
		sessions.push(session);
		const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

		await session.steer(`use ${token}`);

		expect(vault.calls).toEqual([{ name: "GITHUB_TOKEN", value: token, source: "detected" }]);
		// Detection ran before the text was queued, so the value is now a
		// registered secret and can no longer reach the provider verbatim.
		expect(session.obfuscator?.obfuscate(`value is ${token}`)).not.toContain(token);
	});

	it("applies the vault replacement to user follow-ups but not synthetic ones", async () => {
		registerResponse();
		const vault = new FakeSecretVault();
		const session = createSession(true, vault);
		sessions.push(session);
		const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

		await session.followUp(`use ${token}`);
		expect(vault.calls).toEqual([{ name: "GITHUB_TOKEN", value: token, source: "detected" }]);

		await session.followUp(`synthetic ${token}`, undefined, { synthetic: true });
		expect(vault.calls).toHaveLength(1);
	});

	it("registers a detected secret with the obfuscator even when the session started without one", async () => {
		registerResponse();
		const vault = new FakeSecretVault();
		const session = createSession(true, vault);
		sessions.push(session);
		const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		expect(session.obfuscator).toBeUndefined();

		await session.prompt(`Use ${token}`);

		// Without runtime registration a later tool result echoing the injected
		// env var would carry the raw token to the provider.
		const obfuscated = session.obfuscator?.obfuscate(`value is ${token}`);
		expect(obfuscated).toBeDefined();
		expect(obfuscated).not.toContain(token);
	});

	it("redacts a managed value shorter than the obfuscate-mode floor", async () => {
		registerResponse();
		const vault = new FakeSecretVault();
		const session = createSession(true, vault);
		sessions.push(session);

		session.registerRuntimeSecrets([vaultSecretEntry("PIN", "1234")]);

		expect(session.obfuscator?.obfuscate("pin is 1234")).not.toContain("1234");
	});
});
