import { describe, expect, it } from "bun:test";
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
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		secretVault: fakeVault,
		settings: {
			get(key: string): unknown {
				switch (key) {
					case "async.enabled":
					case "bash.autoBackground.enabled":
					case "bashInterceptor.enabled":
						return false;
					case "bash.autoBackground.thresholdMs":
						return 60_000;
					case "secrets.enabled":
						return true;
					case "secrets.injectEnv":
						return options.injectEnv;
					default:
						return undefined;
				}
			},
			getBashInterceptorRules: () => [],
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
	return new BashTool(session);
}

function textOutput(result: AgentToolResult<BashToolDetails>): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("BashTool secret vault environment injection", () => {
	it("injects vault secrets into the child environment", async () => {
		const result = await makeTool({ injectEnv: true }).execute("vault-env", {
			command: 'printf "%s" "$MY_TOKEN"',
		});

		expect(textOutput(result)).toContain("tok_abcdef123456");
	});

	it("keeps model-authored environment values ahead of vault secrets", async () => {
		const result = await makeTool({ injectEnv: true }).execute("vault-env-override", {
			command: 'printf "%s" "$MY_TOKEN"',
			env: { MY_TOKEN: "override" },
		});

		expect(textOutput(result)).toContain("override");
		expect(textOutput(result)).not.toContain("tok_abcdef123456");
	});

	it("does not inject vault secrets when env injection is disabled", async () => {
		const result = await makeTool({ injectEnv: false }).execute("vault-env-disabled", {
			command: 'printf "<%s>" "$MY_TOKEN"',
		});

		expect(textOutput(result)).toContain("<>");
		expect(textOutput(result)).not.toContain("tok_abcdef123456");
	});
});
