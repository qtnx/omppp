import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveEffectiveToolDiscoveryMode } from "@oh-my-pi/pi-coding-agent/tool-discovery/tool-index";

// ─── Subagent discovery mode inheritance tests ────────────────────────────────
// These are unit-level tests that verify the settings resolution logic
// without needing to spin up a full AgentSession or subagent.
// ─────────────────────────────────────────────────────────────────────────────
describe("effective discovery mode resolution", () => {
	it("tools.discoveryMode=all beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "all", "mcp.discoveryMode": false });
		expect(resolveEffectiveToolDiscoveryMode(s, { contextWindow: 1_000_000 })).toBe("all");
	});

	it("tools.discoveryMode=mcp-only beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "mcp-only", "mcp.discoveryMode": false });
		expect(resolveEffectiveToolDiscoveryMode(s, { contextWindow: 1_000_000 })).toBe("mcp-only");
	});

	it("tools.discoveryMode=off beats legacy mcp.discoveryMode=true", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": true });
		expect(resolveEffectiveToolDiscoveryMode(s, { contextWindow: 999_999 })).toBe("off");
	});

	it("legacy mcp.discoveryMode=true resolves auto settings to mcp-only", () => {
		const s = Settings.isolated({ "mcp.discoveryMode": true });
		expect(resolveEffectiveToolDiscoveryMode(s, { contextWindow: 999_999 })).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=false → off", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": false });
		expect(resolveEffectiveToolDiscoveryMode(s, { contextWindow: 8192 })).toBe("off");
	});

	it("default auto settings enable all discovery below 1M context tokens", () => {
		const s = Settings.isolated({});
		expect(resolveEffectiveToolDiscoveryMode(s, { contextWindow: 999_999 })).toBe("all");
	});

	it("default auto settings stay off at 1M context tokens", () => {
		const s = Settings.isolated({});
		expect(resolveEffectiveToolDiscoveryMode(s, { contextWindow: 1_000_000 })).toBe("off");
	});
});
