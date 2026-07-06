import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { IrcBus, type IrcMessage } from "../src/irc/bus";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { getBundledAgent } from "../src/task/agents";
import type { BuiltinToolLoadMode, ToolSession } from "../src/tools";
import { filterInitialToolsForDiscoveryAll } from "../src/tools";
import { IrcTool } from "../src/tools/irc";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function registerAgent(
	registry: AgentRegistry,
	id: string,
	ircEnabled: boolean,
	session: AgentSession | null = null,
): void {
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		session,
		status: "idle",
		ircEnabled,
	});
}

function createToolSession(registry: AgentRegistry, id: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "irc.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		agentRegistry: registry,
		getAgentId: () => id,
	} as unknown as ToolSession;
}

function bundledAgentIrcEnabled(name: string): boolean {
	const agent = getBundledAgent(name);
	if (!agent) throw new Error(`Missing bundled agent ${name}`);
	return agent.tools === undefined || agent.tools.includes("irc");
}

describe("IrcTool model-facing guidance", () => {
	it("distinguishes IRC messages from subagent result delivery", () => {
		const registry = new AgentRegistry();
		const description = new IrcTool(createToolSession(registry, "sender")).description;

		expect(description).toContain("IRC waits are not subagent-result waits");
		expect(description).toContain("Use `job` poll");
		expect(description).toContain("Subagent completions");
	});
});

describe("filterInitialToolsForDiscoveryAll IRC preservation", () => {
	const filterWithForcedIrc = (initialToolNames: string[]): string[] =>
		filterInitialToolsForDiscoveryAll(initialToolNames, {
			loadModeOf: (name): BuiltinToolLoadMode | undefined => {
				if (name === "irc") return "discoverable";
				if (name === "read") return "essential";
				return undefined;
			},
			essentialNames: new Set(),
			explicitlyRequested: new Set(),
			restored: new Set(),
			forceActive: new Set(["irc"]),
		});

	it("keeps irc when forceActive names an initially present discoverable tool", () => {
		expect(filterWithForcedIrc(["irc", "read"])).toContain("irc");
	});

	it("does not inject irc when forceActive names an absent tool", () => {
		expect(filterWithForcedIrc(["read"])).not.toContain("irc");
	});
});

describe("AgentRegistry IRC visibility", () => {
	it("hides non-IRC agents from registry-visible peer listings", () => {
		const registry = new AgentRegistry();
		registerAgent(registry, "sender", true);
		registerAgent(registry, "restricted", false);
		registerAgent(registry, "peer", true);

		expect(registry.listVisibleTo("sender").map(peer => peer.id)).toEqual(["peer"]);
	});

	// Read-only/restricted bundled tiers are messageable when their tool contract includes IRC.
	it("exposes bundled read-only and restricted tiers as IRC-capable peers", async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const delivered: string[] = [];
		const senderSession = createToolSession(registry, "sender");
		registerAgent(registry, "sender", true);
		for (const tier of ["explore", "librarian", "plan", "qa", "reviewer", "browser_qa"]) {
			const session = {
				deliverIrcMessage: async (msg: IrcMessage) => {
					delivered.push(msg.to);
					return "injected";
				},
			} as unknown as AgentSession;
			registerAgent(registry, tier, bundledAgentIrcEnabled(tier), session);
		}

		expect(registry.listVisibleTo("sender").map(peer => peer.id)).toEqual([
			"explore",
			"librarian",
			"plan",
			"qa",
			"reviewer",
			"browser_qa",
		]);

		const result = await new IrcTool(senderSession).execute("irc-send", {
			op: "send",
			to: "explore",
			message: "hello",
			await: true,
			timeoutMs: 1,
		});

		expect(delivered).toEqual(["explore"]);
		expect(result.details?.receipts).toEqual([expect.objectContaining({ to: "explore", outcome: "injected" })]);
	});

	it("delivers direct IRC messages to targets registered as IRC-capable", async () => {
		const registry = AgentRegistry.global();
		let deliveries = 0;
		const targetSession = {
			deliverIrcMessage: async () => {
				deliveries += 1;
				return "injected";
			},
		} as unknown as AgentSession;
		registerAgent(registry, "sender", true);
		registerAgent(registry, "peer", true, targetSession);

		const result = await new IrcTool(createToolSession(registry, "sender")).execute("irc-send", {
			op: "send",
			to: "peer",
			message: "hello",
			await: true,
			timeoutMs: 1,
		});

		expect(deliveries).toBe(1);
		expect(result.details?.receipts).toEqual([expect.objectContaining({ to: "peer", outcome: "injected" })]);
		expect(result.details?.receipts?.[0]).not.toEqual(
			expect.objectContaining({ error: "agent has no irc tool and cannot reply" }),
		);
	});

	it("does not deliver direct IRC messages to non-IRC agents", async () => {
		const registry = new AgentRegistry();
		let deliveries = 0;
		const targetSession = {
			getActiveToolNames: () => ["read", "yield"],
			deliverIrcMessage: async () => {
				deliveries += 1;
				return "injected";
			},
		} as unknown as AgentSession;
		registerAgent(registry, "sender", true);
		registerAgent(registry, "restricted", false, targetSession);

		const result = await new IrcTool(createToolSession(registry, "sender")).execute("irc-send", {
			op: "send",
			to: "restricted",
			message: "hello",
			await: true,
			timeoutMs: 1,
		});

		// A target that cannot reply must fail before delivery instead of being woken mute.
		expect(deliveries).toBe(0);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
			"restricted: failed — agent has no irc tool and cannot reply",
		);
		expect(result.details?.receipts).toEqual([
			expect.objectContaining({
				to: "restricted",
				outcome: "failed",
				error: "agent has no irc tool and cannot reply",
			}),
		]);
	});

	it("re-syncs a live target as IRC-capable when irc is now active", async () => {
		const registry = AgentRegistry.global();
		let deliveries = 0;
		const targetSession = {
			getActiveToolNames: () => ["read", "irc"],
			deliverIrcMessage: async () => {
				deliveries += 1;
				return "injected";
			},
		} as unknown as AgentSession;
		registerAgent(registry, "sender", true);
		registerAgent(registry, "late-irc", false, targetSession);

		const result = await new IrcTool(createToolSession(registry, "sender")).execute("irc-send", {
			op: "send",
			to: "late-irc",
			message: "hello",
			await: true,
			timeoutMs: 1,
		});

		expect(deliveries).toBe(1);
		expect(registry.get("late-irc")?.ircEnabled).toBe(true);
		expect(result.details?.receipts).toEqual([expect.objectContaining({ to: "late-irc", outcome: "injected" })]);
		expect(result.details?.receipts?.[0]).not.toEqual(
			expect.objectContaining({ error: "agent has no irc tool and cannot reply" }),
		);
	});

	it("fails fast for parked non-IRC agents without reviving them", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		registerAgent(registry, "sender", true);
		registry.register({
			id: "parked-restricted",
			displayName: "parked-restricted",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/parked-restricted.jsonl",
			status: "parked",
			ircEnabled: false,
		});
		const lifecycle = AgentLifecycleManager.global();
		const ensureLiveSpy = spyOn(lifecycle, "ensureLive");

		const result = await new IrcTool(createToolSession(registry, "sender")).execute("irc-send", {
			op: "send",
			to: "parked-restricted",
			message: "hello",
			await: true,
			timeoutMs: 1,
		});

		// Parked non-IRC refs also fail before ensureLive, so no revive path can swallow the message.
		expect(ensureLiveSpy).not.toHaveBeenCalled();
		expect(result.details?.receipts).toEqual([
			expect.objectContaining({
				to: "parked-restricted",
				outcome: "failed",
				error: "agent has no irc tool and cannot reply",
			}),
		]);
	});

	it("derives parked cold-revived IRC capability from persisted tools before waking", async () => {
		const cwd = makeTempDir("@pi-parked-irc-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		manager.appendSessionInit({ systemPrompt: "restricted", task: "t", tools: ["read", "yield"], spawns: "" });
		manager.appendMessage(assistantMessage("flush"));

		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		registerAgent(registry, "sender", true);
		registry.register({
			id: "cold-parked-restricted",
			displayName: "cold-parked-restricted",
			kind: "sub",
			session: null,
			sessionFile,
			status: "parked",
		});
		const lifecycle = AgentLifecycleManager.global();
		const ensureLiveSpy = spyOn(lifecycle, "ensureLive");

		const result = await new IrcTool(createToolSession(registry, "sender")).execute("irc-send", {
			op: "send",
			to: "cold-parked-restricted",
			message: "hello",
			await: true,
			timeoutMs: 1,
		});

		// Cold-revived refs clamp ircEnabled from persisted tools before any wake is attempted.
		expect(ensureLiveSpy).not.toHaveBeenCalled();
		expect(result.details?.receipts).toEqual([
			expect.objectContaining({
				to: "cold-parked-restricted",
				outcome: "failed",
				error: "agent has no irc tool and cannot reply",
			}),
		]);
		expect(registry.get("cold-parked-restricted")?.ircEnabled).toBe(false);
	});
});
