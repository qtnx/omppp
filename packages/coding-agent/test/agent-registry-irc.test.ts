import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import { IrcTool } from "../src/tools/irc";

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

describe("AgentRegistry IRC visibility", () => {
	it("hides non-IRC agents from peer listings", async () => {
		const registry = new AgentRegistry();
		registerAgent(registry, "sender", true);
		registerAgent(registry, "restricted", false);
		registerAgent(registry, "peer", true);

		const result = await new IrcTool(createToolSession(registry, "sender")).execute("irc-list", { op: "list" });

		expect(result.details?.peers?.map(peer => peer.id)).toEqual(["peer"]);
		expect(result.details?.channels).toEqual(["all", "peer"]);
	});

	it("does not deliver direct IRC messages to non-IRC agents", async () => {
		const registry = new AgentRegistry();
		let deliveries = 0;
		const targetSession = {
			respondAsBackground: async () => {
				deliveries += 1;
				return { replyText: "reply" };
			},
		} as unknown as AgentSession;
		registerAgent(registry, "sender", true);
		registerAgent(registry, "restricted", false, targetSession);

		const result = await new IrcTool(createToolSession(registry, "sender")).execute("irc-send", {
			op: "send",
			to: "restricted",
			message: "hello",
			awaitReply: true,
		});

		expect(deliveries).toBe(0);
		expect(result.details?.delivered).toEqual([]);
		expect(result.details?.notFound).toEqual(["restricted"]);
	});
});
