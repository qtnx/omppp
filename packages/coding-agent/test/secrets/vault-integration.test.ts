import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { detectSecretsInText } from "../../src/secrets/detect";
import { vaultKeychainRuntime } from "../../src/secrets/keychain";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { maskSecretValue, SecretVault } from "../../src/secrets/vault";

async function withAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "secret-vault-integration-"));
	try {
		return await fn(agentDir);
	} finally {
		await removeWithRetries(agentDir);
	}
}

describe("secret vault integration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("encrypts, redacts, restores, detects, and masks a stored token", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const value = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
			const vault = await SecretVault.open(agentDir);
			expect(vault.keyBackend).toBe("file");
			expect(await vault.set("github token", value, "user")).toBe("GITHUB_TOKEN");

			const entries = vault.toSecretEntries();
			expect(entries).toEqual([
				expect.objectContaining({ type: "plain", content: value, mode: "obfuscate", friendlyName: "GITHUB_TOKEN" }),
			]);
			const obfuscator = new SecretObfuscator(entries);
			const original = `Use ${value} for this request.`;
			const obfuscated = obfuscator.obfuscate(original);
			expect(obfuscated).toContain("$$");
			expect(obfuscated).not.toContain(value);
			expect(obfuscator.deobfuscate(obfuscated)).toBe(original);

			const prompt = `Token ${value}\n<secret name="deploy key">deploy-secret-0123456789</secret>`;
			const detections = detectSecretsInText(prompt);
			expect(detections).toHaveLength(2);
			expect(detections.map(detection => prompt.slice(detection.start, detection.end))).toEqual([
				value,
				'<secret name="deploy key">deploy-secret-0123456789</secret>',
			]);
			expect(detections.map(detection => detection.kind)).toEqual(["github-token", "tag"]);

			const [meta] = vault.list();
			expect(meta).toEqual(
				expect.objectContaining({ name: "GITHUB_TOKEN", mask: maskSecretValue(value), length: value.length }),
			);
		});
	});
});
