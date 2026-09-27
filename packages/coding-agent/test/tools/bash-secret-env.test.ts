import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgLaunchEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgSecretsEnabled, cfgSecretsInjectEnv } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SecretVaultLike } from "@oh-my-pi/pi-coding-agent/secrets/vault";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";

const vaultEnv = { MY_TOKEN: "tok_abcdef123456" };

const fakeVault: SecretVaultLike = {
	list: () => [],
	get: () => undefined,
	set: async name => name,
	remove: async () => false,
	env: () => vaultEnv,
	toSecretEntries: () => [],
	keyBackend: "file",
	keyMaterialToRedact: "fake-vault-key-material",
};

function makeTool(options: { injectEnv: boolean }): BashTool {
	const settings = Settings.isolated();
	cfgSecretsEnabled.set(settings, true);
	cfgLaunchEnabled.set(settings, true);
	cfgSecretsInjectEnv.set(settings, options.injectEnv);
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		secretVault: fakeVault,
		settings,
		getBashInterceptorRules: () => [],
	} as unknown as ToolSession;
	return new BashTool(session);
}

function textOutput(result: AgentToolResult<BashToolDetails>): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("BashTool secret vault environment injection", () => {
	it("injects vault secrets into the child environment", async () => {
		const result = await makeTool({ injectEnv: true }).execute("vault-env", {
			name: "vault-env-service",
			command: "true",
			pty: false,
		});

		expect(textOutput(result)).toContain("vault-env-service");
	});

	it("keeps model-authored environment values ahead of vault secrets", async () => {
		const result = await makeTool({ injectEnv: true }).execute("vault-env-override", {
			name: "vault-env-override-service",
			command: "true",
			env: { MY_TOKEN: "override" },
			pty: false,
		});

		expect(textOutput(result)).toContain("vault-env-override-service");
	});

	it("does not inject vault secrets when env injection is disabled", async () => {
		const result = await makeTool({ injectEnv: false }).execute("vault-env-disabled", {
			name: "vault-env-disabled-service",
			command: "true",
			pty: false,
		});

		expect(textOutput(result)).toContain("vault-env-disabled-service");
	});
});
