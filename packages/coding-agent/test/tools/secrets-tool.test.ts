import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SecretVaultLike, VaultSecretMeta } from "@oh-my-pi/pi-coding-agent/secrets/vault";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SecretsTool } from "@oh-my-pi/pi-coding-agent/tools/secrets";

function createVault(secrets: VaultSecretMeta[], values: Record<string, string>): SecretVaultLike {
	return {
		list: () => secrets,
		get: name => values[name],
		set: async name => name,
		remove: async () => false,
		env: () => values,
		toSecretEntries: () => [],
		keyBackend: "file",
		keyMaterialToRedact: "fake-vault-key-material",
	};
}

function createSession(secretVault: SecretVaultLike | undefined): ToolSession {
	return {
		cwd: "/tmp/secrets-tool-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		secretVault,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("SecretsTool", () => {
	it("lists masks without exposing plaintext values", async () => {
		const rawValue = "super-secret-value-1234";
		const tool = SecretsTool.createIf(
			createSession(
				createVault(
					[
						{
							name: "API_TOKEN",
							mask: "su…1234",
							length: rawValue.length,
							source: "user",
							createdAt: "2026-07-31T00:00:00.000Z",
						},
					],
					{ API_TOKEN: rawValue },
				),
			),
		);
		expect(tool).not.toBeNull();

		const result = await tool!.execute("call-1", { op: "list" });
		const text = getText(result);

		expect(text).toContain("API_TOKEN");
		expect(text).toContain("su…1234");
		expect(text).toContain(`Length: ${rawValue.length}`);
		expect(text).toContain("exported as env var NAME in bash commands");
		expect(text).not.toContain(rawValue);
	});

	it("reports an explicit empty state", async () => {
		const tool = SecretsTool.createIf(createSession(createVault([], {})));
		expect(tool).not.toBeNull();

		const result = await tool!.execute("call-1", { op: "list" });

		expect(getText(result)).toBe("No secrets are stored. Add a secret with /secrets add <NAME> <VALUE>.");
	});
});
